import * as si from 'systeminformation';
import { loadavg } from 'os';
import { Metric } from '../types.js';

export interface SystemMetrics {
  cpu: {
    usage_percent: number;
    load_avg: [number, number, number];
  };
  memory: {
    used_percent: number;
    total_gib: number;
    available_gib: number;
    used_gib: number;
  };
  disk: Array<{
    path: string;
    used_percent: number;
    total_gb: number;
    used_gb: number;
    available_gb: number;
  }>;
  network: Array<{
    rx_bytes: number;
    tx_bytes: number;
    interface: string;
  }>;
}

export class SystemCollector {
  private lastNetworkStats: Map<string, { rx: number; tx: number; ts: number }> = new Map();

  async collectCPU(): Promise<SystemMetrics['cpu']> {
    const load = await si.currentLoad();
    const [avg1, avg5, avg15] = loadavg();

    return {
      usage_percent: Math.round(load.currentLoad),
      load_avg: [avg1, avg5, avg15]
    };
  }

  async collectMemory(): Promise<SystemMetrics['memory']> {
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

  async collectDisk(paths: string[]): Promise<SystemMetrics['disk']> {
    const fsSize = await si.fsSize();
    
    const diskStats: SystemMetrics['disk'] = [];
    for (const path of paths) {
      const disk = fsSize.find(d => d.mount === path);
      if (disk) {
        diskStats.push({
          path,
          used_percent: Math.round(disk.use),
          used_gb: Math.round(disk.used / 1024 / 1024 / 1024),
          total_gb: Math.round(disk.size / 1024 / 1024 / 1024)
        });
      }
    }
    
    return diskStats;
  }

  async collectNetwork(): Promise<SystemMetrics['network']> {
    const networkStats = await si.networkStats();
    const now = Date.now();
    const networkInterfaces: SystemMetrics['network'] = [];

    for (const iface of networkStats) {
      if (iface.operstate === 'up' && !iface.internal) {
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
    const serverId = 1; // Default to localhost for MVP
    
    // CPU
    const cpu = await this.collectCPU();
    metrics.push({
      id: 0,
      server_id: serverId,
      metric_type: 'cpu',
      value: { cpu },
      timestamp
    });
    
    // Memory
    const memory = await this.collectMemory();
    metrics.push({
      id: 0,
      server_id: serverId,
      metric_type: 'memory',
      value: { memory },
      timestamp
    });
    
    // Disk
    const disks = await this.collectDisk(diskPaths);
    for (const disk of disks) {
      metrics.push({
        id: 0,
        server_id: serverId,
        metric_type: 'disk',
        value: { disk },
        timestamp
      });
    }
    
    // Network
    const network = await this.collectNetwork();
    for (const net of network) {
      metrics.push({
        id: 0,
        server_id: serverId,
        metric_type: 'network',
        value: { network: net },
        timestamp
      });
    }
    
    return metrics;
  }
}
