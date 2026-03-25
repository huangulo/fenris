import { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/client.js';
import { AnomalyDetector } from '../engine/anomaly.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';
import { Metric, Alert, ContainerStats, Config } from '../types.js';

// Global instances
let detector: AnomalyDetector;
let dispatcher: AlertDispatcher;
let config: Config;

// Fenris containers excluded from anomaly detection (self-referential noise)
const DOCKER_EXCLUDED = new Set(['fenris-server', 'fenris-web', 'fenris-postgres']);

export function initServices(cfg: Config): void {
  config = cfg;
  detector = new AnomalyDetector(cfg.anomaly_detection);
  dispatcher = new AlertDispatcher(cfg);
}

export async function healthCheck(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.send({ status: 'healthy', timestamp: new Date().toISOString() });
}

export async function ingestMetrics(metrics: Metric[]): Promise<{ anomaliesDetected: number }> {
  console.log('Received metrics:', metrics.length, 'records');

  const serverId = metrics[0]?.server_id ?? 1;
  // Scope detector keys per server so histories don't bleed across hosts
  const key = (k: string) => `${serverId}:${k}`;

  type AnomalyEntry = { isAnomaly: boolean; severity: string; value: number; message?: string };
  const anomalyResults = new Map<string, AnomalyEntry>();

  // Pre-fetch last docker snapshot for state-transition detection (before any inserts)
  const prevDockerResult = await query(
    "SELECT value->'docker' AS containers FROM metrics WHERE server_id = $1 AND metric_type = 'docker' ORDER BY timestamp DESC LIMIT 1",
    [serverId]
  );
  const prevContainers: ContainerStats[] = prevDockerResult.rows[0]?.containers ?? [];
  const prevStateMap = new Map(prevContainers.map(c => [c.name, c.state]));

  for (const metric of metrics) {
    await query(
      'INSERT INTO metrics (server_id, metric_type, value, timestamp) VALUES ($1, $2, $3::jsonb, $4)',
      [metric.server_id, metric.metric_type, JSON.stringify(metric.value), metric.timestamp]
    );

    if (metric.metric_type === 'docker') {
      const containers = metric.value.docker ?? [];
      for (const c of containers) {
        // State-transition alert — immediate critical, no Z-score needed
        const prevState = prevStateMap.get(c.name);
        if (prevState === 'running' && c.state !== 'running' && !DOCKER_EXCLUDED.has(c.name)) {
          anomalyResults.set(`docker:${c.name}:state`, {
            isAnomaly: true,
            severity: 'critical',
            value: 0,
            message: `Container '${c.name}' stopped (was running, now ${c.state})`
          });
        }

        // Z-score anomaly on CPU and memory (skip Fenris containers)
        if (!DOCKER_EXCLUDED.has(c.name)) {
          const cpuKey = key(`docker:${c.name}:cpu`);
          detector.addMetric(cpuKey, c.cpu_percent);
          const cpuResult = detector.detectAnomaly(cpuKey, c.cpu_percent);
          if (cpuResult.isAnomaly) {
            anomalyResults.set(cpuKey, {
              isAnomaly: true, severity: 'warning', value: c.cpu_percent,
              message: `Container '${c.name}' CPU anomaly: ${c.cpu_percent.toFixed(1)}%`
            });
          }

          const memKey = key(`docker:${c.name}:memory`);
          detector.addMetric(memKey, c.memory_percent);
          const memResult = detector.detectAnomaly(memKey, c.memory_percent);
          if (memResult.isAnomaly) {
            anomalyResults.set(memKey, {
              isAnomaly: true, severity: 'warning', value: c.memory_percent,
              message: `Container '${c.name}' memory anomaly: ${c.memory_percent.toFixed(1)}%`
            });
          }
        }
      }
      continue; // skip generic addMetric path
    }

    let numericValue: number = 0;
    if (metric.metric_type === 'cpu') {
      numericValue = metric.value.cpu!.usage_percent;
    } else if (metric.metric_type === 'memory') {
      numericValue = metric.value.memory!.used_percent;
    } else if (metric.metric_type === 'disk') {
      numericValue = metric.value.disk!.used_percent;
    } else if (metric.metric_type === 'network') {
      numericValue = metric.value.network!.rx_bytes;
    }

    const metricKey = key(metric.metric_type);
    detector.addMetric(metricKey, numericValue);
    const result = detector.detectAnomaly(metricKey, numericValue);

    if (result.isAnomaly) {
      const severity = determineSeverity(metric.metric_type, numericValue, config.alerts.thresholds);
      anomalyResults.set(metric.metric_type, {
        isAnomaly: true,
        severity,
        value: numericValue
      });
    }
  }

  await query('UPDATE servers SET last_heartbeat = NOW() WHERE id = $1', [serverId]);

  for (const [metricType, anomaly] of anomalyResults.entries()) {
    const message = anomaly.message ?? `Anomaly detected in ${metricType.toUpperCase()} metrics`;
    const alert: Alert = {
      id: 0,
      server_id: metrics[0].server_id,
      severity: anomaly.severity as Alert['severity'],
      message,
      metric_type: metricType.startsWith('docker:') ? 'docker' : metricType as Alert['metric_type'],
      actual_value: { value: anomaly.value },
      threshold_value: { zscore: detector.getHistory(metricType).slice(-1)[0] ?? 0 },
      acknowledged: false,
      created_at: new Date()
    };

    const alertResult = await query(
      'INSERT INTO alerts (server_id, severity, message, metric_type, actual_value, threshold_value, acknowledged, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING id',
      [alert.server_id, alert.severity, alert.message, alert.metric_type,
       JSON.stringify(alert.actual_value), JSON.stringify(alert.threshold_value),
       alert.acknowledged, alert.created_at]
    );

    alert.id = alertResult.rows[0].id;
    await dispatcher.dispatchAlert(alert);
  }

  return { anomaliesDetected: anomalyResults.size };
}

interface AgentPayload {
  server_name: string;
  metrics: Omit<Metric, 'id' | 'server_id'>[];
}

export async function receiveMetrics(
  request: FastifyRequest<{ Body: AgentPayload }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (!apiKey) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { server_name, metrics: rawMetrics } = request.body;
    if (!server_name) {
      return reply.status(400).send({ error: 'server_name is required in payload' });
    }
    if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) {
      return reply.status(400).send({ error: 'metrics array is required and must not be empty' });
    }

    // Resolve IP from request (X-Forwarded-For → socket)
    const forwarded = request.headers['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim()
             ?? request.socket.remoteAddress
             ?? '0.0.0.0';

    // Upsert: auto-register on first contact, update heartbeat on reconnect
    const upsertResult = await query(
      `INSERT INTO servers (name, ip_address, api_key, last_heartbeat)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (api_key, name)
       DO UPDATE SET ip_address = EXCLUDED.ip_address, last_heartbeat = NOW()
       RETURNING id, (xmax = 0) AS is_new`,
      [server_name, ip, apiKey]
    );

    const { id: serverId, is_new: isNew } = upsertResult.rows[0];
    if (isNew) {
      console.log(`[server] auto-registered new agent: "${server_name}" (${ip}) → server_id=${serverId}`);
    }

    // Stamp server_id on all incoming metrics
    const metrics: Metric[] = rawMetrics.map(m => ({
      ...m,
      id: 0,
      server_id: serverId,
      timestamp: m.timestamp ? new Date(m.timestamp as unknown as string) : new Date()
    }));

    const result = await ingestMetrics(metrics);
    return reply.status(201).send({ success: true, server_id: serverId, ...result });
  } catch (error) {
    console.error('Error processing metrics:', error);
    return reply.status(500).send({ error: 'Failed to process metrics' });
  }
}

function determineSeverity(metricType: string, value: number, thresholds: Config['alerts']['thresholds']): 'info' | 'warning' | 'critical' {
  const thresholdConfig = thresholds[metricType as keyof typeof thresholds];
  if (!thresholdConfig || typeof thresholdConfig !== 'object') {
    return 'info';
  }

  const cfg = thresholdConfig as { warning?: number; critical?: number };

  if (cfg.critical && value >= cfg.critical) {
    return 'critical';
  } else if (cfg.warning && value >= cfg.warning) {
    return 'warning';
  }

  return 'info';
}

export async function listServers(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const result = await query('SELECT * FROM servers ORDER BY last_heartbeat DESC NULLS LAST');
    return reply.send(result.rows);
  } catch (error) {
    console.error('Error listing servers:', error);
    return reply.status(500).send({ error: 'Failed to list servers' });
  }
}

export async function getServerMetrics(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const serverId = parseInt(request.params.id);
    const limit = parseInt((request.query as any).limit || '100');

    const result = await query(
      'SELECT * FROM metrics WHERE server_id = $1 ORDER BY timestamp DESC LIMIT $2',
      [serverId, limit]
    );

    return reply.send(result.rows);
  } catch (error) {
    console.error('Error fetching server metrics:', error);
    return reply.status(500).send({ error: 'Failed to fetch metrics' });
  }
}

export async function getAllMetrics(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const limit = parseInt((request.query as any).limit || '100');
    const serverIdParam = (request.query as any).server_id;

    let result;
    if (serverIdParam) {
      result = await query(
        'SELECT * FROM metrics WHERE server_id = $1 ORDER BY timestamp DESC LIMIT $2',
        [parseInt(serverIdParam), limit]
      );
    } else {
      result = await query(
        'SELECT * FROM metrics ORDER BY timestamp DESC LIMIT $1',
        [limit]
      );
    }

    return reply.send(result.rows);
  } catch (error) {
    console.error('Error fetching metrics:', error);
    return reply.status(500).send({ error: 'Failed to fetch metrics' });
  }
}

export async function getDockerContainers(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const serverIdParam = (request.query as any).server_id;
    let result;
    if (serverIdParam) {
      const serverId = parseInt(serverIdParam);
      result = await query(
        "SELECT value->'docker' AS containers, timestamp FROM metrics WHERE server_id = $1 AND metric_type = 'docker' ORDER BY timestamp DESC LIMIT 1",
        [serverId]
      );
    } else {
      result = await query(
        "SELECT value->'docker' AS containers, timestamp FROM metrics WHERE metric_type = 'docker' ORDER BY timestamp DESC LIMIT 1"
      );
    }
    if (result.rows.length === 0) {
      return reply.send({ containers: [], timestamp: null });
    }
    return reply.send({ containers: result.rows[0].containers ?? [], timestamp: result.rows[0].timestamp });
  } catch (error) {
    console.error('Error fetching docker containers:', error);
    return reply.status(500).send({ error: 'Failed to fetch docker containers' });
  }
}

export async function getDockerContainerHistory(
  request: FastifyRequest<{ Params: { name: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const containerName = request.params.name;
    const limit = Math.min(parseInt((request.query as any).limit || '50'), 200);
    const serverIdParam = (request.query as any).server_id;

    let result;
    if (serverIdParam) {
      result = await query(
        `SELECT m.timestamp, elem AS stats
         FROM metrics m,
              LATERAL jsonb_array_elements(m.value->'docker') AS elem
         WHERE m.server_id = $1
           AND m.metric_type = 'docker'
           AND elem->>'name' = $2
         ORDER BY m.timestamp DESC
         LIMIT $3`,
        [parseInt(serverIdParam), containerName, limit]
      );
    } else {
      result = await query(
        `SELECT m.timestamp, elem AS stats
         FROM metrics m,
              LATERAL jsonb_array_elements(m.value->'docker') AS elem
         WHERE m.metric_type = 'docker'
           AND elem->>'name' = $1
         ORDER BY m.timestamp DESC
         LIMIT $2`,
        [containerName, limit]
      );
    }

    return reply.send(result.rows);
  } catch (error) {
    console.error('Error fetching docker container history:', error);
    return reply.status(500).send({ error: 'Failed to fetch container history' });
  }
}

export async function listAlerts(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const limit = parseInt((request.query as any).limit || '50');
    const acknowledged = (request.query as any).acknowledged;
    const serverIdParam = (request.query as any).server_id;

    const conditions: string[] = [];
    const params: any[] = [];

    if (serverIdParam) {
      params.push(parseInt(serverIdParam));
      conditions.push(`server_id = $${params.length}`);
    }
    if (acknowledged !== undefined) {
      params.push(acknowledged === 'true');
      conditions.push(`acknowledged = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const sql = `SELECT a.*, s.name AS server_name FROM alerts a LEFT JOIN servers s ON s.id = a.server_id ${where} ORDER BY a.created_at DESC LIMIT $${params.length}`;

    const result = await query(sql, params);
    return reply.send(result.rows);
  } catch (error) {
    console.error('Error listing alerts:', error);
    return reply.status(500).send({ error: 'Failed to list alerts' });
  }
}

export async function acknowledgeAlert(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const alertId = parseInt(request.params.id);

    const result = await query(
      'UPDATE alerts SET acknowledged = TRUE WHERE id = $1 RETURNING *',
      [alertId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Alert not found' });
    }

    return reply.send(result.rows[0]);
  } catch (error) {
    console.error('Error acknowledging alert:', error);
    return reply.status(500).send({ error: 'Failed to acknowledge alert' });
  }
}

export async function getConfig(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const safeConfig = JSON.parse(JSON.stringify(config));
    // Strip server block (contains database_url) and all channel credentials
    delete safeConfig.server;
    if (safeConfig.alerts?.discord)  delete safeConfig.alerts.discord.webhook_url;
    if (safeConfig.alerts?.slack)    delete safeConfig.alerts.slack.webhook_url;
    if (safeConfig.alerts?.email) {
      delete safeConfig.alerts.email.password;
      delete safeConfig.alerts.email.username;
    }
    return reply.send(safeConfig);
  } catch (error) {
    console.error('Error getting config:', error);
    return reply.status(500).send({ error: 'Failed to get config' });
  }
}
