import Docker from 'dockerode';
import { accessSync, constants } from 'fs';
import { Metric, ContainerStats } from '../types.js';

export class DockerCollector {
  private docker: Docker | null = null;
  private enabled = false;

  async init(): Promise<void> {
    try {
      accessSync('/var/run/docker.sock', constants.R_OK);
      this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
      await this.docker.ping();
      this.enabled = true;
      console.log('Docker collector initialized — container monitoring active');
    } catch (err) {
      console.warn('Docker socket not available — container monitoring disabled:', (err as Error).message);
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
          console.warn('Docker container stats error:', result.reason);
        }
      }

      return {
        id: 0,
        server_id: 1,
        metric_type: 'docker',
        value: { docker: stats },
        timestamp: new Date()
      };
    } catch (err) {
      console.error('Docker collectAll error:', err);
      return null;
    }
  }

  private async getContainerStats(info: Docker.ContainerInfo): Promise<ContainerStats> {
    const name = info.Names[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12);
    const image = info.Image;
    const state = this.normalizeState(info.State);

    // Uptime from container creation (good proxy for long-running services)
    const uptime_seconds = state === 'running'
      ? Math.max(0, Math.floor(Date.now() / 1000) - info.Created)
      : 0;

    // Skip expensive stats call for non-running containers
    if (state !== 'running') {
      return { name, image, state, cpu_percent: 0, memory_mb: 0, memory_percent: 0, net_rx_bytes: 0, net_tx_bytes: 0, uptime_seconds };
    }

    const container = this.docker!.getContainer(info.Id);
    const statsRaw = await (container.stats({ stream: false }) as unknown as Promise<any>);

    // CPU % — two-sample delta already provided by Docker in a single call
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

    // Memory — subtract page cache (cgroup v1: stats.cache; cgroup v2: stats.inactive_file)
    const memUsage = statsRaw.memory_stats?.usage ?? 0;
    const memLimit = statsRaw.memory_stats?.limit ?? 1;
    const memCache = statsRaw.memory_stats?.stats?.cache
                  ?? statsRaw.memory_stats?.stats?.inactive_file
                  ?? 0;
    const actualMem = Math.max(0, memUsage - memCache);
    const memory_mb = parseFloat((actualMem / 1024 / 1024).toFixed(1));
    const memory_percent = parseFloat(((actualMem / memLimit) * 100).toFixed(1));

    // Network — sum all interfaces
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

    return { name, image, state, cpu_percent, memory_mb, memory_percent, net_rx_bytes, net_tx_bytes, uptime_seconds };
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
