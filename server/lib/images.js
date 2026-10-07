// Keeps a copy of each article's pictures on the server, so a saved article still shows them after the original
// page changes, disappears or goes behind a paywall. Pictures are downloaded through the same guarded fetcher as
// pages (nothing on the local network), recognised by their first bytes (JPEG, PNG, GIF, WebP and AVIF; never SVG)
// and stored as DATA_DIR/images/<article id>/<hash of the address>.<ext>. The article body then points at
// /api/articles/<id>/images/<file>, which only the article's owner can load. A picture that can't be downloaded
// keeps its original address.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, nowIso, IMAGES_DIR } from './db.js';
import { cfgBool } from './config.js';
import { fetchImage } from './fetcher.js';
import { parseSrcset, pictureKey } from './extract.js';
import { hooks, leadInContent } from './articles.js';

const MAX_PER_ARTICLE = Number(process.env.MAX_IMAGES_PER_ARTICLE || 60);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_MB || 8) * 1048576;
const MAX_ARTICLE_BYTES = Number(process.env.MAX_ARTICLE_IMAGES_MB || 60) * 1048576;
const TARGET_WIDTH = 1600; // widest srcset size kept: sharp on a 2x screen at the widest reading width
const DOWNLOADS = 4; // pictures fetched at once for one article
const ARTICLES = 2; // articles worked on at once

export const FILE_RE = /^[a-f0-9]{20}\.(jpg|png|gif|webp|avif)$/;
export const savingImages = () => cfgBool('save_images', true);
export const imageUrl = (articleId, file) => `/api/articles/${articleId}/images/${file}`;
const articleDir = (id) => path.join(IMAGES_DIR, String(id));
const fileStem = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 20);

// <img> tags as the sanitizer writes them: attribute values in double quotes, where a quoted value may contain ">".
const IMG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const LOCAL_RE = /\/api\/articles\/\d+\/images\/([a-f0-9]{20}\.\w+)/g;
const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return m ? unescape(m[1]) : null;
}
const isRemote = (u) => /^https?:\/\//i.test(u || '');

// The one picture to keep for an <img>: the largest srcset size up to TARGET_WIDTH (or the 2x one), else src.
export function pickSource(src, srcset) {
  const cands = parseSrcset(srcset).filter((c) => isRemote(c.url));
  const widths = cands.map((c) => ({ url: c.url, w: Number(/^(\d+)w$/.exec(c.desc)?.[1]) })).filter((c) => c.w > 0).sort((a, b) => a.w - b.w);
  if (widths.length) {
    const fit = widths.filter((c) => c.w <= TARGET_WIDTH).pop() || widths[0];
    // A tiny best fit next to a plain src: the src is usually the full-size picture.
    if (fit.w < 500 && isRemote(src) && !widths.some((c) => c.url === src)) return src;
    return fit.url;
  }
  const dens = cands.map((c) => ({ url: c.url, x: Number(/^([\d.]+)x$/.exec(c.desc)?.[1]) || (c.desc ? 0 : 1) })).filter((c) => c.x > 0 && c.x <= 2).sort((a, b) => a.x - b.x);
  if (dens.length && (dens.at(-1).x > 1 || !isRemote(src))) return dens.at(-1).url;
  return isRemote(src) ? src : cands[0]?.url || null;
}

function localTag(tag, url) {
  let out = tag.replace(/\s(?:srcset|sizes)="[^"]*"/gi, '');
  out = /\ssrc="[^"]*"/i.test(out) ? out.replace(/\ssrc="[^"]*"/i, ` src="${url}"`) : out.replace(/^<img\b/i, `<img src="${url}"`);
  return out;
}

// One more try after a moment for failures that may pass (timeouts, rate limits, server errors).
async function fetchWithRetry(url, opts) {
  try {
    return await fetchImage(url, opts);
  } catch (e) {
    const lasting = (e.status && e.status < 500 && e.status !== 429) || /picture|larger than|private network|blocked/i.test(e.message);
    if (lasting) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    return fetchImage(url, opts);
  }
}

async function eachLimited(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Download an article's pictures and point its body at the copies. Safe to run again: pictures already saved are
// reused, and if the article's content changes meanwhile the result is dropped (the change queues its own run).
async function saveImages(id) {
  if (!savingImages()) return;
  const a = db.prepare('SELECT id, content_html, lead_image, lead_in_content, final_url, url, fetch_status FROM articles WHERE id = ?').get(id);
  if (!a || a.fetch_status !== 'ok') return;
  const html = a.content_html || '';
  const tags = [...html.matchAll(IMG_RE)].map((m) => {
    const src = attr(m[0], 'src');
    const srcset = attr(m[0], 'srcset');
    return { src, pick: pickSource(src, srcset), all: [src, ...parseSrcset(srcset).map((c) => c.url)].filter(Boolean) };
  });
  const wanted = [...new Set(tags.map((t) => t.pick).filter(Boolean))];
  // The lead picture reuses the body's copy when the body shows the same picture (at any size).
  let leadUrl = isRemote(a.lead_image) ? a.lead_image : null;
  if (leadUrl) {
    const key = pictureKey(leadUrl);
    const same = tags.find((t) => t.pick && (t.all.includes(leadUrl) || (key && t.all.some((u) => pictureKey(u) === key))));
    if (same) leadUrl = same.pick; else wanted.push(leadUrl);
  }
  // Past the per-article limit the rest keep their original addresses; the lead picture is always among the saved.
  if (wanted.length > MAX_PER_ARTICLE) {
    const at = leadUrl ? wanted.indexOf(leadUrl) : -1;
    if (at >= MAX_PER_ARTICLE) { wanted.splice(at, 1); wanted.splice(MAX_PER_ARTICLE - 1, 0, leadUrl); }
    wanted.length = MAX_PER_ARTICLE;
  }

  const dir = articleDir(id);
  const known = new Map(db.prepare('SELECT url, file, bytes FROM article_images WHERE article_id = ?').all(id).map((r) => [r.url, r]));
  const saved = new Map(); // address -> file
  const record = db.prepare(`INSERT INTO article_images (article_id, url, file, bytes, error, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(article_id, url) DO UPDATE SET file = excluded.file, bytes = excluded.bytes, error = excluded.error, created_at = excluded.created_at`);
  let budget = MAX_ARTICLE_BYTES;
  const referer = a.final_url || a.url || undefined;
  await eachLimited(wanted, DOWNLOADS, async (url) => {
    const k = known.get(url);
    if (k?.file && fs.existsSync(path.join(dir, k.file))) { saved.set(url, k.file); budget -= k.bytes; return; }
    if (budget <= 0) { record.run(id, url, null, 0, 'Over the size limit for one article', nowIso()); return; }
    try {
      const img = await fetchWithRetry(url, { referer, maxBytes: Math.min(MAX_IMAGE_BYTES, budget) });
      budget -= img.buf.length;
      const file = `${fileStem(url)}.${img.ext}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${file}.part`), img.buf);
      fs.renameSync(path.join(dir, `${file}.part`), path.join(dir, file));
      record.run(id, url, file, img.buf.length, null, nowIso());
      saved.set(url, file);
    } catch (e) {
      record.run(id, url, null, 0, String(e.message || e).slice(0, 200), nowIso());
    }
  });

  const body = html.replace(IMG_RE, (tag) => {
    const pick = pickSource(attr(tag, 'src'), attr(tag, 'srcset'));
    const file = pick && saved.get(pick);
    return file ? localTag(tag, imageUrl(id, file)) : tag;
  });
  const leadFile = (leadUrl && saved.get(leadUrl)) || null;
  // Worked out on the original addresses: the rewritten ones can't be compared with the lead picture's.
  const leadIn = a.lead_in_content ?? (leadInContent(a.lead_image, html) ? 1 : 0);
  const info = db.prepare(`UPDATE articles SET content_html = ?, lead_image_file = ?, lead_in_content = ?, images_at = ?
    WHERE id = ? AND content_html = ? AND COALESCE(lead_image, '') = ?`).run(body, leadFile, leadIn, nowIso(), id, html, a.lead_image || '');
  if (!info.changes) return;
  pruneFiles(id, body, leadFile, new Set(wanted));
}

// Remove pictures the article no longer uses (after a refetch). Failures are kept while the article still shows the
// picture from its site, as a record of why.
function pruneFiles(id, body, leadFile, wanted) {
  const used = new Set([...body.matchAll(LOCAL_RE)].map((m) => m[1]));
  if (leadFile) used.add(leadFile);
  for (const r of db.prepare('SELECT url, file FROM article_images WHERE article_id = ?').all(id)) {
    if (r.file ? !used.has(r.file) : !wanted.has(r.url)) db.prepare('DELETE FROM article_images WHERE article_id = ? AND url = ?').run(id, r.url);
  }
  const dir = articleDir(id);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) if (!used.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  if (!used.size) fs.rmSync(dir, { recursive: true, force: true });
}

// ----- queue: newly fetched articles first, older ones (backfill) behind them -----
const queue = [];
const running = new Set();
const again = new Set(); // content changed while its pictures were being saved: run once more afterwards
let active = 0;

export function queueImages(id, { first = true } = {}) {
  if (running.has(id)) { again.add(id); return; }
  const at = queue.indexOf(id);
  if (at !== -1) { if (!first) return; queue.splice(at, 1); }
  if (first) queue.unshift(id); else queue.push(id);
  pump();
}
function pump() {
  while (active < ARTICLES && queue.length) {
    const id = queue.shift();
    active++;
    running.add(id);
    saveImages(id).catch((e) => console.error('saving images failed', id, e.message)).finally(() => {
      active--;
      running.delete(id);
      if (again.delete(id)) queue.unshift(id);
      pump();
    });
  }
}
export const imagesQueued = () => queue.length + active;

// Articles saved before this feature (or while it was off) get their pictures saved in the background.
export function backfillImages() {
  if (!savingImages()) return 0;
  db.prepare("UPDATE articles SET images_at = ? WHERE images_at IS NULL AND fetch_status = 'ok' AND lead_image IS NULL AND content_html NOT LIKE '%<img%'").run(nowIso());
  const ids = db.prepare("SELECT id FROM articles WHERE images_at IS NULL AND fetch_status = 'ok' ORDER BY id DESC").all().map((r) => r.id);
  for (const id of ids) queueImages(id, { first: false });
  return ids.length;
}

export function imageFile(articleId, file) {
  if (!FILE_RE.test(String(file))) return null;
  const p = path.join(articleDir(articleId), file);
  return fs.existsSync(p) ? p : null;
}

export function deleteArticleImages(articleId) {
  fs.rmSync(articleDir(articleId), { recursive: true, force: true });
}

// For exports: the body with the original picture addresses back in place of the saved copies.
export function originalImageHtml(articleId, html) {
  const byFile = new Map(db.prepare('SELECT url, file FROM article_images WHERE article_id = ? AND file IS NOT NULL').all(articleId).map((r) => [r.file, r.url]));
  return String(html || '').replace(LOCAL_RE, (m, file) => (byFile.has(file) ? byFile.get(file).replace(/&/g, '&amp;').replace(/"/g, '&quot;') : m));
}

export function imageUsage() {
  const r = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes, COUNT(DISTINCT article_id) AS articles FROM article_images WHERE file IS NOT NULL').get();
  const failed = db.prepare('SELECT COUNT(*) AS n FROM article_images WHERE file IS NULL').get().n;
  return { files: r.files, bytes: r.bytes, articles: r.articles, failed, queued: imagesQueued(), enabled: savingImages() };
}

// Startup: clear folders of deleted articles and half-written files, then save pictures for older articles.
export function initImages() {
  hooks.contentChanged = (id) => queueImages(id);
  hooks.deleteFiles.push(deleteArticleImages);
  const live = new Set(db.prepare('SELECT id FROM articles').all().map((r) => String(r.id)));
  for (const name of fs.readdirSync(IMAGES_DIR)) {
    const p = path.join(IMAGES_DIR, name);
    if (!live.has(name)) { fs.rmSync(p, { recursive: true, force: true }); continue; }
    try { for (const f of fs.readdirSync(p)) if (f.endsWith('.part')) fs.rmSync(path.join(p, f), { force: true }); } catch { /* not a folder */ }
  }
  setTimeout(() => { try { backfillImages(); } catch (e) { console.error('image backfill failed', e.message); } }, 20000).unref();
}
