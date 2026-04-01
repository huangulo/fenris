import React from 'react';

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

export function SettingsPage({ config }: SettingsPageProps) {
  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <h1 className="text-sm font-semibold text-white">Settings</h1>

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
