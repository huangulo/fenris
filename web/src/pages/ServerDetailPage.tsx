import React, { useMemo } from 'react';
import { ServerRow, MetricRow, AlertRow, DockerSnapshot } from '../types';
import {
  isOnline, fmtRelativeTime, metricColor, metricTextClass,
  fmtBytesPerSec, fmtUptime, truncateImage,
} from '../utils';
import { CircularGauge } from '../components/CircularGauge';
import { HistoryChart } from '../components/HistoryChart';
import { StateBadge, OnlineDot } from '../components/Badges';

interface ServerDetailPageProps {
  server: ServerRow | null;
  servers: ServerRow[];
  metrics: MetricRow[];
  docker: DockerSnapshot;
  alerts: AlertRow[];
  onBack: () => void;
  onSelectServer: (id: number) => void;
}

// ── Metric panel ──────────────────────────────────────────────────────────────

interface MetricPanelProps {
  label: string;
  pct: number;
  display: string;
  sub?: string;
  history: number[];
  timestamps: string[];
  color?: string;
  formatTooltip?: (v: number) => string;
}

function MetricPanel({ label, pct, display, sub, history, timestamps, color, formatTooltip }: MetricPanelProps) {
  const c = color ?? metricColor(pct);
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-widest text-gray-500 font-medium">{label}</span>
        <span className={`text-xs font-mono ${metricTextClass(pct)}`}>live</span>
      </div>
      {/* Gauge */}
      <div className="flex justify-center">
        <CircularGauge
          value={pct}
          display={display}
          sub={sub}
          size={120}
          strokeWidth={10}
          color={c}
        />
      </div>
      {/* 1-hour history chart */}
      <div>
        <span className="text-[10px] text-gray-700 font-mono uppercase tracking-widest">1 hour</span>
        <div className="mt-1">
          <HistoryChart
            values={history}
            timestamps={timestamps}
            color={c}
            latestPct={pct}
            height={52}
            formatTooltip={formatTooltip}
          />
        </div>
      </div>
    </div>
  );
}

// ── Container table ───────────────────────────────────────────────────────────

function ContainerTable({ containers }: { containers: DockerSnapshot['containers'] }) {
  const sorted = useMemo(
    () => [...containers].sort((a, b) => {
      // Unhealthy first, then alphabetical
      const aDown = a.state !== 'running' ? 0 : 1;
      const bDown = b.state !== 'running' ? 0 : 1;
      if (aDown !== bDown) return aDown - bDown;
      return a.name.localeCompare(b.name);
    }),
    [containers],
  );

  if (sorted.length === 0) {
    return <p className="text-xs text-gray-600 font-mono py-2">No container data available.</p>;
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-gray-800 text-gray-500 uppercase tracking-widest text-[10px]">
            <th className="px-4 py-3 text-left">Container</th>
            <th className="px-4 py-3 text-left">Image</th>
            <th className="px-4 py-3 text-left">State</th>
            <th className="px-4 py-3 text-right">CPU%</th>
            <th className="px-4 py-3 text-right">Mem MB</th>
            <th className="px-4 py-3 text-right">Mem%</th>
            <th className="px-4 py-3 text-right">Uptime</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(c => (
            <tr key={c.name} className="border-b border-gray-800/50 last:border-0 hover:bg-gray-800/30 transition-colors">
              <td className="px-4 py-3 text-white font-semibold">{c.name}</td>
              <td className="px-4 py-3 text-gray-500 max-w-[12rem] truncate">{truncateImage(c.image)}</td>
              <td className="px-4 py-3"><StateBadge state={c.state} /></td>
              <td className={`px-4 py-3 text-right tabular-nums ${metricTextClass(c.cpu_percent)}`}>
                {c.cpu_percent.toFixed(1)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-gray-300">
                {c.memory_mb.toFixed(0)}
              </td>
              <td className={`px-4 py-3 text-right tabular-nums ${metricTextClass(c.memory_percent)}`}>
                {c.memory_percent.toFixed(1)}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">
                {fmtUptime(c.uptime_seconds)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Server detail page ────────────────────────────────────────────────────────

export function ServerDetailPage({
  server,
  servers,
  metrics,
  docker,
  alerts,
  onBack,
  onSelectServer,
}: ServerDetailPageProps) {

  // Build history arrays from metrics (ascending by timestamp, last 120 points)
  const history = useMemo(() => {
    const sorted = [...metrics].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const byType = (t: MetricRow['metric_type']) =>
      sorted.filter(r => r.metric_type === t);

    const cpuRows   = byType('cpu');
    const memRows   = byType('memory');
    const diskRows  = byType('disk');
    const netRows   = byType('network');

    return {
      cpu:       { vals: cpuRows.map(r => r.value.cpu?.usage_percent ?? 0),    ts: cpuRows.map(r => r.timestamp) },
      memory:    { vals: memRows.map(r => r.value.memory?.used_percent ?? 0),  ts: memRows.map(r => r.timestamp) },
      disk:      { vals: diskRows.map(r => r.value.disk?.used_percent ?? 0),   ts: diskRows.map(r => r.timestamp) },
      netRx:     { vals: netRows.map(r => r.value.network?.rx_bytes ?? 0),     ts: netRows.map(r => r.timestamp) },
      netTx:     { vals: netRows.map(r => r.value.network?.tx_bytes ?? 0),     ts: netRows.map(r => r.timestamp) },
      // Latest raw values
      memInfo:   memRows.at(-1)?.value.memory ?? null,
      diskInfo:  diskRows.at(-1)?.value.disk  ?? null,
      netInfo:   netRows.at(-1)?.value.network ?? null,
    };
  }, [metrics]);

  const latestCpu  = history.cpu.vals.at(-1)    ?? 0;
  const latestMem  = history.memory.vals.at(-1)  ?? 0;
  const latestDisk = history.disk.vals.at(-1)    ?? 0;
  const latestRx   = history.netRx.vals.at(-1)   ?? 0;

  const activeAlerts = alerts.filter(a => !a.acknowledged && a.server_id === server?.id).length;

  // If no specific server is selected, show a picker
  if (!server) {
    return (
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        <h2 className="text-[11px] uppercase tracking-widest text-gray-600">Select a server</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {servers.map(s => (
            <button
              key={s.id}
              onClick={() => onSelectServer(s.id)}
              className="card p-4 text-left hover:border-gray-700 hover:bg-gray-800/40 transition-all flex items-center gap-3"
            >
              <OnlineDot online={isOnline(s.last_heartbeat)} />
              <div>
                <div className="font-semibold text-sm text-white">{s.name}</div>
                <div className="text-xs font-mono text-gray-600">{s.ip_address}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const online = isOnline(server.last_heartbeat);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 flex-wrap">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Overview
        </button>

        <div className="flex items-center gap-2.5">
          <OnlineDot online={online} size="md" />
          <h1 className="text-base font-semibold text-white">{server.name}</h1>
          <span className="text-xs font-mono text-gray-600">{server.ip_address}</span>
        </div>

        {activeAlerts > 0 && (
          <span className="text-xs font-mono bg-red-500/15 text-red-400 border border-red-700/30 rounded-full px-3 py-1">
            {activeAlerts} active alert{activeAlerts > 1 ? 's' : ''}
          </span>
        )}

        <div className="ml-auto text-xs font-mono text-gray-600">
          {fmtRelativeTime(server.last_heartbeat)}
        </div>
      </div>

      {/* Metric panels */}
      <div>
        <h2 className="text-[11px] uppercase tracking-widest text-gray-600 mb-3">System Metrics</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricPanel
            label="CPU"
            pct={latestCpu}
            display={`${latestCpu.toFixed(1)}%`}
            sub={history.cpu.vals.length > 0 ? `load` : undefined}
            history={history.cpu.vals}
            timestamps={history.cpu.ts}
          />
          <MetricPanel
            label="Memory"
            pct={latestMem}
            display={`${latestMem.toFixed(1)}%`}
            sub={history.memInfo
              ? `${history.memInfo.used_gib.toFixed(1)}/${history.memInfo.total_gib.toFixed(1)} GiB`
              : undefined}
            history={history.memory.vals}
            timestamps={history.memory.ts}
          />
          <MetricPanel
            label="Disk"
            pct={latestDisk}
            display={`${latestDisk.toFixed(1)}%`}
            sub={history.diskInfo
              ? `${history.diskInfo.used_gb.toFixed(0)}/${history.diskInfo.total_gb.toFixed(0)} GB`
              : undefined}
            history={history.disk.vals}
            timestamps={history.disk.ts}
          />
          <MetricPanel
            label="Network"
            pct={0}
            display={fmtBytesPerSec(latestRx)}
            sub={history.netInfo ? `tx ${fmtBytesPerSec(history.netRx.vals.at(-1) ?? 0)}` : undefined}
            history={history.netRx.vals}
            timestamps={history.netRx.ts}
            color="#06b6d4"
            formatTooltip={v => fmtBytesPerSec(v)}
          />
        </div>
      </div>

      {/* Containers */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-[11px] uppercase tracking-widest text-gray-600">Containers</h2>
          {docker.containers.length > 0 && (
            <span className="text-xs font-mono text-gray-600">
              {docker.containers.filter(c => c.state === 'running').length}/{docker.containers.length} running
            </span>
          )}
        </div>
        <ContainerTable containers={docker.containers} />
      </div>
    </div>
  );
}
