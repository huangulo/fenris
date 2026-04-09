import { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuthUser { id: number; username: string; role: 'admin' | 'operator' | 'viewer' }

function getUser(req: FastifyRequest): AuthUser {
  return (req as any).user as AuthUser;
}

function requireRole(req: FastifyRequest, reply: FastifyReply, min: 'viewer' | 'operator' | 'admin'): boolean {
  const rank: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };
  const user = getUser(req);
  if (!user || rank[user.role] < rank[min]) {
    reply.status(403).send({ error: 'Insufficient permissions' });
    return false;
  }
  return true;
}

function fmtMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// ── List tickets ──────────────────────────────────────────────────────────────

export async function listTickets(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const { status, assigned_to, requester, limit: limitParam, search } = request.query as Record<string, string>;
    const limit = Math.min(parseInt(limitParam ?? '100'), 500);

    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (status)      { params.push(status);      conditions.push(`t.status = $${params.length}`); }
    if (assigned_to) { params.push(parseInt(assigned_to)); conditions.push(`t.assigned_to_user_id = $${params.length}`); }
    if (requester)   { params.push(`%${requester}%`);      conditions.push(`t.requester_name ILIKE $${params.length}`); }
    if (search)      {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(`(t.title ILIKE $${idx} OR t.requester_name ILIKE $${idx} OR t.description ILIKE $${idx})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const sql = `
      SELECT
        t.*,
        u_assign.username AS assigned_to_username,
        u_create.username AS created_by_username,
        (SELECT COALESCE(SUM(duration_minutes), 0) FROM support_ticket_notes WHERE ticket_id = t.id) AS notes_duration_minutes,
        (SELECT COUNT(*) FROM support_ticket_notes WHERE ticket_id = t.id) AS note_count
      FROM support_tickets t
      LEFT JOIN users u_assign ON u_assign.id = t.assigned_to_user_id
      LEFT JOIN users u_create ON u_create.id = t.created_by_user_id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await query(sql, params);
    return reply.send(result.rows);
  } catch (err) {
    console.error('[support] list error:', err);
    return reply.status(500).send({ error: 'Failed to list tickets' });
  }
}

// ── Get single ticket ─────────────────────────────────────────────────────────

export async function getTicket(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const id = parseInt(request.params.id);
    const ticketRes = await query(`
      SELECT
        t.*,
        u_assign.username AS assigned_to_username,
        u_create.username AS created_by_username,
        (SELECT COALESCE(SUM(duration_minutes), 0) FROM support_ticket_notes WHERE ticket_id = t.id) AS notes_duration_minutes
      FROM support_tickets t
      LEFT JOIN users u_assign ON u_assign.id = t.assigned_to_user_id
      LEFT JOIN users u_create ON u_create.id = t.created_by_user_id
      WHERE t.id = $1
    `, [id]);

    if (ticketRes.rows.length === 0) return reply.status(404).send({ error: 'Ticket not found' });

    const ticket = ticketRes.rows[0];
    const notesRes = await query(`
      SELECT n.*, u.username AS user_display
      FROM support_ticket_notes n
      LEFT JOIN users u ON u.id = n.user_id
      WHERE n.ticket_id = $1
      ORDER BY n.created_at ASC
    `, [id]);
    ticket.notes = notesRes.rows;
    return reply.send(ticket);
  } catch (err) {
    console.error('[support] get error:', err);
    return reply.status(500).send({ error: 'Failed to get ticket' });
  }
}

// ── Create ticket ─────────────────────────────────────────────────────────────

export async function createTicket(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const user = getUser(request);
    const { title, description, category = 'other', priority = 'normal',
            requester_name, requester_email, requester_department, device_info } =
      request.body as Record<string, string>;

    if (!title?.trim())           return reply.status(400).send({ error: 'title is required' });
    if (!requester_name?.trim())  return reply.status(400).send({ error: 'requester_name is required' });

    const result = await query(`
      INSERT INTO support_tickets
        (title, description, category, priority, requester_name, requester_email,
         requester_department, device_info, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [title, description ?? null, category, priority, requester_name,
        requester_email ?? null, requester_department ?? null, device_info ?? null, user?.id ?? null]);

    return reply.status(201).send(result.rows[0]);
  } catch (err) {
    console.error('[support] create error:', err);
    return reply.status(500).send({ error: 'Failed to create ticket' });
  }
}

// ── Update ticket ─────────────────────────────────────────────────────────────

export async function updateTicket(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    if (!requireRole(request, reply, 'operator')) return reply;

    const id   = parseInt(request.params.id);
    const body = request.body as Record<string, unknown>;

    const allowed = ['title','description','category','priority','status','requester_name',
                     'requester_email','requester_department','device_info','resolution',
                     'duration_minutes','assigned_to_user_id'];

    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];

    for (const key of allowed) {
      if (key in body) {
        params.push(body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }

    if (sets.length === 1) return reply.status(400).send({ error: 'No fields to update' });

    params.push(id);
    const result = await query(
      `UPDATE support_tickets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Ticket not found' });
    return reply.send(result.rows[0]);
  } catch (err) {
    console.error('[support] update error:', err);
    return reply.status(500).send({ error: 'Failed to update ticket' });
  }
}

// ── Delete ticket ─────────────────────────────────────────────────────────────

export async function deleteTicket(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    if (!requireRole(request, reply, 'admin')) return reply;
    const id = parseInt(request.params.id);
    await query('DELETE FROM support_tickets WHERE id = $1', [id]);
    return reply.status(204).send();
  } catch (err) {
    console.error('[support] delete error:', err);
    return reply.status(500).send({ error: 'Failed to delete ticket' });
  }
}

// ── Add note ──────────────────────────────────────────────────────────────────

export async function addNote(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    const user = getUser(request);
    const ticketId = parseInt(request.params.id);
    const { note, duration_minutes = 0 } = request.body as Record<string, unknown>;

    if (!note || String(note).trim() === '') return reply.status(400).send({ error: 'note is required' });

    const result = await query(`
      INSERT INTO support_ticket_notes (ticket_id, user_id, username, note, duration_minutes)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [ticketId, user?.id ?? null, user?.username ?? 'unknown', String(note), Number(duration_minutes)]);

    // Bump updated_at on parent ticket
    await query('UPDATE support_tickets SET updated_at = NOW() WHERE id = $1', [ticketId]);

    return reply.status(201).send(result.rows[0]);
  } catch (err) {
    console.error('[support] add-note error:', err);
    return reply.status(500).send({ error: 'Failed to add note' });
  }
}

// ── Start ticket ──────────────────────────────────────────────────────────────

export async function startTicket(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    if (!requireRole(request, reply, 'operator')) return reply;
    const user = getUser(request);
    const id   = parseInt(request.params.id);
    const result = await query(`
      UPDATE support_tickets
      SET status = 'in_progress',
          started_at = COALESCE(started_at, NOW()),
          assigned_to_user_id = COALESCE(assigned_to_user_id, $2),
          updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [id, user?.id ?? null]);
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Ticket not found' });
    return reply.send(result.rows[0]);
  } catch (err) {
    console.error('[support] start error:', err);
    return reply.status(500).send({ error: 'Failed to start ticket' });
  }
}

// ── Resolve ticket ────────────────────────────────────────────────────────────

export async function resolveTicket(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  try {
    if (!requireRole(request, reply, 'operator')) return reply;
    const id   = parseInt(request.params.id);
    const { resolution, duration_minutes } = request.body as Record<string, unknown>;
    const result = await query(`
      UPDATE support_tickets
      SET status = 'resolved',
          resolved_at = NOW(),
          resolution = COALESCE($2, resolution),
          duration_minutes = duration_minutes + $3,
          updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [id, resolution ?? null, Number(duration_minutes ?? 0)]);
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Ticket not found' });
    return reply.send(result.rows[0]);
  } catch (err) {
    console.error('[support] resolve error:', err);
    return reply.status(500).send({ error: 'Failed to resolve ticket' });
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function getStats(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const { from, to } = request.query as Record<string, string>;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 86_400_000);
    const toDate   = to   ? new Date(to)   : new Date();

    const [totals, byStatus, byCategory, byPriority, byUser, topRequesters, avgRes] = await Promise.all([
      query(`SELECT COUNT(*) AS total, COALESCE(SUM(duration_minutes),0) AS total_minutes
             FROM support_tickets WHERE created_at BETWEEN $1 AND $2`, [fromDate, toDate]),
      query(`SELECT status, COUNT(*) AS count FROM support_tickets
             WHERE created_at BETWEEN $1 AND $2 GROUP BY status`, [fromDate, toDate]),
      query(`SELECT category, COUNT(*) AS count FROM support_tickets
             WHERE created_at BETWEEN $1 AND $2 GROUP BY category ORDER BY count DESC`, [fromDate, toDate]),
      query(`SELECT priority, COUNT(*) AS count FROM support_tickets
             WHERE created_at BETWEEN $1 AND $2 GROUP BY priority ORDER BY count DESC`, [fromDate, toDate]),
      query(`SELECT u.username, COUNT(*) AS ticket_count, COALESCE(SUM(t.duration_minutes),0) AS total_minutes
             FROM support_tickets t JOIN users u ON u.id = t.assigned_to_user_id
             WHERE t.created_at BETWEEN $1 AND $2
             GROUP BY u.username ORDER BY ticket_count DESC LIMIT 10`, [fromDate, toDate]),
      query(`SELECT requester_name, COUNT(*) AS count FROM support_tickets
             WHERE created_at BETWEEN $1 AND $2
             GROUP BY requester_name ORDER BY count DESC LIMIT 10`, [fromDate, toDate]),
      query(`SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/60) AS avg_resolution_minutes
             FROM support_tickets
             WHERE created_at BETWEEN $1 AND $2 AND status = 'resolved' AND resolved_at IS NOT NULL`, [fromDate, toDate]),
    ]);

    const totalMinutes = parseInt(totals.rows[0]?.total_minutes ?? '0');

    return reply.send({
      total_tickets:        parseInt(totals.rows[0]?.total ?? '0'),
      total_hours:          fmtMinutes(totalMinutes),
      total_minutes:        totalMinutes,
      avg_resolution_time:  avgRes.rows[0]?.avg_resolution_minutes
                              ? `${Math.round(avgRes.rows[0].avg_resolution_minutes)}m`
                              : null,
      by_status:            byStatus.rows,
      by_category:          byCategory.rows,
      by_priority:          byPriority.rows,
      tickets_per_user:     byUser.rows,
      top_requesters:       topRequesters.rows,
    });
  } catch (err) {
    console.error('[support] stats error:', err);
    return reply.status(500).send({ error: 'Failed to get stats' });
  }
}

// ── Report (CSV or JSON) ──────────────────────────────────────────────────────

export async function getReport(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const { from, to, format = 'json' } = request.query as Record<string, string>;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 86_400_000);
    const toDate   = to   ? new Date(to)   : new Date();

    const result = await query(`
      SELECT t.id, t.title, t.category, t.priority, t.status,
             t.requester_name, t.requester_email, t.requester_department,
             t.duration_minutes,
             u.username AS assigned_to,
             t.created_at, t.started_at, t.resolved_at, t.resolution
      FROM support_tickets t
      LEFT JOIN users u ON u.id = t.assigned_to_user_id
      WHERE t.created_at BETWEEN $1 AND $2
      ORDER BY t.created_at DESC
    `, [fromDate, toDate]);

    if (format === 'csv') {
      const headers = ['id','title','category','priority','status','requester_name','requester_email',
                       'requester_department','duration_minutes','assigned_to','created_at','started_at',
                       'resolved_at','resolution'];
      const escape = (v: unknown) => {
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
      };
      const lines = [
        headers.join(','),
        ...result.rows.map((r: any) => headers.map(h => escape(r[h])).join(',')),
      ];
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="support-report.csv"');
      return reply.send(lines.join('\n'));
    }

    return reply.send(result.rows);
  } catch (err) {
    console.error('[support] report error:', err);
    return reply.status(500).send({ error: 'Failed to generate report' });
  }
}

// ── Requester autocomplete ────────────────────────────────────────────────────

export async function getRequesters(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    const { q } = request.query as Record<string, string>;
    const result = await query(`
      SELECT DISTINCT requester_name, requester_email, requester_department
      FROM support_tickets
      WHERE requester_name ILIKE $1
      ORDER BY requester_name
      LIMIT 10
    `, [`%${q ?? ''}%`]);
    return reply.send(result.rows);
  } catch (err) {
    return reply.status(500).send({ error: 'Failed' });
  }
}
