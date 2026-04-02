# Fenris Project Audit

**Date:** 2026-04-01  
**Audited by:** Claude Code (claude-sonnet-4-6)  
**Branch:** master  

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
│   └── fenris-agent.yaml              # Concrete agent config for the compose environment
│
├── server/                             # Central monitoring hub — runs once, receives all agents
│   ├── src/
│   │   ├── index.ts                   # Fastify server setup, route registration, DB init, retention job
│   │   ├── types.ts                   # TypeScript types: Config, Metric, Alert, Server
│   │   ├── api/
│   │   │   └── routes.ts              # All HTTP endpoints: metric ingestion, queries, alerts
│   │   ├── db/
│   │   │   ├── client.ts              # PostgreSQL pool, query wrapper with logging
│   │   │   └── schema.sql             # DB schema: CREATE TABLE/INDEX statements (idempotent)
│   │   ├── engine/
│   │   │   └── anomaly.ts             # Z-score anomaly detection algorithm
│   │   └── alerts/
│   │       ├── dispatcher.ts          # Alert router: calls Discord/Slack/Email in parallel
│   │       ├── discord.ts             # Discord incoming webhook integration
│   │       ├── slack.ts               # Slack incoming webhook integration
│   │       ├── email.ts               # SMTP email alerts via nodemailer
│   │       └── util.ts                # Alert formatting, severity colors, 5-min cooldown state
│   ├── Dockerfile                     # Alpine Node.js, non-root user, health check via wget
│   ├── package.json                   # Server dependencies
│   ├── pnpm-lock.yaml                 # Locked dependency versions
│   ├── tsconfig.json                  # TypeScript config
│   └── tsup.config.ts                 # Build config
│
├── web/                                # React dashboard frontend
│   ├── src/
│   │   ├── App.tsx                    # Main/only component: metrics, alerts, server selector, charts
│   │   ├── main.tsx                   # React DOM entry point
│   │   └── index.css                  # Tailwind base + custom styles
│   ├── index.html                     # HTML template
│   ├── Dockerfile                     # Multi-stage: Vite build → Nginx serve
│   ├── package.json                   # Frontend dependencies
│   ├── vite.config.ts                 # Dev server config with /api proxy to server:3200
│   ├── nginx.conf                     # SPA routing + /api reverse proxy config
│   ├── tailwind.config.js             # Tailwind configuration
│   ├── postcss.config.js              # PostCSS pipeline config
│   └── tsconfig.json                  # TypeScript config
│
├── web.disabled/                       # Deleted frontend variant (git-tracked deletions pending)
│   └── ...                            # (Dockerfile, index.html, nginx.conf, package.json, src/ — deleted)
│
├── docker-compose.yml                  # Production orchestration: postgres, server, web, agent
├── fenris.yaml                         # Main server runtime config (alerts, thresholds, anomaly params)
├── fenris.yaml.example                 # Config template with all options documented
├── fenris-agent.yaml.example           # Agent config template
├── .env.example                        # Environment variable template
├── README.md                           # User-facing quick-start guide
├── PROJECT.md                          # High-level project vision/goals
├── fenris.code-workspace               # VS Code workspace settings
├── .gitignore                          # Git ignore rules
└── antfarm-request.txt                 # External request log (historical artifact)
```

---

## 2. Architecture

### High-Level Data Flow

```
┌──────────────────────────────┐
│  Fenris Agent (per host)      │
│  system.ts + docker.ts        │
│  Collects every 30s           │
│  Buffers up to 100 snapshots  │
└─────────────┬────────────────┘
              │ HTTP POST /api/v1/metrics
              │ Header: X-API-Key
              │
┌─────────────▼────────────────────────────────┐
│  Fenris Server (central)                      │
│                                               │
│  ┌──────────────┐   ┌──────────────────────┐  │
│  │ Fastify API  │   │ Anomaly Detection     │  │
│  │ :3200        │──▶│ Z-score, window=100   │  │
│  └──────┬───────┘   └──────────┬───────────┘  │
│         │                      │               │
│  ┌──────▼───────┐   ┌──────────▼───────────┐  │
│  │  PostgreSQL  │   │  Alert Dispatcher     │  │
│  │  metrics     │   │  Discord/Slack/Email  │  │
│  │  alerts      │   └──────────────────────┘  │
│  │  servers     │                              │
│  └──────────────┘                              │
└───────────┬──────────────────────────────────-┘
            │ HTTP REST API
            │ Header: X-API-Key
            │
┌───────────▼──────────────┐
│  Web Dashboard (Nginx)    │
│  React + Tailwind :8081   │
│  Polls API every 30s      │
│  View metrics/alerts      │
└──────────────────────────┘
```

### Component Responsibilities

**Agent**
- Collects system metrics via `systeminformation`: CPU usage, load average, memory, disk, network
- Collects Docker stats via `dockerode` if `/var/run/docker.sock` is available
- Buffers up to 100 metric snapshots in memory when server is unreachable
- Retries with exponential backoff (5 s → 5 min cap)
- Auto-identifies itself by `server_name` in the POST payload
- Config: YAML file or env vars; falls back to hostname

**Server**
- Fastify HTTP server on port 3200
- Auth hook gates all `/api/` routes on `X-API-Key` header (compared against DB `servers.api_key`)
- `POST /api/v1/metrics`: upserts agent record, stores metric batch, runs anomaly detection
- Anomaly detection: computes Z-score against last 100 samples; alerts if |z| > 3.0 and n >= 30
- Alert dispatch: concurrent fan-out to configured channels; 5-min in-memory cooldown per message
- Retention cron: runs hourly, deletes metrics > 30 days and alerts > 90 days
- Default seed: server row `(id=1, name='local', api_key='local-default-key')` inserted on schema init

**Web Dashboard**
- Single-page React app (single component `App.tsx`, ~568 lines)
- Polls `/api/v1/servers`, `/api/v1/metrics`, `/api/v1/alerts`, `/api/v1/docker/containers` every 30 s
- Uses `VITE_API_KEY` build-time env var as the API key for all requests
- Nginx serves static assets and proxies `/api/` to `server:3200`

**PostgreSQL**
- `postgres:15-alpine`, persistent volume `fenris-postgres-data`
- Schema applied at server startup from `schema.sql` (idempotent `IF NOT EXISTS`)
- No migration framework; schema versioning is manual

### External Service Integrations

| Service | Config Key | Protocol | Direction |
|---------|-----------|----------|-----------|
| Discord | `DISCORD_WEBHOOK_URL` | HTTPS POST | Outbound (alerts) |
| Slack | `SLACK_WEBHOOK_URL` | HTTPS POST | Outbound (alerts) |
| SMTP / Email | `SMTP_HOST/PORT/USER/PASS` | SMTP | Outbound (alerts) |
| Docker daemon | `/var/run/docker.sock` | Unix socket | Local (metrics) |

---

## 3. Dependencies

### Server (`server/package.json`)

| Package | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `fastify` | ^5.0.0 | HTTP server framework | Core |
| `@fastify/cors` | ^10.0.0 | CORS middleware | Active |
| `@fastify/env` | ^4.0.0 | Env var validation | **Unused** — imported but never registered |
| `pg` | ^8.11.0 | PostgreSQL client (Pool) | Core |
| `dockerode` | ^4.0.10 | Docker API client | Used in metrics collection |
| `systeminformation` | ^5.22.0 | System metrics | Also listed in server, used primarily in agent |
| `js-yaml` | ^4.1.0 | YAML config parser | Active |
| `node-fetch` | ^3.3.2 | HTTP client for webhooks | Active |
| `nodemailer` | ^8.0.3 | SMTP email dispatch | Active |
| `pino` | ^9.0.0 | Structured logger | **Unused** — imported but `console.log` used everywhere |

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

- `@fastify/env` — declared, never used; safe to remove
- `pino` — declared, never used; remove or adopt (replace `console.log`)
- `typescript` as dev dep in all three packages — expected, correct

---

## 4. Database & State

### Tables

**`servers`** — registered agent identities
```sql
CREATE TABLE servers (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  ip_address      VARCHAR(45)  NOT NULL,
  api_key         VARCHAR(64)  NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  last_heartbeat  TIMESTAMPTZ,
  UNIQUE (api_key, name)
);
```
- Auto-upserted on `POST /api/v1/metrics` using `ON CONFLICT (api_key, name)`
- `last_heartbeat` updated on every metric batch received
- Default seed row: `(id=1, 'local', '127.0.0.1', 'local-default-key')`

**`metrics`** — time-series metric storage
```sql
CREATE TABLE metrics (
  id          SERIAL PRIMARY KEY,
  server_id   INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  metric_type VARCHAR(50) NOT NULL,
  value       JSONB NOT NULL,
  timestamp   TIMESTAMPTZ DEFAULT NOW()
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

**`alerts`** — generated anomaly/threshold alerts
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
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
```

Indexes: `idx_alerts_server_id`, `idx_alerts_severity`, `idx_alerts_acknowledged`, `idx_alerts_timestamp`

### Migration Status

- No migration framework (no Flyway, Liquibase, node-pg-migrate, etc.)
- Schema applied via `schema.sql` at server startup with `IF NOT EXISTS` guards — safe to re-run, not safe to roll back
- Schema changes require manual SQL authoring and server restart

### In-Memory State (Lost on Restart)

- `lastSent: Map<string, number>` in `server/src/alerts/util.ts` — alert cooldown tracker
- Anomaly detection history is re-queried from DB on each computation (not lost on restart)

---

## 5. API Surface

All routes served by Fastify on port 3200.

**Auth:** Requests matching `/api/` require `X-API-Key` header equal to a `servers.api_key` value in the database. Non-`/api/` paths are public.

### Public Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness probe — returns `{"status":"ok"}` |
| `GET` | `/api/v1/config` | Filtered server config — strips credentials; used by web dashboard |

### Authenticated Routes (`X-API-Key` required)

| Method | Path | Query Params | Purpose |
|--------|------|-------------|---------|
| `POST` | `/api/v1/metrics` | — | Ingest metric batch from agent; upserts server; triggers anomaly detection |
| `GET` | `/api/v1/servers` | — | List all registered servers |
| `GET` | `/api/v1/metrics` | `server_id`, `metric_type`, `limit` | Recent metrics, optionally filtered |
| `GET` | `/api/v1/servers/:id/metrics` | `metric_type`, `limit` | Metrics for a specific server |
| `GET` | `/api/v1/alerts` | `server_id`, `acknowledged`, `limit` | Alerts with optional filters |
| `POST` | `/api/v1/alerts/:id/acknowledge` | — | Mark alert acknowledged |
| `GET` | `/api/v1/docker/containers` | `server_id` | Latest Docker snapshot per server |
| `GET` | `/api/v1/docker/containers/:name/metrics` | `server_id`, `limit` | Container history (50–200 entries) |

### Key Request/Response Shapes

**`POST /api/v1/metrics`**
```json
// Request
{
  "server_name": "my-host",
  "metrics": [
    { "metric_type": "cpu",    "value": { "cpu": { "usage_percent": 45.2, "load_avg": [1.2, 1.5, 1.8] } }, "timestamp": "2025-04-01T12:00:00Z" },
    { "metric_type": "memory", "value": { "memory": { "used_percent": 62, "total_gib": 16 } },             "timestamp": "2025-04-01T12:00:00Z" }
  ]
}

// Response 201
{ "success": true, "server_id": 2, "anomaliesDetected": 0 }
```

**`GET /api/v1/alerts?limit=30`**
```json
[
  {
    "id": 1, "server_id": 1, "server_name": "local",
    "severity": "warning", "message": "CPU anomaly detected",
    "metric_type": "cpu",
    "threshold_value": { "zscore": 3.5 },
    "actual_value": { "value": 92.5 },
    "acknowledged": false,
    "created_at": "2025-04-01T12:05:00Z"
  }
]
```

---

## 6. Environment & Config

### Environment Variables

#### Server

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | No | `postgresql://fenris:fenris@localhost:5432/fenris` | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | No | `fenris` | Postgres password (compose override) |
| `PORT` | No | `3200` | HTTP server port |
| `NODE_ENV` | No | `development` | Runtime mode |
| `DISCORD_WEBHOOK_URL` | No | — | Discord alert webhook (disabled if unset) |
| `SLACK_WEBHOOK_URL` | No | — | Slack alert webhook (disabled if unset) |
| `SMTP_HOST` | No | — | Email SMTP host |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USERNAME` | No | — | SMTP auth username |
| `SMTP_PASSWORD` | No | — | SMTP auth password |
| `ALERT_FROM` | No | — | Email sender address |
| `ALERT_TO` | No | — | Email recipient address |
| `DOCKER_GID` | No | — | Docker socket GID for container access |
| `FENRIS_CONFIG` | No | `/app/fenris.yaml` | Path to server config YAML |

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
| `VITE_API_KEY` | No | `local-default-key` | API key baked into JS bundle for dashboard requests |

### Config Files

**`fenris.yaml`** — server runtime config
```yaml
server:
  port: 3200
  database_url: postgresql://fenris:${POSTGRES_PASSWORD}@postgres:5432/fenris

monitors:
  system:
    enabled: true
    scrape_interval: 30s
    metrics: [cpu, memory, disk, network]
  disk:
    paths:
      - { path: /, name: root, warning_threshold: 85, critical_threshold: 95 }

alerts:
  discord:
    enabled: true
    webhook_url: ${DISCORD_WEBHOOK_URL}      # NOTE: NOT expanded by js-yaml — see below
    severity_levels: [info, warning, critical]
  thresholds:
    cpu:    { warning: 75, critical: 95 }
    memory: { warning: 80, critical: 90 }
    disk:   { warning: 85, critical: 95 }

anomaly_detection:
  enabled: true
  algorithm: zscore
  zscore_threshold: 3.0
  window_size: 100
  min_samples: 30

retention:
  metrics_days: 30
  alerts_days: 90
```

> **Important:** `js-yaml` does **not** expand `${ENV_VAR}` syntax. The `${DISCORD_WEBHOOK_URL}` shown above is a literal string — env vars must be set independently and are read via `process.env` in code. Documented as a known limitation with a comment in the source.

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

- **Server:** YAML file → env vars override selected fields → hardcoded defaults
- **Agent:** YAML file → env vars → `os.hostname()` / hardcoded defaults

---

## 7. Known Issues

### Dead Code

| Location | Issue |
|----------|-------|
| `server/src/index.ts` | `pino` imported, never used; `console.log` used throughout |
| `server/package.json` | `@fastify/env` declared, never registered or called |
| `server/package.json` | `pino` declared, never used |

### TODO / FIXME Comments

None found in application source code.

### Missing Error Handling

| Location | Issue |
|----------|-------|
| `agent/src/collectors/docker.ts` | Returns `null` silently on Docker API errors; continues without Docker metrics |
| `agent/src/index.ts` | `console.error` on POST failure only; no escalation |
| `server/src/alerts/email.ts` | SMTP config not validated at startup; errors only surface at send time |
| `server/src/db/client.ts` | Pool errors logged but not necessarily fatal to request handling |
| `server/src/alerts/dispatcher.ts` | No circuit breaker for failing external webhooks |

### Logic Issues

| Issue | Location | Detail |
|-------|----------|--------|
| Alert cooldown lost on restart | `server/src/alerts/util.ts` | `lastSent` Map is module-level; reset on every restart; can flood channels |
| Alert cooldown not per-server | `server/src/alerts/util.ts` | Cooldown key is raw message text, not `(server_id, metric_type)` |
| Cooldown duration hardcoded | `server/src/alerts/util.ts` | 5 minutes; not configurable |
| Docker container exclusion hardcoded | Server source | `DOCKER_EXCLUDED = ['fenris-server', 'fenris-web', 'fenris-postgres']`; not configurable |
| No metric deduplication | `server/src/api/routes.ts` | Agent retry after network timeout can insert duplicate rows |
| YAML `${ENV_VAR}` not expanded | `server/src/index.ts` | `js-yaml` treats `${...}` as literal string; documented in code comment |
| Z-score cold start | `server/src/engine/anomaly.ts` | Detection inactive until 30 samples (≥15 min of data) |
| Fixed anomaly window | `server/src/engine/anomaly.ts` | 100-sample window; no time-of-day or seasonal awareness |

### Security Concerns

| Severity | Issue | Location |
|----------|-------|----------|
| High | Default API key `local-default-key` seeded in DB and used as `VITE_API_KEY` default | `schema.sql`, `docker-compose.yml` |
| High | `VITE_API_KEY` baked into JS bundle at build time — readable in browser devtools | `web/vite.config.ts`, `web/src/App.tsx` |
| Medium | No HTTPS by default — API key transmitted in plaintext HTTP headers | `docker-compose.yml` |
| Medium | No CSRF protection on state-mutating routes (`POST /api/v1/alerts/:id/acknowledge`) | `server/src/api/routes.ts` |
| Medium | Webhook URLs may appear in server logs | `server/src/alerts/dispatcher.ts` |
| Medium | Default DB credentials (`fenris`/`fenris`) in hardcoded fallback connection string | `server/src/db/client.ts` |
| Low | No API key rotation, expiry, or usage audit log | All |
| Low | No rate limiting on `/api/v1/metrics` — potential DB flood vector | `server/src/api/routes.ts` |
| Low | No validation of metric value ranges (accepts negative %, NaN) | `server/src/api/routes.ts` |
| Low | No multi-tenancy — any valid-key agent can read all servers' metrics | `server/src/api/routes.ts` |

### Frontend Issues

| Issue | Detail |
|-------|--------|
| Silent auth failure | Invalid API key causes fetch to silently fail; user sees indefinite loading |
| Monolithic component | `App.tsx` is ~568 lines; no sub-components |
| No error boundaries | No loading/error states, no React error boundary |
| Hardcoded poll interval | 30 s polling; not configurable; no WebSocket/SSE push |

---

## 8. Test Coverage

**Current status: Zero.**

- No test files (`*.test.ts`, `*.spec.ts`, `*.test.tsx`) anywhere in the repository
- No test runner configured (no `jest.config.js`, `vitest.config.ts`, etc.)
- No `test` script in any `package.json`

### Untested Critical Paths

| Component | Path |
|-----------|------|
| `server/src/engine/anomaly.ts` | Z-score calculation, edge cases (empty window, uniform values) |
| `server/src/alerts/dispatcher.ts` | Concurrent dispatch, partial failure handling |
| `server/src/alerts/util.ts` | Cooldown logic, severity formatting |
| `server/src/api/routes.ts` | Metric ingestion, server upsert, auth hook |
| `server/src/db/schema.sql` | Schema idempotency on repeated application |
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
- Health check: `wget -q http://localhost:3200/health`

**`agent/Dockerfile`**
- Base: `node:22-alpine`
- Same build pipeline as server
- Non-root user: `fenris-agent`
- No exposed port (outbound HTTP only)
- No health check

**`web/Dockerfile`**
- Stage 1 (`builder`): `node:22-alpine`, runs Vite build
- Stage 2: `nginx:alpine`, copies built assets and `nginx.conf`
- Exposes port 80
- No health check

### `docker-compose.yml`

| Service | Image/Build | Ports | Key Config |
|---------|-------------|-------|-----------|
| `postgres` | `postgres:15-alpine` | 5432 (internal) | healthcheck: `pg_isready -U fenris` |
| `server` | `./server` (build) | `3200:3200` | depends_on postgres (healthy); mounts docker.sock |
| `web` | `./web` (build) | `8081:80` | depends_on server |
| `agent` | `./agent` (build) | none | depends_on server; restart: unless-stopped; mounts docker.sock |

Volumes:
- `fenris-postgres-data` — PostgreSQL data persistence
- `fenris-logs` — server log output at `/app/logs`
- `./agent-local/fenris-agent.yaml` → `/app/fenris-agent.yaml:ro`
- `/var/run/docker.sock` → read-only into `server` and `agent`

Network: `fenris` bridge (all containers)

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
2. `server` starts → applies schema → seeds default server row → Fastify ready
3. `web` starts → Nginx serves pre-built static assets, proxies `/api/`
4. `agent` starts → loads config → begins collection loop → POSTs to `server:3200`

### CI/CD
**None present.** No `.github/workflows/`, no `Jenkinsfile`, no `.gitlab-ci.yml`. No linting, type-check, or test automation configured.

---

## 10. Summary & Recommendations

### Strengths
- Clean three-tier separation: agent → server → web
- Lightweight (~1,400 LOC across all services)
- Zero-config agent self-registration
- Multi-channel alert dispatch with in-memory cooldown
- Z-score anomaly detection with configurable threshold and window
- Idempotent schema initialization
- Docker-native deployment

### Priority Recommendations

**P0 — Security (before any external exposure)**
1. Replace hardcoded default key `local-default-key` with a required env var; fail fast on startup if unset
2. Move `VITE_API_KEY` to runtime: serve it via `/api/v1/config` instead of baking it into the JS bundle
3. Add TLS/HTTPS termination (Nginx with cert or Caddy in front of the stack)
4. Redact secrets (webhook URLs, SMTP credentials) from server logs

**P1 — Reliability**
5. Persist alert cooldown to DB — prevents post-restart alert storms
6. Scope cooldown key to `(server_id, metric_type)` instead of raw message text
7. Add idempotency key to metric POST to prevent duplicate rows on agent retry
8. Validate SMTP config at startup; surface misconfiguration early

**P2 — Observability**
9. Replace `console.log` with structured logging — adopt `pino` (already declared as a dep)
10. Add request/response middleware logging (method, path, status, latency)
11. Redact sensitive values from query logs in `db/client.ts`

**P3 — Maintainability**
12. Add tests: start with `anomaly.ts` (pure function, high value), then API route integration tests
13. Split `web/src/App.tsx` into focused sub-components
14. Remove unused deps: `@fastify/env`, `pino` (or adopt it — see #9)
15. Add a migration framework (e.g., `node-pg-migrate`) for safe schema evolution
16. Add CI pipeline with lint + type-check + test steps

**P4 — Features / Polish**
17. Make alert cooldown duration configurable via `fenris.yaml`
18. Make excluded Docker containers configurable
19. Add WebSocket or SSE for real-time dashboard updates (replace 30 s polling)
20. Add rate limiting on `/api/v1/metrics`
21. Show auth error state in web dashboard when API key is rejected

---

*Generated by automated audit — verify all findings against current source before acting.*
