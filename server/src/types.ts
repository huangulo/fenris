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
  id: number;
  server_id: number;
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

export interface Alert {
  id: number;
  server_id: number;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metric_type?: 'cpu' | 'memory' | 'disk' | 'network' | 'docker';
  threshold_value?: Record<string, number>;
  actual_value?: Record<string, number>;
  acknowledged: boolean;
  created_at: Date;
}

export interface Server {
  id: number;
  name: string;
  ip_address: string;
  api_key: string;
  created_at: Date;
  last_heartbeat?: Date;
}

export interface AnomalyDetectionResult {
  isAnomaly: boolean;
  zScore: number;
  mean: number;
  stdDev: number;
  threshold: number;
}

export interface Config {
  server: {
    port: number;
    database_url: string;
  };
  monitors: {
    system: {
      enabled: boolean;
      scrape_interval: string;
      metrics: string[];
    };
    disk: {
      paths: Array<{
        path: string;
        name: string;
        warning_threshold: number;
        critical_threshold: number;
      }>;
    };
  };
  alerts: {
    discord: {
      enabled: boolean;
      webhook_url: string;
      severity_levels: string[];
    };
    slack?: {
      enabled: boolean;
      webhook_url: string;
      severity_levels: string[];
    };
    email?: {
      enabled: boolean;
      smtp_host: string;
      smtp_port: number;
      smtp_secure: boolean;
      username: string;
      password: string;
      from: string;
      to: string[];
      severity_levels: string[];
    };
    thresholds: {
      cpu: { warning: number; critical: number };
      memory: { warning: number; critical: number };
      disk: { warning: number; critical: number };
      network: { anomaly_threshold: number };
    };
  };
  anomaly_detection: {
    enabled: boolean;
    algorithm: string;
    zscore_threshold: number;
    window_size: number;
    min_samples: number;
    /** Minimum absolute value below which Z-score detection is skipped entirely. */
    floors?: {
      cpu:           number;  // default 50
      memory:        number;  // default 60
      disk:          number;  // default 70
      docker_cpu:    number;  // default 30
      docker_memory: number;  // default 40
    };
  };
  retention?: {
    metrics_days: number;
    alerts_days: number;
  };
  predictions?: {
    enabled: boolean;
    interval: string;         // "5m", "1h", etc.
    disk_horizon_days: number;
    cpu_horizon_hours: number;
    memory_horizon_hours: number;
    disk_threshold: number;
    cpu_threshold: number;
    memory_threshold: number;
    min_samples: number;
    min_confidence: number;   // R² floor, 0–1
  };
  ai?: {
    enabled: boolean;
    provider: string;
    api_url: string;
    api_key: string;
    model: string;
    max_calls_per_hour: number;
    batch_window_ms: number;   // how long to wait before summarising a batch
    cooldown_per_server_ms: number;
  };
  wazuh?: {
    enabled: boolean;
    manager_url: string;
    username: string;
    password: string;
    poll_interval: string;  // "60s"
    verify_ssl: boolean;
  };
}
