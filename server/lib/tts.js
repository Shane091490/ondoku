// Natural-voice read aloud through the bundled Piper TTS service. Each article is synthesized one segment
// (title, paragraph, heading, list item) at a time; segments become playable as soon as they are ready, and the
// finished track is encoded to a single MP3 so phones can keep playing it with the screen locked. A manifest of
// segment start/end times lets the reader highlight the paragraph being spoken.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, nowIso, AUDIO_DIR, DATA_DIR } from './db.js';
import { cfg } from './config.js';
import { hooks, wantsAutoAudio } from './articles.js';
import { userPrefs } from './auth.js';
import { spokenText } from './pronounce.js';

const GAP_SECONDS = 0.45; // pause between paragraphs
const PARALLEL = Math.max(1, Number(process.env.TTS_PARALLEL) || 2); // paragraphs requested at once (match the TTS MAX_CONCURRENT)
const MAX_REQUEST_CHARS = 2500;
const ttsUrl = () => cfg('tts_url', 'http://tts:5000').replace(/\/+$/, '');

// ----- Piper service -----
// A voice key is a model id ("en_US-lessac-high") or model id + "#" + speaker for multi-speaker models. It has at
// most one "#" (Piper takes everything after the first one as the speaker). Voices the TTS service reports as
// unsupported in this version are never used.
export function voiceKeyOk(st, key) {
  if (typeof key !== 'string' || !key || !st?.voices?.length) return false;
  const parts = key.split('#');
  if (parts.length > 2) return false;
  const v = st.voices.find((x) => x.id === parts[0]);
  if (!v || v.supported === false) return false;
  return parts.length === 1 || (v.speakerNames || []).includes(parts[1]);
}

let statusCache = { at: 0, value: null };
export function invalidateTtsStatus() { statusCache.at = 0; }
export async function ttsStatus({ fresh = false } = {}) {
  if (!fresh && statusCache.value && Date.now() - statusCache.at < 30000) return statusCache.value;
  let value;
  try {
    const res = await fetch(`${ttsUrl()}/voices`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`TTS service returned ${res.status}`);
    const data = await res.json();
    const voices = Array.isArray(data) ? data : data.voices;
    value = { online: true, voices, defaultVoice: null };
    // The admin's choice, else the service's default, else the first voice that can be used.
    value.defaultVoice = [cfg('default_voice', ''), data.default, ...voices.map((v) => v.id)].find((k) => voiceKeyOk(value, k)) || null;
  } catch (e) {
    value = { online: false, voices: [], defaultVoice: null, error: e.name === 'TimeoutError' ? 'TTS service did not answer' : e.message };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// Errors carry the status the API answers with: 503 when the service is offline, 502 for its own failures, and its
// 4xx as they are (e.g. 404 for a voice that is not installed).
async function ttsFetch(method, path, body, timeout = 40000) {
  let res;
  try {
    res = await fetch(`${ttsUrl()}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw Object.assign(new Error(`The voice service is offline (${e.name === 'TimeoutError' ? 'no answer' : e.message})`), { status: 503 });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `Voice service error ${res.status}`), { status: res.status >= 500 ? 502 : res.status });
  }
  return res;
}
async function ttsCall(method, path, body) {
  return (await ttsFetch(method, path, body)).json().catch(() => ({}));
}

// Whether the service is still downloading voices (first start, or an install in progress).
export async function ttsDownloading() {
  try {
    const res = await ttsFetch('GET', '/health', null, 4000);
    return !!(await res.json()).downloading;
  } catch { return false; }
}

// ----- voice library -----
export const voiceCatalog = (refresh) => ttsCall('GET', `/catalog${refresh ? '?refresh=1' : ''}`);
export async function voiceDownloads() {
  const list = await ttsCall('GET', '/downloads');
  if (list.some((d) => d.status === 'done')) invalidateTtsStatus();
  return list;
}
export async function installVoice(id) {
  const out = await ttsCall('POST', '/install', { voice: id });
  invalidateTtsStatus();
  return out;
}
export async function removeVoice(id) {
  // Already gone (removed in another tab, or by hand): still clean up its audio and previews below.
  try { await ttsCall('DELETE', `/voices/${encodeURIComponent(id)}`); } catch (e) { if (e.status !== 404) throw e; }
  invalidateTtsStatus();
  // Audio made with this voice (any of its speakers) can no longer be played back or regenerated.
  for (const t of db.prepare("SELECT * FROM audio_tracks WHERE voice = ? OR voice LIKE ? ESCAPE '\\'").all(id, `${id.replace(/[%_\\]/g, '\\$&')}#%`)) deleteTrack(t);
  for (const k of previews.keys()) if (k === id || k.startsWith(`${id}#`)) previews.delete(k);
}

// Sample recordings published with the Piper voices (one per speaker), cached on disk. They let people hear a
// voice before installing it.
const SAMPLE_DIR = path.join(DATA_DIR, 'samples');
const VOICE_ID_RE = /^([a-z]{2,3})_([A-Za-z]{2})-([\p{L}\p{N}_]+)-([a-z_]+)$/u; // names may have accents (pt_PT-tugão-medium)
export async function voiceSample(id, speaker = 0) {
  const m = VOICE_ID_RE.exec(String(id));
  const n = Number(speaker);
  if (!m || !Number.isInteger(n) || n < 0 || n > 2000) throw Object.assign(new Error('Unknown voice'), { status: 400 });
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  const file = path.join(SAMPLE_DIR, `${id}_${n}.mp3`);
  if (!fs.existsSync(file)) {
    const [, family, region] = m;
    const url = `https://rhasspy.github.io/piper-samples/samples/${family}/${family}_${region}/${encodeURIComponent(m[3])}/${m[4]}/speaker_${n}.mp3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!res?.ok) throw Object.assign(new Error('No sample is available for this voice'), { status: 404 });
    fs.writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${file}.part`, file);
  }
  return file;
}

async function synthesize(text, voice) {
  const res = await ttsFetch('POST', '/synthesize', { text, voice }, 180000);
  return parseWav(Buffer.from(await res.arrayBuffer()));
}

// Short sample for the voice picker; cached per voice.
const previews = new Map();
export async function previewVoice(voice) {
  if (!previews.has(voice)) {
    const res = await ttsFetch('POST', '/synthesize', { text: 'Here is how this voice sounds reading your saved articles.', voice }, 30000);
    previews.set(voice, Buffer.from(await res.arrayBuffer()));
  }
  return previews.get(voice);
}

// Any short text in a voice, e.g. to try a pronunciation fix. Not cached.
export async function speakText(text, voice) {
  const res = await ttsFetch('POST', '/synthesize', { text, voice }, 30000);
  return Buffer.from(await res.arrayBuffer());
}

// Minimal RIFF/WAVE reader: returns 16-bit PCM samples and format.
export function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('TTS returned something that is not WAV audio');
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body; // streamed WAVs
      if (!fmt || fmt.bits !== 16) throw new Error('Unsupported WAV format from TTS');
      return { ...fmt, pcm: buf.subarray(body, body + size) };
    }
    off = body + size + (size % 2);
  }
  throw new Error('TTS audio had no data');
}
function wavHeader(dataBytes, sampleRate, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

// Long paragraphs are split at sentence ends so one request never runs for minutes. Chinese and Japanese sentence
// ends need no space after them. A piece still too long is cut at a space, or by length when it has none (a long
// token, unpunctuated CJK), so no text is ever dropped.
function chunkText(text) {
  if (text.length <= MAX_REQUEST_CHARS) return [text];
  const sentences = text.match(/[\s\S]*?(?:[.!?…]+["'”’)\]]*(?:\s+|$)|[。！？．｡]+[」』”’）]*\s*)|[\s\S]+$/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > MAX_REQUEST_CHARS) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((c) => (c.length > MAX_REQUEST_CHARS * 1.5
    ? c.match(new RegExp(`[\\s\\S]{1,${MAX_REQUEST_CHARS}}(?:\\s+|$)|[\\s\\S]{1,${MAX_REQUEST_CHARS}}`, 'gu')) // u: never splits an emoji
    : [c]));
}

// ----- tracks -----
const trackDir = (trackId) => path.join(AUDIO_DIR, `track-${trackId}`);
const trackFile = (articleId, trackId) => path.join(AUDIO_DIR, `${articleId}-${trackId}.mp3`);

export function serializeTrack(t) {
  if (!t) return null;
  let manifest = null;
  try { manifest = t.manifest_json ? JSON.parse(t.manifest_json) : null; } catch { /* ignore */ }
  return {
    id: t.id,
    voice: t.voice,
    status: t.status,
    segmentsDone: t.segments_done,
    segmentsTotal: t.segments_total,
    progress: t.segments_total ? t.segments_done / t.segments_total : 0,
    duration: t.duration,
    error: t.error,
    size: t.size,
    contentHash: t.content_hash,
    // ready: one MP3 for the whole article; generating: per-segment WAVs that are already done
    url: t.status === 'ready' ? `/api/articles/${t.article_id}/audio/${t.id}.mp3` : null,
    segments: manifest?.segments || [],
    createdAt: t.created_at,
  };
}

export function findTrack(articleId, voice, contentHash) {
  return db.prepare('SELECT * FROM audio_tracks WHERE article_id = ? AND voice = ? AND content_hash = ?').get(articleId, voice, contentHash);
}
export function tracksForArticle(articleId) {
  return db.prepare('SELECT * FROM audio_tracks WHERE article_id = ? ORDER BY created_at DESC').all(articleId);
}
// The article's tracks that match its current text and pronunciation fixes (a finished track made with older fixes
// is regenerated when it is next requested, so it isn't offered).
export function currentTracks(article) {
  const { sayHash } = spokenText(article);
  return tracksForArticle(article.id).filter((t) => t.content_hash === article.content_hash && (t.status !== 'ready' || t.say_hash === sayHash));
}
export function touchTrack(id) {
  db.prepare('UPDATE audio_tracks SET last_access = ? WHERE id = ?').run(nowIso(), id);
}
export function segmentFile(track, n) {
  return path.join(trackDir(track.id), `seg-${n}.wav`);
}
export function trackPath(track) {
  return track.file ? path.join(AUDIO_DIR, track.file) : null;
}

function removeTrackFiles(t) {
  if (t.file) fs.rmSync(path.join(AUDIO_DIR, t.file), { force: true });
  fs.rmSync(trackDir(t.id), { recursive: true, force: true });
}
export function deleteTrack(t) {
  removeTrackFiles(t);
  db.prepare('DELETE FROM audio_tracks WHERE id = ?').run(t.id);
}
export function deleteArticleAudio(articleId) {
  for (const t of tracksForArticle(articleId)) removeTrackFiles(t);
}
// Remove an article's audio but keep the article (a job making it stops before its next paragraph).
export function dropArticleAudio(articleId) {
  for (const t of tracksForArticle(articleId)) deleteTrack(t);
}

// Find or start the audio for an article in a voice. A request from someone waiting to listen (interactive) goes
// ahead of automatic jobs and stops the article's unfinished audio in other voices, so switching voices in the
// player doesn't wait for the whole article in the voice they left.
export function requestTrack(article, voice, { interactive = false } = {}) {
  if (!article.content_hash) throw Object.assign(new Error('This article has no text to read yet'), { status: 409 });
  if (interactive) {
    for (const o of db.prepare("SELECT * FROM audio_tracks WHERE article_id = ? AND voice != ? AND status IN ('queued', 'generating')").all(article.id, voice)) cancelJob(o);
  }
  const { sayHash } = spokenText(article);
  let t = findTrack(article.id, voice, article.content_hash);
  if (t && t.status === 'ready' && t.say_hash === sayHash && t.file && fs.existsSync(path.join(AUDIO_DIR, t.file))) { touchTrack(t.id); return t; }
  // Failed, its file is gone, or made before the pronunciation fixes changed: make it again.
  if (t && (t.status === 'failed' || t.status === 'ready')) {
    removeTrackFiles(t);
    db.prepare("UPDATE audio_tracks SET status = 'queued', segments_done = 0, manifest_json = NULL, file = NULL, size = 0, error = NULL, duration = 0 WHERE id = ?").run(t.id);
  }
  if (!t) {
    const info = db.prepare('INSERT INTO audio_tracks (article_id, voice, content_hash) VALUES (?, ?, ?)').run(article.id, voice, article.content_hash);
    t = { id: Number(info.lastInsertRowid) };
  }
  if (interactive) cancelled.delete(t.id); // picked again before its running job noticed the cancellation
  enqueue(t.id, interactive);
  return db.prepare('SELECT * FROM audio_tracks WHERE id = ?').get(t.id);
}

// ----- job queue (one at a time: synthesis is CPU-heavy) -----
const jobs = [];
const cancelled = new Set(); // running jobs asked to stop; runJob checks between segments
let running = null;
function enqueue(id, first = false) {
  if (running === id) return;
  const i = jobs.indexOf(id);
  if (i !== -1) {
    if (!first) return;
    jobs.splice(i, 1);
  }
  if (first) jobs.unshift(id); else jobs.push(id);
  setImmediate(next);
}
// A queued job is dropped with its track now; the running one stops before its next segment and deletes its track.
function cancelJob(t) {
  if (t.id === running) { cancelled.add(t.id); return; }
  const i = jobs.indexOf(t.id);
  if (i !== -1) jobs.splice(i, 1);
  deleteTrack(t);
}
async function next() {
  if (running || !jobs.length) return;
  running = jobs.shift();
  try { await runJob(running); } catch (e) { console.error('audio job failed', running, e.message); } finally { cancelled.delete(running); running = null; setImmediate(next); }
}

async function runJob(trackId) {
  const t = db.prepare('SELECT * FROM audio_tracks WHERE id = ?').get(trackId);
  if (!t) return;
  const article = db.prepare('SELECT id, user_id, segments_json, content_hash FROM articles WHERE id = ?').get(t.article_id);
  if (!article || article.content_hash !== t.content_hash) { deleteTrack(t); return; }
  const { segs, sayHash } = spokenText(article);
  const dir = trackDir(t.id);
  const pcmPath = path.join(dir, 'all.pcm');
  let pcmOut;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    pcmOut = fs.openSync(pcmPath, 'w');
  } catch (e) {
    // e.g. files left behind with the wrong owner: report it on the track instead of leaving it "generating"
    db.prepare("UPDATE audio_tracks SET status = 'failed', error = ? WHERE id = ?").run(`Could not prepare the audio folder: ${e.code || e.message}`, t.id);
    throw e;
  }
  db.prepare("UPDATE audio_tracks SET status = 'generating', segments_total = ?, segments_done = 0, error = NULL, say_hash = ? WHERE id = ?").run(segs.length, sayHash, t.id);

  // Cancelled by a voice switch, or the track was deleted (voice removed, text changed, article deleted).
  const stopped = () => cancelled.has(t.id) || !db.prepare('SELECT 1 FROM audio_tracks WHERE id = ?').get(t.id);
  const manifest = { sampleRate: 0, segments: [] };
  let seconds = 0;
  // Keep PARALLEL paragraphs in flight (the TTS service splits its CPU cores between them; about 1.3x faster on a
  // 4-core machine than one at a time), but write them out in order.
  const render = async (i) => {
    const parts = [];
    let rate = 0;
    for (const chunk of chunkText(segs[i].text)) {
      const wav = await synthesize(chunk, t.voice);
      rate = wav.sampleRate;
      parts.push(wav.pcm);
    }
    return { pcm: Buffer.concat(parts), rate };
  };
  const inFlight = new Map();
  const startRender = (i) => {
    if (i >= segs.length || inFlight.has(i)) return;
    const job = render(i);
    job.catch(() => {}); // awaited below; this only keeps an abandoned one from becoming an unhandled rejection
    inFlight.set(i, job);
  };
  try {
    for (let i = 0; i < segs.length; i++) {
      if (stopped()) throw new Error('cancelled');
      for (let k = i; k < i + PARALLEL; k++) startRender(k);
      const { pcm, rate } = await inFlight.get(i);
      inFlight.delete(i);
      manifest.sampleRate = rate;
      const gap = Buffer.alloc(Math.round(rate * GAP_SECONDS) * 2);
      const segPcm = i < segs.length - 1 ? Buffer.concat([pcm, gap]) : pcm;
      fs.writeFileSync(segmentFile(t, i), Buffer.concat([wavHeader(segPcm.length, rate), segPcm]));
      fs.writeSync(pcmOut, segPcm);
      const dur = segPcm.length / 2 / rate;
      manifest.segments.push({ seg: segs[i].seg, start: +seconds.toFixed(3), end: +(seconds + dur).toFixed(3), n: i });
      seconds += dur;
      db.prepare('UPDATE audio_tracks SET segments_done = ?, manifest_json = ?, duration = ? WHERE id = ?').run(i + 1, JSON.stringify(manifest), seconds, t.id);
    }
    fs.closeSync(pcmOut);
    const file = path.basename(trackFile(t.article_id, t.id));
    await encodeMp3(pcmPath, manifest.sampleRate, path.join(AUDIO_DIR, file));
    fs.rmSync(pcmPath, { force: true });
    if (stopped()) { fs.rmSync(path.join(AUDIO_DIR, file), { force: true }); throw new Error('cancelled'); } // during encoding
    const size = fs.statSync(path.join(AUDIO_DIR, file)).size;
    db.prepare("UPDATE audio_tracks SET status = 'ready', file = ?, size = ?, duration = ?, last_access = ? WHERE id = ?").run(file, size, seconds, nowIso(), t.id);
    // Keep the segment files a little longer for players still stepping through them.
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }, 15 * 60000).unref();
    evictCache();
  } catch (e) {
    try { fs.closeSync(pcmOut); } catch { /* already closed */ }
    // Stopped (a request that was running may fail first, e.g. its folder or voice was deleted): remove the track.
    if (e.message === 'cancelled' || stopped()) { deleteTrack(t); return; }
    db.prepare("UPDATE audio_tracks SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 300), t.id);
    invalidateTtsStatus();
  }
}

function encodeMp3(pcmPath, sampleRate, outPath) {
  return new Promise((resolve, reject) => {
    const tmp = `${outPath}.part`;
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', pcmPath, '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', tmp]);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`MP3 encoding failed: ${err.slice(0, 200)}`));
      fs.renameSync(tmp, outPath);
      resolve();
    });
  });
}

// Keep the audio cache under AUDIO_CACHE_MB by dropping the least recently played tracks.
export function evictCache() {
  const limit = Number(cfg('audio_cache_mb', '2048')) * 1048576;
  const tracks = db.prepare("SELECT * FROM audio_tracks WHERE status = 'ready' ORDER BY last_access ASC").all();
  let total = tracks.reduce((n, t) => n + t.size, 0);
  for (const t of tracks) {
    if (total <= limit) break;
    deleteTrack(t);
    total -= t.size;
  }
}
export function cacheUsage() {
  return db.prepare("SELECT COUNT(*) AS tracks, COALESCE(SUM(size), 0) AS bytes FROM audio_tracks WHERE status = 'ready'").get();
}

// Startup: resume unfinished jobs and clear leftovers.
export function initTts() {
  for (const t of db.prepare("SELECT id FROM audio_tracks WHERE status IN ('queued', 'generating') ORDER BY id").all()) enqueue(t.id);
  const live = new Set(db.prepare('SELECT id FROM audio_tracks').all().map((t) => `track-${t.id}`));
  for (const name of fs.readdirSync(AUDIO_DIR)) {
    if (name.startsWith('track-') && !live.has(name)) fs.rmSync(path.join(AUDIO_DIR, name), { recursive: true, force: true });
    if (name.endsWith('.part')) fs.rmSync(path.join(AUDIO_DIR, name), { force: true });
  }
  hooks.deleteFiles.push(deleteArticleAudio);
  hooks.dropStaleAudio = (articleId, contentHash) => {
    for (const t of db.prepare('SELECT * FROM audio_tracks WHERE article_id = ? AND content_hash != ?').all(articleId, contentHash)) deleteTrack(t);
  };
  // "Remove the audio when an article is archived" preference.
  hooks.onArchived = (userId, ids) => {
    const u = db.prepare('SELECT prefs_json FROM users WHERE id = ?').get(userId);
    if (!userPrefs(u).dropAudioOnArchive) return;
    for (const id of ids) dropArticleAudio(id);
  };
  // "Prepare audio automatically" preference: queue the default voice once an article has its text, behind the
  // jobs people are waiting for. It runs in the background, so it must never throw.
  hooks.afterFill = async (articleId) => {
    try {
      const a = db.prepare('SELECT articles.id, articles.user_id, u.prefs_json FROM articles JOIN users u ON u.id = articles.user_id WHERE articles.id = ?').get(articleId);
      if (!a || !wantsAutoAudio(a.user_id)) return;
      const st = await ttsStatus();
      if (!st.online) return;
      let voice = st.defaultVoice;
      try { const p = JSON.parse(a.prefs_json || '{}'); if (voiceKeyOk(st, p.piperVoice)) voice = p.piperVoice; } catch { /* default */ }
      // The article (or its owner) may have been deleted while the voice service answered.
      const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (voice && article?.content_hash) requestTrack(article, voice);
    } catch (e) { console.error('auto audio failed', articleId, e.message); }
  };
}
