export interface ContainerStats {
  name: string;
  image: string;
  state: 'running' | 'stopped' | 'restarting' | 'paused' | 'exited' | 'dead';
  cpu_percent: number;
  memory_mb: number;
  memory_percent: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
  uptime_seconds: number;
}

export interface Metric {
  metric_type: 'cpu' | 'memory' | 'disk' | 'network' | 'docker';
  value: {
    cpu?: { usage_percent: number; load_avg: [number, number, number] };
    memory?: { used_percent: number; total_gib: number; available_gib: number; used_gib: number };
    disk?: { path: string; used_percent: number; total_gb: number; used_gb: number; available_gb: number };
    network?: { rx_bytes: number; tx_bytes: number; interface: string };
    docker?: ContainerStats[];
  };
  timestamp: Date;
}

export interface AgentPayload {
  server_name: string;
  host_ip?: string;
  os_type?: string;
  metrics: Metric[];
}
