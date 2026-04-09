export type View = 'incidents' | 'overview' | 'server' | 'alerts' | 'containers' | 'uptime' | 'wazuh' | 'settings';

export interface MetricRow {
  id: number;
  server_id: number;
  metric_type: 'cpu' | 'memory' | 'disk' | 'network';
  value: {
    cpu?:     { usage_percent: number; load_avg: number[] };
    memory?:  { used_percent: number; total_gib: number; available_gib: number; used_gib: number };
    disk?:    { used_percent: number; total_gb: number; used_gb: number; available_gb: number };
    network?: { rx_bytes: number; tx_bytes: number; rx_sec?: number; tx_sec?: number; interface: string };
  };
  timestamp: string;
}

export interface AlertRow {
  id: number;
  server_id: number;
  server_name?: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metric_type?: string;
  acknowledged: boolean;
  created_at: string;
  summary_id?: number | null;
}

export interface SummaryRow {
  id: number;
  server_id: number;
  server_name?: string;
  alert_ids: number[];
  summary: string;
  model: string | null;
  created_at: string;
}

export interface ServerRow {
  id: number;
  name: string;
  ip_address: string;
  last_heartbeat: string | null;
  os_type?: string | null;
}

export interface ContainerStats {
  name: string;
  image: string;
  state: string;
  cpu_percent: number;
  memory_mb: number;
  memory_percent: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
  uptime_seconds: number;
}

export interface DockerSnapshot {
  containers: ContainerStats[];
  timestamp: string | null;
}

/** Per-server sparkline history for the overview cards. */
export interface ServerSparklines {
  cpu:  number[];
  mem:  number[];
  disk: number[];
}

export interface MonitorRow {
  id: number;
  name: string;
  url: string;
  method: string;
  interval_seconds: number;
  timeout_seconds: number;
  expected_status: number;
  headers: Record<string, string>;
  enabled: boolean;
  created_at: string;
  // computed from DB joins
  last_is_up: boolean | null;
  last_status_code: number | null;
  last_response_time_ms: number | null;
  last_error: string | null;
  last_cert_expires_at: string | null;
  last_checked_at: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  uptime_30d: number | null;
}

export interface MonitorCheck {
  id: number;
  monitor_id: number;
  status_code: number | null;
  response_time_ms: number | null;
  is_up: boolean;
  error: string | null;
  cert_expires_at: string | null;
  checked_at: string;
}

export interface AppData {
  servers:       ServerRow[];
  allMetrics:    MetricRow[];      // overview sparklines (all servers, last N)
  serverMetrics: MetricRow[];      // server detail (selected server, last 120)
  alerts:        AlertRow[];
  docker:        DockerSnapshot;   // current selected / all
}

export interface IncidentRow {
  id:             number;
  title:          string;
  server_id:      number | null;
  server_name:    string | null;
  severity:       'info' | 'warning' | 'critical';
  state:          'new' | 'investigating' | 'resolved';
  started_at:     string;
  resolved_at:    string | null;
  claimed_by:     string | null;
  claimed_at:     string | null;
  alert_count:    number;
  ai_summary_id:  number | null;
  ai_summary:     string | null;
  notes:          string | null;
  created_at:     string;
  updated_at:     string;
  recent_alerts?: AlertRow[];
  alerts?:        AlertRow[];
}

export interface WazuhAgentRow {
  id: number;
  wazuh_id: string;
  name: string;
  ip_address: string | null;
  status: 'active' | 'disconnected' | 'never_connected' | 'pending' | string;
  os_name: string | null;
  os_version: string | null;
  agent_version: string | null;
  last_keep_alive: string | null;
  group_name: string | null;
  first_seen: string;
  last_seen: string;
  last_status_change: string | null;
  recent_alerts?: WazuhAgentAlert[];
}

export interface WazuhAgentAlert {
  id: number;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  acknowledged: boolean;
  created_at: string;
}

export interface WazuhStatus {
  enabled: boolean;
  total: number;
  active: number;
  disconnected: number;
  never_connected: number;
  pending: number;
  last_poll_at: string | null;
  last_poll_ok: boolean;
  last_poll_error: string | null;
  manager_url: string | null;
}
