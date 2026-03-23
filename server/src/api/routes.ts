import { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/client.js';
import { SystemCollector } from '../collectors/system.js';
import { AnomalyDetector } from '../engine/anomaly.js';
import { DiscordAlert } from '../alerts/discord.js';
import { Metric, Alert, ContainerStats, Config } from '../types.js';

// Global instances
let collector: SystemCollector;
let detector: AnomalyDetector;
let discordAlert: DiscordAlert;
let config: Config;

// Fenris containers excluded from anomaly detection (self-referential noise)
const DOCKER_EXCLUDED = new Set(['fenris-server', 'fenris-web', 'fenris-postgres']);

export function initServices(cfg: Config): void {
  config = cfg;
  collector = new SystemCollector();
  detector = new AnomalyDetector(cfg.anomaly_detection);
  discordAlert = new DiscordAlert(
    cfg.alerts.discord.webhook_url,
    cfg.alerts.discord.enabled,
    cfg.alerts.discord.severity_levels
  );
}

export async function healthCheck(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.send({ status: 'healthy', timestamp: new Date().toISOString() });
}

export async function ingestMetrics(metrics: Metric[]): Promise<{ anomaliesDetected: number }> {
  console.log('Received metrics:', metrics.length, 'records');

  type AnomalyEntry = { isAnomaly: boolean; severity: string; value: number; message?: string };
  const anomalyResults = new Map<string, AnomalyEntry>();

  // Pre-fetch last docker snapshot for state-transition detection (before any inserts)
  const prevDockerResult = await query(
    "SELECT value->'docker' AS containers FROM metrics WHERE server_id = $1 AND metric_type = 'docker' ORDER BY timestamp DESC LIMIT 1",
    [metrics[0]?.server_id ?? 1]
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
          const cpuKey = `docker:${c.name}:cpu`;
          detector.addMetric(cpuKey, c.cpu_percent);
          const cpuResult = detector.detectAnomaly(cpuKey, c.cpu_percent);
          if (cpuResult.isAnomaly) {
            anomalyResults.set(cpuKey, {
              isAnomaly: true, severity: 'warning', value: c.cpu_percent,
              message: `Container '${c.name}' CPU anomaly: ${c.cpu_percent.toFixed(1)}%`
            });
          }

          const memKey = `docker:${c.name}:memory`;
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

    detector.addMetric(metric.metric_type, numericValue);
    const result = detector.detectAnomaly(metric.metric_type, numericValue);

    if (result.isAnomaly) {
      const severity = determineSeverity(metric.metric_type, numericValue, config.alerts.thresholds);
      anomalyResults.set(metric.metric_type, {
        isAnomaly: true,
        severity,
        value: numericValue
      });
    }
  }

  await query('UPDATE servers SET last_heartbeat = NOW() WHERE id = $1', [metrics[0].server_id]);

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
    await discordAlert.send(alert);
  }

  return { anomaliesDetected: anomalyResults.size };
}

export async function receiveMetrics(request: FastifyRequest<{ Body: Metric[] }>, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const result = await ingestMetrics(request.body);
    return reply.status(201).send({ success: true, ...result });
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

export async function getDockerContainers(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const result = await query(
      "SELECT value->'docker' AS containers, timestamp FROM metrics WHERE server_id = 1 AND metric_type = 'docker' ORDER BY timestamp DESC LIMIT 1"
    );
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

    const result = await query(
      `SELECT m.timestamp, elem AS stats
       FROM metrics m,
            LATERAL jsonb_array_elements(m.value->'docker') AS elem
       WHERE m.server_id = 1
         AND m.metric_type = 'docker'
         AND elem->>'name' = $1
       ORDER BY m.timestamp DESC
       LIMIT $2`,
      [containerName, limit]
    );

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

    let sql = 'SELECT * FROM alerts ORDER BY created_at DESC LIMIT $1';
    let params: any[] = [limit];

    if (acknowledged !== undefined) {
      sql = 'SELECT * FROM alerts WHERE acknowledged = $1 ORDER BY created_at DESC LIMIT $2';
      params = [acknowledged === 'true', limit];
    }

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
    // Strip all credential fields before sending
    delete safeConfig.server;
    delete safeConfig.alerts.discord.webhook_url;
    return reply.send(safeConfig);
  } catch (error) {
    console.error('Error getting config:', error);
    return reply.status(500).send({ error: 'Failed to get config' });
  }
}
