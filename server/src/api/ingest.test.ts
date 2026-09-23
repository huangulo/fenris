import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const query = vi.fn();
vi.mock('../db/client.js', () => ({ query: (...args: unknown[]) => query(...args) }));

const { initServices, receiveMetrics } = await import('./routes.js');
import type { Config, ContainerStats } from '../types.js';

const container = (name: string): ContainerStats => ({
  name, image: 'nginx:latest', state: 'running',
  cpu_percent: 1, memory_mb: 10, memory_percent: 1,
  net_rx_bytes: 0, net_tx_bytes: 0, uptime_seconds: 100,
});

const config = {
  anomaly_detection: { enabled: true, algorithm: 'zscore', zscore_threshold: 3, window_size: 60, min_samples: 10 },
  alerts: { thresholds: {} },
} as unknown as Config;

function fakeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { reply.statusCode = code; return reply; },
    send(body: unknown) { reply.body = body; return reply; },
  };
  return reply;
}

async function post(metrics: unknown[]) {
  const request = {
    headers: { 'x-api-key': 'test-key' },
    body: { server_name: 'test-host', os_type: 'linux', metrics },
    socket: { remoteAddress: '192.168.1.50' },
  } as unknown as FastifyRequest<{ Body: any }>;
  const reply = fakeReply();
  await receiveMetrics(request, reply as unknown as FastifyReply);
  return reply;
}

const dockerPayload = [
  { metric_type: 'cpu', value: { cpu: { usage_percent: 5, load_avg: [0, 0, 0] } }, timestamp: new Date().toISOString() },
  { metric_type: 'docker', value: { docker: [container('web')] }, timestamp: new Date().toISOString() },
];

beforeEach(() => {
  initServices(config);
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('INSERT INTO servers')) return { rows: [{ id: 7, is_new: false }] };
    // Previous snapshot has a container ('gone') that has since disappeared
    if (sql.includes("metric_type = 'docker' ORDER BY")) {
      return { rows: [{ containers: [container('web'), container('gone')] }] };
    }
    return { rows: [], rowCount: 0 };
  });
});

describe('POST /api/v1/metrics ingestion', () => {
  it('returns 201 for a payload with docker metrics and records removed containers', async () => {
    const reply = await post(dockerPayload);

    expect(reply.statusCode).toBe(201);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/^INSERT INTO metrics/), expect.any(Array));
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/^INSERT INTO container_events/),
      [7, 'gone', 'removed', 'running', null, '{}'],
    );
  });

  it('still returns 201 when post-insert processing throws', async () => {
    const base = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE servers SET last_heartbeat')) throw new Error('boom');
      return base(sql, params);
    });

    const reply = await post(dockerPayload);

    expect(reply.statusCode).toBe(201);
  });

  it('returns 500 when the metrics INSERT itself fails', async () => {
    const base = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO metrics')) throw new Error('db down');
      return base(sql, params);
    });

    const reply = await post(dockerPayload);

    expect(reply.statusCode).toBe(500);
  });
});
