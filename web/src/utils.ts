/** Returns a hex color string based on a 0-100 percentage. */
export function metricColor(pct: number): string {
  if (pct >= 80) return '#ef4444';
  if (pct >= 60) return '#f59e0b';
  return '#10b981';
}

/** Returns a Tailwind text color class based on a 0-100 percentage. */
export function metricTextClass(pct: number): string {
  if (pct >= 80) return 'text-red-400';
  if (pct >= 60) return 'text-amber-400';
  return 'text-emerald-400';
}

/** Format bytes/s for network display. */
export function fmtBytesPerSec(b: number): string {
  if (b >= 1_000_000) return (b / 1_000_000).toFixed(1) + ' MB/s';
  if (b >= 1_000)     return (b / 1_000).toFixed(1) + ' KB/s';
  return b.toFixed(0) + ' B/s';
}

/** Format raw bytes (for totals, not rates). */
export function fmtBytes(b: number): string {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + ' GB';
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(1) + ' MB';
  if (b >= 1_024)         return (b / 1_024).toFixed(1) + ' KB';
  return b.toFixed(0) + ' B';
}

/** Format a Date to HH:MM:SS. */
export function fmtClock(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false });
}

/** Seconds elapsed since an ISO timestamp. Returns Infinity if null. */
export function secondsAgo(ts: string | null): number {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts).getTime()) / 1000;
}

/** True if the server sent a heartbeat within the last 90 seconds. */
export function isOnline(lastHeartbeat: string | null): boolean {
  return secondsAgo(lastHeartbeat) < 90;
}

/** Human-relative time string for a timestamp. */
export function fmtRelativeTime(ts: string | null): string {
  if (!ts) return 'never';
  const secs = secondsAgo(ts);
  if (secs < 5)    return 'just now';
  if (secs < 60)   return `${Math.round(secs)}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Format container uptime. */
export function fmtUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return '—';
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Shorten a Docker image name to just the image:tag component. */
export function truncateImage(image: string): string {
  const short = image.split('/').pop() ?? image;
  return short.length > 32 ? short.slice(0, 29) + '…' : short;
}

/** Format a number to a fixed number of decimal places with optional suffix. */
export function fmtNum(n: number, decimals = 1, suffix = ''): string {
  return n.toFixed(decimals) + suffix;
}
