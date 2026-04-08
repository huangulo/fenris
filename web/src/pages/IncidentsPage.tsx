import React, { useState, useEffect, useCallback, useRef } from 'react';
import { IncidentRow, AlertRow, ServerRow } from '../types';
import { apiFetch } from '../api';
import { fmtRelativeTime } from '../utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

function severityColor(sev: IncidentRow['severity']) {
  if (sev === 'critical') return 'text-red-400 bg-red-500/10 border-red-700/40';
  if (sev === 'warning')  return 'text-yellow-400 bg-yellow-500/10 border-yellow-700/40';
  return 'text-blue-400 bg-blue-500/10 border-blue-700/40';
}

function severityDot(sev: IncidentRow['severity']) {
  if (sev === 'critical') return 'bg-red-500';
  if (sev === 'warning')  return 'bg-yellow-400';
  return 'bg-blue-400';
}

function stateLabel(state: IncidentRow['state']) {
  if (state === 'new')           return { label: 'NEW',          cls: 'text-red-400' };
  if (state === 'investigating') return { label: 'INVESTIGATING', cls: 'text-yellow-400' };
  return { label: 'RESOLVED', cls: 'text-emerald-400' };
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-red-900/90 border border-red-700/60 text-red-200 text-xs font-mono px-4 py-2 rounded-lg shadow-xl">
      {msg}
    </div>
  );
}

// ── Incident card ─────────────────────────────────────────────────────────────

interface CardProps {
  incident: IncidentRow;
  onClaim:    (id: number) => Promise<void>;
  onResolve:  (id: number) => Promise<void>;
  onReopen:   (id: number) => Promise<void>;
  onRelease:  (id: number) => Promise<void>;
  onClick:    (incident: IncidentRow) => void;
}

function IncidentCard({ incident, onClaim, onResolve, onReopen, onRelease, onClick }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy]         = useState(false);

  const act = async (e: React.MouseEvent, fn: (id: number) => Promise<void>) => {
    e.stopPropagation();
    setBusy(true);
    try { await fn(incident.id); } finally { setBusy(false); }
  };

  const sl = stateLabel(incident.state);

  return (
    <div
      className="card p-3 cursor-pointer hover:border-gray-700/80 hover:bg-gray-800/30 transition-all duration-150 select-none"
      onClick={() => onClick(incident)}
    >
      {/* Header row */}
      <div className="flex items-start gap-2 mb-2">
        <span className={`flex-shrink-0 mt-0.5 w-2 h-2 rounded-full ${severityDot(incident.severity)}`} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white leading-snug line-clamp-2">{incident.title}</p>
          <p className="text-[10px] text-gray-500 mt-0.5 font-mono">
            {incident.server_name ?? '—'} · started {fmtRelativeTime(incident.started_at)}
          </p>
        </div>
        <span className={`flex-shrink-0 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${severityColor(incident.severity)}`}>
          {incident.severity.toUpperCase()}
        </span>
      </div>

      {/* Alert count */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-mono text-gray-500">
          {incident.alert_count} alert{incident.alert_count !== 1 ? 's' : ''}
        </span>
        {incident.claimed_by && incident.state === 'investigating' && (
          <span className="text-[10px] text-gray-600 font-mono">· claimed by {incident.claimed_by}</span>
        )}
        {incident.state === 'resolved' && incident.resolved_at && (
          <span className="text-[10px] text-gray-600 font-mono">· resolved {fmtRelativeTime(incident.resolved_at)}</span>
        )}
      </div>

      {/* AI summary preview */}
      {incident.ai_summary && (
        <div className="mb-2">
          <p
            className={`text-[10px] text-gray-500 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}
            onClick={e => { e.stopPropagation(); setExpanded(x => !x); }}
          >
            {incident.ai_summary}
          </p>
          {!expanded && incident.ai_summary.length > 120 && (
            <button
              className="text-[10px] text-cyan-600 hover:text-cyan-400 mt-0.5"
              onClick={e => { e.stopPropagation(); setExpanded(true); }}
            >show more</button>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-1.5 pt-1 border-t border-gray-800/60" onClick={e => e.stopPropagation()}>
        {incident.state === 'new' && (
          <button
            disabled={busy}
            className="flex-1 text-[10px] font-medium py-1 rounded bg-yellow-500/15 border border-yellow-700/40 text-yellow-400 hover:bg-yellow-500/25 transition-colors disabled:opacity-50"
            onClick={e => act(e, onClaim)}
          >Claim</button>
        )}
        {incident.state === 'investigating' && (
          <>
            <button
              disabled={busy}
              className="flex-1 text-[10px] font-medium py-1 rounded bg-emerald-500/15 border border-emerald-700/40 text-emerald-400 hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
              onClick={e => act(e, onResolve)}
            >Resolve</button>
            <button
              disabled={busy}
              className="flex-1 text-[10px] font-medium py-1 rounded bg-gray-700/30 border border-gray-700/40 text-gray-400 hover:bg-gray-700/50 transition-colors disabled:opacity-50"
              onClick={e => act(e, onRelease)}
            >Release</button>
          </>
        )}
        {incident.state === 'resolved' && (
          <button
            disabled={busy}
            className="flex-1 text-[10px] font-medium py-1 rounded bg-gray-700/30 border border-gray-700/40 text-gray-400 hover:bg-gray-700/50 transition-colors disabled:opacity-50"
            onClick={e => act(e, onReopen)}
          >Reopen</button>
        )}
      </div>
    </div>
  );
}

// ── Detail modal ──────────────────────────────────────────────────────────────

interface ModalProps {
  incident:  IncidentRow;
  incidents: IncidentRow[];
  onClose:   () => void;
  onRefresh: () => void;
  onError:   (msg: string) => void;
}

function IncidentModal({ incident: init, incidents, onClose, onRefresh, onError }: ModalProps) {
  const [incident, setIncident] = useState<IncidentRow>(init);
  const [fullAlerts, setFullAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [selectedAlerts, setSelectedAlerts] = useState<Set<number>>(new Set());
  const [mergeTarget, setMergeTarget] = useState('');
  const [editTitle, setEditTitle]   = useState(init.title);
  const [editNotes, setEditNotes]   = useState(init.notes ?? '');
  const titleRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/v1/incidents/${init.id}`);
      if (res.ok) {
        const data: IncidentRow = await res.json();
        setIncident(data);
        setFullAlerts(data.alerts ?? []);
        setEditTitle(data.title);
        setEditNotes(data.notes ?? '');
      }
    } finally { setLoading(false); }
  }, [init.id]);

  useEffect(() => { load(); }, [load]);

  const saveTitle = async () => {
    if (editTitle === incident.title) return;
    const res = await apiFetch(`/api/v1/incidents/${incident.id}`, {
      method: 'PUT', body: JSON.stringify({ title: editTitle }),
    });
    if (res.ok) { const d = await res.json(); setIncident(d); onRefresh(); }
    else onError('Failed to update title');
  };

  const saveNotes = async () => {
    if (editNotes === incident.notes) return;
    const res = await apiFetch(`/api/v1/incidents/${incident.id}`, {
      method: 'PUT', body: JSON.stringify({ notes: editNotes }),
    });
    if (res.ok) { const d = await res.json(); setIncident(d); onRefresh(); }
    else onError('Failed to update notes');
  };

  const doMerge = async () => {
    const targetId = parseInt(mergeTarget);
    if (isNaN(targetId)) return;
    const res = await apiFetch(`/api/v1/incidents/${incident.id}/merge`, {
      method: 'POST', body: JSON.stringify({ target_incident_id: targetId }),
    });
    if (res.ok) { onRefresh(); onClose(); }
    else onError('Failed to merge incident');
  };

  const doSplit = async () => {
    if (selectedAlerts.size === 0) return;
    const res = await apiFetch(`/api/v1/incidents/${incident.id}/split`, {
      method: 'POST', body: JSON.stringify({ alert_ids: [...selectedAlerts] }),
    });
    if (res.ok) { onRefresh(); onClose(); }
    else onError('Failed to split incident');
  };

  const doAction = async (action: 'claim' | 'resolve' | 'reopen') => {
    const res = await apiFetch(`/api/v1/incidents/${incident.id}/${action}`, {
      method: 'POST', body: JSON.stringify({ claimed_by: 'you' }),
    });
    if (res.ok) { const d = await res.json(); setIncident(d); onRefresh(); }
    else onError(`Failed to ${action} incident`);
  };

  const toggleAlert = (id: number) => {
    setSelectedAlerts(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const mergeOptions = incidents.filter(i => i.id !== incident.id && i.state !== 'resolved');

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center overflow-y-auto py-8 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#0e1420] border border-gray-800/80 rounded-xl w-full max-w-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-gray-800/60">
          <span className={`flex-shrink-0 mt-1.5 w-2.5 h-2.5 rounded-full ${severityDot(incident.severity)}`} />
          <div className="flex-1 min-w-0">
            <input
              ref={titleRef}
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={e => { if (e.key === 'Enter') titleRef.current?.blur(); }}
              className="w-full bg-transparent text-white font-semibold text-sm leading-snug outline-none border-b border-transparent focus:border-gray-600 pb-0.5 transition-colors"
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[10px] font-mono text-gray-500">
              <span>Server: <span className="text-gray-400">{incident.server_name ?? '—'}</span></span>
              <span>Severity: <span className={incident.severity === 'critical' ? 'text-red-400' : incident.severity === 'warning' ? 'text-yellow-400' : 'text-blue-400'}>{incident.severity}</span></span>
              <span>State: <span className={stateLabel(incident.state).cls}>{incident.state}</span></span>
              <span>Started: <span className="text-gray-400">{fmtRelativeTime(incident.started_at)}</span></span>
              {incident.resolved_at && <span>Resolved: <span className="text-gray-400">{fmtRelativeTime(incident.resolved_at)}</span></span>}
              {incident.claimed_by && <span>Claimed by: <span className="text-gray-400">{incident.claimed_by}</span></span>}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0 mt-0.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-5 py-3 border-b border-gray-800/60">
          {incident.state === 'new' && (
            <button onClick={() => doAction('claim')} className="text-xs font-medium px-3 py-1.5 rounded bg-yellow-500/15 border border-yellow-700/40 text-yellow-400 hover:bg-yellow-500/25 transition-colors">Claim</button>
          )}
          {incident.state === 'investigating' && (
            <button onClick={() => doAction('resolve')} className="text-xs font-medium px-3 py-1.5 rounded bg-emerald-500/15 border border-emerald-700/40 text-emerald-400 hover:bg-emerald-500/25 transition-colors">Resolve</button>
          )}
          {incident.state === 'resolved' && (
            <button onClick={() => doAction('reopen')} className="text-xs font-medium px-3 py-1.5 rounded bg-gray-700/30 border border-gray-700/40 text-gray-400 hover:bg-gray-700/50 transition-colors">Reopen</button>
          )}
          {incident.state === 'investigating' && (
            <button onClick={() => doAction('reopen')} className="text-xs font-medium px-3 py-1.5 rounded bg-gray-700/30 border border-gray-700/40 text-gray-400 hover:bg-gray-700/50 transition-colors">Release</button>
          )}
        </div>

        <div className="p-5 space-y-5">
          {loading && (
            <div className="flex items-center justify-center py-6">
              <div className="w-5 h-5 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
            </div>
          )}

          {/* AI Summary */}
          {incident.ai_summary && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-2">AI Summary</h3>
              <div className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap bg-gray-900/40 rounded-lg p-3 border border-gray-800/60">
                {incident.ai_summary}
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-2">Notes</h3>
            <textarea
              value={editNotes}
              onChange={e => setEditNotes(e.target.value)}
              onBlur={saveNotes}
              placeholder="Add notes…"
              rows={3}
              className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 resize-none transition-colors font-mono"
            />
          </div>

          {/* Attached alerts */}
          {!loading && fullAlerts.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] uppercase tracking-widest text-gray-600">
                  Alerts ({fullAlerts.length})
                </h3>
                {selectedAlerts.size > 0 && (
                  <button onClick={doSplit} className="text-[10px] font-medium px-2 py-1 rounded bg-cyan-500/15 border border-cyan-700/40 text-cyan-400 hover:bg-cyan-500/25 transition-colors">
                    Split {selectedAlerts.size} into new incident
                  </button>
                )}
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {fullAlerts.map(a => (
                  <label
                    key={a.id}
                    className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${selectedAlerts.has(a.id) ? 'bg-cyan-900/20 border border-cyan-800/40' : 'hover:bg-gray-800/40 border border-transparent'}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedAlerts.has(a.id)}
                      onChange={() => toggleAlert(a.id)}
                      className="mt-0.5 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-gray-300 leading-snug">{a.message}</p>
                      <p className="text-[10px] text-gray-600 font-mono">
                        {a.severity} · {fmtRelativeTime(a.created_at)}
                        {a.acknowledged ? ' · acked' : ''}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Merge */}
          {mergeOptions.length > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-2">Merge into</h3>
              <div className="flex gap-2">
                <select
                  value={mergeTarget}
                  onChange={e => setMergeTarget(e.target.value)}
                  className="flex-1 bg-gray-900/40 border border-gray-800/60 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none focus:border-gray-600"
                >
                  <option value="">Select incident…</option>
                  {mergeOptions.map(i => (
                    <option key={i.id} value={i.id}>#{i.id} {i.title.slice(0, 60)}</option>
                  ))}
                </select>
                <button
                  onClick={doMerge}
                  disabled={!mergeTarget}
                  className="text-xs font-medium px-3 py-1.5 rounded bg-purple-500/15 border border-purple-700/40 text-purple-400 hover:bg-purple-500/25 transition-colors disabled:opacity-40"
                >Merge</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Kanban column ─────────────────────────────────────────────────────────────

interface ColumnProps {
  title:      string;
  accent:     string;
  incidents:  IncidentRow[];
  collapsed?: boolean;
  onClaim:    (id: number) => Promise<void>;
  onResolve:  (id: number) => Promise<void>;
  onReopen:   (id: number) => Promise<void>;
  onRelease:  (id: number) => Promise<void>;
  onClick:    (incident: IncidentRow) => void;
}

function KanbanColumn({ title, accent, incidents, collapsed: initCollapsed = false, onClaim, onResolve, onReopen, onRelease, onClick }: ColumnProps) {
  const [collapsed, setCollapsed] = useState(initCollapsed);
  const [showAll, setShowAll]     = useState(false);

  const sorted = [...incidents].sort((a, b) => {
    const sev = { critical: 3, warning: 2, info: 1 };
    const ds = sev[b.severity] - sev[a.severity];
    if (ds !== 0) return ds;
    return new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
  });

  const displayed = title === 'RESOLVED' && !showAll ? sorted.slice(0, 10) : sorted;

  return (
    <div className="flex flex-col min-h-0">
      <button
        className={`flex items-center gap-2 px-1 pb-2 border-b-2 ${accent} mb-3 w-full text-left`}
        onClick={() => setCollapsed(c => !c)}
      >
        <span className={`text-xs font-mono font-bold ${accent.replace('border-', 'text-').replace('/60', '')}`}>{title}</span>
        <span className="text-[10px] text-gray-600 font-mono">({incidents.length})</span>
        <svg className={`ml-auto w-3 h-3 text-gray-600 transition-transform ${collapsed ? '-rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {!collapsed && (
        <div className="space-y-2 overflow-y-auto flex-1">
          {displayed.map(inc => (
            <IncidentCard
              key={inc.id}
              incident={inc}
              onClaim={onClaim}
              onResolve={onResolve}
              onReopen={onReopen}
              onRelease={onRelease}
              onClick={onClick}
            />
          ))}
          {incidents.length === 0 && (
            <p className="text-[11px] text-gray-700 text-center py-6">No incidents</p>
          )}
          {title === 'RESOLVED' && sorted.length > 10 && !showAll && (
            <button
              className="w-full text-[10px] text-gray-600 hover:text-gray-400 py-2 transition-colors"
              onClick={() => setShowAll(true)}
            >show {sorted.length - 10} more</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Timeline view ─────────────────────────────────────────────────────────────

function formatDay(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (day.getTime() === today.getTime()) return 'Today';
  if (day.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface TimelineProps {
  incidents: IncidentRow[];
  onClaim:   (id: number) => Promise<void>;
  onResolve: (id: number) => Promise<void>;
  onReopen:  (id: number) => Promise<void>;
  onRelease: (id: number) => Promise<void>;
  onClick:   (incident: IncidentRow) => void;
}

function TimelineView({ incidents, onClaim, onResolve, onReopen, onRelease, onClick }: TimelineProps) {
  const grouped = new Map<string, IncidentRow[]>();
  for (const inc of incidents) {
    const key = formatDay(inc.started_at);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(inc);
  }

  return (
    <div className="space-y-6">
      {[...grouped.entries()].map(([day, items]) => (
        <div key={day}>
          <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">{day}</h3>
          <div className="space-y-2">
            {items.map(inc => (
              <div key={inc.id} className="flex gap-3">
                <div className="flex flex-col items-center flex-shrink-0 pt-1">
                  <span className={`w-2 h-2 rounded-full ${severityDot(inc.severity)}`} />
                  <div className="w-px flex-1 bg-gray-800/60 mt-1" />
                </div>
                <div className="flex-1 pb-2">
                  <IncidentCard
                    incident={inc}
                    onClaim={onClaim}
                    onResolve={onResolve}
                    onReopen={onReopen}
                    onRelease={onRelease}
                    onClick={onClick}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {incidents.length === 0 && (
        <p className="text-sm text-gray-600 text-center py-16">No incidents</p>
      )}
    </div>
  );
}

// ── Main IncidentsPage ────────────────────────────────────────────────────────

interface IncidentsPageProps {
  servers:              ServerRow[];
  onActiveCountChange?: (n: number) => void;
}

export function IncidentsPage({ servers, onActiveCountChange }: IncidentsPageProps) {
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [viewMode, setViewMode]   = useState<'kanban' | 'timeline'>('kanban');
  const [filterServer, setFilterServer] = useState<number | null>(null);
  const [modalIncident, setModalIncident] = useState<IncidentRow | null>(null);
  const [toast, setToast]               = useState<string | null>(null);

  const showError = useCallback((msg: string) => setToast(msg), []);

  const load = useCallback(async () => {
    try {
      const url = filterServer != null
        ? `/api/v1/incidents?server_id=${filterServer}&limit=200`
        : '/api/v1/incidents?limit=200';
      const res = await apiFetch(url);
      if (res.ok) {
        const data: IncidentRow[] = await res.json();
        setIncidents(data);
        const activeCount = data.filter(i => i.state !== 'resolved').length;
        onActiveCountChange?.(activeCount);
      }
    } finally { setLoading(false); }
  }, [filterServer, onActiveCountChange]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  // ── Actions (optimistic updates) ──────────────────────────────────────────

  const transition = useCallback(async (id: number, action: string, body?: object): Promise<void> => {
    const prev = incidents;
    try {
      const res = await apiFetch(`/api/v1/incidents/${id}/${action}`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        showError(`Failed to ${action} incident`);
        setIncidents(prev);
        return;
      }
      const updated: IncidentRow = await res.json();
      setIncidents(list => list.map(i => i.id === id ? { ...i, ...updated } : i));
      // Refresh modal if open
      if (modalIncident?.id === id) setModalIncident({ ...modalIncident, ...updated });
    } catch {
      showError(`Failed to ${action} incident`);
      setIncidents(prev);
    }
  }, [incidents, modalIncident, showError]);

  const handleClaim   = useCallback((id: number) => transition(id, 'claim',   { claimed_by: 'you' }), [transition]);
  const handleResolve = useCallback((id: number) => transition(id, 'resolve'), [transition]);
  const handleReopen  = useCallback((id: number) => transition(id, 'reopen'),  [transition]);
  const handleRelease = useCallback((id: number) => transition(id, 'reopen'),  [transition]);

  const openModal = (inc: IncidentRow) => setModalIncident(inc);
  const closeModal = () => { setModalIncident(null); load(); };

  // ── Derived ────────────────────────────────────────────────────────────────

  const newInc          = incidents.filter(i => i.state === 'new');
  const investigatingInc = incidents.filter(i => i.state === 'investigating');
  const resolvedInc     = incidents.filter(i => i.state === 'resolved');
  const activeCount     = newInc.length + investigatingInc.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="w-5 h-5 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-white">Incidents</h1>
          {activeCount > 0 && (
            <span className="text-xs font-mono font-bold bg-orange-500/15 text-orange-400 border border-orange-700/40 rounded-full px-2 py-0.5">
              {activeCount} active
            </span>
          )}
        </div>

        {/* View toggle */}
        <div className="flex gap-1 bg-gray-900/60 border border-gray-800/60 rounded-lg p-0.5 ml-auto">
          {(['kanban', 'timeline'] as const).map(m => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors capitalize ${viewMode === m ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >{m}</button>
          ))}
        </div>

        {/* Server filter */}
        <select
          value={filterServer ?? ''}
          onChange={e => setFilterServer(e.target.value ? parseInt(e.target.value) : null)}
          className="text-xs bg-gray-900/60 border border-gray-800/60 rounded-lg px-2 py-1.5 text-gray-400 outline-none focus:border-gray-600"
        >
          <option value="">All servers</option>
          {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {/* Content */}
      {viewMode === 'kanban' ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          <KanbanColumn
            title="NEW"
            accent="border-red-500/60"
            incidents={newInc}
            onClaim={handleClaim}
            onResolve={handleResolve}
            onReopen={handleReopen}
            onRelease={handleRelease}
            onClick={openModal}
          />
          <KanbanColumn
            title="INVESTIGATING"
            accent="border-yellow-500/60"
            incidents={investigatingInc}
            onClaim={handleClaim}
            onResolve={handleResolve}
            onReopen={handleReopen}
            onRelease={handleRelease}
            onClick={openModal}
          />
          <KanbanColumn
            title="RESOLVED"
            accent="border-emerald-500/60"
            incidents={resolvedInc}
            collapsed={resolvedInc.length > 0}
            onClaim={handleClaim}
            onResolve={handleResolve}
            onReopen={handleReopen}
            onRelease={handleRelease}
            onClick={openModal}
          />
        </div>
      ) : (
        <TimelineView
          incidents={incidents}
          onClaim={handleClaim}
          onResolve={handleResolve}
          onReopen={handleReopen}
          onRelease={handleRelease}
          onClick={openModal}
        />
      )}

      {/* Detail modal */}
      {modalIncident && (
        <IncidentModal
          incident={modalIncident}
          incidents={incidents}
          onClose={closeModal}
          onRefresh={load}
          onError={showError}
        />
      )}

      {/* Toast */}
      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
