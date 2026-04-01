import React, { useMemo } from 'react';
import { ServerRow, MetricRow, AlertRow, DockerSnapshot, ServerSparklines } from '../types';
import { isOnline, fmtRelativeTime, metricColor, metricTextClass } from '../utils';
import { Sparkline } from '../components/Sparkline';
import { OnlineDot } from '../components/Badges';
import { SkeletonCard } from '../components/Skeleton';

interface OverviewPageProps {
  servers: ServerRow[];
  allMetrics: MetricRow[];
  alerts: AlertRow[];
  docker: DockerSnapshot;
  onSelectServer: (id: number) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildSparklines(metrics: MetricRow[]): Map<number, ServerSparklines> {
  const map = new Map<number, { cpu: { v: number; ts: number }[]; mem: { v: number; ts: number }[] }>();

  for (const m of metrics) {
    if (!map.has(m.server_id)) map.set(m.server_id, { cpu: [], mem: [] });
    const entry = map.get(m.server_id)!;
    const ts = new Date(m.timestamp).getTime();

    if (m.metric_type === 'cpu' && m.value.cpu) {
      entry.cpu.push({ v: m.value.cpu.usage_percent, ts });
    } else if (m.metric_type === 'memory' && m.value.memory) {
      entry.mem.push({ v: m.value.memory.used_percent, ts });
    }
  }

  const result = new Map<number, ServerSparklines>();
  for (const [id, { cpu, mem }] of map) {
    const sort = (arr: { v: number; ts: number }[]) =>
      arr.sort((a, b) => a.ts - b.ts).slice(-20).map(x => x.v);
    result.set(id, { cpu: sort(cpu), mem: sort(mem) });
  }
  return result;
}

// ── Cluster stats bar ─────────────────────────────────────────────────────────

function StatPill({ label, value, sub, accent }: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="card px-5 py-4 flex flex-col gap-1 min-w-[120px]">
      <span className="text-[11px] uppercase tracking-widest text-gray-500 font-medium">{label}</span>
      <span className={`font-mono font-bold text-2xl leading-none ${accent ?? 'text-white'}`}>
        {value}
      </span>
      {sub && <span className="text-xs text-gray-600 font-mono">{sub}</span>}
    </div>
  );
}

// ── Server card ───────────────────────────────────────────────────────────────

interface ServerCardProps {
  server: ServerRow;
  sparklines: ServerSparklines;
  containerCount: { running: number; total: number };
  alertCount: number;
  onClick: () => void;
}

function ServerCard({ server, sparklines, containerCount, alertCount, onClick }: ServerCardProps) {
  const online = isOnline(server.last_heartbeat);
  const latestCpu = sparklines.cpu.at(-1) ?? 0;
  const latestMem = sparklines.mem.at(-1) ?? 0;

  return (
    <button
      onClick={onClick}
      className="card p-4 text-left hover:border-gray-700 hover:bg-gray-800/40 active:scale-[0.99] transition-all duration-150 group w-full"
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <OnlineDot online={online} />
          <span className="font-semibold text-sm text-white truncate">{server.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {alertCount > 0 && (
            <span className="text-[10px] font-mono bg-red-500/20 text-red-400 border border-red-700/40 rounded px-1.5 py-0.5">
              {alertCount} alert{alertCount > 1 ? 's' : ''}
            </span>
          )}
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="text-gray-700 group-hover:text-gray-500 transition-colors flex-shrink-0"
          >
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </div>

      {/* Sparkline row */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* CPU */}
        <div className="card-sm px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-widest text-gray-600">CPU</span>
            <span className={`text-xs font-mono font-semibold ${metricTextClass(latestCpu)}`}>
              {latestCpu.toFixed(1)}%
            </span>
          </div>
          <Sparkline
            values={sparklines.cpu}
            color={metricColor(latestCpu)}
            width={88}
            height={24}
          />
        </div>
        {/* Memory */}
        <div className="card-sm px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-widest text-gray-600">MEM</span>
            <span className={`text-xs font-mono font-semibold ${metricTextClass(latestMem)}`}>
              {latestMem.toFixed(1)}%
            </span>
          </div>
          <Sparkline
            values={sparklines.mem}
            color={metricColor(latestMem)}
            width={88}
            height={24}
          />
        </div>
      </div>

      {/* Footer row */}
      <div className="flex items-center justify-between text-[11px] font-mono text-gray-600">
        <span>
          {containerCount.total > 0
            ? `${containerCount.running}/${containerCount.total} containers`
            : 'no containers'}
        </span>
        <span className={online ? 'text-gray-600' : 'text-red-500'}>
          {fmtRelativeTime(server.last_heartbeat)}
        </span>
      </div>
    </button>
  );
}

// ── Overview page ─────────────────────────────────────────────────────────────

export function OverviewPage({
  servers,
  allMetrics,
  alerts,
  docker,
  onSelectServer,
}: OverviewPageProps) {
  const sparklineMap = useMemo(() => buildSparklines(allMetrics), [allMetrics]);

  const onlineCount   = servers.filter(s => isOnline(s.last_heartbeat)).length;
  const activeAlerts  = alerts.filter(a => !a.acknowledged).length;
  const runningCtrs   = docker.containers.filter(c => c.state === 'running').length;
  const totalCtrs     = docker.containers.length;

  // Per-server alert counts
  const alertsByServer = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of alerts) {
      if (!a.acknowledged) m.set(a.server_id, (m.get(a.server_id) ?? 0) + 1);
    }
    return m;
  }, [alerts]);

  if (servers.length === 0) {
    return (
      <div className="p-8 flex flex-col items-center justify-center gap-4 text-center min-h-[50vh]">
        <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-2">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2"/>
          </svg>
        </div>
        <p className="text-sm text-gray-400 font-medium">No agents connected</p>
        <p className="text-xs text-gray-600 max-w-xs">
          Start a Fenris agent on a host to begin collecting metrics.
          See the README for configuration instructions.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Cluster stats */}
      <div>
        <h2 className="text-[11px] uppercase tracking-widest text-gray-600 mb-3">Cluster</h2>
        <div className="flex flex-wrap gap-3">
          <StatPill
            label="Servers"
            value={onlineCount}
            sub={`${servers.length - onlineCount} offline`}
            accent={onlineCount > 0 ? 'text-emerald-400' : 'text-gray-400'}
          />
          <StatPill
            label="Containers"
            value={runningCtrs}
            sub={`${totalCtrs} total`}
            accent="text-cyan-400"
          />
          <StatPill
            label="Active Alerts"
            value={activeAlerts}
            accent={activeAlerts > 0 ? 'text-red-400' : 'text-emerald-400'}
          />
        </div>
      </div>

      {/* Server grid */}
      <div>
        <h2 className="text-[11px] uppercase tracking-widest text-gray-600 mb-3">Servers</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {servers.map(server => {
            const lines = sparklineMap.get(server.id) ?? { cpu: [], mem: [] };
            // Container counts come from the all-server docker snapshot
            // (approximation: not perfect when docker data is single-server)
            const alertCnt = alertsByServer.get(server.id) ?? 0;
            return (
              <ServerCard
                key={server.id}
                server={server}
                sparklines={lines}
                containerCount={{ running: 0, total: 0 }}
                alertCount={alertCnt}
                onClick={() => onSelectServer(server.id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
