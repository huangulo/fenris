import { query } from '../db/client.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';
import { Alert, Config } from '../types.js';

interface DigestConfig {
  enabled: boolean;
  time: string;      // "HH:MM"
  timezone: string;  // IANA e.g. "America/Bogota"
}

/**
 * Fires a daily summary alert at the configured time.
 * Replaces individual low-severity notifications with a single digest.
 */
export class DailyDigest {
  private cfg: DigestConfig;
  private dispatcher: AlertDispatcher;
  private timer: NodeJS.Timeout | null = null;

  constructor(cfg: DigestConfig, dispatcher: AlertDispatcher) {
    this.cfg        = cfg;
    this.dispatcher = dispatcher;
  }

  start(): void {
    if (!this.cfg.enabled) {
      console.log('[digest] disabled — skipping');
      return;
    }
    this.scheduleNext();
    console.log(`[digest] scheduled daily at ${this.cfg.time} ${this.cfg.timezone}`);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Compute ms until the next firing of cfg.time in cfg.timezone. */
  private msUntilNext(): number {
    const [hStr, mStr] = this.cfg.time.split(':');
    const targetH = parseInt(hStr, 10);
    const targetM = parseInt(mStr ?? '0', 10);

    // Determine current wall-clock time in target timezone
    const now = new Date();
    const tzNow = new Date(now.toLocaleString('en-US', { timeZone: this.cfg.timezone }));
    const tzH = tzNow.getHours();
    const tzM = tzNow.getMinutes();
    const tzS = tzNow.getSeconds();

    // Minutes from now until target time today
    let diffMin = (targetH * 60 + targetM) - (tzH * 60 + tzM);
    if (diffMin <= 0) diffMin += 24 * 60; // already past today → tomorrow

    return (diffMin * 60 - tzS) * 1_000;
  }

  private scheduleNext(): void {
    const delay = this.msUntilNext();
    console.log(`[digest] next run in ${(delay / 60_000).toFixed(1)} min`);
    this.timer = setTimeout(async () => {
      await this.run();
      this.scheduleNext(); // reschedule for tomorrow
    }, delay);
  }

  private async run(): Promise<void> {
    console.log('[digest] generating daily summary…');
    try {
      // Stats for the past 24 hours
      const totRes = await query(
        `SELECT COUNT(*) AS total FROM alerts WHERE created_at > NOW() - INTERVAL '24 hours'`
      );
      const total = parseInt(totRes.rows[0]?.total ?? '0', 10);

      const byMetric = await query(
        `SELECT metric_type, COUNT(*) AS cnt
         FROM alerts
         WHERE created_at > NOW() - INTERVAL '24 hours'
           AND metric_type IS NOT NULL
         GROUP BY metric_type
         ORDER BY cnt DESC
         LIMIT 5`
      );

      const byServer = await query(
        `SELECT s.name, COUNT(*) AS cnt
         FROM alerts a
         JOIN servers s ON s.id = a.server_id
         WHERE a.created_at > NOW() - INTERVAL '24 hours'
         GROUP BY s.name
         ORDER BY cnt DESC
         LIMIT 5`
      );

      if (total === 0) {
        console.log('[digest] no alerts in the last 24 h — skipping dispatch');
        return;
      }

      const metricLines = byMetric.rows
        .map((r: { metric_type: string; cnt: string }) => `  • ${r.metric_type}: ${r.cnt}`)
        .join('\n');

      const serverLines = byServer.rows
        .map((r: { name: string; cnt: string }) => `  • ${r.name}: ${r.cnt}`)
        .join('\n');

      const date = new Date().toLocaleDateString('en-CA', { timeZone: this.cfg.timezone });
      const message =
        `Daily Digest — ${date}\n` +
        `Total alerts (last 24 h): ${total}\n\n` +
        `Top metric types:\n${metricLines || '  (none)'}\n\n` +
        `Top noisy servers:\n${serverLines || '  (none)'}`;

      const alert: Alert = {
        id: 0,
        server_id: 0,
        severity: 'info',
        message,
        metric_type: undefined,
        threshold_value: undefined,
        actual_value: { total_alerts: total },
        acknowledged: false,
        created_at: new Date(),
      };

      const res = await query(
        `INSERT INTO alerts (server_id, severity, message, actual_value, acknowledged, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
        [
          alert.server_id, alert.severity, alert.message,
          JSON.stringify(alert.actual_value), alert.acknowledged, alert.created_at,
        ]
      );
      alert.id = res.rows[0].id;

      console.log(`[digest] dispatching daily summary — ${total} alerts`);
      await this.dispatcher.dispatchAlert(alert);
    } catch (err) {
      console.error('[digest] run error:', err);
    }
  }
}
