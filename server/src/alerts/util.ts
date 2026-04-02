import { Alert } from '../types.js';

/**
 * Shared cooldown store — keyed by "channel:server_id:metric_type" so the
 * same metric type on the same server is throttled across all alert messages.
 * Resets on server restart (in-memory), but that is acceptable — a restart
 * itself resets the anomaly detector history anyway.
 */
const lastSent = new Map<string, number>();
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes per (server, metric_type)

/**
 * Returns true if this alert should fire on the given channel:
 *  - The channel is enabled
 *  - The alert's severity is in the channel's severity_levels list
 *  - The 15-minute cooldown for (channel, server_id, metric_type) has expired
 */
export function shouldAlert(
  channel: string,
  enabled: boolean,
  severityLevels: string[],
  alert: Alert
): boolean {
  if (!enabled) return false;
  if (!severityLevels.includes(alert.severity)) return false;

  const key = `${channel}:${alert.server_id}:${alert.metric_type ?? 'unknown'}`;
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
