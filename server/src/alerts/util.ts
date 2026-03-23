import { Alert } from '../types.js';

/**
 * Shared cooldown store — keyed by "channel:alertId" so each channel
 * tracks its own last-sent time independently.
 */
const lastSent = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns true if this alert should fire on the given channel:
 *  - The channel is enabled
 *  - The alert's severity is in the channel's severity_levels list
 *  - The cooldown for this (channel, alert-message) pair has expired
 *
 * Uses the alert message as the dedup key so repeated identical anomalies
 * are throttled even if the DB id differs.
 */
export function shouldAlert(
  channel: string,
  enabled: boolean,
  severityLevels: string[],
  alert: Alert
): boolean {
  if (!enabled) return false;
  if (!severityLevels.includes(alert.severity)) return false;

  const key = `${channel}:${alert.message}`;
  const now = Date.now();
  const last = lastSent.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return false;

  lastSent.set(key, now);
  return true;
}

/** Severity → hex colour string for use in HTML and Slack attachments */
export function severityColor(severity: string): string {
  const map: Record<string, string> = {
    info:     '#3498db',
    warning:  '#f39c12',
    critical: '#e74c3c',
  };
  return map[severity] ?? '#95a5a6';
}

/** Severity → Discord embed integer colour */
export function severityColorDiscord(severity: string): number {
  const map: Record<string, number> = {
    info:     3447003,   // blue
    warning:  16098851,  // orange
    critical: 16711680,  // red
  };
  return map[severity] ?? 0;
}

/** Format a key/value map as a compact string ("key: val, key: val") */
export function fmtKV(obj?: Record<string, number>): string {
  if (!obj) return '—';
  return Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`).join(', ');
}
