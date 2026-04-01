import React from 'react';
import { ServerRow } from '../types';
import { isOnline, fmtClock } from '../utils';

interface TopBarProps {
  servers: ServerRow[];
  selectedServerId: number | null;
  onSelectServer: (id: number | null) => void;
  clock: Date;
  lastRefresh: Date | null;
}

const WolfIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {/* Stylised wolf head */}
    <path d="M12 3 L7 7 L4 6 L5 10 L3 13 L6 14 L8 18 L12 20 L16 18 L18 14 L21 13 L19 10 L20 6 L17 7 Z"/>
    <circle cx="9.5" cy="12.5" r="0.8" fill="currentColor"/>
    <circle cx="14.5" cy="12.5" r="0.8" fill="currentColor"/>
    <path d="M10.5 15.5 Q12 16.5 13.5 15.5"/>
  </svg>
);

export function TopBar({ servers, selectedServerId, onSelectServer, clock, lastRefresh }: TopBarProps) {
  const onlineCount = servers.filter(s => isOnline(s.last_heartbeat)).length;
  const anyOnline   = onlineCount > 0;

  return (
    <header className="h-14 flex items-center gap-4 px-4 md:px-6 border-b border-gray-800/60 bg-[#0b0f1a]/90 backdrop-blur-sm flex-shrink-0 z-10">

      {/* Logo — only visible on mobile (sidebar hides it on desktop) */}
      <div className="flex items-center gap-2 md:hidden">
        <span className="text-cyan-400 opacity-80"><WolfIcon /></span>
        <span className="font-mono font-bold text-sm tracking-[0.2em] text-white">FENRIS</span>
      </div>

      {/* Spacer on mobile */}
      <div className="flex-1 md:flex-none" />

      {/* Server selector */}
      {servers.length > 0 && (
        <select
          value={selectedServerId ?? ''}
          onChange={e => onSelectServer(e.target.value === '' ? null : parseInt(e.target.value))}
          className="text-xs font-mono bg-gray-800/80 border border-gray-700/60 text-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-gray-500 transition-colors hover:border-gray-600 cursor-pointer appearance-none pr-7 bg-no-repeat"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`, backgroundPosition: 'right 8px center' }}
        >
          <option value="">All Servers</option>
          {servers.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      )}

      {/* Push everything else right */}
      <div className="flex-1" />

      {/* Status */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${anyOnline ? 'bg-emerald-400 shadow-[0_0_5px_#10b981]' : 'bg-gray-600'}`} />
        <span className={`font-mono ${anyOnline ? 'text-emerald-400' : 'text-gray-500'}`}>
          {servers.length === 0
            ? 'no agents'
            : anyOnline
              ? `${onlineCount}/${servers.length} online`
              : 'offline'}
        </span>
      </div>

      {/* Last refresh */}
      {lastRefresh && (
        <span className="hidden lg:block text-xs font-mono text-gray-600">
          ↻ {fmtClock(lastRefresh)}
        </span>
      )}

      {/* Clock */}
      <span className="text-xs font-mono text-gray-400 tabular-nums w-16 text-right">
        {fmtClock(clock)}
      </span>
    </header>
  );
}
