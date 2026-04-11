# First Run Checklist

Follow these steps after `docker compose up -d` to get Fenris fully operational.

---

## 1. Get your admin password

The auto-generated admin password is printed **once** to the server log on first start:

```bash
docker compose logs server | grep -A 10 "FENRIS DEFAULT ADMIN"
```

Copy the password. You will not see it again — if you miss it, reset the user via the database:

```bash
docker compose exec postgres psql -U fenris -c "DELETE FROM users;"
docker compose restart server
# Server will recreate the admin user and print a new password
```

---

## 2. Log in and change your password

1. Open **http://localhost:8081** (or your server's IP/port)
2. Log in as `admin` with the generated password
3. Go to **Settings → Account** and set a strong password

---

## 3. Add your API key

The API key authenticates agents pushing metrics to the server.

1. Check your `.env` — the value of `FENRIS_API_KEY` is your key
2. Use this key when installing agents (the installer will prompt for it)

---

## 4. Install agents

Install the Fenris agent on each host you want to monitor:

**Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/your-username/fenris/main/install.sh | bash
```

**Windows (PowerShell — Administrator):**
```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
iex (New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/your-username/fenris/main/agent-windows/install.ps1')
```

After 30–60 seconds the host should appear in the dashboard Overview page.

---

## 5. Configure alert channels (optional)

Edit `fenris.yaml` and restart the server:

```yaml
alerts:
  discord_webhook: "https://discord.com/api/webhooks/..."
  slack_webhook: "https://hooks.slack.com/services/..."
```

```bash
docker compose restart server
```

---

## 6. Set up uptime monitors (optional)

Go to **Uptime** in the dashboard and add HTTP/HTTPS endpoints to monitor. Fenris checks them on the configured interval and alerts when they go down or certificates are about to expire.

---

## 7. Enable integrations (optional)

**Wazuh** — add to `fenris.yaml`:
```yaml
wazuh:
  enabled: true
  url: "https://your-wazuh-manager:55000"
  username: "wazuh-wui"
  password: "your-password"
```

**CrowdSec** — add to `fenris.yaml`:
```yaml
crowdsec:
  - name: "my-server"
    url: "http://crowdsec:8080"
    api_key: "your-bouncer-api-key"
```

Restart the server after any `fenris.yaml` change:
```bash
docker compose restart server
```

---

## 8. Invite additional users (optional)

Go to **Settings → Users** (admin only) to create accounts with `operator` or `viewer` roles.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Dashboard shows no servers | Agent not running, wrong server URL, or wrong API key |
| No container data | `docker_enabled: true` in agent config; socket mounted |
| Alerts not firing | `min_samples` not yet reached (default: 60 samples = ~30 min) |
| Discord/Slack not working | Webhook URL correct; check `docker compose logs server` |
| Wazuh shows 0 agents | URL reachable from the server container; credentials correct |

Logs:
```bash
docker compose logs -f server
docker compose logs -f agent    # if using --profile agent
```
