// Runtime configuration: environment variables provide defaults, admin settings stored in the DB override them.
import { getSetting, getAllSettings } from './db.js';

export const APP_NAME = process.env.APP_NAME || 'Ondoku';
export const APP_VERSION = '1.0.0';

const ENV_MAP = {
  public_url: 'PUBLIC_URL',
  registration_enabled: 'REGISTRATION_ENABLED',
  oidc_enabled: 'OIDC_ENABLED',
  oidc_issuer: 'OIDC_ISSUER',
  oidc_client_id: 'OIDC_CLIENT_ID',
  oidc_client_secret: 'OIDC_CLIENT_SECRET',
  oidc_name: 'OIDC_NAME',
  oidc_scopes: 'OIDC_SCOPES',
  oidc_auto_create: 'OIDC_AUTO_CREATE',
  oidc_only: 'OIDC_ONLY',
  oidc_admin_claim: 'OIDC_ADMIN_CLAIM',
  oidc_admin_value: 'OIDC_ADMIN_VALUE',
  tts_url: 'TTS_URL',
  default_voice: 'TTS_DEFAULT_VOICE',
  audio_cache_mb: 'AUDIO_CACHE_MB',
  save_images: 'SAVE_IMAGES',
};
export const SETTING_KEYS = Object.keys(ENV_MAP);
export const SECRET_KEYS = ['oidc_client_secret'];

export function cfg(key, fallback = '') {
  const v = getSetting(key);
  if (v != null && v !== '') return v;
  const env = process.env[ENV_MAP[key]];
  if (env != null && env !== '') return env;
  return fallback;
}
export function cfgBool(key, fallback = false) {
  const v = cfg(key, null);
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
export function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
export function publicUrl(req) {
  const p = cfg('public_url', '');
  if (p) return p.replace(/\/+$/, '');
  if (!req) return 'http://localhost:' + (process.env.PORT || 3102);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
// Snapshot for the admin UI (secrets masked, env-provided values flagged)
export function settingsSnapshot() {
  const stored = getAllSettings();
  const out = {};
  for (const k of SETTING_KEYS) {
    const fromEnv = process.env[ENV_MAP[k]];
    const value = stored[k] ?? '';
    out[k] = {
      value: SECRET_KEYS.includes(k) ? (value ? '••••••••' : '') : value,
      envValue: fromEnv != null && fromEnv !== '' ? (SECRET_KEYS.includes(k) ? '••••••••' : fromEnv) : null,
      set: !!(value || (fromEnv != null && fromEnv !== '')),
    };
  }
  return out;
}
