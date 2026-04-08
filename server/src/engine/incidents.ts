import { query } from '../db/client.js';

type Severity = 'info' | 'warning' | 'critical';

const SEVERITY_RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 };

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Called after every alert INSERT.
 * Finds or creates an active incident for the server and links the alert.
 * If anything goes wrong, logs a warning — the alert is never lost.
 */
export async function attachAlertToIncident(
  alertId:    number,
  serverId:   number,
  severity:   Severity,
  metricType: string,
  message:    string,
): Promise<void> {
  try {
    // Look for an active incident on this server started within the last 5 minutes
    const existing = await query(
      `SELECT id, severity FROM incidents
       WHERE server_id = $1
         AND state != 'resolved'
         AND started_at > NOW() - INTERVAL '5 minutes'
       ORDER BY started_at DESC LIMIT 1`,
      [serverId]
    );

    let incidentId: number;

    if (existing.rows.length > 0) {
      incidentId = existing.rows[0].id;
      const current = existing.rows[0].severity as Severity;
      const merged  = maxSeverity(current, severity);

      await query(
        `UPDATE incidents
         SET alert_count = alert_count + 1, severity = $1, updated_at = NOW()
         WHERE id = $2`,
        [merged, incidentId]
      );
    } else {
      // Build a default title from the first alert
      const srvRes = await query('SELECT name FROM servers WHERE id = $1', [serverId]);
      const serverName = srvRes.rows[0]?.name ?? `server-${serverId}`;
      // e.g. "CPU anomaly on Racknerd Dallas"
      const friendlyType = metricType.replace(/_/g, ' ');
      const title = message.length <= 120
        ? message
        : `${friendlyType} anomaly on ${serverName}`;

      const incRes = await query(
        `INSERT INTO incidents
           (title, server_id, severity, state, started_at, alert_count, created_at, updated_at)
         VALUES ($1, $2, $3, 'new', NOW(), 1, NOW(), NOW())
         RETURNING id`,
        [title, serverId, severity]
      );
      incidentId = incRes.rows[0].id;
    }

    await query('UPDATE alerts SET incident_id = $1 WHERE id = $2', [incidentId, alertId]);

  } catch (err) {
    console.warn(`[incidents] failed to attach alert ${alertId} to incident (alert still saved):`, err);
  }
}

/**
 * Called after an alert is acknowledged.
 * Auto-resolves the parent incident if all its alerts are now acknowledged.
 */
export async function autoResolveIncident(incidentId: number): Promise<void> {
  try {
    const res = await query(
      `SELECT
         COUNT(*)                                  AS total,
         COUNT(*) FILTER (WHERE acknowledged)      AS acked
       FROM alerts WHERE incident_id = $1`,
      [incidentId]
    );
    const total = parseInt(res.rows[0]?.total ?? '0');
    const acked = parseInt(res.rows[0]?.acked ?? '0');

    if (total > 0 && total === acked) {
      await query(
        `UPDATE incidents
         SET state = 'resolved', resolved_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND state != 'resolved'`,
        [incidentId]
      );
      console.log(`[incidents] auto-resolved incident ${incidentId} (all ${total} alerts acknowledged)`);
    }
  } catch (err) {
    console.warn(`[incidents] failed to auto-resolve incident ${incidentId}:`, err);
  }
}

/**
 * One-time backfill: groups existing alerts (without an incident) into incidents
 * using the same 5-minute window logic. Runs only when the incidents table is empty.
 */
export async function backfillIncidents(): Promise<void> {
  try {
    const countRes = await query('SELECT COUNT(*) AS n FROM incidents');
    if (parseInt(countRes.rows[0].n) > 0) {
      console.log('[incidents] backfill skipped — incidents table already populated');
      return;
    }

    // Fetch all alerts without an incident, ordered chronologically
    const alertsRes = await query(
      `SELECT a.id, a.server_id, a.severity, a.metric_type, a.message, a.acknowledged, a.created_at
       FROM alerts a
       WHERE a.incident_id IS NULL
       ORDER BY a.created_at ASC`
    );

    if (alertsRes.rows.length === 0) {
      console.log('[incidents] backfill: no unattached alerts found');
      return;
    }

    // Group into 5-minute windows per server
    const openIncidents = new Map<number, { id: number; severity: Severity; windowEnd: Date }>();

    for (const alert of alertsRes.rows) {
      const serverId   = alert.server_id;
      const severity   = alert.severity as Severity;
      const createdAt  = new Date(alert.created_at);
      const open       = openIncidents.get(serverId);

      if (open && createdAt <= open.windowEnd) {
        // Attach to existing backfill incident
        const merged = maxSeverity(open.severity, severity);
        open.severity   = merged;
        open.windowEnd  = new Date(Math.max(open.windowEnd.getTime(), createdAt.getTime() + 5 * 60_000));

        await query(
          `UPDATE incidents SET alert_count = alert_count + 1, severity = $1, updated_at = NOW() WHERE id = $2`,
          [merged, open.id]
        );
        await query('UPDATE alerts SET incident_id = $1 WHERE id = $2', [open.id, alert.id]);
      } else {
        // Create new backfill incident
        const srvRes = await query('SELECT name FROM servers WHERE id = $1', [serverId]);
        const serverName = srvRes.rows[0]?.name ?? `server-${serverId}`;
        const title = alert.message?.length <= 120
          ? alert.message
          : `${(alert.metric_type ?? 'system').replace(/_/g, ' ')} anomaly on ${serverName}`;

        const state = alert.acknowledged ? 'resolved' : 'new';
        const incRes = await query(
          `INSERT INTO incidents
             (title, server_id, severity, state, started_at, alert_count,
              resolved_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, $6, NOW(), NOW())
           RETURNING id`,
          [
            title, serverId, severity, state, createdAt,
            alert.acknowledged ? createdAt : null,
          ]
        );
        const incidentId = incRes.rows[0].id;
        openIncidents.set(serverId, {
          id:        incidentId,
          severity,
          windowEnd: new Date(createdAt.getTime() + 5 * 60_000),
        });
        await query('UPDATE alerts SET incident_id = $1 WHERE id = $2', [incidentId, alert.id]);
      }
    }

    const total = alertsRes.rows.length;
    const incidents = openIncidents.size;
    console.log(`[incidents] backfill complete — ${total} alerts grouped into ${incidents} incidents`);
  } catch (err) {
    console.error('[incidents] backfill error:', err);
  }
}
