import React, { useState, FormEvent } from 'react';
import { useAuth } from '../auth';

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState<string | null>(null);
  const [busy, setBusy]         = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) { setError('Enter username and password'); return; }
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err: any) {
      setError(err?.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo / branding */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <div className="w-12 h-12 rounded-xl bg-cyan-500/15 border border-cyan-700/40 flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div className="text-center">
            <p className="font-mono font-bold text-lg tracking-[0.2em] text-white">FENRIS</p>
            <p className="text-xs text-gray-600 mt-0.5">Infrastructure Monitoring</p>
          </div>
        </div>

        {/* Card */}
        <div className="card p-6">
          <h1 className="text-sm font-semibold text-white mb-5">Sign in</h1>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-600 mb-1.5">
                Username
              </label>
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                disabled={busy}
                className="w-full bg-gray-900/60 border border-gray-800/60 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors font-mono"
                placeholder="admin"
              />
            </div>

            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-600 mb-1.5">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={busy}
                className="w-full bg-gray-900/60 border border-gray-800/60 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors font-mono"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full py-2 rounded-lg bg-cyan-600/80 hover:bg-cyan-600 border border-cyan-700/60 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {busy && (
                <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              )}
              Sign in
            </button>
          </form>
        </div>

        <p className="text-center text-[11px] text-gray-700 mt-4">
          Default credentials are printed to server logs on first startup.
        </p>
      </div>
    </div>
  );
}
