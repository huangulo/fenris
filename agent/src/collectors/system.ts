import * as si from 'systeminformation';
import { loadavg } from 'os';
import { Metric } from '../types.js';

export class SystemCollector {
  private lastNetworkStats: Map<string, { rx: number; tx: number; ts: number }> = new Map();

  async collectCPU() {
    const load = await si.currentLoad();
    const [avg1, avg5, avg15] = loadavg();
    return {
      usage_percent: Math.round(load.currentLoad),
      load_avg: [avg1, avg5, avg15] as [number, number, number]
    };
  }

  async collectMemory() {
    const mem = await si.mem();
    const actualUsed = mem.total - mem.available;
    const toGiB = (b: number) => parseFloat((b / 1024 / 1024 / 1024).toFixed(1));
    return {
      used_percent: Math.round((actualUsed / mem.total) * 100),
      total_gib: toGiB(mem.total),
      available_gib: toGiB(mem.available),
      used_gib: toGiB(actualUsed)
    };
  }

  async collectDisk(paths: string[]) {
    const fsSize = await si.fsSize();
    const toGB = (b: number) => parseFloat((b / 1e9).toFixed(1));

    const diskStats: Array<{ path: string; used_percent: number; total_gb: number; used_gb: number; available_gb: number }> = [];
    for (const path of paths) {
      const disk = fsSize.find(d => d.mount === path);
      if (disk) {
        diskStats.push({
          path,
          used_percent: parseFloat(disk.use.toFixed(1)),
          total_gb: toGB(disk.size),
          used_gb: toGB(disk.used),
          available_gb: toGB(disk.available)
        });
      }
    }

    if (diskStats.length === 0) {
      const SKIP = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'sysfs', 'proc']);
      const real = fsSize
        .filter(d => !SKIP.has(d.type) && d.size > 0)
        .sort((a, b) => b.size - a.size)[0];
      if (real) {
        diskStats.push({
          path: real.mount,
          used_percent: parseFloat(real.use.toFixed(1)),
          total_gb: toGB(real.size),
          used_gb: toGB(real.used),
          available_gb: toGB(real.available)
        });
      }
    }

    return diskStats;
  }

  async collectNetwork() {
    const networkStats = await si.networkStats();
    const now = Date.now();
    const networkInterfaces: Array<{ rx_bytes: number; tx_bytes: number; interface: string }> = [];

    for (const iface of networkStats) {
      if (iface.operstate === 'up' && iface.iface !== 'lo') {
        const last = this.lastNetworkStats.get(iface.iface);

        let rx_bytes = 0;
        let tx_bytes = 0;
        if (last) {
          const elapsedSec = (now - last.ts) / 1000;
          rx_bytes = Math.round((iface.rx_bytes - last.rx) / elapsedSec);
          tx_bytes = Math.round((iface.tx_bytes - last.tx) / elapsedSec);
        }

        networkInterfaces.push({ rx_bytes, tx_bytes, interface: iface.iface });
        this.lastNetworkStats.set(iface.iface, { rx: iface.rx_bytes, tx: iface.tx_bytes, ts: now });
      }
    }

    return networkInterfaces;
  }

  async collectAll(diskPaths: string[]): Promise<Metric[]> {
    const timestamp = new Date();
    const metrics: Metric[] = [];

    const cpu = await this.collectCPU();
    metrics.push({ metric_type: 'cpu', value: { cpu }, timestamp });

    const memory = await this.collectMemory();
    metrics.push({ metric_type: 'memory', value: { memory }, timestamp });

    const disks = await this.collectDisk(diskPaths);
    for (const disk of disks) {
      metrics.push({ metric_type: 'disk', value: { disk }, timestamp });
    }

    const network = await this.collectNetwork();
    for (const net of network) {
      metrics.push({ metric_type: 'network', value: { network: net }, timestamp });
    }

    return metrics;
  }
}
