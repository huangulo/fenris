# Fenris

**Predictive infrastructure monitoring for homelabs and small teams.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED?logo=docker&logoColor=white)](#prerequisites)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white)](#manual-install)

Fenris is a self-hosted, three-tier monitoring stack: lightweight per-host agents push metrics to a central server, which runs Z-score anomaly detection and dispatches alerts, all surfaced in a dark, information-dense React dashboard.

---

## Features

- **Agent-based collection** — deploy one small agent per host; zero polling from the server
- **Windows + Linux agents** — PowerShell installer for Windows (runs as a Windows Service); curl one-liner for Linux
- **Z-score anomaly detection** — statistical baseline per metric, fires only on genuine spikes
- **Predictive alerting** — linear regression projects disk/CPU/memory exhaustion days in advance
- **Docker container monitoring** — per-container CPU, memory, network, state-transition alerts
- **Multi-channel alerts** — Discord, Slack, and Email; per-severity routing, 15-minute cooldown
- **Alert channel testing** — `POST /api/v1/test-alert` + Settings UI button to verify webhooks
- **AI incident summaries** — optional OpenAI integration batches and explains alert clusters
- **Incidents workflow** — create, track, and resolve incidents linked to alerts
- **Support ticket tracking** — built-in ticket list, detail modal, and reports/stats tab
- **Multi-user auth with RBAC** — local accounts with role-based access control (admin / read-only)
- **Wazuh agent monitoring** — pulls agent status and security alerts from the Wazuh Manager REST API
- **CrowdSec integration** — displays active IP bans and decisions from the CrowdSec Local API
- **Dark React dashboard** — server cards with sparklines, circular gauges, 1-hour history charts
- **Data retention** — configurable per-metric and per-alert TTL, hourly background cleanup

---

## Quick Start

**Full server stack** (PostgreSQL + API server + React dashboard):
```sh
git clone https://github.com/huangulo/fenris.git && cd fenris
cp .env.example .env && $EDITOR .env   # set POSTGRES_PASSWORD, DISCORD_WEBHOOK_URL, etc.
docker compose up -d --build
```

**Agent only** (metrics collector for a remote host):
```sh
curl -fsSL https://raw.githubusercontent.com/huangulo/fenris/main/install-agent.sh | sh
```

---

## Manual Install

### Prerequisites

- Linux (x86-64 or ARM64)
- Docker Engine 24+
- Docker Compose v2 (`docker compose` plugin, not legacy `docker-compose`)
- Git

### Server (full stack)

```sh
git clone https://github.com/your-org/fenris.git ~/.fenris
cd ~/.fenris

# Copy and edit the environment file
cp .env.example .env
$EDITOR .env          # set POSTGRES_PASSWORD, API_KEY, optional webhooks

# Build and start
docker compose up -d --build

# Verify
curl http://localhost:3200/health
```

The dashboard is served by the `web` container on port **5173** by default.
The API server runs on port **3200**.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | PostgreSQL password (used internally between containers) |
| `API_KEY` | yes | Shared key agents send as `X-API-Key` |
| `DISCORD_WEBHOOK_URL` | no | Full Discord webhook URL for alerts |
| `SLACK_WEBHOOK_URL` | no | Full Slack incoming-webhook URL for alerts |
| `PORT` | no | Server HTTP port (default `3200`) |
| `VITE_API_KEY` | no | API key baked into the web bundle for dashboard auth |

---

## Deploying an Agent

Each host you want to monitor runs one agent container. The fastest way is the one-liner installer:

```sh
curl -fsSL https://raw.githubusercontent.com/huangulo/fenris/main/install-agent.sh | sh
```

The script will prompt for your Fenris server URL, API key, and a server name (defaults to `hostname`). It then:

1. Sparse-clones just the `agent/` directory from GitHub (no full repo clone)
2. Detects your Docker socket GID automatically
3. Writes `/opt/fenris-agent/fenris-agent.yaml` and `docker-compose.yml`
4. Builds the image and starts the container (`restart: unless-stopped`)
5. Confirms the first successful POST to your server

To update an existing agent, re-run the same command — the script is idempotent.

### Manual deploy

If you prefer to set things up yourself:

```sh
git clone --filter=blob:none --depth=1 https://github.com/huangulo/fenris.git
cd fenris/agent

cat > /opt/fenris-agent/fenris-agent.yaml <<EOF
server_url: "http://YOUR_SERVER_IP:3200"
api_key: "YOUR_API_KEY"
server_name: "$(hostname)"
collect_interval: "30s"
docker_enabled: true
disk_paths:
  - /
EOF

docker compose -f /opt/fenris-agent/docker-compose.yml up -d
```

### Windows Agent

> **Requires PowerShell running as Administrator.**

The PowerShell installer downloads the agent, registers it as a Windows Service, and writes a default config file.

**Step 1 — allow script execution for this session (if needed):**

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

**Step 2 — download and run the installer:**

```powershell
iwr https://raw.githubusercontent.com/huangulo/fenris/main/install-agent.ps1 -OutFile install-agent.ps1 -UseBasicParsing; .\install-agent.ps1
```

> **Antivirus note:** Bitdefender and other AV products may flag the `iex` (Invoke-Expression) pattern used in piped installs. The download-then-run approach above (`-OutFile` first, then `.\install-agent.ps1`) avoids this and lets you inspect the script before executing it.

The installer will prompt for your Fenris server URL, API key, and a server name, then register the `FenrisAgent` Windows Service set to start automatically.

**Service management:**

```powershell
Start-Service FenrisAgent    # start the agent
Stop-Service FenrisAgent     # stop the agent
Restart-Service FenrisAgent  # restart after config changes
Get-Service FenrisAgent      # check status
```

**Config file location:** `C:\ProgramData\Fenris\fenris-agent.yaml`

The config schema is identical to the Linux agent — edit it and restart the service to apply changes.

---

### Agent configuration (`fenris-agent.yaml`)

| Field | Default | Description |
|---|---|---|
| `server_url` | — | HTTP URL of the Fenris server |
| `api_key` | — | API key sent as `X-API-Key` header |
| `server_name` | system hostname | Name shown in the dashboard |
| `collect_interval` | `30s` | Metrics push interval |
| `docker_enabled` | `true` | Enable Docker container stats |
| `disk_paths` | `[/]` | Mount paths to monitor |

---

## Configuration Reference

Full server config lives in `fenris.yaml` (mounted into the server container at `/app/fenris.yaml`).

```yaml
server:
  port: 3200
  database_url: postgresql://fenris:PASSWORD@postgres:5432/fenris

monitors:
  system:
    enabled: true
    scrape_interval: 30s
    metrics: [cpu, memory, disk, network]
  docker:
    enabled: false          # set true to collect container stats
    scrape_interval: 15s
    include_stopped: false  # include exited containers in snapshots

alerts:
  discord:
    enabled: true
    webhook_url: ${DISCORD_WEBHOOK_URL}   # resolved from environment
    severity_levels: [info, warning, critical]
  slack:
    enabled: false
    webhook_url: ${SLACK_WEBHOOK_URL}
    severity_levels: [warning, critical]
  thresholds:
    cpu:
      warning: 75
      critical: 95
    memory:
      warning: 80
      critical: 90
    disk:
      warning: 85
      critical: 95
    network:
      anomaly_threshold: 3.0   # Z-score; network uses anomaly detection only

disk_paths:
  - path: /
    name: root
    warning_threshold: 85
    critical_threshold: 95
  - path: /var/lib/docker
    name: docker-data
    warning_threshold: 80
    critical_threshold: 90

anomaly_detection:
  enabled: true
  algorithm: zscore
  zscore_threshold: 3.0    # standard deviations above the rolling mean
  window_size: 100         # number of data points in the sliding window
  min_samples: 60          # samples needed before first alert (~30 min at 30s interval)

retention:
  metrics_days: 30         # delete metric rows older than N days
  alerts_days: 90          # delete alert rows older than N days

logging:
  level: info
  file: /app/logs/fenris.log
  max_size: 100MB
  max_files: 5
```

---

## Integrations

### Wazuh

Fenris polls the Wazuh Manager REST API to pull agent status and security alerts into the dashboard. Each Wazuh agent can be linked to a Fenris server so security events appear alongside infrastructure metrics.

#### Prerequisites

- Wazuh Manager 4.x with the REST API enabled (default port **55000**)
- A Wazuh API user with at least read permissions (`agents:read`, `alerts:read`)

#### Configuration

Add a `wazuh:` block to `fenris.yaml`:

```yaml
wazuh:
  enabled: true
  url: "https://your-wazuh-manager:55000"
  username: "wazuh-api-user"
  password: "your-password"
  poll_interval: "5m"        # how often to refresh agent list and alerts
  verify_ssl: false          # set true if your Wazuh TLS cert is trusted
```

#### Agent matching

Fenris links Wazuh agents to Fenris servers by comparing the Wazuh agent name against the Fenris server name (case-insensitive). If the names differ, go to **Settings → Servers**, edit the server, and set the **Wazuh Agent Name** field to the exact name shown in the Wazuh console.

---

### CrowdSec

Fenris integrates with the CrowdSec Local API (LAPI) to display active IP bans, captchas, and other decisions on the CrowdSec dashboard page. Source countries are resolved automatically from the bundled MaxMind GeoLite2 database (no external API calls).

#### Credential type — bouncer, not machine

CrowdSec uses two credential classes:

| Type | Command | Endpoint access |
|---|---|---|
| **Bouncer** | `cscli bouncers add` | `/v1/decisions/stream` ✓ |
| Machine | `cscli machines add` | `/v1/decisions` — returns **403** for bouncers |

Fenris uses **`/v1/decisions/stream`**, which requires a **bouncer** API key. Using a machine credential will produce a 403 error.

#### Generating the API key

**Bare-metal / systemd install:**
```sh
sudo cscli bouncers add fenris
```

**Docker install** (CrowdSec running in a container):
```sh
docker exec crowdsec cscli bouncers add fenris
```

Both commands print a key — copy it immediately, it is not shown again.

#### Configuration

Add a `crowdsec:` block to `fenris.yaml`. The `name` field must match a Fenris server name **exactly** (case-insensitive) so decisions are linked to the correct server in the dashboard:

```yaml
crowdsec:
  enabled: true
  poll_interval: "60s"      # how often to poll /v1/decisions/stream
  instances:
    - name: "my-server"     # must match the Fenris server name exactly
      url: "http://127.0.0.1:8080"
      api_key: "abc123..."  # bouncer key from cscli bouncers add
```

Multiple instances (one per CrowdSec LAPI host) are supported:

```yaml
crowdsec:
  enabled: true
  poll_interval: "60s"
  instances:
    - name: "web-01"
      url: "http://192.168.1.10:8080"
      api_key: "key-for-web-01"
    - name: "web-02"
      url: "http://192.168.1.11:8080"
      api_key: "key-for-web-02"
```

#### How it works

On startup Fenris calls `/v1/decisions/stream?startup=true` to fetch the full current decision set. Subsequent polls use `startup=false` to receive only incremental adds and deletes since the last call, keeping database state in sync with the LAPI without re-fetching the entire list every minute.

---

## API Reference

All `/api/` routes require the header `X-API-Key: <key>` unless noted otherwise.

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Liveness check. Returns `{ status: "healthy", timestamp }`. |

### Metrics ingestion

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/metrics` | none* | Ingest a metric batch from an agent. Auto-registers unknown agents by `(api_key, server_name)`. |

*`POST /api/v1/metrics` authenticates via the `X-API-Key` header inline — it does not go through the shared auth hook so agents can self-register.

**Request body:**
```json
{
  "server_name": "my-host",
  "metrics": [
    {
      "metric_type": "cpu",
      "value": { "cpu": { "usage": 42.1 } },
      "timestamp": "2026-04-01T12:00:00.000Z"
    }
  ]
}
```

**Supported `metric_type` values:** `cpu`, `memory`, `disk`, `network`, `docker`

### Servers

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/servers` | key | List all registered servers with `id`, `name`, `ip_address`, `last_heartbeat`. |

### Metrics query

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/metrics` | key | Recent metrics across all servers. Query: `limit` (default 100). |
| `GET` | `/api/v1/servers/:id/metrics` | key | Metrics for one server. Query: `limit`, `metric_type`. |

### Alerts

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/alerts` | key | List alerts. Query: `limit`, `server_id`, `severity`, `acknowledged` (`true`/`false`). Response includes `summary_id` when an AI summary exists. |
| `POST` | `/api/v1/alerts/:id/acknowledge` | key | Acknowledge a single alert by ID. |
| `POST` | `/api/v1/test-alert` | key | Fire a test `info`-severity alert through every configured notification channel. Optional body: `{ "channels": ["discord", "slack", "email"] }`. Returns `{ "sent": [...], "failed": [...], "disabled": [...] }`. Does **not** write to the database. |

### AI Summaries

Requires `ai.enabled: true` and a valid `ai.api_key` in `fenris.yaml`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/alerts/:id/summary` | key | Returns the AI-generated summary that covers this alert (404 if none). |
| `GET` | `/api/v1/summaries` | key | Recent AI summaries. Query: `server_id`, `limit` (max 50, default 10). |

### Docker

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/docker/containers` | key | Latest container snapshot. Query: `server_id`. |
| `GET` | `/api/v1/docker/containers/:name/metrics` | key | Historical stats for one container. Query: `server_id`, `limit`. |

### Config

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/config` | none | Returns safe config subset (thresholds, anomaly settings). Passwords and webhook URLs are stripped. |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Your network                            │
│                                                                  │
│  ┌──────────────┐   POST /api/v1/metrics    ┌─────────────────┐ │
│  │  Agent host  │ ───────────────────────►  │                 │ │
│  │  (Node.js)   │   X-API-Key: <key>        │  Fenris Server  │ │
│  │              │                           │   (Fastify)     │ │
│  │ • CPU/mem    │                           │                 │ │
│  │ • disk/net   │                           │ • Z-score       │ │
│  │ • Docker     │                           │   anomaly det.  │ │
│  └──────────────┘                           │ • Threshold     │ │
│                                             │   checks        │ │
│  ┌──────────────┐                           │ • Alert         │ │
│  │  Agent host  │ ───────────────────────►  │   dispatch      │ │
│  └──────────────┘                           │ • REST API      │ │
│                                             └───────┬─────────┘ │
│                                                     │           │
│  ┌─────────────────┐    REST + X-API-Key    ┌───────▼─────────┐ │
│  │  Browser        │ ◄────────────────────► │  Web Dashboard  │ │
│  │  (React SPA)    │                        │  (Vite + Nginx) │ │
│  └─────────────────┘                        └─────────────────┘ │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    PostgreSQL 15                          │   │
│  │   tables: servers · metrics (JSONB+GIN) · alerts         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Alerts ──► Discord webhook                                      │
│         ──► Slack webhook                                        │
└──────────────────────────────────────────────────────────────────┘
```

---

## Roadmap

- [ ] Email alert channel (SMTP)
- [ ] Per-server alert threshold overrides
- [ ] Alert history chart in dashboard
- [ ] PagerDuty / Opsgenie integration
- [ ] Multi-user auth (currently single shared API key)
- [ ] Prometheus `/metrics` scrape endpoint
- [ ] ARM64 Docker image in CI
- [ ] Automated test suite (Jest for anomaly engine, Playwright for dashboard)

---

## Homepage Dashboard Integration

Fenris exposes a [`GET /api/v1/status`](http://localhost:3200/api/v1/status) endpoint compatible with [Homepage](https://gethomepage.dev)'s `customapi` widget.

Add this to your Homepage `services.yaml`:

```yaml
- Fenris:
    icon: fenris
    href: http://your-fenris-url:8081
    widget:
      type: customapi
      url: http://your-fenris-url:3200/api/v1/status
      headers:
        X-API-Key: your-api-key
      mappings:
        - field: servers_online
          label: Servers
          format: text
        - field: monitors_up
          label: Uptime
          format: text
        - field: active_alerts
          label: Alerts
          format: text
```

The endpoint returns:

```json
{
  "servers_online": 3,
  "servers_total": 3,
  "containers_running": 45,
  "containers_total": 45,
  "monitors_up": 5,
  "monitors_total": 5,
  "active_alerts": 2,
  "uptime_percentage": 99.8
}
```

---

## Contributing

1. Fork and create a feature branch
2. `cd server && npm install && npm run build` — TypeScript must compile cleanly
3. `cd web && npm install && npm run build` — Vite build must complete without errors
4. Open a pull request with a clear description of the change

---

## License

MIT License

Copyright (c) 2026 Fenris contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
