import { Alert } from '../types.js';
import { shouldAlert, severityColor, fmtKV } from './util.js';

export class SlackAlert {
  private webhookUrl: string;
  private enabled: boolean;
  private severityLevels: string[];

  constructor(webhookUrl: string, enabled: boolean, severityLevels: string[]) {
    this.webhookUrl = webhookUrl;
    this.enabled = enabled;
    this.severityLevels = severityLevels;
  }

  async send(alert: Alert): Promise<boolean> {
    if (!shouldAlert('slack', this.enabled, this.severityLevels, alert)) return false;

    const emojis: Record<string, string> = { info: ':information_source:', warning: ':warning:', critical: ':rotating_light:' };
    const emoji = emojis[alert.severity] ?? ':bell:';
    const color = severityColor(alert.severity);
    const ts = Math.floor(alert.created_at.getTime() / 1000);

    // Block Kit: header + attachment for the colour sidebar
    const payload = {
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${emoji} Fenris Alert — ${alert.severity.toUpperCase()}`, emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${alert.message}*` },
        },
      ],
      attachments: [
        {
          color,
          fields: [
            alert.metric_type && { title: 'Metric', value: alert.metric_type.toUpperCase(), short: true },
            alert.actual_value && { title: 'Actual', value: fmtKV(alert.actual_value), short: true },
            alert.threshold_value && { title: 'Threshold', value: fmtKV(alert.threshold_value), short: true },
            { title: 'Server', value: `id: ${alert.server_id}`, short: true },
          ].filter(Boolean),
          footer: 'Fenris',
          ts,
        },
      ],
    };

    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        console.log('Alert sent to Slack:', alert.id);
        return true;
      }
      console.error('Slack alert failed:', res.status, res.statusText);
      return false;
    } catch (err) {
      console.error('Slack alert error:', err);
      return false;
    }
  }
}
