import { Alert } from '../types.js';

interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp: string;
}

interface DiscordPayload {
  embeds: DiscordEmbed[];
}

export class DiscordAlert {
  private webhookUrl: string;
  private enabled: boolean;
  private severityLevels: string[];

  constructor(webhookUrl: string, enabled: boolean, severityLevels: string[]) {
    this.webhookUrl = webhookUrl;
    this.enabled = enabled;
    this.severityLevels = severityLevels;
  }

  /**
   * Check if severity should trigger alert
   */
  shouldAlert(severity: string): boolean {
    return this.enabled && this.severityLevels.includes(severity);
  }

  /**
   * Convert severity to Discord embed color
   */
  private severityToColor(severity: string): number {
    const colors = {
      'info': 3447003,      // Blue
      'warning': 16776960,   // Orange
      'critical': 16711680    // Red
    };
    return colors[severity as keyof typeof colors] || 0;
  }

  /**
   * Format alert as Discord embed
   */
  formatAlert(alert: Alert): DiscordEmbed {
    const embed: DiscordEmbed = {
      title: this.formatTitle(alert),
      description: alert.message,
      color: this.severityToColor(alert.severity),
      timestamp: alert.created_at.toISOString(),
      fields: this.formatFields(alert)
    };
    return embed;
  }

  /**
   * Format title with emoji and severity
   */
  private formatTitle(alert: Alert): string {
    const emojis = {
      'info': 'ℹ️',
      'warning': '⚠️',
      'critical': '🚨'
    };
    const emoji = emojis[alert.severity] || 'ℹ️';
    return `${emoji} Fenris Alert - ${alert.severity.toUpperCase()}`;
  }

  /**
   * Format alert fields
   */
  private formatFields(alert: Alert): Array<{ name: string; value: string; inline: boolean }> {
    const fields: Array<{ name: string; value: string; inline: boolean }> = [];
    
    // Metric type
    if (alert.metric_type) {
      fields.push({
        name: 'Metric Type',
        value: alert.metric_type.toUpperCase(),
        inline: true
      });
    }
    
    // Actual value
    if (alert.actual_value) {
      const valueStr = Object.entries(alert.actual_value)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      fields.push({
        name: 'Actual Value',
        value: valueStr,
        inline: true
      });
    }
    
    // Threshold
    if (alert.threshold_value) {
      const thresholdStr = Object.entries(alert.threshold_value)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      fields.push({
        name: 'Threshold',
        value: thresholdStr,
        inline: true
      });
    }
    
    // Acknowledged status
    fields.push({
      name: 'Acknowledged',
      value: alert.acknowledged ? '✅ Yes' : '❌ No',
      inline: true
    });
    
    return fields;
  }

  /**
   * Send alert to Discord webhook
   */
  async send(alert: Alert): Promise<boolean> {
    if (!this.shouldAlert(alert.severity)) {
      console.log('Severity not in configured levels, skipping:', alert.severity);
      return false;
    }
    
    try {
      const embed = this.formatAlert(alert);
      const payload: DiscordPayload = {
        embeds: [embed]
      };
      
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        console.log('Alert sent to Discord successfully:', alert.id);
        return true;
      } else {
        console.error('Failed to send Discord alert:', response.status, response.statusText);
        return false;
      }
    } catch (error) {
      console.error('Error sending Discord alert:', error);
      return false;
    }
  }

  /**
   * Test webhook connectivity
   */
  async test(): Promise<boolean> {
    try {
      const testPayload: DiscordPayload = {
        embeds: [{
          title: '🧪 Fenris Webhook Test',
          description: 'This is a test message to verify Discord integration is working.',
          color: 3447003,
          timestamp: new Date().toISOString()
        }]
      };
      
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testPayload)
      });
      
      return response.ok;
    } catch (error) {
      console.error('Discord webhook test failed:', error);
      return false;
    }
  }
}
