import { Alert, Config } from '../types.js';
import { DiscordAlert } from './discord.js';
import { SlackAlert } from './slack.js';
import { EmailAlert } from './email.js';

/**
 * AlertDispatcher initialises every enabled channel from config and fires
 * them all in parallel when dispatchAlert() is called. A failure on one
 * channel (bad webhook, SMTP timeout, etc.) is logged and does NOT prevent
 * the remaining channels from delivering.
 */
export class AlertDispatcher {
  private channels: Array<{ name: string; send: (alert: Alert) => Promise<boolean> }> = [];

  constructor(cfg: Config) {
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
}
