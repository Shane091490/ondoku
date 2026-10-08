// Ondoku: save articles from links, read them clean, listen to them. JSON API, password/OIDC auth, serves the PWA.
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authenticate, cleanupAuth } from './lib/auth.js';
import { authRouter, oidcRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { publicRouter } from './routes/public.js';
import { resumePendingFetches, archiveStale, purgeArchived } from './lib/articles.js';
import { initTts } from './lib/tts.js';
import { initImages } from './lib/images.js';
import { startFeedScheduler } from './lib/feeds.js';
import { APP_NAME, APP_VERSION } from './lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3102);
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 1);

// Saved articles are rendered from sanitized HTML; the CSP is a second line of defence (no inline or remote scripts).
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(cookieParser());
app.use(authenticate);
app.use(express.json({ limit: '10mb' }));

// Optional CORS for browser-based clients using API keys (never cookies). CORS_ORIGINS="https://a.example,https://b.example" or "*".
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (corsOrigins.length) {
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (corsOrigins.includes('*') || corsOrigins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
}

app.use('/api/auth', authRouter);
app.use('/auth/oidc', oidcRouter);
app.use('/api/v1', apiRouter);
app.use('/api', apiRouter);

app.get('/healthz', (req, res) => res.json({ ok: true, app: APP_NAME, version: APP_VERSION }));

// Public share links (no sign-in): /s/<token>
app.use('/s', publicRouter);

// PWA share target and bookmarklet entry point: hand the link to the in-app "save" screen.
app.get('/share', (req, res) => {
  const pick = (v) => (typeof v === 'string' ? v.slice(0, 4000) : '');
  const p = new URLSearchParams();
  const url = pick(req.query.url) || (pick(req.query.text).match(/https?:\/\/\S+/) || [''])[0];
  if (url) p.set('url', url);
  if (pick(req.query.title)) p.set('title', pick(req.query.title));
  if (!url && pick(req.query.text)) p.set('text', pick(req.query.text));
  if (req.query.open === '1') p.set('open', '1'); // bookmarklet: go straight to the saved article
  res.redirect(`/#/save?${p}`);
});

// Static SPA
if (fs.existsSync(PUBLIC_DIR)) {
  app.get('/manifest.webmanifest', (req, res) => {
    const m = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));
    m.name = APP_NAME; m.short_name = APP_NAME;
    res.set('Cache-Control', 'no-cache').type('application/manifest+json').send(JSON.stringify(m));
  });
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, p) => {
      if (p.endsWith('sw.js') || p.endsWith('index.html') || p.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
      // The service worker's own fetches follow the CSP it was served with; it caches article images from other sites.
      if (p.endsWith('sw.js')) res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' https: http:; img-src * data: blob:");
    },
  }));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    html = html.replace(/__APP_NAME__/g, APP_NAME);
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  });
}

app.use((err, req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`${APP_NAME} ${APP_VERSION} listening on :${PORT}`);
  cleanupAuth();
  setInterval(cleanupAuth, 6 * 3600000).unref();
  initTts();
  initImages();
  resumePendingFetches();
  startFeedScheduler();
  // "Archive articles left in the queue for N days" and "delete archived articles after N days" preferences: checked
  // shortly after start, then hourly.
  const tidy = () => {
    try { const n = archiveStale(); if (n) console.log(`auto-archived ${n} articles left in the queue`); } catch (e) { console.error('auto-archive failed', e.message); }
    try { const n = purgeArchived(); if (n) console.log(`deleted ${n} articles archived longer than their owners keep them`); } catch (e) { console.error('deleting old archived articles failed', e.message); }
  };
  setTimeout(tidy, 60000).unref();
  setInterval(tidy, 3600000).unref();
});
