import React, { useState, useEffect, useCallback } from 'react';
import { View, ServerRow, MetricRow, AlertRow, DockerSnapshot, SummaryRow } from './types';
import { apiFetch } from './api';
import { useAuth } from './auth';
import { LoginPage } from './pages/LoginPage';
import { Sidebar } from './layout/Sidebar';
import { TopBar } from './layout/TopBar';
import { OverviewPage } from './pages/OverviewPage';
import { ServerDetailPage } from './pages/ServerDetailPage';
import { AlertsPage } from './pages/AlertsPage';
import { ContainersPage } from './pages/ContainersPage';
import { SettingsPage } from './pages/SettingsPage';
import { UptimePage } from './pages/UptimePage';
import { WazuhPage } from './pages/WazuhPage';
import { CrowdSecPage } from './pages/CrowdSecPage';
import { IncidentsPage } from './pages/IncidentsPage';

const REFRESH_MS = 30_000;

export default function App() {
  const { user, loading: authLoading } = useAuth();

  // Show loading spinner while validating stored JWT
  if (authLoading) {
    return (
      <div className="h-screen w-screen bg-page flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  // Not logged in — show login page
  if (!user) return <LoginPage />;

  return <Dashboard />;
}

function Dashboard() {
  // ── Navigation ──────────────────────────────────────────────────────────────
  const [view, setView]                     = useState<View>('overview');
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ── Data ────────────────────────────────────────────────────────────────────
  const [servers,       setServers]       = useState<ServerRow[]>([]);
  const [allMetrics,    setAllMetrics]    = useState<MetricRow[]>([]);
  const [serverMetrics, setServerMetrics] = useState<MetricRow[]>([]);
  const [alerts,        setAlerts]        = useState<AlertRow[]>([]);
  const [docker,        setDocker]        = useState<DockerSnapshot>({ containers: [], timestamp: null });
  const [serverDocker,  setServerDocker]  = useState<DockerSnapshot>({ containers: [], timestamp: null });
  const [serverConfig,  setServerConfig]  = useState<Record<string, unknown> | null>(null);
  const [summaries,     setSummaries]     = useState<SummaryRow[]>([]);
  const [wazuhEnabled,    setWazuhEnabled]    = useState(false);
  const [crowdSecEnabled, setCrowdSecEnabled] = useState(false);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [loading,      setLoading]      = useState(true);
  const [clock,        setClock]        = useState(new Date());
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null);

  // 1-second clock tick
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Fetchers ─────────────────────────────────────────────────────────────────
  const fetchServers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/servers');
      if (res.ok) setServers(await res.json());
    } catch { /* silent */ }
  }, []);

  const fetchAllMetrics = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/metrics?limit=400');
      if (res.ok) setAllMetrics(await res.json());
    } catch { /* silent */ }
  }, []);

  const fetchServerMetrics = useCallback(async (id: number) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${id}/metrics?limit=120`);
      if (res.ok) setServerMetrics(await res.json());
    } catch { /* silent */ }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/alerts?limit=100');
      if (res.ok) setAlerts(await res.json());
    } catch { /* silent */ }
  }, []);

  const fetchDocker = useCallback(async (serverId: number | null) => {
    try {
      const url = serverId != null
        ? `/api/v1/docker/containers?server_id=${serverId}`
        : '/api/v1/docker/containers';
      const res = await apiFetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (serverId != null) {
        setServerDocker(data);
      } else {
        setDocker(data);
      }
    } catch { /* silent */ }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/config');
      if (res.ok) setServerConfig(await res.json());
    } catch { /* silent */ }
  }, []);

  const checkWazuhEnabled = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/wazuh/status');
      if (res.ok) {
        const data = await res.json() as { enabled?: boolean };
        setWazuhEnabled(data.enabled ?? false);
      }
    } catch { /* silent */ }
  }, []);

  const checkCrowdSecEnabled = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/crowdsec/status');
      if (res.ok) {
        const data = await res.json() as { enabled?: boolean };
        setCrowdSecEnabled(data.enabled ?? false);
      }
    } catch { /* silent */ }
  }, []);

  const fetchSummaries = useCallback(async (serverId?: number) => {
    try {
      const url = serverId != null
        ? `/api/v1/summaries?server_id=${serverId}&limit=5`
        : '/api/v1/summaries?limit=10';
      const res = await apiFetch(url);
      if (res.ok) setSummaries(await res.json());
    } catch { /* silent */ }
  }, []);

  // ── Refresh orchestration ────────────────────────────────────────────────────
  const refreshAll = useCallback(async () => {
    await Promise.all([
      fetchServers(),
      fetchAllMetrics(),
      fetchAlerts(),
      fetchDocker(null),
      fetchSummaries(),
    ]);
    setLastRefresh(new Date());
    setLoading(false);
  }, [fetchServers, fetchAllMetrics, fetchAlerts, fetchDocker, fetchSummaries]);

  const refreshForServer = useCallback(async (id: number) => {
    await Promise.all([
      fetchServerMetrics(id),
      fetchDocker(id),
      fetchAlerts(),
      fetchSummaries(id),
    ]);
    setLastRefresh(new Date());
  }, [fetchServerMetrics, fetchDocker, fetchAlerts, fetchSummaries]);

  // Initial load + 30s poll
  useEffect(() => {
    refreshAll();
    checkWazuhEnabled();
    checkCrowdSecEnabled();
    const t = setInterval(refreshAll, REFRESH_MS);
    return () => clearInterval(t);
  }, [refreshAll, checkWazuhEnabled, checkCrowdSecEnabled]);

  // When a server is selected (server detail view), fetch its specific data
  useEffect(() => {
    if (selectedServerId != null) {
      refreshForServer(selectedServerId);
      const t = setInterval(() => refreshForServer(selectedServerId), REFRESH_MS);
      return () => clearInterval(t);
    }
  }, [selectedServerId, refreshForServer]);

  // Settings page: fetch config once on demand
  useEffect(() => {
    if (view === 'settings' && serverConfig === null) fetchConfig();
  }, [view, serverConfig, fetchConfig]);

  // ── Actions ──────────────────────────────────────────────────────────────────
  const acknowledgeAlert = useCallback(async (id: number) => {
    try {
      await apiFetch(`/api/v1/alerts/${id}/acknowledge`, { method: 'POST' });
      setAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged: true } : a));
    } catch { /* silent */ }
  }, []);

  const acknowledgeMany = useCallback(async (ids: number[]) => {
    await Promise.all(ids.map(id => apiFetch(`/api/v1/alerts/${id}/acknowledge`, { method: 'POST' })));
    setAlerts(prev => prev.map(a => ids.includes(a.id) ? { ...a, acknowledged: true } : a));
  }, []);

  // ── Navigation helpers ───────────────────────────────────────────────────────
  const navigateTo = useCallback((v: View, serverId?: number) => {
    setView(v);
    if (serverId !== undefined) setSelectedServerId(serverId);
    else if (v === 'overview') setSelectedServerId(null);
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const activeAlerts = alerts.filter(a => !a.acknowledged).length;
  const selectedServer = servers.find(s => s.id === selectedServerId) ?? null;
  // Incident counts come from the IncidentsPage itself via its own fetch;
  // pass activeAlerts as fallback badge for the sidebar until we have a global count.
  const [activeIncidentCount, setActiveIncidentCount] = useState(0);

  // ── Loading screen ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="h-screen w-screen bg-page flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
          <span className="font-mono text-xs text-gray-500">connecting…</span>
        </div>
      </div>
    );
  }

  // ── Page content ─────────────────────────────────────────────────────────────
  const renderPage = () => {
    switch (view) {
      case 'incidents':
        return (
          <IncidentsPage
            servers={servers}
            onActiveCountChange={setActiveIncidentCount}
          />
        );
      case 'overview':
        return (
          <OverviewPage
            servers={servers}
            allMetrics={allMetrics}
            alerts={alerts}
            docker={docker}
            onSelectServer={(id) => navigateTo('server', id)}
            incidentsNew={activeIncidentCount}
          />
        );
      case 'server':
        return (
          <ServerDetailPage
            server={selectedServer}
            servers={servers}
            metrics={serverMetrics}
            docker={serverDocker}
            alerts={alerts}
            summaries={summaries.filter(s => s.server_id === selectedServerId)}
            onBack={() => navigateTo('overview')}
            onSelectServer={(id) => { setSelectedServerId(id); }}
            onNavigate={(v) => navigateTo(v as any)}
            crowdSecEnabled={crowdSecEnabled}
          />
        );
      case 'alerts':
        return (
          <AlertsPage
            alerts={alerts}
            servers={servers}
            summaries={summaries}
            onAcknowledge={acknowledgeAlert}
            onAcknowledgeMany={acknowledgeMany}
          />
        );
      case 'containers':
        return (
          <ContainersPage
            docker={selectedServerId != null ? serverDocker : docker}
            servers={servers}
            selectedServerId={selectedServerId}
            onSelectServer={setSelectedServerId}
          />
        );
      case 'uptime':
        return <UptimePage />;
      case 'wazuh':
        return <WazuhPage />;
      case 'crowdsec':
        return <CrowdSecPage />;
      case 'settings':
        return <SettingsPage config={serverConfig} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-page">
      <Sidebar
        view={view}
        onNavigate={navigateTo}
        activeAlerts={activeAlerts}
        activeIncidents={activeIncidentCount}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        wazuhEnabled={wazuhEnabled}
        crowdSecEnabled={crowdSecEnabled}
      />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar
          servers={servers}
          selectedServerId={selectedServerId}
          onSelectServer={(id) => {
            setSelectedServerId(id);
            if (id != null && view !== 'server') navigateTo('server', id);
          }}
          clock={clock}
          lastRefresh={lastRefresh}
        />

        <main className="flex-1 overflow-y-auto overflow-x-hidden pb-16 md:pb-0">
          <div className="animate-fade-in">
            {renderPage()}
          </div>
        </main>
      </div>
    </div>
  );
}
