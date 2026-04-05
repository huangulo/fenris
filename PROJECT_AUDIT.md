# Fenris Project Audit

**Date:** 2026-04-05
**Audited by:** Claude Code (claude-sonnet-4-6)
**Branch:** main

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Architecture](#2-architecture)
3. [Dependencies](#3-dependencies)
4. [Database & State](#4-database--state)
5. [API Surface](#5-api-surface)
6. [Environment & Config](#6-environment--config)
7. [Known Issues](#7-known-issues)
8. [Test Coverage](#8-test-coverage)
9. [Build & Deploy](#9-build--deploy)
10. [Summary & Recommendations](#10-summary--recommendations)

---

## 1. Project Structure

```
/root/workspace/fenris/
├── agent/                              # Remote metrics collector — runs on each monitored host
│   ├── src/
│   │   ├── index.ts                   # Entry point: collection loop, metric buffering, retry logic
│   │   ├── config.ts                  # Config loader (YAML file + env var fallbacks)
│   │   ├── types.ts                   # TypeScript types: Metric, AgentPayload, AgentConfig
│   │   └── collectors/
│   │       ├── system.ts              # CPU, memory, disk, network metric collection
│   │       └── docker.ts              # Docker container stats via dockerode
│   ├── Dockerfile                     # Alpine Node.js container: builds to dist/index.js
│   ├── package.json                   # Agent dependencies
│   ├── tsconfig.json                  # TypeScript config
│   └── tsup.config.ts                 # Build config (bundles TypeScript to single JS)
│
├── agent-local/                        # Host-local agent config override (bind-mounted in compose)
│   └── fenris-agent.yaml              # Concrete agent config — gitignored; created manually
│
├── server/                             # Central monitoring hub — runs once, receives all agents
│   ├── src/
│   │   ├── index.ts                   # Fastify server setup, route registration, DB init, retention + predictor jobs
│   │   ├── types.ts                   # TypeScript types: Config, Metric, Alert, Server
│   │   ├── api/
│   │   │   └── routes.ts              # All HTTP endpoints: metric ingestion, queries, alerts, AI summaries
│   │   ├── collectors/                # Leftover from pre-agent self-collection era — not imported by index.ts
│   │   │   ├── system.ts              # (dead code)
│   │   │   └── docker.ts              # (dead code)
│   │   ├── db/
│   │   │   ├── client.ts              # PostgreSQL pool, query wrapper with logging
│   │   │   └── schema.sql             # DB schema: CREATE TABLE/INDEX statements (idempotent)
│   │   ├── engine/
│   │   │   ├── anomaly.ts             # Z-score anomaly detection algorithm
│   │   │   ├── predictor.ts           # Linear regression prediction engine with per-metric cooldowns
│   │   │   └── summarizer.ts          # AI incident summary batching via OpenAI-compatible API
│   │   └── alerts/
│   │       ├── dispatcher.ts          # Alert router: calls Discord/Slack/Email in parallel; test-alert support
│   │       ├── discord.ts             # Discord incoming webhook integration
│   │       ├── slack.ts               # Slack incoming webhook integration
│   │       ├── email.ts               # SMTP email alerts via nodemailer
│   │       └── util.ts                # Alert formatting, severity colors, per-server/metric cooldown state
│   ├── Dockerfile                     # Alpine Node.js, non-root user, health check via Node.js fetch
│   ├── package.json                   # Server dependencies
│   ├── pnpm-lock.yaml                 # Locked dependency versions
│   ├── tsconfig.json                  # TypeScript config
│   └── tsup.config.ts                 # Build config
│
├── web/                                # React dashboard frontend — fully rewritten as multi-page SPA
│   ├── src/
│   │   ├── App.tsx                    # Root component: routing, layout wiring (~265 lines)
│   │   ├── main.tsx                   # React DOM entry point
│   │   ├── index.css                  # Tailwind base + custom styles
│   │   ├── api.ts                     # Typed fetch helpers for all API endpoints
│   │   ├── types.ts                   # Shared TypeScript types
│   │   ├── utils.ts                   # Formatting helpers
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx            # Navigation sidebar
│   │   │   └── TopBar.tsx             # Top bar with server selector
│   │   ├── components/
│   │   │   ├── CircularGauge.tsx      # SVG radial gauge for CPU/memory/disk
│   │   │   ├── HistoryChart.tsx       # 1-hour time-series line chart
│   │   │   ├── Sparkline.tsx          # Inline mini sparkline for server cards
│   │   │   ├── Badges.tsx             # Severity/status badge components
│   │   │   └── Skeleton.tsx           # Loading skeleton placeholders
│   │   └── pages/
│   │       ├── OverviewPage.tsx       # Cluster stats + server card grid with sparklines (~256 lines)
│   │       ├── ServerDetailPage.tsx   # Per-server gauges, 1-hr history charts, container table (~419 lines)
│   │       ├── AlertsPage.tsx         # Alert list with AI summary badges, acknowledge action (~279 lines)
│   │       ├── ContainersPage.tsx     # Cross-server Docker container table (~106 lines)
│   │       └── SettingsPage.tsx       # Config display + test-alert trigger (~157 lines)
│   ├── index.html                     # HTML template
│   ├── Dockerfile                     # Multi-stage: Vite build → Nginx serve
│   ├── package.json                   # Frontend dependencies
│   ├── vite.config.ts                 # Dev server config with /api proxy to server:3200
│   ├── nginx.conf                     # SPA routing + /api reverse proxy config
│   ├── tailwind.config.js             # Tailwind configuration
│   ├── postcss.config.js              # PostCSS pipeline config
│   └── tsconfig.json                  # TypeScript config
│
├── docker-compose.yml                  # Production orchestration: postgres, server, web, agent
├── fenris.yaml                         # Main server runtime config (gitignored — not in repo)
├── fenris.yaml.example                 # Config template with all options documented
├── fenris-agent.yaml.example           # Agent config template
├── .env.example                        # Environment variable template
├── install.sh                          # Full-stack one-liner installer (server + agent)
├── install-agent.sh                    # Agent-only one-liner installer (for remote hosts)
├── README.md                           # User-facing quick-start guide
├── CHANGELOG.md                        # Release change log
├── PROJECT.md                          # High-level project vision/goals
├── fenris.code-workspace               # VS Code workspace settings
└── .gitignore                          # Git ignore rules
```

---

## 2. Architecture

### High-Level Data Flow

```
┌──────────────────────────────┐
│  Fenris Agent (per host)      │
│  system.ts + docker.ts        │
│  Collects every 30s           │
│  Sends host_ip in payload     │
│  Buffers up to 100 snapshots  │
└─────────────┬────────────────┘
              │ HTTP POST /api/v1/metrics
              │ Header: X-API-Key
              │ Body: { server_name, host_ip, metrics[] }
              │
┌─────────────▼────────────────────────────────────────┐
│  Fenris Server (central)                              │
│                                                       │
│  ┌──────────────┐   ┌──────────────────────────────┐  │
│  │ Fastify API  │   │ Anomaly Detection             │  │
│  │ :3200        │──▶│ Z-score, window=100           │  │
│  └──────┬───────┘   │ Skips network metrics         │  │
│         │           └──────────────┬───────────────┘  │
│         │                          │                   │
│  ┌──────▼───────┐   ┌──────────────▼───────────────┐  │
│  │  PostgreSQL  │   │  Alert Dispatcher             │  │
│  │  metrics     │   │  Discord/Slack/Email (fanout) │  │
│  │  alerts      │   └──────────────────────────────┘  │
│  │  alert_sum.. │                                      │
│  │  servers     │   ┌──────────────────────────────┐  │
│  └──────────────┘   │  Predictor (background job)  │  │
│                     │  Linear regression, 5-min     │  │
│                     │  Disk/CPU/memory horizons     │  │
│                     └──────────────────────────────┘  │
│                                                       │
│                     ┌──────────────────────────────┐  │
│                     │  AI Summarizer (optional)     │  │
│                     │  OpenAI-compatible API        │  │
│                     │  Batches alerts per server    │  │
│                     └──────────────────────────────┘  │
└───────────┬──────────────────────────────────────────┘
            │ HTTP REST API
            │ Header: X-API-Key
            │
┌───────────▼──────────────────────────────┐
│  Web Dashboard (Nginx)                    │
│  React multi-page SPA + Tailwind :8081    │
│  Overview / Server Detail / Alerts /      │
│  Containers / Settings pages              │
│  Polls API every 30s                      │
└──────────────────────────────────────────┘
```

### Component Responsibilities

**Agent**
- Collects system metrics via `systeminformation`: CPU usage, load average, memory, disk, network
- Collects Docker stats via `dockerode` if `/var/run/docker.sock` is available
- Sends `host_ip` (detected from network interfaces) in every payload so the server stores the correct IP instead of the Docker-internal gateway address
- Buffers up to 100 metric snapshots in memory when server is unreachable
- Retries with exponential backoff (5 s → 5 min cap)
- Auto-identifies itself by `server_name` in the POST payload
- Config: YAML file or env vars; falls back to hostname

**Server**
- Fastify HTTP server on port 3200; `logger: true` enables pino-based structured logging
- Auth hook gates all `/api/` routes on `X-API-Key` header (compared against DB `servers.api_key`)
- `POST /api/v1/metrics`: upserts agent record (using `host_ip`), stores metric batch, runs anomaly detection
- Anomaly detection: Z-score against last 100 samples; network metrics are explicitly skipped; alerts if |z| > threshold and n ≥ min_samples
- Default anomaly thresholds in `fenris.yaml.example`: `zscore_threshold: 3.0`, `min_samples: 30` (production `fenris.yaml` may override these)
- Alert cooldown: 15 min per `(server_id, metric_type)` — scoped correctly, not per raw message text
- Alert dispatch: concurrent fan-out to configured channels
- **Predictor** (background job, runs every 5 min): linear regression over recent samples; fires pre-emptive alerts when projected value will breach a threshold within a configurable horizon (disk: days, CPU/memory: hours); per-metric cooldowns (1 h CPU/memory, 6 h disk)
- **Summarizer** (optional, event-driven): batches alerts per server over a 2-min window, then calls an OpenAI-compatible API to generate an incident narrative; persists result in `alert_summaries`; rate-limited to `max_calls_per_hour`; 15-min per-server cooldown
- Retention cron: runs hourly, deletes metrics > 30 days and alerts > 90 days
- Default seed: server row `(id=1, name='local', api_key='local-default-key')` inserted on schema init

**Web Dashboard**
- Full multi-page React SPA (rewritten from single 568-line component)
- Pages: Overview (cluster stats, server card grid with sparklines), Server Detail (circular gauges, 1-hr history charts, container table), Alerts (list with AI summary badges, acknowledge), Containers (cross-server Docker table), Settings (config display, test-alert button)
- Shared `api.ts` module centralises all fetch calls
- Layout: persistent sidebar nav + top bar with server selector
- Polls every 30 s via native `fetch`; `VITE_API_KEY` baked into bundle at build time

**PostgreSQL**
- `postgres:15-alpine`, persistent volume `fenris-postgres-data`
- Schema applied at server startup from `schema.sql` (idempotent `IF NOT EXISTS`)
- Includes live migration blocks (ALTER TABLE inside `DO $$ BEGIN … END $$`) for additive schema changes
- No migration framework; schema versioning is manual

### External Service Integrations

| Service | Config Key | Protocol | Direction |
|---------|-----------|----------|-----------|
| Discord | `discord.webhook_url` | HTTPS POST | Outbound (alerts) |
| Slack | `slack.webhook_url` | HTTPS POST | Outbound (alerts) |
| SMTP / Email | `email.smtp_host/port/username/password` | SMTP | Outbound (alerts) |
| OpenAI (or compatible) | `ai.api_url` + `ai.api_key` | HTTPS POST | Outbound (AI summaries) |
| Docker daemon | `/var/run/docker.sock` | Unix socket | Local (agent metrics) |

---

## 3. Dependencies

### Server (`server/package.json`)

| Package | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `fastify` | ^5.0.0 | HTTP server framework | Core |
| `@fastify/cors` | ^10.0.0 | CORS middleware | Active |
| `@fastify/env` | ^4.0.0 | Env var validation | Imported; still not registered via `server.register()` — effectively unused |
| `pg` | ^8.11.0 | PostgreSQL client (Pool) | Core |
| `dockerode` | ^4.0.10 | Docker API client | Used in server/src/collectors/ (dead code after self-collection removal) |
| `systeminformation` | ^5.22.0 | System metrics | Server/src/collectors/ (dead code); used actively in agent |
| `js-yaml` | ^4.1.0 | YAML config parser | Active |
| `node-fetch` | ^3.3.2 | HTTP client for webhooks + AI API calls | Active |
| `nodemailer` | ^8.0.3 | SMTP email dispatch | Active |
| `pino` | ^9.0.0 | Structured logger | Active — used via Fastify's built-in logger (`logger: true`); standalone `console.log` calls also remain |

Dev: `tsup ^8.3.0`, `typescript ^5.5.0`

### Agent (`agent/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `dockerode` | ^4.0.10 | Docker container stats |
| `systeminformation` | ^5.22.0 | CPU, memory, disk, network |
| `js-yaml` | ^4.1.0 | YAML config parsing |
| `node-fetch` | ^3.3.2 | HTTP POST to server |

Dev: `tsup ^8.3.0`, `typescript ^5.5.0`

### Web (`web/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^18.3.0 | UI framework |
| `react-dom` | ^18.3.0 | DOM renderer |
| `tailwindcss` | ^3.4.0 | Utility-first CSS |
| `vite` | ^5.3.0 | Dev server + build bundler |
| `@vitejs/plugin-react` | ^4.3.0 | Vite React plugin |
| `autoprefixer` | ^10.4.0 | CSS vendor prefixing |
| `postcss` | ^8.4.0 | CSS processor |
| `typescript` | ^5.5.0 | Type checking |

Notes: No HTTP client (native `fetch`), no state management library, no testing libraries.

### Flagged Issues

- `@fastify/env` — declared and imported, but `server.register(env, …)` is never called; safe to remove
- `server/src/collectors/` — dead code left over from the pre-agent self-collection era; `index.ts` no longer imports either file
- `pino` is now partially adopted (via Fastify's built-in logger); direct `console.log` calls remain throughout routes and engine code

---

## 4. Database & State

### Tables

**`servers`** — registered agent identities
```sql
CREATE TABLE servers (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  ip_address      VARCHAR(45)  NOT NULL,
  api_key         VARCHAR(64)  NOT NULL,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  last_heartbeat  TIMESTAMPTZ,
  UNIQUE (api_key, name)
);
```
- Auto-upserted on `POST /api/v1/metrics` using `ON CONFLICT (api_key, name) DO UPDATE SET ip_address = …`
- `ip_address` populated from agent-reported `host_ip` (accurate since fix `42cd528`)
- `last_heartbeat` updated on every metric batch received
- Default seed row: `(id=1, 'local', '127.0.0.1', 'local-default-key')`
- Schema includes a live migration block to drop old individual unique constraints and add composite `(api_key, name)` constraint

**`metrics`** — time-series metric storage
```sql
CREATE TABLE metrics (
  id          SERIAL PRIMARY KEY,
  server_id   INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  metric_type VARCHAR(50) NOT NULL,
  value       JSONB NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Indexes:
- `idx_metrics_server_id` on `(server_id)`
- `idx_metrics_type` on `(metric_type)`
- `idx_metrics_timestamp` on `(timestamp DESC)`
- `idx_metrics_server_timestamp` on `(server_id, timestamp DESC)` — main query index
- `idx_metrics_docker_containers` GIN on `(value)` where `metric_type = 'docker'`

Metric type → JSONB value shapes:

| `metric_type` | JSONB value |
|---------------|-------------|
| `cpu` | `{"cpu": {"usage_percent": float, "load_avg": [1m, 5m, 15m]}}` |
| `memory` | `{"memory": {"used_percent": float, "total_gib": float, "available_gib": float, "used_gib": float}}` |
| `disk` | `{"disk": {"path": str, "used_percent": float, "total_gb": float, "used_gb": float, "available_gb": float}}` |
| `network` | `{"network": {"interface": str, "rx_bytes": int, "tx_bytes": int, "rx_sec": float, "tx_sec": float}}` |
| `docker` | `{"docker": [{"name": str, "image": str, "state": str, "cpu_percent": float, "memory_mb": float, ...}]}` |

**`alerts`** — generated anomaly/threshold/prediction alerts
```sql
CREATE TABLE alerts (
  id               SERIAL PRIMARY KEY,
  server_id        INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  severity         VARCHAR(20) CHECK (severity IN ('info', 'warning', 'critical')),
  message          TEXT NOT NULL,
  metric_type      VARCHAR(50),
  threshold_value  JSONB,
  actual_value     JSONB,
  acknowledged     BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  summary_id       INTEGER REFERENCES alert_summaries(id) ON DELETE SET NULL  -- added via live migration
);
```

Indexes: `idx_alerts_server_id`, `idx_alerts_severity`, `idx_alerts_acknowledged`, `idx_alerts_timestamp`

**`alert_summaries`** — AI-generated incident narratives
```sql
CREATE TABLE alert_summaries (
  id         SERIAL PRIMARY KEY,
  server_id  INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  alert_ids  INTEGER[] NOT NULL,
  summary    TEXT NOT NULL,
  model      VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```
- Each row covers a batch of alerts for one server
- `alerts.summary_id` FK links individual alerts back to their summary
- Indexes: `idx_summaries_server_id`, `idx_summaries_created_at`

### Migration Status

- No migration framework (no Flyway, Liquibase, node-pg-migrate, etc.)
- Schema applied via `schema.sql` at server startup with `IF NOT EXISTS` guards — safe to re-run
- Additive changes (new columns, tables) handled via inline `DO $$ BEGIN … END $$` migration blocks
- Destructive schema changes still require manual SQL and a full restart

### In-Memory State (Lost on Restart)

- `lastSent: Map<string, number>` in `server/src/alerts/util.ts` — alert cooldown tracker (keyed by `${serverId}:${metricType}`)
- `lastPrediction: Map<string, number>` in `server/src/engine/predictor.ts` — prediction cooldown tracker
- `lastSummarised: Map<number, number>` in `server/src/engine/summarizer.ts` — per-server summarizer cooldown
- `callTimestamps: number[]` in `server/src/engine/summarizer.ts` — rolling hourly API call counter
- Anomaly detection history is re-queried from DB on each computation (survives restarts)

---

## 5. API Surface

All routes served by Fastify on port 3200.

**Auth:** Requests matching `/api/` require `X-API-Key` header equal to a `servers.api_key` value in the database. Non-`/api/` paths are public.

### Public Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness probe — returns `{"status":"healthy","timestamp":"..."}` |
| `GET` | `/api/v1/config` | Filtered server config — strips credentials; used by Settings page |

### Authenticated Routes (`X-API-Key` required)

| Method | Path | Query Params | Purpose |
|--------|------|-------------|---------|
| `POST` | `/api/v1/metrics` | — | Ingest metric batch from agent; upserts server with `host_ip`; triggers anomaly detection |
| `GET` | `/api/v1/servers` | — | List all registered servers |
| `GET` | `/api/v1/metrics` | `server_id`, `metric_type`, `limit` | Recent metrics, optionally filtered |
| `GET` | `/api/v1/servers/:id/metrics` | `metric_type`, `limit` | Metrics for a specific server |
| `GET` | `/api/v1/alerts` | `server_id`, `acknowledged`, `limit` | Alerts with optional filters |
| `POST` | `/api/v1/alerts/:id/acknowledge` | — | Mark alert acknowledged |
| `GET` | `/api/v1/alerts/:id/summary` | — | Fetch AI incident summary for an alert (404 if none generated yet) |
| `GET` | `/api/v1/summaries` | `server_id`, `limit` | List AI summaries, optionally filtered by server |
| `GET` | `/api/v1/docker/containers` | `server_id` | Latest Docker snapshot per server |
| `GET` | `/api/v1/docker/containers/:name/metrics` | `server_id`, `limit` | Container history (50–200 entries) |
| `POST` | `/api/v1/test-alert` | — | Fire test alert through all configured channels; body: `{"channels": [...]}` (optional filter) |

### Key Request/Response Shapes

**`POST /api/v1/metrics`**
```json
// Request
{
  "server_name": "my-host",
  "host_ip": "192.168.1.42",
  "metrics": [
    { "metric_type": "cpu",    "value": { "cpu": { "usage_percent": 45.2, "load_avg": [1.2, 1.5, 1.8] } }, "timestamp": "2026-04-05T12:00:00Z" },
    { "metric_type": "memory", "value": { "memory": { "used_percent": 62, "total_gib": 16 } },             "timestamp": "2026-04-05T12:00:00Z" }
  ]
}

// Response 201
{ "success": true, "server_id": 2, "anomaliesDetected": 0 }
```

**`GET /api/v1/alerts/:id/summary`**
```json
{
  "id": 7,
  "summary": "CPU on web-01 spiked to 94% at 11:52 UTC...",
  "model": "gpt-4o-mini",
  "alert_ids": [42, 43, 44],
  "created_at": "2026-04-05T12:05:00Z"
}
```

**`POST /api/v1/test-alert`**
```json
// Request (optional — omit body to test all configured channels)
{ "channels": ["discord", "slack"] }

// Response
{ "discord": { "success": true }, "slack": { "success": true, "status": 200 } }
```

---

## 6. Environment & Config

### Environment Variables

#### Server

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | No | `postgresql://fenris:fenris@localhost:5432/fenris` | PostgreSQL connection string (overrides YAML) |
| `POSTGRES_PASSWORD` | No | `CHANGE_ME_BEFORE_DEPLOY` | Postgres password (compose override) |
| `PORT` | No | `3200` | HTTP server port |
| `NODE_ENV` | No | `development` | Runtime mode |
| `FENRIS_CONFIG` | No | `/app/fenris.yaml` | Path to server config YAML |

Alert channel credentials, SMTP config, and AI API keys are configured via `fenris.yaml` (not env vars), though `DATABASE_URL` env var overrides the YAML value at startup.

#### Agent

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `FENRIS_API_KEY` | **Yes** | — | API key sent with every metric POST |
| `FENRIS_SERVER_URL` | No | `http://localhost:3200` | Server base URL |
| `FENRIS_SERVER_NAME` | No | `os.hostname()` | Agent identity name |
| `FENRIS_COLLECT_INTERVAL` | No | `30s` | Metric collection interval |
| `FENRIS_DOCKER_ENABLED` | No | `true` | Enable Docker stats collection |
| `FENRIS_DISK_PATHS` | No | `/` | Comma-separated mount paths to monitor |
| `FENRIS_AGENT_CONFIG` | No | `/app/fenris-agent.yaml` | Path to agent config YAML |

#### Frontend (build-time only)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VITE_API_KEY` | No | (hashed default) | API key baked into JS bundle for dashboard requests |

### Config Files

**`fenris.yaml`** — server runtime config (gitignored; copy from `fenris.yaml.example`)

Key sections:
```yaml
anomaly_detection:
  enabled: true
  algorithm: zscore
  zscore_threshold: 3.0   # raise in production to reduce noise (e.g. 3.5)
  window_size: 100
  min_samples: 30         # raise in production (e.g. 60) for cold-start protection

ai:
  enabled: false
  provider: "openai"
  api_url: "https://api.openai.com/v1/chat/completions"
  api_key: ""
  model: "gpt-4o-mini"
  max_calls_per_hour: 10
  batch_window_ms: 120000         # 2-min alert batching window
  cooldown_per_server_ms: 900000  # 15-min per-server summarizer cooldown

retention:
  metrics_days: 30
  alerts_days: 90
```

> **Important:** `js-yaml` does **not** expand `${ENV_VAR}` syntax. All credentials must be written as literal values in `fenris.yaml`. The sole exception is `DATABASE_URL` — `server/src/index.ts` explicitly overrides the YAML value with `process.env.DATABASE_URL` if set.

**`fenris-agent.yaml`** — agent runtime config
```yaml
server_url: http://fenris.example.com:3200
api_key: CHANGE_ME_UNIQUE_PER_HOST
server_name: my-host
collect_interval: 30s
docker_enabled: true
disk_paths: [/, /var/lib/docker, /var/log]
```

### Config Loading Order

- **Server:** YAML file → `process.env.DATABASE_URL` overrides `server.database_url` → hardcoded defaults if YAML missing
- **Agent:** YAML file → env vars → `os.hostname()` / hardcoded defaults

---

## 7. Known Issues

### Dead Code

| Location | Issue |
|----------|-------|
| `server/src/collectors/` | `system.ts` and `docker.ts` are never imported by `index.ts`; left over from pre-agent self-collection era |
| `server/src/index.ts` | `@fastify/env` imported but `server.register(env, …)` never called |
| `server/package.json` | `@fastify/env` declared as dependency but unused at runtime |

### Mixed Logging

Fastify is started with `logger: true` (pino under the hood), providing structured request logs. However, application code in `routes.ts`, `predictor.ts`, `summarizer.ts`, and elsewhere still uses `console.log`/`console.error` directly, producing unstructured output alongside the structured Fastify logs.

### Missing Error Handling

| Location | Issue |
|----------|-------|
| `agent/src/collectors/docker.ts` | Returns `null` silently on Docker API errors; continues without Docker metrics |
| `agent/src/index.ts` | `console.error` on POST failure only; no escalation path |
| `server/src/alerts/email.ts` | SMTP config not validated at startup; errors only surface at send time |
| `server/src/alerts/dispatcher.ts` | No circuit breaker for repeatedly failing external webhooks |
| `server/src/engine/summarizer.ts` | Per-server cooldown and rate-limit state lost on restart; can trigger extra API calls post-restart |

### Logic Issues

| Issue | Location | Detail |
|-------|----------|--------|
| Alert cooldown lost on restart | `util.ts`, `predictor.ts`, `summarizer.ts` | All in-memory cooldown maps reset on every restart |
| No metric deduplication | `server/src/api/routes.ts` | Agent retry after network timeout can insert duplicate rows |
| YAML `${ENV_VAR}` not expanded | `server/src/index.ts` | `js-yaml` treats `${...}` as literal string; only `DATABASE_URL` is specially handled |
| Z-score cold start | `server/src/engine/anomaly.ts` | Detection inactive until `min_samples` reached (≥15 min at default 30; ≥30 min at recommended 60) |
| Fixed anomaly window | `server/src/engine/anomaly.ts` | 100-sample window; no time-of-day or seasonal awareness |
| Docker container exclusion hardcoded | `server/src/api/routes.ts` | `DOCKER_EXCLUDED = ['fenris-server', 'fenris-web', 'fenris-postgres']`; not configurable |
| Prediction state not persisted | `server/src/engine/predictor.ts` | `lastPrediction` Map resets on restart; may fire duplicate prediction alerts |

### Security Concerns

| Severity | Issue | Location |
|----------|-------|----------|
| High | Default API key `local-default-key` seeded in DB and used as `VITE_API_KEY` default | `schema.sql`, `docker-compose.yml` |
| High | `VITE_API_KEY` baked into JS bundle at build time — readable in browser devtools | `web/vite.config.ts`, `web/src/api.ts` |
| High | `ai.api_key` written as plaintext in `fenris.yaml` (not gitignored by pattern, only the specific file) | `fenris.yaml` |
| Medium | No HTTPS by default — API key transmitted in plaintext HTTP headers | `docker-compose.yml` |
| Medium | No CSRF protection on state-mutating routes (`POST /api/v1/alerts/:id/acknowledge`, `POST /api/v1/test-alert`) | `server/src/api/routes.ts` |
| Medium | Webhook URLs and SMTP credentials may appear in server logs | `server/src/alerts/dispatcher.ts` |
| Medium | Default DB credentials (`fenris`/`CHANGE_ME_BEFORE_DEPLOY`) in config — easy to deploy without changing | `docker-compose.yml`, `fenris.yaml.example` |
| Low | No API key rotation, expiry, or usage audit log | All |
| Low | No rate limiting on `/api/v1/metrics` — potential DB flood vector | `server/src/api/routes.ts` |
| Low | No validation of metric value ranges (accepts negative %, NaN) | `server/src/api/routes.ts` |
| Low | No multi-tenancy — any valid-key agent can read all servers' metrics | `server/src/api/routes.ts` |

### Frontend Issues

| Issue | Detail |
|-------|--------|
| Silent auth failure | Invalid API key causes fetch to silently fail; user sees indefinite loading spinner |
| Hardcoded poll interval | 30 s polling; not configurable; no WebSocket/SSE push |
| `ServerDetailPage.tsx` size | 419 lines — a candidate for sub-component extraction |

---

## 8. Test Coverage

**Current status: Zero.**

- No test files (`*.test.ts`, `*.spec.ts`, `*.test.tsx`) anywhere in the repository
- No test runner configured (no `jest.config.js`, `vitest.config.ts`, etc.)
- No `test` script in any `package.json`

### Untested Critical Paths

| Component | Path |
|-----------|------|
| `server/src/engine/anomaly.ts` | Z-score calculation, edge cases (empty window, uniform values, network skip) |
| `server/src/engine/predictor.ts` | Linear regression accuracy, cooldown logic, threshold projection |
| `server/src/engine/summarizer.ts` | Batching logic, rate limit enforcement, API error handling |
| `server/src/alerts/dispatcher.ts` | Concurrent dispatch, partial failure, test-alert path |
| `server/src/alerts/util.ts` | Cooldown scoping, severity formatting |
| `server/src/api/routes.ts` | Metric ingestion, server upsert with `host_ip`, auth hook |
| `server/src/db/schema.sql` | Schema idempotency; live migration correctness |
| `agent/src/collectors/system.ts` | Metric shape correctness |
| `agent/src/collectors/docker.ts` | Docker-unavailable fallback behavior |
| `agent/src/index.ts` | Buffer-and-retry logic under network failures |

---

## 9. Build & Deploy

### Dockerfiles

**`server/Dockerfile`**
- Base: `node:22-alpine`
- Installs pnpm, runs `pnpm install`, builds via `tsup` → `dist/index.js`
- Copies `src/db/schema.sql` alongside bundle
- Non-root user: `fenris` (uid 1001)
- Exposes port 3200
- Health check: Node.js `fetch('http://127.0.0.1:3200/health')` (replaced wget in `e4a955cf`)

**`agent/Dockerfile`**
- Base: `node:22-alpine`
- Same build pipeline as server
- Non-root user: `fenris-agent`
- No exposed port (outbound HTTP only)
- No health check

**`web/Dockerfile`**
- Stage 1 (`builder`): `node:22-alpine`, runs Vite build with `VITE_API_KEY` build arg
- Stage 2: `nginx:alpine`, copies built assets and `nginx.conf`
- Exposes port 80
- No health check

### `docker-compose.yml`

| Service | Image/Build | Ports | Key Config |
|---------|-------------|-------|-----------|
| `postgres` | `postgres:15-alpine` | 5432 (internal) | healthcheck: `pg_isready -U fenris`; password defaults to `CHANGE_ME_BEFORE_DEPLOY` |
| `server` | `./server` (build) | `3200:3200` | depends_on postgres (healthy); mounts docker.sock; `DOCKER_GID` via env |
| `web` | `./web` (build) | `8081:80` | depends_on server; `VITE_API_KEY` passed as build arg |
| `agent` | `./agent` (build) | none | depends_on server; restart: unless-stopped; mounts docker.sock |

Volumes:
- `fenris-postgres-data` — PostgreSQL data persistence
- `fenris-logs` — server log output at `/app/logs`
- `./agent-local/fenris-agent.yaml` → `/app/fenris-agent.yaml:ro`
- `/var/run/docker.sock` → read-only into `server` and `agent`

Network: `fenris` bridge (all containers)

### Install Scripts

**`install.sh`** — full-stack installer (server + agent on a single host)
- Checks prerequisites (Docker, Docker Compose v2, Git)
- Sparse-clones from GitHub
- Prompts for configuration and writes `fenris.yaml` and `agent-local/fenris-agent.yaml`
- Builds and starts the full compose stack

**`install-agent.sh`** — remote agent-only installer (run on each monitored host)
- Checks prerequisites, prompts for server URL (prepends `http://` if no scheme given), API key, server name, Docker monitoring toggle
- Auto-detects Docker socket GID
- Sparse-clones just `agent/` from GitHub
- Writes `fenris-agent.yaml` and a self-contained `docker-compose.yml`
- Builds and starts the agent container; tails logs to confirm first POST

### Build Commands

```bash
# Development
cd server && pnpm run dev    # watch + rebuild
cd agent  && pnpm run dev    # watch + rebuild
cd web    && pnpm run dev    # Vite dev server on :5173 (proxies /api → :3200)

# Production
docker compose up -d         # build all images, start all services
docker compose up -d --build # force rebuild

# Individual
cd server && pnpm run build  # tsup → dist/index.js
cd agent  && pnpm run build  # tsup → dist/index.js
cd web    && pnpm run build  # vite → dist/
```

### Startup Sequence
1. `postgres` starts → health check passes (`pg_isready`)
2. `server` starts → applies schema + migrations → seeds default server row → starts predictor and summarizer (if configured) → Fastify ready
3. `web` starts → Nginx serves pre-built static assets, proxies `/api/`
4. `agent` starts → loads config → begins collection loop → POSTs to `server:3200`

### CI/CD
**None present.** No `.github/workflows/`, no `Jenkinsfile`, no `.gitlab-ci.yml`. No linting, type-check, or test automation configured.

---

## 10. Summary & Recommendations

### What Has Been Built

Since the initial architecture was established, the following have been completed:

- **Multi-page web dashboard** — full rewrite from a 568-line monolith into a proper page/component structure with per-server detail views, circular gauges, sparklines, history charts, and a settings page
- **AI incident summaries** — OpenAI-compatible integration that batches alerts per server and generates readable incident narratives; stored in DB and surfaced on the Alerts page
- **Linear regression predictor** — background job that projects CPU, memory, and disk trends and fires pre-emptive alerts before thresholds are breached
- **Test-alert endpoint + UI button** — `POST /api/v1/test-alert` fires a real test through all configured channels; wired into the Settings page
- **Remote agent installer** — `install-agent.sh` one-liner handles prerequisites, config prompting, GID detection, sparse-clone, and container startup
- **Alert noise reduction** — network metrics excluded from z-score detection; configurable min_samples and zscore_threshold
- **Accurate IP tracking** — agent now reports its own `host_ip` instead of relying on the server to infer it from the Docker gateway address
- **Healthcheck fix** — server container healthcheck uses Node.js `fetch` instead of `wget` (not installed in the Alpine image)

### Strengths
- Clean three-tier separation: agent → server → web
- Zero-config agent self-registration
- Multi-channel alert dispatch (Discord, Slack, Email) with per-server/metric-type cooldown
- Z-score anomaly detection + linear regression prediction in parallel
- Optional AI incident summaries with rate limiting and batching
- Idempotent schema initialization with inline migration support
- One-liner deployment for both full stack and remote agents
- Docker-native deployment with minimal host dependencies

### Priority Recommendations

**P0 — Security (before any external exposure)**
1. Replace hardcoded default key `local-default-key` with a required env var; fail fast on startup if unset
2. Move `VITE_API_KEY` to runtime: serve it via `/api/v1/config` instead of baking it into the JS bundle
3. Add TLS/HTTPS termination (Nginx with cert or Caddy in front of the stack)
4. Redact secrets (webhook URLs, SMTP/AI credentials) from all server log output

**P1 — Reliability**
5. Persist cooldown state to DB (alerts, predictor, summarizer) — prevents post-restart notification storms
6. Add idempotency key to metric POST to prevent duplicate rows on agent retry
7. Validate SMTP and AI config at startup; surface misconfiguration early
8. Add a circuit breaker for external webhook/AI API failures

**P2 — Observability**
9. Replace direct `console.log`/`console.error` calls with the Fastify logger (`request.log` / `server.log`) to unify output as structured JSON
10. Add request/response middleware logging (method, path, status, latency) via a Fastify plugin
11. Remove or adopt `@fastify/env` for environment variable schema validation at startup

**P3 — Maintainability**
12. Delete `server/src/collectors/` — dead code since self-collection was removed
13. Remove `@fastify/env` from `package.json` or register it
14. Add tests: start with `anomaly.ts` and `predictor.ts` (pure functions, high value), then API route integration tests
15. Add a migration framework (e.g., `node-pg-migrate`) for safe schema evolution; replace inline `DO $$ BEGIN` blocks
16. Add CI pipeline with lint + type-check + test steps

**P4 — Features / Polish**
17. Show auth error state in web dashboard when API key is rejected (currently silent loading)
18. Make excluded Docker containers configurable via `fenris.yaml`
19. Add WebSocket or SSE for real-time dashboard updates (replace 30 s polling)
20. Add rate limiting on `/api/v1/metrics` to prevent DB flood
21. Extract `ServerDetailPage.tsx` sub-components (419 lines)
22. Add a `/api/v1/predictions` endpoint to surface predictor projections in the dashboard

---

*Generated by automated audit — verify all findings against current source before acting.*
