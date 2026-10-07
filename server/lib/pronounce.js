// Pronunciation fixes for read aloud: a per-account list of words (names, acronyms, "GIF") and how Piper should say
// them, used with every voice. Entries match whole words, ignoring case unless the entry says to match it, and the
// longest entry wins ("New York Times" before "New York"). Only the text sent to Piper changes, never the article.
// Audio made with an older list is regenerated the next time it is played (see spokenText and audio_tracks.say_hash).
import crypto from 'node:crypto';
import { db } from './db.js';
import { speechSegments } from './extract.js';

export const MAX_ENTRIES = 500;
export const MAX_WORD = 100;
export const MAX_SAY = 200;

const compiledCache = new Map(); // user id -> { re, exact, loose } | null
const spokenCache = new Map(); // `${user}:${version}:${article}:${content hash}` -> { segs, sayHash }
const versions = new Map(); // user id -> counter, bumped on every change
const version = (userId) => versions.get(userId) || 0;

export function serializeEntry(r) {
  return { id: r.id, word: r.word, say: r.say, matchCase: !!r.match_case, createdAt: r.created_at };
}
export function listPronunciations(userId) {
  return db.prepare('SELECT * FROM pronunciations WHERE user_id = ? ORDER BY word COLLATE NOCASE, word').all(userId).map(serializeEntry);
}

function changed(userId) {
  compiledCache.delete(userId);
  versions.set(userId, version(userId) + 1);
  for (const k of spokenCache.keys()) if (k.startsWith(`${userId}:`)) spokenCache.delete(k);
}

const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function checkWord(word) {
  if (!word) throw bad('Enter the word to fix');
  if (!/[\p{L}\p{N}]/u.test(word)) throw bad('The word needs at least one letter or number');
}

// Adds an entry, or updates the one with exactly this word.
export function savePronunciation(userId, { word, say, matchCase }) {
  const w = clean(word, MAX_WORD);
  checkWord(w);
  const s = clean(say, MAX_SAY);
  const existing = db.prepare('SELECT id FROM pronunciations WHERE user_id = ? AND word = ?').get(userId, w);
  if (!existing && db.prepare('SELECT COUNT(*) AS n FROM pronunciations WHERE user_id = ?').get(userId).n >= MAX_ENTRIES) {
    throw bad(`You can keep up to ${MAX_ENTRIES} pronunciation fixes`);
  }
  if (existing) db.prepare('UPDATE pronunciations SET say = ?, match_case = ? WHERE id = ?').run(s, matchCase ? 1 : 0, existing.id);
  else db.prepare('INSERT INTO pronunciations (user_id, word, say, match_case) VALUES (?, ?, ?, ?)').run(userId, w, s, matchCase ? 1 : 0);
  changed(userId);
  return { entry: serializeEntry(db.prepare('SELECT * FROM pronunciations WHERE user_id = ? AND word = ?').get(userId, w)), created: !existing };
}

export function updatePronunciation(userId, id, { word, say, matchCase }) {
  const cur = db.prepare('SELECT * FROM pronunciations WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!cur) throw bad('Not found', 404);
  const w = word !== undefined ? clean(word, MAX_WORD) : cur.word;
  checkWord(w);
  if (w !== cur.word && db.prepare('SELECT 1 FROM pronunciations WHERE user_id = ? AND word = ? AND id != ?').get(userId, w, cur.id)) throw bad(`“${w}” is already in your list`, 409);
  const s = say !== undefined ? clean(say, MAX_SAY) : cur.say;
  const mc = matchCase !== undefined ? (matchCase ? 1 : 0) : cur.match_case;
  db.prepare('UPDATE pronunciations SET word = ?, say = ?, match_case = ? WHERE id = ?').run(w, s, mc, cur.id);
  changed(userId);
  return serializeEntry(db.prepare('SELECT * FROM pronunciations WHERE id = ?').get(cur.id));
}

export function deletePronunciation(userId, id) {
  const info = db.prepare('DELETE FROM pronunciations WHERE id = ? AND user_id = ?').run(Number(id), userId);
  if (info.changes) changed(userId);
  return info.changes > 0;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex for the whole list. Entries that ignore case are wrapped in (?i:…); an entry that matches case beats
// one that doesn't for the same word.
function compiled(userId) {
  if (compiledCache.has(userId)) return compiledCache.get(userId);
  const rows = db.prepare('SELECT word, say, match_case FROM pronunciations WHERE user_id = ?').all(userId)
    .sort((a, b) => b.word.length - a.word.length || b.match_case - a.match_case);
  let value = null;
  if (rows.length) {
    const exact = new Map();
    const loose = new Map();
    for (const r of rows) {
      if (r.match_case) { if (!exact.has(r.word)) exact.set(r.word, r.say); } else if (!loose.has(r.word.toLowerCase())) loose.set(r.word.toLowerCase(), r.say);
    }
    const alts = rows.map((r) => (r.match_case ? escapeRe(r.word) : `(?i:${escapeRe(r.word)})`));
    value = { re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join('|')})(?![\\p{L}\\p{N}_])`, 'gu'), exact, loose };
  }
  compiledCache.set(userId, value);
  return value;
}

export function applyPronunciations(userId, text) {
  const c = compiled(userId);
  if (!c) return text;
  let hit = false;
  const out = text.replace(c.re, (m) => {
    const say = c.exact.get(m) ?? c.loose.get(m.toLowerCase()) ?? m;
    if (say !== m) hit = true;
    return say;
  });
  return hit ? out.replace(/ {2,}/g, ' ') : text; // an entry with nothing to say leaves a double space
}

// What read aloud says for an article: its speech segments with the owner's fixes applied, and a hash naming the
// fixes that changed anything ('' when none did, so audio made before any fixes existed stays valid).
export function spokenText(article) {
  const key = `${article.user_id}:${version(article.user_id)}:${article.id}:${article.content_hash}`;
  const hit = spokenCache.get(key);
  if (hit) return hit;
  const raw = speechSegments(JSON.parse(article.segments_json || '[]'));
  let changedAny = false;
  const segs = raw.map((s) => {
    const text = applyPronunciations(article.user_id, s.text);
    if (text !== s.text) changedAny = true;
    return { ...s, text };
  });
  const sayHash = changedAny ? crypto.createHash('sha1').update(JSON.stringify(segs.map((s) => s.text))).digest('hex').slice(0, 16) : '';
  const value = { segs, sayHash };
  if (spokenCache.size > 500) spokenCache.delete(spokenCache.keys().next().value);
  spokenCache.set(key, value);
  return value;
}
