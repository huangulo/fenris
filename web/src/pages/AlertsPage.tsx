import React, { useState, useMemo } from 'react';
import { AlertRow, ServerRow } from '../types';
import { fmtRelativeTime } from '../utils';
import { SeverityBadge } from '../components/Badges';

interface AlertsPageProps {
  alerts: AlertRow[];
  servers: ServerRow[];
  onAcknowledge: (id: number) => void;
  onAcknowledgeMany: (ids: number[]) => void;
}

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info';
type StatusFilter   = 'all' | 'active' | 'acknowledged';

export function AlertsPage({ alerts, servers, onAcknowledge, onAcknowledgeMany }: AlertsPageProps) {
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

  const activeCount  = alerts.filter(a => !a.acknowledged).length;
  const selectableIds = filtered.filter(a => !a.acknowledged).map(a => a.id);
  const allSelected  = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableIds));
    }
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
        {/* Server */}
        <select
          value={serverFilter === 'all' ? '' : serverFilter}
          onChange={e => setServerFilter(e.target.value === '' ? 'all' : parseInt(e.target.value))}
          className="text-xs font-mono bg-gray-800/80 border border-gray-700/60 text-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-gray-500"
        >
          <option value="">All Servers</option>
          {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        {/* Severity */}
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

        {/* Status */}
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
                <th className="px-4 py-3 w-16" />
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
                  <td className="px-4 py-3 text-gray-400 max-w-[280px] truncate" title={alert.message}>
                    {alert.message}
                  </td>
                  <td className="px-4 py-3 text-gray-600 uppercase hidden sm:table-cell">
                    {alert.metric_type ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">
                    {fmtRelativeTime(alert.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!alert.acknowledged && (
                      <button
                        onClick={() => onAcknowledge(alert.id)}
                        className="text-gray-600 hover:text-cyan-400 border border-transparent hover:border-cyan-800/50 rounded px-2 py-0.5 transition-colors whitespace-nowrap"
                      >
                        ack
                      </button>
                    )}
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
