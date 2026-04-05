-- Database schema for Fenris
-- PostgreSQL 15+ compatible

-- Servers table: Stores registered monitoring targets
CREATE TABLE IF NOT EXISTS servers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  api_key VARCHAR(64) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_heartbeat TIMESTAMP WITH TIME ZONE,
  UNIQUE (api_key, name)
);

-- Migration: replace individual unique constraints with composite (api_key, name)
DO $$ BEGIN
  ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_api_key_key;
  ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_name_key;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'servers_api_key_name_key'
  ) THEN
    ALTER TABLE servers ADD CONSTRAINT servers_api_key_name_key UNIQUE (api_key, name);
  END IF;
END $$;

-- Metrics table: Time-series metrics data
CREATE TABLE IF NOT EXISTS metrics (
  id SERIAL PRIMARY KEY,
  server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  metric_type VARCHAR(50) NOT NULL,
  value JSONB NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for efficient time-series queries
CREATE INDEX IF NOT EXISTS idx_metrics_server_id ON metrics(server_id);
CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_server_timestamp ON metrics(server_id, timestamp DESC);

-- Alerts table: Generated alerts
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message TEXT NOT NULL,
  metric_type VARCHAR(50),
  threshold_value JSONB,
  actual_value JSONB,
  acknowledged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Partial GIN index for efficient per-container history queries
CREATE INDEX IF NOT EXISTS idx_metrics_docker_containers
  ON metrics USING GIN ((value->'docker'))
  WHERE metric_type = 'docker';

-- Index for alert queries
CREATE INDEX IF NOT EXISTS idx_alerts_server_id ON alerts(server_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged);
CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(created_at DESC);

-- Default local server (id=1, matches hardcoded server_id in collector)
INSERT INTO servers (id, name, ip_address, api_key)
VALUES (1, 'local', '127.0.0.1', 'local-default-key')
ON CONFLICT DO NOTHING;

-- AI Incident Summaries
CREATE TABLE IF NOT EXISTS alert_summaries (
  id         SERIAL PRIMARY KEY,
  server_id  INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  alert_ids  INTEGER[] NOT NULL,
  summary    TEXT NOT NULL,
  model      VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_summaries_server_id   ON alert_summaries(server_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created_at  ON alert_summaries(created_at DESC);

-- Link alerts back to the summary that covers them (nullable — most alerts have none)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'alerts' AND column_name = 'summary_id'
  ) THEN
    ALTER TABLE alerts ADD COLUMN summary_id INTEGER REFERENCES alert_summaries(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Uptime Monitors ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS monitors (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  url              TEXT NOT NULL,
  method           VARCHAR(10)  DEFAULT 'GET',
  interval_seconds INTEGER      DEFAULT 60,
  timeout_seconds  INTEGER      DEFAULT 10,
  expected_status  INTEGER      DEFAULT 200,
  headers          JSONB        DEFAULT '{}',
  enabled          BOOLEAN      DEFAULT TRUE,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monitor_checks (
  id               SERIAL PRIMARY KEY,
  monitor_id       INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  status_code      INTEGER,
  response_time_ms INTEGER,
  is_up            BOOLEAN NOT NULL,
  error            TEXT,
  cert_expires_at  TIMESTAMP WITH TIME ZONE,
  checked_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitor_checks_monitor_ts ON monitor_checks (monitor_id, checked_at DESC);

-- Trigger for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_heartbeat = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
