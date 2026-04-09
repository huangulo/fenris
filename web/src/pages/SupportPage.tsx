import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../api';
import { SupportTicket, SupportTicketNote, SupportStats, TicketCategory, TicketPriority, TicketStatus } from '../types';
import { fmtRelativeTime } from '../utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMinutes(m: number): string {
  if (!m) return '—';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

const CATEGORY_ICONS: Record<TicketCategory, string> = {
  hardware: '🖥️', software: '💻', network: '🌐', email: '📧',
  printer: '🖨️', account: '👤', training: '📚', other: '🔧',
};

const PRIORITY_COLOR: Record<TicketPriority, string> = {
  low:    'text-gray-400 bg-gray-800/40 border-gray-700/40',
  normal: 'text-blue-400 bg-blue-900/20 border-blue-800/40',
  high:   'text-orange-400 bg-orange-900/20 border-orange-800/40',
  urgent: 'text-red-400 bg-red-900/20 border-red-800/40',
};

const STATUS_COLOR: Record<TicketStatus, string> = {
  open:        'text-cyan-400 bg-cyan-900/20 border-cyan-800/40',
  in_progress: 'text-yellow-400 bg-yellow-900/20 border-yellow-800/40',
  resolved:    'text-emerald-400 bg-emerald-900/20 border-emerald-800/40',
  cancelled:   'text-gray-500 bg-gray-900/20 border-gray-700/40',
};

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', cancelled: 'Cancelled',
};

function Badge({ text, cls }: { text: string; cls: string }) {
  return (
    <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border ${cls}`}>{text}</span>
  );
}

// ── New Ticket Modal ──────────────────────────────────────────────────────────

interface NewTicketModalProps {
  onClose: () => void;
  onCreated: (t: SupportTicket) => void;
}

function NewTicketModal({ onClose, onCreated }: NewTicketModalProps) {
  const [form, setForm] = useState({
    title: '', requester_name: '', requester_email: '', requester_department: '',
    description: '', category: 'other' as TicketCategory, priority: 'normal' as TicketPriority,
    device_info: '',
  });
  const [suggestions, setSuggestions] = useState<Array<{ requester_name: string; requester_email: string | null; requester_department: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  // Keyboard shortcut: Esc closes
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (!q.trim()) { setSuggestions([]); return; }
    try {
      const res = await apiFetch(`/api/v1/support/requesters?q=${encodeURIComponent(q)}`);
      if (res.ok) setSuggestions(await res.json());
    } catch { /* silent */ }
  }, []);

  const applySuggestion = (s: typeof suggestions[0]) => {
    setForm(f => ({
      ...f,
      requester_name:       s.requester_name,
      requester_email:      s.requester_email ?? f.requester_email,
      requester_department: s.requester_department ?? f.requester_department,
    }));
    setSuggestions([]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.requester_name.trim()) { setError('Title and requester name are required'); return; }
    setBusy(true);
    try {
      const res = await apiFetch('/api/v1/support/tickets', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      if (!res.ok) { setError('Failed to create ticket'); return; }
      const ticket: SupportTicket = await res.json();
      onCreated(ticket);
      onClose();
    } finally { setBusy(false); }
  };

  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        onSubmit={submit}
        className="bg-[#0e1420] border border-gray-800/80 rounded-xl w-full max-w-lg shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800/60">
          <h2 className="text-sm font-semibold text-white">New Ticket</h2>
          <button type="button" onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-3">
          {error && <p className="text-xs text-red-400 font-mono">{error}</p>}

          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-600 block mb-1">Title *</label>
            <input ref={titleRef} value={form.title} onChange={e => set('title', e.target.value)}
              placeholder="Short description of the issue"
              className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors" />
          </div>

          <div className="relative">
            <label className="text-[10px] uppercase tracking-widest text-gray-600 block mb-1">Requester *</label>
            <input value={form.requester_name}
              onChange={e => { set('requester_name', e.target.value); fetchSuggestions(e.target.value); }}
              placeholder="Full name"
              className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors" />
            {suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 bg-[#0e1420] border border-gray-800/80 rounded-lg shadow-xl z-10 mt-1">
                {suggestions.map((s, i) => (
                  <button key={i} type="button" onClick={() => applySuggestion(s)}
                    className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800/60 transition-colors">
                    <span className="font-medium">{s.requester_name}</span>
                    {s.requester_department && <span className="text-gray-600 ml-2">{s.requester_department}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-600 block mb-1">Category</label>
              <select value={form.category} onChange={e => set('category', e.target.value)}
                className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-2 py-2 text-xs text-gray-300 outline-none focus:border-gray-600">
                {(Object.keys(CATEGORY_ICONS) as TicketCategory[]).map(c => (
                  <option key={c} value={c}>{CATEGORY_ICONS[c]} {c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-600 block mb-1">Priority</label>
              <select value={form.priority} onChange={e => set('priority', e.target.value)}
                className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-2 py-2 text-xs text-gray-300 outline-none focus:border-gray-600">
                {(['low','normal','high','urgent'] as TicketPriority[]).map(p => (
                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-600 block mb-1">Email</label>
              <input value={form.requester_email} onChange={e => set('requester_email', e.target.value)}
                placeholder="user@example.com" type="email"
                className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-600 block mb-1">Department</label>
              <input value={form.requester_department} onChange={e => set('requester_department', e.target.value)}
                placeholder="Finance, IT, HR…"
                className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors" />
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-600 block mb-1">Device / Asset</label>
            <input value={form.device_info} onChange={e => set('device_info', e.target.value)}
              placeholder="Hostname, model, serial…"
              className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors" />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-600 block mb-1">Description</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              rows={3} placeholder="Detailed description…"
              className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors resize-none font-mono" />
          </div>
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-gray-800/60">
          <button type="button" onClick={onClose}
            className="flex-1 text-xs font-medium py-2 rounded bg-gray-800/40 border border-gray-700/40 text-gray-400 hover:bg-gray-700/40 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={busy}
            className="flex-1 text-xs font-medium py-2 rounded bg-cyan-500/15 border border-cyan-700/40 text-cyan-400 hover:bg-cyan-500/25 transition-colors disabled:opacity-50">
            {busy ? 'Creating…' : 'Create Ticket'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Ticket Detail Modal ───────────────────────────────────────────────────────

interface DetailModalProps {
  ticket: SupportTicket;
  onClose: () => void;
  onRefresh: () => void;
}

function DetailModal({ ticket: init, onClose, onRefresh }: DetailModalProps) {
  const [ticket, setTicket] = useState<SupportTicket>(init);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState('');
  const [noteDuration, setNoteDuration] = useState('');
  const [resolveText, setResolveText] = useState('');
  const [resolveDuration, setResolveDuration] = useState('');
  const [showResolveForm, setShowResolveForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/v1/support/tickets/${init.id}`);
      if (res.ok) setTicket(await res.json());
    } finally { setLoading(false); }
  }, [init.id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const doAction = async (action: string, body?: object) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/v1/support/tickets/${ticket.id}/${action}`, {
        method: 'POST', body: JSON.stringify(body ?? {}),
      });
      if (res.ok) { const t = await res.json(); setTicket(t); onRefresh(); }
    } finally { setBusy(false); }
  };

  const doUpdate = async (fields: Partial<SupportTicket>) => {
    const res = await apiFetch(`/api/v1/support/tickets/${ticket.id}`, {
      method: 'PUT', body: JSON.stringify(fields),
    });
    if (res.ok) { setTicket(await res.json()); onRefresh(); }
  };

  const submitNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteText.trim()) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/v1/support/tickets/${ticket.id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ note: noteText, duration_minutes: parseInt(noteDuration) || 0 }),
      });
      if (res.ok) {
        setNoteText('');
        setNoteDuration('');
        await load();
        onRefresh();
      }
    } finally { setBusy(false); }
  };

  const submitResolve = async (e: React.FormEvent) => {
    e.preventDefault();
    await doAction('resolve', { resolution: resolveText, duration_minutes: parseInt(resolveDuration) || 0 });
    setShowResolveForm(false);
  };

  const totalMinutes = (ticket.notes_duration_minutes ?? 0) + (ticket.duration_minutes ?? 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center overflow-y-auto py-8 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-[#0e1420] border border-gray-800/80 rounded-xl w-full max-w-2xl shadow-2xl">

        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-gray-800/60">
          <span className="text-2xl flex-shrink-0 mt-0.5">{CATEGORY_ICONS[ticket.category]}</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-white leading-snug">{ticket.title}</h2>
            <div className="flex flex-wrap gap-2 mt-1.5">
              <Badge text={STATUS_LABEL[ticket.status]} cls={STATUS_COLOR[ticket.status]} />
              <Badge text={ticket.priority} cls={PRIORITY_COLOR[ticket.priority]} />
              <Badge text={ticket.category} cls="text-gray-400 border-gray-700/40 bg-gray-800/20" />
              {totalMinutes > 0 && (
                <span className="text-[10px] font-mono text-cyan-400 bg-cyan-900/20 border border-cyan-800/40 px-1.5 py-0.5 rounded">
                  ⏱ {fmtMinutes(totalMinutes)}
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0 mt-0.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Requester info */}
        <div className="px-5 py-3 bg-gray-900/30 border-b border-gray-800/60 grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px] font-mono">
          <div><span className="text-gray-600">Requester: </span><span className="text-gray-300">{ticket.requester_name}</span></div>
          {ticket.requester_email      && <div><span className="text-gray-600">Email: </span><span className="text-gray-300">{ticket.requester_email}</span></div>}
          {ticket.requester_department && <div><span className="text-gray-600">Dept: </span><span className="text-gray-300">{ticket.requester_department}</span></div>}
          {ticket.device_info          && <div className="col-span-2"><span className="text-gray-600">Device: </span><span className="text-gray-300">{ticket.device_info}</span></div>}
          <div><span className="text-gray-600">Created: </span><span className="text-gray-400">{fmtRelativeTime(ticket.created_at)}</span></div>
          {ticket.assigned_to_username && <div><span className="text-gray-600">Assigned: </span><span className="text-gray-300">{ticket.assigned_to_username}</span></div>}
          {ticket.resolved_at && <div><span className="text-gray-600">Resolved: </span><span className="text-emerald-400">{fmtRelativeTime(ticket.resolved_at)}</span></div>}
        </div>

        {/* Action bar */}
        <div className="flex gap-2 px-5 py-3 border-b border-gray-800/60 flex-wrap">
          {ticket.status === 'open' && (
            <button disabled={busy} onClick={() => doAction('start')}
              className="text-xs font-medium px-3 py-1.5 rounded bg-yellow-500/15 border border-yellow-700/40 text-yellow-400 hover:bg-yellow-500/25 transition-colors disabled:opacity-50">
              Start Working
            </button>
          )}
          {ticket.status === 'in_progress' && !showResolveForm && (
            <button disabled={busy} onClick={() => setShowResolveForm(true)}
              className="text-xs font-medium px-3 py-1.5 rounded bg-emerald-500/15 border border-emerald-700/40 text-emerald-400 hover:bg-emerald-500/25 transition-colors disabled:opacity-50">
              Resolve
            </button>
          )}
          {(ticket.status === 'resolved' || ticket.status === 'cancelled') && (
            <button disabled={busy} onClick={() => doUpdate({ status: 'open' })}
              className="text-xs font-medium px-3 py-1.5 rounded bg-gray-700/30 border border-gray-700/40 text-gray-400 hover:bg-gray-700/50 transition-colors disabled:opacity-50">
              Reopen
            </button>
          )}
          {ticket.status !== 'cancelled' && ticket.status !== 'resolved' && (
            <button disabled={busy} onClick={() => doUpdate({ status: 'cancelled' })}
              className="text-xs font-medium px-3 py-1.5 rounded bg-gray-700/30 border border-gray-700/40 text-gray-500 hover:bg-gray-700/50 transition-colors disabled:opacity-50 ml-auto">
              Cancel
            </button>
          )}
        </div>

        <div className="p-5 space-y-5">
          {/* Resolve form */}
          {showResolveForm && (
            <form onSubmit={submitResolve} className="bg-emerald-900/10 border border-emerald-800/30 rounded-lg p-4 space-y-3">
              <h3 className="text-[10px] uppercase tracking-widest text-emerald-600">Resolve Ticket</h3>
              <textarea value={resolveText} onChange={e => setResolveText(e.target.value)}
                rows={3} placeholder="What did you do to fix this?"
                className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 resize-none transition-colors font-mono" />
              <div className="flex gap-2">
                <input value={resolveDuration} onChange={e => setResolveDuration(e.target.value)}
                  placeholder="Additional time (min)" type="number" min="0"
                  className="w-48 bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors" />
                <button type="submit" disabled={busy}
                  className="text-xs font-medium px-4 py-2 rounded bg-emerald-500/15 border border-emerald-700/40 text-emerald-400 hover:bg-emerald-500/25 transition-colors disabled:opacity-50">
                  Confirm Resolve
                </button>
                <button type="button" onClick={() => setShowResolveForm(false)}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Description */}
          {ticket.description && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-2">Description</h3>
              <p className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap font-mono bg-gray-900/40 rounded-lg p-3 border border-gray-800/60">
                {ticket.description}
              </p>
            </div>
          )}

          {/* Resolution */}
          {ticket.resolution && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-2">Resolution</h3>
              <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap bg-emerald-900/10 rounded-lg p-3 border border-emerald-800/30">
                {ticket.resolution}
              </p>
            </div>
          )}

          {/* Notes timeline */}
          {loading ? (
            <div className="space-y-2">
              {[0,1].map(i => <div key={i} className="h-12 bg-gray-800/40 rounded animate-pulse" />)}
            </div>
          ) : (
            <>
              {(ticket.notes ?? []).length > 0 && (
                <div>
                  <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">Notes</h3>
                  <div className="space-y-3">
                    {(ticket.notes ?? []).map((n: SupportTicketNote) => (
                      <div key={n.id} className="flex gap-3">
                        <div className="flex flex-col items-center flex-shrink-0 pt-1">
                          <span className="w-2 h-2 rounded-full bg-cyan-600" />
                          <div className="w-px flex-1 bg-gray-800/60 mt-1" />
                        </div>
                        <div className="flex-1 pb-2">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-mono text-gray-400 font-medium">{n.username}</span>
                            <span className="text-[10px] font-mono text-gray-600">{fmtRelativeTime(n.created_at)}</span>
                            {n.duration_minutes > 0 && (
                              <span className="text-[10px] font-mono text-cyan-600">+{fmtMinutes(n.duration_minutes)}</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">{n.note}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add note form */}
              <form onSubmit={submitNote} className="space-y-2">
                <h3 className="text-[10px] uppercase tracking-widest text-gray-600">Add Note</h3>
                <textarea value={noteText} onChange={e => setNoteText(e.target.value)}
                  rows={3} placeholder="What did you do?"
                  className="w-full bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 resize-none transition-colors font-mono" />
                <div className="flex gap-2">
                  <input value={noteDuration} onChange={e => setNoteDuration(e.target.value)}
                    placeholder="Time spent (min)" type="number" min="0"
                    className="w-40 bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors" />
                  <button type="submit" disabled={busy || !noteText.trim()}
                    className="text-xs font-medium px-4 py-2 rounded bg-cyan-500/15 border border-cyan-700/40 text-cyan-400 hover:bg-cyan-500/25 transition-colors disabled:opacity-50">
                    {busy ? 'Saving…' : 'Add Note'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stats section ─────────────────────────────────────────────────────────────

function StatsSection({ from, to }: { from: string; to: string }) {
  const [stats, setStats] = useState<SupportStats | null>(null);

  useEffect(() => {
    apiFetch(`/api/v1/support/stats?from=${from}&to=${to}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setStats(d));
  }, [from, to]);

  if (!stats) return <div className="h-32 bg-gray-800/40 rounded animate-pulse" />;

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Tickets', val: stats.total_tickets },
          { label: 'Total Time',    val: stats.total_hours },
          { label: 'Avg Resolution', val: stats.avg_resolution_time ?? '—' },
          { label: 'Open',          val: stats.by_status.find(s => s.status === 'open')?.count ?? 0 },
        ].map(c => (
          <div key={c.label} className="card p-4">
            <p className="text-[10px] uppercase tracking-widest text-gray-600">{c.label}</p>
            <p className="text-2xl font-mono font-bold text-white tabular-nums mt-1">{c.val}</p>
          </div>
        ))}
      </div>

      {/* By category */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4 space-y-2">
          <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">By Category</h3>
          {stats.by_category.map((c, i) => (
            <div key={c.category} className="flex items-center gap-3 text-xs font-mono">
              <span className="text-gray-700 w-4 text-right">{i + 1}.</span>
              <span className="text-lg">{CATEGORY_ICONS[c.category as TicketCategory] ?? '🔧'}</span>
              <span className="flex-1 text-gray-300 capitalize">{c.category}</span>
              <span className="text-cyan-400 font-bold tabular-nums">{c.count}</span>
            </div>
          ))}
          {stats.by_category.length === 0 && <p className="text-xs text-gray-700">No data</p>}
        </div>

        <div className="card p-4 space-y-2">
          <h3 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">Top Requesters</h3>
          {stats.top_requesters.slice(0, 5).map((r, i) => (
            <div key={r.requester_name} className="flex items-center gap-3 text-xs font-mono">
              <span className="text-gray-700 w-4 text-right">{i + 1}.</span>
              <span className="flex-1 text-gray-300 truncate">{r.requester_name}</span>
              <span className="text-orange-400 font-bold tabular-nums">{r.count}</span>
            </div>
          ))}
          {stats.top_requesters.length === 0 && <p className="text-xs text-gray-700">No data</p>}
        </div>
      </div>
    </div>
  );
}

// ── Main SupportPage ──────────────────────────────────────────────────────────

interface SupportPageProps {
  onOpenCountChange?: (n: number) => void;
}

export function SupportPage({ onOpenCountChange }: SupportPageProps) {
  const [tickets,  setTickets]  = useState<SupportTicket[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [search,   setSearch]   = useState('');
  const [showNew,  setShowNew]  = useState(false);
  const [modal,    setModal]    = useState<SupportTicket | null>(null);
  const [tab,      setTab]      = useState<'tickets' | 'reports'>('tickets');
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (filterStatus) params.set('status', filterStatus);
      if (search)       params.set('search', search);
      const res = await apiFetch(`/api/v1/support/tickets?${params}`);
      if (res.ok) {
        const data: SupportTicket[] = await res.json();
        setTickets(data);
        const open = data.filter(t => t.status === 'open' || t.status === 'in_progress').length;
        onOpenCountChange?.(open);
      }
    } finally { setLoading(false); }
  }, [filterStatus, search, onOpenCountChange]);

  useEffect(() => { load(); }, [load]);

  // Keyboard shortcut: N opens new ticket modal
  useEffect(() => {
    if (modal || showNew) return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setShowNew(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [modal, showNew]);

  const handleExportCSV = async () => {
    const res = await apiFetch(`/api/v1/support/report?from=${fromDate}&to=${toDate}&format=csv`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'support-report.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const openCount     = tickets.filter(t => t.status === 'open').length;
  const inProgCount   = tickets.filter(t => t.status === 'in_progress').length;
  const resolvedToday = tickets.filter(t => {
    if (t.status !== 'resolved' || !t.resolved_at) return false;
    return new Date(t.resolved_at).toDateString() === new Date().toDateString();
  }).length;
  const totalMinThisWeek = tickets
    .filter(t => new Date(t.created_at).getTime() > Date.now() - 7 * 86_400_000)
    .reduce((s, t) => s + (t.notes_duration_minutes ?? 0) + (t.duration_minutes ?? 0), 0);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-white">Support</h1>

        {/* Tab toggle */}
        <div className="flex gap-1 bg-gray-900/60 border border-gray-800/60 rounded-lg p-0.5">
          {(['tickets', 'reports'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors capitalize ${tab === t ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              {t}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowNew(true)}
          className="ml-auto text-xs font-medium px-3 py-1.5 rounded bg-cyan-500/15 border border-cyan-700/40 text-cyan-400 hover:bg-cyan-500/25 transition-colors"
          title="New Ticket (N)"
        >
          + New Ticket
        </button>
      </div>

      {tab === 'tickets' ? (
        <>
          {/* Stats cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Open',              val: openCount,       cls: 'text-cyan-400' },
              { label: 'In Progress',       val: inProgCount,     cls: 'text-yellow-400' },
              { label: 'Resolved Today',    val: resolvedToday,   cls: 'text-emerald-400' },
              { label: 'Hours This Week',   val: fmtMinutes(totalMinThisWeek), cls: 'text-purple-400' },
            ].map(c => (
              <div key={c.label} className="card p-4">
                <p className="text-[10px] uppercase tracking-widest text-gray-600">{c.label}</p>
                <p className={`text-2xl font-mono font-bold tabular-nums mt-1 ${c.cls}`}>{c.val}</p>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-2 items-center">
            {([
              { val: '',            label: 'All' },
              { val: 'open',        label: 'Open' },
              { val: 'in_progress', label: 'In Progress' },
              { val: 'resolved',    label: 'Resolved' },
            ] as { val: string; label: string }[]).map(f => (
              <button key={f.val} onClick={() => setFilterStatus(f.val)}
                className={`text-xs font-mono px-3 py-1 rounded-lg border transition-colors ${
                  filterStatus === f.val
                    ? 'bg-cyan-500/15 text-cyan-400 border-cyan-700/40'
                    : 'text-gray-500 border-gray-700/40 hover:text-gray-300 hover:border-gray-600'
                }`}>
                {f.label}
              </button>
            ))}
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search title, requester…"
              className="ml-auto w-56 bg-gray-900/60 border border-gray-800/60 rounded-lg px-3 py-1 text-xs text-gray-300 font-mono placeholder-gray-700 outline-none focus:border-gray-600"
            />
          </div>

          {/* Ticket table */}
          {loading ? (
            <div className="card overflow-hidden">
              {[0,1,2,3].map(i => (
                <div key={i} className="flex gap-4 px-4 py-3 border-b border-gray-800/40">
                  <div className="h-3 bg-gray-800/60 rounded animate-pulse w-1/3" />
                  <div className="h-3 bg-gray-800/40 rounded animate-pulse w-1/6" />
                  <div className="h-3 bg-gray-800/40 rounded animate-pulse w-1/6" />
                </div>
              ))}
            </div>
          ) : (
            <div className="card overflow-hidden">
              <div className="max-h-[65vh] overflow-y-auto">
                <table className="w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-[#0e1420]">
                    <tr className="border-b border-gray-800/60 text-[10px] uppercase tracking-widest text-gray-600">
                      <th className="px-4 py-3 text-left">Status</th>
                      <th className="px-4 py-3 text-left">Title</th>
                      <th className="px-4 py-3 text-left hidden sm:table-cell">Requester</th>
                      <th className="px-4 py-3 text-left hidden md:table-cell">Category</th>
                      <th className="px-4 py-3 text-left hidden lg:table-cell">Priority</th>
                      <th className="px-4 py-3 text-left hidden lg:table-cell">Assigned</th>
                      <th className="px-4 py-3 text-left hidden md:table-cell">Time</th>
                      <th className="px-4 py-3 text-left">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.length === 0 && (
                      <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-600">No tickets found.</td></tr>
                    )}
                    {tickets.map(t => (
                      <tr key={t.id}
                        className="border-b border-gray-800/40 hover:bg-gray-800/20 cursor-pointer transition-colors"
                        onClick={() => setModal(t)}>
                        <td className="px-4 py-2.5">
                          <Badge text={STATUS_LABEL[t.status]} cls={STATUS_COLOR[t.status]} />
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-white truncate max-w-[12rem] block">{t.title}</span>
                        </td>
                        <td className="px-4 py-2.5 text-gray-400 hidden sm:table-cell">{t.requester_name}</td>
                        <td className="px-4 py-2.5 hidden md:table-cell">
                          <span title={t.category}>{CATEGORY_ICONS[t.category]} <span className="text-gray-500 capitalize">{t.category}</span></span>
                        </td>
                        <td className="px-4 py-2.5 hidden lg:table-cell">
                          <Badge text={t.priority} cls={PRIORITY_COLOR[t.priority]} />
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 hidden lg:table-cell">{t.assigned_to_username ?? '—'}</td>
                        <td className="px-4 py-2.5 text-cyan-600 hidden md:table-cell">
                          {fmtMinutes((t.notes_duration_minutes ?? 0) + (t.duration_minutes ?? 0))}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{fmtRelativeTime(t.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {tickets.length > 0 && (
                <div className="px-4 py-2 text-[10px] text-gray-700 font-mono border-t border-gray-800/40">
                  {tickets.length} ticket{tickets.length !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        /* Reports tab */
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-[10px] uppercase tracking-widest text-gray-600">From</label>
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                className="bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-1.5 text-xs text-gray-300 outline-none focus:border-gray-600" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] uppercase tracking-widest text-gray-600">To</label>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                className="bg-gray-900/40 border border-gray-800/60 rounded-lg px-3 py-1.5 text-xs text-gray-300 outline-none focus:border-gray-600" />
            </div>
            <button onClick={handleExportCSV}
              className="ml-auto text-xs font-medium px-3 py-1.5 rounded bg-emerald-500/15 border border-emerald-700/40 text-emerald-400 hover:bg-emerald-500/25 transition-colors">
              Export CSV
            </button>
          </div>

          <StatsSection from={fromDate} to={toDate} />
        </div>
      )}

      {/* Modals */}
      {showNew && (
        <NewTicketModal
          onClose={() => setShowNew(false)}
          onCreated={() => load()}
        />
      )}
      {modal && (
        <DetailModal
          ticket={modal}
          onClose={() => { setModal(null); load(); }}
          onRefresh={load}
        />
      )}
    </div>
  );
}
