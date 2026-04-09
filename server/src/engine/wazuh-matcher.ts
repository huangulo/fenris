import { query } from '../db/client.js';

// ── Wazuh ↔ Fenris server matcher ────────────────────────────────────────────
//
// Matching rules (in order):
//   1. Exact case-insensitive match: servers.name === wazuh_agents.name
//   2. Manual alias match:           servers.wazuh_agent_name === wazuh_agents.name
//
// If matched, servers.wazuh_agent_name is updated with the canonical Wazuh name.
// Unmatched servers and Wazuh agents are logged for admin visibility.

export interface MatchSummary {
  matched: number;
  unmatched_servers: string[];
  unmatched_wazuh_agents: string[];
}

export async function matchWazuhAgents(): Promise<MatchSummary> {
  const [serversRes, wazuhRes] = await Promise.all([
    query('SELECT id, name, wazuh_agent_name FROM servers ORDER BY id'),
    query('SELECT name FROM wazuh_agents ORDER BY name'),
  ]);

  const servers: Array<{ id: number; name: string; wazuh_agent_name: string | null }> = serversRes.rows;
  const wazuhAgents: Array<{ name: string }> = wazuhRes.rows;

  // Build lowercase lookup map: wazuh name → canonical name
  const wazuhByLower = new Map<string, string>(
    wazuhAgents.map(a => [a.name.toLowerCase(), a.name])
  );

  const matchedWazuhLower = new Set<string>();
  const matchedServerIds  = new Set<number>();

  for (const server of servers) {
    // Try 1: server.name matches a Wazuh agent name (case-insensitive)
    const canonical1 = wazuhByLower.get(server.name.toLowerCase());
    if (canonical1) {
      await query('UPDATE servers SET wazuh_agent_name = $1 WHERE id = $2', [canonical1, server.id]);
      matchedWazuhLower.add(canonical1.toLowerCase());
      matchedServerIds.add(server.id);
      continue;
    }

    // Try 2: servers.wazuh_agent_name (manually-set alias) matches a Wazuh agent name
    if (server.wazuh_agent_name) {
      const canonical2 = wazuhByLower.get(server.wazuh_agent_name.toLowerCase());
      if (canonical2) {
        matchedWazuhLower.add(canonical2.toLowerCase());
        matchedServerIds.add(server.id);
        continue;
      }
    }
  }

  const unmatched_servers = servers
    .filter(s => !matchedServerIds.has(s.id))
    .map(s => s.name);

  const unmatched_wazuh_agents = wazuhAgents
    .filter(a => !matchedWazuhLower.has(a.name.toLowerCase()))
    .map(a => a.name);

  if (unmatched_servers.length > 0) {
    console.log('[wazuh-matcher] Fenris servers with no Wazuh agent:', unmatched_servers.join(', '));
  }
  if (unmatched_wazuh_agents.length > 0) {
    console.log('[wazuh-matcher] Wazuh agents with no Fenris server:', unmatched_wazuh_agents.join(', '));
  }

  return {
    matched: matchedServerIds.size,
    unmatched_servers,
    unmatched_wazuh_agents,
  };
}
