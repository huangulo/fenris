# Changelog

All notable changes to Fenris are documented here.

---

## [0.2.0] — 2026-04-01

### Dashboard — complete rewrite

- New dark React SPA with sidebar navigation (icons + labels, collapsible to icons-only, mobile bottom nav)
- Top bar: server selector dropdown, online/offline indicator, live clock
- **Overview page** — cluster stats row (servers online, containers running, active alerts) + server card grid with three inline sparklines (CPU / MEM / DISK), container count, last-seen timestamp, and alert count badge
- **Server detail page** — four metric panels (CPU, Memory, Disk, Network), each with a 116 px circular SVG gauge and a 1-hour Recharts AreaChart; container table below with unhealthy rows floated to the top
- **Alerts page** — filterable by server, severity, and acknowledged status; checkbox-per-row with select-all and bulk-acknowledge; per-row acknowledge button
- **Containers page** — server filter, responsive container table (CPU %, memory MB, network rx/tx, state badge with coloured dot, uptime)
- **Settings page** — renders `/api/v1/config` JSON in a monospace block; shows API endpoint and refresh interval
- Shared component library: `CircularGauge`, `HistoryChart` (Recharts AreaChart with gradient fill), `Sparkline` (pure SVG), `SeverityBadge`, `StateBadge`, `OnlineDot`, skeleton loaders
- 30-second auto-refresh with `Promise.all` parallel fetch; loading screen on first load; `animate-fade-in` page transitions
- Vite `manualChunks` splits recharts (517 kB) into its own chunk — app bundle drops from 558 kB to 44 kB

### Monitoring — Docker container support

- New `docker` collector in agent using `dockerode` — per-container CPU %, memory MB/%, net rx/tx bytes, state, uptime
- State-transition alerts: immediate critical alert when a running container stops (no Z-score wait)
- `GET /api/v1/docker/containers` — latest container snapshot, optionally filtered by `server_id`
- `GET /api/v1/docker/containers/:name/metrics` — historical stats per container
- Fenris own containers (`fenris-server`, `fenris-web`, `fenris-postgres`) excluded from anomaly detection to prevent self-referential noise

### Alert system — multi-channel dispatcher

- `AlertDispatcher` delivers to all configured channels in parallel
- Discord channel: rich embed with severity colour, metric type, server name, value breakdown
- Slack channel: `attachments`-based message with matching colour coding
- Email channel: HTML template via nodemailer (SMTP)
- Shared `shouldAlert()` utility: checks enabled flag, severity allowlist, and per-`(channel, server_id, metric_type)` cooldown in one call
- Alert cooldown raised from 5 minutes to **15 minutes**, keyed by `channel:server_id:metric_type` (previously keyed by message text — one noisy metric could exhaust the cooldown for all metrics on a server)

### Anomaly detection — noise reduction

- `min_samples` default raised 30 → **60** (~30 minutes of data at 30 s interval before first alert)
- Z-score threshold default confirmed at **3.0** standard deviations (previously in some paths defaulted to 2.0)
- Anomaly detector histories scoped per `server_id:metric_type` so per-host baselines are independent

### Agent — remote metrics collector

- New lightweight Node.js agent (`agent/`) replacing server-side self-collection
- Collects CPU, memory, disk (configurable paths), and network every 30 s via `systeminformation`
- Auto-registers with the server on first contact; subsequent pushes upsert on `(api_key, server_name)` so shared-key multi-agent setups create separate server rows
- In-memory buffer (up to 100 snapshots) + exponential-backoff retry on network failure
- Configurable via `fenris-agent.yaml`: server URL, API key, hostname override, Docker socket path

### API — server-id filtering

- `GET /api/v1/metrics` accepts `?server_id=` and `?metric_type=` query params
- `GET /api/v1/alerts` accepts `?server_id=`, `?severity=`, `?acknowledged=`
- `POST /api/v1/alerts/:id/acknowledge` added
- Auth hook now gates on `/api/` prefix rather than an explicit route allowlist; `/health` and `GET /api/v1/config` remain public
- `last_heartbeat` updated on every metrics ingestion (not only registration)

### Server — database and schema

- JSONB `metrics.value` column with GIN index for container sub-key queries
- `servers` table upsert on `(api_key, name)` to support multiple agents sharing one key
- Hourly data-retention job: configurable `metrics_days` (default 30) and `alerts_days` (default 90)
- `GET /api/v1/config` returns safe config subset — passwords and webhook URLs stripped before response

### Infrastructure

- `install.sh` one-line curl installer:
  - OS check (Linux only), Docker daemon check, Docker Compose v2 check, git check
  - **Server mode**: prompts for port, PostgreSQL password, API key (auto-generates if blank), Discord/Slack webhooks; clones to `~/.fenris/`; writes `.env` and `fenris.yaml`; seeds API key into PostgreSQL after startup; prints dashboard URL
  - **Agent mode**: prompts for server URL, API key, hostname; clones to `~/.fenris-agent/`; writes `fenris-agent.yaml`; starts agent container
  - Idempotent: re-runs preserve existing values as defaults; `fenris.yaml` only written on first install
  - `/dev/tty` prompts work correctly when script is piped through curl
- Vite build proxy (`/api` → `http://localhost:3200`) for local development
- `PROJECT_AUDIT.md` added — comprehensive codebase audit covering architecture, schema, API surface, known issues, and dependency inventory

---

## [0.1.0] — initial release

- Fastify HTTP server with PostgreSQL 15 backend
- System metrics collection (CPU, memory, disk, network) via `systeminformation`
- Z-score anomaly detection with configurable sliding window
- Discord webhook alerts
- Basic React dashboard
- Docker Compose stack (`server`, `web`, `postgres`)
