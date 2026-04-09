import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { query } from '../db/client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'operator' | 'viewer';

export interface JwtPayload {
  id:       number;
  username: string;
  role:     Role;
  iat?:     number;
  exp?:     number;
}

// Role hierarchy: higher = more permissions
const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

// ── JWT secret ────────────────────────────────────────────────────────────────

const SECRET_PATH = '/app/data/jwt-secret';
let jwtSecret: string;

export function loadOrGenerateJwtSecret(): string {
  // Prefer explicit env var
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
    jwtSecret = process.env.JWT_SECRET;
    console.log('[auth] JWT secret loaded from JWT_SECRET env var');
    return jwtSecret;
  }

  // Try loading from persisted file
  if (existsSync(SECRET_PATH)) {
    try {
      const stored = readFileSync(SECRET_PATH, 'utf8').trim();
      if (stored.length >= 64) {
        jwtSecret = stored;
        console.log('[auth] JWT secret loaded from', SECRET_PATH);
        return jwtSecret;
      }
    } catch { /* fall through to generate */ }
  }

  // Generate a new 64-byte secret and persist it
  jwtSecret = randomBytes(64).toString('hex');
  try {
    mkdirSync('/app/data', { recursive: true });
    writeFileSync(SECRET_PATH, jwtSecret, { mode: 0o600 });
    console.log('[auth] JWT secret generated and saved to', SECRET_PATH);
  } catch (err) {
    console.warn('[auth] Could not persist JWT secret to disk (stateless mode):', err);
  }
  return jwtSecret;
}

function getSecret(): string {
  if (!jwtSecret) throw new Error('[auth] JWT secret not initialised — call loadOrGenerateJwtSecret() first');
  return jwtSecret;
}

// ── Password ──────────────────────────────────────────────────────────────────

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, 12);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

// ── JWT ───────────────────────────────────────────────────────────────────────

export function generateToken(user: { id: number; username: string; role: Role }): string {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    getSecret(),
    { expiresIn: '24h' }
  );
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret()) as JwtPayload;
}

// ── Role check ────────────────────────────────────────────────────────────────

/**
 * Returns true if the user's role meets or exceeds the required role.
 * admin >= operator >= viewer
 */
export function hasRole(userRole: Role, required: Role): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[required];
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function writeAuditLog(
  userId:       number | null,
  username:     string,
  action:       string,
  resourceType?: string,
  resourceId?:   number,
  metadata?:     object,
  ipAddress?:    string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log
         (user_id, username, action, resource_type, resource_id, metadata, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        userId  ?? null,
        username,
        action,
        resourceType ?? null,
        resourceId   ?? null,
        metadata     ? JSON.stringify(metadata) : null,
        ipAddress    ?? null,
      ]
    );
  } catch (err) {
    // Audit failures must never break the main flow
    console.warn('[audit] failed to write audit log entry:', err);
  }
}

// ── Default admin creation ────────────────────────────────────────────────────

export async function ensureDefaultAdmin(): Promise<void> {
  try {
    const res = await query('SELECT COUNT(*) AS n FROM users');
    if (parseInt(res.rows[0].n) > 0) return;

    // No users exist — create default admin
    const password = randomBytes(8).toString('hex'); // 16-char hex
    const hash = await hashPassword(password);

    await query(
      `INSERT INTO users (username, password_hash, role, enabled, created_at)
       VALUES ('admin', $1, 'admin', TRUE, NOW())`,
      [hash]
    );

    // Print clearly — never again
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║          FENRIS DEFAULT ADMIN — SAVE THIS            ║');
    console.log('║                                                      ║');
    console.log(`║   Username: admin                                    ║`);
    console.log(`║   Password: ${password}                    ║`);
    console.log('║                                                      ║');
    console.log('║   Change it immediately via Settings → Account.      ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
  } catch (err) {
    console.error('[auth] failed to create default admin:', err);
  }
}
