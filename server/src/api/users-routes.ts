import { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/client.js';
import { hashPassword, writeAuditLog, hasRole } from '../auth/index.js';

function getIP(request: FastifyRequest): string {
  const fwd = request.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0])?.trim()
      ?? request.socket.remoteAddress ?? 'unknown';
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.user || !hasRole(request.user.role, 'admin')) {
    reply.status(403).send({ error: 'admin role required' });
    return false;
  }
  return true;
}

// ── GET /api/v1/users ─────────────────────────────────────────────────────────

export async function listUsers(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  if (!requireAdmin(request, reply)) return reply;
  const res = await query(
    'SELECT id, username, email, role, enabled, last_login, created_at FROM users ORDER BY created_at ASC'
  );
  return reply.send(res.rows);
}

// ── POST /api/v1/users ────────────────────────────────────────────────────────

interface CreateUserBody { username: string; email?: string; password: string; role: string }

export async function createUser(
  request: FastifyRequest<{ Body: CreateUserBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!requireAdmin(request, reply)) return reply;
  const { username, email, password, role } = request.body ?? {};
  if (!username || !password || !role) {
    return reply.status(400).send({ error: 'username, password, and role required' });
  }
  if (!['admin', 'operator', 'viewer'].includes(role)) {
    return reply.status(400).send({ error: 'role must be admin, operator, or viewer' });
  }
  if (password.length < 8) {
    return reply.status(400).send({ error: 'password must be at least 8 characters' });
  }

  const hash = await hashPassword(password);
  try {
    const res = await query(
      `INSERT INTO users (username, email, password_hash, role, enabled, created_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW())
       RETURNING id, username, email, role, enabled, created_at`,
      [username, email ?? null, hash, role]
    );
    await writeAuditLog(request.user!.id, request.user!.username, 'user.create',
      'user', res.rows[0].id, { username, role }, getIP(request));
    return reply.status(201).send(res.rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') return reply.status(409).send({ error: 'Username already exists' });
    throw err;
  }
}

// ── PUT /api/v1/users/:id ─────────────────────────────────────────────────────

interface UpdateUserBody { role?: string; email?: string; enabled?: boolean }

export async function updateUser(
  request: FastifyRequest<{ Params: { id: string }; Body: UpdateUserBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!requireAdmin(request, reply)) return reply;
  const id = parseInt(request.params.id);
  const { role, email, enabled } = request.body ?? {};

  if (role && !['admin', 'operator', 'viewer'].includes(role)) {
    return reply.status(400).send({ error: 'invalid role' });
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (role    !== undefined) { params.push(role);    sets.push(`role = $${params.length}`); }
  if (email   !== undefined) { params.push(email);   sets.push(`email = $${params.length}`); }
  if (enabled !== undefined) { params.push(enabled); sets.push(`enabled = $${params.length}`); }

  if (sets.length === 0) return reply.status(400).send({ error: 'nothing to update' });

  params.push(id);
  const res = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, username, email, role, enabled, last_login, created_at`,
    params
  );
  if (res.rows.length === 0) return reply.status(404).send({ error: 'User not found' });

  await writeAuditLog(request.user!.id, request.user!.username, 'user.update',
    'user', id, { role, email, enabled }, getIP(request));
  return reply.send(res.rows[0]);
}

// ── POST /api/v1/users/:id/reset-password ────────────────────────────────────

interface ResetPasswordBody { new_password: string }

export async function resetPassword(
  request: FastifyRequest<{ Params: { id: string }; Body: ResetPasswordBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!requireAdmin(request, reply)) return reply;
  const id = parseInt(request.params.id);
  const { new_password } = request.body ?? {};
  if (!new_password || new_password.length < 8) {
    return reply.status(400).send({ error: 'new_password must be at least 8 characters' });
  }
  const hash = await hashPassword(new_password);
  const res = await query(
    'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, username',
    [hash, id]
  );
  if (res.rows.length === 0) return reply.status(404).send({ error: 'User not found' });
  await writeAuditLog(request.user!.id, request.user!.username, 'user.reset_password',
    'user', id, { target_username: res.rows[0].username }, getIP(request));
  return reply.send({ ok: true });
}

// ── DELETE /api/v1/users/:id ──────────────────────────────────────────────────

export async function deleteUser(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!requireAdmin(request, reply)) return reply;
  const id = parseInt(request.params.id);

  if (id === request.user!.id) {
    return reply.status(400).send({ error: "Cannot delete your own account" });
  }
  // Guard: cannot delete the last admin
  const adminRes = await query(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND enabled = TRUE"
  );
  const userRes = await query("SELECT role FROM users WHERE id = $1", [id]);
  if (userRes.rows.length === 0) return reply.status(404).send({ error: 'User not found' });

  if (userRes.rows[0].role === 'admin' && parseInt(adminRes.rows[0].n) <= 1) {
    return reply.status(400).send({ error: 'Cannot delete the last admin account' });
  }

  await query('DELETE FROM users WHERE id = $1', [id]);
  await writeAuditLog(request.user!.id, request.user!.username, 'user.delete',
    'user', id, { username: userRes.rows[0].username }, getIP(request));
  return reply.send({ ok: true });
}

// ── GET /api/v1/audit ─────────────────────────────────────────────────────────

export async function listAuditLog(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  if (!requireAdmin(request, reply)) return reply;
  const { user_id, action, limit: limitParam } = request.query as Record<string, string>;
  const limit = Math.min(parseInt(limitParam ?? '100'), 500);

  const conditions: string[] = [];
  const params: unknown[]    = [];
  if (user_id) { params.push(parseInt(user_id)); conditions.push(`user_id = $${params.length}`); }
  if (action)  { params.push(action);            conditions.push(`action = $${params.length}`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);
  const res = await query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return reply.send(res.rows);
}
