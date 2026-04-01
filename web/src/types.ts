export type View = 'overview' | 'server' | 'alerts' | 'containers' | 'settings';

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
}

export interface ServerRow {
  id: number;
  name: string;
  ip_address: string;
  last_heartbeat: string | null;
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
}

export interface AppData {
  servers:       ServerRow[];
  allMetrics:    MetricRow[];      // overview sparklines (all servers, last N)
  serverMetrics: MetricRow[];      // server detail (selected server, last 120)
  alerts:        AlertRow[];
  docker:        DockerSnapshot;   // current selected / all
}
