// OpenID Connect login (authorization code + PKCE) using the provider's discovery document. No extra dependencies.
// The ID token comes straight from the token endpoint over TLS, so issuer/audience/nonce checks are done on the
// decoded claims (OIDC Core 3.1.3.7.6 allows skipping the signature check in that case).
import crypto from 'node:crypto';
import { db } from './db.js';
import { cfg, cfgBool, publicUrl } from './config.js';
import { createSession, setSessionCookie, normalizeEmail } from './auth.js';

let discoveryCache = { issuer: null, doc: null, at: 0 };

export function oidcEnabled() {
  return cfgBool('oidc_enabled', true) && !!(cfg('oidc_issuer') && cfg('oidc_client_id'));
}
export function oidcName() {
  return cfg('oidc_name', 'Single sign-on');
}

async function discover() {
  const issuer = cfg('oidc_issuer').replace(/\/+$/, '');
  if (discoveryCache.issuer === issuer && Date.now() - discoveryCache.at < 3600000) return discoveryCache.doc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = await res.json();
  discoveryCache = { issuer, doc, at: Date.now() };
  return doc;
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function redirectUri(req) { return `${publicUrl(req)}/auth/oidc/callback`; }

export async function beginLogin(req, res) {
  const doc = await discover();
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const nonce = b64url(crypto.randomBytes(16));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const redirect = typeof req.query.redirect === 'string' && req.query.redirect.startsWith('/') ? req.query.redirect : '/';
  db.prepare('INSERT INTO oidc_states (state, verifier, nonce, redirect) VALUES (?, ?, ?, ?)').run(state, verifier, nonce, redirect);
  const params = new URLSearchParams({
    response_type: 'code', client_id: cfg('oidc_client_id'), redirect_uri: redirectUri(req),
    scope: cfg('oidc_scopes', 'openid profile email'), state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
  });
  res.redirect(`${doc.authorization_endpoint}?${params}`);
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

function claimHasValue(claims, claimName, value) {
  if (!claimName || !value) return false;
  const path = claimName.split('.');
  let v = claims;
  for (const p of path) { if (v == null) return false; v = v[p]; }
  if (Array.isArray(v)) return v.map(String).includes(value);
  return v != null && String(v) === value;
}

export async function finishLogin(req, res) {
  const { code, state, error, error_description } = req.query;
  if (error) throw new Error(`Provider error: ${error_description || error}`);
  const st = db.prepare('SELECT * FROM oidc_states WHERE state = ?').get(String(state || ''));
  if (!st) throw new Error('Login session expired, please try again');
  db.prepare('DELETE FROM oidc_states WHERE state = ?').run(st.state);
  const doc = await discover();
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri(req), client_id: cfg('oidc_client_id'), code_verifier: st.verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const secret = cfg('oidc_client_secret');
  if (secret) headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(cfg('oidc_client_id'))}:${encodeURIComponent(secret)}`).toString('base64');
  const tokenRes = await fetch(doc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokens.error_description || tokens.error || tokenRes.status}`);
  const idClaims = decodeJwtPayload(tokens.id_token) || {};
  if (idClaims.nonce && idClaims.nonce !== st.nonce) throw new Error('Nonce mismatch');
  if (idClaims.iss && idClaims.iss.replace(/\/+$/, '') !== cfg('oidc_issuer').replace(/\/+$/, '')) throw new Error('Issuer mismatch');
  const aud = Array.isArray(idClaims.aud) ? idClaims.aud : [idClaims.aud];
  if (idClaims.aud && !aud.includes(cfg('oidc_client_id'))) throw new Error('Audience mismatch');
  let claims = { ...idClaims };
  if (doc.userinfo_endpoint && tokens.access_token) {
    try {
      const ui = await fetch(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) });
      if (ui.ok) claims = { ...claims, ...(await ui.json()) };
    } catch { /* userinfo optional */ }
  }
  const sub = String(claims.sub || '');
  if (!sub) throw new Error('Provider did not return a subject');
  const email = claims.email ? normalizeEmail(claims.email) : null;
  const displayName = claims.name || claims.preferred_username || (email ? email.split('@')[0] : sub);
  const wantAdmin = claimHasValue(claims, cfg('oidc_admin_claim'), cfg('oidc_admin_value'));

  // Accounts are matched by provider subject first, then by email (which links an existing password account).
  let user = db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub);
  if (!user && email) {
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (byEmail && byEmail.oidc_sub && byEmail.oidc_sub !== sub) throw new Error('This email address is already linked to a different single sign-on identity');
    if (byEmail) { db.prepare('UPDATE users SET oidc_sub = ? WHERE id = ?').run(sub, byEmail.id); user = byEmail; }
  }
  if (!user) {
    if (!cfgBool('oidc_auto_create', true)) throw new Error('No account is linked to this identity. Ask an administrator to create one.');
    if (!email) throw new Error('The identity provider did not return an email address, which is needed to create an account');
    const firstUser = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    const info = db.prepare('INSERT INTO users (email, display_name, password_hash, is_admin, oidc_sub) VALUES (?, ?, NULL, ?, ?)').run(email, String(displayName).slice(0, 80), firstUser || wantAdmin ? 1 : 0, sub);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } else {
    if (cfg('oidc_admin_claim') && cfg('oidc_admin_value')) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(wantAdmin ? 1 : 0, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  if (user.disabled) throw new Error('This account is disabled');
  const session = createSession(user.id, req.headers['user-agent']);
  setSessionCookie(res, session);
  res.redirect(st.redirect || '/');
}
