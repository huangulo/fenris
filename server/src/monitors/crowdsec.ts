import fetch from 'node-fetch';
import { query } from '../db/client.js';
import { Alert } from '../types.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';
import { parseDurationMs } from '../engine/predictor.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CrowdSecInstanceConfig {
  name:    string;
  url:     string;
  api_key: string;
}

export interface CrowdSecConfig {
  enabled:       boolean;
  instances:     CrowdSecInstanceConfig[];
  poll_interval: string;
}

interface CrowdSecDecision {
  id:        number;
  origin:    string;
  type:      string;    // "ban" | "captcha" | …
  scope:     string;    // "Ip" | "Range"
  value:     string;    // IP address or CIDR
  duration:  string;    // Go duration, e.g. "3h59m57.123s"
  scenario:  string;
  simulated: boolean;
  until?:    string;    // ISO-8601 expiry timestamp (some versions)
  country?:  string;    // two-letter ISO country code (some versions)
}

interface InstanceState {
  cfg:          CrowdSecInstanceConfig;
  serverId:     number | null;
  lastPollAt:   Date   | null;
  lastPollOk:   boolean;
  lastPollError: string | null;
  backoffMs:    number;
  isFirstPoll:  boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse a Go-style duration string to milliseconds, e.g. "3h59m57.123s" → ms */
function parseGoDuration(d: string): number {
  let ms = 0;
  const m = d.match(/(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/);
  if (m) {
    ms += (parseInt(m[1] ?? '0', 10)) * 3_600_000;
    ms += (parseInt(m[2] ?? '0', 10)) * 60_000;
    ms += (parseFloat(m[3] ?? '0'))   * 1_000;
  }
  return ms;
}

const MAX_BACKOFF_MS    = 5 * 60_000;   // 5 min
const ALERT_COOLDOWN_MS = 15 * 60_000;  // 15 min per server

// ── CrowdSecMonitor ───────────────────────────────────────────────────────────

export class CrowdSecMonitor {
  private cfg:        CrowdSecConfig;
  private dispatcher: AlertDispatcher;
  private instances:  InstanceState[] = [];
  private pollTimer:  NodeJS.Timeout | null = null;

  /** Per-server alert cooldown: Map<serverId, lastAlertTimestamp> */
  private alertCooldown = new Map<number, number>();

  constructor(cfg: CrowdSecConfig, dispatcher: AlertDispatcher) {
    this.cfg        = cfg;
    this.dispatcher = dispatcher;
  }

  async start(): Promise<void> {
    if (!this.cfg.enabled) return;

    // Resolve server IDs for each instance
    for (const inst of this.cfg.instances) {
      const { rows } = await query('SELECT id FROM servers WHERE LOWER(name) = LOWER($1) LIMIT 1', [inst.name]);
      const serverId = rows[0]?.id ?? null;
      if (serverId === null) {
        console.warn(`[crowdsec] No Fenris server found matching instance "${inst.name}" — will retry on each poll`);
      } else {
        console.log(`[crowdsec] Instance "${inst.name}" → server_id=${serverId}`);
      }
      this.instances.push({ cfg: inst, serverId, lastPollAt: null, lastPollOk: false, lastPollError: null, backoffMs: 60_000, isFirstPoll: true });
    }

    await this.pollAll();

    const intervalMs = parseDurationMs(this.cfg.poll_interval, 60_000);
    this.pollTimer = setInterval(() => this.pollAll(), intervalMs);
    console.log(`[crowdsec] polling ${this.instances.length} instance(s) every ${this.cfg.poll_interval}`);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    console.log('[crowdsec] stopped');
  }

  /** Called by POST /api/v1/crowdsec/test-connection */
  async testConnection(instanceName: string): Promise<{ ok: boolean; decision_count?: number; error?: string }> {
    const inst = this.cfg.instances.find(i => i.name === instanceName);
    if (!inst) return { ok: false, error: `Instance "${instanceName}" not found in config` };

    try {
      const { added } = await this.fetchDecisionStream(inst, true);
      return { ok: true, decision_count: added.length };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Unknown error' };
    }
  }

  /** Observable state for settings page */
  getStatus(): { enabled: boolean; instances: Array<{ name: string; server_id: number | null; last_poll_at: Date | null; last_poll_ok: boolean; last_poll_error: string | null }> } {
    return {
      enabled: this.cfg.enabled,
      instances: this.instances.map(s => ({
        name:            s.cfg.name,
        server_id:       s.serverId,
        last_poll_at:    s.lastPollAt,
        last_poll_ok:    s.lastPollOk,
        last_poll_error: s.lastPollError,
      })),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async pollAll(): Promise<void> {
    for (const state of this.instances) {
      await this.safePoll(state);
    }
  }

  private async safePoll(state: InstanceState): Promise<void> {
    try {
      await this.poll(state);
      state.lastPollOk    = true;
      state.lastPollError = null;
      state.backoffMs     = 60_000;
    } catch (err: any) {
      console.error(`[crowdsec] poll error for "${state.cfg.name}":`, err);
      state.lastPollOk    = false;
      state.lastPollError = err?.message ?? 'Unknown error';
      state.backoffMs     = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  private async poll(state: InstanceState): Promise<void> {
    // Re-resolve server ID if not yet found
    if (state.serverId === null) {
      const { rows } = await query('SELECT id FROM servers WHERE LOWER(name) = LOWER($1) LIMIT 1', [state.cfg.name]);
      state.serverId = rows[0]?.id ?? null;
      if (state.serverId === null) {
        throw new Error(`No Fenris server matching "${state.cfg.name}"`);
      }
      console.log(`[crowdsec] Resolved "${state.cfg.name}" → server_id=${state.serverId}`);
    }

    const startup = state.isFirstPoll;
    const { added, deleted } = await this.fetchDecisionStream(state.cfg, startup);
    state.lastPollAt   = new Date();
    state.isFirstPoll  = false;

    // ── Upsert added decisions ────────────────────────────────────────────────
    const newBans: CrowdSecDecision[] = [];

    for (const d of added) {
      let expiresAt: Date | null = null;
      if (d.until) {
        expiresAt = new Date(d.until);
      } else if (d.duration) {
        expiresAt = new Date(Date.now() + parseGoDuration(d.duration));
      }

      await query(
        `INSERT INTO crowdsec_decisions
           (server_id, decision_id, source_ip, source_country, scenario, action, duration, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (server_id, decision_id) DO UPDATE SET
           source_ip      = EXCLUDED.source_ip,
           source_country = EXCLUDED.source_country,
           scenario       = EXCLUDED.scenario,
           action         = EXCLUDED.action,
           duration       = EXCLUDED.duration,
           expires_at     = EXCLUDED.expires_at`,
        [
          state.serverId, d.id, d.value, d.country ?? null,
          d.scenario, d.type, d.duration, expiresAt,
        ]
      );

      if (d.type === 'ban') newBans.push(d);
    }

    // ── Remove deleted decisions reported by LAPI ─────────────────────────────
    if (deleted.length > 0) {
      const deletedIds = deleted.map(d => d.id);
      await query(
        `DELETE FROM crowdsec_decisions WHERE server_id = $1 AND decision_id = ANY($2::int[])`,
        [state.serverId, deletedIds]
      );
    }

    // ── Alert on new ban decisions (per-server cooldown) ──────────────────────
    if (newBans.length > 0) {
      const lastAlert = this.alertCooldown.get(state.serverId) ?? 0;
      if (Date.now() - lastAlert >= ALERT_COOLDOWN_MS) {
        const sample = newBans[0];
        const message = `CROWDSEC: ${state.cfg.name} — ${newBans.length} new ban(s). Latest: ${sample.value} for ${sample.scenario}`;
        await this.fire('info', state.serverId, message);
        this.alertCooldown.set(state.serverId, Date.now());
      }
    }
  }

  private async fetchDecisionStream(
    inst: CrowdSecInstanceConfig,
    startup: boolean,
  ): Promise<{ added: CrowdSecDecision[]; deleted: CrowdSecDecision[] }> {
    const url = `${inst.url}/v1/decisions/stream?startup=${startup}`;
    const res = await fetch(url, { headers: { 'X-Api-Key': inst.api_key } });
    if (!res.ok) throw new Error(`CrowdSec LAPI responded HTTP ${res.status}`);
    const body = await res.json() as { new?: CrowdSecDecision[] | null; deleted?: CrowdSecDecision[] | null } | null;
    if (body === null) return { added: [], deleted: [] };
    return {
      added:   body.new     ?? [],
      deleted: body.deleted ?? [],
    };
  }

  private async fire(severity: Alert['severity'], serverId: number, message: string): Promise<void> {
    const { rows } = await query(
      `INSERT INTO alerts (server_id, severity, message, metric_type)
       VALUES ($1, $2, $3, 'crowdsec') RETURNING id, created_at`,
      [serverId, severity, message]
    );
    const row = rows[0];
    await this.dispatcher.dispatchAlert({
      id:              row?.id ?? 0,
      server_id:       serverId,
      severity,
      message,
      metric_type:     'crowdsec' as Alert['metric_type'],
      threshold_value: {},
      actual_value:    {},
      acknowledged:    false,
      created_at:      row?.created_at ?? new Date(),
    });
  }
}
