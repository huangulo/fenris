import { Alert } from '../types.js';
import { shouldAlert, severityColorDiscord, fmtKV } from './util.js';

export class DiscordAlert {
  private webhookUrl: string;
  private enabled: boolean;
  private severityLevels: string[];

  constructor(webhookUrl: string, enabled: boolean, severityLevels: string[]) {
    this.webhookUrl = webhookUrl;
    this.enabled = enabled;
    this.severityLevels = severityLevels;
  }

  async send(alert: Alert): Promise<boolean> {
    if (!shouldAlert('discord', this.enabled, this.severityLevels, alert)) return false;

    const emojis: Record<string, string> = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
    const emoji = emojis[alert.severity] ?? 'ℹ️';

    const fields: Array<{ name: string; value: string; inline: boolean }> = [];
    if (alert.metric_type) fields.push({ name: 'Metric', value: alert.metric_type.toUpperCase(), inline: true });
    if (alert.actual_value) fields.push({ name: 'Actual', value: fmtKV(alert.actual_value), inline: true });
    if (alert.threshold_value) fields.push({ name: 'Threshold', value: fmtKV(alert.threshold_value), inline: true });

    const payload = {
      embeds: [{
        title: `${emoji} Fenris Alert — ${alert.severity.toUpperCase()}`,
        description: alert.message,
        color: severityColorDiscord(alert.severity),
        fields,
        timestamp: alert.created_at.toISOString(),
      }]
    };

    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        console.log('Alert sent to Discord:', alert.id);
        return true;
      }
      console.error('Discord alert failed:', res.status, res.statusText);
      return false;
    } catch (err) {
      console.error('Discord alert error:', err);
      return false;
    }
  }
}
