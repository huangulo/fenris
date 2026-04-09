import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from '@fastify/env';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { initDatabase, initializeTables, closeDatabase, query } from './db/client.js';
import {
  initServices, healthCheck, receiveMetrics,
  listServers, getAllMetrics, getServerMetrics,
  listAlerts, acknowledgeAlert, getConfig,
  getDockerContainers, getDockerContainerHistory,
  getAlertSummary, listSummaries, sendTestAlert,
  getStatus, getServerStatus,
  listMonitors, createMonitor, updateMonitor, deleteMonitor, getMonitorChecks, testMonitorNow,
  setUptimeMonitor, setWazuhMonitor,
  listWazuhAgents, getWazuhAgent, getWazuhStatus, testWazuhConnection, getWazuhUnmatched,
  getServerSecurity, updateServer,
  listCrowdSecDecisions, getCrowdSecStats, testCrowdSecConnection, getCrowdSecStatus,
  setCrowdSecMonitor,
  listIncidents, getIncident, claimIncident, resolveIncident, reopenIncident,
  updateIncident, mergeIncidents, splitIncident,
} from './api/routes.js';
import { backfillIncidents }   from './engine/incidents.js';
import { UptimeMonitor }       from './monitors/uptime.js';
import { WazuhMonitor }        from './monitors/wazuh.js';
import { CrowdSecMonitor }     from './monitors/crowdsec.js';
import { Predictor, parseDurationMs } from './engine/predictor.js';
import { Summarizer }          from './engine/summarizer.js';
import { Config }              from './types.js';
import {
  loadOrGenerateJwtSecret, ensureDefaultAdmin,
  verifyToken,
} from './auth/index.js';
import { query as dbQuery } from './db/client.js';
import { login, logout, me, changePassword } from './api/auth-routes.js';
import {
  listUsers, createUser, updateUser, resetPassword, deleteUser,
  listAuditLog,
} from './api/users-routes.js';
// Side-effect import: augments FastifyRequest with .user
import './auth/fastify.d.js';

const server = Fastify({ logger: true });

// Decorate requests so TypeScript is happy before middleware sets the value
server.decorateRequest('user', null);

let config: Config;
let retentionInterval: NodeJS.Timeout | null = null;
let predictor:       Predictor       | null = null;
let summarizer:      Summarizer      | null = null;
let uptimeMonitor:   UptimeMonitor   | null = null;
let wazuhMonitor:    WazuhMonitor    | null = null;
let crowdSecMonitor: CrowdSecMonitor | null = null;

async function loadConfig(): Promise<Config> {
  const configPath = process.env.FENRIS_CONFIG || '/app/fenris.yaml';
  try {
    const configData = readFileSync(configPath, 'utf8');
    config = load(configData) as Config;
    if (process.env.DATABASE_URL) config.server.database_url = process.env.DATABASE_URL;
    console.log('Configuration loaded from:', configPath);
    return config;
  } catch (error) {
    console.warn('Could not load config, using defaults:', error);
    config = {
      server: {
        port: parseInt(process.env.PORT || '3000'),
        database_url: process.env.DATABASE_URL || 'postgresql://fenris:fenris@localhost:5432/fenris',
      },
      monitors: {
        system: { enabled: true, scrape_interval: '30s', metrics: ['cpu', 'memory', 'disk', 'network'] },
        disk: {
          paths: [
            { path: '/', name: 'root', warning_threshold: 85, critical_threshold: 95 },
            { path: '/var/lib/docker', name: 'docker-data', warning_threshold: 80, critical_threshold: 90 },
            { path: '/var/log', name: 'logs', warning_threshold: 85, critical_threshold: 95 },
          ],
        },
      },
      alerts: {
        discord: {
          enabled: !!process.env.DISCORD_WEBHOOK_URL,
          webhook_url: process.env.DISCORD_WEBHOOK_URL || '',
          severity_levels: ['info', 'warning', 'critical'],
        },
        thresholds: {
          cpu: { warning: 75, critical: 95 },
          memory: { warning: 80, critical: 90 },
          disk: { warning: 85, critical: 95 },
          network: { anomaly_threshold: 3.0 },
        },
      },
      anomaly_detection: {
        enabled: true, algorithm: 'zscore', zscore_threshold: 3.5,
        window_size: 100, min_samples: 60,
        floors: { cpu: 50, memory: 60, disk: 70, docker_cpu: 30, docker_memory: 40 },
      },
      predictions: {
        enabled: true, interval: '5m',
        disk_horizon_days: 7, cpu_horizon_hours: 1, memory_horizon_hours: 1,
        disk_threshold: 85, cpu_threshold: 90, memory_threshold: 90,
        min_samples: 120, min_confidence: 0.5,
      },
      ai: {
        enabled: false, provider: 'openai',
        api_url: 'https://api.openai.com/v1/chat/completions', api_key: '',
        model: 'gpt-4o-mini', max_calls_per_hour: 10,
        batch_window_ms: 120_000, cooldown_per_server_ms: 900_000,
      },
    };
    return config;
  }
}

async function startRetentionJob(): Promise<void> {
  const metricsDays = config.retention?.metrics_days ?? 30;
  const alertsDays  = config.retention?.alerts_days  ?? 90;

  const runCleanup = async () => {
    try {
      const m = await query(
        "DELETE FROM metrics WHERE timestamp < NOW() - ($1 || ' days')::INTERVAL", [metricsDays]);
      console.log('Retention: deleted', m.rowCount, 'metric rows older than', metricsDays, 'days');
      const a = await query(
        "DELETE FROM alerts WHERE created_at < NOW() - ($1 || ' days')::INTERVAL", [alertsDays]);
      console.log('Retention: deleted', a.rowCount, 'alert rows older than', alertsDays, 'days');
      const c = await query("DELETE FROM monitor_checks WHERE checked_at < NOW() - INTERVAL '90 days'");
      console.log('Retention: deleted', c.rowCount, 'monitor_checks older than 90 days');
      const cs = await query("DELETE FROM crowdsec_decisions WHERE expires_at IS NOT NULL AND expires_at < NOW()");
      console.log('Retention: deleted', cs.rowCount, 'expired crowdsec_decisions');
    } catch (err) { console.error('Retention job error:', err); }
  };
  retentionInterval = setInterval(runCleanup, 60 * 60 * 1000);
}

// ── Auth middleware ────────────────────────────────────────────────────────────

/** Paths that require X-API-Key agent auth (not JWT). The route handler validates inline. */
const AGENT_PATHS = new Set(['POST /api/v1/metrics']);

/** Paths that are fully public — no auth required. */
const PUBLIC_PATHS = new Set([
  'POST /api/v1/auth/login',
  'GET /api/v1/config',   // safe config subset (no secrets)
]);

/**
 * Dual-auth paths: accept either a valid JWT OR a valid X-API-Key matching any
 * row in the servers table. These are read-only status endpoints consumed by
 * Homepage's customapi widget which can only send static headers.
 */
function isDualAuthPath(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  if (path === '/api/v1/status') return true;
  // /api/v1/servers/:id/status  (id is numeric)
  if (/^\/api\/v1\/servers\/\d+\/status$/.test(path)) return true;
  return false;
}

/** Returns true if the given api_key exists in the servers table. */
async function isValidServerApiKey(apiKey: string): Promise<boolean> {
  try {
    const { rows } = await dbQuery('SELECT id FROM servers WHERE api_key = $1 LIMIT 1', [apiKey]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

function buildAuthHook() {
  return async (request: any, reply: any) => {
    const path   = request.url.split('?')[0];
    const method = request.method as string;
    const key    = `${method} ${path}`;

    // Non-API routes (e.g. /health) — always public
    if (!path.startsWith('/api/')) return;
    // Agent ingestion — inline X-API-Key check in handler
    if (AGENT_PATHS.has(key)) return;
    // Explicitly public API paths
    if (PUBLIC_PATHS.has(key)) return;

    const authHeader = request.headers['authorization'] as string | undefined;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Dual-auth paths: JWT takes priority; fall back to X-API-Key
    if (isDualAuthPath(method, path)) {
      if (token) {
        try {
          request.user = verifyToken(token);
          return; // valid JWT — proceed
        } catch { /* fall through to API key check */ }
      }
      const apiKey = request.headers['x-api-key'] as string | undefined;
      if (apiKey && await isValidServerApiKey(apiKey)) {
        // Valid server API key — grant viewer-level access (no user object needed for read-only)
        request.user = { id: 0, username: 'api-key', role: 'viewer' };
        return;
      }
      return reply.status(401).send({ error: 'Authorization header required' });
    }

    // All other API paths require a valid JWT
    if (!token) {
      return reply.status(401).send({ error: 'Authorization header required' });
    }

    try {
      request.user = verifyToken(token);
    } catch {
      return reply.status(401).send({ error: 'Token invalid or expired' });
    }
  };
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    config = await loadConfig();
    await server.register(cors, { origin: true });

    initDatabase(config.server);
    await initializeTables();

    // Auth bootstrapping
    loadOrGenerateJwtSecret();
    await ensureDefaultAdmin();

    // One-time incident backfill
    backfillIncidents().catch(err => console.error('[incidents] backfill startup error:', err));

    initServices(config);

    // Install JWT auth middleware
    server.addHook('onRequest', buildAuthHook());

    // ── Routes ───────────────────────────────────────────────────────────────

    // Public
    server.get('/health', healthCheck);

    // Agent ingestion (X-API-Key auth handled inline)
    server.post('/api/v1/metrics', {
      schema: {
        body: {
          type: 'object',
          required: ['server_name', 'metrics'],
          properties: {
            server_name: { type: 'string', minLength: 1, maxLength: 255 },
            host_ip:     { type: 'string' },
            metrics: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  metric_type: { type: 'string' },
                  value:       { type: 'object' },
                  timestamp:   { type: 'string' },
                },
              },
            },
          },
        },
      },
    }, receiveMetrics);

    // Auth
    server.post('/api/v1/auth/login',          login);
    server.post('/api/v1/auth/logout',         logout);
    server.get('/api/v1/auth/me',              me);
    server.post('/api/v1/auth/change-password', changePassword);

    // User management (admin only — enforced inside handlers)
    server.get('/api/v1/users',                      listUsers);
    server.post('/api/v1/users',                     createUser);
    server.put('/api/v1/users/:id',                  updateUser);
    server.post('/api/v1/users/:id/reset-password',  resetPassword);
    server.delete('/api/v1/users/:id',               deleteUser);

    // Audit log (admin only)
    server.get('/api/v1/audit', listAuditLog);

    // Dashboard (viewer+)
    server.get('/api/v1/config',          getConfig);
    server.get('/api/v1/status',          getStatus);
    server.get('/api/v1/servers',         listServers);
    server.get('/api/v1/servers/:id/status',  getServerStatus);
    server.get('/api/v1/metrics',         getAllMetrics);
    server.get('/api/v1/servers/:id/metrics', getServerMetrics);
    server.get('/api/v1/alerts',          listAlerts);
    server.get('/api/v1/alerts/:id/summary', getAlertSummary);
    server.get('/api/v1/summaries',       listSummaries);
    server.get('/api/v1/docker/containers', getDockerContainers);
    server.get('/api/v1/docker/containers/:name/metrics', getDockerContainerHistory);

    // Operator+
    server.post('/api/v1/alerts/:id/acknowledge', acknowledgeAlert);
    server.post('/api/v1/test-alert', sendTestAlert);

    // Monitors (viewer GET, admin write)
    server.get('/api/v1/monitors',            listMonitors);
    server.post('/api/v1/monitors',           createMonitor);
    server.put('/api/v1/monitors/:id',        updateMonitor);
    server.delete('/api/v1/monitors/:id',     deleteMonitor);
    server.get('/api/v1/monitors/:id/checks', getMonitorChecks);
    server.post('/api/v1/monitors/:id/test',  testMonitorNow);

    // Incidents
    server.get('/api/v1/incidents',              listIncidents);
    server.get('/api/v1/incidents/:id',          getIncident);
    server.post('/api/v1/incidents/:id/claim',   claimIncident);
    server.post('/api/v1/incidents/:id/resolve', resolveIncident);
    server.post('/api/v1/incidents/:id/reopen',  reopenIncident);
    server.put('/api/v1/incidents/:id',          updateIncident);
    server.post('/api/v1/incidents/:id/merge',   mergeIncidents);
    server.post('/api/v1/incidents/:id/split',   splitIncident);

    // Server management
    server.put('/api/v1/servers/:id',              updateServer);
    server.get('/api/v1/servers/:id/security',     getServerSecurity);

    // Wazuh
    server.get('/api/v1/wazuh/agents',             listWazuhAgents);
    server.get('/api/v1/wazuh/agents/:id',         getWazuhAgent);
    server.get('/api/v1/wazuh/status',             getWazuhStatus);
    server.get('/api/v1/wazuh/unmatched',          getWazuhUnmatched);
    server.post('/api/v1/wazuh/test-connection',   testWazuhConnection);

    // CrowdSec
    server.get('/api/v1/crowdsec/decisions',       listCrowdSecDecisions);
    server.get('/api/v1/crowdsec/stats',           getCrowdSecStats);
    server.get('/api/v1/crowdsec/status',          getCrowdSecStatus);
    server.post('/api/v1/crowdsec/test-connection', testCrowdSecConnection);

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal as NodeJS.Signals, async () => {
        console.log(`Received ${signal}, shutting down gracefully…`);
        if (retentionInterval) clearInterval(retentionInterval);
        predictor?.stop();
        summarizer?.stop();
        uptimeMonitor?.stop();
        wazuhMonitor?.stop();
        crowdSecMonitor?.stop();
        await closeDatabase();
        await server.close();
        process.exit(0);
      });
    }

    await server.listen({ port: config.server.port, host: '0.0.0.0' });
    console.log('Fenris server listening on port', config.server.port);
    console.log('NOTICE: Dashboard API now requires JWT auth. Agents still use X-API-Key.');

    await startRetentionJob();

    // Predictor
    const predCfg = config.predictions;
    if (predCfg) {
      const { getDispatcher } = await import('./api/routes.js');
      predictor = new Predictor({
        enabled:              predCfg.enabled ?? true,
        interval_ms:          parseDurationMs(predCfg.interval ?? '5m', 5 * 60_000),
        disk_horizon_days:    predCfg.disk_horizon_days    ?? 7,
        cpu_horizon_hours:    predCfg.cpu_horizon_hours    ?? 1,
        memory_horizon_hours: predCfg.memory_horizon_hours ?? 1,
        disk_threshold:       predCfg.disk_threshold       ?? 85,
        cpu_threshold:        predCfg.cpu_threshold        ?? 90,
        memory_threshold:     predCfg.memory_threshold     ?? 90,
        min_samples:          predCfg.min_samples          ?? 120,
        min_confidence:       predCfg.min_confidence       ?? 0.5,
      }, getDispatcher());
      predictor.start();
    }

    const { getSummarizer } = await import('./api/routes.js');
    summarizer = getSummarizer();

    const { getDispatcher: getDisp } = await import('./api/routes.js');
    uptimeMonitor = new UptimeMonitor(getDisp());
    setUptimeMonitor(uptimeMonitor);
    await uptimeMonitor.start();

    const wazuhCfg = config.wazuh;
    if (wazuhCfg?.enabled) {
      const { getDispatcher: getWazuhDisp } = await import('./api/routes.js');
      wazuhMonitor = new WazuhMonitor(wazuhCfg, getWazuhDisp());
      setWazuhMonitor(wazuhMonitor);
      wazuhMonitor.start().catch(err => console.error('[wazuh] startup error:', err));
    } else {
      console.log('[wazuh] disabled — skipping');
    }

    const crowdSecCfg = config.crowdsec;
    if (crowdSecCfg?.enabled && crowdSecCfg.instances?.length > 0) {
      const { getDispatcher: getCrowdSecDisp } = await import('./api/routes.js');
      crowdSecMonitor = new CrowdSecMonitor(crowdSecCfg, getCrowdSecDisp());
      setCrowdSecMonitor(crowdSecMonitor);
      crowdSecMonitor.start().catch(err => console.error('[crowdsec] startup error:', err));
    } else {
      console.log('[crowdsec] disabled or no instances configured — skipping');
    }

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start().catch(error => {
  console.error('Startup error:', error);
  process.exit(1);
});
