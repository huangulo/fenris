import { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/client.js';
import { AnomalyDetector } from '../engine/anomaly.js';
import { AlertDispatcher, TestResult } from '../alerts/dispatcher.js';
import { Summarizer } from '../engine/summarizer.js';
import { attachAlertToIncident, autoResolveIncident } from '../engine/incidents.js';
import { UptimeMonitor, MonitorConfig } from '../monitors/uptime.js';
import { WazuhMonitor } from '../monitors/wazuh.js';
import { Metric, Alert, ContainerStats, Config } from '../types.js';

/** Resolve floor thresholds with hardcoded defaults so the config key is optional. */
function getFloors(cfg: Config) {
  const f = cfg.anomaly_detection.floors;
  return {
    cpu:           f?.cpu           ?? 50,
    memory:        f?.memory        ?? 60,
    disk:          f?.disk          ?? 70,
    docker_cpu:    f?.docker_cpu    ?? 30,
    docker_memory: f?.docker_memory ?? 40,
  };
}

// Global instances
let detector: AnomalyDetector;
let dispatcher: AlertDispatcher;
let summarizer: Summarizer | null = null;
let uptimeMonitor: UptimeMonitor | null = null;
let wazuhMonitor:  WazuhMonitor  | null = null;
let config: Config;

// Fenris containers excluded from anomaly detection (self-referential noise)
const DOCKER_EXCLUDED = new Set(['fenris-server', 'fenris-web', 'fenris-postgres']);

export function initServices(cfg: Config): void {
  config = cfg;
  detector = new AnomalyDetector(cfg.anomaly_detection);
  dispatcher = new AlertDispatcher(cfg);
  if (cfg.ai) {
    summarizer = new Summarizer(cfg.ai);
    summarizer.start();
  }
}

export function getDispatcher(): AlertDispatcher {
  return dispatcher;}

export function getSummarizer(): Summarizer | null {
  return summarizer;
}

export function setUptimeMonitor(m: UptimeMonitor): void {
  uptimeMonitor = m;
}

export function getUptimeMonitor(): UptimeMonitor | null {
  return uptimeMonitor;
}

export function setWazuhMonitor(m: WazuhMonitor): void {
  wazuhMonitor = m;
}

export function getWazuhMonitor(): WazuhMonitor | null {
  return wazuhMonitor;
}

export async function healthCheck(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.send({ status: 'healthy', timestamp: new Date().toISOString() });
}

// Per-container cooldown maps (server_id:container_name → last alert ms)
const flappingCooldowns    = new Map<string, number>();
const imageChangeCooldowns = new Map<string, number>();

interface PrevContainerInfo {
  state: string;
  image_hash?: string;
  started_at?: string;
  image?: string;
}

async function trackContainerEvents(
  serverId: number,
  c: ContainerStats,
  prev: PrevContainerInfo | null,
): Promise<void> {
  const ins = (eventType: string, prevState: string | null, newState: string | null, meta: object) =>
    query(
      'INSERT INTO container_events (server_id, container_name, event_type, previous_state, new_state, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [serverId, c.name, eventType, prevState, newState, JSON.stringify(meta)]
    );

  if (!prev) {
    await ins('created', null, c.state, { image: c.image });
    return;
  }

  // State changed
  if (prev.state !== c.state) {
    await ins('state_change', prev.state, c.state, {});
  }

  // Restart: started_at moved forward
  if (c.started_at && prev.started_at && c.started_at !== prev.started_at && c.state === 'running') {
    await ins('restart', prev.state, c.state, { started_at: c.started_at });

    // Flapping: ≥3 restarts in last 15 min → warning alert with 30-min cooldown
    const fKey = `${serverId}:${c.name}`;
    const now  = Date.now();
    if (now - (flappingCooldowns.get(fKey) ?? 0) > 30 * 60_000) {
      const result = await query(
        "SELECT COUNT(*) AS cnt FROM container_events WHERE server_id = $1 AND container_name = $2 AND event_type = 'restart' AND created_at > NOW() - INTERVAL '15 minutes'",
        [serverId, c.name]
      );
      if (parseInt(result.rows[0].cnt, 10) >= 3) {
        flappingCooldowns.set(fKey, now);
        const alert: Alert = {
          id: 0, server_id: serverId, severity: 'warning',
          message: `Container '${c.name}' is flapping (${result.rows[0].cnt} restarts in 15 min)`,
          metric_type: 'docker',
          actual_value: { restarts: parseInt(result.rows[0].cnt, 10) },
          threshold_value: { max: 3 },
          acknowledged: false, created_at: new Date(),
        };
        const ar = await query(
          'INSERT INTO alerts (server_id, severity, message, metric_type, actual_value, threshold_value, acknowledged, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING id',
          [alert.server_id, alert.severity, alert.message, alert.metric_type,
           JSON.stringify(alert.actual_value), JSON.stringify(alert.threshold_value),
           alert.acknowledged, alert.created_at]
        );
        alert.id = ar.rows[0].id;
        dispatcher.dispatchAlert(alert).catch(() => {});
        summarizer?.enqueue(alert);
        attachAlertToIncident(alert.id, alert.server_id, alert.severity, 'docker', alert.message);
      }
    }
  }

  // Image hash changed
  if (c.image_hash && prev.image_hash && c.image_hash !== prev.image_hash) {
    await ins('image_change', prev.state, c.state, {
      old_image: prev.image ?? '', new_image: c.image,
      old_hash:  prev.image_hash,  new_hash:  c.image_hash,
    });

    // Info alert with 1-hour cooldown
    const iKey = `${serverId}:${c.name}:img`;
    const now  = Date.now();
    if (now - (imageChangeCooldowns.get(iKey) ?? 0) > 60 * 60_000) {
      imageChangeCooldowns.set(iKey, now);
      const oldTag = (prev.image ?? '').split('/').pop() ?? prev.image ?? prev.image_hash.slice(7, 19);
      const newTag = c.image.split('/').pop() ?? c.image;
      const alert: Alert = {
        id: 0, server_id: serverId, severity: 'info',
        message: `Container '${c.name}' image updated: ${oldTag} → ${newTag}`,
        metric_type: 'docker',
        actual_value: {}, threshold_value: {},
        acknowledged: false, created_at: new Date(),
      };
      const ar = await query(
        'INSERT INTO alerts (server_id, severity, message, metric_type, actual_value, threshold_value, acknowledged, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING id',
        [alert.server_id, alert.severity, alert.message, alert.metric_type,
         JSON.stringify(alert.actual_value), JSON.stringify(alert.threshold_value),
         alert.acknowledged, alert.created_at]
      );
      alert.id = ar.rows[0].id;
      dispatcher.dispatchAlert(alert).catch(() => {});
      summarizer?.enqueue(alert);
    }
  }
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
  type PrevInfo = { state: string; image_hash?: string; started_at?: string; image?: string };
  const prevStateMap = new Map<string, PrevInfo>(
    prevContainers.map(c => [c.name, { state: c.state, image_hash: c.image_hash, started_at: c.started_at, image: c.image }])
  );

  for (const metric of metrics) {
    await query(
      'INSERT INTO metrics (server_id, metric_type, value, timestamp) VALUES ($1, $2, $3::jsonb, $4)',
      [metric.server_id, metric.metric_type, JSON.stringify(metric.value), metric.timestamp]
    );

    // Network rx_bytes is highly variable (orders-of-magnitude bursts are normal
    // traffic); z-score on raw byte counts produces constant false positives.
    // Skip anomaly detection for network — thresholds are not applicable either.
    if (metric.metric_type === 'network') {
      continue;
    }

    if (metric.metric_type === 'docker') {
      const containers = metric.value.docker ?? [];
      const newNames = new Set(containers.map(c => c.name));

      for (const c of containers) {
        // State-transition alert — immediate critical, no Z-score needed
        const prevInfo = prevStateMap.get(c.name);
        if (prevInfo?.state === 'running' && c.state !== 'running' && !DOCKER_EXCLUDED.has(c.name)) {
          anomalyResults.set(`docker:${c.name}:state`, {
            isAnomaly: true,
            severity: 'critical',
            value: 0,
            message: `Container '${c.name}' stopped (was running, now ${c.state})`
          });
        }

        // Track container lifecycle events (fire-and-forget)
        if (!DOCKER_EXCLUDED.has(c.name)) {
          trackContainerEvents(serverId, c, prevInfo ?? null).catch(
            err => console.error('[events] container event error:', err)
          );
        }

        // Z-score anomaly on CPU and memory (skip Fenris containers)
        if (!DOCKER_EXCLUDED.has(c.name)) {
          const floors = getFloors(config);

          const cpuKey = key(`docker:${c.name}:cpu`);
          detector.addMetric(cpuKey, c.cpu_percent);
          if (c.cpu_percent > floors.docker_cpu) {
            const cpuResult = detector.detectAnomaly(cpuKey, c.cpu_percent);
            if (cpuResult.isAnomaly) {
              anomalyResults.set(cpuKey, {
                isAnomaly: true, severity: 'warning', value: c.cpu_percent,
                message: `Container '${c.name}' CPU anomaly: ${c.cpu_percent.toFixed(1)}%`
              });
            }
          }

          const memKey = key(`docker:${c.name}:memory`);
          detector.addMetric(memKey, c.memory_percent);
          if (c.memory_percent > floors.docker_memory) {
            const memResult = detector.detectAnomaly(memKey, c.memory_percent);
            if (memResult.isAnomaly) {
              anomalyResults.set(memKey, {
                isAnomaly: true, severity: 'warning', value: c.memory_percent,
                message: `Container '${c.name}' memory anomaly: ${c.memory_percent.toFixed(1)}%`
              });
            }
          }
        }
      }
      // Track containers that disappeared from the snapshot
      for (const [name, prevInfo] of prevStateMap) {
        if (!newNames.has(name) && !DOCKER_EXCLUDED.has(name)) {
          query(
            'INSERT INTO container_events (server_id, container_name, event_type, previous_state, new_state, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
            [serverId, name, 'removed', prevInfo.state, null, JSON.stringify({})]
          ).catch(err => console.error('[events] removed event insert error:', err));
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

    const floors = getFloors(config);
    const floor = metric.metric_type === 'cpu'    ? floors.cpu
                : metric.metric_type === 'memory' ? floors.memory
                : metric.metric_type === 'disk'   ? floors.disk
                : null;

    if (floor !== null && numericValue > floor) {
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
    summarizer?.enqueue(alert);
    // Attach to incident (fire-and-forget — never blocks alert delivery)
    attachAlertToIncident(
      alert.id, alert.server_id, alert.severity,
      alert.metric_type ?? metricType, alert.message
    );
  }

  return { anomaliesDetected: anomalyResults.size };
}

interface AgentPayload {
  server_name: string;
  host_ip?: string;
  os_type?: string;
  host_uptime_seconds?: number;
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

    const { server_name, host_ip: payloadHostIP, os_type, metrics: rawMetrics } = request.body;
    if (!server_name) {
      return reply.status(400).send({ error: 'server_name is required in payload' });
    }
    if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) {
      return reply.status(400).send({ error: 'metrics array is required and must not be empty' });
    }

    // Resolve IP: X-Forwarded-For → socket remote address
    const forwarded = request.headers['x-forwarded-for'];
    const requestIP = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim()
                   ?? request.socket.remoteAddress
                   ?? '0.0.0.0';

    // If the request IP is a Docker-internal address (172.16–31.x or 10.x), prefer the
    // host_ip the agent detected via its own network interfaces.
    const isDockerIP = /^(172\.(1[6-9]|2\d|3[01])\.|10\.)/.test(requestIP);
    const ip = (isDockerIP && payloadHostIP) ? payloadHostIP : requestIP;

    // Upsert: auto-register on first contact, update heartbeat on reconnect
    const upsertResult = await query(
      `INSERT INTO servers (name, ip_address, api_key, last_heartbeat, os_type)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (api_key, name)
       DO UPDATE SET ip_address = EXCLUDED.ip_address, last_heartbeat = NOW(),
         os_type = COALESCE(EXCLUDED.os_type, servers.os_type)
       RETURNING id, (xmax = 0) AS is_new`,
      [server_name, ip, apiKey, os_type ?? null]
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
      // One latest snapshot per server, then merge all container arrays
      result = await query(
        `SELECT DISTINCT ON (server_id) value->'docker' AS containers, timestamp
         FROM metrics WHERE metric_type = 'docker'
         ORDER BY server_id, timestamp DESC`
      );
    }
    if (result.rows.length === 0) {
      return reply.send({ containers: [], timestamp: null });
    }
    if (!serverIdParam) {
      // Merge containers from all servers into a single flat array
      const allContainers = result.rows.flatMap((r: any) => r.containers ?? []);
      const latestTs = result.rows.reduce((max: any, r: any) =>
        r.timestamp > max ? r.timestamp : max, result.rows[0].timestamp);
      return reply.send({ containers: allContainers, timestamp: latestTs });
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

    const alert = result.rows[0];
    if (alert.incident_id) {
      autoResolveIncident(alert.incident_id);
    }

    return reply.send(alert);
  } catch (error) {
    console.error('Error acknowledging alert:', error);
    return reply.status(500).send({ error: 'Failed to acknowledge alert' });
  }
}

interface TestAlertBody {
  channels?: string[];
}

export async function sendTestAlert(
  request: FastifyRequest<{ Body: TestAlertBody }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const requested = Array.isArray(request.body?.channels) ? request.body.channels : undefined;
    const result: TestResult = await dispatcher.dispatchTest(requested);
    return reply.send(result);
  } catch (error) {
    console.error('Error sending test alert:', error);
    return reply.status(500).send({ error: 'Failed to send test alert' });
  }
}

export async function getAlertSummary(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const alertId = parseInt(request.params.id);
    const result = await query(
      `SELECT s.id, s.summary, s.model, s.created_at, s.alert_ids
       FROM alert_summaries s
       JOIN alerts a ON a.summary_id = s.id
       WHERE a.id = $1`,
      [alertId]
    );
    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'No summary for this alert' });
    }
    return reply.send(result.rows[0]);
  } catch (error) {
    console.error('Error fetching alert summary:', error);
    return reply.status(500).send({ error: 'Failed to fetch summary' });
  }
}

export async function listSummaries(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const limit = Math.min(parseInt((request.query as any).limit || '10'), 50);
    const serverIdParam = (request.query as any).server_id;

    let result;
    if (serverIdParam) {
      result = await query(
        `SELECT s.*, srv.name AS server_name
         FROM alert_summaries s
         LEFT JOIN servers srv ON srv.id = s.server_id
         WHERE s.server_id = $1
         ORDER BY s.created_at DESC LIMIT $2`,
        [parseInt(serverIdParam), limit]
      );
    } else {
      result = await query(
        `SELECT s.*, srv.name AS server_name
         FROM alert_summaries s
         LEFT JOIN servers srv ON srv.id = s.server_id
         ORDER BY s.created_at DESC LIMIT $1`,
        [limit]
      );
    }
    return reply.send(result.rows);
  } catch (error) {
    console.error('Error listing summaries:', error);
    return reply.status(500).send({ error: 'Failed to list summaries' });
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

// ── Homepage status widget ────────────────────────────────────────────────────

export async function getStatus(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const [serversRes, dockerRes, monitorsRes, alertsRes, incidentsRes] = await Promise.all([
      query('SELECT COUNT(*) AS total, COUNT(last_heartbeat) FILTER (WHERE last_heartbeat > NOW() - INTERVAL \'90 seconds\') AS online FROM servers'),
      query(`SELECT DISTINCT ON (server_id) value->'docker' AS containers
             FROM metrics WHERE metric_type = 'docker'
             ORDER BY server_id, timestamp DESC`),
      query('SELECT is_up FROM (SELECT DISTINCT ON (monitor_id) is_up FROM monitor_checks ORDER BY monitor_id, checked_at DESC) sub'),
      query('SELECT COUNT(*) AS total FROM alerts WHERE acknowledged = FALSE'),
      query(`SELECT
               COUNT(*) FILTER (WHERE state = 'new')           AS incidents_new,
               COUNT(*) FILTER (WHERE state = 'investigating') AS incidents_investigating,
               COUNT(*) FILTER (WHERE state = 'resolved' AND resolved_at > NOW() - INTERVAL '24 hours') AS incidents_resolved_today
             FROM incidents`),
    ]);

    const serversTotal  = parseInt(serversRes.rows[0]?.total ?? '0');
    const serversOnline = parseInt(serversRes.rows[0]?.online ?? '0');

    // Aggregate container counts from latest docker metrics per server
    let containersRunning = 0;
    let containersTotal   = 0;
    for (const row of dockerRes.rows) {
      const list: Array<{ state: string }> = row.containers ?? [];
      containersTotal   += list.length;
      containersRunning += list.filter(c => c.state === 'running').length;
    }

    const monitorsUp    = monitorsRes.rows.filter(r => r.is_up).length;
    const monitorsTotal = monitorsRes.rows.length;

    // 30-day uptime across all monitors
    let uptimePct = 100;
    if (monitorsTotal > 0) {
      const uptimeRes = await query(
        `SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_up) / NULLIF(COUNT(*), 0), 1) AS pct
         FROM monitor_checks WHERE checked_at > NOW() - INTERVAL '30 days'`
      );
      uptimePct = parseFloat(uptimeRes.rows[0]?.pct ?? '100');
    }

    const activeAlerts = parseInt(alertsRes.rows[0]?.total ?? '0');
    const incidentsNew          = parseInt(incidentsRes.rows[0]?.incidents_new ?? '0');
    const incidentsInvestigating = parseInt(incidentsRes.rows[0]?.incidents_investigating ?? '0');
    const incidentsResolvedToday = parseInt(incidentsRes.rows[0]?.incidents_resolved_today ?? '0');

    return reply.send({
      servers_online:           serversOnline,
      servers_total:            serversTotal,
      containers_running:       containersRunning,
      containers_total:         containersTotal,
      monitors_up:              monitorsUp,
      monitors_total:           monitorsTotal,
      active_alerts:            activeAlerts,
      uptime_percentage:        uptimePct,
      incidents_new:            incidentsNew,
      incidents_investigating:  incidentsInvestigating,
      incidents_resolved_today: incidentsResolvedToday,
    });
  } catch (error) {
    console.error('Error building status:', error);
    return reply.status(500).send({ error: 'Failed to build status' });
  }
}

// ── Per-server status widget ──────────────────────────────────────────────────

export async function getServerStatus(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const serverId = parseInt(request.params.id);
    if (isNaN(serverId)) return reply.status(400).send({ error: 'Invalid server id' });

    const [serverRes, cpuRes, memRes, diskRes, dockerRes, alertsRes] = await Promise.all([
      query('SELECT name, last_heartbeat, created_at FROM servers WHERE id = $1', [serverId]),
      query(
        `SELECT value FROM metrics WHERE server_id = $1 AND metric_type = 'cpu'
         ORDER BY timestamp DESC LIMIT 1`,
        [serverId]
      ),
      query(
        `SELECT value FROM metrics WHERE server_id = $1 AND metric_type = 'memory'
         ORDER BY timestamp DESC LIMIT 1`,
        [serverId]
      ),
      query(
        `SELECT value FROM metrics WHERE server_id = $1 AND metric_type = 'disk'
         ORDER BY timestamp DESC LIMIT 1`,
        [serverId]
      ),
      query(
        `SELECT value->'docker' AS containers FROM metrics
         WHERE server_id = $1 AND metric_type = 'docker'
         ORDER BY timestamp DESC LIMIT 1`,
        [serverId]
      ),
      query(
        `SELECT COUNT(*) AS total FROM alerts
         WHERE server_id = $1 AND acknowledged = FALSE`,
        [serverId]
      ),
    ]);

    if (serverRes.rows.length === 0) {
      return reply.status(404).send({ error: 'Server not found' });
    }

    const server = serverRes.rows[0];
    const lastHeartbeat: Date | null = server.last_heartbeat ? new Date(server.last_heartbeat) : null;
    const isOnline = lastHeartbeat !== null && (Date.now() - lastHeartbeat.getTime()) < 90_000;

    const cpu    = Math.round(cpuRes.rows[0]?.value?.cpu?.usage_percent ?? 0);
    const memory = Math.round(memRes.rows[0]?.value?.memory?.used_percent ?? 0);
    const disk   = Math.round(diskRes.rows[0]?.value?.disk?.used_percent ?? 0);

    const containers: Array<{ state: string }> = dockerRes.rows[0]?.containers ?? [];
    const containersRunning = containers.filter(c => c.state === 'running').length;
    const containersTotal   = containers.length;

    const activeAlerts = parseInt(alertsRes.rows[0]?.total ?? '0');

    // Uptime string from server created_at
    const uptimeMs = lastHeartbeat ? lastHeartbeat.getTime() - new Date(server.created_at).getTime() : 0;
    const uptimeDays  = Math.floor(uptimeMs / (86_400_000));
    const uptimeHours = Math.floor((uptimeMs % 86_400_000) / 3_600_000);
    const uptime = uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours}h` : `${uptimeHours}h`;

    return reply.send({
      name:               server.name,
      status:             isOnline ? 'online' : 'offline',
      cpu,
      memory,
      disk,
      containers_running: containersRunning,
      containers_total:   containersTotal,
      active_alerts:      activeAlerts,
      uptime,
    });
  } catch (error) {
    console.error('Error building server status:', error);
    return reply.status(500).send({ error: 'Failed to build server status' });
  }
}

// ── Uptime Monitor routes ─────────────────────────────────────────────────────

const MONITOR_UPTIME_SQL = `
  SELECT
    m.*,
    lc.status_code      AS last_status_code,
    lc.response_time_ms AS last_response_time_ms,
    lc.is_up            AS last_is_up,
    lc.error            AS last_error,
    lc.cert_expires_at  AS last_cert_expires_at,
    lc.checked_at       AS last_checked_at,
    u24.uptime_pct      AS uptime_24h,
    u7d.uptime_pct      AS uptime_7d,
    u30d.uptime_pct     AS uptime_30d
  FROM monitors m
  LEFT JOIN LATERAL (
    SELECT status_code, response_time_ms, is_up, error, cert_expires_at, checked_at
    FROM monitor_checks WHERE monitor_id = m.id ORDER BY checked_at DESC LIMIT 1
  ) lc ON true
  LEFT JOIN LATERAL (
    SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_up) / NULLIF(COUNT(*), 0), 1) AS uptime_pct
    FROM monitor_checks WHERE monitor_id = m.id AND checked_at > NOW() - INTERVAL '24 hours'
  ) u24 ON true
  LEFT JOIN LATERAL (
    SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_up) / NULLIF(COUNT(*), 0), 1) AS uptime_pct
    FROM monitor_checks WHERE monitor_id = m.id AND checked_at > NOW() - INTERVAL '7 days'
  ) u7d ON true
  LEFT JOIN LATERAL (
    SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_up) / NULLIF(COUNT(*), 0), 1) AS uptime_pct
    FROM monitor_checks WHERE monitor_id = m.id AND checked_at > NOW() - INTERVAL '30 days'
  ) u30d ON true
`;

export async function listMonitors(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const result = await query(`${MONITOR_UPTIME_SQL} ORDER BY m.name`);
    return reply.send(result.rows);
  } catch (error) {
    console.error('Error listing monitors:', error);
    return reply.status(500).send({ error: 'Failed to list monitors' });
  }
}

export async function createMonitor(
  request: FastifyRequest<{ Body: Partial<MonitorConfig> }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const { name, url, method, interval_seconds, timeout_seconds, expected_status, headers } = request.body;
    if (!name || !url) return reply.status(400).send({ error: 'name and url are required' });

    const { rows } = await query(
      `INSERT INTO monitors (name, url, method, interval_seconds, timeout_seconds, expected_status, headers)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, url, method ?? 'GET', interval_seconds ?? 60, timeout_seconds ?? 10, expected_status ?? 200, JSON.stringify(headers ?? {})]
    );
    const monitor = rows[0];
    await uptimeMonitor?.reloadMonitor(monitor.id);
    return reply.status(201).send(monitor);
  } catch (error) {
    console.error('Error creating monitor:', error);
    return reply.status(500).send({ error: 'Failed to create monitor' });
  }
}

export async function updateMonitor(
  request: FastifyRequest<{ Params: { id: string }; Body: Partial<MonitorConfig & { enabled: boolean }> }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    const { name, url, method, interval_seconds, timeout_seconds, expected_status, headers, enabled } = request.body;

    const { rows } = await query(
      `UPDATE monitors
       SET name             = COALESCE($1, name),
           url              = COALESCE($2, url),
           method           = COALESCE($3, method),
           interval_seconds = COALESCE($4, interval_seconds),
           timeout_seconds  = COALESCE($5, timeout_seconds),
           expected_status  = COALESCE($6, expected_status),
           headers          = COALESCE($7, headers),
           enabled          = COALESCE($8, enabled)
       WHERE id = $9 RETURNING *`,
      [name, url, method, interval_seconds, timeout_seconds, expected_status,
       headers ? JSON.stringify(headers) : undefined, enabled, id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Monitor not found' });

    await uptimeMonitor?.reloadMonitor(id);
    return reply.send(rows[0]);
  } catch (error) {
    console.error('Error updating monitor:', error);
    return reply.status(500).send({ error: 'Failed to update monitor' });
  }
}

export async function deleteMonitor(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    uptimeMonitor?.removeMonitor(id);
    const { rows } = await query('DELETE FROM monitors WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) return reply.status(404).send({ error: 'Monitor not found' });
    return reply.send({ deleted: true });
  } catch (error) {
    console.error('Error deleting monitor:', error);
    return reply.status(500).send({ error: 'Failed to delete monitor' });
  }
}

export async function getMonitorChecks(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    const limit = Math.min(parseInt((request.query as any).limit || '100'), 500);
    const { rows } = await query(
      'SELECT * FROM monitor_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT $2',
      [id, limit]
    );
    return reply.send(rows);
  } catch (error) {
    console.error('Error fetching monitor checks:', error);
    return reply.status(500).send({ error: 'Failed to fetch checks' });
  }
}

export async function testMonitorNow(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    const { rows } = await query('SELECT * FROM monitors WHERE id = $1', [id]);
    if (rows.length === 0) return reply.status(404).send({ error: 'Monitor not found' });

    const monitor = rows[0] as MonitorConfig;
    if (!uptimeMonitor) {
      return reply.status(503).send({ error: 'Uptime monitor not running' });
    }
    const result = await uptimeMonitor.runTestCheck(monitor);
    return reply.send(result);
  } catch (error) {
    console.error('Error running test check:', error);
    return reply.status(500).send({ error: 'Failed to run test check' });
  }
}

// ── Wazuh endpoints ───────────────────────────────────────────────────────────

export async function listWazuhAgents(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const { rows } = await query(
      `SELECT * FROM wazuh_agents
       ORDER BY
         CASE status
           WHEN 'disconnected'    THEN 1
           WHEN 'never_connected' THEN 2
           WHEN 'pending'         THEN 3
           WHEN 'active'          THEN 4
           ELSE 5
         END,
         name ASC`
    );
    return reply.send(rows);
  } catch (error) {
    console.error('Error listing Wazuh agents:', error);
    return reply.status(500).send({ error: 'Failed to list Wazuh agents' });
  }
}

export async function getWazuhAgent(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const { rows } = await query(
      'SELECT * FROM wazuh_agents WHERE id = $1',
      [parseInt(request.params.id)]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Agent not found' });

    // Attach related alerts (last 10 referencing this agent's name)
    const agent = rows[0];
    const { rows: alerts } = await query(
      `SELECT id, severity, message, acknowledged, created_at
       FROM alerts
       WHERE metric_type = 'wazuh' AND message ILIKE $1
       ORDER BY created_at DESC LIMIT 10`,
      [`%${agent.name}%`]
    );
    return reply.send({ ...agent, recent_alerts: alerts });
  } catch (error) {
    console.error('Error fetching Wazuh agent:', error);
    return reply.status(500).send({ error: 'Failed to fetch Wazuh agent' });
  }
}

export async function getWazuhStatus(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int                                          AS total,
         COUNT(*) FILTER (WHERE status = 'active')::int        AS active,
         COUNT(*) FILTER (WHERE status = 'disconnected')::int  AS disconnected,
         COUNT(*) FILTER (WHERE status = 'never_connected')::int AS never_connected,
         COUNT(*) FILTER (WHERE status = 'pending')::int       AS pending
       FROM wazuh_agents`
    );
    const counts = rows[0] ?? { total: 0, active: 0, disconnected: 0, never_connected: 0, pending: 0 };

    const mon = wazuhMonitor;
    return reply.send({
      ...counts,
      enabled:        true,
      last_poll_at:   mon?.lastPollAt ?? null,
      last_poll_ok:   mon?.lastPollOk ?? false,
      last_poll_error: mon?.lastPollError ?? null,
      manager_url:    config.wazuh?.manager_url ?? null,
    });
  } catch (error) {
    console.error('Error fetching Wazuh status:', error);
    return reply.status(500).send({ error: 'Failed to fetch Wazuh status' });
  }
}

export async function testWazuhConnection(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  if (!wazuhMonitor) {
    return reply.status(503).send({ ok: false, error: 'Wazuh monitor not enabled' });
  }
  const result = await wazuhMonitor.testConnection();
  return reply.send(result);
}

export async function getWazuhUnmatched(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    // Wazuh agents not matched to any Fenris server
    const { rows } = await query(
      `SELECT wa.name, wa.status, wa.os_name, wa.os_version, wa.last_keep_alive, wa.group_name
       FROM wazuh_agents wa
       WHERE NOT EXISTS (
         SELECT 1 FROM servers s
         WHERE LOWER(s.wazuh_agent_name) = LOWER(wa.name)
       )
       ORDER BY wa.name`
    );
    return reply.send(rows);
  } catch (error) {
    console.error('Error fetching unmatched Wazuh agents:', error);
    return reply.status(500).send({ error: 'Failed to fetch unmatched agents' });
  }
}

// ── Server security endpoint ──────────────────────────────────────────────────

export async function getServerSecurity(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const serverId = parseInt(request.params.id);
    if (isNaN(serverId)) return reply.status(400).send({ error: 'Invalid server id' });

    const serverRes = await query(
      'SELECT wazuh_agent_name FROM servers WHERE id = $1',
      [serverId]
    );
    if (serverRes.rows.length === 0) return reply.status(404).send({ error: 'Server not found' });

    const { wazuh_agent_name } = serverRes.rows[0];

    // List of all Wazuh agent names (for the "set alias" dropdown)
    const allAgentsRes = await query('SELECT name FROM wazuh_agents ORDER BY name');
    const available_agents: string[] = allAgentsRes.rows.map((r: any) => r.name);

    if (!wazuh_agent_name) {
      return reply.send({ wazuh_agent: null, active_alerts: 0, available_agents });
    }

    const [agentRes, alertsRes] = await Promise.all([
      query(
        `SELECT name, status, os_name, os_version, agent_version, last_keep_alive, group_name
         FROM wazuh_agents WHERE LOWER(name) = LOWER($1)`,
        [wazuh_agent_name]
      ),
      query(
        `SELECT COUNT(*) AS total FROM alerts
         WHERE metric_type = 'wazuh' AND acknowledged = FALSE AND message ILIKE $1`,
        [`%${wazuh_agent_name}%`]
      ),
    ]);

    const agent = agentRes.rows[0] ?? null;
    const active_alerts = parseInt(alertsRes.rows[0]?.total ?? '0');

    return reply.send({
      wazuh_agent: agent
        ? {
            name:           agent.name,
            status:         agent.status,
            os:             agent.os_name
                              ? `${agent.os_name}${agent.os_version ? ' ' + agent.os_version : ''}`
                              : null,
            version:        agent.agent_version,
            last_keepalive: agent.last_keep_alive,
            group:          agent.group_name,
          }
        : null,
      active_alerts,
      available_agents,
    });
  } catch (error) {
    console.error('Error fetching server security:', error);
    return reply.status(500).send({ error: 'Failed to fetch server security' });
  }
}

export async function updateServer(
  request: FastifyRequest<{ Params: { id: string }; Body: { wazuh_agent_name?: string | null } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const user = (request as any).user;
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin role required' });
    }

    const serverId = parseInt(request.params.id);
    if (isNaN(serverId)) return reply.status(400).send({ error: 'Invalid server id' });

    const { wazuh_agent_name } = request.body ?? {};

    const { rows } = await query(
      `UPDATE servers SET wazuh_agent_name = $1 WHERE id = $2
       RETURNING id, name, ip_address, last_heartbeat, os_type, wazuh_agent_name`,
      [wazuh_agent_name ?? null, serverId]
    );

    if (rows.length === 0) return reply.status(404).send({ error: 'Server not found' });
    return reply.send(rows[0]);
  } catch (error) {
    console.error('Error updating server:', error);
    return reply.status(500).send({ error: 'Failed to update server' });
  }
}

// ── CrowdSec endpoints ────────────────────────────────────────────────────────

let crowdSecMonitor: import('../monitors/crowdsec.js').CrowdSecMonitor | null = null;

export function setCrowdSecMonitor(m: import('../monitors/crowdsec.js').CrowdSecMonitor): void {
  crowdSecMonitor = m;
}

export function getCrowdSecMonitor(): import('../monitors/crowdsec.js').CrowdSecMonitor | null {
  return crowdSecMonitor;
}

export async function listCrowdSecDecisions(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const serverIdParam = (request.query as any).server_id;
    const limit = Math.min(parseInt((request.query as any).limit || '50'), 200);

    let result;
    if (serverIdParam) {
      result = await query(
        `SELECT cd.*, s.name AS server_name
         FROM crowdsec_decisions cd
         JOIN servers s ON s.id = cd.server_id
         WHERE cd.server_id = $1
         ORDER BY cd.created_at DESC LIMIT $2`,
        [parseInt(serverIdParam), limit]
      );
    } else {
      result = await query(
        `SELECT cd.*, s.name AS server_name
         FROM crowdsec_decisions cd
         JOIN servers s ON s.id = cd.server_id
         ORDER BY cd.created_at DESC LIMIT $1`,
        [limit]
      );
    }
    return reply.send(result.rows);
  } catch (error) {
    console.error('Error listing CrowdSec decisions:', error);
    return reply.status(500).send({ error: 'Failed to list decisions' });
  }
}

export async function getCrowdSecStats(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const serverIdParam = (request.query as any).server_id;
    const params: any[] = serverIdParam ? [parseInt(serverIdParam)] : [];
    const where = serverIdParam ? 'WHERE server_id = $1' : '';
    const and   = serverIdParam ? 'AND server_id = $1' : '';

    const [totalRes, bans24hRes, scenariosRes, countriesRes] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM crowdsec_decisions ${where}`, params),
      query(`SELECT COUNT(*) AS total FROM crowdsec_decisions WHERE action = 'ban' AND created_at > NOW() - INTERVAL '24 hours' ${and}`, params),
      query(`SELECT scenario, COUNT(*) AS count FROM crowdsec_decisions ${where} GROUP BY scenario ORDER BY count DESC LIMIT 5`, params),
      query(`SELECT source_country, COUNT(*) AS count FROM crowdsec_decisions ${where} GROUP BY source_country ORDER BY count DESC LIMIT 5`, params),
    ]);

    return reply.send({
      total_decisions:  parseInt(totalRes.rows[0]?.total ?? '0'),
      bans_last_24h:    parseInt(bans24hRes.rows[0]?.total ?? '0'),
      top_scenarios:    scenariosRes.rows,
      top_countries:    countriesRes.rows.filter((r: any) => r.source_country),
    });
  } catch (error) {
    console.error('Error fetching CrowdSec stats:', error);
    return reply.status(500).send({ error: 'Failed to fetch CrowdSec stats' });
  }
}

export async function testCrowdSecConnection(
  request: FastifyRequest<{ Body: { name: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const user = (request as any).user;
    if (!user || !['admin', 'operator'].includes(user.role)) {
      return reply.status(403).send({ error: 'Operator or admin role required' });
    }
    const { name } = request.body ?? {};
    if (!name) return reply.status(400).send({ error: 'name is required' });

    if (!crowdSecMonitor) {
      return reply.status(503).send({ ok: false, error: 'CrowdSec monitor not running (disabled or not configured)' });
    }
    const result = await crowdSecMonitor.testConnection(name);
    return reply.send(result);
  } catch (error) {
    console.error('Error testing CrowdSec connection:', error);
    return reply.status(500).send({ error: 'Failed to test connection' });
  }
}

export async function getCrowdSecStatus(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    if (!crowdSecMonitor) {
      return reply.send({ enabled: false, instances: [] });
    }
    return reply.send(crowdSecMonitor.getStatus());
  } catch (error) {
    console.error('Error fetching CrowdSec status:', error);
    return reply.status(500).send({ error: 'Failed to fetch CrowdSec status' });
  }
}

// ── Incidents endpoints ───────────────────────────────────────────────────────

const INCIDENT_LIST_SQL = `
  SELECT
    i.*,
    s.name AS server_name,
    asm.summary AS ai_summary,
    (
      SELECT json_agg(sub ORDER BY sub.created_at DESC)
      FROM (
        SELECT a.id, a.severity, a.message, a.metric_type, a.acknowledged, a.created_at
        FROM alerts a WHERE a.incident_id = i.id ORDER BY a.created_at DESC LIMIT 3
      ) sub
    ) AS recent_alerts
  FROM incidents i
  LEFT JOIN servers s ON s.id = i.server_id
  LEFT JOIN alert_summaries asm ON asm.id = i.ai_summary_id
`;

/** Set to true after first request so EXPLAIN ANALYZE runs only once at warmup. */
let _incidentsExplained = false;

export async function listIncidents(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const { state, server_id, limit: limitParam } = request.query as Record<string, string>;
    const limit = Math.min(parseInt(limitParam ?? '100'), 500);

    const serverFilter = server_id ? parseInt(server_id) : null;

    // Run EXPLAIN ANALYZE once on startup to surface slow query plans in logs.
    if (!_incidentsExplained) {
      _incidentsExplained = true;
      try {
        const explain = await query(`EXPLAIN ANALYZE ${INCIDENT_LIST_SQL} WHERE i.state != 'resolved' ORDER BY i.started_at DESC LIMIT 50`, []);
        console.log('[incidents] EXPLAIN ANALYZE (active, limit 50):');
        explain.rows.forEach((r: Record<string, unknown>) => console.log(' ', r['QUERY PLAN']));
      } catch (e) { /* non-fatal */ }
    }

    let rows: unknown[];

    if (state || serverFilter !== null) {
      // Explicit filter: normal single-pass query
      const conditions: string[] = [];
      const params: unknown[]    = [];
      if (state)            { params.push(state);       conditions.push(`i.state = $${params.length}`); }
      if (serverFilter !== null) { params.push(serverFilter); conditions.push(`i.server_id = $${params.length}`); }
      params.push(limit);
      const sql = `${INCIDENT_LIST_SQL} WHERE ${conditions.join(' AND ')} ORDER BY i.started_at DESC LIMIT $${params.length}`;
      const result = await query(sql, params);
      rows = result.rows;
    } else {
      // No filter: return all active + last 20 resolved to keep payload small
      const RESOLVED_LIMIT = 20;
      const [activeRes, resolvedRes] = await Promise.all([
        query(`${INCIDENT_LIST_SQL} WHERE i.state != 'resolved' ORDER BY i.started_at DESC`, []),
        query(`${INCIDENT_LIST_SQL} WHERE i.state = 'resolved' ORDER BY i.started_at DESC LIMIT $1`, [RESOLVED_LIMIT]),
      ]);
      rows = [...activeRes.rows, ...resolvedRes.rows]
        .sort((a: any, b: any) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    }

    return reply.send(rows);
  } catch (err) {
    console.error('[incidents] list error:', err);
    return reply.status(500).send({ error: 'Failed to list incidents' });
  }
}

export async function getIncident(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    const incRes = await query(
      `${INCIDENT_LIST_SQL} WHERE i.id = $1`,
      [id]
    );
    if (incRes.rows.length === 0) return reply.status(404).send({ error: 'Incident not found' });

    const incident = incRes.rows[0];
    // Fetch all attached alerts
    const alertsRes = await query(
      `SELECT a.*, s.name AS server_name
       FROM alerts a LEFT JOIN servers s ON s.id = a.server_id
       WHERE a.incident_id = $1 ORDER BY a.created_at DESC`,
      [id]
    );
    incident.alerts = alertsRes.rows;
    return reply.send(incident);
  } catch (err) {
    console.error('[incidents] get error:', err);
    return reply.status(500).send({ error: 'Failed to get incident' });
  }
}

export async function claimIncident(
  request: FastifyRequest<{ Params: { id: string }; Body: { claimed_by?: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    // Prefer JWT username, fall back to body claim, fall back to 'you'
    const claimedBy = (request as any).user?.username ?? request.body?.claimed_by ?? 'you';
    const result = await query(
      `UPDATE incidents
       SET state = 'investigating', claimed_by = $1, claimed_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [claimedBy, id]
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Incident not found' });
    return reply.send(result.rows[0]);
  } catch (err) {
    console.error('[incidents] claim error:', err);
    return reply.status(500).send({ error: 'Failed to claim incident' });
  }
}

export async function resolveIncident(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    // Auto-acknowledge all attached alerts
    await query(
      'UPDATE alerts SET acknowledged = TRUE WHERE incident_id = $1 AND acknowledged = FALSE',
      [id]
    );
    const result = await query(
      `UPDATE incidents
       SET state = 'resolved', resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Incident not found' });
    return reply.send(result.rows[0]);
  } catch (err) {
    console.error('[incidents] resolve error:', err);
    return reply.status(500).send({ error: 'Failed to resolve incident' });
  }
}

export async function reopenIncident(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    const result = await query(
      `UPDATE incidents
       SET state = 'new', resolved_at = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Incident not found' });
    return reply.send(result.rows[0]);
  } catch (err) {
    console.error('[incidents] reopen error:', err);
    return reply.status(500).send({ error: 'Failed to reopen incident' });
  }
}

export async function updateIncident(
  request: FastifyRequest<{ Params: { id: string }; Body: { title?: string; notes?: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id    = parseInt(request.params.id);
    const { title, notes } = request.body ?? {};

    const sets: string[]    = ['updated_at = NOW()'];
    const params: unknown[] = [];
    if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
    if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`); }

    params.push(id);
    const result = await query(
      `UPDATE incidents SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Incident not found' });
    return reply.send(result.rows[0]);
  } catch (err) {
    console.error('[incidents] update error:', err);
    return reply.status(500).send({ error: 'Failed to update incident' });
  }
}

export async function mergeIncidents(
  request: FastifyRequest<{ Params: { id: string }; Body: { target_incident_id: number } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const sourceId = parseInt(request.params.id);
    const targetId = request.body?.target_incident_id;
    if (!targetId) return reply.status(400).send({ error: 'target_incident_id required' });
    if (sourceId === targetId) return reply.status(400).send({ error: 'Cannot merge incident with itself' });

    // Move alerts from source to target
    await query('UPDATE alerts SET incident_id = $1 WHERE incident_id = $2', [targetId, sourceId]);

    // Recalculate target severity + alert_count
    const statsRes = await query(
      `SELECT COUNT(*) AS cnt,
              MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END) AS sev_rank
       FROM alerts WHERE incident_id = $1`,
      [targetId]
    );
    const alertCount = parseInt(statsRes.rows[0]?.cnt ?? '0');
    const sevRank    = parseInt(statsRes.rows[0]?.sev_rank ?? '1');
    const severity   = sevRank === 3 ? 'critical' : sevRank === 2 ? 'warning' : 'info';

    await query(
      'UPDATE incidents SET alert_count = $1, severity = $2, updated_at = NOW() WHERE id = $3',
      [alertCount, severity, targetId]
    );

    // Delete source incident
    await query('DELETE FROM incidents WHERE id = $1', [sourceId]);

    const targetRes = await query('SELECT * FROM incidents WHERE id = $1', [targetId]);
    return reply.send(targetRes.rows[0]);
  } catch (err) {
    console.error('[incidents] merge error:', err);
    return reply.status(500).send({ error: 'Failed to merge incidents' });
  }
}

export async function splitIncident(
  request: FastifyRequest<{ Params: { id: string }; Body: { alert_ids: number[] } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const sourceId = parseInt(request.params.id);
    const alertIds = request.body?.alert_ids;
    if (!Array.isArray(alertIds) || alertIds.length === 0) {
      return reply.status(400).send({ error: 'alert_ids array required' });
    }

    // Verify these alerts belong to this incident
    const checkRes = await query(
      'SELECT id FROM alerts WHERE id = ANY($1) AND incident_id = $2',
      [alertIds, sourceId]
    );
    if (checkRes.rows.length === 0) {
      return reply.status(400).send({ error: 'None of the specified alerts belong to this incident' });
    }
    const validIds = checkRes.rows.map(r => r.id);

    // Get source incident info
    const srcRes = await query('SELECT * FROM incidents WHERE id = $1', [sourceId]);
    if (srcRes.rows.length === 0) return reply.status(404).send({ error: 'Incident not found' });
    const src = srcRes.rows[0];

    // Get severity for the split set
    const splitSevRes = await query(
      `SELECT MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END) AS sev_rank
       FROM alerts WHERE id = ANY($1)`,
      [validIds]
    );
    const sevRank    = parseInt(splitSevRes.rows[0]?.sev_rank ?? '1');
    const severity   = sevRank === 3 ? 'critical' : sevRank === 2 ? 'warning' : 'info';

    // Create new incident
    const newTitle = `Split from: ${src.title}`;
    const newRes = await query(
      `INSERT INTO incidents (title, server_id, severity, state, started_at, alert_count, created_at, updated_at)
       VALUES ($1, $2, $3, 'new', NOW(), $4, NOW(), NOW()) RETURNING *`,
      [newTitle, src.server_id, severity, validIds.length]
    );
    const newIncident = newRes.rows[0];

    // Move alerts
    await query('UPDATE alerts SET incident_id = $1 WHERE id = ANY($2)', [newIncident.id, validIds]);

    // Update source incident counts
    const remainRes = await query(
      `SELECT COUNT(*) AS cnt,
              COALESCE(MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END), 1) AS sev_rank
       FROM alerts WHERE incident_id = $1`,
      [sourceId]
    );
    const remCount   = parseInt(remainRes.rows[0]?.cnt ?? '0');
    const remSevRank = parseInt(remainRes.rows[0]?.sev_rank ?? '1');
    const remSev     = remSevRank === 3 ? 'critical' : remSevRank === 2 ? 'warning' : 'info';
    await query(
      'UPDATE incidents SET alert_count = $1, severity = $2, updated_at = NOW() WHERE id = $3',
      [remCount, remSev, sourceId]
    );

    return reply.status(201).send(newIncident);
  } catch (err) {
    console.error('[incidents] split error:', err);
    return reply.status(500).send({ error: 'Failed to split incident' });
  }
}

// ── Docker container history (time-range, structured) ─────────────────────────

export async function getContainerHistory(
  request: FastifyRequest<{ Params: { server_id: string; container_name: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const serverId     = parseInt(request.params.server_id);
    const containerName = decodeURIComponent(request.params.container_name);
    const hours = Math.min(parseInt((request.query as any).hours || '24'), 168);

    const result = await query(
      `SELECT
         m.timestamp,
         (elem->>'cpu_percent')::float    AS cpu_percent,
         (elem->>'memory_mb')::float      AS memory_mb,
         (elem->>'memory_percent')::float AS memory_percent,
         (elem->>'net_rx_bytes')::bigint  AS network_rx_bytes,
         (elem->>'net_tx_bytes')::bigint  AS network_tx_bytes
       FROM metrics m,
            LATERAL jsonb_array_elements(m.value->'docker') AS elem
       WHERE m.server_id    = $1
         AND m.metric_type  = 'docker'
         AND elem->>'name'  = $2
         AND m.timestamp   > NOW() - ($3 || ' hours')::INTERVAL
       ORDER BY m.timestamp ASC`,
      [serverId, containerName, hours]
    );

    return reply.send(result.rows);
  } catch (err) {
    console.error('[docker] container history error:', err);
    return reply.status(500).send({ error: 'Failed to fetch container history' });
  }
}

// ── Docker events list ────────────────────────────────────────────────────────

export async function listDockerEvents(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const serverId      = (request.query as any).server_id;
    const containerName = (request.query as any).container_name;
    const limit = Math.min(parseInt((request.query as any).limit || '50'), 200);

    const conditions: string[] = [];
    const params: any[] = [];

    if (serverId) {
      params.push(parseInt(serverId));
      conditions.push(`e.server_id = $${params.length}`);
    }
    if (containerName) {
      params.push(containerName);
      conditions.push(`e.container_name = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const result = await query(
      `SELECT e.*, s.name AS server_name
       FROM container_events e
       LEFT JOIN servers s ON s.id = e.server_id
       ${where}
       ORDER BY e.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    return reply.send(result.rows);
  } catch (err) {
    console.error('[docker] events list error:', err);
    return reply.status(500).send({ error: 'Failed to fetch container events' });
  }
}

// ── Docker top consumers ──────────────────────────────────────────────────────

export async function getDockerTop(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const metric = (request.query as any).metric || 'cpu';
    const limit  = Math.min(parseInt((request.query as any).limit || '10'), 50);

    if (!['cpu', 'memory', 'network'].includes(metric)) {
      return reply.status(400).send({ error: 'metric must be one of: cpu, memory, network' });
    }

    const orderExpr = metric === 'cpu'    ? '(elem->>\'cpu_percent\')::float'
                    : metric === 'memory' ? '(elem->>\'memory_mb\')::float'
                    : '(elem->>\'net_rx_bytes\')::bigint + (elem->>\'net_tx_bytes\')::bigint';

    const result = await query(
      `WITH latest_docker AS (
         SELECT DISTINCT ON (server_id)
           server_id, value->'docker' AS containers
         FROM metrics
         WHERE metric_type = 'docker'
         ORDER BY server_id, timestamp DESC
       )
       SELECT
         s.id   AS server_id,
         s.name AS server_name,
         elem->>'name'          AS container_name,
         elem->>'image'         AS image,
         elem->>'state'         AS state,
         (elem->>'cpu_percent')::float    AS cpu_percent,
         (elem->>'memory_mb')::float      AS memory_mb,
         (elem->>'memory_percent')::float AS memory_percent,
         (elem->>'net_rx_bytes')::bigint  AS net_rx_bytes,
         (elem->>'net_tx_bytes')::bigint  AS net_tx_bytes
       FROM latest_docker ld
       JOIN servers s ON s.id = ld.server_id,
       LATERAL jsonb_array_elements(ld.containers) AS elem
       WHERE (elem->>'state') = 'running'
       ORDER BY ${orderExpr} DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );

    return reply.send(result.rows);
  } catch (err) {
    console.error('[docker] top error:', err);
    return reply.status(500).send({ error: 'Failed to fetch top containers' });
  }
}

// ── Docker restart count (last 24h) per container ────────────────────────────

export async function getContainerRestartCount(
  request: FastifyRequest<{ Params: { server_id: string; container_name: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const serverId      = parseInt(request.params.server_id);
    const containerName = decodeURIComponent(request.params.container_name);

    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'restart' AND created_at > NOW() - INTERVAL '24 hours') AS restarts_24h,
         COUNT(*) FILTER (WHERE event_type = 'restart' AND created_at > NOW() - INTERVAL '7 days')  AS restarts_7d
       FROM container_events
       WHERE server_id = $1 AND container_name = $2`,
      [serverId, containerName]
    );

    const row = result.rows[0] ?? { restarts_24h: 0, restarts_7d: 0 };
    return reply.send({
      restarts_24h: parseInt(row.restarts_24h, 10),
      restarts_7d:  parseInt(row.restarts_7d,  10),
    });
  } catch (err) {
    console.error('[docker] restart count error:', err);
    return reply.status(500).send({ error: 'Failed to fetch restart count' });
  }
}
