# FENRIS 🐕

Self-hosted infrastructure intelligence for homelabs and small ops teams.

## Vision

A predictive monitoring system that learns your infrastructure patterns and alerts **before** things break.

## Features

- **Pattern Learning**: Learns normal behavior (CPU, RAM, disk, network)
- **Predictive Alerts**: Detects anomalies using Z-score algorithm
- **Multi-Server**: Monitor multiple servers from a central dashboard (v0.2+)
- **Alert Routing**: Discord, Slack, WhatsApp, Email, Webhooks
- **Knowledge Graph**: Service dependencies and infrastructure visualization
- **Real-time Dashboard**: Grafana-style metrics and alert history

## Prerequisites

### Required
- **Docker**: 20.10+ for Docker Compose v2
- **Docker Compose**: 2.0+ (built into Docker)
- **Git**: For cloning repository
- **Discord Webhook**: For alerts (get from Discord server settings)

### Optional (for development)
- **Node.js**: 22.x LTS (for local development)
- **PostgreSQL**: 15+ (for local database)
- **pnpm**: For fast package management

## Quick Start

### Production (Docker Compose)

```bash
# Clone repository
git clone https://github.com/hugolechauve/fenris.git
cd fenris

# Copy and edit configuration
cp fenris.yaml.example fenris.yaml
nano fenris.yaml  # Set your Discord webhook URL

# Set environment variables (optional, for PostgreSQL password)
export POSTGRES_PASSWORD=your-secure-password
export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Start all services
docker-compose up -d

# Check logs
docker-compose logs -f

# Access dashboard
open http://localhost:8081
```

### Local Development

```bash
# Clone repository
git clone https://github.com/hugolechauve/fenris.git
cd fenris

# Install dependencies
cd server && pnpm install
cd ../web && pnpm install

# Start PostgreSQL (Docker)
docker-compose up -d postgres

# Configure environment
cp .env.example .env
nano .env  # Set DATABASE_URL and other variables

# Start backend (in server/)
cd server
pnpm run dev

# Start frontend (in web/)
cd ../web
pnpm run dev

# Access dashboard
open http://localhost:5173  # Vite dev server
```

## Configuration

Edit `fenris.yaml` to customize:

```yaml
# Server configuration
server:
  port: 3200
  database_url: postgresql://fenris:${POSTGRES_PASSWORD:-fenris}@localhost:5432/fenris

# Disk monitoring paths (REQUIRED)
disk_paths:
  - path: /
    name: root
    warning_threshold: 85
    critical_threshold: 95
  - path: /var/lib/docker
    name: docker-data
    warning_threshold: 80
    critical_threshold: 90
  - path: /var/log
    name: logs
    warning_threshold: 85
    critical_threshold: 95

# Alert thresholds
alerts:
  discord:
    enabled: true
    webhook_url: ${DISCORD_WEBHOOK_URL}
    severity_levels: [info, warning, critical]
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
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|----------|
| PORT | Server port | 3200 |
| POSTGRES_PASSWORD | PostgreSQL database password | fenris |
| DISCORD_WEBHOOK_URL | Discord webhook for alerts | - |
| NODE_ENV | Environment mode | production |

## Architecture

```
Fenris Server (Central Brain)
├── Pattern Engine (ML/Stats)
├── Alert Manager (Routing)
├── Knowledge Graph (Dependencies)
└── Web Dashboard (UI)
     ↑
     ├── Agent 1 (Pangolin .100) - v0.2
     ├── Agent 2 (RackNerd .230) - v0.2
     └── Agent N (Your Servers) - v0.2
```

## Roadmap

### v0.1 (MVP - Current) - Single-Server
- ✅ Core monitoring engine
- ✅ System metrics (CPU, RAM, disk, network)
- ✅ Z-score anomaly detection
- ✅ Discord alert integration
- ✅ Basic web dashboard
- ⏸️ Docker container monitoring (v0.2)
- ⏸️ Multi-server support (v0.2)

### v0.2 (Multi-Server) - 1 week
- Docker agent system
- Multi-server UI
- Secure agent communication
- Agent auto-registration

### v1.0 (Full Release) - 4 weeks
- Pattern learning
- Predictive alerts
- All alert integrations (Slack, WhatsApp, Email)
- Knowledge graph MVP

### v1.1+ (Enhancements)
- ML models (more than Z-score)
- Mobile app
- Advanced dashboards
- SSO integration

## Troubleshooting

### Docker Compose won't start
```bash
# Check logs
docker-compose logs

# Verify ports are available
ss -tlnp | grep -E '3200|5432|8081'

# Check disk space
df -h
```

### Database connection errors
```bash
# Verify PostgreSQL is healthy
docker-compose ps postgres

# Check database logs
docker-compose logs postgres

# Test connection from server container
docker-compose exec server psql ${DATABASE_URL} -c 'SELECT 1'
```

### Alerts not sending to Discord
```bash
# Test webhook URL
curl -X POST $DISCORD_WEBHOOK_URL \
  -H 'Content-Type: application/json' \
  -d '{"content":"Fenris webhook test"}'

# Check server logs
docker-compose logs -f server | grep -i 'discord'
```

### Health checks failing
```bash
# Check health endpoint
curl http://localhost:3200/health

# Check health check configuration
docker inspect fenris-server | jq '.[0].State.Health'
```

## Contributing

```bash
# Fork repository
git clone https://github.com/YOUR_USERNAME/fenris.git
cd fenris

# Create feature branch
git checkout -b feature/your-feature

# Install dependencies
pnpm install

# Run tests
pnpm test

# Run linter
pnpm lint

# Commit changes
git commit -am 'Add your feature'

# Push to fork
git push origin feature/your-feature

# Open pull request
```

Pull requests welcome! See `CONTRIBUTING.md` for guidelines.

## License

MIT License - Free for everyone, commercial friendly.

## Support

- **Documentation**: https://docs.fenris.sh
- **Issues**: https://github.com/hugolechauve/fenris/issues
- **Discussions**: https://github.com/hugolechauve/fenris/discussions

---

Built with 🐕 by [Hugo Le Chauve](https://github.com/hugolechauve)
