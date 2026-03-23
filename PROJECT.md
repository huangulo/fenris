# FENRIS - Self-Hosted Infrastructure Intelligence

## Vision
A predictive monitoring system that learns infrastructure patterns and alerts before failures occur.

## Core Features

### 1. Pattern Learning Engine
- Baseline normal behavior (CPU, RAM, disk, network)
- Detect anomalies using statistical models
- Learn seasonal patterns (diurnal/weekly cycles)

### 2. Predictive Failure Detection
- Memory leak detection (before OOM)
- Disk space forecasting
- Service health degradation alerts
- Log pattern analysis (error clustering)

### 3. Multi-Server Agent
- Lightweight collectors (Docker, system, logs)
- Secure communication to central brain
- Auto-registration and heartbeat
- Configurable scrape intervals

### 4. Alert Routing
- Multiple channels: Discord, Slack, WhatsApp, Email, Webhooks
- Severity-based routing (Info, Warning, Critical)
- Alert deduplication and grouping
- Escalation policies

### 5. Knowledge Graph
- Service dependency mapping
- Infrastructure visualization
- Historical incident timeline
- Root cause analysis

### 6. Web Dashboard
- Real-time metrics (Grafana-style)
- Alert history and status
- Server health overview
- Configuration management

## Tech Stack

- **Backend**: Node.js 22 (TypeScript)
- **Database**: PostgreSQL 15+ (TimescaleDB optional)
- **Frontend**: React + Vite
- **Metrics**: Prometheus-compatible exporters
- **Queue**: BullMQ (Redis)
- **Deployment**: Docker Compose (v1), Kubernetes Helm (v2)

## Architecture

```
Fenris Server (Central Brain)
├── Pattern Engine (ML/Stats)
├── Alert Manager (Routing)
├── Knowledge Graph (Deps)
└── Web Dashboard (UI)
     ↑
     ├── Agent 1 (.100 Pangolin)
     ├── Agent 2 (.230 RackNerd)
     └── Agent N (Future servers)
```

## MVP Scope (v1.0)

### Must Have
- [ ] Single-server monitoring
- [ ] Docker container health tracking
- [ ] Basic anomaly detection (Z-score)
- [ ] Discord alert integration
- [ ] Simple web dashboard (metrics + alerts)
- [ ] Configuration via YAML

### Should Have
- [ ] Multi-server support
- [ ] Log pattern analysis
- [ ] Service dependency graph
- [ ] Historical data retention
- [ ] Alert severity levels

### Nice to Have
- [ ] Predictive ML models
- [ ] WhatsApp integration
- [ ] Custom alert rules
- [ ] Mobile app
- [ ] API for external integrations

## Installation

```bash
curl -fsSL https://fenris.sh/install | bash
```

## Configuration Example

```yaml
# fenris.yaml
server:
  port: 3000
  database: postgresql://fenris:password@localhost:5432/fenris

monitors:
  - name: docker
    type: docker
    scrape_interval: 15s
  - name: system
    type: system
    metrics: [cpu, memory, disk, network]
    scrape_interval: 30s

alerts:
  channels:
    - type: discord
      webhook: https://discord.com/api/webhooks/...
      severity: [warning, critical]
```

## Open Source Roadmap

### v0.1 (MVP - 2 weeks)
- Core monitoring engine
- Docker agent
- Basic dashboard
- Discord alerts

### v0.2 (Multi-Server - 1 week)
- Agent system
- Multi-server UI
- Secure communication

### v1.0 (Full Release - 4 weeks)
- Pattern learning
- Predictive alerts
- All alert integrations
- Knowledge graph MVP

### v1.1+ (Enhancements)
- ML models
- Mobile app
- Advanced dashboards
- SSO integration

## License

MIT License - Free for everyone, commercial friendly.

## Contributing

Standard open source contribution model.
- Pull requests welcome
- Good first issue labels
- Community contributions appreciated.
