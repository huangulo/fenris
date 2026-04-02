import fetch from 'node-fetch';
import si from 'systeminformation';
import { loadConfig } from './config.js';
import { SystemCollector } from './collectors/system.js';
import { DockerCollector } from './collectors/docker.js';
import { Metric, AgentPayload } from './types.js';

const MAX_BUFFER = 100;

// Docker bridge IP range: 172.16.0.0/12 (172.16–31.x.x)
const DOCKER_IP_RE = /^172\.(1[6-9]|2\d|3[01])\./;

async function getHostIP(): Promise<string> {
  try {
    const nics = await si.networkInterfaces('*');
    const list = Array.isArray(nics) ? nics : [nics];
    const candidate = list.find(n =>
      !n.internal &&
      n.ip4 &&
      !/^(docker|br-|veth|virbr)/.test(n.iface) &&
      !DOCKER_IP_RE.test(n.ip4)
    );
    return candidate?.ip4 ?? '';
  } catch {
    return '';
  }
}

// Buffered payloads to flush when server is reachable again
const buffer: AgentPayload[] = [];
let backoffMs = 5_000; // starts at 5s, backs off up to 5 min on persistent failures

async function postPayload(serverUrl: string, apiKey: string, payload: AgentPayload): Promise<boolean> {
  try {
    console.log(`[agent] POSTing to ${serverUrl}`);
    const res = await fetch(`${serverUrl}/api/v1/metrics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify(payload),
      // 10s timeout via AbortController
      signal: AbortSignal.timeout(10_000)
    });

    if (!res.ok) {
      console.error(`[agent] server returned ${res.status}: ${await res.text()}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[agent] POST failed:', (err as Error).message);
    return false;
  }
}

async function flush(serverUrl: string, apiKey: string): Promise<void> {
  if (buffer.length === 0) return;
  console.log(`[agent] flushing ${buffer.length} buffered snapshot(s)…`);

  while (buffer.length > 0) {
    const payload = buffer[0];
    const ok = await postPayload(serverUrl, apiKey, payload);
    if (!ok) {
      console.error(`[agent] flush failed — ${buffer.length} snapshot(s) still buffered`);
      return;
    }
    buffer.shift();
  }

  console.log('[agent] buffer flushed');
}

async function collect(
  systemCollector: SystemCollector,
  dockerCollector: DockerCollector,
  serverName: string,
  diskPaths: string[],
  hostIP: string
): Promise<AgentPayload> {
  const metrics: Metric[] = await systemCollector.collectAll(diskPaths);

  const dockerMetric = await dockerCollector.collectAll();
  if (dockerMetric) metrics.push(dockerMetric);

  return { server_name: serverName, host_ip: hostIP, metrics };
}

async function run(): Promise<void> {
  const config = loadConfig();

  console.log(`[agent] starting — server: ${config.server_url}, name: ${config.server_name}, interval: ${config.collect_interval}ms`);

  const systemCollector = new SystemCollector();
  const dockerCollector = new DockerCollector();

  if (config.docker_enabled) {
    await dockerCollector.init();
  }

  const hostIP = await getHostIP();
  if (hostIP) {
    console.log(`[agent] detected host IP: ${hostIP}`);
  }

  const tick = async () => {
    console.log('[agent] collecting metrics…');
    try {
      const payload = await collect(systemCollector, dockerCollector, config.server_name, config.disk_paths, hostIP);
      console.log(`[agent] collected ${payload.metrics.length} metrics, sending…`);

      // Try to flush any backlog first
      if (buffer.length > 0) {
        await flush(config.server_url, config.api_key);
      }

      const ok = await postPayload(config.server_url, config.api_key, payload);

      if (ok) {
        backoffMs = 5_000; // reset backoff on success
      } else {
        if (buffer.length < MAX_BUFFER) {
          buffer.push(payload);
          console.warn(`[agent] server unreachable — buffered snapshot (backlog: ${buffer.length}/${MAX_BUFFER})`);
        } else {
          console.error(`[agent] buffer full (${MAX_BUFFER}) — dropping oldest snapshot`);
          buffer.shift();
          buffer.push(payload);
        }
        backoffMs = Math.min(backoffMs * 2, 5 * 60 * 1000);
      }
    } catch (err) {
      console.error('[agent] collection error:', err);
    }
  };

  // Run immediately, then on interval
  await tick();
  setInterval(tick, config.collect_interval);
}

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal as NodeJS.Signals, () => {
    console.log(`[agent] received ${signal}, exiting`);
    process.exit(0);
  });
}

run().catch(err => {
  console.error('[agent] fatal startup error:', err);
  process.exit(1);
});
