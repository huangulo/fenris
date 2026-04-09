import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api';
import { CrowdSecDecisionRow, CrowdSecStats } from '../types';
import { fmtRelativeTime } from '../utils';

// ── Country flag emoji ─────────────────────────────────────────────────────────

function countryFlag(cc: string | null): string {
  if (!cc || cc.length !== 2) return '';
  const offset = 127397;
  return String.fromCodePoint(...cc.toUpperCase().split('').map(c => c.charCodeAt(0) + offset));
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-4 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-gray-600">{label}</span>
      <span className="text-2xl font-mono font-bold text-white tabular-nums">{value}</span>
      {sub && <span className="text-[11px] font-mono text-gray-500">{sub}</span>}
    </div>
  );
}

// ── Decision table ─────────────────────────────────────────────────────────────

type Filter = 'all' | '24h' | '7d' | 'bans';

function actionBadge(action: string | null) {
  if (!action) return <span className="text-gray-600">—</span>;
  const color = action === 'ban'     ? 'text-red-400 border-red-800/40 bg-red-900/10'
              : action === 'captcha' ? 'text-yellow-400 border-yellow-800/40 bg-yellow-900/10'
              :                        'text-gray-400 border-gray-700/40 bg-gray-800/20';
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${color}`}>{action}</span>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function CrowdSecPage() {
  const [decisions, setDecisions] = useState<CrowdSecDecisionRow[]>([]);
  const [stats,     setStats]     = useState<CrowdSecStats | null>(null);
  const [filter,    setFilter]    = useState<Filter>('all');
  const [search,    setSearch]    = useState('');
  const [loading,   setLoading]   = useState(true);

  const load = useCallback(async () => {
    const [decRes, statRes] = await Promise.all([
      apiFetch('/api/v1/crowdsec/decisions?limit=200'),
      apiFetch('/api/v1/crowdsec/stats'),
    ]);
    if (decRes.ok)  setDecisions(await decRes.json());
    if (statRes.ok) setStats(await statRes.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Apply filters
  const now = Date.now();
  const filtered = decisions.filter(d => {
    if (filter === '24h' && new Date(d.created_at).getTime() < now - 86_400_000) return false;
    if (filter === '7d'  && new Date(d.created_at).getTime() < now - 7 * 86_400_000) return false;
    if (filter === 'bans' && d.action !== 'ban') return false;
    if (search) {
      const q = search.toLowerCase();
      if (!d.source_ip.toLowerCase().includes(q) && !(d.scenario ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <h1 className="text-sm font-semibold text-white">CrowdSec Decisions</h1>

      {/* Summary cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Decisions" value={stats.total_decisions} />
          <StatCard label="Bans Last 24h"   value={stats.bans_last_24h} />
          <StatCard
            label="Top Scenario"
            value={stats.top_scenarios[0]?.scenario?.split('/')[1] ?? '—'}
            sub={stats.top_scenarios[0]?.scenario ?? undefined}
          />
          <StatCard
            label="Top Country"
            value={`${countryFlag(stats.top_countries[0]?.source_country ?? null)} ${stats.top_countries[0]?.source_country ?? '—'}`}
            sub={stats.top_countries[0] ? `${stats.top_countries[0].count} decisions` : undefined}
          />
        </div>
      )}

      {/* Top lists */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card p-4 space-y-2">
            <h2 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">Top Attack Scenarios</h2>
            {stats.top_scenarios.length === 0 && <p className="text-xs text-gray-600 font-mono">No data</p>}
            {stats.top_scenarios.map((s, i) => (
              <div key={s.scenario} className="flex items-center gap-3 text-xs font-mono">
                <span className="text-gray-700 w-4 text-right">{i + 1}.</span>
                <span className="flex-1 text-gray-300 truncate">{s.scenario}</span>
                <span className="text-red-400 font-bold tabular-nums">{s.count}</span>
              </div>
            ))}
          </div>
          <div className="card p-4 space-y-2">
            <h2 className="text-[10px] uppercase tracking-widest text-gray-600 mb-3">Top Source Countries</h2>
            {stats.top_countries.length === 0 && <p className="text-xs text-gray-600 font-mono">No data</p>}
            {stats.top_countries.map((c, i) => (
              <div key={c.source_country} className="flex items-center gap-3 text-xs font-mono">
                <span className="text-gray-700 w-4 text-right">{i + 1}.</span>
                <span className="text-lg leading-none">{countryFlag(c.source_country)}</span>
                <span className="flex-1 text-gray-300">{c.source_country}</span>
                <span className="text-orange-400 font-bold tabular-nums">{c.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter + search */}
      <div className="flex flex-wrap gap-2 items-center">
        {(['all', '24h', '7d', 'bans'] as Filter[]).map(f => (
          <button key={f}
            onClick={() => setFilter(f)}
            className={`text-xs font-mono px-3 py-1 rounded-lg border transition-colors ${
              filter === f
                ? 'bg-cyan-500/15 text-cyan-400 border-cyan-700/40'
                : 'text-gray-500 border-gray-700/40 hover:text-gray-300 hover:border-gray-600'
            }`}>
            {f === 'all' ? 'All' : f === '24h' ? 'Last 24h' : f === '7d' ? 'Last 7d' : 'Active bans'}
          </button>
        ))}
        <input
          placeholder="Search IP or scenario…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="ml-auto w-56 bg-gray-900/60 border border-gray-800/60 rounded-lg px-3 py-1 text-xs text-gray-300 font-mono placeholder-gray-700 outline-none focus:border-gray-600"
        />
      </div>

      {/* Decision table */}
      {loading ? (
        <div className="card p-4 text-xs text-gray-600 font-mono animate-pulse">Loading…</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0 bg-[#0e1420]">
                <tr className="border-b border-gray-800/60 text-[10px] uppercase tracking-widest text-gray-600">
                  <th className="px-4 py-3 text-left">Time</th>
                  <th className="px-4 py-3 text-left">Server</th>
                  <th className="px-4 py-3 text-left">Source IP</th>
                  <th className="px-4 py-3 text-left hidden sm:table-cell">Country</th>
                  <th className="px-4 py-3 text-left hidden md:table-cell">Scenario</th>
                  <th className="px-4 py-3 text-left">Action</th>
                  <th className="px-4 py-3 text-left hidden lg:table-cell">Duration</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-600">No decisions match your filters.</td></tr>
                )}
                {filtered.map(d => (
                  <tr key={d.id} className="border-b border-gray-800/40 hover:bg-gray-800/20 transition-colors">
                    <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{fmtRelativeTime(d.created_at)}</td>
                    <td className="px-4 py-2.5 text-gray-400">{d.server_name ?? `#${d.server_id}`}</td>
                    <td className="px-4 py-2.5 text-orange-300 tabular-nums">{d.source_ip}</td>
                    <td className="px-4 py-2.5 hidden sm:table-cell">
                      {d.source_country
                        ? <span title={d.source_country}>{countryFlag(d.source_country)} {d.source_country}</span>
                        : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 max-w-[14rem] truncate hidden md:table-cell">
                      {d.scenario ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">{actionBadge(d.action)}</td>
                    <td className="px-4 py-2.5 text-gray-500 hidden lg:table-cell">{d.duration ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > 0 && (
            <div className="px-4 py-2 text-[10px] text-gray-700 font-mono border-t border-gray-800/40">
              {filtered.length} decision{filtered.length !== 1 ? 's' : ''} shown
            </div>
          )}
        </div>
      )}
    </div>
  );
}
