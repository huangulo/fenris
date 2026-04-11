# Changelog

All notable changes to Fenris are documented here.

---

## [0.4.0] — 2026-04-11

### Docker — deep container monitoring

- Per-container history charts with inline row expansion: CPU %, memory MB/%, network rx/tx rate (4 Recharts AreaCharts per container)
- Container restart tracking — `container_events` table records every state transition, restart, image change, and removal
- Restart counts API: `GET /api/v1/docker/containers/:server_id/:name/restarts` returns 24 h and 7 d totals
- **Flapping alerts** — warning alert fires when a container restarts ≥ 3 times in 15 minutes; 30-minute cooldown per container
- **Image change alerts** — info alert when a running container's image hash changes between polls; 1-hour cooldown
- Volume/disk usage collection — opt-in (`collect_volume_sizes: true`); sizes derived via `du`; results cached 5 minutes per container; Windows skipped automatically
- Container uptime fix — `started_at` from Docker inspect (`State.StartedAt`) replaces creation time; capped at host uptime to survive agent restarts
- **Top consumers view** — `GET /api/v1/docker/top?metric=cpu|memory|network` returns top 5 across all servers; Containers page shows three cards above the table
- Container events feed — `GET /api/v1/docker/events` with `?server_id=` and `?container_name=` filters; timeline shown in detail panel
- 90-day retention job for `container_events`

### Dashboard

- Containers page: top consumers cards (CPU % / Memory MB / Network I/O) with loading skeletons; always visible with "No data" state
- Server detail: container rows are now clickable — expands inline to show 4 history charts + volumes table + events timeline

### Windows agent

- Go binary (`agent-windows/`) replaces the PowerShell proof-of-concept
- Collects CPU, memory, disk, and network via `gopsutil`
- Host uptime via `gopsutil/host.BootTime()` — transmitted in agent payload to cap container uptimes on the server side
- Registers as a Windows Service; managed with `Start-Service FenrisAgent` / `Stop-Service FenrisAgent`
- Config at `C:\ProgramData\Fenris\fenris-agent.yaml`
- PowerShell one-liner installer (`agent-windows/install.ps1`)

---

## [0.3.0] — 2026-04-05

### Support tickets module

- Full helpdesk ticketing: create, assign, update status, resolve, and cancel tickets
- Categories: hardware, software, network, email, printer, account, training, other
- Priorities: low, normal, high, urgent
- Time tracking: log minutes per note; totals aggregate to per-ticket and per-technician stats
- Stats / reports page: breakdowns by status, category, priority, technician, and top requesters
- Schema: `support_tickets` and `support_ticket_notes` tables with indexes

### Security integrations

- **Wazuh SIEM** — polls Wazuh manager REST API on configurable interval; imports agent inventory and MITRE-mapped alerts; per-agent alert badge in the dashboard; `wazuh_agents` and `wazuh_agent_alerts` tables
- **CrowdSec threat intelligence** — polls CrowdSec LAPI; imports active decisions (bans, captchas, throttles); top scenarios and countries cards; `crowdsec_decisions` table; multiple LAPI instances supported
- Both integrations surface security context on the Server Detail page alongside system metrics

### Incident management

- Incidents page: create, investigate, and resolve incidents; link related alerts; assign to a user
- AI summary button — calls OpenAI with the incident's recent alerts; summary stored and displayed inline (requires `ai.enabled: true` in config)
- Notes with full text and audit trail
- `incidents` and `incident_notes` tables

### Multi-user auth and RBAC

- `users` table with bcrypt passwords; roles: `admin`, `operator`, `viewer`
- JWT sessions (24 h); `POST /api/v1/auth/login` issues token
- Role-gated endpoints (admin-only for user management and config; operator for acknowledge/create; viewer read-only)
- `ensureDefaultAdmin()` — on first start, creates `admin` user with random 16-char hex password and prints it once to stdout
- Audit log: `audit_log` table records sensitive actions with user, IP, resource, and metadata

### Uptime monitoring

- `monitors` table: HTTP/HTTPS endpoints with method, interval, timeout, expected status, and custom headers
- Background checker runs monitors on their configured interval; records results in `monitor_checks`
- TLS certificate expiry detection and storage
- 24 h / 7 d / 30 d uptime percentage computed from check history
- Uptime page in dashboard: status table, response time, cert expiry, uptime badges

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
