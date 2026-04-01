import React from 'react';

// ── Severity badge ────────────────────────────────────────────────────────────

const SEV: Record<string, string> = {
  critical: 'bg-red-950/70 text-red-300 border-red-800/60',
  warning:  'bg-amber-950/70 text-amber-300 border-amber-800/60',
  info:     'bg-blue-950/70 text-blue-300 border-blue-800/60',
};

export function SeverityBadge({ sev }: { sev: string }) {
  return (
    <span className={`inline-flex items-center text-[11px] font-mono font-semibold uppercase tracking-wide px-2 py-0.5 rounded border whitespace-nowrap ${SEV[sev] ?? 'bg-gray-800 text-gray-400 border-gray-700'}`}>
      {sev}
    </span>
  );
}

// ── Container state badge ─────────────────────────────────────────────────────

const STATE: Record<string, { cls: string; dot: string }> = {
  running:    { cls: 'bg-emerald-950/70 text-emerald-300 border-emerald-800/60', dot: 'bg-emerald-400' },
  restarting: { cls: 'bg-amber-950/70 text-amber-300 border-amber-800/60',      dot: 'bg-amber-400 animate-pulse' },
  paused:     { cls: 'bg-blue-950/70 text-blue-300 border-blue-800/60',         dot: 'bg-blue-400' },
  exited:     { cls: 'bg-red-950/70 text-red-400 border-red-800/60',            dot: 'bg-red-500' },
  dead:       { cls: 'bg-gray-800/70 text-gray-500 border-gray-700/60',         dot: 'bg-gray-600' },
  stopped:    { cls: 'bg-red-950/70 text-red-400 border-red-800/60',            dot: 'bg-red-500' },
};

const fallbackState = { cls: 'bg-gray-800 text-gray-400 border-gray-700', dot: 'bg-gray-600' };

export function StateBadge({ state }: { state: string }) {
  const s = STATE[state] ?? fallbackState;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded border whitespace-nowrap ${s.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
      {state}
    </span>
  );
}

// ── Online dot ────────────────────────────────────────────────────────────────

export function OnlineDot({ online, size = 'sm' }: { online: boolean; size?: 'sm' | 'md' }) {
  const base = size === 'md' ? 'w-2.5 h-2.5' : 'w-2 h-2';
  return (
    <span
      className={`inline-block rounded-full flex-shrink-0 ${base} ${
        online
          ? 'bg-emerald-400 shadow-[0_0_6px_#10b981]'
          : 'bg-gray-600'
      }`}
    />
  );
}
