# Fenris Project Reference Document

> Generated 2026-05-07. Intended as a living reference for ongoing development and troubleshooting by AI assistants and developers. Update when schema, routes, or background workers change.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Schema](#2-database-schema)
3. [API & Routes](#3-api--routes)
4. [Services & Workers](#4-services--workers)
5. [Docker / Infrastructure](#5-docker--infrastructure)
6. [Data Flow](#6-data-flow)
7. [Known Performance Concerns](#7-known-performance-concerns)
8. [Dependencies](#8-dependencies)
9. [Configuration](#9-configuration)
10. [Deployment](#10-deployment)

---

## 1. Architecture Overview

### Summary

Fenris is a self-hosted infrastructure monitoring platform. Remote agents push metrics to a central Fastify server, which stores them in PostgreSQL and serves a React SPA. The server also runs several background services: anomaly detection, predictive alerting, uptime checks, Wazuh/CrowdSec polling, AI summarization, and a daily digest.

### Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Server runtime | Node.js | 22 (LTS) |
| Server framework | Fastify | v5 |
| Server language | TypeScript | 5.5 |
| Database | PostgreSQL | 15 |
| DB client | `pg` (node-postgres) | 8.11 |
| Frontend framework | React | 18.3 |
| Frontend build | Vite | 5.3 |
| Frontend language | TypeScript | 5.5 |
| Frontend styling | Tailwind CSS | 3.4 |
| Frontend charts | Recharts | 2.12 |
| Linux agent | Node.js / TypeScript | 22 |
| Windows agent | Go | 1.22 |
| Reverse proxy | Nginx (Alpine) | latest |
| Containerization | Docker Compose | — |
| Package manager (server/web) | pnpm / npm | — |

### Repository Layout

```
fenris/                           # Monorepo root
├── server/                       # Fastify API server (Node.js/TypeScript)
│   ├── src/
│   │   ├── index.ts              # Entry point, startup, route registration
│   │   ├── db/
│   │   │   ├── client.ts         # pg.Pool wrapper (max 20 connections)
│   │   │   └── schema.sql        # Full DDL + idempotent migrations
│   │   ├── api/
│   │   │   ├── routes.ts         # Main route handlers (~1,900 lines)
│   │   │   ├── auth-routes.ts    # Login/logout/me/change-password
│   │   │   ├── users-routes.ts   # User CRUD + audit log
│   │   │   └── support-routes.ts # IT ticket CRUD + stats
│   │   ├── engine/
│   │   │   ├── anomaly.ts        # Z-score anomaly detection (in-memory)
│   │   │   ├── predictor.ts      # Linear regression predictions
│   │   │   ├── summarizer.ts     # AI alert summarization (OpenAI-compat)
│   │   │   ├── incidents.ts      # Alert→incident grouping logic
│   │   │   ├── digest.ts         # Daily email digest scheduler
│   │   │   └── wazuh-matcher.ts  # Wazuh agent ↔ Fenris server matching
│   │   ├── monitors/
│   │   │   ├── uptime.ts         # HTTP/HTTPS uptime checker
│   │   │   ├── wazuh.ts          # Wazuh SIEM polling
│   │   │   └── crowdsec.ts       # CrowdSec LAPI polling
│   │   ├── alerts/
│   │   │   ├── dispatcher.ts     # Fan-out to Discord/Slack/Email
│   │   │   ├── discord.ts
│   │   │   ├── slack.ts
│   │   │   ├── email.ts
│   │   │   └── util.ts           # Cooldown helpers
│   │   ├── auth/
│   │   │   └── index.ts          # JWT sign/verify, bcrypt, RBAC
│   │   ├── collectors/           # Local (server-side) collection (unused in prod)
│   │   └── types.ts              # Shared TypeScript interfaces
│   └── Dockerfile
│
├── agent/                        # Linux remote agent (Node.js/TypeScript)
│   ├── src/
│   │   ├── index.ts              # Main loop, buffer, backoff
│   │   ├── config.ts             # YAML + env loading
│   │   └── collectors/
│   │       ├── system.ts         # CPU/memory/disk/network via systeminformation
│   │       └── docker.ts         # Container stats via dockerode
│   └── Dockerfile
│
├── agent-windows/                # Windows remote agent (Go)
│   ├── main.go                   # Service install/uninstall/run commands
│   ├── collectors.go             # CPU/mem/disk/network via gopsutil
│   ├── config.go
│   └── go.mod
│
├── web/                          # React SPA dashboard
│   ├── src/
│   │   ├── main.tsx              # React 18 entry, AuthProvider
│   │   ├── App.tsx               # Router + layout (~340 lines)
│   │   ├── api.ts                # Typed fetch wrappers + JWT injection
│   │   ├── auth.tsx              # AuthContext + useAuth hook
│   │   ├── pages/                # One file per page/route
│   │   └── components/           # CircularGauge, HistoryChart, Sparkline, etc.
│   ├── nginx.conf                # SPA routing + /api/ proxy to server:3200
│   └── Dockerfile                # Multi-stage: Vite build → Nginx
│
├── agent-local/                  # Config override for the Docker Compose agent profile
├── docker-compose.yml            # Full-stack orchestration
├── .env.example                  # Env var template
├── fenris.yaml.example           # Server config template
├── fenris-agent.yaml.example     # Agent config template
├── install.sh                    # Full-stack one-liner installer
├── install-agent.sh              # Agent-only installer (Linux)
├── install-agent.ps1             # Agent installer (Windows, PowerShell)
└── .github/workflows/release.yml # Windows agent cross-compile + GitHub Release
```

### Component Communication

```
[Linux Agent]  ──POST /api/v1/metrics (X-API-Key)──►  [Fastify :3200]  ◄──►  [PostgreSQL :5432]
[Windows Agent]──POST /api/v1/metrics (X-API-Key)──►       │
                                                            │
[React SPA :8081] ──── GET/POST /api/v1/* (JWT) ──────────►│
         │                                                  │
    [Nginx :80]  ──── proxy_pass server:3200 ──────────────►│
                                                            │
                         Background workers:                │
                         ├── Predictor (5 min)              │
                         ├── UptimeMonitor (per-interval)   │
                         ├── WazuhMonitor (60s)             │
                         ├── CrowdSecMonitor (configurable) │
                         ├── Summarizer (event-driven)      │
                         ├── DailyDigest (08:00 UTC)        │
                         └── RetentionJob (hourly)          │
```

---

## 2. Database Schema

**File:** `server/src/db/schema.sql`

The schema is applied idempotently at every server startup via `initializeTables()`. It uses `CREATE TABLE IF NOT EXISTS` and `DO $$ BEGIN … END $$` blocks for additive column migrations.

**PostgreSQL connection pool:** `max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000`

---

### Table: `servers`

Stores registered monitoring targets. Auto-populated on first agent contact.

```sql
CREATE TABLE IF NOT EXISTS servers (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  ip_address     VARCHAR(45)  NOT NULL,
  api_key        VARCHAR(64)  NOT NULL,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_heartbeat TIMESTAMP WITH TIME ZONE,
  os_type        VARCHAR(32),              -- added via migration
  wazuh_agent_name VARCHAR(100),           -- added via migration
  UNIQUE (api_key, name)
);
```

**Indexes:** `UNIQUE (api_key, name)` (implicit B-tree).

**⚠ Missing index:** `last_heartbeat` — used in `listServers` (`ORDER BY last_heartbeat DESC NULLS LAST`) and in `getStatus` (`WHERE last_heartbeat > NOW() - INTERVAL '90 seconds'`). On large installs an index on `last_heartbeat` would benefit these queries.

**Seed row:**
```sql
INSERT INTO servers (id, name, ip_address, api_key)
VALUES (1, 'local', '127.0.0.1', 'local-default-key')
ON CONFLICT DO NOTHING;
```

---

### Table: `metrics`

Core time-series table. Grows continuously; controlled by the retention job.

```sql
CREATE TABLE IF NOT EXISTS metrics (
  id          SERIAL PRIMARY KEY,
  server_id   INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  metric_type VARCHAR(50) NOT NULL,
  value       JSONB NOT NULL,
  timestamp   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

**Indexes:**
```sql
CREATE INDEX IF NOT EXISTS idx_metrics_server_id        ON metrics(server_id);
CREATE INDEX IF NOT EXISTS idx_metrics_type             ON metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp        ON metrics(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_server_timestamp ON metrics(server_id, timestamp DESC);

-- Partial GIN index for LATERAL jsonb_array_elements queries on docker metrics
CREATE INDEX IF NOT EXISTS idx_metrics_docker_containers
  ON metrics USING GIN ((value->'docker'))
  WHERE metric_type = 'docker';
```

**Value shapes by `metric_type`:**

| metric_type | value JSON shape |
|---|---|
| `cpu` | `{ "cpu": { "usage_percent": 12.3, "load_avg_1": 0.5, "load_avg_5": 0.4, "load_avg_15": 0.3 } }` |
| `memory` | `{ "memory": { "used_percent": 45.2, "used_gib": 3.6, "total_gib": 8.0, "available_gib": 4.4 } }` |
| `disk` | `{ "disk": { "path": "/", "name": "root", "used_percent": 62.1, "used_gb": 74.5, "total_gb": 120.0, "free_gb": 45.5 } }` |
| `network` | `{ "network": { "interface": "eth0", "rx_bytes": 12345, "tx_bytes": 6789 } }` |
| `docker` | `{ "docker": [ { "name": "nginx", "state": "running", "cpu_percent": 0.2, "memory_mb": 45.1, "memory_percent": 0.5, "net_rx_bytes": 1024, "net_tx_bytes": 512, "image": "nginx:alpine", "image_hash": "sha256:abc...", "started_at": "2026-01-01T00:00:00Z" }, … ] }` |

**Growth rate (default config, 1 server):**

- CPU + memory + disk (×3 paths) + network (×N interfaces) + docker = ~7–10 rows per 30s tick
- ≈ 20,000–30,000 rows/day per server
- Retention: 30 days → steady-state ~600,000–900,000 rows per server

---

### Table: `alerts`

```sql
CREATE TABLE IF NOT EXISTS alerts (
  id              SERIAL PRIMARY KEY,
  server_id       INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  severity        VARCHAR(20) NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message         TEXT NOT NULL,
  metric_type     VARCHAR(50),
  threshold_value JSONB,
  actual_value    JSONB,
  acknowledged    BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  summary_id      INTEGER REFERENCES alert_summaries(id) ON DELETE SET NULL,  -- added via migration
  incident_id     INTEGER REFERENCES incidents(id) ON DELETE SET NULL          -- added via migration
);
```

**Indexes:**
```sql
CREATE INDEX IF NOT EXISTS idx_alerts_server_id   ON alerts(server_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity    ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged);
CREATE INDEX IF NOT EXISTS idx_alerts_timestamp   ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_incident_id ON alerts(incident_id);
```

**⚠ Missing composite index:** Queries like `WHERE server_id = $1 AND acknowledged = FALSE` (used in `getServerStatus`) cannot use a single index efficiently. A composite `(server_id, acknowledged)` or `(server_id, created_at DESC)` index would help.

---

### Table: `alert_summaries`

AI-generated narrative summaries, one per batch of alerts per server.

```sql
CREATE TABLE IF NOT EXISTS alert_summaries (
  id         SERIAL PRIMARY KEY,
  server_id  INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  alert_ids  INTEGER[] NOT NULL,
  summary    TEXT NOT NULL,
  model      VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_summaries_server_id  ON alert_summaries(server_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created_at ON alert_summaries(created_at DESC);
```

---

### Table: `monitors`

Uptime monitor configurations.

```sql
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
```

---

### Table: `monitor_checks`

Results of uptime checks. Grows at `interval_seconds` per monitor. Retention: 90 days (hardcoded).

```sql
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
CREATE INDEX IF NOT EXISTS idx_monitor_checks_monitor_ts ON monitor_checks(monitor_id, checked_at DESC);
```

**⚠ Performance note:** `listMonitors` executes three LATERAL subqueries per monitor for 24h/7d/30d uptime percentages. Each subquery does a range scan on `monitor_checks`. With many monitors or long history this can be slow. The index `(monitor_id, checked_at DESC)` covers it but the query still runs 3N range scans.

---

### Table: `incidents`

Groups of related alerts with state machine and assignment.

```sql
CREATE TABLE IF NOT EXISTS incidents (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(500) NOT NULL,
  server_id     INTEGER REFERENCES servers(id) ON DELETE SET NULL,
  severity      VARCHAR(20) NOT NULL CHECK (severity IN ('info','warning','critical')),
  state         VARCHAR(20) NOT NULL DEFAULT 'new'
                  CHECK (state IN ('new','investigating','resolved')),
  started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMP,
  claimed_by    VARCHAR(100),
  claimed_at    TIMESTAMP,
  alert_count   INTEGER DEFAULT 0,
  ai_summary_id INTEGER REFERENCES alert_summaries(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incidents_state         ON incidents(state);
CREATE INDEX IF NOT EXISTS idx_incidents_server_id     ON incidents(server_id);
CREATE INDEX IF NOT EXISTS idx_incidents_started_at    ON incidents(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_state_started ON incidents(state, started_at DESC);
```

---

### Table: `users`

```sql
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) NOT NULL UNIQUE,
  email         VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin','operator','viewer')),
  enabled       BOOLEAN DEFAULT TRUE,
  last_login    TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);
```

**No explicit secondary indexes** beyond the UNIQUE on `username`. Queries hit by PK or username — fine for small user tables.

---

### Table: `audit_log`

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username      VARCHAR(100) NOT NULL,
  action        VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id   INTEGER,
  metadata      JSONB,
  ip_address    VARCHAR(45),
  created_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id    ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource   ON audit_log(resource_type, resource_id);
```

**⚠ No retention policy.** `audit_log` has no cleanup job. It grows indefinitely.

---

### Table: `wazuh_agents`

```sql
CREATE TABLE IF NOT EXISTS wazuh_agents (
  id                 SERIAL PRIMARY KEY,
  wazuh_id           VARCHAR(20) NOT NULL UNIQUE,
  name               VARCHAR(255) NOT NULL,
  ip_address         VARCHAR(45),
  status             VARCHAR(50),
  os_name            VARCHAR(100),
  os_version         VARCHAR(100),
  agent_version      VARCHAR(50),
  last_keep_alive    TIMESTAMP WITH TIME ZONE,
  group_name         VARCHAR(100),
  first_seen         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_status_change TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_wazuh_agents_status ON wazuh_agents(status);
```

---

### Table: `crowdsec_decisions`

```sql
CREATE TABLE IF NOT EXISTS crowdsec_decisions (
  id             SERIAL PRIMARY KEY,
  server_id      INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  decision_id    INTEGER NOT NULL,
  source_ip      VARCHAR(45) NOT NULL,
  source_country VARCHAR(10),
  scenario       VARCHAR(255),
  action         VARCHAR(50),
  duration       VARCHAR(50),
  expires_at     TIMESTAMP,
  created_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE (server_id, decision_id)
);
CREATE INDEX IF NOT EXISTS idx_crowdsec_decisions_server_id  ON crowdsec_decisions(server_id);
CREATE INDEX IF NOT EXISTS idx_crowdsec_decisions_created_at ON crowdsec_decisions(created_at DESC);
```

Expired decisions are purged by the retention job: `DELETE FROM crowdsec_decisions WHERE expires_at IS NOT NULL AND expires_at < NOW()`.

---

### Table: `support_tickets`

```sql
CREATE TABLE IF NOT EXISTS support_tickets (
  id                   SERIAL PRIMARY KEY,
  title                VARCHAR(500) NOT NULL,
  description          TEXT,
  category             VARCHAR(50) NOT NULL DEFAULT 'other'
                         CHECK (category IN ('hardware','software','network','email','printer','account','training','other')),
  priority             VARCHAR(20) NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low','normal','high','urgent')),
  status               VARCHAR(20) NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','in_progress','resolved','cancelled')),
  requester_name       VARCHAR(255) NOT NULL,
  requester_email      VARCHAR(255),
  requester_department VARCHAR(100),
  device_info          VARCHAR(500),
  resolution           TEXT,
  duration_minutes     INTEGER DEFAULT 0,
  assigned_to_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMP DEFAULT NOW(),
  updated_at           TIMESTAMP DEFAULT NOW(),
  started_at           TIMESTAMP,
  resolved_at          TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status      ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to ON support_tickets(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at  ON support_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_requester   ON support_tickets(requester_name);
```

---

### Table: `support_ticket_notes`

```sql
CREATE TABLE IF NOT EXISTS support_ticket_notes (
  id               SERIAL PRIMARY KEY,
  ticket_id        INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username         VARCHAR(100) NOT NULL,
  note             TEXT NOT NULL,
  duration_minutes INTEGER DEFAULT 0,
  created_at       TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_notes_ticket_id ON support_ticket_notes(ticket_id);
```

---

### Table: `container_events`

```sql
CREATE TABLE IF NOT EXISTS container_events (
  id             SERIAL PRIMARY KEY,
  server_id      INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  container_name VARCHAR(255) NOT NULL,
  event_type     VARCHAR(50) NOT NULL,   -- created | state_change | restart | image_change | removed
  previous_state VARCHAR(50),
  new_state      VARCHAR(50),
  metadata       JSONB,
  created_at     TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_container_events_server_id ON container_events(server_id);
CREATE INDEX IF NOT EXISTS idx_container_events_container
  ON container_events(server_id, container_name, created_at DESC);
```

Retention: 90 days (hardcoded in the retention job).

---

### Schema Relationship Diagram (textual)

```
servers ──< metrics
        ──< alerts ──> alert_summaries
        ──< incidents ──> alert_summaries
        ──< crowdsec_decisions
        ──< container_events
        ──< wazuh_agents (soft link via wazuh_agent_name)

monitors ──< monitor_checks

users ──< audit_log
      ──< support_tickets (assigned_to, created_by)
      ──< support_ticket_notes

alerts >── incidents (incident_id FK)
alerts >── alert_summaries (summary_id FK)
incidents >── alert_summaries (ai_summary_id FK)
```

---

## 3. API & Routes

**Base URL:** `http://<host>:3200`
**Auth:** All `/api/v1/` paths require JWT (`Authorization: Bearer <token>`) except where noted.

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/auth/login` | Public | Returns `{ token, user }`. Rate-limited 5/min/IP |
| POST | `/api/v1/auth/logout` | JWT | Client-side discard (no server state) |
| GET | `/api/v1/auth/me` | JWT | Returns current user profile |
| POST | `/api/v1/auth/change-password` | JWT | Updates own password |

**Login request/response:**
```json
// POST /api/v1/auth/login
// Request:
{ "username": "admin", "password": "secret" }

// Response 200:
{ "token": "eyJ...", "user": { "id": 1, "username": "admin", "role": "admin" } }
```

### User Management (admin only)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/users` | List all users |
| POST | `/api/v1/users` | Create user (`{ username, password, email?, role }`) |
| PUT | `/api/v1/users/:id` | Update user (role, enabled) |
| POST | `/api/v1/users/:id/reset-password` | Reset password |
| DELETE | `/api/v1/users/:id` | Delete user |
| GET | `/api/v1/audit` | List audit log (paginated) |

### Metric Ingestion (X-API-Key, not JWT)

```
POST /api/v1/metrics
Header: X-API-Key: <server api_key>
```

**Request body:**
```json
{
  "server_name": "web-01",
  "host_ip": "192.168.1.10",
  "os_type": "linux",
  "host_uptime_seconds": 86400,
  "metrics": [
    {
      "metric_type": "cpu",
      "value": { "cpu": { "usage_percent": 14.2, "load_avg_1": 0.3 } },
      "timestamp": "2026-05-07T10:00:00.000Z"
    }
  ]
}
```

**Response 201:**
```json
{ "success": true, "server_id": 3, "anomaliesDetected": 0 }
```

Server upserts the server row, stamps `server_id`, inserts metrics, runs anomaly detection.

### Metrics & Servers (viewer+)

| Method | Path | Query Params | Description |
|---|---|---|---|
| GET | `/api/v1/servers` | — | All servers, ordered by heartbeat |
| PUT | `/api/v1/servers/:id` | — | Update name/notes (admin) |
| GET | `/api/v1/servers/:id/metrics` | `limit` (default 100) | Per-server metrics |
| GET | `/api/v1/metrics` | `limit`, `server_id` | All metrics (filtered) |
| GET | `/api/v1/status` | — | Cluster summary (dual-auth: JWT or X-API-Key) |
| GET | `/api/v1/servers/:id/status` | — | Per-server summary (dual-auth) |
| GET | `/api/v1/servers/:id/security` | — | Wazuh + CrowdSec context for server |
| GET | `/api/v1/config` | — | Safe config subset (no secrets) |

**`/api/v1/status` response shape:**
```json
{
  "servers_online": 3,
  "servers_total": 4,
  "containers_running": 12,
  "containers_total": 14,
  "monitors_up": 5,
  "monitors_total": 5,
  "active_alerts": 2,
  "uptime_percentage": 99.8,
  "incidents_new": 1,
  "incidents_investigating": 0,
  "incidents_resolved_today": 3
}
```

### Alerts (viewer+)

| Method | Path | Query Params | Description |
|---|---|---|---|
| GET | `/api/v1/alerts` | `limit` (50), `server_id`, `acknowledged` | List alerts with server name |
| GET | `/api/v1/alerts/:id/summary` | — | AI summary for alert |
| GET | `/api/v1/summaries` | `limit` (10, max 50), `server_id` | All AI summaries |
| POST | `/api/v1/alerts/:id/acknowledge` | — | Mark acknowledged (operator+) |
| POST | `/api/v1/test-alert` | body: `{ channels?: string[] }` | Send test (operator+) |

### Docker Monitoring (viewer+)

| Method | Path | Query Params | Description |
|---|---|---|---|
| GET | `/api/v1/docker/containers` | `server_id?` | Latest container snapshot (all or one server) |
| GET | `/api/v1/docker/containers/:name/metrics` | `limit` (50, max 200), `server_id?` | LATERAL jsonb expansion history |
| GET | `/api/v1/docker/containers/:server_id/:container_name/history` | `hours` (24, max 168) | Structured per-container time-series |
| GET | `/api/v1/docker/containers/:server_id/:container_name/restarts` | — | Restart counts (24h, 7d) |
| GET | `/api/v1/docker/events` | `server_id?`, `container_name?`, `limit` (100) | Container lifecycle events |
| GET | `/api/v1/docker/top` | `metric` (cpu/memory/network), `limit` (10, max 50) | Top consumers across all servers |

**`getDockerTop` SQL:**
```sql
WITH latest_docker AS (
  SELECT DISTINCT ON (server_id)
    server_id,
    value->'docker' AS containers
  FROM metrics
  WHERE metric_type = 'docker'
  ORDER BY server_id, timestamp DESC
)
SELECT
  s.name AS server_name,
  ld.server_id,
  elem->>'name'                               AS container_name,
  (elem->>'state')                            AS state,
  COALESCE((elem->>'cpu_percent')::float8, 0) AS cpu_percent,
  COALESCE((elem->>'memory_mb')::float8, 0)   AS memory_mb,
  COALESCE((elem->>'memory_percent')::float8, 0) AS memory_percent,
  COALESCE((elem->>'net_rx_bytes')::float8, 0) AS net_rx_bytes,
  COALESCE((elem->>'net_tx_bytes')::float8, 0) AS net_tx_bytes
FROM latest_docker ld
JOIN servers s ON s.id = ld.server_id,
LATERAL jsonb_array_elements(COALESCE(ld.containers, '[]'::jsonb)) AS elem
WHERE (elem->>'state') = 'running'
  AND elem->>'name' IS NOT NULL
ORDER BY <orderExpr> DESC NULLS LAST
LIMIT $1
```

### Uptime Monitors (viewer GET, admin write)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/monitors` | All monitors with latest check + 24h/7d/30d uptime % |
| POST | `/api/v1/monitors` | Create monitor |
| PUT | `/api/v1/monitors/:id` | Update monitor |
| DELETE | `/api/v1/monitors/:id` | Delete monitor |
| GET | `/api/v1/monitors/:id/checks` | Historical check results |
| POST | `/api/v1/monitors/:id/test` | Run check immediately |

**`listMonitors` SQL (MONITOR_UPTIME_SQL):**
```sql
SELECT
  m.*,
  lc.status_code, lc.response_time_ms, lc.is_up, lc.error,
  lc.cert_expires_at, lc.checked_at,
  u24.uptime_pct AS uptime_24h,
  u7d.uptime_pct AS uptime_7d,
  u30d.uptime_pct AS uptime_30d
FROM monitors m
LEFT JOIN LATERAL (
  SELECT * FROM monitor_checks
  WHERE monitor_id = m.id ORDER BY checked_at DESC LIMIT 1
) lc ON true
LEFT JOIN LATERAL (
  SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_up) / NULLIF(COUNT(*),0), 1) AS uptime_pct
  FROM monitor_checks WHERE monitor_id = m.id AND checked_at > NOW() - INTERVAL '24 hours'
) u24 ON true
LEFT JOIN LATERAL (
  SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_up) / NULLIF(COUNT(*),0), 1) AS uptime_pct
  FROM monitor_checks WHERE monitor_id = m.id AND checked_at > NOW() - INTERVAL '7 days'
) u7d ON true
LEFT JOIN LATERAL (
  SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_up) / NULLIF(COUNT(*),0), 1) AS uptime_pct
  FROM monitor_checks WHERE monitor_id = m.id AND checked_at > NOW() - INTERVAL '30 days'
) u30d ON true
```

### Incidents (viewer read, operator write)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/incidents` | List with filters (`state`, `server_id`, `severity`, `limit`) |
| GET | `/api/v1/incidents/:id` | Full detail with alerts and notes |
| POST | `/api/v1/incidents/:id/claim` | Assign to current user |
| POST | `/api/v1/incidents/:id/resolve` | Mark resolved |
| POST | `/api/v1/incidents/:id/reopen` | Reopen resolved incident |
| PUT | `/api/v1/incidents/:id` | Update title/severity/notes |
| POST | `/api/v1/incidents/:id/merge` | Merge another incident into this one |
| POST | `/api/v1/incidents/:id/split` | Split subset of alerts into new incident |
| POST | `/api/v1/incidents/bulk-resolve` | Resolve all matching scope (admin) |
| GET | `/api/v1/incidents/bulk-resolve/count` | Preview count for bulk-resolve scope |

### Wazuh Integration (viewer+)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/wazuh/agents` | All Wazuh agents |
| GET | `/api/v1/wazuh/agents/:id` | Single agent detail |
| GET | `/api/v1/wazuh/status` | Integration status + last poll timestamp |
| GET | `/api/v1/wazuh/unmatched` | Wazuh agents without a matching Fenris server |
| POST | `/api/v1/wazuh/test-connection` | Test Wazuh credentials (admin) |

### CrowdSec Integration (viewer+)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/crowdsec/decisions` | Active bans/captchas/throttles |
| GET | `/api/v1/crowdsec/stats` | Top scenarios + source countries |
| GET | `/api/v1/crowdsec/status` | Integration status |
| POST | `/api/v1/crowdsec/test-connection` | Test LAPI credentials (admin) |

### Support Tickets (viewer read, operator write)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/support/tickets` | List tickets (filterable) |
| POST | `/api/v1/support/tickets` | Create ticket |
| GET | `/api/v1/support/tickets/:id` | Full ticket + notes |
| PUT | `/api/v1/support/tickets/:id` | Update ticket |
| DELETE | `/api/v1/support/tickets/:id` | Delete ticket (admin) |
| POST | `/api/v1/support/tickets/:id/notes` | Add note with time tracking |
| POST | `/api/v1/support/tickets/:id/start` | Mark in-progress |
| POST | `/api/v1/support/tickets/:id/resolve` | Mark resolved |
| GET | `/api/v1/support/stats` | Stats by status/category/priority/technician |
| GET | `/api/v1/support/report` | Monthly/yearly volume trends |
| GET | `/api/v1/support/requesters` | Top requester names |

### Auth Mechanics

**JWT:** HS256, 24h expiry. Payload: `{ id, username, role }`. Secret loaded from env `JWT_SECRET` → `/app/data/jwt-secret` file → generated random 64-char hex.

**Role hierarchy:** `viewer < operator < admin`. All role checks in handlers via `hasRole(req.user.role, 'admin')`.

**Agent auth:** `X-API-Key` header matched against `servers.api_key` column. Auto-registers new server on first contact via `INSERT … ON CONFLICT DO UPDATE`.

**Dual-auth paths** (`GET /api/v1/status`, `GET /api/v1/servers/:id/status`): accept either JWT or a valid server API key — intended for Homepage widget integration with static headers.

---

## 4. Services & Workers

All workers are started in `server/src/index.ts`'s `start()` function after route registration.

---

### Retention Job

**File:** `server/src/index.ts:startRetentionJob()`
**Interval:** Every 60 minutes (`setInterval(runCleanup, 60 * 60 * 1000)`)

```typescript
// Configurable via fenris.yaml:
const metricsDays = config.retention?.metrics_days ?? 30;
const alertsDays  = config.retention?.alerts_days  ?? 90;

DELETE FROM metrics WHERE timestamp < NOW() - ($1 || ' days')::INTERVAL
DELETE FROM alerts WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
DELETE FROM monitor_checks WHERE checked_at < NOW() - INTERVAL '90 days'          -- hardcoded
DELETE FROM crowdsec_decisions WHERE expires_at IS NOT NULL AND expires_at < NOW()
DELETE FROM container_events WHERE created_at < NOW() - INTERVAL '90 days'         -- hardcoded
```

**⚠ Note:** `monitor_checks` and `container_events` retention is hardcoded at 90 days and cannot be configured via `fenris.yaml`. `audit_log` has no retention at all.

---

### Predictor

**File:** `server/src/engine/predictor.ts`
**Interval:** Every 5 minutes (configurable: `predictions.interval`, default `"5m"`)
**Startup delay:** 30 seconds (waits for initial data)

**Algorithm:** Linear regression on last N samples (`min_samples`, default 120). Computes slope, intercept, R² confidence. If `confidence >= min_confidence` (default 0.75) and the metric is trending toward breach within the configured horizon, fires a `warning` alert.

**DB queries per run:**
```sql
-- 1. Fetch all servers
SELECT id, name FROM servers

-- 2. Per server, per metric type (cpu, memory, disk) = 3N queries:
SELECT value, timestamp FROM metrics
WHERE server_id = $1 AND metric_type = $2
ORDER BY timestamp DESC LIMIT $3
-- $3 = min_samples (default 120)
```

**Total queries per 5-min cycle:** `1 + 3 × N_servers`. With 10 servers: 31 queries every 5 minutes.

**Cooldowns (in-memory Map, resets on restart):**
- CPU/memory: 1 hour per `serverId:metricType`
- Disk: 6 hours per `serverId:metricType`

**Defaults:**
```yaml
predictions:
  enabled: true
  interval: "5m"
  disk_horizon_days: 3
  cpu_horizon_hours: 1
  memory_horizon_hours: 1
  disk_threshold: 85
  cpu_threshold: 90
  memory_threshold: 90
  min_samples: 120
  min_confidence: 0.75
```

---

### Anomaly Detector

**File:** `server/src/engine/anomaly.ts`
**Trigger:** Called synchronously during metric ingestion (not a background timer)

**Algorithm:** Z-score. `z = (value - mean) / stdDev`. Alert fires if `|z| > zscore_threshold` AND `n >= min_samples`.

**Per-metric floors** (skip anomaly if value below floor — prevents noise):

| Metric | Default floor |
|---|---|
| cpu | 80% |
| memory | 85% |
| disk | 80% |
| docker_cpu | 75% |
| docker_memory | 70% |
| network | Always skipped |

**State:** In-memory Map keyed by `serverId:metricType`. Keeps last `window_size * 2` samples. Lost on server restart.

**Defaults:**
```yaml
anomaly_detection:
  enabled: true
  zscore_threshold: 4.0
  window_size: 100
  min_samples: 60
```

---

### Uptime Monitor

**File:** `server/src/monitors/uptime.ts`
**Trigger:** Runs on each monitor's `interval_seconds` (set per-monitor, default 60s)

- Fetches all enabled monitors from DB at startup, starts a timer per monitor
- For each check: HTTP/HTTPS request with timeout, extracts TLS cert expiry via `tls.connect()`
- Records result in `monitor_checks` table
- Fires transition alerts: `UP→DOWN` (critical), `DOWN→UP` (info), SSL expiry warning
- Cooldown: 15 minutes per monitor (in-memory)

---

### Wazuh Monitor

**File:** `server/src/monitors/wazuh.ts`
**Interval:** `wazuh.poll_interval` (default 60s)
**Enabled:** Only if `wazuh.enabled = true` in fenris.yaml

- Authenticates with Wazuh manager REST API (Basic Auth → JWT)
- Refreshes JWT every 10 minutes
- Fetches `/agents?limit=500`
- Upserts agent state into `wazuh_agents` table
- Matches by name to `servers.wazuh_agent_name`
- Fires alerts for agents offline or with stale keepalives (>5 min)
- Per-agent cooldown: 15 minutes

---

### CrowdSec Monitor

**File:** `server/src/monitors/crowdsec.ts`
**Interval:** `crowdsec.poll_interval` (configurable)
**Enabled:** Only if `crowdsec.enabled = true` and at least one instance configured

- Polls each LAPI instance's `/decisions` endpoint
- Upserts into `crowdsec_decisions` (UNIQUE on `server_id, decision_id`)
- Optional geo-IP lookup via `geoip-lite`
- Stats (top scenarios, countries) computed in-memory from table

---

### AI Summarizer

**File:** `server/src/engine/summarizer.ts`
**Trigger:** Event-driven; batched with 2-minute window
**Enabled:** Only if `ai.enabled = true`

- `enqueue(alert)` adds alert to per-server batch queue
- After 2-minute batch window expires: POSTs to OpenAI-compatible API
- Rate limit: `max_calls_per_hour` (default 10)
- Per-server cooldown: 15 minutes
- Result stored in `alert_summaries` table, linked to alerts via `summary_id`

**Defaults:**
```yaml
ai:
  enabled: false
  provider: openai
  api_url: "https://api.openai.com/v1/chat/completions"
  model: "gpt-4o-mini"
  max_calls_per_hour: 10
  batch_window_ms: 120000
  cooldown_per_server_ms: 900000
```

---

### Alert Dispatcher

**File:** `server/src/alerts/dispatcher.ts`

Fan-out to all enabled channels. Channels: Discord (webhook), Slack (webhook), Email (SMTP/nodemailer). Per-channel severity filtering. Failure on one channel never blocks others. Cooldown: 15 minutes per `serverId:metricType` (in-memory).

---

### Daily Digest

**File:** `server/src/engine/digest.ts`
**Trigger:** Configured time of day (default `08:00 UTC`)

Compiles a daily incident/alert summary and emails it via SMTP. Skips if email not configured.

```yaml
daily_digest:
  enabled: false
  time: "08:00"
  timezone: "UTC"
```

---

### Startup Cleanup (one-shot on server start)

**File:** `server/src/index.ts:startupCleanup()`

```sql
-- Bulk-acknowledge stale unacknowledged alerts (>24h old)
UPDATE alerts SET acknowledged = true
WHERE acknowledged = false AND created_at < NOW() - INTERVAL '24 hours';

-- Auto-resolve stale open incidents (>24h, no recent alert in last hour)
UPDATE incidents
SET state = 'resolved', resolved_at = NOW(), updated_at = NOW()
WHERE state IN ('new', 'investigating')
  AND started_at < NOW() - INTERVAL '24 hours'
  AND id NOT IN (
    SELECT DISTINCT incident_id FROM alerts
    WHERE incident_id IS NOT NULL AND created_at > NOW() - INTERVAL '1 hour'
  );
```

---

### Incident Grouping (event-driven)

**File:** `server/src/engine/incidents.ts:attachAlertToIncident()`

Called on every new alert (fire-and-forget). Finds an open incident on the same server within the last hour; if found, increments `alert_count`; if not, creates a new incident. Severity = max severity of all linked alerts.

---

### Linux Agent Collection Loop

**File:** `agent/src/index.ts`
**Default interval:** 30 seconds (`collect_interval: 30` in fenris-agent.yaml)

```typescript
// Runs immediately then on interval
setInterval(tick, config.collect_interval);
```

**Per-tick:** collects CPU, memory, disk (configured paths), network interfaces, Docker containers → single HTTP POST to `/api/v1/metrics`.

**Buffer:** Up to 100 payloads buffered if server unreachable. Exponential backoff: 5s → 5 minutes max.

---

## 5. Docker / Infrastructure

### `server/Dockerfile`

```dockerfile
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
RUN cp src/db/schema.sql dist/schema.sql
RUN adduser --disabled-password --no-create-home fenris
RUN mkdir -p /app/logs /app/data && chown -R fenris:fenris /app/logs /app/data
USER fenris
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3200/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```

### `web/Dockerfile`

```dockerfile
FROM node:22-alpine AS builder
ARG VITE_API_KEY
ENV VITE_API_KEY=${VITE_API_KEY}
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**⚠ `VITE_API_KEY` is baked into the static JS bundle at build time.** It is the default server API key that the web frontend uses for the dual-auth status endpoints. This key is visible in the browser; it should only grant viewer-level access and never be an admin JWT.

### `web/nginx.conf`

```nginx
upstream fenris_backend { server server:3200; }

server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  location /api/ {
    proxy_pass http://fenris_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

### `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:15-alpine
    container_name: fenris-postgres
    environment:
      POSTGRES_USER: fenris
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-CHANGE_ME_BEFORE_DEPLOY}
      POSTGRES_DB: fenris
    volumes:
      - fenris-postgres-data:/var/lib/postgresql/data
    restart: unless-stopped
    networks: [fenris]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U fenris']
      interval: 10s
      timeout: 5s
      retries: 5

  server:
    build: { context: ./server, dockerfile: Dockerfile }
    container_name: fenris-server
    environment:
      - DATABASE_URL=postgresql://fenris:${POSTGRES_PASSWORD}@postgres:5432/fenris
      - PORT=3200
      - NODE_ENV=production
    ports: ['3200:3200']
    group_add: ["${DOCKER_GID:-988}"]        # grants access to Docker socket GID
    volumes:
      - fenris-logs:/app/logs
      - fenris-data:/app/data                # JWT secret persisted here
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./fenris.yaml:/app/fenris.yaml:ro
    depends_on: { postgres: { condition: service_healthy } }
    restart: unless-stopped
    networks: [fenris]
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3200/health')…"]
      interval: 30s
      timeout: 10s
      retries: 3

  web:
    build:
      context: ./web
      dockerfile: Dockerfile
      args:
        VITE_API_KEY: ${VITE_API_KEY:-088eef410ebc4caffb6e7bcf934530e022042d810fffe4d89caac3650164c774}
    container_name: fenris-web
    ports: ['8081:80']
    depends_on: { server: { condition: service_healthy } }
    restart: unless-stopped
    networks: [fenris]
    labels: ["autoheal=true"]

  agent:                   # optional: monitors the host running the stack
    profiles: ["agent"]
    build: { context: ./agent }
    environment:
      HOST_IP: 100.90.129.230    # ← hardcoded in repo; should come from .env
    volumes:
      - ./agent-local/fenris-agent.yaml:/app/fenris-agent.yaml:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    group_add: ["${DOCKER_GID:-988}"]
    depends_on: [server]
    restart: unless-stopped
    networks: [fenris]

volumes:
  fenris-postgres-data:
  fenris-logs:
  fenris-data:

networks:
  fenris:
    driver: bridge
```

**No CPU/memory resource limits are defined** on any container.

### Environment Variables

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `POSTGRES_PASSWORD` | postgres, server | `CHANGE_ME_BEFORE_DEPLOY` | Must be set before deploy |
| `DATABASE_URL` | server | derived from above | Full connection string |
| `PORT` | server | `3200` | |
| `NODE_ENV` | server | `production` | |
| `FENRIS_API_KEY` | agent | `CHANGE_ME_BEFORE_DEPLOY` | Agents authenticate with this |
| `JWT_SECRET` | server | generated + persisted | 32+ chars; persisted to `/app/data/jwt-secret` |
| `DISCORD_WEBHOOK_URL` | server | blank | Enables Discord alerts if set |
| `SLACK_WEBHOOK_URL` | server | blank | Enables Slack alerts if set |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` | server | blank | Enables email alerts |
| `ALERT_FROM` / `ALERT_TO` | server | blank | Email sender/recipient |
| `DOCKER_GID` | server, agent | `988` | GID of `/var/run/docker.sock` on host |
| `FENRIS_CONFIG` | server | `/app/fenris.yaml` | Config file path |
| `VITE_API_KEY` | web (build arg) | hardcoded default | Baked into frontend bundle |
| `HOST_IP` | agent (docker-compose) | — | Override auto-detected IP |
| `FENRIS_SERVER_URL` | agent (env alt) | `http://localhost:3200` | Alternative to YAML config |
| `FENRIS_SERVER_NAME` | agent (env alt) | `hostname()` | |
| `FENRIS_COLLECT_INTERVAL` | agent (env alt) | `30` (seconds) | |

### Volume Mounts

| Volume | Mount | Purpose |
|---|---|---|
| `fenris-postgres-data` | `/var/lib/postgresql/data` | Database files |
| `fenris-logs` | `/app/logs` | Server log files |
| `fenris-data` | `/app/data` | JWT secret persistence |
| `/var/run/docker.sock` | `/var/run/docker.sock:ro` | Docker API access (server + agent) |
| `./fenris.yaml` | `/app/fenris.yaml:ro` | Server config |
| `./agent-local/fenris-agent.yaml` | `/app/fenris-agent.yaml:ro` | Agent config (local profile) |

---

## 6. Data Flow

### Metric Ingestion Pipeline

```
[Host System]
  └─ systeminformation / gopsutil / dockerode
        │  (every 30 seconds by default)
        ▼
[Agent] agent/src/index.ts:tick()
  1. Collect CPU, memory, disk(×paths), network(×interfaces), docker(×containers)
  2. Bundle into AgentPayload
  3. If buffer has backlog: flush first
  4. POST /api/v1/metrics  Header: X-API-Key
  5. On failure: buffer (max 100), backoff 5s→5min

        │
        ▼
[Fastify server] api/routes.ts:receiveMetrics()
  1. Validate X-API-Key
  2. Resolve IP (filter Docker-internal addresses)
  3. UPSERT servers (auto-register on first contact)
  4. Stamp server_id on each metric
  5. Call ingestMetrics(metrics)

        │
        ▼
[ingestMetrics()]
  1. Query last docker snapshot (1 DB read for state-transition detection)
  2. For each metric:
       - INSERT INTO metrics …         (1 DB write per metric)
       - Add to in-memory Z-score detector
       - If anomaly: record in anomalyResults map
  3. Fire container event tracking (async, fire-and-forget)
  4. UPDATE servers SET last_heartbeat = NOW()
  5. For each anomaly:
       - INSERT INTO alerts …
       - dispatcher.dispatchAlert() → fan-out Discord/Slack/Email
       - summarizer.enqueue()       → batch for AI summary
       - attachAlertToIncident()    → group into incident

        │
        ▼
[Dashboard] web/src/pages/
  - Polls GET /api/v1/metrics every 30s (via Promise.all in useEffect)
  - Renders HistoryChart (Recharts AreaChart), CircularGauge (SVG), Sparkline
```

### Telemetry Write Rate

With default 30-second collection interval on 1 server with 3 disk paths and 2 network interfaces:

- Per tick: 1 (cpu) + 1 (memory) + 3 (disk) + 2 (network) + 1 (docker) = **8 INSERT statements**
- Per minute: 16 inserts
- Per hour: ~960 inserts
- Per day: ~23,000 inserts
- Per 30-day retention window (steady state): ~690,000 rows

With 10 servers this scales to ~6.9M rows. The `idx_metrics_server_timestamp` composite index covers the most common query pattern.

### Alert Lifecycle

```
Alert created → INSERT alerts
             → dispatcher.dispatchAlert() (async, non-blocking)
                   ├── Discord webhook POST
                   ├── Slack webhook POST
                   └── SMTP sendMail()
             → summarizer.enqueue() (if AI enabled)
                   └── after 2-min window: POST to OpenAI API
                         └── INSERT alert_summaries, UPDATE alerts.summary_id
             → attachAlertToIncident()
                   ├── Find open incident (same server, last 1 hour)
                   │     └── UPDATE incidents SET alert_count = alert_count + 1
                   └── If none: INSERT incidents

Alert acknowledged → UPDATE alerts SET acknowledged = true
                   → autoResolveIncident() if all alerts on incident acknowledged
```

### Uptime Check Flow

```
UptimeMonitor.start()
  └── loads all enabled monitors from DB
  └── for each monitor: setInterval(check, interval_seconds * 1000)

check()
  ├── HTTP(S) request with timeout
  ├── TLS cert expiry via tls.connect() (HTTPS only)
  ├── INSERT monitor_checks
  ├── If state transition: dispatcher.dispatchAlert()
  └── 15-min cooldown per monitor
```

---

## 7. Known Performance Concerns

### P1 — Metric ingestion: sequential per-row INSERTs

**File:** `server/src/api/routes.ts:ingestMetrics()`

Each metric in the payload is inserted individually in a `for` loop:
```typescript
for (const metric of metrics) {
  await query(
    'INSERT INTO metrics (server_id, metric_type, value, timestamp) VALUES ($1, $2, $3::jsonb, $4)',
    [...]
  );
```

With 8 metrics per tick, this is 8 sequential round-trips to PostgreSQL per agent push. At high agent count this adds up. **Fix:** use a single multi-row INSERT or `pg-copy-streams`.

### P2 — `getDockerContainerHistory` without `server_id`: full-table LATERAL expand

**File:** `server/src/api/routes.ts:getDockerContainerHistory()`

```sql
SELECT m.timestamp, elem AS stats
FROM metrics m,
     LATERAL jsonb_array_elements(m.value->'docker') AS elem
WHERE m.metric_type = 'docker'
  AND elem->>'name' = $1
ORDER BY m.timestamp DESC
LIMIT $2
```

Without `server_id`, this scans all `docker` metric rows across all servers and expands every JSON array to find containers matching `name`. The partial GIN index `idx_metrics_docker_containers` does not help here because the filter is on `elem->>'name'` (a text equality on an expanded element), not a top-level JSONB key. This will degrade as the `metrics` table grows. The `server_id`-filtered variant is more efficient.

### P3 — `getAllMetrics` without `server_id`: scans entire metrics table

```sql
SELECT * FROM metrics ORDER BY timestamp DESC LIMIT $1
```

Uses `idx_metrics_timestamp` for the index scan but fetches full JSONB rows. At high row counts the LIMIT still requires reading the top-N rows from the index, which is efficient, but the result payload size can be large. Default limit is 100; no maximum enforced.

### P4 — `getStatus`: 5 parallel queries + conditional 6th

```typescript
await Promise.all([
  query('SELECT COUNT(*) … FROM servers'),
  query('SELECT DISTINCT ON (server_id) value->\'docker\' … FROM metrics WHERE metric_type = \'docker\' ORDER BY server_id, timestamp DESC'),
  query('SELECT is_up FROM (SELECT DISTINCT ON (monitor_id) is_up FROM monitor_checks ORDER BY monitor_id, checked_at DESC) sub'),
  query('SELECT COUNT(*) FROM alerts WHERE acknowledged = FALSE'),
  query('SELECT COUNT(*) FILTER … FROM incidents'),
]);
// + conditional uptime query over 30 days of monitor_checks
```

The Docker query (`DISTINCT ON (server_id)`) scans the docker-metric subset ordered by `(server_id, timestamp DESC)` — covered by `idx_metrics_server_timestamp`. The monitor DISTINCT ON also uses its index. These are generally fast, but the 30-day `monitor_checks` aggregate can be slow with many checks per monitor.

### P5 — Predictor: N×3 queries every 5 minutes, no batching

**File:** `server/src/engine/predictor.ts`

```typescript
const servers = await query('SELECT id, name FROM servers');
for (const s of servers.rows) {
  for (const mt of ['cpu', 'memory', 'disk']) {
    await predictForMetric(s.id, s.name, mt, ...);
    // Inside: SELECT value, timestamp FROM metrics WHERE server_id=$1 AND metric_type=$2 ORDER BY timestamp DESC LIMIT 120
  }
}
```

Sequential awaits inside the loops. With 10 servers: 31 DB queries per cycle, all sequential. **Fix:** batch via `Promise.all` across servers, or fetch all required samples in one query grouped by `(server_id, metric_type)`.

### P6 — `listMonitors`: 3N LATERAL range scans per request

The `MONITOR_UPTIME_SQL` view runs three correlated subqueries over `monitor_checks` per monitor for 24h/7d/30d windows. With 20 monitors this is 60 range scans per `GET /api/v1/monitors` call (frontend polls every 30s). The `idx_monitor_checks_monitor_ts` index helps but the query still runs many scans. **Fix:** consider a materialized view or a single aggregating CTE over `monitor_checks` grouped by `(monitor_id, window)`.

### P7 — `audit_log` has no retention policy

The `audit_log` table grows indefinitely. No cleanup is run. On busy installations this table will accumulate unboundedly. Add a retention job or partition by month.

### P8 — In-memory cooldown Maps reset on server restart

All cooldown state (anomaly dispatch, flapping, image-change, uptime, prediction) is stored in JavaScript `Map` objects. Server restart clears all cooldowns, which can cause a burst of duplicate alerts immediately after a restart. A PostgreSQL-backed cooldown or a minimum cooldown on the per-server alert dispatch in the DB would be more durable.

### P9 — `getServerStatus` fires 6 parallel single-row queries

```typescript
await Promise.all([
  query('SELECT name, last_heartbeat, created_at FROM servers WHERE id=$1'),
  query("SELECT value FROM metrics WHERE server_id=$1 AND metric_type='cpu' ORDER BY timestamp DESC LIMIT 1"),
  query("SELECT value FROM metrics WHERE server_id=$1 AND metric_type='memory' ORDER BY timestamp DESC LIMIT 1"),
  query("SELECT value FROM metrics WHERE server_id=$1 AND metric_type='disk' ORDER BY timestamp DESC LIMIT 1"),
  query("SELECT value->'docker' FROM metrics WHERE server_id=$1 AND metric_type='docker' ORDER BY timestamp DESC LIMIT 1"),
  query('SELECT COUNT(*) FROM alerts WHERE server_id=$1 AND acknowledged=FALSE'),
]);
```

Each of the four metric queries hits `idx_metrics_server_timestamp` individually. These could be combined into a single query using `DISTINCT ON (metric_type)` or `FILTER` aggregates.

### P10 — Container event flapping query: COUNT inside metric ingestion hot path

```sql
SELECT COUNT(*) AS cnt FROM container_events
WHERE server_id = $1 AND container_name = $2
  AND event_type = 'restart'
  AND created_at > NOW() - INTERVAL '30 minutes'
```

This query runs inside `trackContainerEvents()` which is called (async) on every metric ingestion for every container. The `idx_container_events_container` index covers this well, but it still hits the DB on every restart event per container.

### P11 — `SELECT *` with full JSONB rows in hot paths

Multiple queries use `SELECT *` from `metrics` including the large `value` JSONB column when only a subset of fields is needed. For example, `getServerMetrics` returns all columns including full JSONB for every row up to `limit`. At 100 rows with large docker arrays this can produce a large response payload.

---

## 8. Dependencies

### Server (`server/package.json`)

| Package | Version | Purpose |
|---|---|---|
| `fastify` | ^5.0.0 | HTTP framework |
| `@fastify/cors` | ^10.0.0 | CORS middleware |
| `@fastify/env` | ^4.0.0 | Env validation |
| `pg` | ^8.11.0 | PostgreSQL client |
| `bcryptjs` | ^3.0.3 | Password hashing (cost=12) |
| `jsonwebtoken` | ^9.0.3 | JWT sign/verify (HS256) |
| `js-yaml` | ^4.1.0 | Parse `fenris.yaml` |
| `nodemailer` | ^8.0.3 | SMTP email alerts |
| `node-fetch` | ^3.3.2 | HTTP for webhooks + integrations |
| `dockerode` | ^4.0.10 | Docker daemon API (local collector) |
| `systeminformation` | ^5.22.0 | Local system metrics (local collector) |
| `geoip-lite` | ^2.0.1 | IP geolocation for CrowdSec |
| `pino` | ^9.0.0 | Structured logging |

### Agent (`agent/package.json`)

| Package | Version | Purpose |
|---|---|---|
| `systeminformation` | ^5.22.0 | CPU/memory/disk/network collection |
| `dockerode` | ^4.0.10 | Docker stats via Unix socket |
| `js-yaml` | ^4.1.0 | Parse `fenris-agent.yaml` |
| `node-fetch` | ^3.3.2 | POST metrics to server |

### Web (`web/package.json`)

| Package | Version | Purpose |
|---|---|---|
| `react` | ^18.3.0 | UI framework |
| `react-dom` | ^18.3.0 | DOM renderer |
| `recharts` | ^2.12.0 | Charts (AreaChart, LineChart) |
| `react-markdown` | ^10.1.0 | AI summary rendering |
| `vite` | ^5.3.0 (dev) | Build tool |
| `tailwindcss` | ^3.4.0 (dev) | CSS utility framework |
| `typescript` | ^5.5.0 (dev) | Type checking |

### Windows Agent (`agent-windows/go.mod`)

| Package | Version | Purpose |
|---|---|---|
| `github.com/shirou/gopsutil/v3` | v3.24.5 | CPU/memory/disk/network collection |
| `golang.org/x/sys` | v0.43.0 | Windows syscalls |
| `gopkg.in/yaml.v3` | v3.0.1 | Config parsing |

---

## 9. Configuration

### Primary Config File: `fenris.yaml`

Loaded from `FENRIS_CONFIG` env var (default `/app/fenris.yaml`). Falls back to hardcoded defaults if file not found.

```yaml
server:
  port: 3200
  database_url: "postgresql://fenris:PASSWORD@postgres:5432/fenris"

monitors:
  system:
    enabled: true
    scrape_interval: 30s          # agent collection interval default
    metrics: [cpu, memory, disk, network]
  disk:
    paths:
      - path: /
        name: root
        warning_threshold: 85
        critical_threshold: 95
      - path: /var/lib/docker
        name: docker-data
        warning_threshold: 80
        critical_threshold: 90

alerts:
  discord:
    enabled: true
    webhook_url: "https://discord.com/api/webhooks/…"
    severity_levels: [info, warning, critical]
  slack:
    enabled: false
    webhook_url: "https://hooks.slack.com/…"
    severity_levels: [warning, critical]
  email:
    enabled: false
    host: smtp.gmail.com
    port: 587
    username: you@gmail.com
    password: app-password
    from: fenris@yourdomain.com
    to: admin@yourdomain.com
    severity_levels: [critical]
  thresholds:
    cpu:     { warning: 75, critical: 95 }
    memory:  { warning: 80, critical: 90 }
    disk:    { warning: 85, critical: 95 }
    network: { anomaly_threshold: 3.0 }

anomaly_detection:
  enabled: true
  algorithm: zscore
  zscore_threshold: 4.0
  window_size: 100
  min_samples: 60
  floors:
    cpu: 80
    memory: 85
    disk: 80
    docker_cpu: 75
    docker_memory: 70
  exclude_containers:             # glob patterns; built-in Fenris containers always excluded
    - "*-agent*"
    - "*-exporter"
    - "*-cron*"
    - "watchtower"

predictions:
  enabled: true
  interval: "5m"
  disk_horizon_days: 3
  cpu_horizon_hours: 1
  memory_horizon_hours: 1
  disk_threshold: 85
  cpu_threshold: 90
  memory_threshold: 90
  min_samples: 120
  min_confidence: 0.75

ai:
  enabled: false
  provider: openai
  api_url: "https://api.openai.com/v1/chat/completions"
  api_key: "sk-…"
  model: "gpt-4o-mini"
  max_calls_per_hour: 10
  batch_window_ms: 120000
  cooldown_per_server_ms: 900000

wazuh:
  enabled: false
  manager_url: "https://wazuh-manager:55000"
  username: "wazuh-wui"
  password: ""
  poll_interval: 60            # seconds

crowdsec:
  enabled: false
  instances:
    - name: "web-01"
      url: "http://crowdsec:8080"
      api_key: "your-bouncer-key"

retention:
  metrics_days: 30
  alerts_days: 90
  # Note: monitor_checks and container_events retention is hardcoded at 90 days
  # Note: audit_log has no retention

daily_digest:
  enabled: false
  time: "08:00"
  timezone: "UTC"
```

### Agent Config File: `fenris-agent.yaml`

```yaml
server_url: "http://fenris-server:3200"
api_key: "your-api-key-here"
server_name: "my-server"
collect_interval: 30              # seconds (or "30s", "1m", "2h")
docker_enabled: true
collect_volume_sizes: false        # expensive: du per container mount
volume_size_interval: 300          # seconds between du runs
disk_paths:
  - /
  - /var/lib/docker
  - /home
```

All fields can also be set via environment variables (`FENRIS_SERVER_URL`, `FENRIS_API_KEY`, `FENRIS_SERVER_NAME`, `FENRIS_COLLECT_INTERVAL`, `FENRIS_DOCKER_ENABLED`).

### Secrets Management

- **Database password:** `.env` → `POSTGRES_PASSWORD` → Docker Compose env injection.
- **JWT secret:** `JWT_SECRET` env var, or auto-generated and persisted to `/app/data/jwt-secret` (volume-backed).
- **Webhook URLs / SMTP password:** `fenris.yaml` (mounted as read-only volume) or env vars.
- **AI API key:** `fenris.yaml` `ai.api_key` field.
- **No secrets manager integration** — all secrets are plaintext in `.env` / `fenris.yaml`.

---

## 10. Deployment

### Standard Deployment: Docker Compose

**Prerequisites:** Docker, Docker Compose v2, Git.

```bash
git clone <repo>
cd fenris
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, JWT_SECRET, FENRIS_API_KEY
cp fenris.yaml.example fenris.yaml
# Edit fenris.yaml: configure alerts, thresholds, integrations

docker compose up -d

# Get initial admin password:
docker compose logs server | grep "Initial admin password"
```

Dashboard: `http://<host>:8081`
API: `http://<host>:3200`

**With built-in host agent (monitors the Docker host itself):**
```bash
cp agent-local/fenris-agent.yaml.example agent-local/fenris-agent.yaml
# Edit agent-local/fenris-agent.yaml
docker compose --profile agent up -d
```

### Remote Agent Deployment (Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/…/install-agent.sh | bash
# Prompts for: server URL, API key, server name
# Installs as systemd service
```

### Remote Agent Deployment (Windows)

```powershell
# Run as Administrator:
iex (irm "https://raw.githubusercontent.com/…/install-agent.ps1")
# Prompts for: server URL, API key, server name
# Installs as Windows Service (FenrisAgent)
# Config at C:\ProgramData\Fenris\fenris-agent.yaml
```

### CI/CD

**File:** `.github/workflows/release.yml`

Triggered on git tags matching `v*.*.*`. Cross-compiles the Windows agent Go binary for `windows/amd64` and `windows/arm64` using `ubuntu-latest`, then creates a GitHub Release with the binaries as assets.

No CI for the server or frontend (no test suite, no lint checks in CI).

### Upgrade Procedure

1. `git pull`
2. `docker compose build`
3. `docker compose up -d`

Schema migrations are applied idempotently at startup via `initializeTables()` (runs the full `schema.sql` which uses `IF NOT EXISTS` and `DO $$ BEGIN … END $$` guards). No down migrations exist.

### Health Checks

- **Server:** `GET /health` → `{ "status": "healthy", "timestamp": "…" }`
- **Postgres:** `pg_isready -U fenris` (Docker healthcheck)
- **Web/Nginx:** Implicitly healthy if serving `index.html`

---

*End of FENRIS_PROJECT_DOC.md*
