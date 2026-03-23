import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from '@fastify/env';
import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { initDatabase, initializeTables, closeDatabase } from './db/client.js';
import { initServices, ingestMetrics, healthCheck, receiveMetrics, listServers, getServerMetrics, listAlerts, acknowledgeAlert, getConfig } from './api/routes.js';
import { SystemCollector } from './collectors/system.js';
import { Config } from './types.js';

const server = Fastify({ logger: true });

let collector: SystemCollector;
let config: Config;
let metricInterval: NodeJS.Timeout | null = null;

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
  const match = intervalStr.match(/^(\d+)\s*$/);
  if (!match) {
    return 30000; // Default 30s
  }
  return parseInt(match[1]) * 1000;
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
