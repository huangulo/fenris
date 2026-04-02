import { query } from '../db/client.js';
import { Alert, Config } from '../types.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PredictionConfig {
  enabled: boolean;
  interval_ms: number;        // derived from "5m" string
  disk_horizon_days: number;
  cpu_horizon_hours: number;
  memory_horizon_hours: number;
  disk_threshold: number;     // %, e.g. 85
  cpu_threshold: number;      // %, e.g. 90
  memory_threshold: number;   // %, e.g. 90
  min_samples: number;        // data points to use for regression
  min_confidence: number;     // R² floor below which we don't predict
}

interface RegressionResult {
  slope: number;      // value-units per millisecond
  intercept: number;
  confidence: number; // R² in [0,1]
}

interface PredictionMeta {
  type: 'prediction';
  projected_value: number;
  projected_time: string;   // ISO
  slope_per_day: number;    // same units per day (for the message)
  confidence: number;
}

// ── In-memory cooldown (prevent duplicate DB rows) ────────────────────────────

// Key: `${serverId}:${metricType}`
const lastPrediction = new Map<string, number>();
const COOLDOWN_CPU_MEM_MS  = 60 * 60 * 1000;   // 1 h
const COOLDOWN_DISK_MS     = 6 * 60 * 60 * 1000; // 6 h

function cooldownMs(metricType: string): number {
  return metricType === 'disk' ? COOLDOWN_DISK_MS : COOLDOWN_CPU_MEM_MS;
}

function inCooldown(serverId: number, metricType: string): boolean {
  const key = `${serverId}:${metricType}`;
  const last = lastPrediction.get(key) ?? 0;
  return Date.now() - last < cooldownMs(metricType);
}

function markSent(serverId: number, metricType: string): void {
  lastPrediction.set(`${serverId}:${metricType}`, Date.now());
}

// ── Linear regression ─────────────────────────────────────────────────────────

function linearRegression(xs: number[], ys: number[]): RegressionResult {
  const n = xs.length;
  if (n < 3) return { slope: 0, intercept: ys[0] ?? 0, confidence: 0 };

  const sumX  = xs.reduce((a, b) => a + b, 0);
  const sumY  = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumX2 = xs.reduce((acc, x) => acc + x * x, 0);

  const meanX = sumX / n;
  const meanY = sumY / n;

  const denom = sumX2 - (sumX * sumX) / n;
  if (denom === 0) return { slope: 0, intercept: meanY, confidence: 0 };

  const slope     = (sumXY - (sumX * sumY) / n) / denom;
  const intercept = meanY - slope * meanX;

  // R² coefficient of determination
  const ssRes = ys.reduce((a, y, i) => a + Math.pow(y - (slope * xs[i] + intercept), 2), 0);
  const ssTot = ys.reduce((a, y) => a + Math.pow(y - meanY, 2), 0);
  const confidence = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  return { slope, intercept, confidence };
}

// ── Time-to-breach calculation ────────────────────────────────────────────────

/**
 * Given y = slope*x + intercept (x in ms from epoch),
 * solve for x when y = threshold: x = (threshold - intercept) / slope
 * Returns null if breach never happens (slope <= 0 or already past threshold).
 */
function timeToBreach(
  reg: RegressionResult,
  currentValueAtNow: number,
  threshold: number,
  nowMs: number,
): number | null {
  if (reg.slope <= 0) return null;                     // not trending toward threshold
  if (currentValueAtNow >= threshold) return null;     // already breached

  // Using the regression line anchored at now:
  // y(t) = currentValueAtNow + slope * dt
  // threshold = currentValueAtNow + slope * dt  →  dt = (threshold - currentValueAtNow) / slope
  const dt = (threshold - currentValueAtNow) / reg.slope;
  if (dt <= 0) return null;
  return dt; // milliseconds until breach
}

// ── DB fetch + per-metric logic ───────────────────────────────────────────────

async function predictForMetric(
  serverId: number,
  serverName: string,
  metricType: 'cpu' | 'memory' | 'disk',
  cfg: PredictionConfig,
  dispatcher: AlertDispatcher,
): Promise<void> {
  if (inCooldown(serverId, metricType)) return;

  const limit = cfg.min_samples;
  const rows = await query(
    `SELECT value, timestamp FROM metrics
     WHERE server_id = $1 AND metric_type = $2
     ORDER BY timestamp DESC LIMIT $3`,
    [serverId, metricType, limit]
  );

  if (rows.rows.length < Math.floor(limit * 0.5)) return; // need at least 50% of window filled

  // Sort ascending for regression
  const sorted: Array<{ value: unknown; timestamp: string }> = [...rows.rows].reverse();

  const t0 = new Date(sorted[0].timestamp).getTime();
  const xs: number[] = sorted.map(r => new Date(r.timestamp).getTime() - t0);
  const ys: number[] = sorted.map(r => {
    const v = r.value as Record<string, unknown>;
    if (metricType === 'cpu')    return (v.cpu    as { usage_percent: number })?.usage_percent    ?? 0;
    if (metricType === 'memory') return (v.memory as { used_percent:  number })?.used_percent     ?? 0;
    if (metricType === 'disk')   return (v.disk   as { used_percent:  number })?.used_percent     ?? 0;
    return 0;
  });

  const reg = linearRegression(xs, ys);
  if (reg.confidence < cfg.min_confidence) return;  // not enough of a trend

  const nowMs          = Date.now();
  const nowX           = nowMs - t0;
  const currentValue   = reg.slope * nowX + reg.intercept;

  const threshold = metricType === 'cpu'    ? cfg.cpu_threshold
                  : metricType === 'memory' ? cfg.memory_threshold
                  : cfg.disk_threshold;

  const horizonMs = metricType === 'disk'
    ? cfg.disk_horizon_days * 24 * 60 * 60 * 1000
    : (metricType === 'cpu' ? cfg.cpu_horizon_hours : cfg.memory_horizon_hours) * 60 * 60 * 1000;

  const breachInMs = timeToBreach(reg, currentValue, threshold, nowMs);
  if (breachInMs === null || breachInMs > horizonMs) return;

  // Build human-readable time-to-breach
  const breachAt    = new Date(nowMs + breachInMs);
  const MS_PER_DAY  = 86_400_000;
  const MS_PER_HOUR = 3_600_000;
  const MS_PER_MIN  = 60_000;

  let timeStr: string;
  if (breachInMs >= MS_PER_DAY) {
    timeStr = `~${(breachInMs / MS_PER_DAY).toFixed(1)} days`;
  } else if (breachInMs >= MS_PER_HOUR) {
    timeStr = `~${(breachInMs / MS_PER_HOUR).toFixed(1)} hours`;
  } else {
    timeStr = `~${Math.round(breachInMs / MS_PER_MIN)} minutes`;
  }

  const slopePerDay = reg.slope * MS_PER_DAY;
  const unit = metricType === 'disk' ? '%/day' : '%/hour';
  const slopeDisplay = metricType === 'disk'
    ? `${slopePerDay.toFixed(2)}%/day`
    : `${(reg.slope * MS_PER_HOUR).toFixed(2)}%/hr`;

  const metricLabel = metricType.toUpperCase();
  const message = `PREDICTION: ${metricLabel} on ${serverName} will reach ${threshold}% in ${timeStr} at current growth rate (${slopeDisplay})`;

  const predMeta: PredictionMeta = {
    type: 'prediction',
    projected_value: parseFloat(threshold.toFixed(1)),
    projected_time:  breachAt.toISOString(),
    slope_per_day:   parseFloat(slopePerDay.toFixed(4)),
    confidence:      parseFloat(reg.confidence.toFixed(4)),
  };

  const alert: Alert = {
    id:              0,
    server_id:       serverId,
    severity:        'warning',
    message,
    metric_type:     metricType,
    threshold_value: predMeta as unknown as Record<string, number>,
    actual_value:    { value: parseFloat(currentValue.toFixed(2)) },
    acknowledged:    false,
    created_at:      new Date(),
  };

  const result = await query(
    `INSERT INTO alerts (server_id, severity, message, metric_type, actual_value, threshold_value, acknowledged, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING id`,
    [
      alert.server_id, alert.severity, alert.message, alert.metric_type,
      JSON.stringify(alert.actual_value), JSON.stringify(alert.threshold_value),
      alert.acknowledged, alert.created_at,
    ]
  );

  alert.id = result.rows[0].id;
  markSent(serverId, metricType);
  console.log(`[predictor] ${message}`);
  await dispatcher.dispatchAlert(alert);
}

// ── Public API ────────────────────────────────────────────────────────────────

export class Predictor {
  private cfg: PredictionConfig;
  private dispatcher: AlertDispatcher;
  private timer: NodeJS.Timeout | null = null;

  constructor(cfg: PredictionConfig, dispatcher: AlertDispatcher) {
    this.cfg        = cfg;
    this.dispatcher = dispatcher;
  }

  start(): void {
    if (!this.cfg.enabled) {
      console.log('[predictor] disabled — skipping');
      return;
    }
    console.log(`[predictor] starting — interval ${this.cfg.interval_ms / 60000} min`);
    // Run once after a short delay (wait for data to accumulate), then on interval
    setTimeout(() => this.run(), 30_000);
    this.timer = setInterval(() => this.run(), this.cfg.interval_ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    try {
      const servers = await query('SELECT id, name FROM servers');
      for (const s of servers.rows) {
        for (const mt of ['cpu', 'memory', 'disk'] as const) {
          await predictForMetric(s.id, s.name, mt, this.cfg, this.dispatcher);
        }
      }
    } catch (err) {
      console.error('[predictor] run error:', err);
    }
  }
}

/** Parse a duration string like "5m", "1h", "30s" → milliseconds. */
export function parseDurationMs(s: string, defaultMs: number): number {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([smh]?)$/i);
  if (!m) return defaultMs;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  if (unit === 'h') return n * 3600_000;
  if (unit === 'm') return n * 60_000;
  return n * 1_000;
}
