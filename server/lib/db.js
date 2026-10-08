// SQLite database (node:sqlite, built into Node 22.13+). One file under DATA_DIR, plus cached read-aloud audio.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
export const DB_PATH = path.join(DATA_DIR, 'readlog.db');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// Full-text search over saved articles (porter stemming, so "train" finds "trains"). tags_text holds the article's tag
// names, so plain search words match tags too.
const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, byline, site_name, text_content, tags_text,
  content='articles', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS articles_fts_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, byline, site_name, text_content, tags_text) VALUES (new.id, new.title, new.byline, new.site_name, new.text_content, new.tags_text);
END;
CREATE TRIGGER IF NOT EXISTS articles_fts_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, byline, site_name, text_content, tags_text) VALUES ('delete', old.id, old.title, old.byline, old.site_name, old.text_content, old.tags_text);
END;
CREATE TRIGGER IF NOT EXISTS articles_fts_au AFTER UPDATE OF title, byline, site_name, text_content, tags_text ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, byline, site_name, text_content, tags_text) VALUES ('delete', old.id, old.title, old.byline, old.site_name, old.text_content, old.tags_text);
  INSERT INTO articles_fts(rowid, title, byline, site_name, text_content, tags_text) VALUES (new.id, new.title, new.byline, new.site_name, new.text_content, new.tags_text);
END;
`;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  oidc_sub TEXT UNIQUE,
  prefs_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL DEFAULT 'write',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS oidc_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  redirect TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT,
  final_url TEXT,
  url_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  byline TEXT NOT NULL DEFAULT '',
  site_name TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  lead_image TEXT,
  published_at TEXT,
  lang TEXT,
  content_html TEXT NOT NULL DEFAULT '',
  text_content TEXT NOT NULL DEFAULT '',
  segments_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  reading_minutes INTEGER NOT NULL DEFAULT 0,
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  fetch_error TEXT,
  source TEXT NOT NULL DEFAULT 'url',
  starred INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  listen_seg INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fetched_at TEXT,
  opened_at TEXT,
  archived_at TEXT,
  tags_text TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_user_url ON articles(user_id, url_key) WHERE url_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS articles_user_list ON articles(user_id, archived, created_at);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE TABLE IF NOT EXISTS audio_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  voice TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  segments_done INTEGER NOT NULL DEFAULT 0,
  segments_total INTEGER NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  manifest_json TEXT,
  file TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_access TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(article_id, voice, content_hash)
);

-- Pictures kept on the server for an article (file is NULL when the download failed).
CREATE TABLE IF NOT EXISTS article_images (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  file TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (article_id, url)
);

-- Auto-tag rules: articles whose site, title or text matches get the tag when first saved.
CREATE TABLE IF NOT EXISTS tag_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  pattern TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, kind, pattern, tag)
);

-- Followed RSS/Atom feeds, and the entries already seen in each (so nothing is saved twice).
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  site_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  etag TEXT,
  last_modified TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, url)
);
CREATE TABLE IF NOT EXISTS feed_items (
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  link TEXT,
  published_at TEXT,
  article_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (feed_id, guid)
);

-- Read-aloud pronunciation fixes, per account.
CREATE TABLE IF NOT EXISTS pronunciations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  say TEXT NOT NULL DEFAULT '',
  match_case INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, word)
);

${FTS_SQL}
`);

// Additive migrations for columns added after a database was created.
export function ensureColumns(table, cols) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, def] of Object.entries(cols)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

// Searchable tags (2026-10-07): older databases get articles.tags_text, filled from their tags, and a rebuilt search
// index that includes it. tags_text is filled before the new triggers exist, then 'rebuild' indexes everything.
ensureColumns('articles', { tags_text: "TEXT NOT NULL DEFAULT ''" });
if (!db.prepare("SELECT 1 FROM pragma_table_info('articles_fts') WHERE name = 'tags_text'").get()) {
  db.exec('BEGIN');
  try {
    db.exec('DROP TRIGGER IF EXISTS articles_fts_ai; DROP TRIGGER IF EXISTS articles_fts_ad; DROP TRIGGER IF EXISTS articles_fts_au; DROP TABLE IF EXISTS articles_fts;');
    db.exec(`UPDATE articles SET tags_text = COALESCE((SELECT group_concat(t.name, ' ') FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = articles.id), '')`);
    db.exec(FTS_SQL);
    db.exec("INSERT INTO articles_fts(articles_fts) VALUES ('rebuild')");
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Saved images and pronunciation fixes (2026-10-07). images_at: when the article's pictures were last saved (NULL:
// not yet); lead_image_file: the saved copy of lead_image; lead_in_content: whether the article body already shows
// the lead image, worked out before the body's image addresses were rewritten. say_hash: which pronunciation fixes
// an audio track was made with ('' for none).
ensureColumns('articles', { images_at: 'TEXT', lead_image_file: 'TEXT', lead_in_content: 'INTEGER' });
ensureColumns('audio_tracks', { say_hash: "TEXT NOT NULL DEFAULT ''" });
// Public share links and feeds (2026-10-08). share_token: the secret in /s/<token> (NULL: not shared); feed_id: the
// followed feed an article was saved from.
ensureColumns('articles', { share_token: 'TEXT', share_created_at: 'TEXT', share_views: 'INTEGER NOT NULL DEFAULT 0', feed_id: 'INTEGER' });
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS articles_share_token ON articles(share_token) WHERE share_token IS NOT NULL');

export function nowIso() {
  return new Date().toISOString();
}

// Run fn inside a transaction (node:sqlite has no helper for this).
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  setSettingStmt.run(key, value == null ? '' : String(value));
}
export function getAllSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}
export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
