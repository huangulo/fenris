import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { WazuhAgentRow, WazuhStatus } from '../types';
import { apiFetch } from '../api';
import { fmtRelativeTime } from '../utils';

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { dot: string; label: string; text: string }> = {
  active:          { dot: 'bg-emerald-400', label: 'Active',          text: 'text-emerald-400' },
  disconnected:    { dot: 'bg-red-400',     label: 'Disconnected',    text: 'text-red-400'     },
  never_connected: { dot: 'bg-gray-500',    label: 'Never Connected', text: 'text-gray-500'    },
  pending:         { dot: 'bg-yellow-400',  label: 'Pending',         text: 'text-yellow-400'  },
};

function StatusDot({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? { dot: 'bg-gray-600', label: status, text: 'text-gray-400' };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dot}`} />
      <span className={`text-[11px] font-mono ${s.text}`}>{s.label}</span>
    </span>
  );
}

// ── OS icon (simple text glyphs) ──────────────────────────────────────────────

function OsIcon({ name }: { name: string | null }) {
  if (!name) return <span className="text-gray-600">—</span>;
  const lower = name.toLowerCase();
  if (lower.includes('windows')) return <span title={name} className="text-blue-400 text-xs">⊞</span>;
  if (lower.includes('mac') || lower.includes('darwin')) return <span title={name} className="text-gray-300 text-xs">⌘</span>;
  return <span title={name} className="text-orange-400 text-xs">🐧</span>;
}

// ── Keepalive cell ────────────────────────────────────────────────────────────

function KeepAliveCell({ ts, status }: { ts: string | null; status: string }) {
  if (!ts) return <span className="text-gray-600">—</span>;
  const ageMs  = Date.now() - new Date(ts).getTime();
  const stale  = status === 'active' && ageMs > 5 * 60_000;
  const label  = fmtRelativeTime(ts);
  return (
    <span className={stale ? 'text-red-400' : 'text-gray-400'}>{label}</span>
  );
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card px-4 py-3 flex flex-col gap-1 min-w-[100px]">
      <span className={`text-xl font-mono font-bold ${color}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-widest text-gray-500">{label}</span>
    </div>
  );
}

// ── Agent detail modal ────────────────────────────────────────────────────────

function AgentModal({ agent, onClose }: { agent: WazuhAgentRow; onClose: () => void }) {
  const [detail, setDetail] = useState<WazuhAgentRow>(agent);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch(`/api/v1/wazuh/agents/${agent.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setDetail(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agent.id]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const fields: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'Wazuh ID',      value: detail.wazuh_id },
    { label: 'IP Address',    value: detail.ip_address ?? '—' },
    { label: 'Status',        value: <StatusDot status={detail.status} /> },
    { label: 'OS',            value: detail.os_name ? `${detail.os_name} ${detail.os_version ?? ''}`.trim() : '—' },
    { label: 'Agent Version', value: detail.agent_version ?? '—' },
    { label: 'Group',         value: detail.group_name ?? '—' },
    { label: 'Last Keepalive',value: detail.last_keep_alive ? fmtRelativeTime(detail.last_keep_alive) : '—' },
    { label: 'Status Changed',value: detail.last_status_change ? fmtRelativeTime(detail.last_status_change) : '—' },
    { label: 'First Seen',    value: fmtRelativeTime(detail.first_seen) },
    { label: 'Last Seen',     value: fmtRelativeTime(detail.last_seen) },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg mx-4 p-5 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white font-mono">{detail.name}</h2>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 text-lg leading-none">×</button>
        </div>

        {loading ? (
          <div className="text-xs text-gray-500 font-mono">Loading…</div>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
              {fields.map(f => (
                <React.Fragment key={f.label}>
                  <dt className="text-gray-600 uppercase tracking-wider text-[10px]">{f.label}</dt>
                  <dd className="text-gray-300">{f.value}</dd>
                </React.Fragment>
              ))}
            </dl>

            {detail.recent_alerts && detail.recent_alerts.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest text-gray-600">Recent Alerts</p>
                {detail.recent_alerts.map(a => (
                  <div key={a.id} className="flex items-start gap-2 text-[11px]">
                    <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      a.severity === 'critical' ? 'bg-red-400' :
                      a.severity === 'warning'  ? 'bg-yellow-400' : 'bg-blue-400'
                    }`} />
                    <span className="text-gray-400 flex-1">{a.message}</span>
                    <span className="text-gray-600 whitespace-nowrap">{fmtRelativeTime(a.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'disconnected' | 'never_connected' | 'pending';

export function WazuhPage() {
  const [agents,    setAgents]    = useState<WazuhAgentRow[]>([]);
  const [status,    setStatus]    = useState<WazuhStatus | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [filter,    setFilter]    = useState<StatusFilter>('all');
  const [search,    setSearch]    = useState('');
  const [selected,  setSelected]  = useState<WazuhAgentRow | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [agRes, stRes] = await Promise.all([
        apiFetch('/api/v1/wazuh/agents'),
        apiFetch('/api/v1/wazuh/status'),
      ]);
      if (agRes.ok) setAgents(await agRes.json());
      if (stRes.ok) setStatus(await stRes.json());
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 60_000);
    return () => clearInterval(t);
  }, [fetchData]);

  const visible = useMemo(() => {
    return agents.filter(a => {
      if (filter !== 'all' && a.status !== filter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!a.name.toLowerCase().includes(q) && !(a.ip_address ?? '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [agents, filter, search]);

  const filterBtns: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all',             label: 'All' },
    { id: 'active',          label: 'Active' },
    { id: 'disconnected',    label: 'Disconnected' },
    { id: 'never_connected', label: 'Never Connected' },
    { id: 'pending',         label: 'Pending' },
  ];

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="w-5 h-5 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-sm font-semibold text-white">Wazuh Agents</h1>
        {status && (
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
            status.last_poll_ok
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-700/30'
              : 'bg-red-500/10 text-red-400 border-red-700/30'
          }`}>
            {status.last_poll_ok ? 'Connected' : 'Unreachable'}
            {status.last_poll_at && ` · ${fmtRelativeTime(status.last_poll_at)}`}
          </span>
        )}
      </div>

      {/* Summary cards */}
      {status && (
        <div className="flex flex-wrap gap-3">
          <StatCard label="Total"           value={status.total}           color="text-white" />
          <StatCard label="Active"          value={status.active}          color="text-emerald-400" />
          <StatCard label="Disconnected"    value={status.disconnected}    color="text-red-400" />
          <StatCard label="Never Connected" value={status.never_connected} color="text-gray-500" />
          <StatCard label="Pending"         value={status.pending}         color="text-yellow-400" />
        </div>
      )}

      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg overflow-hidden border border-gray-700/60">
          {filterBtns.map(b => (
            <button
              key={b.id}
              onClick={() => setFilter(b.id)}
              className={`text-xs font-mono px-3 py-1.5 transition-colors ${
                filter === b.id
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'bg-gray-800/60 text-gray-500 hover:text-gray-300'
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name or IP…"
          className="text-xs font-mono bg-gray-800/80 border border-gray-700/60 text-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-gray-500 w-48"
        />
      </div>

      {/* Agent table */}
      {visible.length === 0 ? (
        <div className="card p-8 flex flex-col items-center gap-3 text-center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <p className="text-sm text-gray-500">No agents match the current filter</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-gray-800 text-gray-600 uppercase tracking-widest text-[10px]">
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left hidden sm:table-cell">IP</th>
                <th className="px-4 py-3 text-left hidden md:table-cell">OS</th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">Version</th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">Group</th>
                <th className="px-4 py-3 text-right">Keepalive</th>
                <th className="px-4 py-3 text-right hidden sm:table-cell">Changed</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(agent => (
                <tr
                  key={agent.id}
                  onClick={() => setSelected(agent)}
                  className="border-b border-gray-800/50 last:border-0 hover:bg-gray-800/20 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <StatusDot status={agent.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-200 font-semibold">
                    {agent.name}
                  </td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                    {agent.ip_address ?? '—'}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className="flex items-center gap-1.5">
                      <OsIcon name={agent.os_name} />
                      <span className="text-gray-500">{agent.os_name ?? '—'}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 hidden lg:table-cell">
                    {agent.agent_version ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600 hidden lg:table-cell">
                    {agent.group_name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <KeepAliveCell ts={agent.last_keep_alive} status={agent.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap hidden sm:table-cell">
                    {agent.last_status_change ? fmtRelativeTime(agent.last_status_change) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <AgentModal agent={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
