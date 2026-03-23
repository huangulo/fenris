import { readFileSync, existsSync } from 'fs';
import { hostname } from 'os';
import { load } from 'js-yaml';

export interface AgentConfig {
  server_url: string;
  api_key: string;
  server_name: string;
  collect_interval: number; // ms
  docker_enabled: boolean;
  disk_paths: string[];
}

function parseInterval(raw: string | number | undefined, defaultSec: number): number {
  if (raw == null) return defaultSec * 1000;
  if (typeof raw === 'number') return raw * 1000;
  const m = String(raw).match(/^(\d+)(s|m|h)?$/);
  if (!m) throw new Error(`Invalid interval format: "${raw}". Use e.g. "30s", "5m", "2h".`);
  const n = parseInt(m[1], 10);
  if (m[2] === 'm') return n * 60_000;
  if (m[2] === 'h') return n * 3_600_000;
  return n * 1_000; // seconds (default unit)
}

export function loadConfig(): AgentConfig {
  const configPath = process.env.FENRIS_AGENT_CONFIG ?? '/app/fenris-agent.yaml';
  let raw: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    raw = (load(readFileSync(configPath, 'utf8')) as Record<string, unknown>) ?? {};
    console.log('[agent] config loaded from', configPath);
  } else {
    console.log('[agent] no config file found at', configPath, '— using env vars / defaults');
  }

  const apiKey = (raw.api_key as string | undefined) ?? process.env.FENRIS_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('api_key is required (set in fenris-agent.yaml or FENRIS_API_KEY env var)');
  }

  const diskPaths = (raw.disk_paths as string[] | undefined) ??
    (process.env.FENRIS_DISK_PATHS ? process.env.FENRIS_DISK_PATHS.split(',') : ['/']);

  return {
    server_url:       (raw.server_url as string | undefined)       ?? process.env.FENRIS_SERVER_URL       ?? 'http://localhost:3200',
    api_key:          apiKey,
    server_name:      (raw.server_name as string | undefined)      ?? process.env.FENRIS_SERVER_NAME      ?? hostname(),
    collect_interval: parseInterval(raw.collect_interval as string | number | undefined ?? process.env.FENRIS_COLLECT_INTERVAL, 30),
    docker_enabled:   raw.docker_enabled != null
                        ? Boolean(raw.docker_enabled)
                        : process.env.FENRIS_DOCKER_ENABLED !== 'false',
    disk_paths:       diskPaths,
  };
}
