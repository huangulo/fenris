import React from 'react';
import { ServerRow } from '../types';
import { isOnline, fmtClock } from '../utils';

interface TopBarProps {
  servers:          ServerRow[];
  selectedServerId: number | null;
  onSelectServer:   (id: number | null) => void;
  clock:            Date;
  lastRefresh:      Date | null;
}

function WolfWordmark() {
  return (
    <div className="flex items-center gap-2">
      {/* Mini wolf icon */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-cyan-500/70">
        <path
          d="M12 3C9 3 7 5 7 5L3.5 6.5L5 10.5L3 13.5L6.5 14.5L8 17L12 19.5L16 17L17.5 14.5L21 13.5L19 10.5L20.5 6.5L17 5C17 5 15 3 12 3Z"
          stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"
        />
        <circle cx="9.5" cy="12" r="1" fill="currentColor"/>
        <circle cx="14.5" cy="12" r="1" fill="currentColor"/>
        <path d="M10.5 15Q12 16.2 13.5 15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none"/>
      </svg>
      <span className="font-mono font-bold text-sm tracking-[0.18em] text-white">FENRIS</span>
    </div>
  );
}

export function TopBar({ servers, selectedServerId, onSelectServer, clock, lastRefresh }: TopBarProps) {
  const onlineCount = servers.filter(s => isOnline(s.last_heartbeat)).length;
  const anyOnline   = onlineCount > 0;

  return (
    <header className="h-14 flex items-center gap-3 px-4 md:px-5 border-b border-gray-800/60 bg-[#0b0f1a] flex-shrink-0 z-10">

      {/* Wordmark — only on mobile (desktop shows it in sidebar) */}
      <div className="md:hidden">
        <WolfWordmark />
      </div>

      {/* Separator on mobile */}
      <div className="md:hidden w-px h-5 bg-gray-800" />

      {/* Server selector */}
      {servers.length > 0 && (
        <div className="relative">
          <select
            value={selectedServerId ?? ''}
            onChange={e => onSelectServer(e.target.value === '' ? null : parseInt(e.target.value))}
            className="
              text-xs font-mono
              bg-gray-800/70 border border-gray-700/50
              text-gray-200 rounded-lg
              pl-3 pr-7 py-1.5
              focus:outline-none focus:border-gray-500
              hover:border-gray-600
              transition-colors cursor-pointer
            "
          >
            <option value="">All Servers</option>
            {servers.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {/* Chevron */}
          <svg
            width="11" height="11" viewBox="0 0 24 24" fill="none"
            stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      )}

      {/* Push right */}
      <div className="flex-1" />

      {/* Online indicator */}
      <div className="flex items-center gap-2 text-xs">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          anyOnline ? 'bg-emerald-400 shadow-[0_0_6px_#10b981]' : 'bg-gray-700'
        }`} />
        <span className={`font-mono hidden sm:block ${anyOnline ? 'text-emerald-400' : 'text-gray-500'}`}>
          {servers.length === 0
            ? 'no agents'
            : anyOnline
              ? `${onlineCount}/${servers.length} online`
              : 'offline'}
        </span>
      </div>

      {/* Last refresh — desktop only */}
      {lastRefresh && (
        <span className="hidden lg:block text-[11px] font-mono text-gray-700 tabular-nums">
          ↻ {fmtClock(lastRefresh)}
        </span>
      )}

      {/* Clock */}
      <span className="text-[11px] font-mono text-gray-500 tabular-nums w-[52px] text-right">
        {fmtClock(clock)}
      </span>
    </header>
  );
}
