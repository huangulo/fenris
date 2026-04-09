import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api';
import { useAuth, hasRole } from '../auth';
import { WazuhStatus, CrowdSecStatus } from '../types';
import { fmtRelativeTime } from '../utils';

interface SettingsPageProps {
  config: Record<string, unknown> | null;
}

function JsonBlock({ data }: { data: unknown }) {
  return (
    <pre className="text-xs font-mono text-gray-400 bg-gray-800/60 border border-gray-700/50 rounded-lg p-4 overflow-x-auto leading-relaxed">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-widest text-gray-600">{title}</h2>
      {children}
    </div>
  );
}

// ── Account section ───────────────────────────────────────────────────────────

function AccountSection() {
  const { user, logout } = useAuth();
  const [cur, setCur]    = useState('');
  const [next, setNext]  = useState('');
  const [msg, setMsg]    = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy]  = useState(false);

  const changePassword = async () => {
    if (!cur || !next) { setMsg({ ok: false, text: 'Both fields required' }); return; }
    if (next.length < 8) { setMsg({ ok: false, text: 'New password must be ≥ 8 characters' }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await apiFetch('/api/v1/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: cur, new_password: next }),
      });
      if (res.ok) {
        setMsg({ ok: true, text: 'Password changed.' });
        setCur(''); setNext('');
      } else {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setMsg({ ok: false, text: d.error ?? 'Failed' });
      }
    } finally { setBusy(false); }
  };

  const roleColor = user?.role === 'admin' ? 'text-cyan-400'
                  : user?.role === 'operator' ? 'text-yellow-400'
                  : 'text-gray-400';

  return (
    <div className="card p-4 space-y-4">
      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <span className="text-gray-500">Username</span>
        <span className="text-gray-300">{user?.username}</span>
        <span className="text-gray-500">Role</span>
        <span className={roleColor}>{user?.role}</span>
        <span className="text-gray-500">Email</span>
        <span className="text-gray-400">{user?.email ?? '—'}</span>
      </div>

      <div className="border-t border-gray-800/60 pt-4">
        <p className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">Change Password</p>
        <div className="space-y-2">
          <input type="password" placeholder="Current password" value={cur}
            onChange={e => setCur(e.target.value)}
            className="w-full bg-gray-900/60 border border-gray-800/60 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 font-mono" />
          <input type="password" placeholder="New password (min 8 chars)" value={next}
            onChange={e => setNext(e.target.value)}
            className="w-full bg-gray-900/60 border border-gray-800/60 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 font-mono" />
          <div className="flex gap-2 items-center">
            <button onClick={changePassword} disabled={busy}
              className="text-xs font-mono bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 text-cyan-400 border border-cyan-500/30 rounded-lg px-3 py-1.5 transition-colors">
              Update Password
            </button>
            {msg && <span className={`text-xs font-mono ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</span>}
          </div>
        </div>
      </div>

      <div className="border-t border-gray-800/60 pt-3">
        <button onClick={() => logout()}
          className="text-xs font-mono text-red-400 hover:text-red-300 border border-red-800/40 bg-red-900/10 hover:bg-red-900/20 rounded-lg px-3 py-1.5 transition-colors">
          Sign out
        </button>
      </div>
    </div>
  );
}

// ── User management section (admin only) ──────────────────────────────────────

interface UserRow {
  id: number; username: string; email: string | null;
  role: string; enabled: boolean; last_login: string | null; created_at: string;
}

function UserManagement() {
  const [users, setUsers]     = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser]   = useState({ username: '', email: '', password: '', role: 'viewer' });
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [resetId, setResetId]   = useState<number | null>(null);
  const [resetPw, setResetPw]   = useState('');
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch('/api/v1/users');
    if (res.ok) setUsers(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const createUser = async () => {
    setCreateErr(null);
    const res = await apiFetch('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify(newUser),
    });
    if (res.ok) {
      setCreating(false);
      setNewUser({ username: '', email: '', password: '', role: 'viewer' });
      load();
    } else {
      const d = await res.json().catch(() => ({})) as { error?: string };
      setCreateErr(d.error ?? 'Failed');
    }
  };

  const toggleEnabled = async (u: UserRow) => {
    await apiFetch(`/api/v1/users/${u.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !u.enabled }),
    });
    load();
  };

  const changeRole = async (u: UserRow, role: string) => {
    await apiFetch(`/api/v1/users/${u.id}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
    load();
  };

  const deleteUser = async (u: UserRow) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    const res = await apiFetch(`/api/v1/users/${u.id}`, { method: 'DELETE' });
    if (res.ok) load();
    else {
      const d = await res.json().catch(() => ({})) as { error?: string };
      alert(d.error ?? 'Failed to delete');
    }
  };

  const doReset = async () => {
    if (!resetId || resetPw.length < 8) { setResetMsg('Min 8 characters'); return; }
    const res = await apiFetch(`/api/v1/users/${resetId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ new_password: resetPw }),
    });
    if (res.ok) { setResetMsg('Password reset.'); setResetPw(''); setTimeout(() => { setResetId(null); setResetMsg(null); }, 2000); }
    else { const d = await res.json().catch(() => ({})) as { error?: string }; setResetMsg(d.error ?? 'Failed'); }
  };

  if (loading) return <div className="card p-4 text-xs text-gray-600">Loading…</div>;

  return (
    <div className="space-y-3">
      {/* User table */}
      <div className="card overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-gray-800/60">
              <th className="text-left px-3 py-2 text-gray-600 font-medium">Username</th>
              <th className="text-left px-3 py-2 text-gray-600 font-medium">Role</th>
              <th className="text-left px-3 py-2 text-gray-600 font-medium">Status</th>
              <th className="text-left px-3 py-2 text-gray-600 font-medium">Last login</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                <td className="px-3 py-2 text-gray-300">{u.username}</td>
                <td className="px-3 py-2">
                  <select value={u.role}
                    onChange={e => changeRole(u, e.target.value)}
                    className="bg-transparent text-xs text-gray-400 outline-none cursor-pointer hover:text-gray-200">
                    <option value="viewer">viewer</option>
                    <option value="operator">operator</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="px-3 py-2">
                  <button onClick={() => toggleEnabled(u)}
                    className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${u.enabled
                      ? 'text-emerald-400 border-emerald-800/40 bg-emerald-900/10 hover:bg-emerald-900/20'
                      : 'text-red-400 border-red-800/40 bg-red-900/10 hover:bg-red-900/20'}`}>
                    {u.enabled ? 'enabled' : 'disabled'}
                  </button>
                </td>
                <td className="px-3 py-2 text-gray-500">
                  {u.last_login ? fmtRelativeTime(u.last_login) : '—'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => { setResetId(u.id); setResetPw(''); setResetMsg(null); }}
                      className="text-[10px] text-cyan-600 hover:text-cyan-400 transition-colors">reset pw</button>
                    <button onClick={() => deleteUser(u)}
                      className="text-[10px] text-red-600 hover:text-red-400 transition-colors">delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Reset password inline modal */}
      {resetId !== null && (
        <div className="card p-3 border-cyan-800/40 bg-cyan-900/5 flex gap-2 items-center">
          <input type="password" placeholder="New password" value={resetPw}
            onChange={e => setResetPw(e.target.value)}
            className="flex-1 bg-gray-900/60 border border-gray-800/60 rounded px-2 py-1 text-xs text-gray-300 font-mono outline-none focus:border-gray-600" />
          <button onClick={doReset}
            className="text-xs font-mono text-cyan-400 border border-cyan-800/40 rounded px-2 py-1 hover:bg-cyan-900/20">Set</button>
          <button onClick={() => { setResetId(null); setResetMsg(null); }}
            className="text-xs text-gray-600 hover:text-gray-400">Cancel</button>
          {resetMsg && <span className={`text-xs ${resetMsg.includes('reset') ? 'text-emerald-400' : 'text-red-400'}`}>{resetMsg}</span>}
        </div>
      )}

      {/* Create user */}
      {creating ? (
        <div className="card p-3 space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-gray-600">New User</p>
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="Username" value={newUser.username}
              onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))}
              className="bg-gray-900/60 border border-gray-800/60 rounded px-2 py-1 text-xs text-gray-300 font-mono outline-none focus:border-gray-600" />
            <input placeholder="Email (optional)" value={newUser.email}
              onChange={e => setNewUser(u => ({ ...u, email: e.target.value }))}
              className="bg-gray-900/60 border border-gray-800/60 rounded px-2 py-1 text-xs text-gray-300 font-mono outline-none focus:border-gray-600" />
            <input type="password" placeholder="Password" value={newUser.password}
              onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
              className="bg-gray-900/60 border border-gray-800/60 rounded px-2 py-1 text-xs text-gray-300 font-mono outline-none focus:border-gray-600" />
            <select value={newUser.role} onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))}
              className="bg-gray-900/60 border border-gray-800/60 rounded px-2 py-1 text-xs text-gray-400 outline-none focus:border-gray-600">
              <option value="viewer">viewer</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
          </div>
          {createErr && <p className="text-xs text-red-400 font-mono">{createErr}</p>}
          <div className="flex gap-2">
            <button onClick={createUser}
              className="text-xs font-mono text-cyan-400 border border-cyan-800/40 rounded px-3 py-1 hover:bg-cyan-900/20">Create</button>
            <button onClick={() => { setCreating(false); setCreateErr(null); }}
              className="text-xs text-gray-600 hover:text-gray-400">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setCreating(true)}
          className="text-xs font-mono text-cyan-400 border border-cyan-700/40 rounded-lg px-3 py-1.5 hover:bg-cyan-900/10 transition-colors">
          + Add User
        </button>
      )}
    </div>
  );
}

// ── Audit log section (admin only) ────────────────────────────────────────────

interface AuditEntry {
  id: number; username: string; action: string;
  resource_type: string | null; resource_id: number | null;
  metadata: Record<string, unknown> | null; ip_address: string | null;
  created_at: string;
}

function AuditLogSection() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState('');

  const load = useCallback(async () => {
    const url = filter ? `/api/v1/audit?action=${encodeURIComponent(filter)}&limit=100` : '/api/v1/audit?limit=100';
    const res = await apiFetch(url);
    if (res.ok) setEntries(await res.json());
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const actionColor = (action: string) => {
    if (action.includes('login_failed')) return 'text-red-400';
    if (action.includes('login'))        return 'text-emerald-400';
    if (action.includes('delete'))       return 'text-red-400';
    if (action.includes('create'))       return 'text-cyan-400';
    if (action.includes('resolve'))      return 'text-emerald-400';
    if (action.includes('claim'))        return 'text-yellow-400';
    return 'text-gray-400';
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input placeholder="Filter by action (e.g. auth.login)" value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 bg-gray-900/60 border border-gray-800/60 rounded-lg px-3 py-1.5 text-xs text-gray-300 font-mono outline-none focus:border-gray-600" />
        <button onClick={load}
          className="text-xs font-mono text-gray-400 border border-gray-700/40 rounded-lg px-3 py-1.5 hover:bg-gray-800/40 transition-colors">
          Search
        </button>
      </div>

      {loading ? (
        <div className="card p-4 text-xs text-gray-600">Loading…</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0 bg-[#0e1420]">
                <tr className="border-b border-gray-800/60">
                  <th className="text-left px-3 py-2 text-gray-600 font-medium">Time</th>
                  <th className="text-left px-3 py-2 text-gray-600 font-medium">User</th>
                  <th className="text-left px-3 py-2 text-gray-600 font-medium">Action</th>
                  <th className="text-left px-3 py-2 text-gray-600 font-medium">Resource</th>
                  <th className="text-left px-3 py-2 text-gray-600 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                    <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{fmtRelativeTime(e.created_at)}</td>
                    <td className="px-3 py-1.5 text-gray-300">{e.username}</td>
                    <td className={`px-3 py-1.5 ${actionColor(e.action)}`}>{e.action}</td>
                    <td className="px-3 py-1.5 text-gray-500">
                      {e.resource_type ? `${e.resource_type}${e.resource_id ? ` #${e.resource_id}` : ''}` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-gray-600">{e.ip_address ?? '—'}</td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-600">No entries</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Test alert ────────────────────────────────────────────────────────────────

interface TestResult { sent: string[]; failed: string[]; disabled: string[] }

function ResultPills({ result }: { result: TestResult }) {
  const pills = [
    ...result.sent    .map(c => ({ label: `${c}: sent`,     color: 'bg-emerald-500/15 text-emerald-400 border-emerald-700/40' })),
    ...result.failed  .map(c => ({ label: `${c}: failed`,   color: 'bg-red-500/15 text-red-400 border-red-700/40' })),
    ...result.disabled.map(c => ({ label: `${c}: disabled`, color: 'bg-gray-700/40 text-gray-500 border-gray-600/40' })),
  ];
  if (pills.length === 0) return <span className="text-xs text-gray-500 font-mono">No channels configured.</span>;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {pills.map(p => (
        <span key={p.label} className={`text-[11px] font-mono px-2 py-0.5 rounded border ${p.color}`}>{p.label}</span>
      ))}
    </div>
  );
}

function TestAlertPanel() {
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState<TestResult | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  const send = async () => {
    setLoading(true); setResult(null); setError(null);
    try {
      const res = await apiFetch('/api/v1/test-alert', { method: 'POST', body: '{}' });
      if (res.ok) setResult(await res.json());
      else { const b = await res.json().catch(() => ({})) as { error?: string }; setError(b.error ?? 'Failed'); }
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div className="card p-4 space-y-3">
      <p className="text-xs text-gray-500 font-mono leading-relaxed">
        Sends a test <span className="text-gray-400">info</span>-severity alert through every enabled notification channel.
      </p>
      <button onClick={send} disabled={loading}
        className="text-xs font-mono bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 text-cyan-400 border border-cyan-500/30 rounded-lg px-4 py-1.5 transition-colors flex items-center gap-2">
        {loading && <span className="w-3 h-3 rounded-full border border-cyan-500 border-t-transparent animate-spin" />}
        Send Test Alert
      </button>
      {result && <ResultPills result={result} />}
      {error  && <p className="text-xs text-red-400 font-mono">{error}</p>}
    </div>
  );
}

// ── Wazuh panel ───────────────────────────────────────────────────────────────

interface UnmatchedAgent {
  name: string; status: string; os_name: string | null; last_keep_alive: string | null;
}

function WazuhPanel() {
  const [status,     setStatus]     = useState<WazuhStatus | null>(null);
  const [testing,    setTesting]    = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; agentCount?: number; error?: string } | null>(null);
  const [unmatched,  setUnmatched]  = useState<UnmatchedAgent[]>([]);

  useEffect(() => {
    apiFetch('/api/v1/wazuh/status').then(r => r.ok ? r.json() : null).then(d => setStatus(d)).catch(() => {});
    apiFetch('/api/v1/wazuh/unmatched').then(r => r.ok ? r.json() : []).then(d => setUnmatched(d)).catch(() => {});
  }, []);

  const runTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await apiFetch('/api/v1/wazuh/test-connection', { method: 'POST', body: '{}' });
      setTestResult(await res.json());
    } catch (e) { setTestResult({ ok: false, error: (e as Error).message }); }
    finally { setTesting(false); }
  };

  if (!status?.enabled) {
    return (
      <div className="card p-4 text-xs font-mono text-gray-500">
        Wazuh integration is disabled. Set <code className="text-gray-400">wazuh.enabled: true</code> in fenris.yaml to activate.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
          <span className="text-gray-500">Connection</span>
          <span className={status.last_poll_ok ? 'text-emerald-400' : 'text-red-400'}>
            {status.last_poll_ok ? 'Connected' : 'Unreachable'}
          </span>
          <span className="text-gray-500">Manager URL</span>
          <span className="text-gray-300 truncate">{status.manager_url ?? '—'}</span>
          <span className="text-gray-500">Last Poll</span>
          <span className="text-gray-300">{status.last_poll_at ? fmtRelativeTime(status.last_poll_at) : '—'}</span>
          <span className="text-gray-500">Agents</span>
          <span className="text-gray-300">{status.total}</span>
          {status.last_poll_error && (
            <><span className="text-gray-500">Error</span><span className="text-red-400 text-[10px]">{status.last_poll_error}</span></>
          )}
        </div>
        <button onClick={runTest} disabled={testing}
          className="text-xs font-mono bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-50 text-violet-400 border border-violet-500/30 rounded-lg px-4 py-1.5 transition-colors flex items-center gap-2">
          {testing && <span className="w-3 h-3 rounded-full border border-violet-400 border-t-transparent animate-spin" />}
          Test Connection
        </button>
        {testResult && (
          <p className={`text-xs font-mono ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {testResult.ok ? `Connected — ${testResult.agentCount} agent(s) reachable` : `Failed: ${testResult.error}`}
          </p>
        )}
      </div>

      {/* Unmatched Wazuh agents */}
      {unmatched.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-widest text-gray-600 mb-2">
            Unmatched Agents ({unmatched.length})
          </p>
          <div className="card overflow-hidden">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-gray-800/60 text-[10px] text-gray-600">
                  <th className="px-3 py-2 text-left">Agent name</th>
                  <th className="px-3 py-2 text-left hidden sm:table-cell">Status</th>
                  <th className="px-3 py-2 text-left hidden md:table-cell">OS</th>
                  <th className="px-3 py-2 text-left hidden lg:table-cell">Last keepalive</th>
                </tr>
              </thead>
              <tbody>
                {unmatched.map(a => (
                  <tr key={a.name} className="border-b border-gray-800/40 last:border-0">
                    <td className="px-3 py-2 text-gray-300">{a.name}</td>
                    <td className="px-3 py-2 hidden sm:table-cell">
                      <span className={`text-[10px] px-1 py-0.5 rounded border ${
                        a.status === 'active'
                          ? 'text-emerald-400 border-emerald-800/40'
                          : 'text-red-400 border-red-800/40'
                      }`}>{a.status}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-500 hidden md:table-cell">{a.os_name ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-600 hidden lg:table-cell">
                      {a.last_keep_alive ? fmtRelativeTime(a.last_keep_alive) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-gray-600 font-mono mt-1">
            These Wazuh agents have no matching Fenris server. Go to a server's detail page → Security to set an alias.
          </p>
        </div>
      )}
    </div>
  );
}

// ── CrowdSec panel ─────────────────────────────────────────────────────────────

function CrowdSecSettingsPanel() {
  const [status,     setStatus]     = useState<CrowdSecStatus | null>(null);
  const [testingIdx, setTestingIdx] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; decision_count?: number; error?: string }>>({});

  useEffect(() => {
    apiFetch('/api/v1/crowdsec/status').then(r => r.ok ? r.json() : null).then(d => setStatus(d)).catch(() => {});
  }, []);

  const runTest = async (idx: number, name: string) => {
    setTestingIdx(idx);
    try {
      const res = await apiFetch('/api/v1/crowdsec/test-connection', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [idx]: data }));
    } catch (e) {
      setTestResults(prev => ({ ...prev, [idx]: { ok: false, error: (e as Error).message } }));
    } finally {
      setTestingIdx(null);
    }
  };

  if (!status?.enabled) {
    return (
      <div className="card p-4 text-xs font-mono text-gray-500">
        CrowdSec integration is disabled. Set <code className="text-gray-400">crowdsec.enabled: true</code> in fenris.yaml to activate.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {status.instances.map((inst, idx) => {
        const tr = testResults[idx];
        return (
          <div key={inst.name} className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-semibold text-gray-300">{inst.name}</span>
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                inst.last_poll_ok
                  ? 'text-emerald-400 border-emerald-800/40 bg-emerald-900/10'
                  : 'text-red-400 border-red-800/40 bg-red-900/10'
              }`}>
                {inst.last_poll_ok ? 'connected' : 'error'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
              <span className="text-gray-500">Last poll</span>
              <span className="text-gray-300">{inst.last_poll_at ? fmtRelativeTime(inst.last_poll_at) : '—'}</span>
              {inst.server_id && (
                <><span className="text-gray-500">Server ID</span><span className="text-gray-300">{inst.server_id}</span></>
              )}
              {inst.last_poll_error && (
                <><span className="text-gray-500">Error</span><span className="text-red-400 text-[10px]">{inst.last_poll_error}</span></>
              )}
            </div>
            <div className="flex gap-2 items-center">
              <button onClick={() => runTest(idx, inst.name)} disabled={testingIdx === idx}
                className="text-xs font-mono bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 text-cyan-400 border border-cyan-500/30 rounded-lg px-3 py-1 transition-colors flex items-center gap-2">
                {testingIdx === idx && <span className="w-3 h-3 rounded-full border border-cyan-400 border-t-transparent animate-spin" />}
                Test Connection
              </button>
              {tr && (
                <span className={`text-xs font-mono ${tr.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  {tr.ok ? `OK — ${tr.decision_count} decision(s)` : `Failed: ${tr.error}`}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SettingsPage({ config }: SettingsPageProps) {
  const { user } = useAuth();
  const isAdmin = hasRole(user, 'admin');

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <h1 className="text-sm font-semibold text-white">Settings</h1>

      <Section title="Account">
        <AccountSection />
      </Section>

      {isAdmin && (
        <Section title="User Management">
          <UserManagement />
        </Section>
      )}

      {isAdmin && (
        <Section title="Audit Log">
          <AuditLogSection />
        </Section>
      )}

      <Section title="Alert Channels">
        <TestAlertPanel />
      </Section>

      <Section title="Wazuh Integration">
        <WazuhPanel />
      </Section>

      <Section title="CrowdSec Integration">
        <CrowdSecSettingsPanel />
      </Section>

      <Section title="Server Configuration">
        {config === null ? (
          <div className="card p-4 animate-pulse">
            <div className="h-3 w-48 bg-gray-800 rounded mb-2" />
            <div className="h-3 w-full bg-gray-800 rounded mb-2" />
            <div className="h-3 w-3/4 bg-gray-800 rounded" />
          </div>
        ) : (
          <JsonBlock data={config} />
        )}
      </Section>

      <Section title="About">
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-gray-500">Version</span>
            <span className="text-gray-300">0.2.0</span>
          </div>
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-gray-500">API endpoint</span>
            <span className="text-gray-300">{window.location.origin}/api/v1</span>
          </div>
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-gray-500">Refresh interval</span>
            <span className="text-gray-300">30 seconds</span>
          </div>
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-gray-500">Auth</span>
            <span className="text-gray-300">JWT · 24h sessions</span>
          </div>
        </div>
      </Section>
    </div>
  );
}
