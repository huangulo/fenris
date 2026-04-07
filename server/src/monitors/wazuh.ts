import fetch from 'node-fetch';
import https from 'https';
import { query } from '../db/client.js';
import { Alert } from '../types.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';
import { parseDurationMs } from '../engine/predictor.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WazuhConfig {
  enabled: boolean;
  manager_url: string;
  username: string;
  password: string;
  poll_interval: string;
  verify_ssl: boolean;
}

interface WazuhApiAgent {
  id: string;
  name: string;
  ip?: string;
  status: string;
  os?: { name?: string; version?: string };
  version?: string;
  lastKeepAlive?: string;
  group?: string[];
}

// ── In-memory state ───────────────────────────────────────────────────────────

/** Last known status per Wazuh agent ID. */
const lastStatus = new Map<string, string>();

/** Per-agent alert cooldown: timestamp of last alert. */
const cooldown = new Map<string, number>();

const COOLDOWN_MS        = 15 * 60 * 1_000;   // 15 minutes per agent
const TOKEN_REFRESH_MS   = 10 * 60 * 1_000;   // refresh JWT every 10 min
const STALE_KEEPALIVE_MS =  5 * 60 * 1_000;   // warn if keepalive > 5 min old
const MAX_BACKOFF_MS     =  5 * 60 * 1_000;   // cap exponential backoff at 5 min

// ── WazuhMonitor ──────────────────────────────────────────────────────────────

export class WazuhMonitor {
  private cfg: WazuhConfig;
  private dispatcher: AlertDispatcher;

  /** JWT stored only in memory, never persisted. */
  private token: string | null = null;

  private pollTimer:  NodeJS.Timeout | null = null;
  private tokenTimer: NodeJS.Timeout | null = null;
  private httpsAgent: https.Agent;
  private backoffMs = 60_000;

  /** Observable state for the /status endpoint. */
  lastPollAt:   Date | null = null;
  lastPollOk    = false;
  lastPollError: string | null = null;

  constructor(cfg: WazuhConfig, dispatcher: AlertDispatcher) {
    this.cfg        = cfg;
    this.dispatcher = dispatcher;
    this.httpsAgent = new https.Agent({ rejectUnauthorized: cfg.verify_ssl });
  }

  async start(): Promise<void> {
    console.log('[wazuh] starting monitor —', this.cfg.manager_url);
    try {
      await this.authenticate();
      await this.poll();
    } catch (err) {
      console.error('[wazuh] initial poll failed:', err);
      this.lastPollOk    = false;
      this.lastPollError = (err as Error).message;
    }

    const intervalMs = parseDurationMs(this.cfg.poll_interval, 60_000);
    this.pollTimer  = setInterval(() => this.safePoll(), intervalMs);
    this.tokenTimer = setInterval(
      () => this.authenticate().catch(e => console.error('[wazuh] token refresh failed:', e)),
      TOKEN_REFRESH_MS
    );
    console.log(`[wazuh] polling every ${this.cfg.poll_interval}`);
  }

  stop(): void {
    if (this.pollTimer)  clearInterval(this.pollTimer);
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    this.pollTimer  = null;
    this.tokenTimer = null;
    console.log('[wazuh] stopped');
  }

  /** Called by POST /api/v1/wazuh/test-connection. */
  async testConnection(): Promise<{ ok: boolean; agentCount?: number; error?: string }> {
    try {
      const token  = await this.doAuthenticate();
      const agents = await this.doFetchAgents(token);
      return { ok: true, agentCount: agents.length };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Unknown error' };
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async safePoll(): Promise<void> {
    try {
      await this.poll();
      this.backoffMs     = 60_000;
      this.lastPollError = null;
    } catch (err: any) {
      console.error('[wazuh] poll error:', err);
      this.lastPollOk    = false;
      this.lastPollError = err?.message ?? 'Unknown error';
      this.backoffMs     = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  private async authenticate(): Promise<void> {
    this.token = await this.doAuthenticate();
    console.log('[wazuh] JWT refreshed');
  }

  private async doAuthenticate(): Promise<string> {
    const b64 = Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64');
    const res  = await fetch(`${this.cfg.manager_url}/security/user/authenticate`, {
      method:  'POST',
      headers: { Authorization: `Basic ${b64}` },
      agent:   this.httpsAgent as any,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Wazuh auth failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    const token = data?.data?.token as string | undefined;
    if (!token) throw new Error('Wazuh auth: no token in response');
    return token;
  }

  private async doFetchAgents(token: string): Promise<WazuhApiAgent[]> {
    const res = await fetch(`${this.cfg.manager_url}/agents?limit=500`, {
      headers: { Authorization: `Bearer ${token}` },
      agent:   this.httpsAgent as any,
    });
    if (res.status === 401) {
      // Token expired mid-interval — re-auth once and retry
      const fresh = await this.doAuthenticate();
      this.token  = fresh;
      return this.doFetchAgents(fresh);
    }
    if (!res.ok) throw new Error(`Wazuh agents fetch failed: HTTP ${res.status}`);
    const data = await res.json() as any;
    return (data?.data?.affected_items ?? []) as WazuhApiAgent[];
  }

  private async poll(): Promise<void> {
    if (!this.token) await this.authenticate();
    const agents = await this.doFetchAgents(this.token!);
    this.lastPollAt = new Date();
    this.lastPollOk = true;

    for (const agent of agents) {
      await this.processAgent(agent).catch(err =>
        console.error(`[wazuh] processAgent(${agent.id}) error:`, err)
      );
    }
  }

  private async processAgent(agent: WazuhApiAgent): Promise<void> {
    const prevStatus = lastStatus.get(agent.id);
    const keepAlive  = agent.lastKeepAlive ? new Date(agent.lastKeepAlive) : null;
    const groupName  = agent.group?.[0] ?? null;

    // Upsert — last_status_change only updated when status actually changes (SQL CASE)
    await query(
      `INSERT INTO wazuh_agents
         (wazuh_id, name, ip_address, status, os_name, os_version,
          agent_version, last_keep_alive, group_name, last_seen, last_status_change)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
       ON CONFLICT (wazuh_id) DO UPDATE SET
         name               = EXCLUDED.name,
         ip_address         = EXCLUDED.ip_address,
         status             = EXCLUDED.status,
         os_name            = EXCLUDED.os_name,
         os_version         = EXCLUDED.os_version,
         agent_version      = EXCLUDED.agent_version,
         last_keep_alive    = EXCLUDED.last_keep_alive,
         group_name         = EXCLUDED.group_name,
         last_seen          = NOW(),
         last_status_change = CASE
           WHEN wazuh_agents.status <> EXCLUDED.status THEN NOW()
           ELSE wazuh_agents.last_status_change
         END`,
      [
        agent.id,
        agent.name,
        agent.ip ?? null,
        agent.status,
        agent.os?.name    ?? null,
        agent.os?.version ?? null,
        agent.version     ?? null,
        keepAlive,
        groupName,
      ]
    );

    // ── Alerting logic ───────────────────────────────────────────────────────

    const coolKey   = agent.id;
    const lastAlert = cooldown.get(coolKey) ?? 0;
    const cooledDown = Date.now() - lastAlert >= COOLDOWN_MS;

    if (prevStatus === undefined) {
      // First time we see this agent — info alert
      await this.fire('info', agent, `WAZUH AGENT ${agent.name} (${agent.ip ?? 'unknown'}) registered — status: ${agent.status}`);
    } else if (prevStatus === 'active' && agent.status !== 'active' && cooledDown) {
      // Degraded from active → critical alert
      cooldown.set(coolKey, Date.now());
      await this.fire('critical', agent, `WAZUH AGENT ${agent.name} (${agent.ip ?? 'unknown'}) is now ${agent.status}`);
    } else if (agent.status === 'active' && keepAlive) {
      // Stale keepalive check
      const ageMs = Date.now() - keepAlive.getTime();
      if (ageMs > STALE_KEEPALIVE_MS && cooledDown) {
        const mins = Math.round(ageMs / 60_000);
        cooldown.set(coolKey, Date.now());
        await this.fire('warning', agent, `WAZUH AGENT ${agent.name} last keepalive ${mins}m ago`);
      }
    }

    lastStatus.set(agent.id, agent.status);
  }

  private async fire(
    severity: Alert['severity'],
    agent: WazuhApiAgent,
    message: string
  ): Promise<void> {
    const { rows } = await query(
      `INSERT INTO alerts (server_id, severity, message, metric_type)
       VALUES (NULL, $1, $2, 'wazuh') RETURNING id, created_at`,
      [severity, message]
    );
    const row = rows[0];
    await this.dispatcher.dispatchAlert({
      id:              row?.id ?? 0,
      server_id:       0,
      severity,
      message,
      metric_type:     'wazuh' as Alert['metric_type'],
      threshold_value: {},
      actual_value:    {},
      acknowledged:    false,
      created_at:      row?.created_at ?? new Date(),
    });
  }
}
