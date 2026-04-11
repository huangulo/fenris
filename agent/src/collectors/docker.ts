import Docker from 'dockerode';
import { accessSync, constants } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import { Metric, ContainerStats } from '../types.js';

type VolumeInfo = { name: string; source: string; destination: string; size_bytes: number };

interface VolumeSizeEntry {
  sizes: VolumeInfo[];
  lastMs: number;
}

export class DockerCollector {
  private docker: Docker | null = null;
  private enabled = false;
  private collectVolumeSizes = false;
  private volumeSizeIntervalMs = 300_000; // 5 min default
  private volumeSizeCache = new Map<string, VolumeSizeEntry>(); // keyed by container name

  async init(collectVolumeSizes = false, volumeSizeIntervalMs = 300_000): Promise<void> {
    this.collectVolumeSizes = collectVolumeSizes;
    this.volumeSizeIntervalMs = volumeSizeIntervalMs;
    try {
      accessSync('/var/run/docker.sock', constants.R_OK);
      this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
      await this.docker.ping();
      this.enabled = true;
      console.log('[agent] Docker collector initialized — container monitoring active');
    } catch (err) {
      console.warn('[agent] Docker socket not available — container monitoring disabled:', (err as Error).message);
      this.enabled = false;
    }
  }

  async collectAll(): Promise<Metric | null> {
    if (!this.enabled || !this.docker) return null;

    try {
      const containers = await this.docker.listContainers({ all: true });
      const results = await Promise.allSettled(
        containers.map(info => this.getContainerStats(info))
      );

      const stats: ContainerStats[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          stats.push(result.value);
        } else {
          console.warn('[agent] Docker container stats error:', result.reason);
        }
      }

      return {
        metric_type: 'docker',
        value: { docker: stats },
        timestamp: new Date()
      };
    } catch (err) {
      console.error('[agent] Docker collectAll error:', err);
      return null;
    }
  }

  private async getContainerStats(info: Docker.ContainerInfo): Promise<ContainerStats> {
    const name = info.Names[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12);
    const image = info.Image;
    const state = this.normalizeState(info.State);

    if (state !== 'running') {
      return { name, image, state, cpu_percent: 0, memory_mb: 0, memory_percent: 0, net_rx_bytes: 0, net_tx_bytes: 0, uptime_seconds: 0 };
    }

    const container = this.docker!.getContainer(info.Id);

    // Fetch stats and inspect in parallel
    const [statsRaw, inspectInfo] = await Promise.all([
      container.stats({ stream: false }) as unknown as Promise<any>,
      container.inspect(),
    ]);

    // Fix 1: Use StartedAt from inspect, capped at host uptime to handle
    // cases where Docker preserves container start time across host reboots.
    const startedAtSec = new Date(inspectInfo.State.StartedAt).getTime() / 1000;
    const rawUptime = Math.max(0, Math.floor(Date.now() / 1000) - startedAtSec);
    const uptime_seconds = Math.min(rawUptime, os.uptime());

    const image_hash: string | undefined = inspectInfo.Image ?? undefined;
    const started_at: string | undefined = inspectInfo.State.StartedAt ?? undefined;

    // CPU
    const cpuDelta = (statsRaw.cpu_stats?.cpu_usage?.total_usage ?? 0)
                   - (statsRaw.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (statsRaw.cpu_stats?.system_cpu_usage ?? 0)
                      - (statsRaw.precpu_stats?.system_cpu_usage ?? 0);
    const numCpus = statsRaw.cpu_stats?.online_cpus
                 ?? statsRaw.cpu_stats?.cpu_usage?.percpu_usage?.length
                 ?? 1;
    const cpu_percent = systemDelta > 0
      ? parseFloat(((cpuDelta / systemDelta) * numCpus * 100).toFixed(2))
      : 0;

    // Memory
    const memUsage = statsRaw.memory_stats?.usage ?? 0;
    const memLimit = statsRaw.memory_stats?.limit ?? 1;
    const memCache = statsRaw.memory_stats?.stats?.cache
                  ?? statsRaw.memory_stats?.stats?.inactive_file
                  ?? 0;
    const actualMem = Math.max(0, memUsage - memCache);
    const memory_mb = parseFloat((actualMem / 1024 / 1024).toFixed(1));
    const memory_percent = parseFloat(((actualMem / memLimit) * 100).toFixed(1));

    // Network
    let net_rx_bytes = 0;
    let net_tx_bytes = 0;
    if (statsRaw.networks) {
      for (const iface of Object.values(statsRaw.networks) as any[]) {
        net_rx_bytes += iface.rx_bytes ?? 0;
        net_tx_bytes += iface.tx_bytes ?? 0;
      }
    } else if (statsRaw.network) {
      net_rx_bytes = statsRaw.network.rx_bytes ?? 0;
      net_tx_bytes = statsRaw.network.tx_bytes ?? 0;
    }

    // Volumes (optional, rate-limited)
    const volumes = this.collectVolumeSizes
      ? this.getVolumes(name, inspectInfo.Mounts ?? [])
      : undefined;

    return { name, image, image_hash, started_at, state, cpu_percent, memory_mb, memory_percent, net_rx_bytes, net_tx_bytes, uptime_seconds, volumes };
  }

  private getVolumes(containerName: string, mounts: any[]): VolumeInfo[] {
    const now = Date.now();
    const cached = this.volumeSizeCache.get(containerName);
    if (cached && now - cached.lastMs < this.volumeSizeIntervalMs) {
      return cached.sizes;
    }

    const sizes: VolumeInfo[] = mounts
      .filter((m: any) => m.Source && m.Destination)
      .map((m: any) => ({
        name:        m.Name ?? '',
        source:      m.Source as string,
        destination: m.Destination as string,
        size_bytes:  this.getDirSizeBytes(m.Source as string),
      }));

    this.volumeSizeCache.set(containerName, { sizes, lastMs: now });
    return sizes;
  }

  private getDirSizeBytes(path: string): number {
    // Skip system paths to avoid very slow du runs
    if (path === '/' || path === '/etc' || path === '/usr' || path === '/proc' || path === '/sys') return 0;
    try {
      const result = spawnSync('du', ['-sb', path], { timeout: 4000 });
      if (result.status !== 0) return 0;
      const match = result.stdout.toString().match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }

  private normalizeState(state: string): ContainerStats['state'] {
    switch (state.toLowerCase()) {
      case 'running':    return 'running';
      case 'restarting': return 'restarting';
      case 'paused':     return 'paused';
      case 'exited':     return 'exited';
      case 'dead':       return 'dead';
      default:           return 'stopped';
    }
  }
}
