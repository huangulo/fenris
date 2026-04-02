import React, { useState } from 'react';
import { apiFetch } from '../api';

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

// ── Test alert result pill ────────────────────────────────────────────────────

interface TestResult {
  sent:     string[];
  failed:   string[];
  disabled: string[];
}

function ResultPills({ result }: { result: TestResult }) {
  const pills: Array<{ label: string; color: string }> = [
    ...result.sent    .map(c => ({ label: `${c}: sent`,     color: 'bg-emerald-500/15 text-emerald-400 border-emerald-700/40' })),
    ...result.failed  .map(c => ({ label: `${c}: failed`,   color: 'bg-red-500/15 text-red-400 border-red-700/40' })),
    ...result.disabled.map(c => ({ label: `${c}: disabled`, color: 'bg-gray-700/40 text-gray-500 border-gray-600/40' })),
  ];

  if (pills.length === 0) {
    return <span className="text-xs text-gray-500 font-mono">No channels configured.</span>;
  }

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {pills.map(p => (
        <span key={p.label} className={`text-[11px] font-mono px-2 py-0.5 rounded border ${p.color}`}>
          {p.label}
        </span>
      ))}
    </div>
  );
}

// ── Test alert panel ──────────────────────────────────────────────────────────

function TestAlertPanel() {
  const [loading, setLoading]   = useState(false);
  const [result,  setResult]    = useState<TestResult | null>(null);
  const [error,   setError]     = useState<string | null>(null);

  const send = async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await apiFetch('/api/v1/test-alert', { method: 'POST', body: '{}' });
      if (res.ok) {
        setResult(await res.json());
      } else {
        const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        setError(body.error ?? 'Request failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card p-4 space-y-3">
      <p className="text-xs text-gray-500 font-mono leading-relaxed">
        Sends a test <span className="text-gray-400">info</span>-severity alert through every
        enabled notification channel. Useful for verifying webhook URLs and SMTP settings
        without creating real alert noise.
      </p>
      <button
        onClick={send}
        disabled={loading}
        className="text-xs font-mono bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 text-cyan-400 border border-cyan-500/30 rounded-lg px-4 py-1.5 transition-colors flex items-center gap-2"
      >
        {loading && (
          <span className="w-3 h-3 rounded-full border border-cyan-500 border-t-transparent animate-spin" />
        )}
        Send Test Alert
      </button>
      {result  && <ResultPills result={result} />}
      {error   && <p className="text-xs text-red-400 font-mono">{error}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SettingsPage({ config }: SettingsPageProps) {
  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <h1 className="text-sm font-semibold text-white">Settings</h1>

      {/* Alert channel test */}
      <Section title="Alert Channels">
        <TestAlertPanel />
      </Section>

      {/* Server config */}
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

      {/* Info section */}
      <Section title="About">
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-gray-500">Version</span>
            <span className="text-gray-300">0.1.0</span>
          </div>
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-gray-500">API endpoint</span>
            <span className="text-gray-300">{window.location.origin}/api/v1</span>
          </div>
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-gray-500">Refresh interval</span>
            <span className="text-gray-300">30 seconds</span>
          </div>
        </div>
      </Section>

      {/* Links */}
      <Section title="Resources">
        <div className="card p-4 space-y-2 text-xs font-mono">
          <p className="text-gray-600">
            Fenris is an open-source server monitoring system. Edit <code className="text-gray-400">fenris.yaml</code> to configure alert thresholds, anomaly detection, and notification channels.
          </p>
        </div>
      </Section>
    </div>
  );
}
