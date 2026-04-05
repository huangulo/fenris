import fetch from 'node-fetch';
import tls from 'tls';
import { query } from '../db/client.js';
import { Alert } from '../types.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MonitorConfig {
  id: number;
  name: string;
  url: string;
  method: string;
  interval_seconds: number;
  timeout_seconds: number;
  expected_status: number;
  headers: Record<string, string>;
}

export interface CheckResult {
  is_up: boolean;
  status_code: number | null;
  response_time_ms: number;
  error: string | null;
  cert_expires_at: Date | null;
}

// ── In-memory state ───────────────────────────────────────────────────────────

/** Last known up/down per monitor — used to detect transitions. */
const lastStatus = new Map<number, boolean>();

/** When a monitor first went down (for "was down for X" recovery message). */
const downSince = new Map<number, number>();

/**
 * Per-monitor cooldown for repeated DOWN alerts and SSL expiry warnings.
 * Key: monitor.id (DOWN), -monitor.id (SSL expiry).
 */
const cooldown = new Map<number, number>();
const COOLDOWN_MS = 15 * 60 * 1_000;

// ── SSL certificate helper ────────────────────────────────────────────────────

async function getSSLExpiry(url: string): Promise<Date | null> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const port = parseInt(parsed.port) || 443;
    return await new Promise<Date | null>((resolve) => {
      const socket = tls.connect(
        { host: hostname, port, servername: hostname, rejectUnauthorized: false },
        () => {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          resolve(cert?.valid_to ? new Date(cert.valid_to) : null);
        }
      );
      socket.on('error', () => resolve(null));
      socket.setTimeout(5_000, () => { socket.destroy(); resolve(null); });
    });
  } catch {
    return null;
  }
}

// ── HTTP check ────────────────────────────────────────────────────────────────

async function httpCheck(m: MonitorConfig): Promise<CheckResult> {
  const start = Date.now();

  // Start SSL cert lookup in parallel for HTTPS endpoints
  const sslPromise = m.url.startsWith('https://')
    ? getSSLExpiry(m.url)
    : Promise.resolve(null as null);

  try {
    const res = await fetch(m.url, {
      method: m.method || 'GET',
      headers: m.headers ?? {},
      signal: AbortSignal.timeout(m.timeout_seconds * 1_000),
      redirect: 'follow',
    } as any);

    const certExpiresAt = await sslPromise;
    const responseTimeMs = Date.now() - start;
    const expected = m.expected_status || 200;
    const isUp = res.status === expected;

    return {
      is_up: isUp,
      status_code: res.status,
      response_time_ms: responseTimeMs,
      error: isUp ? null : `HTTP ${res.status} (expected ${expected})`,
      cert_expires_at: certExpiresAt,
    };
  } catch (err: any) {
    const certExpiresAt = await sslPromise.catch(() => null);
    const isTimeout = err?.name === 'AbortError' || err?.type === 'aborted' || err?.code === 'ABORT_ERR';
    return {
      is_up: false,
      status_code: null,
      response_time_ms: Date.now() - start,
      error: isTimeout ? 'Timeout' : (err?.message ?? 'Connection failed'),
      cert_expires_at: certExpiresAt,
    };
  }
}

// ── UptimeMonitor ─────────────────────────────────────────────────────────────

export class UptimeMonitor {
  private dispatcher: AlertDispatcher;
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(dispatcher: AlertDispatcher) {
    this.dispatcher = dispatcher;
  }

  async start(): Promise<void> {
    const { rows } = await query('SELECT * FROM monitors WHERE enabled = true');
    for (const monitor of rows) this.schedule(monitor);
    console.log(`[uptime] started — ${rows.length} monitor(s)`);
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    console.log('[uptime] stopped');
  }

  /** Reload a single monitor after create/update — cancel existing timer and reschedule. */
  async reloadMonitor(id: number): Promise<void> {
    const existing = this.timers.get(id);
    if (existing) { clearInterval(existing); this.timers.delete(id); }

    const { rows } = await query('SELECT * FROM monitors WHERE id = $1 AND enabled = true', [id]);
    if (rows.length > 0) this.schedule(rows[0]);
  }

  /** Remove a monitor's timer after delete. */
  removeMonitor(id: number): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
    lastStatus.delete(id);
    downSince.delete(id);
  }

  /** Execute a check, persist result, and fire transition alerts. */
  async runCheck(m: MonitorConfig): Promise<CheckResult> {
    const result = await httpCheck(m);

    await query(
      `INSERT INTO monitor_checks (monitor_id, status_code, response_time_ms, is_up, error, cert_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [m.id, result.status_code, result.response_time_ms, result.is_up, result.error, result.cert_expires_at]
    );

    const wasUp = lastStatus.get(m.id);

    if (wasUp === true && !result.is_up) {
      // Transition: UP → DOWN
      downSince.set(m.id, Date.now());
      await this.alertDown(m, result.error ?? 'Check failed');
    } else if (wasUp === false && result.is_up) {
      // Transition: DOWN → UP
      await this.alertRecovered(m);
      downSince.delete(m.id);
    } else if (wasUp === false && !result.is_up) {
      // Still down — re-alert only after cooldown
      const last = cooldown.get(m.id) ?? 0;
      if (Date.now() - last >= COOLDOWN_MS) {
        await this.alertDown(m, result.error ?? 'Check failed');
      }
    }

    lastStatus.set(m.id, result.is_up);

    // SSL expiry check (uses negative id as cooldown key to avoid conflict with DOWN)
    if (result.cert_expires_at) {
      const daysLeft = (result.cert_expires_at.getTime() - Date.now()) / 86_400_000;
      if (daysLeft > 0 && daysLeft <= 14) {
        const sslKey = -m.id;
        const lastSSL = cooldown.get(sslKey) ?? 0;
        if (Date.now() - lastSSL >= COOLDOWN_MS) {
          await this.alertSSL(m, result.cert_expires_at, Math.floor(daysLeft));
          cooldown.set(sslKey, Date.now());
        }
      }
    }

    return result;
  }

  /** Execute a check without persisting or alerting — used by the test endpoint. */
  async runTestCheck(m: MonitorConfig): Promise<CheckResult> {
    return httpCheck(m);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private schedule(m: MonitorConfig): void {
    this.runCheck(m).catch(err => console.error(`[uptime] check error (${m.name}):`, err));
    const t = setInterval(
      () => this.runCheck(m).catch(err => console.error(`[uptime] check error (${m.name}):`, err)),
      m.interval_seconds * 1_000
    );
    this.timers.set(m.id, t);
  }

  private async persistAndDispatch(
    monitorId: number,
    severity: Alert['severity'],
    message: string
  ): Promise<void> {
    const { rows } = await query(
      `INSERT INTO alerts (server_id, severity, message, metric_type)
       VALUES (NULL, $1, $2, 'uptime') RETURNING id, created_at`,
      [severity, message]
    );
    const row = rows[0];
    await this.dispatcher.dispatchAlert({
      id:              row?.id ?? 0,
      // Use monitorId as server_id so shouldAlert() keys per-monitor in util.ts
      server_id:       monitorId,
      severity,
      message,
      metric_type:     'uptime' as Alert['metric_type'],
      threshold_value: {},
      actual_value:    {},
      acknowledged:    false,
      created_at:      row?.created_at ?? new Date(),
    });
  }

  private async alertDown(m: MonitorConfig, error: string): Promise<void> {
    cooldown.set(m.id, Date.now());
    await this.persistAndDispatch(
      m.id,
      'critical',
      `SITE DOWN: ${m.name} (${m.url}) — ${error}`
    );
  }

  private async alertRecovered(m: MonitorConfig): Promise<void> {
    const since = downSince.get(m.id);
    let downFor = '';
    if (since) {
      const secs = Math.round((Date.now() - since) / 1_000);
      downFor = secs < 60 ? `${secs}s`
              : secs < 3_600 ? `${Math.round(secs / 60)}m`
              : `${Math.round(secs / 3_600)}h`;
    }
    await this.persistAndDispatch(
      m.id,
      'info',
      `SITE RECOVERED: ${m.name} (${m.url})${downFor ? ` — was down for ${downFor}` : ''}`
    );
  }

  private async alertSSL(m: MonitorConfig, expiresAt: Date, daysLeft: number): Promise<void> {
    const expiry = expiresAt.toISOString().split('T')[0];
    await this.persistAndDispatch(
      m.id,
      'warning',
      `SSL EXPIRY: ${m.name} (${m.url}) — certificate expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} on ${expiry}`
    );
  }
}
