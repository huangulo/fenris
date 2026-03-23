import nodemailer from 'nodemailer';
import { Alert, Config } from '../types.js';
import { shouldAlert, severityColor, fmtKV } from './util.js';

type EmailConfig = NonNullable<Config['alerts']['email']>;

export class EmailAlert {
  private cfg: EmailConfig;
  private transporter: nodemailer.Transporter;

  constructor(cfg: EmailConfig) {
    this.cfg = cfg;
    this.transporter = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: cfg.smtp_port,
      secure: cfg.smtp_secure,
      auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
    });
  }

  async send(alert: Alert): Promise<boolean> {
    if (!shouldAlert('email', this.cfg.enabled, this.cfg.severity_levels, alert)) return false;

    const color = severityColor(alert.severity);
    const emojis: Record<string, string> = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
    const emoji = emojis[alert.severity] ?? '🔔';
    const subject = `${emoji} Fenris [${alert.severity.toUpperCase()}] — ${alert.message.slice(0, 80)}`;

    const rows = [
      ['Severity',   `<span style="color:${color};font-weight:bold">${alert.severity.toUpperCase()}</span>`],
      ['Message',    alert.message],
      ['Metric',     alert.metric_type?.toUpperCase() ?? '—'],
      ['Actual',     fmtKV(alert.actual_value)],
      ['Threshold',  fmtKV(alert.threshold_value)],
      ['Server ID',  String(alert.server_id)],
      ['Time',       alert.created_at.toISOString()],
    ];

    const tableRows = rows
      .map(([label, value]) =>
        `<tr>
          <td style="padding:6px 12px;font-weight:bold;background:#f5f5f5;white-space:nowrap">${label}</td>
          <td style="padding:6px 12px">${value}</td>
        </tr>`
      )
      .join('\n');

    const html = `<!DOCTYPE html>
<html>
<body style="font-family:monospace;font-size:14px;color:#222;max-width:600px;margin:0 auto">
  <div style="border-left:4px solid ${color};padding:16px 20px;background:#fafafa;margin-bottom:16px">
    <h2 style="margin:0 0 4px;font-size:16px">${emoji} Fenris Alert</h2>
    <p style="margin:0;color:#555">${alert.message}</p>
  </div>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <tbody>${tableRows}</tbody>
  </table>
  <p style="font-size:11px;color:#999;margin-top:16px">
    Sent by <strong>Fenris</strong> infrastructure monitor
  </p>
</body>
</html>`;

    try {
      await this.transporter.sendMail({
        from: this.cfg.from,
        to: this.cfg.to.join(', '),
        subject,
        html,
      });
      console.log('Alert sent via email:', alert.id, '→', this.cfg.to.join(', '));
      return true;
    } catch (err) {
      console.error('Email alert error:', err);
      return false;
    }
  }
}
