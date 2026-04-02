import fetch from 'node-fetch';
import { query } from '../db/client.js';
import { Alert, Config } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type AiConfig = NonNullable<Config['ai']>;

interface PendingBatch {
  serverId:  number;
  alerts:    Alert[];
  timer:     NodeJS.Timeout;
}

// ── Rate-limit state ──────────────────────────────────────────────────────────

// Track calls per hour across all servers
const callTimestamps: number[] = [];

// Per-server cooldown
const lastSummarised = new Map<number, number>();

// ── Summarizer ────────────────────────────────────────────────────────────────

export class Summarizer {
  private cfg:     AiConfig;
  private pending: Map<number, PendingBatch> = new Map(); // keyed by server_id
  private running  = false;

  constructor(cfg: AiConfig, _onSummary?: (s: string) => void) {
    this.cfg = cfg;
  }

  start(): void {
    if (!this.cfg.enabled) {
      console.log('[summarizer] AI disabled — set ai.enabled=true and provide api_key to activate');
      return;
    }
    this.running = true;
    console.log(`[summarizer] started — model: ${this.cfg.model}`);
  }

  stop(): void {
    this.running = false;
    // Cancel all pending timers
    for (const batch of this.pending.values()) {
      clearTimeout(batch.timer);
    }
    this.pending.clear();
  }

  /** Called by routes.ts whenever a new alert is created. */
  enqueue(alert: Alert): void {
    if (!this.running || !this.cfg.enabled) return;

    const sid = alert.server_id;

    // Per-server cooldown
    const lastMs = lastSummarised.get(sid) ?? 0;
    if (Date.now() - lastMs < (this.cfg.cooldown_per_server_ms ?? 900_000)) return;

    const existing = this.pending.get(sid);
    if (existing) {
      existing.alerts.push(alert);
    } else {
      // Start the batch window — summarise after batch_window_ms
      const windowMs = this.cfg.batch_window_ms ?? 120_000;
      const timer = setTimeout(() => this.flush(sid), windowMs);
      this.pending.set(sid, { serverId: sid, alerts: [alert], timer });
    }
  }

  // ── Internal flush ──────────────────────────────────────────────────────────

  private async flush(serverId: number): Promise<void> {
    const batch = this.pending.get(serverId);
    if (!batch) return;
    this.pending.delete(serverId);

    if (batch.alerts.length === 0) return;

    // Global rate limit
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    // Remove timestamps older than 1 hour
    while (callTimestamps.length > 0 && callTimestamps[0] < oneHourAgo) callTimestamps.shift();

    const maxCalls = this.cfg.max_calls_per_hour ?? 10;
    if (callTimestamps.length >= maxCalls) {
      console.warn(`[summarizer] rate limit reached (${maxCalls}/hr) — skipping summary for server ${serverId}`);
      return;
    }

    // Fetch server name
    const srvRes = await query('SELECT name FROM servers WHERE id = $1', [serverId]);
    const serverName: string = srvRes.rows[0]?.name ?? `server-${serverId}`;

    // Strip sensitive fields before sending to AI
    const safeAlerts = batch.alerts.map(a => ({
      id:          a.id,
      server:      serverName,
      severity:    a.severity,
      metric_type: a.metric_type,
      message:     a.message,
      actual_value: a.actual_value,
      created_at:  a.created_at,
    }));

    try {
      callTimestamps.push(now);
      lastSummarised.set(serverId, now);

      const summary = await this.callAI(safeAlerts);
      if (!summary) return;

      // Persist to DB
      const alertIds = batch.alerts.map(a => a.id);
      const insertRes = await query(
        `INSERT INTO alert_summaries (server_id, alert_ids, summary, model, created_at)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
        [serverId, alertIds, summary, this.cfg.model]
      );
      const summaryId: number = insertRes.rows[0].id;

      // Back-link each alert to this summary
      await query(
        'UPDATE alerts SET summary_id = $1 WHERE id = ANY($2)',
        [summaryId, alertIds]
      );

      console.log(`[summarizer] summary #${summaryId} created for server ${serverName} (${alertIds.length} alerts)`);
    } catch (err) {
      console.error('[summarizer] error creating summary:', err);
      // Never let summarisation failures affect alert delivery
    }
  }

  // ── AI API call ─────────────────────────────────────────────────────────────

  private async callAI(alerts: object[]): Promise<string | null> {
    if (!this.cfg.api_key) {
      console.warn('[summarizer] api_key not set — skipping AI call');
      return null;
    }

    const body = {
      model: this.cfg.model ?? 'grok-3-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are Fenris, an infrastructure monitoring assistant. ' +
            'Summarize the following alerts concisely. Explain what likely caused them, ' +
            'whether they are related, and suggest actions. Be direct and technical.',
        },
        {
          role: 'user',
          content: JSON.stringify(alerts, null, 2),
        },
      ],
    };

    const res = await fetch(this.cfg.api_url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.cfg.api_key}`,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '(no body)');
      console.error(`[summarizer] AI API error ${res.status}: ${text}`);
      return null;
    }

    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?:   { message?: string };
    };

    if (json.error) {
      console.error('[summarizer] AI API returned error:', json.error.message);
      return null;
    }

    return json.choices?.[0]?.message?.content?.trim() ?? null;
  }
}
