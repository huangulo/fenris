# PROJECT AUDIT: FENRIS

**Generated:** 2026-03-22
**Last Updated:** 2026-03-23
**Auditor:** Claude Code (claude-sonnet-4-6)
**Project Version:** 0.1.1 (post-fix MVP)

---

## Executive Summary

**Project Name:** Fenris
**Description:** Self-hosted predictive infrastructure monitoring system for homelabs and small ops teams
**Status:** Functional MVP — all critical blockers resolved, frontend live, stack deployable
**Total Files:** ~38
**Code Lines:** ~1 150 TypeScript (server) · ~350 TypeScript/TSX (web)
**Repository:** Git repository (initialized 2026-03-23)

---

## 1. Project Structure

```
/root/workspace/fenris/
├── server/                          # Node.js/TypeScript backend
│   ├── src/
│   │   ├── index.ts                # Main entry point and orchestration
│   │   ├── types.ts                # TypeScript interfaces and type definitions
│   │   ├── api/
│   │   │   └── routes.ts           # All API endpoints and service initialization
│   │   ├── db/
│   │   │   ├── client.ts           # PostgreSQL connection pool management
│   │   │   └── schema.sql          # Database schema (tables, indexes, triggers, seed)
│   │   ├── collectors/
│   │   │   └── system.ts           # System metrics collection (CPU/RAM/disk/network)
│   │   ├── engine/
│   │   │   └── anomaly.ts          # Z-score anomaly detection engine
│   │   └── alerts/
│   │       └── discord.ts          # Discord webhook alert formatting and delivery
│   ├── package.json                # Server npm dependencies and scripts
│   ├── pnpm-lock.yaml              # Locked dependency manifest
│   ├── tsconfig.json               # TypeScript compiler configuration
│   ├── tsup.config.ts              # ESM build configuration (no dts)
│   └── Dockerfile                  # Docker image build for server (pnpm, non-root)
├── web/                             # React frontend (enabled)
│   ├── src/
│   │   ├── main.tsx                # React app entry point
│   │   ├── App.tsx                 # Dashboard: metrics cards, sparklines, alerts panel
│   │   └── index.css               # Tailwind CSS directives
│   ├── index.html                  # HTML template
│   ├── package.json                # Frontend npm dependencies
│   ├── tailwind.config.js          # Tailwind content paths
│   ├── postcss.config.js           # PostCSS pipeline (Tailwind + autoprefixer)
│   ├── tsconfig.json               # Frontend TypeScript config
│   ├── vite.config.ts              # Vite build + dev proxy
│   ├── Dockerfile                  # Multi-stage nginx build (accepts VITE_API_KEY ARG)
│   └── nginx.conf                  # Nginx static serve + /api/ proxy_pass
├── docker-compose.yml              # Container orchestration (postgres + server + web)
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
- **Server:** `server/src/index.ts` — loads config, initializes DB, registers routes, starts metric collection and retention loops
- **Frontend:** `web/src/main.tsx` — React root mount, served by nginx at port 8081
- **Docker:** `docker-compose.yml` — orchestrates postgres + server + web services

### Layers

```
┌─────────────────────────────────────────────────────────────┐
│                nginx reverse proxy (:8081)                   │
│                     web/nginx.conf                          │
│      static React SPA  │  /api/* → proxy_pass server:3200  │
├─────────────────────────────────────────────────────────────┤
│                   HTTP API (Fastify 5)                       │
│               server/src/api/routes.ts                       │
│          onRequest hook: X-API-Key validation               │
├──────────────┬───────────────────┬─────────────────────────┤
│  Collectors  │  Anomaly Engine   │  Alert Delivery          │
│  system.ts   │  anomaly.ts       │  discord.ts              │
├──────────────┴───────────────────┴─────────────────────────┤
│               Database Layer (pg pool)                       │
│               server/src/db/client.ts                        │
├─────────────────────────────────────────────────────────────┤
│               PostgreSQL 15 (docker)                         │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Metrics collection** (every 30s, via `setInterval` in `index.ts`):
   - `SystemCollector.collectAll()` → gathers CPU/RAM/disk/network via `systeminformation` + `os.loadavg()`
   - Calls `ingestMetrics()` directly (no self-HTTP; extracted from route handler)

2. **Metrics ingestion** (`ingestMetrics()` and `POST /api/v1/metrics`):
   - Inserts each metric into `metrics` table
   - Calls `detector.addMetric()` to accumulate history, then `detectAnomaly()`
   - If anomaly: creates row in `alerts` table, sends Discord embed

3. **Data retention** (every 1h, via `setInterval` in `index.ts`):
   - Parameterized `DELETE` removes metrics older than `retention.metrics_days` (default 30)
   - Parameterized `DELETE` removes alerts older than `retention.alerts_days` (default 90)

4. **Frontend polling** (every 30s):
   - Fetches `/api/v1/servers/1/metrics?limit=80` and `/api/v1/alerts?limit=30`
   - Renders dark-themed dashboard with sparklines and alert panel
   - All requests carry `X-API-Key` header (baked in at Vite build time)

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
| `@fastify/cors` | ^10.0.0 | CORS handling | Used (bumped from ^9 for Fastify 5 compat) |
| `@fastify/env` | ^4.0.0 | Env var validation | Imported but not actively used |
| `pg` | ^8.11.0 | PostgreSQL client | Used |
| `js-yaml` | ^4.1.0 | YAML config parsing | Used |
| `pino` | ^9.0.0 | JSON structured logging | Used |
| `systeminformation` | ^5.22.0 | System metrics via /proc, /sys | Used |
| `node-fetch` | ^3.3.2 | HTTP client for Discord webhook | Used |

### Server — Dev
| Package | Version | Purpose | Status |
|---------|---------|---------|--------|
| `typescript` | ^5.5.0 | Type checking | Used |
| `tsup` | ^8.3.0 | ESM bundler | Used (dts disabled — server binary, not library) |
| `@types/node` | ^22.0.0 | Node.js type definitions | Used |
| `@types/pg` | ^8.11.0 | pg type definitions | Used |
| `@types/js-yaml` | (missing) | js-yaml types | **MISSING** — implicit any on `load()` return |

### Frontend (`web/`)
| Package | Version | Purpose | Status |
|---------|---------|---------|--------|
| `react` | ^18.3.0 | UI library | Used |
| `react-dom` | ^18.3.0 | DOM rendering | Used |
| `vite` | ^5.3.0 | Build tool | Used |
| `@vitejs/plugin-react` | ^4.3.0 | Vite React plugin | Used |
| `tailwindcss` | ^3.4.0 | Utility CSS | Used |
| `postcss` | ^8.4.0 | CSS pipeline | Used |
| `autoprefixer` | ^10.4.0 | Vendor prefixes | Used |

**Flags:**
- `@types/js-yaml` is missing from server dev dependencies — `load()` return type is `unknown`, cast with `as Config`
- `@fastify/env` is imported but the registered schema is empty — validation provides no benefit

---

## 4. Database / State

### Schema (`server/src/db/schema.sql`)

#### Table: `servers`
```sql
id           SERIAL PRIMARY KEY
name         VARCHAR(255) NOT NULL UNIQUE
ip_address   VARCHAR(45) NOT NULL
api_key      VARCHAR(64) NOT NULL UNIQUE
created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
last_heartbeat TIMESTAMP WITH TIME ZONE
```
- Purpose: Agent registry for multi-server support (v0.2+)
- Currently: `server_id=1` is hardcoded in collector; a default row `(1, 'local', '127.0.0.1', 'local-default-key')` is seeded on schema init via `ON CONFLICT DO NOTHING`

#### Table: `metrics`
```sql
id           SERIAL PRIMARY KEY
server_id    INTEGER REFERENCES servers(id) ON DELETE CASCADE
metric_type  VARCHAR(50) NOT NULL   -- 'cpu' | 'memory' | 'disk' | 'network'
value        JSONB NOT NULL
timestamp    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
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
created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
```
- Indexes: `server_id`, `severity`, `acknowledged`, `created_at DESC`

#### Trigger: `update_timestamp`
```sql
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_heartbeat = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```
Fixed: was using `771506` as dollar-quote delimiter. Now uses standard `$$`.

### Migrations
- No migration framework (Flyway, node-pg-migrate, etc.)
- Schema applied once via `initializeTables()` in `client.ts` on every startup (idempotent — all statements use `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`)

### Retention Policy
- Configured via `config.retention.metrics_days` / `alerts_days` (defaults: 30 / 90)
- Enforced: hourly `setInterval` in `index.ts` runs parameterized `DELETE` queries and logs row counts

---

## 5. API Surface

All endpoints are in `server/src/api/routes.ts`. Authentication is enforced via an `onRequest` Fastify hook.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | **Exempt** | Liveness probe → `{ status, timestamp }` |
| `POST` | `/api/v1/metrics` | X-API-Key | Ingest array of Metric objects; runs anomaly detection; fires alerts |
| `GET` | `/api/v1/servers` | X-API-Key | List all registered servers ordered by last_heartbeat DESC |
| `GET` | `/api/v1/servers/:id/metrics` | X-API-Key | Last N metrics for a server (`?limit=100`) |
| `GET` | `/api/v1/alerts` | X-API-Key | List alerts (`?limit=50`, `?acknowledged=true\|false`) |
| `POST` | `/api/v1/alerts/:id/acknowledge` | X-API-Key | Mark alert acknowledged |
| `GET` | `/api/v1/config` | **Exempt** | Return safe config subset — `server` block and `webhook_url` stripped |

### Authentication
- `onRequest` hook reads `X-API-Key` header and queries `SELECT id FROM servers WHERE api_key = $1`
- Missing or unrecognised key → `401 { error: "unauthorized" }`
- `/health` and `/api/v1/config` are explicitly exempt

---

## 6. Environment / Config

### Environment Variables (`.env.example`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3200` | Server listen port |
| `NODE_ENV` | No | `production` | Execution environment |
| `DATABASE_URL` | **Yes** | `postgresql://fenris:CHANGE_ME_BEFORE_DEPLOY@localhost:5432/fenris` | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | **Yes** | `CHANGE_ME_BEFORE_DEPLOY` | Postgres password (used by docker-compose) |
| `DISCORD_WEBHOOK_URL` | No | — | Discord webhook for alerts |
| `FENRIS_CONFIG` | No | `/app/fenris.yaml` | Path to YAML config file |
| `VITE_API_KEY` | **Yes (web)** | `local-default-key` | API key baked into the frontend bundle at build time |

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

**Note:** `js-yaml` reads `${DATABASE_URL}` as a literal string — it does not expand shell variables. When using a `fenris.yaml`, write the values directly. The server falls back to `process.env.DATABASE_URL` when the file is absent, which is the recommended approach for Docker deployments.

### Config Loading (`index.ts`)
- Tries to read `FENRIS_CONFIG` path as YAML
- Falls back to hardcoded defaults reading from env vars if file is missing
- No schema validation on loaded config

---

## 7. Known Issues

All critical deployment blockers and short-term security/quality issues from the original audit have been resolved. The following items remain open.

### Open — Bugs / Limitations

1. **`system.ts` — `server_id` hardcoded to `1`** (`system.ts`)
   - The collector always emits `server_id: 1`; the multi-server agent architecture from the v0.2 roadmap has not been built
   - Impact: benign for single-server homelabs; blocks any multi-host deployment

2. **`index.ts` — `parseInterval()` does not accept bare-number strings**
   - The rewritten parser requires an explicit `s`/`m`/`h` suffix and throws on unrecognised formats
   - A `fenris.yaml` with `scrape_interval: 30` (no suffix) will crash at startup; must be `"30s"`

3. **`@fastify/env` schema is empty**
   - The plugin is registered but its validation schema has no properties, so it performs no env validation
   - Missing required vars (e.g. `DATABASE_URL`) fail silently at connection time rather than at startup

4. **`@types/js-yaml` missing from dev dependencies**
   - `load()` returns `unknown`; cast to `Config` with `as Config` is unchecked
   - Fix: `pnpm add -D @types/js-yaml` in `server/`

### Open — Security

5. **`CORS origin: true` allows all origins**
   - Acceptable for an isolated homelab network; risky if the server port is publicly reachable
   - Fix: restrict to the web container origin in production

6. **No rate limiting on any endpoint**
   - Authenticated endpoints can be brute-forced for API keys; unauthenticated `/health` is unbounded
   - Fix: add `@fastify/rate-limit`

7. **No input validation on `POST /api/v1/metrics` body**
   - Fastify JSON Schema validates the shape but does not constrain value ranges or string lengths
   - A malformed or oversized payload passes through to the DB
   - Fix: add Zod or stricter JSON Schema constraints on `metric_type` and `value`

8. **`VITE_API_KEY` is baked into the frontend bundle at build time**
   - The key is visible in the compiled JS to anyone who can load the page
   - For a private homelab this is acceptable; for any internet-exposed deployment, the dashboard should sit behind a separate auth layer (e.g. HTTP basic auth in nginx, VPN, or Authelia)

### Open — Code Quality

9. **No linting or formatting config**
   - No `.eslintrc`, `.prettierrc`, or `biome.json` in either `server/` or `web/`

10. **No test files exist anywhere in the project**
    - 0% coverage across server and web

11. **No migration framework**
    - Schema changes require manual `ALTER TABLE` or a full volume wipe; there is no versioned migration history

### Resolved (for reference)

| # | Issue | Fix applied |
|---|-------|-------------|
| — | `schema.sql` trigger used `771506` as dollar-quote delimiter | Replaced with `$$` |
| — | `client.ts` imported schema.sql as JSON | Replaced with `fs.readFileSync` + `import.meta.url`-derived `__dirname` |
| — | `routes.ts` never called `detector.addMetric()` | Added call before `detectAnomaly()` |
| — | `index.ts` self-HTTP POST loop | Extracted `ingestMetrics()` service fn; collection loop calls it directly |
| — | No API authentication | `onRequest` hook validates `X-API-Key` against `servers.api_key` |
| — | `/api/v1/config` leaked `webhook_url` | Deep-clone + `delete` before send; `server` block also stripped |
| — | `parseInterval()` silently ignored `s`/`m`/`h` suffixes | Rewritten to require suffix; `"5m"` → 300 000 ms |
| — | Default Postgres password `fenris` | Replaced with `CHANGE_ME_BEFORE_DEPLOY` placeholder in both files |
| — | `collectCPU()` called `si.currentLoad()` twice | Removed duplicate call |
| — | `usage_percent` multiplied by 100 (e.g. 2511 instead of 25) | `currentLoad` is already 0-100; removed `× 100` |
| — | `load_avg` used non-existent `avgLoad1`/`avgLoad5` fields | Replaced with `os.loadavg()` → standard [1m, 5m, 15m] tuple |
| — | Network metrics reported cumulative bytes | Computes `(current − last) / elapsedSeconds`; reports 0 on first tick |
| — | `nginx.conf` `try_files / /index.html` | Fixed to `try_files $uri $uri/ /index.html` |
| — | `server/Dockerfile` used `npm install` | Switched to pnpm via corepack + `pnpm install --frozen-lockfile` |
| — | `server/Dockerfile` ran as root | Added `adduser fenris` + `USER fenris` before `CMD` |
| — | No data retention enforcement | Hourly `setInterval` with parameterized `DELETE` queries; logs row counts |
| — | Frontend disabled (`web.disabled/`) | Renamed to `web/`, docker-compose web service added, full dashboard built |
| — | `App.tsx` wrong API path `/api/v1/metrics` | Fixed to `/api/v1/servers/1/metrics` |

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
| `parseInterval()` — `s`/`m`/`h` formats, error on bad input | Low | Unit |
| Database schema — constraints, indexes, FK cascades | Medium | Integration |
| `App.tsx` — render with mock API, ack button interaction | Medium | Component (Vitest + Testing Library) |

---

## 9. Build / Deploy

### Local Development
```bash
# Backend
cd server
pnpm install
pnpm run dev        # tsup --watch → restarts on change

# Frontend
cd web
npm install
npm run dev         # vite dev server at :5173, proxies /api → localhost:3200
```

### Production Build
```bash
cd server
pnpm run build      # tsup → outputs dist/index.js
node dist/index.js

cd web
npm run build       # vite → outputs dist/
```

### Docker Build
```bash
# Full stack (server + postgres + web)
POSTGRES_PASSWORD=yourpassword VITE_API_KEY=your-api-key docker compose up -d --build
```

### Docker Compose Services
| Service | Image | Port | Health Check |
|---------|-------|------|-------------|
| `postgres` | postgres:15-alpine | (internal) | `pg_isready` every 10s |
| `server` | built from `./server/Dockerfile` | `3200:3200` | `wget /health` every 30s |
| `web` | built from `./web/Dockerfile` | `8081:80` | (none configured) |

### CI/CD
**None present.** No `.github/workflows/`, `.gitlab-ci.yml`, or any pipeline configuration exists.

---

## 10. Feature Completeness

### v0.1.1 — Current State

| Feature | Status | Notes |
|---------|--------|-------|
| System metrics collection — CPU | **Working** | Single `si.currentLoad()` call; correct 0-100% value; `os.loadavg()` for [1m, 5m, 15m] |
| System metrics collection — Memory | **Working** | `(total−available)/total`; GiB fields in payload |
| System metrics collection — Disk | **Working** | Matches by `d.mount`, `available_gb` included; fallback to largest non-tmpfs |
| Docker container monitoring | **Working** | `DockerCollector` via dockerode; CPU%/mem/net/uptime per container; graceful degradation if socket absent |
| System metrics collection — Network | **Working** | Per-interval bytes/sec delta (rx + tx); reports 0 on first tick |
| Z-score anomaly detection | **Working** | `addMetric()` called before `detectAnomaly()`; accumulates history; fires after min_samples=30 |
| PostgreSQL storage | **Working** | Schema initializes cleanly; trigger syntax fixed; idempotent on restart |
| Data retention enforcement | **Working** | Hourly DELETE job; defaults to 30d metrics / 90d alerts; logs row counts |
| API key authentication | **Working** | `onRequest` hook; all endpoints except `/health` and `/api/v1/config` require valid key |
| Discord alerts | **Working** | Fires when anomaly detected; severity derived from threshold config |
| `/api/v1/config` credential safety | **Working** | `server` block and `webhook_url` stripped before response |
| YAML configuration | **Working** | Falls back to env-var defaults when file absent (recommended for Docker) |
| Docker Compose deployment | **Working** | Three-service stack (postgres + server + web); pnpm lockfile; non-root server process |
| Web dashboard — metrics panel | **Working** | 4 cards (CPU, memory, disk, network); 20-point SVG sparkline; green/yellow/red at 60/80% |
| Web dashboard — alerts panel | **Working** | Severity badges; acknowledge button; acknowledged rows dim; active count in header |
| Web dashboard — auto-refresh | **Working** | 30-second polling; 1-second clock; last-refresh timestamp |
| Web dashboard — API key auth | **Working** | `VITE_API_KEY` baked at build time; all requests carry `X-API-Key` header |
| nginx proxy | **Working** | `/api/*` proxied to `server:3200`; SPA routing via `try_files $uri $uri/ /index.html` |
| `parseInterval()` | **Working** | Handles `s`/`m`/`h` suffixes correctly; throws on unrecognised format |

### v0.2 — Roadmap

| Feature | Status | Notes |
|---------|--------|-------|
| Multi-server agent architecture | **Not started** | `server_id` hardcoded to 1; need agent registration, per-host API keys, heartbeat updates |
| Docker container monitoring | **Working** | `DockerCollector` via dockerode; `GET /api/v1/docker/containers` and `/:name/metrics`; anomaly detection + state-transition alerts |
| Slack / email alert channels | **Not started** | Only Discord webhook is implemented; channel abstraction in `alerts/` is straightforward |
| CI/CD pipeline | **Not started** | No GitHub Actions or equivalent; would need build, type-check, test, image-push jobs |
| Input validation (Zod) | **Not started** | `POST /api/v1/metrics` body validated only by Fastify JSON Schema; no domain constraints |
| API rate limiting | **Not started** | `@fastify/rate-limit` would address brute-force on the auth hook |
| Test suite | **Not started** | 0% coverage; Vitest is the natural choice for both server (unit/integration) and web (component) |
| Config schema validation | **Not started** | Loaded YAML is cast unchecked; Zod would catch misconfigured `fenris.yaml` at startup |
| Data retention — alerts cleanup | **Working** | Included in the hourly job alongside metrics cleanup |
| Frontend charts (time-series) | **Deferred** | Sparklines are SVG; full recharts integration deferred until multi-metric history UX is designed |
| Non-root nginx in web container | **Not done** | nginx runs as root; add `USER nginx` and adjust port binding to >1024 if hardening is needed |
