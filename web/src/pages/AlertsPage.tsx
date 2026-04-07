import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
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

// ── AI summary expanded row ───────────────────────────────────────────────────

const severityBorderClass: Record<string, string> = {
  critical: 'border-l-red-500',
  warning:  'border-l-yellow-500',
  info:     'border-l-blue-400',
};

interface SummaryExpandedRowProps {
  alertId:   number;
  severity:  string;
  summaries: SummaryRow[];
  colSpan:   number;
}

function SummaryExpandedRow({ alertId, severity, summaries, colSpan }: SummaryExpandedRowProps) {
  const [text, setText]       = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const preloaded = useMemo(
    () => summaries.find(s => s.alert_ids.includes(alertId)),
    [summaries, alertId]
  );

  // Fetch on mount if not preloaded
  React.useEffect(() => {
    if (preloaded) { setText(preloaded.summary); return; }
    setLoading(true);
    apiFetch(`/api/v1/alerts/${alertId}/summary`)
      .then(res => res.ok ? res.json() : Promise.reject())
      .then((data: { summary: string }) => setText(data.summary))
      .catch(() => setText('No AI summary available for this alert.'))
      .finally(() => setLoading(false));
  }, [alertId, preloaded]);

  const borderClass = severityBorderClass[severity] ?? 'border-l-violet-500';

  return (
    <tr>
      <td colSpan={colSpan} className="px-0 pt-0 pb-2">
        <div
          className={`mx-4 rounded-r-lg border-l-2 ${borderClass} bg-gray-900/70 px-4 py-3 text-[11px] text-gray-300 leading-relaxed`}
        >
          {loading ? (
            <span className="text-gray-500 italic">Loading summary…</span>
          ) : (
            <ReactMarkdown
              components={{
                p:      ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-gray-100">{children}</strong>,
                em:     ({ children }) => <em className="italic text-gray-300">{children}</em>,
                ul:     ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
                ol:     ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
                li:     ({ children }) => <li className="text-gray-400">{children}</li>,
                code:   ({ children }) => (
                  <code className="bg-gray-800 text-cyan-300 rounded px-1 py-0.5 text-[10px]">{children}</code>
                ),
              }}
            >
              {text ?? ''}
            </ReactMarkdown>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AlertsPage({ alerts, servers, summaries, onAcknowledge, onAcknowledgeMany }: AlertsPageProps) {
  const [serverFilter,   setServerFilter]   = useState<number | 'all'>('all');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [statusFilter,   setStatusFilter]   = useState<StatusFilter>('active');
  const [selected,       setSelected]       = useState<Set<number>>(new Set());
  const [expandedId,     setExpandedId]     = useState<number | null>(null);

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
              {filtered.map(alert => {
                const hasSummary = alertsWithSummary.has(alert.id) || alert.summary_id != null;
                const isExpanded = expandedId === alert.id;
                return (
                  <React.Fragment key={alert.id}>
                    <tr
                      className={`border-b border-gray-800/50 transition-opacity ${
                        isExpanded ? '' : 'last:border-0'
                      } ${alert.acknowledged ? 'opacity-35' : 'hover:bg-gray-800/20'}`}
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
                          {hasSummary && (
                            <button
                              onClick={() => setExpandedId(isExpanded ? null : alert.id)}
                              title="View AI summary"
                              className={`text-[10px] font-bold px-1.5 py-0.5 rounded border transition-colors ${
                                isExpanded
                                  ? 'bg-violet-500/25 text-violet-300 border-violet-500/50'
                                  : 'bg-violet-500/10 text-violet-400 border-violet-700/40 hover:bg-violet-500/20'
                              }`}
                            >
                              AI
                            </button>
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
                    {isExpanded && (
                      <SummaryExpandedRow
                        alertId={alert.id}
                        severity={alert.severity}
                        summaries={summaries}
                        colSpan={7}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
