# PROJECT AUDIT: FENRIS

**Generated:** 2026-03-22
**Auditor:** Claude Code (claude-sonnet-4-6)
**Project Version:** 0.1.0 (MVP)

---

## Executive Summary

**Project Name:** Fenris
**Description:** Self-hosted predictive infrastructure monitoring system for homelabs and small ops teams
**Status:** Early development stage — NOT production-ready
**Total Files:** ~28
**Code Lines:** ~977 TypeScript (server)
**Repository:** Not a git repo (extracted project)

---

## 1. Project Structure

```
/home/lechauve/ally_workspace/fenris/
├── server/                          # Node.js/TypeScript backend
│   ├── src/
│   │   ├── index.ts                # Main entry point and orchestration
│   │   ├── types.ts                # TypeScript interfaces and type definitions
│   │   ├── api/
│   │   │   └── routes.ts           # All API endpoints and service initialization
│   │   ├── db/
│   │   │   ├── client.ts           # PostgreSQL connection pool management
│   │   │   └── schema.sql          # Database schema (tables, indexes, triggers)
│   │   ├── collectors/
│   │   │   └── system.ts           # System metrics collection (CPU/RAM/disk/network)
│   │   ├── engine/
│   │   │   └── anomaly.ts          # Z-score anomaly detection engine
│   │   └── alerts/
│   │       └── discord.ts          # Discord webhook alert formatting and delivery
│   ├── package.json                # Server npm dependencies and scripts
│   ├── tsconfig.json               # TypeScript compiler configuration
│   ├── tsup.config.ts              # ESM build configuration
│   └── Dockerfile                  # Docker image build for server
├── web.disabled/                    # React frontend (disabled at MVP stage)
│   ├── src/
│   │   ├── main.tsx                # React app entry point
│   │   ├── App.tsx                 # Main dashboard component (metrics + alerts)
│   │   └── index.css               # Tailwind CSS base styles
│   ├── index.html                  # HTML template
│   ├── package.json                # Frontend npm dependencies
│   ├── tsconfig.json               # Frontend TypeScript config
│   ├── vite.config.ts              # Vite build configuration
│   ├── Dockerfile                  # Multi-stage nginx build for web
│   └── nginx.conf                  # Nginx reverse proxy / SPA routing config
├── docker-compose.yml              # Container orchestration (postgres + server)
├── .env.example                    # Environment variable template
├── .gitignore                      # Git ignore rules
├── fenris.yaml.example             # Application configuration template
├── README.md                       # User-facing documentation
├── PROJECT.md                      # Project specification and roadmap
└── antfarm-request.txt             # Original project request document
```

---

## 2. Architecture

### Entry Points
- **Server:** `server/src/index.ts` — loads config, initializes DB, registers routes, starts metric collection loop
- **Frontend:** `web.disabled/src/main.tsx` — React root mount (disabled)
- **Docker:** `docker-compose.yml` — orchestrates postgres + server services

### Layers

```
┌──────────────────────────────────────────────────────┐
│                    HTTP API (Fastify)                  │
│              server/src/api/routes.ts                  │
├──────────────┬───────────────────┬────────────────────┤
│  Collectors  │  Anomaly Engine   │  Alert Delivery    │
│  system.ts   │  anomaly.ts       │  discord.ts        │
├──────────────┴───────────────────┴────────────────────┤
│               Database Layer (pg pool)                 │
│               server/src/db/client.ts                  │
├───────────────────────────────────────────────────────┤
│               PostgreSQL 15 (docker)                   │
└───────────────────────────────────────────────────────┘
```

### Data Flow

1. **Metrics collection** (every 30s, via `setInterval` in `index.ts`):
   - `SystemCollector.collectAll()` → gathers CPU/RAM/disk/network via `systeminformation`
   - POSTs results to own `/api/v1/metrics` HTTP endpoint (internal self-call)

2. **Metrics ingestion** (`POST /api/v1/metrics`):
   - Inserts each metric into `metrics` table
   - Runs Z-score anomaly detection via `AnomalyDetector`
   - If anomaly: creates row in `alerts` table, sends Discord embed

3. **Frontend polling** (every 30s, disabled):
   - Fetches `/api/v1/metrics` and `/api/v1/alerts`
   - Renders in dark-themed dashboard

### External Services
| Service | Purpose | Integration |
|---------|---------|-------------|
| PostgreSQL 15 | Persistent storage for metrics and alerts | `pg` connection pool |
| Discord | Alert delivery via webhook | `node-fetch` POST to webhook URL |

---

## 3. Dependencies

### Server — Production
| Package | Version | Purpose | Status |
|---------|---------|---------|--------|
| `fastify` | ^5.0.0 | HTTP framework | Used |
| `@fastify/cors` | ^9.0.0 | CORS handling | Used |
| `@fastify/env` | ^4.0.0 | Env var validation | Registered but schema empty |
| `pg` | ^8.11.0 | PostgreSQL client | Used |
| `js-yaml` | ^4.1.0 | YAML config parsing | Used |
| `pino` | ^9.0.0 | JSON structured logging | Used |
| `systeminformation` | ^5.22.0 | System metrics via /proc, /sys | Used |
| `node-fetch` | ^3.3.2 | HTTP client for Discord webhook | Used |

### Server — Dev
| Package | Version | Purpose | Status |
|---------|---------|---------|--------|
| `typescript` | ^5.5.0 | Type checking | Used |
| `tsup` | ^8.3.0 | ESM bundler | Used |
| `@types/node` | ^22.0.0 | Node.js type definitions | Used |
| `@types/pg` | ^8.11.0 | pg type definitions | Used |
| `@types/js-yaml` | (missing) | js-yaml types | **MISSING** — implicit any |

### Frontend (web.disabled)
| Package | Version | Purpose | Status |
|---------|---------|---------|--------|
| `react` | ^18.3.0 | UI library | Used |
| `react-dom` | ^18.3.0 | DOM rendering | Used |
| `@tanstack/react-query` | ^5.0.0 | Data fetching | **UNUSED** — not used in App.tsx |
| `recharts` | ^2.12.0 | Charts library | **UNUSED** — not used in App.tsx |
| `vite` | ^5.3.0 | Build tool | Used |
| `@vitejs/plugin-react` | ^4.3.0 | Vite React plugin | Used |

**Flags:**
- `@tanstack/react-query` and `recharts` are installed but completely unused — dead weight until frontend is activated
- `@types/js-yaml` is missing from server dev dependencies
- Tailwind CSS classes used in frontend but Tailwind is not in package.json (likely expected globally or via CDN)

---

## 4. Database / State

### Schema (`server/src/db/schema.sql`)

#### Table: `servers`
```sql
id           SERIAL PRIMARY KEY
name         VARCHAR(255) NOT NULL UNIQUE
ip_address   VARCHAR(45) NOT NULL
api_key      VARCHAR(255) NOT NULL UNIQUE
created_at   TIMESTAMP DEFAULT NOW()
last_heartbeat TIMESTAMP
```
- Purpose: Agent registry for multi-server support (v0.2+)
- Currently: server_id=1 is hardcoded in collector

#### Table: `metrics`
```sql
id           SERIAL PRIMARY KEY
server_id    INTEGER REFERENCES servers(id) ON DELETE CASCADE
metric_type  VARCHAR(50) NOT NULL   -- 'cpu' | 'memory' | 'disk' | 'network'
value        JSONB NOT NULL
timestamp    TIMESTAMP DEFAULT NOW()
```
- Indexes: `server_id`, `metric_type`, `timestamp DESC`, compound `(server_id, timestamp DESC)`
- JSONB `value` stores flexible metric payloads (e.g., `{ usage_percent, load_avg }` for CPU)

#### Table: `alerts`
```sql
id               SERIAL PRIMARY KEY
server_id        INTEGER REFERENCES servers(id) ON DELETE CASCADE
severity         VARCHAR(20) CHECK (severity IN ('info','warning','critical'))
message          TEXT NOT NULL
metric_type      VARCHAR(50)
threshold_value  JSONB
actual_value     JSONB
acknowledged     BOOLEAN DEFAULT FALSE
created_at       TIMESTAMP DEFAULT NOW()
```
- Indexes: `server_id`, `severity`, `acknowledged`, `created_at DESC`

#### Trigger: `update_timestamp` — **BROKEN**
```sql
-- INVALID SYNTAX — uses "771506" as dollar-quote delimiter (random number)
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS 771506   -- ← INVALID, should be $$ or $fn$
BEGIN
  NEW.last_heartbeat = NOW();
  RETURN NEW;
END;
771506 LANGUAGE plpgsql;    -- ← repeated token, invalid
```
**This will prevent schema initialization from succeeding.**

### Migrations
- No migration framework (Flyway, node-pg-migrate, etc.)
- Schema applied once via `initializeTables()` in `client.ts`
- `initializeTables()` itself has a broken import (see Known Issues)

### Retention Policy
- Configured in `fenris.yaml`: metrics 30 days, alerts 90 days
- **No cleanup job implemented** — retention is documented but not enforced

---

## 5. API Surface

All endpoints are in `server/src/api/routes.ts`. **No authentication is required on any endpoint.**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Liveness probe → `{ status, timestamp }` |
| `POST` | `/api/v1/metrics` | None | Ingest array of Metric objects; runs anomaly detection; fires alerts |
| `GET` | `/api/v1/servers` | None | List all registered servers ordered by last_heartbeat DESC |
| `GET` | `/api/v1/servers/:id/metrics` | None | Last N metrics for a server (`?limit=100`) |
| `GET` | `/api/v1/alerts` | None | List alerts (`?limit=50`, `?acknowledged=true\|false`) |
| `POST` | `/api/v1/alerts/:id/acknowledge` | None | Mark alert acknowledged |
| `GET` | `/api/v1/config` | None | Return safe config subset (excludes DB URL; **does not exclude webhook URL**) |

### Notes
- `POST /api/v1/metrics` anomaly detection flow has a bug: calls `detector.getHistory()` where `detector.addMetric()` should be called first — history is never populated from ingested data
- `GET /api/v1/config` response should strip `alerts.discord.webhook_url` but currently does not

---

## 6. Environment / Config

### Environment Variables (`.env.example`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3200` | Server listen port |
| `NODE_ENV` | No | `production` | Execution environment |
| `DATABASE_URL` | **Yes** | `postgresql://fenris:fenris@localhost:5432/fenris` | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | **Yes** | `fenris` | Postgres password (used by docker-compose) |
| `DISCORD_WEBHOOK_URL` | No | — | Discord webhook for alerts |
| `FENRIS_CONFIG` | No | `/app/fenris.yaml` | Path to YAML config file |

### Config File (`fenris.yaml.example`)

```yaml
server:
  port: 3200
  database_url: ${DATABASE_URL}

monitors:
  system:
    enabled: true
    scrape_interval: "30s"
    metrics: [cpu, memory, disk, network]
  docker:
    enabled: false   # planned v0.2

disk:
  paths:
    - path: /
      warning: 85
      critical: 95
    - path: /var/lib/docker
    - path: /var/log

alerts:
  discord:
    enabled: true
    webhook_url: ${DISCORD_WEBHOOK_URL}
    severity_levels: [warning, critical]
  thresholds:
    cpu:    { warning: 75, critical: 95 }
    memory: { warning: 80, critical: 90 }
    disk:   { warning: 85, critical: 95 }
    network:
      anomaly_threshold: 3.0

anomaly_detection:
  enabled: true
  algorithm: zscore
  zscore_threshold: 3.0
  window_size: 100
  min_samples: 30

retention:
  metrics_days: 30
  alerts_days: 90

logging:
  level: info
  file: /app/logs/fenris.log
  max_size: 100mb
  max_files: 5
```

### Config Loading (`index.ts`)
- Tries to read `FENRIS_CONFIG` path as YAML
- Falls back to hardcoded defaults if file missing
- No schema validation on loaded config

---

## 7. Known Issues

### Critical (Blocking Deployment)

1. **`schema.sql` — SQL syntax error in trigger function** (`schema.sql:49-55`)
   - Dollar-quote delimiter is `771506` (a random number) instead of `$$`
   - Schema initialization will fail at this line, preventing table creation

2. **`client.ts` — Invalid `initializeTables()` import** (`client.ts:52`)
   - Uses `import schemaSQL from '../db/schema.sql' assert { type: 'json' }`
   - SQL files cannot be imported as JSON; this will throw at runtime
   - Should read the file with `fs.readFileSync` or embed the SQL as a string

3. **`routes.ts` — Anomaly detector never receives data** (`routes.ts:73`)
   - Calls `detector.getHistory(metricType)` to check window size but never calls `detector.addMetric()` before running detection
   - The detector's history is always empty; `min_samples` threshold is never reached; anomaly detection is effectively disabled

4. **`index.ts` — Self-referential HTTP call for metrics ingestion** (`index.ts:90-94`)
   - The metrics collection loop POSTs to `http://localhost:${PORT}/api/v1/metrics` (its own endpoint)
   - Creates a startup race condition (server may not be ready when first tick fires)
   - Should call service methods directly

5. **No authentication on any API endpoint**
   - `POST /api/v1/metrics`, `POST /api/v1/alerts/:id/acknowledge`, etc. are all publicly writable
   - `Server.api_key` field exists in schema but is never read/validated

### Bugs

6. **`index.ts` — `parseInterval()` regex broken** (`index.ts:103`)
   - Regex `\d+` matches digits but the result is multiplied by 1000 assuming it's in seconds
   - Input `"30s"` parses as `30000` but only accidentally — the `s` suffix is silently ignored
   - Input `"5m"` would parse as `5000` ms (5 seconds, not 5 minutes) — wrong

7. **`system.ts` — `collectCPU()` calls `si.currentLoad()` twice** (`system.ts:31-32`)
   - Two separate `await si.currentLoad()` calls in the same function
   - Wasteful; second result is used, first is discarded

8. **`system.ts` — `lastNetworkStats` map populated but delta never used**
   - `lastNetworkStats` is updated but the delta logic is commented out / incomplete
   - Network metrics report raw cumulative bytes, not rate

9. **`system.ts` — `server_id` hardcoded to `1`** (`system.ts:80`)
   - Breaks multi-server support; no mechanism to identify the host

10. **`App.tsx` — Wrong API endpoint path** (`App.tsx:39`)
    - Fetches `/api/v1/metrics?limit=1` which does not exist
    - Correct path is `/api/v1/servers/:id/metrics`

### Security Concerns

11. **`/api/v1/config` leaks Discord webhook URL**
    - The endpoint returns the full config object; `alerts.discord.webhook_url` is not stripped

12. **Default PostgreSQL password `fenris`** in `.env.example` and `docker-compose.yml`
    - Likely to be left unchanged in homelab deployments

13. **`CORS origin: true`** allows all origins — acceptable for homelab, risky if exposed

14. **No rate limiting** on any endpoint

### Code Quality / TODOs

15. **`nginx.conf` — `try_files` directive incorrect** (`nginx.conf:8`)
    - `try_files / /index.html;` should be `try_files $uri /index.html;`
    - Breaks SPA client-side routing

16. **`server/Dockerfile` — uses `npm` instead of `pnpm`**
    - `package.json` specifies `pnpm` as package manager but Dockerfile uses `npm install`

17. **`server/Dockerfile` — runs as root**
    - No `USER` directive; process runs as root inside container

18. **No data retention enforcement**
    - `fenris.yaml` specifies `retention.metrics_days: 30` but no background job or scheduled query deletes old rows

19. **No linting or formatting config**
    - No `.eslintrc`, `.prettierrc`, or similar

20. **No test files exist anywhere in the project**

---

## 8. Test Coverage

**Coverage: 0%**

There are no test files, no test runner configuration, and no testing dependencies in either `package.json`.

### What Should Be Tested
| Component | Priority | Test Type |
|-----------|---------|-----------|
| `anomaly.ts` — Z-score logic, edge cases (stdDev=0, < min_samples) | High | Unit |
| `routes.ts` — metric ingestion flow, alert creation | High | Integration |
| `system.ts` — metric collection and normalization | Medium | Unit with mocked `systeminformation` |
| `discord.ts` — payload formatting, `shouldAlert()` filtering | Medium | Unit |
| `client.ts` — connection pool, query error handling | Medium | Integration |
| `parseInterval()` — various format strings | Low | Unit |
| Database schema — constraints, indexes, FK cascades | Medium | Integration |

---

## 9. Build / Deploy

### Local Development
```bash
cd server
npm install       # or pnpm install
npm run dev       # tsup --watch → restarts on change
```

### Production Build
```bash
cd server
npm run build     # tsup → outputs dist/index.js + .d.ts
npm start         # node dist/index.js
```

### Docker Build
```bash
# Server image
docker build -t fenris-server ./server

# Full stack
docker-compose up -d
```

### Docker Compose Services
| Service | Image | Port | Health Check |
|---------|-------|------|-------------|
| `postgres` | postgres:15-alpine | (internal only) | `pg_isready` every 10s |
| `server` | built from `./server/Dockerfile` | `3200:3200` | `wget /health` every 30s |

### Build Issues
- `server/Dockerfile` uses `npm install` but project uses `pnpm` — lockfile ignored
- `tsc` is installed globally in the Dockerfile but `tsup` handles compilation — redundant
- Frontend `web.disabled/` is not included in `docker-compose.yml` — must be manually added when re-enabled

### CI/CD
**None present.** No `.github/workflows/`, `.gitlab-ci.yml`, or any pipeline configuration exists.

---

## 10. Feature Completeness (v0.1 scope)

| Feature | Status | Notes |
|---------|--------|-------|
| System metrics collection (CPU/RAM/disk/network) | Implemented | Works but has bugs (double call, no delta) |
| Z-score anomaly detection | Implemented | Never receives data due to routes.ts bug |
| PostgreSQL storage | Implemented | Schema broken (trigger syntax error) |
| Discord alerts | Implemented | Relies on broken anomaly pipeline |
| YAML configuration | Implemented | No schema validation |
| Docker Compose deployment | Implemented | Minor Dockerfile issues |
| Web dashboard | Partially implemented | Disabled, has endpoint path bug |
| API key authentication | Schema only | Field exists, never validated |
| Data retention cleanup | Config only | No enforcement job |

---

## 11. Recommendations by Priority

### Immediate (must fix before first use)
1. Fix `schema.sql` trigger: replace `771506` with `$$`
2. Fix `client.ts` schema initialization: use `fs.readFileSync` to load SQL
3. Fix `routes.ts`: call `detector.addMetric(metricType, value)` before `detectAnomaly()`
4. Fix `index.ts`: call `collector.collectAll()` and route methods directly instead of self-HTTP

### Short-term (before sharing/exposing)
5. Implement API key authentication (validate `X-API-Key` header against `servers.api_key`)
6. Strip `webhook_url` from `/api/v1/config` response
7. Fix `parseInterval()` to handle `s`/`m`/`h` suffixes
8. Fix `nginx.conf` `try_files $uri /index.html`
9. Fix `App.tsx` endpoint path to `/api/v1/servers/1/metrics`
10. Add data retention cron or scheduled DELETE query

### Medium-term (quality)
11. Add unit tests for `anomaly.ts`, `discord.ts`, `parseInterval`
12. Add integration tests for metric ingestion + alert creation flow
13. Add `@types/js-yaml` to dev dependencies
14. Add ESLint + Prettier configs
15. Add non-root `USER` to `server/Dockerfile`
16. Add input validation (Zod or JSON Schema) on API request bodies

### Long-term (roadmap)
17. Multi-server agent architecture (server_id discovery, registration flow)
18. Docker container monitoring
19. Additional alert channels (Slack, email)
20. Re-enable and complete frontend with real charts (Recharts already installed)
21. CI/CD pipeline (GitHub Actions)
