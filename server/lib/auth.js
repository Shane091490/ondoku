// Password hashing, sessions, API keys and the request authentication middleware.
// API keys ("Authorization: Bearer od_…" or "x-api-key: od_…") give other apps the same data access as the
// user; they can be read-only and can never manage accounts, keys, passwords or server settings.
import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

const SESSION_DAYS = 30;
export const COOKIE_NAME = 'readlog_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase().slice(0, 160);
}

export const DEFAULT_PREFS = {
  piperVoice: '', rate: 1, autoAudio: false, speakers: [],
  // Archiving: when an article is read to the end, when read aloud finishes it, after N days in the queue (0: never),
  // and whether archiving also removes its audio. Archived articles are deleted N days after archiving (0: never).
  archiveOnFinish: true, archiveOnListen: true, archiveAfterDays: 0, dropAudioOnArchive: false, deleteArchivedAfterDays: 730,
};
// Only known keys are returned, so settings that no longer exist (the old device-voice options) drop out.
export function userPrefs(u) {
  let stored = {};
  try { stored = u?.prefs_json ? JSON.parse(u.prefs_json) : {}; } catch { /* use defaults */ }
  return Object.fromEntries(Object.entries(DEFAULT_PREFS).map(([k, v]) => [k, stored[k] ?? v]));
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    isAdmin: !!u.is_admin,
    disabled: !!u.disabled,
    hasPassword: !!u.password_hash,
    oidc: !!u.oidc_sub,
    prefs: userPrefs(u),
    createdAt: u.created_at,
  };
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function getUserByEmail(email) {
  const e = normalizeEmail(email);
  return e ? db.prepare('SELECT * FROM users WHERE email = ?').get(e) : undefined;
}

// ----- sessions -----
export function createSession(userId, userAgent) {
  const id = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)').run(id, userId, expires, (userAgent || '').slice(0, 200));
  return { id, expires };
}
export function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
export function deleteUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
export function setSessionCookie(res, session) {
  res.cookie(COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true' || (process.env.PUBLIC_URL || '').startsWith('https://'),
    expires: new Date(session.expires),
    path: '/',
  });
}
export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function userFromSession(sessionId) {
  if (!sessionId) return null;
  const row = db.prepare('SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(sessionId);
  if (!row) return null;
  if (row.expires_at < nowIso()) {
    deleteSession(sessionId);
    return null;
  }
  return row;
}

// ----- API keys: "od_" + 40 url-safe chars ("rl_" from before the rename still works); only the SHA-256 hash is stored -----
export function createApiKey(userId, name, permission = 'write') {
  const secret = 'od_' + randomToken(30);
  const prefix = secret.slice(0, 10);
  const info = db.prepare('INSERT INTO api_keys (user_id, name, prefix, hash, permission) VALUES (?, ?, ?, ?, ?)').run(userId, name, prefix, sha256(secret), permission === 'read' ? 'read' : 'write');
  return { id: Number(info.lastInsertRowid), secret, prefix };
}
export function listApiKeys(userId) {
  return db.prepare('SELECT id, name, prefix, permission, created_at, last_used FROM api_keys WHERE user_id = ? ORDER BY created_at').all(userId)
    .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, permission: k.permission, createdAt: k.created_at, lastUsed: k.last_used }));
}
export function revokeApiKey(userId, id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
function userFromApiKey(secret) {
  if (!/^(od|rl)_[A-Za-z0-9_-]{20,}$/.test(secret)) return null;
  const row = db.prepare('SELECT k.id AS key_id, k.name AS key_name, k.permission AS key_permission, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.hash = ?').get(sha256(secret));
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(nowIso(), row.key_id);
  return row;
}

// Populates req.user from an API key (JSON API only) or the session cookie.
export function authenticate(req, _res, next) {
  let user = null;
  const auth = req.headers.authorization || '';
  const headerKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  const secret = (/^Bearer\s+(.+)$/i.exec(auth)?.[1] || headerKey || '').trim();
  if (secret) {
    if (req.path.startsWith('/api/') && !req.path.startsWith('/api/auth')) {
      const row = userFromApiKey(secret);
      if (row) {
        user = row;
        req.authMethod = 'apikey';
        req.apiKey = { id: row.key_id, name: row.key_name, permission: row.key_permission };
      } else req.badApiKey = true;
    }
  } else if (req.cookies?.[COOKIE_NAME]) {
    user = userFromSession(req.cookies[COOKIE_NAME]);
    req.authMethod = 'session';
    req.sessionId = req.cookies[COOKIE_NAME];
  }
  if (user && user.disabled) user = null;
  req.user = user || null;
  next();
}

export function requireUser(req, res, next) {
  if (req.badApiKey) return res.status(401).json({ error: 'Invalid or revoked API key' });
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}
// Endpoints that only a browser session may use (never an API key).
const KEY_BLOCKED = [/^\/me\/(password|sessions|api-keys)(\/|$)/, /^\/admin(\/|$)/];
export function apiKeyGuard(req, res, next) {
  if (req.authMethod !== 'apikey') return next();
  if (KEY_BLOCKED.some((re) => re.test(req.path))) return res.status(403).json({ error: 'API keys cannot access this endpoint' });
  if (req.apiKey.permission === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(403).json({ error: 'This API key is read-only' });
  next();
}
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// Cheap periodic cleanup of expired sessions / stale OIDC states.
export function cleanupAuth() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  db.prepare("DELETE FROM oidc_states WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')").run();
}
