import React, { useMemo } from 'react';
import { ServerRow, MetricRow, AlertRow, DockerSnapshot, SummaryRow } from '../types';
import {
  isOnline, fmtRelativeTime, metricColor, metricTextClass,
  fmtBytesPerSec, fmtUptime, truncateImage,
} from '../utils';
import { CircularGauge } from '../components/CircularGauge';
import { HistoryChart } from '../components/HistoryChart';
import { StateBadge, OnlineDot } from '../components/Badges';

interface ServerDetailPageProps {
  server:         ServerRow | null;
  servers:        ServerRow[];
  metrics:        MetricRow[];
  docker:         DockerSnapshot;
  alerts:         AlertRow[];
  summaries:      SummaryRow[];
  onBack:         () => void;
  onSelectServer: (id: number) => void;
}

// ── Metric panel ──────────────────────────────────────────────────────────────

interface MetricPanelProps {
  label:           string;
  pct:             number;
  display:         string;
  sub?:            string;
  history:         number[];
  timestamps:      string[];
  color?:          string;
  formatTooltip?:  (v: number) => string;
}

function MetricPanel({ label, pct, display, sub, history, timestamps, color, formatTooltip }: MetricPanelProps) {
  const c = color ?? metricColor(pct);
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-gray-600 font-medium">{label}</span>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_4px_#10b981] animate-pulse-slow" />
      </div>

      {/* Circular gauge centred */}
      <div className="flex justify-center py-1">
        <CircularGauge
          value={pct}
          display={display}
          sub={sub}
          size={116}
          strokeWidth={9}
          color={c}
        />
      </div>

      {/* 1-hour history */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-gray-700 font-mono">1 hr history</span>
          <span className="text-[10px] font-mono text-gray-700">
            {history.length} pts
          </span>
        </div>
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
  );
}

// ── Network panel (no natural %) ──────────────────────────────────────────────

interface NetworkPanelProps {
  rxHistory: number[];
  txHistory: number[];
  timestamps: string[];
  latestRx: number;
  latestTx: number;
}

function NetworkPanel({ rxHistory, txHistory, timestamps, latestRx, latestTx }: NetworkPanelProps) {
  // Derive a "relative %" from current vs historical max so the ring is non-trivial
  const maxRx = Math.max(...rxHistory, 1);
  const pct   = Math.min(100, (latestRx / maxRx) * 100);

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-gray-600 font-medium">Network</span>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_4px_#10b981] animate-pulse-slow" />
      </div>

      <div className="flex justify-center py-1">
        <CircularGauge
          value={pct}
          display={fmtBytesPerSec(latestRx)}
          sub={`rx`}
          size={116}
          strokeWidth={9}
          color="#06b6d4"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-gray-700 font-mono">rx / tx</span>
          <span className="text-[10px] font-mono text-gray-600">tx {fmtBytesPerSec(latestTx)}</span>
        </div>
        <HistoryChart
          values={rxHistory}
          timestamps={timestamps}
          color="#06b6d4"
          height={52}
          formatTooltip={v => `↓ ${fmtBytesPerSec(v)}`}
        />
      </div>
    </div>
  );
}

// ── Container table ───────────────────────────────────────────────────────────

function ContainerTable({ containers }: { containers: DockerSnapshot['containers'] }) {
  const sorted = useMemo(
    () => [...containers].sort((a, b) => {
      const aDown = a.state !== 'running' ? 0 : 1;
      const bDown = b.state !== 'running' ? 0 : 1;
      if (aDown !== bDown) return aDown - bDown;
      return a.name.localeCompare(b.name);
    }),
    [containers],
  );

  if (sorted.length === 0) {
    return (
      <p className="text-xs text-gray-600 font-mono py-3">
        No container data — check that the Docker socket is mounted and docker_enabled is true.
      </p>
    );
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-gray-800 text-gray-600 text-[10px] uppercase tracking-widest">
            <th className="px-4 py-3 text-left">Container</th>
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
            <tr key={c.name} className="border-b border-gray-800/50 last:border-0 hover:bg-gray-800/25 transition-colors">
              <td className="px-4 py-3 text-white font-semibold">{c.name}</td>
              <td className="px-4 py-3 text-gray-500 max-w-[12rem] truncate hidden md:table-cell">
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
  );
}

// ── AI Insights panel ─────────────────────────────────────────────────────────

function InsightsPanel({ summaries }: { summaries: SummaryRow[] }) {
  if (summaries.length === 0) return null;

  const latest = summaries[0];
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[10px] uppercase tracking-widest text-gray-600">Insights</h2>
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-violet-500/10 text-violet-400 border-violet-700/40">
          AI
        </span>
        {summaries.length > 1 && (
          <span className="text-[10px] text-gray-700 font-mono">{summaries.length} summaries</span>
        )}
      </div>
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between text-[10px] text-gray-600">
          <span className="font-mono">{latest.model ?? 'AI'}</span>
          <span>{fmtRelativeTime(latest.created_at)}</span>
        </div>
        <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">{latest.summary}</p>
        {latest.alert_ids.length > 0 && (
          <p className="text-[10px] text-gray-700 font-mono">
            Based on {latest.alert_ids.length} alert{latest.alert_ids.length > 1 ? 's' : ''}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Server info strip ─────────────────────────────────────────────────────────

function ServerInfoStrip({ server }: { server: ServerRow }) {
  const online = isOnline(server.last_heartbeat);
  const items = [
    { label: 'IP',         value: server.ip_address },
    { label: 'Status',     value: online ? 'online' : 'offline', accent: online ? 'text-emerald-400' : 'text-red-400' },
    { label: 'Last seen',  value: fmtRelativeTime(server.last_heartbeat) },
  ];
  return (
    <div className="card-sm flex flex-wrap gap-x-6 gap-y-2 px-4 py-3">
      {items.map(({ label, value, accent }) => (
        <div key={label} className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-gray-600">{label}</span>
          <span className={`text-xs font-mono ${accent ?? 'text-gray-300'}`}>{value}</span>
        </div>
      ))}
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
  summaries,
  onBack,
  onSelectServer,
}: ServerDetailPageProps) {

  // Derive sorted history arrays from metrics
  const history = useMemo(() => {
    const sorted = [...metrics].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const byType = (t: MetricRow['metric_type']) => sorted.filter(r => r.metric_type === t);

    const cpuRows  = byType('cpu');
    const memRows  = byType('memory');
    const diskRows = byType('disk');
    const netRows  = byType('network');

    return {
      cpu:     { vals: cpuRows .map(r => r.value.cpu?.usage_percent       ?? 0), ts: cpuRows .map(r => r.timestamp) },
      memory:  { vals: memRows .map(r => r.value.memory?.used_percent     ?? 0), ts: memRows .map(r => r.timestamp) },
      disk:    { vals: diskRows.map(r => r.value.disk?.used_percent        ?? 0), ts: diskRows.map(r => r.timestamp) },
      netRx:   { vals: netRows .map(r => r.value.network?.rx_bytes         ?? 0), ts: netRows .map(r => r.timestamp) },
      netTx:   { vals: netRows .map(r => r.value.network?.tx_bytes         ?? 0) },
      memInfo: memRows .at(-1)?.value.memory  ?? null,
      diskInfo: diskRows.at(-1)?.value.disk   ?? null,
    };
  }, [metrics]);

  const latestCpu  = history.cpu.vals.at(-1)   ?? 0;
  const latestMem  = history.memory.vals.at(-1) ?? 0;
  const latestDisk = history.disk.vals.at(-1)   ?? 0;
  const latestRx   = history.netRx.vals.at(-1)  ?? 0;
  const latestTx   = history.netTx.vals.at(-1)  ?? 0;

  const serverAlerts = alerts.filter(a => !a.acknowledged && a.server_id === server?.id);

  // No server selected → show picker
  if (!server) {
    return (
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        <h2 className="text-[10px] uppercase tracking-widest text-gray-600">Select a Server</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {servers.map(s => (
            <button
              key={s.id}
              onClick={() => onSelectServer(s.id)}
              className="card p-4 text-left hover:border-gray-700 hover:bg-gray-800/40 transition-all flex items-center gap-3"
            >
              <OnlineDot online={isOnline(s.last_heartbeat)} size="md" />
              <div className="min-w-0">
                <div className="font-semibold text-sm text-white leading-snug">{s.name}</div>
                <div className="text-xs font-mono text-gray-600">{s.ip_address}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">

      {/* Page header */}
      <div className="space-y-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-300 transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Overview
        </button>

        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <OnlineDot online={isOnline(server.last_heartbeat)} size="md" />
            <h1 className="text-base font-semibold text-white">{server.name}</h1>
            {serverAlerts.length > 0 && (
              <span className="text-xs font-mono bg-red-500/12 text-red-400 border border-red-800/40 rounded-full px-2.5 py-0.5">
                {serverAlerts.length} alert{serverAlerts.length > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Server switcher */}
          {servers.length > 1 && (
            <select
              value={server.id}
              onChange={e => onSelectServer(parseInt(e.target.value))}
              className="text-xs font-mono bg-gray-800/80 border border-gray-700/60 text-gray-300 rounded-lg px-3 py-1.5 focus:outline-none"
            >
              {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>

        <ServerInfoStrip server={server} />
      </div>

      {/* Metric panels */}
      <div>
        <h2 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">System Metrics</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricPanel
            label="CPU"
            pct={latestCpu}
            display={`${latestCpu.toFixed(1)}%`}
            history={history.cpu.vals}
            timestamps={history.cpu.ts}
          />
          <MetricPanel
            label="Memory"
            pct={latestMem}
            display={`${latestMem.toFixed(1)}%`}
            sub={history.memInfo
              ? `${history.memInfo.used_gib.toFixed(1)} / ${history.memInfo.total_gib.toFixed(1)} GiB`
              : undefined}
            history={history.memory.vals}
            timestamps={history.memory.ts}
          />
          <MetricPanel
            label="Disk"
            pct={latestDisk}
            display={`${latestDisk.toFixed(1)}%`}
            sub={history.diskInfo
              ? `${history.diskInfo.used_gb.toFixed(0)} / ${history.diskInfo.total_gb.toFixed(0)} GB`
              : undefined}
            history={history.disk.vals}
            timestamps={history.disk.ts}
          />
          <NetworkPanel
            rxHistory={history.netRx.vals}
            txHistory={history.netTx.vals}
            timestamps={history.netRx.ts}
            latestRx={latestRx}
            latestTx={latestTx}
          />
        </div>
      </div>

      {/* AI Insights */}
      <InsightsPanel summaries={summaries} />

      {/* Containers */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-[10px] uppercase tracking-widest text-gray-600">Containers</h2>
          {docker.containers.length > 0 && (
            <>
              <span className="text-[11px] font-mono text-emerald-400">
                {docker.containers.filter(c => c.state === 'running').length} running
              </span>
              {docker.containers.filter(c => c.state !== 'running').length > 0 && (
                <span className="text-[11px] font-mono text-red-400">
                  {docker.containers.filter(c => c.state !== 'running').length} stopped
                </span>
              )}
            </>
          )}
        </div>
        <ContainerTable containers={docker.containers} />
      </div>

    </div>
  );
}
