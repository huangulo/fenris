import React, { useMemo, useState, useEffect } from 'react';
import { DockerSnapshot, ServerRow, ContainerTopEntry } from '../types';
import { fmtBytesPerSec, fmtUptime, truncateImage, metricTextClass } from '../utils';
import { StateBadge } from '../components/Badges';
import { fetchDockerTop } from '../api';

interface ContainersPageProps {
  docker: DockerSnapshot;
  servers: ServerRow[];
  selectedServerId: number | null;
  onSelectServer: (id: number | null) => void;
}

// ── Top consumers card ────────────────────────────────────────────────────────

interface TopCardProps {
  title: string;
  metric: 'cpu' | 'memory' | 'network';
  entries: ContainerTopEntry[];
  formatValue: (e: ContainerTopEntry) => string;
  colorClass: (e: ContainerTopEntry) => string;
}

function TopCard({ title, metric, entries, formatValue, colorClass }: TopCardProps) {
  return (
    <div className="card p-4 space-y-3">
      <div className="text-[10px] uppercase tracking-widest text-gray-600 font-medium">{title}</div>
      {entries.length === 0 ? (
        <p className="text-xs text-gray-700 font-mono">No data</p>
      ) : (
        <div className="space-y-2">
          {entries.map((e, i) => (
            <div key={`${e.server_id}-${e.container_name}`} className="flex items-center gap-2.5">
              <span className="text-[10px] font-mono text-gray-700 w-4 text-right">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono text-white truncate">{e.container_name}</div>
                <div className="text-[10px] font-mono text-gray-600 truncate">{e.server_name}</div>
              </div>
              <span className={`text-xs font-mono font-semibold tabular-nums ${colorClass(e)}`}>
                {formatValue(e)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ContainersPage({ docker, servers, selectedServerId, onSelectServer }: ContainersPageProps) {
  const [topCpu,    setTopCpu]    = useState<ContainerTopEntry[]>([]);
  const [topMem,    setTopMem]    = useState<ContainerTopEntry[]>([]);
  const [topNet,    setTopNet]    = useState<ContainerTopEntry[]>([]);
  const [topLoaded, setTopLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      fetchDockerTop('cpu',     5),
      fetchDockerTop('memory',  5),
      fetchDockerTop('network', 5),
    ]).then(([cpu, mem, net]) => {
      setTopCpu(Array.isArray(cpu) ? cpu as ContainerTopEntry[] : []);
      setTopMem(Array.isArray(mem) ? mem as ContainerTopEntry[] : []);
      setTopNet(Array.isArray(net) ? net as ContainerTopEntry[] : []);
      setTopLoaded(true);
    }).catch(err => {
      console.error('[ContainersPage] top consumers fetch error:', err);
      setTopLoaded(true);
    });
  }, []);

  const sorted = useMemo(
    () => [...docker.containers].sort((a, b) => {
      const aDown = a.state !== 'running' ? 0 : 1;
      const bDown = b.state !== 'running' ? 0 : 1;
      if (aDown !== bDown) return aDown - bDown;
      return a.name.localeCompare(b.name);
    }),
    [docker.containers],
  );

  const running   = sorted.filter(c => c.state === 'running').length;
  const unhealthy = sorted.filter(c => c.state !== 'running').length;

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-white">Containers</h1>
          <span className="text-xs font-mono text-emerald-400">{running} running</span>
          {unhealthy > 0 && (
            <span className="text-xs font-mono text-red-400">{unhealthy} unhealthy</span>
          )}
        </div>

        {servers.length > 1 && (
          <select
            value={selectedServerId ?? ''}
            onChange={e => onSelectServer(e.target.value === '' ? null : parseInt(e.target.value))}
            className="text-xs font-mono bg-gray-800/80 border border-gray-700/60 text-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-gray-500"
          >
            <option value="">All Servers</option>
            {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      {/* Top consumers — always shown after load so empty state is visible */}
      <div>
        <h2 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">Top Consumers</h2>
        {!topLoaded ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[0, 1, 2].map(i => (
              <div key={i} className="card p-4 h-32 animate-pulse bg-gray-800/40" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <TopCard
              title="Top 5 CPU %"
              metric="cpu"
              entries={topCpu}
              formatValue={e => `${Number(e.cpu_percent).toFixed(1)}%`}
              colorClass={e => metricTextClass(Number(e.cpu_percent))}
            />
            <TopCard
              title="Top 5 Memory MB"
              metric="memory"
              entries={topMem}
              formatValue={e => `${Number(e.memory_mb).toFixed(0)} MB`}
              colorClass={e => metricTextClass(Number(e.memory_percent))}
            />
            <TopCard
              title="Top 5 Network I/O"
              metric="network"
              entries={topNet}
              formatValue={e => fmtBytesPerSec(Number(e.net_rx_bytes) + Number(e.net_tx_bytes))}
              colorClass={() => 'text-cyan-400'}
            />
          </div>
        )}
      </div>

      {/* Container table */}
      {sorted.length === 0 ? (
        <div className="card p-8 flex flex-col items-center gap-3 text-center">
          <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
            </svg>
          </div>
          <p className="text-sm text-gray-500">No container data available</p>
          <p className="text-xs text-gray-600">Make sure the Docker socket is mounted and docker_enabled is true in the agent config.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-gray-800 text-gray-600 uppercase tracking-widest text-[10px]">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left hidden md:table-cell">Image</th>
                <th className="px-4 py-3 text-left">State</th>
                <th className="px-4 py-3 text-right">CPU%</th>
                <th className="px-4 py-3 text-right">Mem MB</th>
                <th className="px-4 py-3 text-right hidden sm:table-cell">Mem%</th>
                <th className="px-4 py-3 text-right hidden lg:table-cell">Uptime</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(c => (
                <tr
                  key={c.name}
                  className="border-b border-gray-800/50 last:border-0 hover:bg-gray-800/20 transition-colors"
                >
                  <td className="px-4 py-3 text-white font-semibold">{c.name}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[14rem] truncate hidden md:table-cell">
                    {truncateImage(c.image)}
                  </td>
                  <td className="px-4 py-3"><StateBadge state={c.state} /></td>
                  <td className={`px-4 py-3 text-right tabular-nums ${metricTextClass(c.cpu_percent)}`}>
                    {c.cpu_percent.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-300">
                    {c.memory_mb.toFixed(0)}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums hidden sm:table-cell ${metricTextClass(c.memory_percent)}`}>
                    {c.memory_percent.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600 hidden lg:table-cell">
                    {fmtUptime(c.uptime_seconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
