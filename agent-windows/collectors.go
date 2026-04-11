package main

import (
	"fmt"
	"log"
	"net"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	psnet "github.com/shirou/gopsutil/v3/net"
)

// ── Metric types (match Linux agent JSON exactly) ────────────────────────────

type MetricValue struct {
	CPU     *CPUValue     `json:"cpu,omitempty"`
	Memory  *MemoryValue  `json:"memory,omitempty"`
	Disk    *DiskValue    `json:"disk,omitempty"`
	Network *NetworkValue `json:"network,omitempty"`
}

type CPUValue struct {
	UsagePercent float64  `json:"usage_percent"`
	CoreCount    int      `json:"core_count"`
	LoadAvg      []any    `json:"load_avg"` // always [null, null, null] on Windows
}

type MemoryValue struct {
	UsedPercent  float64 `json:"used_percent"`
	TotalGiB     float64 `json:"total_gib"`
	AvailableGiB float64 `json:"available_gib"`
	UsedGiB      float64 `json:"used_gib"`
}

type DiskValue struct {
	Path        string  `json:"path"`
	UsedPercent float64 `json:"used_percent"`
	TotalGB     float64 `json:"total_gb"`
	UsedGB      float64 `json:"used_gb"`
	AvailableGB float64 `json:"available_gb"`
}

type NetworkValue struct {
	RxBytes   int64  `json:"rx_bytes"`
	TxBytes   int64  `json:"tx_bytes"`
	Interface string `json:"interface"`
}

type Metric struct {
	MetricType string      `json:"metric_type"`
	Value      MetricValue `json:"value"`
	Timestamp  string      `json:"timestamp"`
}

type AgentPayload struct {
	ServerName        string   `json:"server_name"`
	HostIP            string   `json:"host_ip,omitempty"`
	OsType            string   `json:"os_type"`
	HostUptimeSeconds uint64   `json:"host_uptime_seconds,omitempty"`
	Metrics           []Metric `json:"metrics"`
}

// ── Collector ─────────────────────────────────────────────────────────────────

type Collector struct {
	lastNet map[string]psnet.IOCountersStat
	lastNetTime time.Time
}

func NewCollector() *Collector {
	return &Collector{
		lastNet: make(map[string]psnet.IOCountersStat),
	}
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}

func toGiB(bytes uint64) float64 {
	return round1(float64(bytes) / 1024 / 1024 / 1024)
}

func toGB(bytes uint64) float64 {
	return round1(float64(bytes) / 1e9)
}

func (c *Collector) CollectCPU() (*Metric, error) {
	percents, err := cpu.Percent(500*time.Millisecond, false)
	if err != nil || len(percents) == 0 {
		return nil, fmt.Errorf("cpu.Percent: %w", err)
	}
	count, _ := cpu.Counts(true)
	ts := time.Now().UTC().Format(time.RFC3339)

	usage := round1(percents[0])
	return &Metric{
		MetricType: "cpu",
		Value: MetricValue{
			CPU: &CPUValue{
				UsagePercent: usage,
				CoreCount:    count,
				LoadAvg:      []any{nil, nil, nil}, // Windows has no load average
			},
		},
		Timestamp: ts,
	}, nil
}

func (c *Collector) CollectMemory() (*Metric, error) {
	v, err := mem.VirtualMemory()
	if err != nil {
		return nil, fmt.Errorf("mem.VirtualMemory: %w", err)
	}
	ts := time.Now().UTC().Format(time.RFC3339)
	used := v.Total - v.Available
	return &Metric{
		MetricType: "memory",
		Value: MetricValue{
			Memory: &MemoryValue{
				UsedPercent:  round1(float64(used) / float64(v.Total) * 100),
				TotalGiB:     toGiB(v.Total),
				AvailableGiB: toGiB(v.Available),
				UsedGiB:      toGiB(used),
			},
		},
		Timestamp: ts,
	}, nil
}

func (c *Collector) CollectDisks() ([]Metric, error) {
	parts, err := disk.Partitions(false)
	if err != nil {
		return nil, fmt.Errorf("disk.Partitions: %w", err)
	}
	ts := time.Now().UTC().Format(time.RFC3339)

	var metrics []Metric
	seen := map[string]bool{}
	for _, p := range parts {
		// Only fixed drives (type "NTFS", "FAT32", etc) — skip CD-ROM etc
		if p.Fstype == "" {
			continue
		}
		mp := p.Mountpoint
		if seen[mp] {
			continue
		}
		seen[mp] = true

		u, err := disk.Usage(mp)
		if err != nil || u.Total == 0 {
			continue
		}
		metrics = append(metrics, Metric{
			MetricType: "disk",
			Value: MetricValue{
				Disk: &DiskValue{
					Path:        mp,
					UsedPercent: round1(u.UsedPercent),
					TotalGB:     toGB(u.Total),
					UsedGB:      toGB(u.Used),
					AvailableGB: toGB(u.Free),
				},
			},
			Timestamp: ts,
		})
	}
	return metrics, nil
}

func (c *Collector) CollectNetwork() ([]Metric, error) {
	stats, err := psnet.IOCounters(true)
	if err != nil {
		return nil, fmt.Errorf("net.IOCounters: %w", err)
	}
	now := time.Now()
	ts := now.UTC().Format(time.RFC3339)

	elapsed := now.Sub(c.lastNetTime).Seconds()
	if elapsed < 1 {
		elapsed = 1
	}

	var metrics []Metric
	newMap := make(map[string]psnet.IOCountersStat)
	for _, s := range stats {
		newMap[s.Name] = s

		last, ok := c.lastNet[s.Name]
		var rxRate, txRate int64
		if ok && elapsed > 0 {
			rxRate = int64(float64(s.BytesRecv-last.BytesRecv) / elapsed)
			txRate = int64(float64(s.BytesSent-last.BytesSent) / elapsed)
		}
		if rxRate < 0 {
			rxRate = 0
		}
		if txRate < 0 {
			txRate = 0
		}

		// Skip loopback and zero-traffic virtual adapters
		if strings.EqualFold(s.Name, "Loopback Pseudo-Interface 1") {
			continue
		}
		if s.BytesRecv == 0 && s.BytesSent == 0 {
			continue
		}

		metrics = append(metrics, Metric{
			MetricType: "network",
			Value: MetricValue{
				Network: &NetworkValue{
					RxBytes:   rxRate,
					TxBytes:   txRate,
					Interface: s.Name,
				},
			},
			Timestamp: ts,
		})
	}
	c.lastNet = newMap
	c.lastNetTime = now
	return metrics, nil
}

func CollectHostUptime() uint64 {
	uptime, err := host.Uptime()
	if err != nil {
		return 0
	}
	return uptime
}

func (c *Collector) CollectAll() []Metric {
	var metrics []Metric

	if m, err := c.CollectCPU(); err == nil {
		metrics = append(metrics, *m)
	} else {
		log.Printf("[collector] CPU error: %v", err)
	}

	if m, err := c.CollectMemory(); err == nil {
		metrics = append(metrics, *m)
	} else {
		log.Printf("[collector] Memory error: %v", err)
	}

	if disks, err := c.CollectDisks(); err == nil {
		metrics = append(metrics, disks...)
	} else {
		log.Printf("[collector] Disk error: %v", err)
	}

	if nets, err := c.CollectNetwork(); err == nil {
		metrics = append(metrics, nets...)
	} else {
		log.Printf("[collector] Network error: %v", err)
	}

	return metrics
}

// ── Host IP detection ─────────────────────────────────────────────────────────

// Virtual adapter name fragments to skip
var virtualPrefixes = []string{
	"vethernet", "hyper-v", "virtualbox", "vmware", "vpn",
	"tunnel", "teredo", "isatap", "loopback",
}

func DetectHostIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}

	var candidates []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		nameLower := strings.ToLower(iface.Name)
		isVirtual := false
		for _, pfx := range virtualPrefixes {
			if strings.Contains(nameLower, pfx) {
				isVirtual = true
				break
			}
		}
		if isVirtual {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.To4() == nil {
				continue
			}
			ipStr := ip.String()
			// Skip APIPA (169.254.x.x)
			if strings.HasPrefix(ipStr, "169.254.") {
				continue
			}
			candidates = append(candidates, ipStr)
		}
	}

	if len(candidates) > 0 {
		return candidates[0]
	}
	return ""
}
