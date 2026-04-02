# Fenris

**Predictive infrastructure monitoring for homelabs and small teams.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED?logo=docker&logoColor=white)](#prerequisites)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white)](#manual-install)

Fenris is a self-hosted, three-tier monitoring stack: lightweight per-host agents push metrics to a central server, which runs Z-score anomaly detection and dispatches alerts, all surfaced in a dark, information-dense React dashboard.

---

## Features

- **Agent-based collection** — deploy one small agent per host; zero polling from the server
- **Z-score anomaly detection** — statistical baseline per metric, fires only on genuine spikes
- **Predictive alerting** — linear regression projects disk/CPU/memory exhaustion days in advance
- **Docker container monitoring** — per-container CPU, memory, network, state-transition alerts
- **Multi-channel alerts** — Discord, Slack, and Email; per-severity routing, 15-minute cooldown
- **Alert channel testing** — `POST /api/v1/test-alert` + Settings UI button to verify webhooks
- **AI incident summaries** — optional OpenAI integration batches and explains alert clusters
- **Dark React dashboard** — server cards with sparklines, circular gauges, 1-hour history charts
- **Data retention** — configurable per-metric and per-alert TTL, hourly background cleanup
- **One-line agent install** — curl installer handles sparse clone, Docker GID, and Compose setup

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
