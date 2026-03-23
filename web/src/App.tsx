import React, { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// API helper — all requests carry the key baked in at build time
// ---------------------------------------------------------------------------
const API_KEY = import.meta.env.VITE_API_KEY ?? '';

function apiFetch(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { 'X-API-Key': API_KEY };
  if (opts.body != null) headers['Content-Type'] = 'application/json';
  return fetch(path, { ...opts, headers: { ...headers, ...(opts.headers ?? {}) } });
}

// ---------------------------------------------------------------------------
// Types (mirror server/src/types.ts, frontend-safe)
// ---------------------------------------------------------------------------
interface MetricRow {
  id: number;
  metric_type: 'cpu' | 'memory' | 'disk' | 'network';
  value: {
    cpu?:     { usage_percent: number; load_avg: number[] };
    memory?:  { used_percent: number; total_gib: number; available_gib: number; used_gib: number };
    disk?:    { used_percent: number; total_gb: number; used_gb: number; available_gb: number };
    network?: { rx_bytes: number; tx_bytes: number; interface: string };
  };
  timestamp: string;
}

interface AlertRow {
  id: number;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metric_type?: string;
  acknowledged: boolean;
  created_at: string;
}

interface ServerRow {
  last_heartbeat: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function valueColor(pct: number): string {
  if (pct >= 80) return 'text-red-400';
  if (pct >= 60) return 'text-yellow-400';
  return 'text-green-400';
}

function sparkStroke(pct: number): string {
  if (pct >= 80) return '#f87171';
  if (pct >= 60) return '#facc15';
  return '#4ade80';
}

function fmtBytes(b: number): string {
  if (b >= 1_000_000) return (b / 1_000_000).toFixed(1) + ' MB/s';
  if (b >= 1_000)     return (b / 1_000).toFixed(1) + ' KB/s';
  return b + ' B/s';
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false });
}

function secondsAgo(ts: string | null): number {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts).getTime()) / 1000;
}

// ---------------------------------------------------------------------------
// Sparkline — pure SVG, no deps
// ---------------------------------------------------------------------------
function Sparkline({ values, stroke }: { values: number[]; stroke: string }) {
  if (values.length < 2) {
    return <div className="w-20 h-8 rounded bg-gray-700 opacity-30" />;
  }
  const max = Math.max(...values, 0.001);
  const W = 80, H = 32;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (W - 4) + 2;
      const y = H - 2 - (v / max) * (H - 6) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={W} height={H} className="opacity-75">
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------
interface CardProps {
  label: string;
  display: string;
  pct: number | null; // null = no % threshold (network)
  history: number[];
  sub?: string;
}

function MetricCard({ label, display, pct, history, sub }: CardProps) {
  const color  = pct != null ? valueColor(pct) : 'text-cyan-400';
  const stroke = pct != null ? sparkStroke(pct) : '#22d3ee';
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between">
        <span className="text-xs font-mono uppercase tracking-widest text-gray-500">{label}</span>
        <Sparkline values={history} stroke={stroke} />
      </div>
      <div className={`text-3xl font-mono font-bold leading-none ${color}`}>{display}</div>
      {sub && <div className="text-xs font-mono text-gray-500">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------
const SEV_CLS: Record<string, string> = {
  critical: 'bg-red-950 text-red-300 border border-red-700',
  warning:  'bg-yellow-950 text-yellow-300 border border-yellow-700',
  info:     'bg-blue-950 text-blue-300 border border-blue-700',
};

function SeverityBadge({ sev }: { sev: string }) {
  return (
    <span className={`text-xs font-mono uppercase px-2 py-0.5 rounded whitespace-nowrap ${SEV_CLS[sev] ?? 'bg-gray-700 text-gray-300'}`}>
      {sev}
    </span>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  // per-metric history arrays (oldest → newest, max 20 entries)
  const [cpuH,   setCpuH]   = useState<number[]>([]);
  const [memH,   setMemH]   = useState<number[]>([]);
  const [diskH,  setDiskH]  = useState<number[]>([]);
  const [netRxH, setNetRxH] = useState<number[]>([]);
  const [netTxH, setNetTxH] = useState<number[]>([]);

  const [memInfo,  setMemInfo]  = useState<{ used_gib: number; total_gib: number } | null>(null);
  const [diskInfo, setDiskInfo] = useState<{ used_gb: number; total_gb: number } | null>(null);

  const [alerts,       setAlerts]       = useState<AlertRow[]>([]);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [clock,        setClock]        = useState(new Date());

  // 1-second clock tick
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- fetchers ----
  const fetchMetrics = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/servers/1/metrics?limit=80');
      if (!res.ok) return;
      const rows: MetricRow[] = await res.json();

      const byType = (t: MetricRow['metric_type']) =>
        rows
          .filter(r => r.metric_type === t)
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
          .slice(-20);

      const memRows  = byType('memory');
      const diskRows = byType('disk');

      setCpuH  (byType('cpu')   .map(r => r.value.cpu?.usage_percent  ?? 0));
      setMemH  (memRows          .map(r => r.value.memory?.used_percent ?? 0));
      setDiskH (diskRows         .map(r => r.value.disk?.used_percent   ?? 0));
      setNetRxH(byType('network').map(r => r.value.network?.rx_bytes    ?? 0));
      setNetTxH(byType('network').map(r => r.value.network?.tx_bytes    ?? 0));

      const lastMem = memRows.at(-1)?.value.memory;
      if (lastMem) setMemInfo({ used_gib: lastMem.used_gib, total_gib: lastMem.total_gib });

      const lastDisk = diskRows.at(-1)?.value.disk;
      if (lastDisk) setDiskInfo({ used_gb: lastDisk.used_gb, total_gb: lastDisk.total_gb });
      setLastRefresh(new Date());
    } catch (e) {
      console.error('metrics fetch error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/alerts?limit=30');
      if (!res.ok) return;
      setAlerts(await res.json());
    } catch (e) {
      console.error('alerts fetch error', e);
    }
  }, []);

  const fetchServer = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/servers');
      if (!res.ok) { setServerOnline(false); return; }
      const servers: ServerRow[] = await res.json();
      setServerOnline(servers.length > 0 && secondsAgo(servers[0].last_heartbeat) < 60);
    } catch {
      setServerOnline(false);
    }
  }, []);

  // initial fetch + 30s poll
  useEffect(() => {
    fetchMetrics();
    fetchAlerts();
    fetchServer();
    const t = setInterval(() => {
      fetchMetrics();
      fetchAlerts();
      fetchServer();
    }, 30_000);
    return () => clearInterval(t);
  }, [fetchMetrics, fetchAlerts, fetchServer]);

  // ---- acknowledge ----
  async function acknowledge(id: number) {
    try {
      await apiFetch(`/api/v1/alerts/${id}/acknowledge`, { method: 'POST' });
      setAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged: true } : a));
    } catch (e) {
      console.error('acknowledge error', e);
    }
  }

  // ---- derived latest values ----
  const latestCpu  = cpuH.at(-1)   ?? 0;
  const latestMem  = memH.at(-1)   ?? 0;
  const latestDisk = diskH.at(-1)  ?? 0;
  const latestRx   = netRxH.at(-1) ?? 0;
  const latestTx   = netTxH.at(-1) ?? 0;

  const activeAlerts = alerts.filter(a => !a.acknowledged).length;

  // ---- loading screen ----
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center font-mono text-sm">
        <span className="animate-pulse">connecting…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-mono">

      {/* ---- Header ---- */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between sticky top-0 bg-gray-950 z-10">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-bold tracking-[0.2em] text-white">FENRIS</h1>
          <span className="text-gray-700">|</span>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                serverOnline === true  ? 'bg-green-400 shadow-[0_0_4px_#4ade80]' :
                serverOnline === false ? 'bg-red-500' :
                'bg-gray-600'
              }`}
            />
            <span className={serverOnline === true ? 'text-green-400' : 'text-gray-500'}>
              {serverOnline === true ? 'online' : serverOnline === false ? 'offline' : '…'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          {lastRefresh && <span>updated {fmtClock(lastRefresh)}</span>}
          <span className="tabular-nums text-gray-400">{fmtClock(clock)}</span>
        </div>
      </header>

      <main className="px-6 py-6 max-w-5xl mx-auto space-y-8">

        {/* ---- Metrics ---- */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-gray-600 mb-3">System Metrics</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard
              label="CPU"
              display={`${latestCpu.toFixed(1)}%`}
              pct={latestCpu}
              history={cpuH}
            />
            <MetricCard
              label="Memory"
              display={`${latestMem.toFixed(1)}%`}
              pct={latestMem}
              history={memH}
              sub={memInfo ? `${memInfo.used_gib} / ${memInfo.total_gib} GiB` : undefined}
            />
            <MetricCard
              label="Disk"
              display={`${latestDisk.toFixed(1)}%`}
              pct={latestDisk}
              history={diskH}
              sub={diskInfo ? `${diskInfo.used_gb} / ${diskInfo.total_gb} GB` : undefined}
            />
            <MetricCard
              label="Network rx"
              display={fmtBytes(latestRx)}
              pct={null}
              history={netRxH}
              sub={`tx ${fmtBytes(latestTx)}`}
            />
          </div>
        </section>

        {/* ---- Alerts ---- */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-gray-600 mb-3">
            Alerts
            {activeAlerts > 0 && (
              <span className="ml-2 text-red-400 normal-case">
                — {activeAlerts} active
              </span>
            )}
          </h2>
          {alerts.length === 0 ? (
            <p className="text-xs text-gray-600">No alerts recorded.</p>
          ) : (
            <div className="space-y-2">
              {alerts.map(alert => (
                <div
                  key={alert.id}
                  className={`flex items-start gap-3 bg-gray-800 border border-gray-700 rounded p-3 transition-opacity duration-300 ${
                    alert.acknowledged ? 'opacity-35' : ''
                  }`}
                >
                  <SeverityBadge sev={alert.severity} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-200 truncate">{alert.message}</div>
                    <div className="text-xs text-gray-500 mt-0.5 space-x-2">
                      {alert.metric_type && (
                        <span className="uppercase">{alert.metric_type}</span>
                      )}
                      <span>{new Date(alert.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                  {!alert.acknowledged && (
                    <button
                      onClick={() => acknowledge(alert.id)}
                      className="shrink-0 text-xs text-gray-400 hover:text-white border border-gray-600 hover:border-gray-400 rounded px-2 py-1 transition-colors"
                    >
                      ack
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

      </main>
    </div>
  );
}
