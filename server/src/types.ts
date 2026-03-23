export interface Metric {
  id: number;
  server_id: number;
  metric_type: 'cpu' | 'memory' | 'disk' | 'network';
  value: {
    cpu?: { usage_percent: number; load_avg: [number, number, number] };
    memory?: { used_percent: number; used_mb: number; total_mb: number };
    disk?: { path: string; used_percent: number; used_gb: number; total_gb: number };
    network?: { rx_bytes: number; tx_bytes: number; interface: string };
  };
  timestamp: Date;
}

export interface Alert {
  id: number;
  server_id: number;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metric_type?: 'cpu' | 'memory' | 'disk' | 'network';
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
  };
  retention?: {
    metrics_days: number;
    alerts_days: number;
  };
}
