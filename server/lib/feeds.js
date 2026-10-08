// Followed sites and feeds: new entries of an RSS or Atom feed are saved to the follower's queue. Feeds are checked
// every FEED_INTERVAL_MINUTES (conditional requests, so unchanged feeds cost a 304). The first check saves only the
// newest few entries and remembers the rest as seen; a link already saved is never touched (a feed must not bring an
// archived article back).
import { JSDOM, VirtualConsole } from 'jsdom';
import { db, nowIso } from './db.js';
import { fetchFeed, parseHttpUrl } from './fetcher.js';
import { createArticle, normalizeTag } from './articles.js';

const INTERVAL_MS = Math.max(5, Number(process.env.FEED_INTERVAL_MINUTES) || 60) * 60000;
const FIRST_IMPORT = 3; // entries saved by the first check
const MAX_PER_CHECK = 20; // entries saved by one later check
const KEEP_SEEN = 500; // remembered entries per feed
const MAX_FEEDS = 200;
const quiet = new VirtualConsole();
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ----- reading feeds -----
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const byName = (parent, name) => [...parent.getElementsByTagNameNS('*', name)];
const first = (parent, ...names) => {
  for (const n of names) { const el = byName(parent, n)[0]; if (el) return el; }
  return null;
};
function absolute(href, base) {
  try { const u = new URL(href, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}
function isoDate(v) {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

// { title, siteUrl, items: [{ guid, link, title, publishedAt }] } for RSS 2.0, RSS 1.0 (RDF) and Atom; null when the
// document isn't a feed.
export function parseFeed(body, baseUrl) {
  // Feeds are XML, but many use HTML entities (&nbsp;) or stray ampersands that XML rejects.
  const xml = String(body).replace(/^﻿/, '').trim().replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
  if (!/^<(\?xml|rss|feed|rdf:RDF)\b/i.test(xml.replace(/^(<!--[\s\S]*?-->\s*)+/, ''))) return null;
  let doc;
  try { doc = new JSDOM(xml, { contentType: 'text/xml', virtualConsole: quiet }).window.document; } catch { return null; }
  const root = doc.documentElement;
  const kind = root.localName.toLowerCase();
  if (kind === 'feed') {
    const link = (el) => {
      const links = byName(el, 'link').filter((l) => l.parentNode === el);
      const alt = links.find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate') || links[0];
      return alt ? absolute(alt.getAttribute('href'), baseUrl) : null;
    };
    const items = byName(root, 'entry').map((e) => {
      const href = link(e);
      return { guid: text(first(e, 'id')) || href, link: href, title: text(first(e, 'title')), publishedAt: isoDate(text(first(e, 'published', 'updated'))) };
    });
    return { title: text(byName(root, 'title').find((t) => t.parentNode === root)), siteUrl: link(root), items };
  }
  if (kind === 'rss' || kind === 'rdf') {
    const channel = first(root, 'channel');
    const items = byName(root, 'item').map((it) => {
      const href = absolute(text(first(it, 'link')) || it.getAttribute('rdf:about') || '', baseUrl);
      const guidEl = first(it, 'guid');
      // A guid marked as a permalink is the address when <link> is missing.
      const guidLink = guidEl && guidEl.getAttribute('isPermaLink') !== 'false' ? absolute(text(guidEl), baseUrl) : null;
      return { guid: text(guidEl) || href || guidLink, link: href || guidLink, title: text(first(it, 'title')), publishedAt: isoDate(text(first(it, 'pubDate', 'date', 'published'))) };
    });
    const chanLink = channel ? byName(channel, 'link').find((l) => l.parentNode === channel && !l.getAttribute('href')) : null;
    return { title: channel ? text(byName(channel, 'title').find((t) => t.parentNode === channel)) : '', siteUrl: absolute(text(chanLink), baseUrl), items };
  }
  return null;
}

// Feed addresses a web page advertises: <link rel="alternate" type="application/rss+xml" href="…">.
function feedLinks(html, baseUrl) {
  const out = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?[^"'>]*alternate/i.test(tag) || !/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const abs = href && absolute(href.replace(/&amp;/g, '&'), baseUrl);
    if (abs) out.push(abs);
  }
  return out;
}

// Finds the feed for an address: the address itself, a feed the page links to, or the usual /feed and /rss.xml.
export async function discoverFeed(input) {
  const start = parseHttpUrl(input).href;
  const tried = new Set();
  const load = async (url) => {
    tried.add(url);
    const r = await fetchFeed(url);
    return { ...r, feed: parseFeed(r.body, r.finalUrl) };
  };
  const page = await load(start);
  if (page.feed) return { url: page.finalUrl, ...page };
  const candidates = feedLinks(page.body, page.finalUrl);
  const origin = new URL(page.finalUrl).origin;
  candidates.push(`${origin}/feed`, `${origin}/rss.xml`);
  for (const url of candidates.slice(0, 4)) {
    if (tried.has(url)) continue;
    try {
      const r = await load(url);
      if (r.feed) return { url: r.finalUrl, ...r };
    } catch { /* try the next one */ }
  }
  throw bad('No RSS or Atom feed was found at that address. Paste the feed\'s own address instead.');
}

// ----- feeds -----
export function serializeFeed(f) {
  let tags = [];
  try { tags = JSON.parse(f.tags || '[]'); } catch { /* none */ }
  const saved = db.prepare('SELECT COUNT(*) AS n FROM feed_items WHERE feed_id = ? AND article_id IS NOT NULL').get(f.id).n;
  return {
    id: f.id, url: f.url, title: f.title || f.url, siteUrl: f.site_url, tags, active: !!f.active, saved,
    lastCheckedAt: f.last_checked_at, lastSuccessAt: f.last_success_at, lastError: f.last_error, createdAt: f.created_at,
  };
}
export function listFeeds(userId) {
  return db.prepare('SELECT * FROM feeds WHERE user_id = ? ORDER BY title COLLATE NOCASE, url').all(userId).map(serializeFeed);
}
const cleanTags = (tags) => [...new Set((Array.isArray(tags) ? tags : String(tags || '').split(',')).map(normalizeTag).filter(Boolean))].slice(0, 10);
const getFeed = (userId, id) => db.prepare('SELECT * FROM feeds WHERE id = ? AND user_id = ?').get(Number(id), userId);

export async function addFeed(userId, { url, tags }) {
  if (db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE user_id = ?').get(userId).n >= MAX_FEEDS) throw bad(`You can follow up to ${MAX_FEEDS} feeds`);
  if (!String(url || '').trim()) throw bad('Enter a site or feed address');
  const raw = /^https?:\/\//i.test(String(url).trim()) ? String(url).trim() : `https://${String(url).trim()}`;
  const found = await discoverFeed(raw);
  if (db.prepare('SELECT 1 FROM feeds WHERE user_id = ? AND url = ?').get(userId, found.url)) throw bad('You already follow that feed', 409);
  const info = db.prepare('INSERT INTO feeds (user_id, url, title, site_url, tags) VALUES (?, ?, ?, ?, ?)').run(
    userId, found.url, (found.feed.title || '').slice(0, 200), found.feed.siteUrl, JSON.stringify(cleanTags(tags)),
  );
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(info.lastInsertRowid);
  const added = await saveEntries(feed, found.feed, { etag: found.etag, lastModified: found.lastModified });
  return { feed: serializeFeed(db.prepare('SELECT * FROM feeds WHERE id = ?').get(feed.id)), added };
}

export function updateFeed(userId, id, { title, tags, active }) {
  const f = getFeed(userId, id);
  if (!f) throw bad('Feed not found', 404);
  if (typeof title === 'string' && title.trim()) db.prepare('UPDATE feeds SET title = ? WHERE id = ?').run(title.trim().slice(0, 200), f.id);
  if (tags !== undefined) db.prepare('UPDATE feeds SET tags = ? WHERE id = ?').run(JSON.stringify(cleanTags(tags)), f.id);
  if (active !== undefined) db.prepare('UPDATE feeds SET active = ? WHERE id = ?').run(active ? 1 : 0, f.id);
  return serializeFeed(db.prepare('SELECT * FROM feeds WHERE id = ?').get(f.id));
}

// Unfollowing keeps the articles already saved from the feed.
export function deleteFeed(userId, id) {
  const f = getFeed(userId, id);
  if (!f) return false;
  db.prepare('UPDATE articles SET feed_id = NULL WHERE feed_id = ?').run(f.id);
  db.prepare('DELETE FROM feeds WHERE id = ?').run(f.id);
  return true;
}

// Saves the feed's new entries. Returns how many articles were added.
async function saveEntries(feed, parsed, { etag, lastModified }) {
  const firstCheck = !db.prepare('SELECT 1 FROM feed_items WHERE feed_id = ? LIMIT 1').get(feed.id);
  const seen = db.prepare('SELECT 1 FROM feed_items WHERE feed_id = ? AND guid = ?');
  const entries = parsed.items.filter((i) => i.link && i.guid).map((i) => ({ ...i, guid: i.guid.slice(0, 500) }));
  const fresh = [];
  for (const e of entries.slice(0, 100)) if (!seen.get(feed.id, e.guid) && !fresh.some((x) => x.guid === e.guid)) fresh.push(e);
  // Newest first, as feeds list them (by date where there are dates).
  fresh.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  const toSave = fresh.slice(0, firstCheck ? FIRST_IMPORT : MAX_PER_CHECK);
  let tags = [];
  try { tags = JSON.parse(feed.tags || '[]'); } catch { /* none */ }
  const remember = db.prepare('INSERT OR IGNORE INTO feed_items (feed_id, guid, link, published_at, article_id) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  // Oldest of the batch first, so the newest ends up at the top of the queue.
  for (const e of [...toSave].reverse()) {
    let articleId = null;
    try {
      const r = await createArticle(feed.user_id, { url: e.link, title: e.title, tags, feedId: feed.id, keepExisting: true });
      if (!r.duplicate) { articleId = r.article.id; added++; }
    } catch { /* a bad link in the feed: remember it and move on */ }
    remember.run(feed.id, e.guid, e.link, e.publishedAt, articleId);
  }
  for (const e of fresh.slice(toSave.length)) remember.run(feed.id, e.guid, e.link, e.publishedAt, null);
  db.prepare(`DELETE FROM feed_items WHERE feed_id = ? AND rowid NOT IN (SELECT rowid FROM feed_items WHERE feed_id = ? ORDER BY created_at DESC LIMIT ${KEEP_SEEN})`).run(feed.id, feed.id);
  db.prepare(`UPDATE feeds SET etag = ?, last_modified = ?, last_checked_at = ?, last_success_at = ?, last_error = NULL,
    title = CASE WHEN title = '' THEN ? ELSE title END, site_url = COALESCE(?, site_url) WHERE id = ?`).run(
    etag || null, lastModified || null, nowIso(), nowIso(), (parsed.title || '').slice(0, 200), parsed.siteUrl || null, feed.id,
  );
  return added;
}

const checking = new Set();
export async function checkFeed(feed) {
  if (checking.has(feed.id)) return 0;
  checking.add(feed.id);
  try {
    const r = await fetchFeed(feed.url, { etag: feed.etag, lastModified: feed.last_modified });
    if (r.notModified) {
      db.prepare('UPDATE feeds SET last_checked_at = ?, last_success_at = ?, last_error = NULL WHERE id = ?').run(nowIso(), nowIso(), feed.id);
      return 0;
    }
    const parsed = parseFeed(r.body, r.finalUrl);
    if (!parsed) throw new Error('The address no longer serves an RSS or Atom feed');
    return await saveEntries(feed, parsed, r);
  } catch (e) {
    db.prepare('UPDATE feeds SET last_checked_at = ?, last_error = ? WHERE id = ?').run(nowIso(), String(e.message || e).slice(0, 300), feed.id);
    return 0;
  } finally {
    checking.delete(feed.id);
  }
}
export async function checkFeedNow(userId, id) {
  const f = getFeed(userId, id);
  if (!f) throw bad('Feed not found', 404);
  const added = await checkFeed(f);
  return { feed: serializeFeed(db.prepare('SELECT * FROM feeds WHERE id = ?').get(f.id)), added };
}

// Checks the feeds that are due, two at a time, every few minutes.
async function checkDue() {
  const cutoff = new Date(Date.now() - INTERVAL_MS).toISOString();
  const due = db.prepare(`SELECT f.* FROM feeds f JOIN users u ON u.id = f.user_id WHERE f.active = 1 AND u.disabled = 0
    AND (f.last_checked_at IS NULL OR f.last_checked_at < ?) ORDER BY f.last_checked_at`).all(cutoff);
  let i = 0;
  await Promise.all([0, 1].map(async () => { while (i < due.length) await checkFeed(due[i++]); }));
}
export function startFeedScheduler() {
  const run = () => checkDue().catch((e) => console.error('feed check failed', e.message));
  setTimeout(run, 45000).unref();
  setInterval(run, 5 * 60000).unref();
}
