import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from '@fastify/env';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { initDatabase, initializeTables, closeDatabase, query } from './db/client.js';
import { initServices, healthCheck, receiveMetrics, listServers, getAllMetrics, getServerMetrics, listAlerts, acknowledgeAlert, getConfig, getDockerContainers, getDockerContainerHistory } from './api/routes.js';
import { Config } from './types.js';

const server = Fastify({ logger: true });

let config: Config;
let retentionInterval: NodeJS.Timeout | null = null;

async function loadConfig(): Promise<Config> {
  const configPath = process.env.FENRIS_CONFIG || '/app/fenris.yaml';
  try {
    const configData = readFileSync(configPath, 'utf8');
    config = load(configData) as Config;
    // js-yaml does not expand ${ENV_VAR} placeholders — override database_url
    // from the environment so Docker-compose-injected credentials are used.
    if (process.env.DATABASE_URL) {
      config.server.database_url = process.env.DATABASE_URL;
    }
    console.log('Configuration loaded from:', configPath);
    return config;
  } catch (error) {
    console.warn('Could not load config, using defaults:', error);
    
    // Default config
    config = {
      server: {
        port: parseInt(process.env.PORT || '3000'),
        database_url: process.env.DATABASE_URL || 'postgresql://fenris:fenris@localhost:5432/fenris'
      },
      monitors: {
        system: {
          enabled: true,
          scrape_interval: '30s',
          metrics: ['cpu', 'memory', 'disk', 'network']
        },
        disk: {
          paths: [
            { path: '/', name: 'root', warning_threshold: 85, critical_threshold: 95 },
            { path: '/var/lib/docker', name: 'docker-data', warning_threshold: 80, critical_threshold: 90 },
            { path: '/var/log', name: 'logs', warning_threshold: 85, critical_threshold: 95 }
          ]
        }
      },
      alerts: {
        discord: {
          enabled: process.env.DISCORD_WEBHOOK_URL ? true : false,
          webhook_url: process.env.DISCORD_WEBHOOK_URL || '',
          severity_levels: ['info', 'warning', 'critical']
        },
        thresholds: {
          cpu: { warning: 75, critical: 95 },
          memory: { warning: 80, critical: 90 },
          disk: { warning: 85, critical: 95 },
          network: { anomaly_threshold: 3.0 }
        }
      },
      anomaly_detection: {
        enabled: true,
        algorithm: 'zscore',
        zscore_threshold: 3.5,
        window_size: 100,
        min_samples: 60
      }
    };
    return config;
  }
}

async function startRetentionJob(): Promise<void> {
  const metricsDays = config.retention?.metrics_days ?? 30;
  const alertsDays = config.retention?.alerts_days ?? 90;

  const runCleanup = async () => {
    try {
      const mResult = await query(
        'DELETE FROM metrics WHERE timestamp < NOW() - ($1 || \' days\')::INTERVAL',
        [metricsDays]
      );
      console.log('Retention: deleted', mResult.rowCount, 'metric rows older than', metricsDays, 'days');

      const aResult = await query(
        'DELETE FROM alerts WHERE created_at < NOW() - ($1 || \' days\')::INTERVAL',
        [alertsDays]
      );
      console.log('Retention: deleted', aResult.rowCount, 'alert rows older than', alertsDays, 'days');
    } catch (error) {
      console.error('Retention job error:', error);
    }
  };

  retentionInterval = setInterval(runCleanup, 60 * 60 * 1000); // hourly
}


async function start(): Promise<void> {
  try {
    // Load configuration
    config = await loadConfig();
    
    // Register plugins
    await server.register(cors, { origin: true });
    
    // Initialize database
    initDatabase(config.server);
    await initializeTables();
    
    // Initialize services
    initServices(config);
    
    // API key authentication — only /api/ routes are gated
    // POST /api/v1/metrics handles its own auth + auto-registration inline
    // GET /api/v1/config is intentionally public (returns safe config subset)
    const NO_AUTH = new Set(['POST /api/v1/metrics', 'GET /api/v1/config']);
    server.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0];
      // Non-API paths (e.g. /health) never require a key
      if (!path.startsWith('/api/')) return;
      // A few API paths are explicitly public
      if (NO_AUTH.has(`${request.method} ${path}`)) return;

      const apiKey = request.headers['x-api-key'];
      if (!apiKey) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const result = await query('SELECT id FROM servers WHERE api_key = $1', [apiKey]);
      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
    });

    // Register routes
    server.get('/health', healthCheck);
    
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
                  timestamp:   { type: 'string' }
                }
              }
            }
          }
        }
      }
    }, receiveMetrics);
    
    server.get('/api/v1/servers', listServers);
    server.get('/api/v1/metrics', getAllMetrics);
    server.get('/api/v1/servers/:id/metrics', getServerMetrics);
    server.get('/api/v1/alerts', listAlerts);
    server.get('/api/v1/docker/containers', getDockerContainers);
    server.get('/api/v1/docker/containers/:name/metrics', getDockerContainerHistory);
    server.post('/api/v1/alerts/:id/acknowledge', acknowledgeAlert);
    server.get('/api/v1/config', getConfig);
    
    // Graceful shutdown
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      process.on(signal as NodeJS.Signals, async () => {
        console.log('Received', signal, ', shutting down gracefully...');

        if (retentionInterval) {
          clearInterval(retentionInterval);
        }

        await closeDatabase();
        await server.close();
        process.exit(0);
      });
    }
    
    // Start server
    await server.listen({ 
      port: config.server.port, 
      host: '0.0.0.0' 
    });
    
    console.log('Fenris server listening on port', config.server.port);
    console.log('Self-collection disabled — metrics are ingested via agents (POST /api/v1/metrics)');

    // Start data retention job
    await startRetentionJob();
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
start().catch(error => {
  console.error('Startup error:', error);
  process.exit(1);
});
