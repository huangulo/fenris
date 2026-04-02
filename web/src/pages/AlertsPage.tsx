import React, { useState, useMemo } from 'react';
import { AlertRow, ServerRow, SummaryRow } from '../types';
import { fmtRelativeTime } from '../utils';
import { SeverityBadge } from '../components/Badges';
import { apiFetch } from '../api';

interface AlertsPageProps {
  alerts:            AlertRow[];
  servers:           ServerRow[];
  summaries:         SummaryRow[];
  onAcknowledge:     (id: number) => void;
  onAcknowledgeMany: (ids: number[]) => void;
}

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info';
type StatusFilter   = 'all' | 'active' | 'acknowledged';

// ── Inline AI summary panel ───────────────────────────────────────────────────

function AISummaryInline({ alertId, summaries }: { alertId: number; summaries: SummaryRow[] }) {
  const [text, setText]       = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);

  // Check if this alert already has a summary in the pre-loaded list
  const preloaded = useMemo(
    () => summaries.find(s => s.alert_ids.includes(alertId)),
    [summaries, alertId]
  );

  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (preloaded) { setText(preloaded.summary); return; }
    if (text !== null) return; // already fetched

    setLoading(true);
    try {
      const res = await apiFetch(`/api/v1/alerts/${alertId}/summary`);
      if (res.ok) {
        const data = await res.json() as { summary: string };
        setText(data.summary);
      } else {
        setText('No AI summary available for this alert.');
      }
    } catch {
      setText('Failed to load summary.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        onClick={toggle}
        title="View AI summary"
        className={`text-[10px] font-bold px-1.5 py-0.5 rounded border transition-colors ${
          open
            ? 'bg-violet-500/25 text-violet-300 border-violet-500/50'
            : 'bg-violet-500/10 text-violet-400 border-violet-700/40 hover:bg-violet-500/20'
        }`}
      >
        AI
      </button>
      {open && (
        <div className="mt-1 w-72 text-left bg-gray-900 border border-violet-700/30 rounded-lg p-3 text-[11px] text-gray-300 leading-relaxed shadow-xl z-10">
          {loading ? (
            <span className="text-gray-500">Loading summary…</span>
          ) : (
            text
          )}
        </div>
      )}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AlertsPage({ alerts, servers, summaries, onAcknowledge, onAcknowledgeMany }: AlertsPageProps) {
  const [serverFilter,   setServerFilter]   = useState<number | 'all'>('all');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [statusFilter,   setStatusFilter]   = useState<StatusFilter>('active');
  const [selected,       setSelected]       = useState<Set<number>>(new Set());

  const filtered = useMemo(() => {
    return alerts.filter(a => {
      if (serverFilter !== 'all' && a.server_id !== serverFilter) return false;
      if (severityFilter !== 'all' && a.severity !== severityFilter) return false;
      if (statusFilter === 'active' && a.acknowledged) return false;
      if (statusFilter === 'acknowledged' && !a.acknowledged) return false;
      return true;
    });
  }, [alerts, serverFilter, severityFilter, statusFilter]);

  const activeCount   = alerts.filter(a => !a.acknowledged).length;
  const selectableIds = filtered.filter(a => !a.acknowledged).map(a => a.id);
  const allSelected   = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else             setSelected(new Set(selectableIds));
  };

  const bulkAck = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    onAcknowledgeMany(ids);
    setSelected(new Set());
  };

  const SelectBox = ({ id }: { id: number }) => (
    <input
      type="checkbox"
      checked={selected.has(id)}
      onChange={() => toggleSelect(id)}
      className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 accent-cyan-500 cursor-pointer"
    />
  );

  // Build a set of alert IDs that have a summary (for fast lookup)
  const alertsWithSummary = useMemo(
    () => new Set(summaries.flatMap(s => s.alert_ids)),
    [summaries]
  );

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-white">Alerts</h1>
          {activeCount > 0 && (
            <span className="text-xs font-mono bg-red-500/15 text-red-400 border border-red-700/30 rounded-full px-2.5 py-0.5">
              {activeCount} active
            </span>
          )}
        </div>
        {selected.size > 0 && (
          <button
            onClick={bulkAck}
            className="text-xs font-mono bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-lg px-3 py-1.5 transition-colors"
          >
            Acknowledge {selected.size} selected
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select
          value={serverFilter === 'all' ? '' : serverFilter}
          onChange={e => setServerFilter(e.target.value === '' ? 'all' : parseInt(e.target.value))}
          className="text-xs font-mono bg-gray-800/80 border border-gray-700/60 text-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-gray-500"
        >
          <option value="">All Servers</option>
          {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <select
          value={severityFilter}
          onChange={e => setSeverityFilter(e.target.value as SeverityFilter)}
          className="text-xs font-mono bg-gray-800/80 border border-gray-700/60 text-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-gray-500"
        >
          <option value="all">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>

        <div className="flex rounded-lg overflow-hidden border border-gray-700/60">
          {(['all', 'active', 'acknowledged'] as StatusFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`text-xs font-mono px-3 py-1.5 transition-colors capitalize ${
                statusFilter === s
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'bg-gray-800/60 text-gray-500 hover:text-gray-300'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="card p-8 flex flex-col items-center gap-3 text-center">
          <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 01-3.46 0"/>
            </svg>
          </div>
          <p className="text-sm text-gray-500">No alerts match the current filters</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-gray-800 text-gray-600 uppercase tracking-widest text-[10px]">
                <th className="px-4 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 accent-cyan-500 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3 text-left">Severity</th>
                <th className="px-4 py-3 text-left">Server</th>
                <th className="px-4 py-3 text-left">Message</th>
                <th className="px-4 py-3 text-left hidden sm:table-cell">Type</th>
                <th className="px-4 py-3 text-right">When</th>
                <th className="px-4 py-3 w-20 text-right" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(alert => (
                <tr
                  key={alert.id}
                  className={`border-b border-gray-800/50 last:border-0 transition-opacity ${
                    alert.acknowledged ? 'opacity-35' : 'hover:bg-gray-800/20'
                  }`}
                >
                  <td className="px-4 py-3">
                    {!alert.acknowledged && <SelectBox id={alert.id} />}
                  </td>
                  <td className="px-4 py-3">
                    <SeverityBadge sev={alert.severity} />
                  </td>
                  <td className="px-4 py-3 text-gray-300 font-semibold whitespace-nowrap">
                    {alert.server_name ?? `#${alert.server_id}`}
                  </td>
                  <td className="px-4 py-3 text-gray-400 max-w-[260px] truncate" title={alert.message}>
                    {alert.message}
                  </td>
                  <td className="px-4 py-3 text-gray-600 uppercase hidden sm:table-cell">
                    {alert.metric_type ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">
                    {fmtRelativeTime(alert.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* AI summary badge — show for alerts with a summary or predictive alerts */}
                      {(alertsWithSummary.has(alert.id) || alert.summary_id != null) && (
                        <AISummaryInline alertId={alert.id} summaries={summaries} />
                      )}
                      {!alert.acknowledged && (
                        <button
                          onClick={() => onAcknowledge(alert.id)}
                          className="text-gray-600 hover:text-cyan-400 border border-transparent hover:border-cyan-800/50 rounded px-2 py-0.5 transition-colors whitespace-nowrap"
                        >
                          ack
                        </button>
                      )}
                    </div>
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
