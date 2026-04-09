package main

import (
	"log"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config holds all agent configuration.
type Config struct {
	ServerURL               string `yaml:"server_url"`
	APIKey                  string `yaml:"api_key"`
	ServerName              string `yaml:"server_name"`
	CollectIntervalSeconds  int    `yaml:"collect_interval_seconds"`
	HostIP                  string `yaml:"host_ip"`
	VerifySSL               bool   `yaml:"verify_ssl"`
}

func defaultConfig() Config {
	hostname, _ := os.Hostname()
	return Config{
		ServerURL:              "http://localhost:3200",
		APIKey:                 "",
		ServerName:             hostname,
		CollectIntervalSeconds: 30,
		HostIP:                 "",
		VerifySSL:              true,
	}
}

// LoadConfig reads fenris-agent.yaml then applies env var overrides.
// Looks in: path argument → same dir as executable → C:\ProgramData\Fenris\
func LoadConfig(path string) Config {
	cfg := defaultConfig()

	// Candidate config paths
	candidates := []string{path}
	if exe, err := os.Executable(); err == nil {
		dir := exe[:strings.LastIndex(exe, `\`)]
		if dir == "" {
			dir = "."
		}
		candidates = append(candidates, dir+`\fenris-agent.yaml`)
	}
	candidates = append(candidates,
		`C:\ProgramData\Fenris\fenris-agent.yaml`,
		`fenris-agent.yaml`,
	)

	for _, p := range candidates {
		if p == "" {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if err := yaml.Unmarshal(data, &cfg); err != nil {
			log.Printf("[config] warning: could not parse %s: %v", p, err)
			continue
		}
		log.Printf("[config] loaded from %s", p)
		break
	}

	// Environment variable overrides
	if v := os.Getenv("FENRIS_SERVER_URL"); v != "" {
		cfg.ServerURL = v
	}
	if v := os.Getenv("FENRIS_API_KEY"); v != "" {
		cfg.APIKey = v
	}
	if v := os.Getenv("FENRIS_SERVER_NAME"); v != "" {
		cfg.ServerName = v
	}
	if v := os.Getenv("FENRIS_HOST_IP"); v != "" {
		cfg.HostIP = v
	}
	if v := os.Getenv("FENRIS_COLLECT_INTERVAL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.CollectIntervalSeconds = n
		}
	}
	if v := os.Getenv("FENRIS_VERIFY_SSL"); v == "false" || v == "0" {
		cfg.VerifySSL = false
	}

	// Apply hostname default for server_name
	if cfg.ServerName == "" {
		hostname, _ := os.Hostname()
		cfg.ServerName = hostname
	}

	return cfg
}
