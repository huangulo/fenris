package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "FenrisAgent"
const serviceDisplayName = "Fenris Monitoring Agent"
const serviceDescription = "Collects system metrics and forwards them to a Fenris server."

// windowsService implements svc.Handler.
type windowsService struct {
	cfg Config
}

func (ws *windowsService) Execute(args []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (svcSpecificEC bool, exitCode uint32) {
	status <- svc.Status{State: svc.StartPending}

	stop := make(chan struct{})
	go ws.runLoop(stop)

	status <- svc.Status{
		State:   svc.Running,
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
	}

loop:
	for c := range req {
		switch c.Cmd {
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			close(stop)
			break loop
		default:
			log.Printf("[svc] unexpected control request #%d", c)
		}
	}

	return false, 0
}

func (ws *windowsService) runLoop(stop <-chan struct{}) {
	collector := NewCollector()
	poster := NewPoster(ws.cfg.ServerURL, ws.cfg.APIKey, ws.cfg.VerifySSL)
	interval := time.Duration(ws.cfg.CollectIntervalSeconds) * time.Second

	hostIP := ws.cfg.HostIP
	if hostIP == "" {
		hostIP = DetectHostIP()
	}

	log.Printf("[svc] loop started (interval=%s, server=%s)", interval, ws.cfg.ServerURL)

	// Collect once immediately
	ws.collect(collector, poster, hostIP)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			log.Println("[svc] stopping")
			return
		case <-ticker.C:
			ws.collect(collector, poster, hostIP)
		}
	}
}

func (ws *windowsService) collect(collector *Collector, poster *Poster, hostIP string) {
	metrics := collector.CollectAll()
	if len(metrics) == 0 {
		return
	}
	payload := AgentPayload{
		ServerName:        ws.cfg.ServerName,
		HostIP:            hostIP,
		OsType:            "windows",
		HostUptimeSeconds: CollectHostUptime(),
		Metrics:           metrics,
	}
	poster.Send(payload)
}

// RunService runs as a Windows service (called when SCM starts the process).
func RunService(cfg Config) {
	elog, err := eventlog.Open(serviceName)
	if err == nil {
		defer elog.Close()
		elog.Info(1, "Fenris Agent starting")
	}

	ws := &windowsService{cfg: cfg}
	if err := svc.Run(serviceName, ws); err != nil {
		log.Printf("[svc] Run failed: %v", err)
		if elog != nil {
			elog.Error(1, fmt.Sprintf("Run failed: %v", err))
		}
		os.Exit(1)
	}
}

// InstallService creates the Windows service entry.
func InstallService(configPath string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("executable path: %w", err)
	}
	exePath, err = filepath.Abs(exePath)
	if err != nil {
		return fmt.Errorf("abs path: %w", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	// Check if already installed
	s, err := m.OpenService(serviceName)
	if err == nil {
		s.Close()
		return fmt.Errorf("service %q already exists", serviceName)
	}

	// Register event source
	_ = eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info)

	args := []string{"run"}
	if configPath != "" {
		args = append(args, "--config", configPath)
	}

	s, err = m.CreateService(
		serviceName,
		exePath,
		mgr.Config{
			StartType:        mgr.StartAutomatic,
			DisplayName:      serviceDisplayName,
			Description:      serviceDescription,
			ServiceStartName: "LocalSystem",
		},
		args...,
	)
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	fmt.Printf("Service %q installed.\n", serviceName)
	return nil
}

// UninstallService removes the Windows service entry.
func UninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service not found: %w", err)
	}
	defer s.Close()

	// Stop first if running
	status, err := s.Query()
	if err == nil && status.State == svc.Running {
		_, _ = s.Control(svc.Stop)
		time.Sleep(2 * time.Second)
	}

	if err := s.Delete(); err != nil {
		return fmt.Errorf("delete service: %w", err)
	}
	_ = eventlog.Remove(serviceName)

	fmt.Printf("Service %q removed.\n", serviceName)
	return nil
}

// StartService starts the Windows service via SCM.
func StartService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service not found: %w", err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	fmt.Printf("Service %q started.\n", serviceName)
	return nil
}

// StopService stops the Windows service via SCM.
func StopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service not found: %w", err)
	}
	defer s.Close()

	status, err := s.Control(svc.Stop)
	if err != nil {
		return fmt.Errorf("stop: %w", err)
	}
	fmt.Printf("Service %q stopping (state=%d).\n", serviceName, status.State)
	return nil
}

// QueryService prints the current service status.
func QueryService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		fmt.Printf("Service %q is not installed.\n", serviceName)
		return nil
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}

	states := map[svc.State]string{
		svc.Stopped:         "STOPPED",
		svc.StartPending:    "START_PENDING",
		svc.StopPending:     "STOP_PENDING",
		svc.Running:         "RUNNING",
		svc.ContinuePending: "CONTINUE_PENDING",
		svc.PausePending:    "PAUSE_PENDING",
		svc.Paused:          "PAUSED",
	}
	stateName := states[status.State]
	if stateName == "" {
		stateName = fmt.Sprintf("UNKNOWN(%d)", status.State)
	}
	fmt.Printf("Service %q: %s\n", serviceName, stateName)
	return nil
}

// isWindowsService returns true when the process was launched by the SCM.
func isWindowsService() bool {
	isSvc, _ := svc.IsWindowsService()
	return isSvc
}

// selfElevate re-launches the current process with runas (request UAC elevation).
func selfElevate(args []string) error {
	verb := "runas"
	exe, _ := os.Executable()
	cwd, _ := os.Getwd()

	argStr := ""
	for i, a := range args {
		if i > 0 {
			argStr += " "
		}
		argStr += `"` + a + `"`
	}

	cmd := exec.Command("powershell", "-Command",
		fmt.Sprintf(`Start-Process -FilePath '%s' -ArgumentList '%s' -Verb %s -Wait`, exe, argStr, verb))
	cmd.Dir = cwd
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
