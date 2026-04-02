import { Alert, Config } from '../types.js';
import { DiscordAlert } from './discord.js';
import { SlackAlert } from './slack.js';
import { EmailAlert } from './email.js';

export interface TestResult {
  sent:     string[];
  failed:   string[];
  disabled: string[];
}

/**
 * AlertDispatcher initialises every enabled channel from config and fires
 * them all in parallel when dispatchAlert() is called. A failure on one
 * channel (bad webhook, SMTP timeout, etc.) is logged and does NOT prevent
 * the remaining channels from delivering.
 */
export class AlertDispatcher {
  private channels: Array<{ name: string; send: (alert: Alert) => Promise<boolean> }> = [];
  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    const { discord, slack, email } = cfg.alerts;

    if (discord?.enabled && discord.webhook_url) {
      this.channels.push({
        name: 'discord',
        send: (a) => new DiscordAlert(discord.webhook_url, discord.enabled, discord.severity_levels).send(a),
      });
    }

    if (slack?.enabled && slack.webhook_url) {
      this.channels.push({
        name: 'slack',
        send: (a) => new SlackAlert(slack.webhook_url, slack.enabled, slack.severity_levels).send(a),
      });
    }

    if (email?.enabled && email.smtp_host) {
      this.channels.push({
        name: 'email',
        send: (a) => new EmailAlert(email).send(a),
      });
    }

    const names = this.channels.map(c => c.name);
    console.log('AlertDispatcher: enabled channels:', names.length ? names.join(', ') : 'none');
  }

  async dispatchAlert(alert: Alert): Promise<void> {
    if (this.channels.length === 0) return;

    const results = await Promise.allSettled(
      this.channels.map(ch => ch.send(alert))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        console.error(`Alert channel '${this.channels[i].name}' threw unexpectedly:`, result.reason);
      }
    }
  }

  /**
   * Send a test alert through a subset (or all) of the configured channels.
   * Uses server_id=0 / metric_type="test" so the in-memory cooldown key
   * ("channel:0:test") is always fresh and never conflicts with real alerts.
   * Temporary channel instances are created with all severity levels so the
   * severity filter in shouldAlert() is satisfied for the "info" test alert.
   *
   * Does NOT write to the database.
   */
  async dispatchTest(requestedChannels?: string[]): Promise<TestResult> {
    const ALL_SEVERITIES = ['info', 'warning', 'critical'];
    const { discord, slack, email } = this.cfg.alerts;

    // Build a map of channel-name → temp send function (full severity levels)
    const testChannels = new Map<string, () => Promise<boolean>>();

    if (discord?.webhook_url) {
      testChannels.set('discord', () =>
        new DiscordAlert(discord.webhook_url, true, ALL_SEVERITIES).send(testAlert)
      );
    }
    if (slack?.webhook_url) {
      testChannels.set('slack', () =>
        new SlackAlert(slack.webhook_url, true, ALL_SEVERITIES).send(testAlert)
      );
    }
    if (email?.smtp_host) {
      testChannels.set('email', () =>
        new EmailAlert({ ...email, enabled: true, severity_levels: ALL_SEVERITIES }).send(testAlert)
      );
    }

    const testAlert: Alert = {
      id:              0,
      server_id:       0,
      severity:        'info',
      message:         'Fenris test alert — all systems nominal',
      metric_type:     'test' as Alert['metric_type'],
      threshold_value: {},
      actual_value:    {},
      acknowledged:    false,
      created_at:      new Date(),
    };

    const filter = requestedChannels ?? [...testChannels.keys()];
    const sent: string[]     = [];
    const failed: string[]   = [];
    const disabled: string[] = [];

    for (const name of filter) {
      const fn = testChannels.get(name);
      if (!fn) {
        // Channel requested but not configured / no credentials
        disabled.push(name);
        continue;
      }
      try {
        const ok = await fn();
        if (ok) sent.push(name);
        else    failed.push(name);
      } catch (err) {
        console.error(`[test-alert] channel '${name}' threw:`, err);
        failed.push(name);
      }
    }

    // Any configured-but-not-requested channels count as disabled
    if (requestedChannels) {
      for (const name of testChannels.keys()) {
        if (!filter.includes(name)) disabled.push(name);
      }
    }

    console.log(`[test-alert] sent=${sent.join(',') || '—'}  failed=${failed.join(',') || '—'}  disabled=${disabled.join(',') || '—'}`);
    return { sent, failed, disabled };
  }
}
