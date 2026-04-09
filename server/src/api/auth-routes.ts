import { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/client.js';
import {
  hashPassword, verifyPassword,
  generateToken, verifyToken,
  writeAuditLog, Role,
} from '../auth/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getIP(request: FastifyRequest): string {
  const fwd = request.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0])?.trim()
      ?? request.socket.remoteAddress
      ?? 'unknown';
}

// ── Login rate limiter (5 attempts / minute / IP) ─────────────────────────────

interface RateEntry { count: number; resetAt: number }
const loginAttempts = new Map<string, RateEntry>();

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

// ── POST /api/v1/auth/login ───────────────────────────────────────────────────

interface LoginBody { username: string; password: string }

export async function login(
  request: FastifyRequest<{ Body: LoginBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const ip = getIP(request);

  if (!checkLoginRateLimit(ip)) {
    return reply.status(429).send({ error: 'Too many login attempts — try again in a minute' });
  }

  const { username, password } = request.body ?? {};
  if (!username || !password) {
    return reply.status(400).send({ error: 'username and password required' });
  }

  const res = await query(
    'SELECT id, username, password_hash, role, enabled FROM users WHERE username = $1',
    [username]
  );

  const user = res.rows[0];
  const valid = user && user.enabled && await verifyPassword(password, user.password_hash);

  await writeAuditLog(
    valid ? user.id : null,
    username,
    valid ? 'auth.login' : 'auth.login_failed',
    undefined, undefined,
    { ip },
    ip,
  );

  if (!valid) {
    return reply.status(401).send({ error: 'Invalid credentials' });
  }

  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
  const token = generateToken({ id: user.id, username: user.username, role: user.role as Role });

  return reply.send({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
}

// ── POST /api/v1/auth/logout ──────────────────────────────────────────────────

export async function logout(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // JWTs are stateless — client must discard the token
  if (request.user) {
    await writeAuditLog(request.user.id, request.user.username, 'auth.logout',
      undefined, undefined, undefined, getIP(request));
  }
  return reply.send({ ok: true });
}

// ── GET /api/v1/auth/me ───────────────────────────────────────────────────────

export async function me(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!request.user) return reply.status(401).send({ error: 'unauthorized' });
  const res = await query(
    'SELECT id, username, email, role, enabled, last_login, created_at FROM users WHERE id = $1',
    [request.user.id]
  );
  if (res.rows.length === 0) return reply.status(401).send({ error: 'user not found' });
  return reply.send(res.rows[0]);
}

// ── POST /api/v1/auth/change-password ────────────────────────────────────────

interface ChangePasswordBody { current_password: string; new_password: string }

export async function changePassword(
  request: FastifyRequest<{ Body: ChangePasswordBody }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!request.user) return reply.status(401).send({ error: 'unauthorized' });
  const { current_password, new_password } = request.body ?? {};
  if (!current_password || !new_password) {
    return reply.status(400).send({ error: 'current_password and new_password required' });
  }
  if (new_password.length < 8) {
    return reply.status(400).send({ error: 'new_password must be at least 8 characters' });
  }

  const res = await query('SELECT password_hash FROM users WHERE id = $1', [request.user.id]);
  const valid = await verifyPassword(current_password, res.rows[0]?.password_hash ?? '');
  if (!valid) return reply.status(401).send({ error: 'Current password is incorrect' });

  const hash = await hashPassword(new_password);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, request.user.id]);

  await writeAuditLog(request.user.id, request.user.username, 'auth.change_password',
    'user', request.user.id, undefined, getIP(request));

  return reply.send({ ok: true });
}
