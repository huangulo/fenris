import React, { useMemo } from 'react';
import { ServerRow, MetricRow, AlertRow, DockerSnapshot, ServerSparklines } from '../types';
import { isOnline, fmtRelativeTime, metricColor, metricTextClass } from '../utils';
import { Sparkline } from '../components/Sparkline';
import { OnlineDot } from '../components/Badges';

interface OverviewPageProps {
  servers:        ServerRow[];
  allMetrics:     MetricRow[];
  alerts:         AlertRow[];
  docker:         DockerSnapshot;
  onSelectServer: (id: number) => void;
}

// ── Build per-server sparkline arrays from the bulk metrics fetch ──────────────

function buildSparklines(metrics: MetricRow[]): Map<number, ServerSparklines> {
  const raw = new Map<number, {
    cpu:  { v: number; ts: number }[];
    mem:  { v: number; ts: number }[];
    disk: { v: number; ts: number }[];
  }>();

  for (const m of metrics) {
    if (!raw.has(m.server_id)) raw.set(m.server_id, { cpu: [], mem: [], disk: [] });
    const e = raw.get(m.server_id)!;
    const ts = new Date(m.timestamp).getTime();

    if      (m.metric_type === 'cpu'    && m.value.cpu)    e.cpu.push({ v: m.value.cpu.usage_percent,    ts });
    else if (m.metric_type === 'memory' && m.value.memory) e.mem.push({ v: m.value.memory.used_percent,  ts });
    else if (m.metric_type === 'disk'   && m.value.disk)   e.disk.push({ v: m.value.disk.used_percent,   ts });
  }

  const result = new Map<number, ServerSparklines>();
  for (const [id, { cpu, mem, disk }] of raw) {
    const sort = (arr: { v: number; ts: number }[]) =>
      arr.sort((a, b) => a.ts - b.ts).slice(-20).map(x => x.v);
    result.set(id, { cpu: sort(cpu), mem: sort(mem), disk: sort(disk) });
  }
  return result;
}

// ── Build per-server container counts from the latest docker metrics ───────────

function buildContainerCounts(metrics: MetricRow[]): Map<number, { running: number; total: number }> {
  // Only keep the most recent docker metric per server
  const latest = new Map<number, MetricRow>();
  for (const m of metrics) {
    if (m.metric_type !== 'docker') continue;
    const existing = latest.get(m.server_id);
    if (!existing || new Date(m.timestamp) > new Date(existing.timestamp)) {
      latest.set(m.server_id, m);
    }
  }
  const result = new Map<number, { running: number; total: number }>();
  for (const [id, m] of latest) {
    const containers = (m.value as any).docker as Array<{ state: string }> | undefined ?? [];
    result.set(id, {
      running: containers.filter(c => c.state === 'running').length,
      total:   containers.length,
    });
  }
  return result;
}

// ── Cluster stat pill ─────────────────────────────────────────────────────────

function StatPill({ label, value, sub, accent }: {
  label:   string;
  value:   string | number;
  sub?:    string;
  accent?: string;
}) {
  return (
    <div className="card px-5 py-4 flex flex-col gap-1.5 min-w-[110px]">
      <span className="text-[10px] uppercase tracking-widest text-gray-600 font-medium">{label}</span>
      <span className={`font-mono font-bold text-2xl leading-none ${accent ?? 'text-white'}`}>
        {value}
      </span>
      {sub && <span className="text-[11px] text-gray-600 font-mono">{sub}</span>}
    </div>
  );
}

// ── Mini sparkline strip ──────────────────────────────────────────────────────

function SparkStrip({ label, values, pct }: { label: string; values: number[]; pct: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-widest text-gray-600">{label}</span>
        <span className={`text-[10px] font-mono font-semibold ${metricTextClass(pct)}`}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <Sparkline values={values} color={metricColor(pct)} width={72} height={20} />
    </div>
  );
}

// ── Server card ───────────────────────────────────────────────────────────────

interface ServerCardProps {
  server:         ServerRow;
  sparklines:     ServerSparklines;
  containers:     { running: number; total: number };
  alertCount:     number;
  onClick:        () => void;
}

function ServerCard({ server, sparklines, containers, alertCount, onClick }: ServerCardProps) {
  const online   = isOnline(server.last_heartbeat);
  const latestCpu  = sparklines.cpu.at(-1)  ?? 0;
  const latestMem  = sparklines.mem.at(-1)  ?? 0;
  const latestDisk = sparklines.disk.at(-1) ?? 0;

  return (
    <button
      onClick={onClick}
      className="card p-4 text-left hover:border-gray-700/80 hover:bg-gray-800/30 active:scale-[0.99] transition-all duration-150 group w-full"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <OnlineDot online={online} />
          <span className="font-semibold text-[13px] text-white truncate leading-none">
            {server.name}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {alertCount > 0 && (
            <span className="text-[10px] font-mono bg-red-500/15 text-red-400 border border-red-800/40 rounded-md px-1.5 py-0.5 leading-none">
              {alertCount}▲
            </span>
          )}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="text-gray-700 group-hover:text-gray-500 transition-colors">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </div>

      {/* Sparkline grid: 3 columns */}
      <div className="grid grid-cols-3 gap-3 mb-4 px-1">
        <SparkStrip label="CPU"  values={sparklines.cpu}  pct={latestCpu} />
        <SparkStrip label="MEM"  values={sparklines.mem}  pct={latestMem} />
        <SparkStrip label="DISK" values={sparklines.disk} pct={latestDisk} />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[10px] font-mono border-t border-gray-800/60 pt-3">
        <span className="text-gray-600">
          {containers.total > 0
            ? `${containers.running}/${containers.total} containers`
            : '—'}
        </span>
        <span className={online ? 'text-gray-600' : 'text-red-500/80'}>
          {fmtRelativeTime(server.last_heartbeat)}
        </span>
      </div>
    </button>
  );
}

// ── Overview page ─────────────────────────────────────────────────────────────

export function OverviewPage({ servers, allMetrics, alerts, docker, onSelectServer }: OverviewPageProps) {
  const sparklineMap    = useMemo(() => buildSparklines(allMetrics),     [allMetrics]);
  const containerMap    = useMemo(() => buildContainerCounts(allMetrics), [allMetrics]);

  const onlineCount    = servers.filter(s => isOnline(s.last_heartbeat)).length;
  const activeAlerts   = alerts.filter(a => !a.acknowledged).length;
  const runningCtrs    = docker.containers.filter(c => c.state === 'running').length;
  const totalCtrs      = docker.containers.length;

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
        <div className="w-14 h-14 rounded-2xl bg-gray-800/60 border border-gray-800 flex items-center justify-center mb-1">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2"/>
            <line x1="6" y1="6" x2="6.01" y2="6"/>
            <line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-400">No agents connected</p>
        <p className="text-xs text-gray-600 max-w-xs leading-relaxed">
          Deploy a Fenris agent on each host you want to monitor. Configure it with
          the server URL and an API key, then it will register automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-7 max-w-6xl mx-auto">

      {/* Cluster stats */}
      <div>
        <h2 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">Cluster Overview</h2>
        <div className="flex flex-wrap gap-3">
          <StatPill
            label="Servers online"
            value={onlineCount}
            sub={`of ${servers.length} total`}
            accent={onlineCount > 0 ? 'text-emerald-400' : 'text-gray-500'}
          />
          <StatPill
            label="Containers"
            value={runningCtrs}
            sub={totalCtrs > 0 ? `${totalCtrs} total` : undefined}
            accent="text-cyan-400"
          />
          <StatPill
            label="Active alerts"
            value={activeAlerts}
            accent={activeAlerts > 0 ? 'text-red-400' : 'text-emerald-400'}
          />
        </div>
      </div>

      {/* Server grid */}
      <div>
        <h2 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">
          Servers
          <span className="ml-2 normal-case text-gray-700">
            {onlineCount}/{servers.length} online
          </span>
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {servers.map(server => (
            <ServerCard
              key={server.id}
              server={server}
              sparklines={sparklineMap.get(server.id) ?? { cpu: [], mem: [], disk: [] }}
              containers={containerMap.get(server.id) ?? { running: 0, total: 0 }}
              alertCount={alertsByServer.get(server.id) ?? 0}
              onClick={() => onSelectServer(server.id)}
            />
          ))}
        </div>
      </div>

    </div>
  );
}
