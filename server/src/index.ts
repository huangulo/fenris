import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from '@fastify/env';
import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { initDatabase, initializeTables, closeDatabase, query } from './db/client.js';
import { initServices, ingestMetrics, healthCheck, receiveMetrics, listServers, getServerMetrics, listAlerts, acknowledgeAlert, getConfig } from './api/routes.js';
import { SystemCollector } from './collectors/system.js';
import { Config } from './types.js';

const server = Fastify({ logger: true });

let collector: SystemCollector;
let config: Config;
let metricInterval: NodeJS.Timeout | null = null;
let retentionInterval: NodeJS.Timeout | null = null;

async function loadConfig(): Promise<Config> {
  const configPath = process.env.FENRIS_CONFIG || '/app/fenris.yaml';
  try {
    const configData = readFileSync(configPath, 'utf8');
    config = load(configData) as Config;
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
        zscore_threshold: 3.0,
        window_size: 100,
        min_samples: 30
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

async function startMetricsCollection(): Promise<void> {
  if (!config.monitors.system.enabled) {
    console.log('System monitoring disabled');
    return;
  }
  
  collector = new SystemCollector();
  const intervalMs = parseInterval(config.monitors.system.scrape_interval);
  const diskPaths = config.monitors.disk.paths.map(d => d.path);
  
  console.log('Starting metrics collection every', intervalMs, 'ms');
  
  metricInterval = setInterval(async () => {
    try {
      const metrics = await collector.collectAll(diskPaths);
      await ingestMetrics(metrics);
    } catch (error) {
      console.error('Error collecting metrics:', error);
    }
  }, intervalMs);
}

function parseInterval(intervalStr: string): number {
  const match = intervalStr.match(/^(\d+)(s|m|h)$/);
  if (!match) {
    throw new Error(`Unrecognized interval format: "${intervalStr}". Use e.g. "30s", "5m", "2h".`);
  }
  const n = parseInt(match[1], 10);
  if (match[2] === 's') return n * 1000;
  if (match[2] === 'm') return n * 60 * 1000;
  return n * 60 * 60 * 1000; // h
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
    
    // API key authentication — exempt only health + config
    const EXEMPT: Set<string> = new Set(['GET /health', 'GET /api/v1/config']);
    server.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0];
      if (EXEMPT.has(`${request.method} ${path}`)) return;

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
          type: 'array',
          items: {
            type: 'object',
            properties: {
              server_id: { type: 'number' },
              metric_type: { type: 'string' },
              value: { type: 'object' },
              timestamp: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }, receiveMetrics);
    
    server.get('/api/v1/servers', listServers);
    server.get('/api/v1/servers/:id/metrics', getServerMetrics);
    server.get('/api/v1/alerts', listAlerts);
    server.post('/api/v1/alerts/:id/acknowledge', acknowledgeAlert);
    server.get('/api/v1/config', getConfig);
    
    // Graceful shutdown
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      process.on(signal as NodeJS.Signals, async () => {
        console.log('Received', signal, ', shutting down gracefully...');
        
        if (metricInterval) {
          clearInterval(metricInterval);
        }
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
    
    // Start metrics collection
    await startMetricsCollection();

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
