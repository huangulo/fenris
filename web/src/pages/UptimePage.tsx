import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { MonitorRow, MonitorCheck } from '../types';
import { apiFetch } from '../api';
import { HistoryChart } from '../components/HistoryChart';
import { fmtRelativeTime } from '../utils';

// ── Icons ─────────────────────────────────────────────────────────────────────

const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

const IconPencil = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

const IconTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);

const IconBack = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);

const IconPlay = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>
);

// ── Uptime bar ─────────────────────────────────────────────────────────────────

function UptimeBar({ pct, label }: { pct: number | null; label: string }) {
  const color = pct == null ? '#4b5563'
    : pct >= 99 ? '#10b981'
    : pct >= 95 ? '#f59e0b'
    : '#ef4444';
  const display = pct == null ? '—' : `${pct.toFixed(1)}%`;
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</span>
        <span className="text-[10px] font-mono tabular-nums" style={{ color }}>{display}</span>
      </div>
      <div className="h-1 rounded-full bg-gray-800">
        {pct != null && (
          <div
            className="h-1 rounded-full transition-all duration-500"
            style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
          />
        )}
      </div>
    </div>
  );
}

// ── Monitor card ──────────────────────────────────────────────────────────────

interface MonitorCardProps {
  monitor: MonitorRow;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function MonitorCard({ monitor, selected, onSelect, onEdit, onDelete }: MonitorCardProps) {
  const isUp = monitor.last_is_up;
  const hasChecked = monitor.last_checked_at != null;

  const statusColor = !hasChecked ? 'text-gray-500'
    : isUp ? 'text-emerald-400' : 'text-red-400';
  const statusLabel = !hasChecked ? 'PENDING' : isUp ? 'UP' : 'DOWN';
  const dotColor = !hasChecked ? 'bg-gray-600'
    : isUp ? 'bg-emerald-400' : 'bg-red-500';

  const truncUrl = monitor.url.length > 48 ? monitor.url.slice(0, 45) + '…' : monitor.url;

  return (
    <div
      onClick={onSelect}
      className={`card p-4 cursor-pointer transition-all duration-150 hover:border-gray-600/60 ${
        selected ? 'border-cyan-500/50 bg-cyan-500/5' : ''
      } ${!isUp && hasChecked ? 'border-red-900/40' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor} ${!isUp && hasChecked ? 'animate-pulse' : ''}`} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate">{monitor.name}</p>
            <p className="text-[10px] font-mono text-gray-500 truncate mt-0.5">{truncUrl}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={e => { e.stopPropagation(); onEdit(); }}
            className="p-1 text-gray-600 hover:text-gray-300 transition-colors rounded"
            title="Edit"
          >
            <IconPencil />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="p-1 text-gray-600 hover:text-red-400 transition-colors rounded"
            title="Delete"
          >
            <IconTrash />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mt-3">
        <span className={`text-xs font-mono font-bold ${statusColor}`}>{statusLabel}</span>
        {monitor.last_response_time_ms != null && (
          <span className="text-[10px] font-mono text-gray-500">
            {monitor.last_response_time_ms}ms
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <UptimeBar pct={monitor.uptime_24h} label="24h" />
        <UptimeBar pct={monitor.uptime_7d}  label="7d" />
        <UptimeBar pct={monitor.uptime_30d} label="30d" />
      </div>

      {monitor.last_checked_at && (
        <p className="text-[10px] text-gray-700 mt-2">
          Checked {fmtRelativeTime(monitor.last_checked_at)}
        </p>
      )}
    </div>
  );
}

// ── Monitor form ──────────────────────────────────────────────────────────────

interface MonitorFormProps {
  initial: Partial<MonitorRow> | null;
  onSave: (data: any) => Promise<void>;
  onClose: () => void;
}

function MonitorForm({ initial, onSave, onClose }: MonitorFormProps) {
  const [name,           setName]           = useState(initial?.name ?? '');
  const [url,            setUrl]            = useState(initial?.url ?? '');
  const [method,         setMethod]         = useState(initial?.method ?? 'GET');
  const [interval,       setInterval]       = useState(String(initial?.interval_seconds ?? 60));
  const [timeout,        setTimeout_]       = useState(String(initial?.timeout_seconds ?? 10));
  const [expectedStatus, setExpectedStatus] = useState(String(initial?.expected_status ?? 200));
  const [headersJson,    setHeadersJson]    = useState(
    initial?.headers && Object.keys(initial.headers).length > 0
      ? JSON.stringify(initial.headers, null, 2)
      : ''
  );
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    let headers: Record<string, string> = {};
    if (headersJson.trim()) {
      try { headers = JSON.parse(headersJson); }
      catch { setError('Headers must be valid JSON'); return; }
    }

    setSaving(true);
    try {
      await onSave({
        name,
        url,
        method,
        interval_seconds: parseInt(interval) || 60,
        timeout_seconds:  parseInt(timeout) || 10,
        expected_status:  parseInt(expectedStatus) || 200,
        headers,
      });
      onClose();
    } catch (err: any) {
      setError(err.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full bg-gray-800/60 border border-gray-700/60 text-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-500 font-mono';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="card w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-white">
          {initial?.id ? 'Edit Monitor' : 'Add Monitor'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Name</label>
              <input value={name} onChange={e => setName(e.target.value)} required className={inputClass} placeholder="My API" />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">URL</label>
              <input value={url} onChange={e => setUrl(e.target.value)} required className={inputClass} placeholder="https://example.com/health" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Method</label>
              <select value={method} onChange={e => setMethod(e.target.value)} className={inputClass}>
                {['GET', 'HEAD', 'POST'].map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Expected Status</label>
              <input value={expectedStatus} onChange={e => setExpectedStatus(e.target.value)} className={inputClass} placeholder="200" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Interval (seconds)</label>
              <input value={interval} onChange={e => setInterval(e.target.value)} className={inputClass} placeholder="60" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">Timeout (seconds)</label>
              <input value={timeout} onChange={e => setTimeout_(e.target.value)} className={inputClass} placeholder="10" />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">
                Headers (JSON, optional)
              </label>
              <textarea
                value={headersJson}
                onChange={e => setHeadersJson(e.target.value)}
                className={`${inputClass} h-20 resize-none`}
                placeholder={'{\n  "Authorization": "Bearer token"\n}'}
              />
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-xs bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function MonitorDetail({
  monitor,
  checks,
  onBack,
  onTest,
}: {
  monitor: MonitorRow;
  checks: MonitorCheck[];
  onBack: () => void;
  onTest: () => void;
}) {
  const rtValues = useMemo(() => [...checks].reverse().map(c => Number(c.response_time_ms ?? 0)), [checks]);
  const rtTimestamps = useMemo(() => [...checks].reverse().map(c => c.checked_at), [checks]);

  const isSSL = monitor.url.startsWith('https://');
  const certExpiry = monitor.last_cert_expires_at ? new Date(monitor.last_cert_expires_at) : null;
  const daysLeft = certExpiry ? Math.floor((certExpiry.getTime() - Date.now()) / 86_400_000) : null;

  const certColor = daysLeft == null ? 'text-gray-500'
    : daysLeft <= 7  ? 'text-red-400'
    : daysLeft <= 14 ? 'text-amber-400'
    : 'text-emerald-400';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-200 transition-colors">
          <IconBack /> Back
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-white">{monitor.name}</h2>
          <p className="text-[10px] font-mono text-gray-500 truncate">{monitor.url}</p>
        </div>
        <button
          onClick={onTest}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
        >
          <IconPlay /> Test Now
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: '24h Uptime', value: monitor.uptime_24h != null ? `${monitor.uptime_24h}%` : '—' },
          { label: '7d Uptime',  value: monitor.uptime_7d  != null ? `${monitor.uptime_7d}%`  : '—' },
          { label: '30d Uptime', value: monitor.uptime_30d != null ? `${monitor.uptime_30d}%` : '—' },
          { label: 'Last Response', value: monitor.last_response_time_ms != null ? `${monitor.last_response_time_ms}ms` : '—' },
        ].map(s => (
          <div key={s.label} className="card-sm px-3 py-2">
            <p className="text-[9px] uppercase tracking-wider text-gray-600">{s.label}</p>
            <p className="text-sm font-mono font-bold text-gray-200 mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      {/* SSL cert info */}
      {isSSL && (
        <div className="card px-4 py-3 flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider text-gray-600">SSL Certificate</span>
          {certExpiry ? (
            <span className={`text-xs font-mono ${certColor}`}>
              Expires {certExpiry.toISOString().split('T')[0]}
              {daysLeft != null && ` (${daysLeft} day${daysLeft !== 1 ? 's' : ''} left)`}
            </span>
          ) : (
            <span className="text-xs text-gray-600">No cert info yet</span>
          )}
        </div>
      )}

      {/* Response time chart */}
      {rtValues.length > 1 && (
        <div className="card px-4 pt-3 pb-4">
          <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-2">Response Time (ms)</p>
          <HistoryChart
            values={rtValues}
            timestamps={rtTimestamps}
            color="#06b6d4"
            height={72}
            formatTooltip={v => `${Math.round(v)}ms`}
          />
        </div>
      )}

      {/* Check history */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 text-[10px] uppercase tracking-wider text-gray-600">
          Recent Checks
        </div>
        {checks.length === 0 ? (
          <p className="px-4 py-6 text-xs text-gray-600 text-center">No checks yet</p>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-gray-800/50 text-gray-600 text-[10px]">
                <th className="px-4 py-2 text-left">Time</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Code</th>
                <th className="px-4 py-2 text-right">Response</th>
                <th className="px-4 py-2 text-left hidden md:table-cell">Error</th>
              </tr>
            </thead>
            <tbody>
              {checks.map(c => (
                <tr key={c.id} className="border-b border-gray-800/30 last:border-0 hover:bg-gray-800/20">
                  <td className="px-4 py-2 text-gray-500">{fmtRelativeTime(c.checked_at)}</td>
                  <td className="px-4 py-2">
                    <span className={`font-bold ${c.is_up ? 'text-emerald-400' : 'text-red-400'}`}>
                      {c.is_up ? 'UP' : 'DOWN'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right text-gray-400">{c.status_code ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-gray-400">{c.response_time_ms != null ? `${c.response_time_ms}ms` : '—'}</td>
                  <td className="px-4 py-2 text-gray-600 max-w-xs truncate hidden md:table-cell">{c.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Data normalisers (PostgreSQL NUMERIC → JS number) ─────────────────────────

function normalizeMonitor(m: any): MonitorRow {
  return {
    ...m,
    uptime_24h:            m.uptime_24h            != null ? parseFloat(m.uptime_24h)        : null,
    uptime_7d:             m.uptime_7d             != null ? parseFloat(m.uptime_7d)         : null,
    uptime_30d:            m.uptime_30d            != null ? parseFloat(m.uptime_30d)        : null,
    last_response_time_ms: m.last_response_time_ms != null ? Number(m.last_response_time_ms) : null,
    last_status_code:      m.last_status_code      != null ? Number(m.last_status_code)      : null,
  };
}

function normalizeCheck(c: any): MonitorCheck {
  return {
    ...c,
    response_time_ms: c.response_time_ms != null ? Number(c.response_time_ms) : null,
    status_code:      c.status_code      != null ? Number(c.status_code)      : null,
  };
}

// ── UptimePage ────────────────────────────────────────────────────────────────

export function UptimePage() {
  const [monitors, setMonitors]       = useState<MonitorRow[]>([]);
  const [selected, setSelected]       = useState<MonitorRow | null>(null);
  const [checks,   setChecks]         = useState<MonitorCheck[]>([]);
  const [showForm, setShowForm]       = useState(false);
  const [editing,  setEditing]        = useState<MonitorRow | null>(null);
  const [loading,  setLoading]        = useState(true);
  const [testResult, setTestResult]   = useState<string | null>(null);

  const fetchMonitors = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/monitors');
      if (res.ok) setMonitors((await res.json()).map(normalizeMonitor));
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  const fetchChecks = useCallback(async (id: number) => {
    try {
      const res = await apiFetch(`/api/v1/monitors/${id}/checks?limit=100`);
      if (res.ok) setChecks((await res.json()).map(normalizeCheck));
    } catch { /* silent */ }
  }, []);

  // Initial load + 30s refresh
  useEffect(() => {
    fetchMonitors();
    const t = setInterval(fetchMonitors, 30_000);
    return () => clearInterval(t);
  }, [fetchMonitors]);

  // Refresh checks when selected monitor changes
  useEffect(() => {
    if (selected) {
      fetchChecks(selected.id);
      const t = setInterval(() => fetchChecks(selected.id), 30_000);
      return () => clearInterval(t);
    }
  }, [selected, fetchChecks]);

  // Update selected monitor from refreshed list
  useEffect(() => {
    if (selected) {
      const updated = monitors.find(m => m.id === selected.id);
      if (updated) setSelected(updated);
    }
  }, [monitors]);

  const sorted = useMemo(
    () => [...monitors].sort((a, b) => {
      // DOWN (or never checked) first, then alphabetically
      const aDown = a.last_is_up === false ? 0 : 1;
      const bDown = b.last_is_up === false ? 0 : 1;
      if (aDown !== bDown) return aDown - bDown;
      return a.name.localeCompare(b.name);
    }),
    [monitors]
  );

  const upCount  = monitors.filter(m => m.last_is_up === true).length;
  const avgRt    = useMemo(() => {
    const checked = monitors.filter(m => m.last_response_time_ms != null);
    if (!checked.length) return null;
    return Math.round(checked.reduce((s, m) => s + m.last_response_time_ms!, 0) / checked.length);
  }, [monitors]);

  const handleSave = async (data: any) => {
    if (editing?.id) {
      const res = await apiFetch(`/api/v1/monitors/${editing.id}`, { method: 'PUT', body: JSON.stringify(data) });
      if (!res.ok) throw new Error(await res.text());
    } else {
      const res = await apiFetch('/api/v1/monitors', { method: 'POST', body: JSON.stringify(data) });
      if (!res.ok) throw new Error(await res.text());
    }
    await fetchMonitors();
    setEditing(null);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this monitor and all its check history?')) return;
    await apiFetch(`/api/v1/monitors/${id}`, { method: 'DELETE' });
    if (selected?.id === id) setSelected(null);
    await fetchMonitors();
  };

  const handleTest = async () => {
    if (!selected) return;
    setTestResult('Testing…');
    try {
      const res = await apiFetch(`/api/v1/monitors/${selected.id}/test`, { method: 'POST' });
      const data = await res.json() as any;
      const status = data.is_up ? 'UP' : 'DOWN';
      const rt = data.response_time_ms != null ? ` • ${data.response_time_ms}ms` : '';
      const err = data.error ? ` • ${data.error}` : '';
      setTestResult(`${status}${rt}${err}`);
    } catch {
      setTestResult('Test failed');
    }
    setTimeout(() => setTestResult(null), 6_000);
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-40">
        <div className="w-5 h-5 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-white">Uptime</h1>
          <span className={`text-xs font-mono ${upCount === monitors.length && monitors.length > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {upCount}/{monitors.length} up
          </span>
          {avgRt != null && (
            <span className="text-xs font-mono text-gray-500">{avgRt}ms avg</span>
          )}
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
        >
          <IconPlus /> Add Monitor
        </button>
      </div>

      {/* Test result flash */}
      {testResult && (
        <div className={`card-sm px-4 py-2 text-xs font-mono ${
          testResult.startsWith('UP') ? 'text-emerald-400 border-emerald-800/50'
          : testResult === 'Testing…' ? 'text-gray-400'
          : 'text-red-400 border-red-900/50'
        }`}>
          {testResult}
        </div>
      )}

      {monitors.length === 0 ? (
        <div className="card p-10 flex flex-col items-center gap-3 text-center">
          <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
            </svg>
          </div>
          <p className="text-sm text-gray-500">No monitors configured</p>
          <p className="text-xs text-gray-600">Click "Add Monitor" to start watching your endpoints.</p>
        </div>
      ) : selected ? (
        <MonitorDetail
          monitor={selected}
          checks={checks}
          onBack={() => { setSelected(null); setChecks([]); }}
          onTest={handleTest}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sorted.map(m => (
            <MonitorCard
              key={m.id}
              monitor={m}
              selected={selected === m}
              onSelect={() => { setSelected(m); setChecks([]); }}
              onEdit={() => { setEditing(m); setShowForm(true); }}
              onDelete={() => handleDelete(m.id)}
            />
          ))}
        </div>
      )}

      {showForm && (
        <MonitorForm
          initial={editing}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditing(null); }}
        />
      )}
    </div>
  );
}
