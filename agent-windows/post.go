package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

const maxBuffer = 100

// Poster handles HTTP posting with an in-memory retry buffer.
type Poster struct {
	serverURL string
	apiKey    string
	client    *http.Client
	buffer    []AgentPayload
}

func NewPoster(serverURL, apiKey string, verifySSL bool) *Poster {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: !verifySSL}, //nolint:gosec
	}
	return &Poster{
		serverURL: serverURL,
		apiKey:    apiKey,
		client: &http.Client{
			Timeout:   10 * time.Second,
			Transport: transport,
		},
	}
}

// Send posts payload immediately. On failure, buffers it.
// First attempts to flush any backlogged payloads.
func (p *Poster) Send(payload AgentPayload) {
	// Flush backlog first
	if len(p.buffer) > 0 {
		p.flush()
	}

	if err := p.post(payload); err != nil {
		log.Printf("[poster] POST failed: %v — buffering snapshot (backlog: %d/%d)", err, len(p.buffer)+1, maxBuffer)
		p.addBuffer(payload)
	}
}

func (p *Poster) post(payload AgentPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	url := p.serverURL + "/api/v1/metrics"
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("server returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func (p *Poster) addBuffer(payload AgentPayload) {
	if len(p.buffer) >= maxBuffer {
		// Drop oldest
		p.buffer = p.buffer[1:]
	}
	p.buffer = append(p.buffer, payload)
}

func (p *Poster) flush() {
	log.Printf("[poster] flushing %d buffered snapshot(s)…", len(p.buffer))
	var remaining []AgentPayload
	for _, payload := range p.buffer {
		if err := p.post(payload); err != nil {
			log.Printf("[poster] flush failed: %v — %d snapshot(s) remain", err, len(p.buffer)-len(remaining))
			remaining = append(remaining, payload)
		}
	}
	p.buffer = remaining
	if len(p.buffer) == 0 {
		log.Println("[poster] buffer flushed")
	}
}
