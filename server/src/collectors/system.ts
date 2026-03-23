import * as si from 'systeminformation';
import { Metric } from '../types.js';

export interface SystemMetrics {
  cpu: {
    usage_percent: number;
    load_avg: [number, number, number];
  };
  memory: {
    used_percent: number;
    used_mb: number;
    total_mb: number;
  };
  disk: Array<{
    path: string;
    used_percent: number;
    used_gb: number;
    total_gb: number;
  }>;
  network: Array<{
    rx_bytes: number;
    tx_bytes: number;
    interface: string;
  }>;
}

export class SystemCollector {
  private lastNetworkStats: Map<string, { rx: number; tx: number }> = new Map();

  async collectCPU(): Promise<SystemMetrics['cpu']> {
    const load = await si.currentLoad();
    const cpuLoad = await si.currentLoad();
    
    return {
      usage_percent: Math.round(cpuLoad.currentLoad * 100),
      load_avg: [load.avgLoad, load.avgLoad1, load.avgLoad5]
    };
  }

  async collectMemory(): Promise<SystemMetrics['memory']> {
    const mem = await si.mem();
    
    return {
      used_percent: Math.round((mem.used / mem.total) * 100),
      used_mb: Math.round(mem.used / 1024 / 1024),
      total_mb: Math.round(mem.total / 1024 / 1024)
    };
  }

  async collectDisk(paths: string[]): Promise<SystemMetrics['disk']> {
    const fsSize = await si.fsSize();
    
    const diskStats: SystemMetrics['disk'] = [];
    for (const path of paths) {
      const disk = fsSize.find(d => d.fs === path);
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
    const networkInterfaces: SystemMetrics['network'] = [];
    
    for (const iface of networkStats) {
      if (iface.operstate === 'up' && !iface.internal) {
        const lastStats = this.lastNetworkStats.get(iface.iface);
        
        const currentStats = {
          rx_bytes: iface.rx_bytes,
          tx_bytes: iface.tx_bytes,
          interface: iface.iface
        };
        
        networkInterfaces.push(currentStats);
        this.lastNetworkStats.set(iface.iface, {
          rx: iface.rx_bytes,
          tx: iface.tx_bytes
        });
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
