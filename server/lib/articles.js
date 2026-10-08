// Saved articles: creation, the background fetch queue, serialization and tags.
import crypto from 'node:crypto';
import { db, nowIso, tx } from './db.js';
import { fetchPage, cleanUrl, urlKey, parseHttpUrl } from './fetcher.js';
import { extractHtml, extractText, extractSupplied } from './extractPool.js';
import { userPrefs } from './auth.js';

const FETCH_CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 3);
// Set by tts.js (auto-prepared audio, stale audio cleanup, audio removal on archive) and images.js (saving pictures
// when content changes) so those modules and this one don't import each other. deleteFiles: each removes an
// article's files (audio, saved pictures) before the article is deleted.
export const hooks = { afterFill: null, dropStaleAudio: null, contentChanged: null, onArchived: null, deleteFiles: [] };
// afterFill runs in the background: its failures are logged, never thrown at the caller or left unhandled (an
// unhandled rejection would stop the server).
function runAfterFill(id) {
  Promise.resolve().then(() => hooks.afterFill?.(id)).catch((e) => console.error('auto audio failed', id, e));
}

const SUMMARY_COLS = `a.id, a.user_id, a.url, a.final_url, a.title, a.byline, a.site_name, a.excerpt, a.lead_image, a.lead_image_file, a.published_at, a.lang,
  a.word_count, a.reading_minutes, a.fetch_status, a.fetch_error, a.source, a.starred, a.archived, a.progress, a.listen_seg,
  a.created_at, a.updated_at, a.fetched_at, a.opened_at, a.archived_at`;

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function tagsFor(ids) {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT at.article_id, t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.name`).all(...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.article_id)) map.set(r.article_id, []);
    map.get(r.article_id).push(r.name);
  }
  return map;
}

export function serializeSummary(a, tags = []) {
  return {
    id: a.id,
    url: a.url,
    finalUrl: a.final_url,
    domain: domainOf(a.final_url || a.url),
    title: a.title || domainOf(a.url) || 'Untitled',
    byline: a.byline,
    siteName: a.site_name,
    excerpt: a.excerpt,
    // The saved copy when there is one (a path on this server that needs the same sign-in as the API).
    leadImage: a.lead_image_file ? `/api/articles/${a.id}/images/${a.lead_image_file}` : a.lead_image,
    leadImageOriginal: a.lead_image,
    publishedAt: a.published_at,
    lang: a.lang,
    wordCount: a.word_count,
    readingMinutes: a.reading_minutes,
    status: a.fetch_status,
    error: a.fetch_error,
    source: a.source,
    starred: !!a.starred,
    archived: !!a.archived,
    progress: a.progress,
    listenSeg: a.listen_seg,
    tags,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    fetchedAt: a.fetched_at,
    openedAt: a.opened_at,
    archivedAt: a.archived_at,
    ...(a.snippet != null ? { snippet: a.snippet } : {}),
  };
}

// "photo-1152x648.jpg", "photo-scaled.jpg" and "photo.jpg" are the same picture.
function imageStem(url) {
  const file = String(url || '').split(/[?#]/)[0].split('/').pop() || '';
  return file.replace(/\.(jpe?g|png|webp|gif|avif)$/i, '').replace(/([-_]\d{2,5}x\d{2,5}|[-_]scaled|[-_]\d{3,4}w?|@\dx)+$/i, '').toLowerCase();
}
// The reader shows the lead image above the text unless the article already shows it, or opens with a picture.
export function leadInContent(lead, html) {
  if (!lead) return false;
  const stem = imageStem(lead);
  const urls = [...html.matchAll(/(?:src|srcset)="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((p) => p.trim().split(/\s+/)[0]));
  if (stem.length > 3 && /[a-z]/.test(stem) && urls.some((u) => imageStem(u) === stem)) return true;
  const firstImg = html.indexOf('<img');
  const thirdSeg = html.indexOf('data-seg="3"');
  return firstImg !== -1 && (thirdSeg === -1 || firstImg < thirdSeg);
}

export function serializeFull(a) {
  const tags = tagsFor([a.id]).get(a.id) || [];
  let segments = [];
  try { segments = JSON.parse(a.segments_json || '[]'); } catch { /* keep empty */ }
  const feed = a.feed_id ? db.prepare('SELECT id, title, url FROM feeds WHERE id = ?').get(a.feed_id) : null;
  return {
    ...serializeSummary(a, tags),
    feed: feed ? { id: feed.id, title: feed.title || feed.url } : null,
    contentHtml: a.content_html,
    segments: segments.map((s) => s.t),
    contentHash: a.content_hash,
    leadInContent: a.lead_in_content != null ? !!a.lead_in_content : leadInContent(a.lead_image, a.content_html),
  };
}

export function getArticle(userId, id) {
  return db.prepare('SELECT * FROM articles WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

// ----- listing -----
const VIEWS = {
  queue: 'a.archived = 0',
  starred: 'a.starred = 1',
  archive: 'a.archived = 1',
  all: '1 = 1',
};
const SORTS = {
  newest: 'a.created_at DESC, a.id DESC',
  oldest: 'a.created_at ASC, a.id ASC',
  shortest: 'CASE WHEN a.word_count = 0 THEN 1 ELSE 0 END, a.word_count ASC, a.created_at DESC',
  longest: 'a.word_count DESC, a.created_at DESC',
  relevance: 'rank',
};

// Splits a search into tag filters and free text. "#travel" and #"long reads" filter by tag (all must match); the
// last tag is matched as a prefix while it is still being typed (nothing after it yet). Everything else is free text.
export function parseSearch(q) {
  const s = String(q || '');
  const re = /(^|\s)#(?:"([^"]*)"?|([^\s#"]+))/g;
  const found = [];
  let m;
  while ((m = re.exec(s))) found.push({ name: (m[2] ?? m[3] ?? '').trim().replace(/\s+/g, ' ').toLowerCase(), end: re.lastIndex, quoted: m[2] !== undefined });
  const tags = found.filter((t) => t.name).map((t) => ({ name: t.name, prefix: !t.quoted && t.end === s.length }));
  return { tags, text: s.replace(re, ' ').replace(/\s+/g, ' ').trim() };
}

const likeEscape = (v) => v.replace(/[\\%_]/g, '\\$&');

// Turns free text into a safe FTS5 query: each word quoted, the last one as a prefix.
export function ftsQuery(q) {
  const words = String(q || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  if (!words.length) return null;
  return words.slice(0, 12).map((w, i, all) => `"${w.replace(/"/g, '')}"${i === all.length - 1 ? '*' : ''}`).join(' ');
}

export function listArticles(userId, { view = 'queue', q = '', tag = '', sort = 'newest', limit = 50, offset = 0, domain = '' } = {}) {
  const where = ['a.user_id = ?', VIEWS[view] || VIEWS.queue];
  const params = [userId];
  let from = 'articles a';
  let snippetCol = '';
  const search = parseSearch(q);
  const fq = ftsQuery(search.text);
  for (const t of search.tags) {
    where.push(t.prefix
      ? "EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND t.name LIKE ? ESCAPE '\\')"
      : 'EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND t.name = ? COLLATE NOCASE)');
    params.push(t.prefix ? `${likeEscape(t.name)}%` : t.name);
  }
  if (fq) {
    from = 'articles_fts f JOIN articles a ON a.id = f.rowid';
    where.push('articles_fts MATCH ?');
    params.push(fq);
    snippetCol = ", snippet(articles_fts, 3, char(2), char(3), '…', 14) AS snippet";
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND t.name = ? COLLATE NOCASE)');
    params.push(String(tag));
  }
  if (domain) {
    where.push("(REPLACE(LOWER(COALESCE(a.final_url, a.url)), 'www.', '') LIKE ?)");
    params.push(`%://${String(domain).toLowerCase().replace(/^www\./, '')}/%`);
  }
  const order = sort === 'relevance' && !fq ? SORTS.newest : SORTS[sort] || SORTS.newest;
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const rows = db.prepare(`SELECT ${SUMMARY_COLS}${snippetCol} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, lim, off);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where.join(' AND ')}`).get(...params).n;
  const tags = tagsFor(rows.map((r) => r.id));
  return { items: rows.map((r) => serializeSummary(r, tags.get(r.id) || [])), total, limit: lim, offset: off };
}

export function counts(userId) {
  const r = db.prepare(`SELECT COUNT(*) AS all_n, COALESCE(SUM(archived = 0), 0) AS queue, COALESCE(SUM(starred = 1), 0) AS starred, COALESCE(SUM(archived = 1), 0) AS archive,
    COALESCE(SUM(archived = 0 AND fetch_status = 'pending'), 0) AS pending FROM articles WHERE user_id = ?`).get(userId);
  return { queue: r.queue, starred: r.starred, archive: r.archive, all: r.all_n, pending: r.pending };
}

// ----- tags -----
export function setTags(userId, articleId, names) {
  const clean = [...new Set((names || []).map(normalizeTag).filter(Boolean))].slice(0, 20);
  tx(() => {
    db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(articleId);
    for (const name of clean) {
      db.prepare('INSERT INTO tags (user_id, name) VALUES (?, ?) ON CONFLICT(user_id, name) DO NOTHING').run(userId, name);
      const tag = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, name);
      db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)').run(articleId, tag.id);
    }
    db.prepare('DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM article_tags)').run(userId);
    refreshTagsText([articleId]);
  });
}

// articles.tags_text mirrors an article's tag names so the search index covers them.
export function refreshTagsText(articleIds) {
  const stmt = db.prepare(`UPDATE articles SET tags_text = COALESCE((SELECT group_concat(name, ' ') FROM (SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = articles.id ORDER BY t.name)), '') WHERE id = ?`);
  for (const id of articleIds) stmt.run(id);
}

export const normalizeTag = (name) => String(name || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40).toLowerCase();

// Rename a tag; renaming onto an existing tag merges the two.
export function renameTag(userId, tagId, newName) {
  const name = normalizeTag(newName);
  if (!name) throw Object.assign(new Error('Name is required'), { status: 400 });
  const tag = db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(Number(tagId), userId);
  if (!tag) throw Object.assign(new Error('Tag not found'), { status: 404 });
  tx(() => {
    const ids = db.prepare('SELECT article_id FROM article_tags WHERE tag_id = ?').all(tag.id).map((r) => r.article_id);
    const clash = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ? AND id != ?').get(userId, name, tag.id);
    if (clash) {
      db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) SELECT article_id, ? FROM article_tags WHERE tag_id = ?').run(clash.id, tag.id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    } else db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, tag.id);
    refreshTagsText(ids);
  });
  return listTags(userId);
}

export function deleteTag(userId, tagId) {
  const tag = db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(Number(tagId), userId);
  if (!tag) return false;
  tx(() => {
    const ids = db.prepare('SELECT article_id FROM article_tags WHERE tag_id = ?').all(tag.id).map((r) => r.article_id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    refreshTagsText(ids);
  });
  return true;
}

export function listTags(userId) {
  return db.prepare('SELECT t.id, t.name, COUNT(at.article_id) AS count FROM tags t LEFT JOIN article_tags at ON at.tag_id = t.id WHERE t.user_id = ? GROUP BY t.id ORDER BY t.name').all(userId)
    .map((t) => ({ id: t.id, name: t.name, count: t.count }));
}

// ----- auto-tag rules -----
// "site" rules match the article's domain and its subdomains; "title" and "text" rules match whole words, ignoring
// case ("text" covers the title too). Rules only ever add tags.
export const RULE_KINDS = ['site', 'title', 'text'];
const MAX_RULES = 200;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function serializeRule(r) {
  return { id: r.id, kind: r.kind, pattern: r.pattern, tag: r.tag, createdAt: r.created_at };
}
export function listRules(userId) {
  return db.prepare("SELECT * FROM tag_rules WHERE user_id = ? ORDER BY CASE kind WHEN 'site' THEN 0 WHEN 'title' THEN 1 ELSE 2 END, pattern COLLATE NOCASE, tag").all(userId).map(serializeRule);
}
function cleanRule({ kind, pattern, tag }) {
  if (!RULE_KINDS.includes(kind)) throw bad('A rule matches the site, the title or the text');
  let p = String(pattern ?? '').replace(/\s+/g, ' ').trim();
  if (kind === 'site') {
    p = p.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#:]/)[0].replace(/^www\./, '').replace(/\.+$/, '');
    if (!/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*$/u.test(p)) throw bad('Enter a site such as foxnews.com');
  } else if (!/[\p{L}\p{N}]/u.test(p)) throw bad('Enter a word or phrase to look for');
  if (p.length > 100) throw bad('Keep the pattern under 100 characters');
  const t = normalizeTag(tag);
  if (!t) throw bad('Enter the tag to add');
  return { kind, pattern: p, tag: t };
}
function saveRule(fn) {
  try { return fn(); } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw bad('That rule already exists', 409);
    throw e;
  }
}
export function addRule(userId, body) {
  const r = cleanRule(body || {});
  if (db.prepare('SELECT COUNT(*) AS n FROM tag_rules WHERE user_id = ?').get(userId).n >= MAX_RULES) throw bad(`You can keep up to ${MAX_RULES} rules`);
  const info = saveRule(() => db.prepare('INSERT INTO tag_rules (user_id, kind, pattern, tag) VALUES (?, ?, ?, ?)').run(userId, r.kind, r.pattern, r.tag));
  return serializeRule(db.prepare('SELECT * FROM tag_rules WHERE id = ?').get(info.lastInsertRowid));
}
export function updateRule(userId, id, body) {
  const cur = db.prepare('SELECT * FROM tag_rules WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!cur) throw bad('Rule not found', 404);
  const r = cleanRule({ kind: body?.kind ?? cur.kind, pattern: body?.pattern ?? cur.pattern, tag: body?.tag ?? cur.tag });
  saveRule(() => db.prepare('UPDATE tag_rules SET kind = ?, pattern = ?, tag = ? WHERE id = ?').run(r.kind, r.pattern, r.tag, cur.id));
  return serializeRule(db.prepare('SELECT * FROM tag_rules WHERE id = ?').get(cur.id));
}
export function deleteRule(userId, id) {
  return db.prepare('DELETE FROM tag_rules WHERE id = ? AND user_id = ?').run(Number(id), userId).changes > 0;
}

const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (phrase) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(phrase).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'iu');
export function rulesTagsFor(userId, a, rules = db.prepare('SELECT * FROM tag_rules WHERE user_id = ?').all(userId)) {
  if (!rules.length) return [];
  const host = domainOf(a.final_url || a.url || '').toLowerCase();
  const title = a.title || '';
  const text = `${title}\n${a.text_content || ''}`;
  const out = new Set();
  for (const r of rules) {
    const hit = r.kind === 'site' ? host === r.pattern || host.endsWith(`.${r.pattern}`) : wordRe(r.pattern).test(r.kind === 'title' ? title : text);
    if (hit) out.add(r.tag);
  }
  return [...out];
}
// Adds the tags an article's rules call for. Returns whether anything was added.
export function applyTagRules(articleId, rules) {
  const a = db.prepare('SELECT id, user_id, url, final_url, title, text_content FROM articles WHERE id = ?').get(articleId);
  if (!a) return false;
  const add = rulesTagsFor(a.user_id, a, rules);
  if (!add.length) return false;
  const cur = tagsFor([a.id]).get(a.id) || [];
  const next = [...new Set([...cur, ...add])];
  if (next.length === cur.length) return false;
  setTags(a.user_id, a.id, next);
  return true;
}
export function applyRulesToAll(userId) {
  const rules = db.prepare('SELECT * FROM tag_rules WHERE user_id = ?').all(userId);
  if (!rules.length) return 0;
  let n = 0;
  for (const r of db.prepare("SELECT id FROM articles WHERE user_id = ? AND fetch_status = 'ok'").all(userId)) if (applyTagRules(r.id, rules)) n++;
  return n;
}

// ----- public share links -----
// A shared article can be read by anyone with its /s/<token> link (see routes/public.js) until sharing stops.
export function shareArticle(userId, id) {
  const a = getArticle(userId, id);
  if (!a) return null;
  if (!a.share_token) db.prepare('UPDATE articles SET share_token = ?, share_created_at = ?, share_views = 0 WHERE id = ?').run(crypto.randomBytes(24).toString('base64url'), nowIso(), a.id);
  return getArticle(userId, id);
}
export function unshareArticle(userId, id) {
  return db.prepare('UPDATE articles SET share_token = NULL, share_created_at = NULL, share_views = 0 WHERE id = ? AND user_id = ? AND share_token IS NOT NULL').run(Number(id), userId).changes > 0;
}
// The article behind a share link, unless sharing stopped or its owner's account is disabled.
export function sharedArticle(token) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(String(token))) return null;
  return db.prepare('SELECT a.* FROM articles a JOIN users u ON u.id = a.user_id WHERE a.share_token = ? AND u.disabled = 0').get(token) || null;
}
export function listShares(userId) {
  return db.prepare('SELECT id, title, url, final_url, share_token, share_created_at, share_views FROM articles WHERE user_id = ? AND share_token IS NOT NULL ORDER BY share_created_at DESC').all(userId);
}

// ----- creating and filling articles -----
function applyExtraction(id, ex, extra = {}) {
  const firstFill = !db.prepare('SELECT fetched_at FROM articles WHERE id = ?').get(id)?.fetched_at;
  db.prepare(`UPDATE articles SET title = ?, byline = ?, site_name = ?, excerpt = ?, lead_image = ?, published_at = ?, lang = ?, content_html = ?, text_content = ?,
    segments_json = ?, content_hash = ?, word_count = ?, reading_minutes = ?, fetch_status = 'ok', fetch_error = NULL, fetched_at = ?, updated_at = ?,
    final_url = COALESCE(?, final_url), source = COALESCE(?, source), lead_image_file = NULL, lead_in_content = NULL, images_at = NULL WHERE id = ?`).run(
    ex.title, ex.byline, ex.siteName, ex.excerpt, ex.leadImage, ex.publishedAt, ex.lang, ex.contentHtml, ex.textContent,
    JSON.stringify(ex.segments), ex.contentHash, ex.wordCount, ex.readingMinutes, nowIso(), nowIso(),
    extra.finalUrl || null, extra.source || null, id,
  );
  // Audio made from older text no longer matches; drop it. The new body's pictures are saved in the background.
  hooks.dropStaleAudio?.(id, ex.contentHash);
  hooks.contentChanged?.(id);
  // Auto-tag rules run once, when an article first gets its text (fetching again doesn't bring back removed tags).
  if (firstFill) {
    try { applyTagRules(id); } catch (e) { console.error('tag rules failed', id, e.message); }
  }
}

// Renaming also changes what read aloud says first, so the spoken title (segment 0) follows.
export function renameArticle(id, title) {
  const a = db.prepare('SELECT segments_json FROM articles WHERE id = ?').get(id);
  let segments = [];
  try { segments = JSON.parse(a.segments_json || '[]'); } catch { /* keep empty */ }
  if (segments.length) {
    segments[0] = { t: title, h: 1 };
    const hash = crypto.createHash('sha1').update(JSON.stringify(segments)).digest('hex');
    db.prepare('UPDATE articles SET title = ?, segments_json = ?, content_hash = ?, updated_at = ? WHERE id = ?').run(title, JSON.stringify(segments), hash, nowIso(), id);
    hooks.dropStaleAudio?.(id, hash);
  } else db.prepare('UPDATE articles SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), id);
}

export function findDuplicate(userId, url) {
  return db.prepare('SELECT * FROM articles WHERE user_id = ? AND url_key = ?').get(userId, urlKey(url));
}

// Creates an article. With text/html supplied it is filled immediately; otherwise the page is fetched in the background.
// feedId: saved from a followed feed. keepExisting: a link already saved is left exactly as it is (a feed must not
// bring an archived article back to the queue).
export async function createArticle(userId, { url, title, text, html, tags, feedId = null, keepExisting = false } = {}) {
  let clean = null;
  if (url) clean = cleanUrl(parseHttpUrl(url).href);
  if (clean) {
    const dup = findDuplicate(userId, clean);
    if (dup && keepExisting) return { article: dup, duplicate: true };
    if (dup) {
      // Saving again brings it back to the top of the queue.
      db.prepare('UPDATE articles SET archived = 0, archived_at = NULL, created_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), dup.id);
      if (tags?.length) setTags(userId, dup.id, [...new Set([...(tagsFor([dup.id]).get(dup.id) || []), ...tags])]);
      return { article: getArticle(userId, dup.id), duplicate: true };
    }
  }
  if (!clean && !text && !html) throw Object.assign(new Error('Provide a url, or text to save'), { status: 400 });

  const supplied = !!(text || html);
  const info = db.prepare(`INSERT INTO articles (user_id, url, final_url, url_key, title, fetch_status, source, feed_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    userId, clean, clean, clean ? urlKey(clean) : null, String(title || '').trim().slice(0, 500), supplied ? 'ok' : 'pending', supplied ? (html ? 'html' : 'text') : 'url', feedId,
  );
  const id = Number(info.lastInsertRowid);
  if (tags?.length) setTags(userId, id, tags);
  if (supplied) {
    try {
      const ex = html ? await extractSupplied(html, { title, url: clean }) : await extractText(text, { title, url: clean });
      applyExtraction(id, ex);
      runAfterFill(id);
    } catch (e) {
      db.prepare('DELETE FROM articles WHERE id = ?').run(id);
      throw Object.assign(e, { status: 400 });
    }
  } else enqueueFetch(id);
  return { article: getArticle(userId, id), duplicate: false };
}

// Replace an article's content with pasted text or HTML (paywalled or script-only pages).
export async function replaceContent(userId, id, { title, text, html }) {
  const a = getArticle(userId, id);
  if (!a) return null;
  const t = title || a.title;
  const ex = html ? await extractSupplied(html, { title: t, url: a.final_url || a.url }) : await extractText(text, { title: t, url: a.final_url || a.url, siteName: a.site_name });
  if (!html && a.lead_image) ex.leadImage = a.lead_image;
  applyExtraction(a.id, ex, { source: html ? 'html' : 'text' });
  return getArticle(userId, id);
}

// ----- background fetch queue -----
const queue = [];
const inFlight = new Set();
let active = 0;

export function enqueueFetch(id) {
  if (queue.includes(id) || inFlight.has(id)) return;
  queue.push(id);
  pump();
}
function pump() {
  while (active < FETCH_CONCURRENCY && queue.length) {
    const id = queue.shift();
    active++;
    inFlight.add(id);
    processArticle(id).catch((e) => console.error('fetch job failed', id, e)).finally(() => { active--; inFlight.delete(id); pump(); });
  }
}

async function processArticle(id) {
  const a = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  if (!a || !a.url) return;
  db.prepare("UPDATE articles SET fetch_status = 'pending', fetch_error = NULL WHERE id = ?").run(id);
  try {
    const page = await fetchPage(a.url);
    const ex = page.isText ? await extractText(page.body, { url: page.finalUrl }) : await extractHtml(page.body, page.finalUrl);
    if (a.title && a.source !== 'url') ex.title = a.title;
    applyExtraction(id, ex, { finalUrl: cleanUrl(page.finalUrl) });
    runAfterFill(id);
  } catch (e) {
    const message = String(e.message || e).slice(0, 400);
    db.prepare("UPDATE articles SET fetch_status = 'failed', fetch_error = ?, updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?").run(message, nowIso(), fallbackTitle(a.url), id);
  }
}
function fallbackTitle(url) {
  try {
    const u = new URL(url);
    const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').trim();
    return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : u.hostname;
  } catch { return url; }
}

// Pages left half-fetched by a restart are picked up again.
export function resumePendingFetches() {
  for (const r of db.prepare("SELECT id FROM articles WHERE fetch_status = 'pending' AND url IS NOT NULL ORDER BY id").all()) enqueueFetch(r.id);
}

// Delete some of a user's articles with their files, and the tags no article uses any more.
export function deleteArticles(userId, ids) {
  let deleted = 0;
  for (const id of ids) {
    if (!db.prepare('SELECT 1 FROM articles WHERE id = ? AND user_id = ?').get(id, userId)) continue;
    for (const removeFiles of hooks.deleteFiles) {
      try { removeFiles(id); } catch (e) { console.error('removing files of article failed', id, e.message); }
    }
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    deleted++;
  }
  if (deleted) db.prepare('DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM article_tags)').run(userId);
  return deleted;
}

// ----- archiving -----
// Archive (or bring back) some of a user's articles. Archiving runs onArchived, which removes their audio when the
// owner asked for that.
export function archiveArticles(userId, ids, archived = true) {
  const now = nowIso();
  const stmt = archived
    ? db.prepare('UPDATE articles SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND archived = 0')
    : db.prepare('UPDATE articles SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?');
  const changed = [];
  for (const id of ids) {
    const info = archived ? stmt.run(now, now, id, userId) : stmt.run(now, id, userId);
    if (info.changes) changed.push(id);
  }
  if (archived && changed.length) {
    try { hooks.onArchived?.(userId, changed); } catch (e) { console.error('after-archive cleanup failed', e.message); }
  }
  return changed;
}

// "Archive articles left in the queue for N days": starred articles, ones still being fetched and ones opened within
// the period stay. Re-saving an article counts as saving it today.
export function archiveStale(onlyUserId = null) {
  let total = 0;
  const users = db.prepare(`SELECT id, prefs_json FROM users WHERE disabled = 0${onlyUserId ? ' AND id = ?' : ''}`).all(...(onlyUserId ? [onlyUserId] : []));
  for (const u of users) {
    const days = userPrefs(u).archiveAfterDays;
    if (!(days > 0)) continue;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const ids = db.prepare(`SELECT id FROM articles WHERE user_id = ? AND archived = 0 AND starred = 0 AND fetch_status != 'pending'
      AND created_at < ? AND (opened_at IS NULL OR opened_at < ?)`).all(u.id, cutoff, cutoff).map((r) => r.id);
    total += archiveArticles(u.id, ids).length;
  }
  return total;
}

// "Delete archived articles after N days": counted from when an article was (last) archived. Starred articles are
// never deleted. expiredArchived lists what a period would delete now, so the settings screen can ask first.
export function expiredArchived(userId, days) {
  if (!(days > 0)) return [];
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare('SELECT id FROM articles WHERE user_id = ? AND archived = 1 AND starred = 0 AND COALESCE(archived_at, updated_at) < ?')
    .all(userId, cutoff).map((r) => r.id);
}
export function purgeArchived(onlyUserId = null) {
  let total = 0;
  const users = db.prepare(`SELECT id, prefs_json FROM users${onlyUserId ? ' WHERE id = ?' : ''}`).all(...(onlyUserId ? [onlyUserId] : []));
  for (const u of users) total += deleteArticles(u.id, expiredArchived(u.id, userPrefs(u).deleteArchivedAfterDays));
  return total;
}

export function wantsAutoAudio(userId) {
  const u = db.prepare('SELECT prefs_json FROM users WHERE id = ?').get(userId);
  return userPrefs(u).autoAudio;
}
