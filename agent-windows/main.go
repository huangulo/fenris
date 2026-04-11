package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"time"
)

const version = "1.0.0"

func usage() {
	fmt.Fprintf(os.Stderr, `Fenris Windows Agent v%s

Usage:
  fenris-agent <command> [options]

Commands:
  install     Install as a Windows service (requires admin)
  uninstall   Remove the Windows service (requires admin)
  start       Start the installed service (requires admin)
  stop        Stop the running service (requires admin)
  status      Print current service state
  run         Run as a Windows service (called by SCM)
  foreground  Run in the foreground (console mode)
  version     Print version and exit

Options:
  --config <path>   Path to fenris-agent.yaml (optional)

`, version)
}

func main() {
	// Detect SCM launch before parsing flags
	if isWindowsService() {
		cfg := LoadConfig("")
		setupLogging(cfg)
		RunService(cfg)
		return
	}

	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	cmd := os.Args[1]

	// Sub-command flag sets
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	configPath := fs.String("config", "", "Path to fenris-agent.yaml")
	_ = fs.Parse(os.Args[2:])

	cfg := LoadConfig(*configPath)
	setupLogging(cfg)

	switch cmd {
	case "install":
		if err := InstallService(*configPath); err != nil {
			log.Fatalf("[main] install failed: %v", err)
		}

	case "uninstall":
		if err := UninstallService(); err != nil {
			log.Fatalf("[main] uninstall failed: %v", err)
		}

	case "start":
		if err := StartService(); err != nil {
			log.Fatalf("[main] start failed: %v", err)
		}

	case "stop":
		if err := StopService(); err != nil {
			log.Fatalf("[main] stop failed: %v", err)
		}

	case "status":
		if err := QueryService(); err != nil {
			log.Fatalf("[main] status failed: %v", err)
		}

	case "run":
		// Invoked by SCM — run service handler
		RunService(cfg)

	case "foreground", "fg":
		runForeground(cfg)

	case "version":
		fmt.Printf("fenris-agent v%s\n", version)

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", cmd)
		usage()
		os.Exit(1)
	}
}

// runForeground runs the collection loop in the current process (no SCM).
func runForeground(cfg Config) {
	log.Printf("[main] foreground mode — server=%s name=%s interval=%ds",
		cfg.ServerURL, cfg.ServerName, cfg.CollectIntervalSeconds)

	collector := NewCollector()
	poster := NewPoster(cfg.ServerURL, cfg.APIKey, cfg.VerifySSL)
	interval := time.Duration(cfg.CollectIntervalSeconds) * time.Second

	hostIP := cfg.HostIP
	if hostIP == "" {
		hostIP = DetectHostIP()
		if hostIP != "" {
			log.Printf("[main] detected host IP: %s", hostIP)
		}
	}

	for {
		metrics := collector.CollectAll()
		if len(metrics) > 0 {
			payload := AgentPayload{
				ServerName:        cfg.ServerName,
				HostIP:            hostIP,
				OsType:            "windows",
				HostUptimeSeconds: CollectHostUptime(),
				Metrics:           metrics,
			}
			poster.Send(payload)
		}
		time.Sleep(interval)
	}
}

// setupLogging configures log output (stdout for foreground, file for service).
func setupLogging(_ Config) {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	// Could be extended to write to a file or Windows Event Log
}
