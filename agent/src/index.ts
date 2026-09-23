import { Agent, fetch } from 'undici';
import si from 'systeminformation';
import os from 'os';
import { loadConfig } from './config.js';
import { SystemCollector } from './collectors/system.js';
import { DockerCollector } from './collectors/docker.js';
import { Metric, AgentPayload } from './types.js';

const MAX_BUFFER = 100;

// Docker/container bridge IP ranges to exclude
const DOCKER_IP_RE = /^172\.(1[6-9]|2\d|3[01])\.|^10\.0\./;
// Docker interface name patterns to exclude
const DOCKER_IFACE_RE = /^(docker|br-|veth|virbr|cni|flannel|calico)/;

async function getHostIP(): Promise<string> {
  if (process.env.HOST_IP?.trim()) return process.env.HOST_IP.trim();

  try {
    const nics = await si.networkInterfaces('*');
    const list = Array.isArray(nics) ? nics : [nics];

    const candidates = list.filter(n =>
      !n.internal &&
      n.ip4 &&
      !DOCKER_IFACE_RE.test(n.iface) &&
      !DOCKER_IP_RE.test(n.ip4)
    );

    // Prefer the interface marked as default gateway
    const preferred = candidates.find(n => (n as any).default) ?? candidates[0];
    if (preferred?.ip4) return preferred.ip4;

    // 2. Fallback: try to derive from the default gateway address
    const gw = await si.networkGatewayDefault();
    if (gw && typeof gw === 'string' && gw.trim() && gw.trim() !== '0.0.0.0') {
      // Return the host IP on the same subnet as the gateway (best-effort)
      const gwPrefix = gw.split('.').slice(0, 3).join('.');
      const sameSubnet = list.find(n => n.ip4?.startsWith(gwPrefix) && !n.internal);
      if (sameSubnet?.ip4) return sameSubnet.ip4;
    }
  } catch { /* fall through */ }

  return '';
}

// Buffered payloads to flush when server is reachable again
const buffer: AgentPayload[] = [];
let backoffMs = 5_000; // starts at 5s, backs off up to 5 min on persistent failures

// Explicit dispatcher with short keep-alive so idle sockets don't outlive a sleep/network change.
// Recreated after MAX_CONSECUTIVE_FAILURES transport errors in a row to drop any stale socket.
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;
let requestTimeoutMs = 10_000;
let dispatcher: Agent;
let consecutiveFailures = 0;

function createDispatcher(): Agent {
  return new Agent({
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT_MS,
    connectTimeout: requestTimeoutMs,
    headersTimeout: requestTimeoutMs,
    bodyTimeout: requestTimeoutMs,
  });
}

function recordTransportFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return;

  console.warn(`[agent] ${consecutiveFailures} consecutive push failures — recreating HTTP dispatcher`);
  const old = dispatcher;
  dispatcher = createDispatcher();
  consecutiveFailures = 0;
  old.destroy().catch(() => { /* already broken, nothing to do */ });
}

// Prefer the underlying socket error (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT…) over "fetch failed".
// DOMExceptions (TimeoutError/AbortError) carry a legacy numeric .code, so only string codes count.
function errorCode(err: unknown): string {
  const e = err as { name?: string; code?: unknown; message?: string; cause?: { code?: unknown; name?: string } };
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return str(e?.cause?.code) ?? str(e?.code) ?? str(e?.cause?.name) ?? str(e?.name) ?? String(e?.message ?? err);
}

/**
 * Returns true once the server has answered, whatever the status: the snapshot is done with.
 * Only network errors/timeouts (no HTTP response) return false so the caller keeps it for retry.
 * A 4xx/5xx is not retried — the server may have stored it anyway (duplicates) or will
 * reject it forever (blocking the backlog).
 */
async function postPayload(serverUrl: string, apiKey: string, payload: AgentPayload): Promise<boolean> {
  const n = payload.metrics.length;
  const start = Date.now();
  try {
    const res = await fetch(`${serverUrl}/api/v1/metrics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(requestTimeoutMs),
      dispatcher,
    });
    // Always consume the body so the socket is released back to the pool
    const body = await res.text();
    const ms = Date.now() - start;
    consecutiveFailures = 0; // got an HTTP response, so the connection itself is healthy

    if (!res.ok) {
      console.error(`[agent] push rejected: ${n} metrics → HTTP ${res.status} (${ms}ms), snapshot dropped: ${body.slice(0, 200)}`);
      return true;
    }

    console.log(`[agent] pushed ${n} metrics → HTTP ${res.status} (${ms}ms)`);
    return true;
  } catch (err) {
    console.error(`[agent] push failed: ${n} metrics → ${errorCode(err)} (${Date.now() - start}ms)`);
    recordTransportFailure();
    return false;
  }
}

/** Returns true when the backlog is empty afterwards; stops at the first network failure. */
async function flush(serverUrl: string, apiKey: string): Promise<boolean> {
  if (buffer.length === 0) return true;
  console.log(`[agent] flushing ${buffer.length} buffered snapshot(s)…`);

  while (buffer.length > 0) {
    const payload = buffer[0];
    const answered = await postPayload(serverUrl, apiKey, payload);
    if (!answered) {
      console.error(`[agent] flush failed — ${buffer.length} snapshot(s) still buffered`);
      return false;
    }
    buffer.shift();
  }

  console.log('[agent] buffer flushed');
  return true;
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

  return { server_name: serverName, host_ip: hostIP, os_type: 'linux', host_uptime_seconds: os.uptime(), metrics };
}

async function run(): Promise<void> {
  const config = loadConfig();
  requestTimeoutMs = config.request_timeout;
  dispatcher = createDispatcher();

  console.log(`[agent] starting — server: ${config.server_url}, name: ${config.server_name}, interval: ${config.collect_interval}ms, request timeout: ${requestTimeoutMs}ms`);

  const systemCollector = new SystemCollector();
  const dockerCollector = new DockerCollector();

  if (config.docker_enabled) {
    await dockerCollector.init(config.collect_volume_sizes, config.volume_size_interval);
  }

  const hostIP = await getHostIP();
  if (hostIP) {
    console.log(`[agent] detected host IP: ${hostIP}`);
  }

  let inFlight = false;
  const tick = async () => {
    if (inFlight) {
      console.warn('[agent] previous push still in flight — skipping this cycle');
      return;
    }
    inFlight = true;
    console.log('[agent] collecting metrics…');
    try {
      const payload = await collect(systemCollector, dockerCollector, config.server_name, config.disk_paths, hostIP);
      console.log(`[agent] collected ${payload.metrics.length} metrics, sending…`);

      // Try to flush any backlog first; if the server is still unreachable,
      // buffer this snapshot too rather than spend a second timeout on it
      const flushed = await flush(config.server_url, config.api_key);

      const answered = flushed && await postPayload(config.server_url, config.api_key, payload);

      if (answered) {
        backoffMs = 5_000; // reset backoff once the server answers
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
    } finally {
      inFlight = false;
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
