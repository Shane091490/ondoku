// Login, registration, logout, status, OIDC.
import express from 'express';
import { db, userCount } from '../lib/db.js';
import { hashPassword, verifyPassword, createSession, deleteSession, setSessionCookie, clearSessionCookie, publicUser, getUserByEmail, normalizeEmail, EMAIL_RE } from '../lib/auth.js';
import { oidcEnabled, oidcName, beginLogin, finishLogin } from '../lib/oidc.js';
import { cfgBool, APP_NAME, APP_VERSION } from '../lib/config.js';

export const authRouter = express.Router();

function loginRateLimit() {
  const attempts = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const a = attempts.get(key) || { count: 0, until: 0 };
    if (a.until > now) return res.status(429).json({ error: 'Too many attempts, try again later' });
    res.on('finish', () => {
      if (res.statusCode === 401) {
        a.count++;
        if (a.count >= 8) { a.until = now + 10 * 60000; a.count = 0; }
        attempts.set(key, a);
      } else if (res.statusCode < 300) attempts.delete(key);
    });
    next();
  };
}

authRouter.get('/status', (req, res) => {
  res.json({
    appName: APP_NAME,
    version: APP_VERSION,
    setupNeeded: userCount() === 0,
    registrationEnabled: cfgBool('registration_enabled', false) || userCount() === 0,
    oidc: oidcEnabled() ? { enabled: true, name: oidcName(), only: cfgBool('oidc_only', false) } : { enabled: false },
    user: publicUser(req.user),
  });
});

authRouter.post('/register', (req, res) => {
  const first = userCount() === 0;
  if (!first && !cfgBool('registration_enabled', false)) return res.status(403).json({ error: 'Registration is disabled' });
  const { password, displayName } = req.body || {};
  const email = normalizeEmail(req.body?.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });
  const info = db.prepare('INSERT INTO users (email, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)').run(email, String(displayName || '').trim().slice(0, 80) || email.split('@')[0], hashPassword(password), first ? 1 : 0);
  const session = createSession(info.lastInsertRowid, req.headers['user-agent']);
  setSessionCookie(res, session);
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
});

authRouter.post('/login', loginRateLimit(), (req, res) => {
  const { password } = req.body || {};
  const user = getUserByEmail(req.body?.email);
  if (!user || !verifyPassword(password || '', user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  if (user.disabled) return res.status(403).json({ error: 'This account is disabled' });
  const session = createSession(user.id, req.headers['user-agent']);
  setSessionCookie(res, session);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  if (req.sessionId) deleteSession(req.sessionId);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: publicUser(req.user) });
});

// OIDC (mounted at /auth/oidc)
export const oidcRouter = express.Router();
oidcRouter.get('/login', async (req, res) => {
  if (!oidcEnabled()) return res.status(404).send('OIDC is not configured');
  try { await beginLogin(req, res); } catch (e) { res.redirect('/#/login?error=' + encodeURIComponent(e.message)); }
});
oidcRouter.get('/callback', async (req, res) => {
  try { await finishLogin(req, res); } catch (e) { res.redirect('/#/login?error=' + encodeURIComponent(e.message)); }
});
