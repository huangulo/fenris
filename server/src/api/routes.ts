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

    // Network rx_bytes is highly variable (orders-of-magnitude bursts are normal
    // traffic); z-score on raw byte counts produces constant false positives.
    // Skip anomaly detection for network — thresholds are not applicable either.
    if (metric.metric_type === 'network') {
      continue;
    }

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

    const { server_name, host_ip: payloadHostIP, metrics: rawMetrics } = request.body;
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

export async function listIncidents(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const { state, server_id, limit: limitParam } = request.query as Record<string, string>;
    const limit = Math.min(parseInt(limitParam ?? '100'), 500);

    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (state)     { params.push(state);            conditions.push(`i.state = $${params.length}`); }
    if (server_id) { params.push(parseInt(server_id)); conditions.push(`i.server_id = $${params.length}`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const sql = `${INCIDENT_LIST_SQL} ${where} ORDER BY i.started_at DESC LIMIT $${params.length}`;
    const result = await query(sql, params);
    return reply.send(result.rows);
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
    const id         = parseInt(request.params.id);
    const claimedBy  = request.body?.claimed_by ?? 'you';
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
