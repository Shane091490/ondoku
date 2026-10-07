// JSON API (mounted at /api and /api/v1). Session cookie or API key; see docs/API.md.
import express from 'express';
import fs from 'node:fs';
import { db, nowIso } from '../lib/db.js';
import {
  requireUser, requireAdmin, apiKeyGuard, publicUser, userPrefs, DEFAULT_PREFS, hashPassword, verifyPassword,
  createApiKey, listApiKeys, revokeApiKey, deleteUserSessions, createSession, setSessionCookie, normalizeEmail, EMAIL_RE, getUserByEmail,
} from '../lib/auth.js';
import { cfg, settingsSnapshot, SETTING_KEYS, SECRET_KEYS, APP_NAME, APP_VERSION } from '../lib/config.js';
import { setSetting } from '../lib/db.js';
import {
  listArticles, counts, getArticle, serializeFull, serializeSummary, createArticle, replaceContent, enqueueFetch, setTags, listTags, renameArticle,
  renameTag, deleteTag, archiveArticles, archiveStale, deleteArticles, expiredArchived, purgeArchived,
} from '../lib/articles.js';
import { imageFile, deleteArticleImages, originalImageHtml, imageUsage, backfillImages } from '../lib/images.js';
import {
  listPronunciations, savePronunciation, updatePronunciation, deletePronunciation, applyPronunciations, MAX_SAY,
} from '../lib/pronounce.js';
import { FetchError, IMAGE_MIME } from '../lib/fetcher.js';
import { ExtractError } from '../lib/extract.js';
import {
  ttsStatus, requestTrack, findTrack, currentTracks, serializeTrack, touchTrack, segmentFile, trackPath, deleteArticleAudio, cacheUsage, previewVoice,
  voiceKeyOk, voiceCatalog, voiceDownloads, installVoice, removeVoice, voiceSample, ttsDownloading, speakText,
} from '../lib/tts.js';

export const apiRouter = express.Router();
apiRouter.use(requireUser, apiKeyGuard);

const asInt = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
function fail(res, e) {
  if (e instanceof FetchError || e instanceof ExtractError || e.status === 400) return res.status(400).json({ error: e.message });
  if (e.status) return res.status(e.status).json({ error: e.message });
  throw e;
}

// ----- articles -----
apiRouter.get('/articles', (req, res) => {
  const { view, q, tag, sort, limit, offset, domain } = req.query;
  const out = listArticles(req.user.id, { view, q, tag, sort, limit, offset, domain });
  res.json({ ...out, counts: counts(req.user.id) });
});

apiRouter.get('/counts', (req, res) => res.json(counts(req.user.id)));

function extractUrls(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return [...new Set(found.map((u) => u.replace(/[),.;:!?\]}>]+$/, '')))];
}

apiRouter.post('/articles', async (req, res) => {
  const b = req.body || {};
  const tags = Array.isArray(b.tags) ? b.tags : typeof b.tags === 'string' ? b.tags.split(',') : [];
  // Several links at once: { urls: [...] } or a url field holding many links.
  const many = Array.isArray(b.urls) ? b.urls : !b.text && !b.html && typeof b.url === 'string' && extractUrls(b.url).length > 1 ? extractUrls(b.url) : null;
  if (many) {
    const result = { created: [], duplicates: [], invalid: [] };
    for (const u of many.slice(0, 200)) {
      try {
        const r = await createArticle(req.user.id, { url: u, tags });
        (r.duplicate ? result.duplicates : result.created).push(serializeSummary(r.article, tags));
      } catch (e) { result.invalid.push({ url: u, error: e.message }); }
    }
    return res.status(result.created.length ? 201 : 200).json(result);
  }
  try {
    let url = typeof b.url === 'string' ? b.url.trim() : '';
    // A shared "text" often carries the link (Android share sheets put it there).
    if (!url && !b.text && !b.html) return res.status(400).json({ error: 'Provide a url, or text to save' });
    if (url && !/^https?:\/\//i.test(url)) url = extractUrls(url)[0] || (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(url) ? `https://${url}` : url);
    const r = await createArticle(req.user.id, { url: url || null, title: b.title, text: typeof b.text === 'string' ? b.text : '', html: typeof b.html === 'string' ? b.html : '', tags });
    res.status(r.duplicate ? 200 : 201).json({ article: serializeFull(r.article), duplicate: r.duplicate });
  } catch (e) { fail(res, e); }
});

apiRouter.get('/articles/:id', (req, res) => {
  const a = getArticle(req.user.id, asInt(req.params.id));
  if (!a) return res.status(404).json({ error: 'Article not found' });
  if (req.authMethod === 'session' && req.query.open === '1') db.prepare('UPDATE articles SET opened_at = ? WHERE id = ?').run(nowIso(), a.id);
  res.json({ ...serializeFull(a), audio: currentTracks(a).map(serializeTrack) });
});

apiRouter.patch('/articles/:id', (req, res) => {
  const a = getArticle(req.user.id, asInt(req.params.id));
  if (!a) return res.status(404).json({ error: 'Article not found' });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.starred !== undefined) { sets.push('starred = ?'); vals.push(bool(b.starred) ? 1 : 0); }
  if (b.progress !== undefined) {
    const p = Number(b.progress);
    if (Number.isFinite(p)) { sets.push('progress = ?'); vals.push(Math.min(Math.max(p, 0), 1)); }
  }
  if (b.listenSeg !== undefined && Number.isInteger(Number(b.listenSeg))) { sets.push('listen_seg = ?'); vals.push(Math.max(0, Number(b.listenSeg))); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(nowIso());
    db.prepare(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`).run(...vals, a.id);
  }
  if (b.archived !== undefined) archiveArticles(req.user.id, [a.id], bool(b.archived));
  if (b.tags !== undefined) setTags(req.user.id, a.id, Array.isArray(b.tags) ? b.tags : String(b.tags).split(','));
  if (typeof b.title === 'string' && b.title.trim() && b.title.trim() !== a.title) renameArticle(a.id, b.title.trim().slice(0, 500));
  res.json(serializeFull(getArticle(req.user.id, a.id)));
});

apiRouter.put('/articles/:id/content', async (req, res) => {
  const b = req.body || {};
  if (!b.text && !b.html) return res.status(400).json({ error: 'Provide text or html' });
  try {
    const a = await replaceContent(req.user.id, asInt(req.params.id), { title: b.title, text: b.text, html: b.html });
    if (!a) return res.status(404).json({ error: 'Article not found' });
    res.json(serializeFull(a));
  } catch (e) { fail(res, e); }
});

apiRouter.post('/articles/:id/refetch', (req, res) => {
  const a = getArticle(req.user.id, asInt(req.params.id));
  if (!a) return res.status(404).json({ error: 'Article not found' });
  if (!a.url) return res.status(400).json({ error: 'This article was pasted in and has no link to fetch' });
  db.prepare("UPDATE articles SET fetch_status = 'pending', fetch_error = NULL, source = 'url' WHERE id = ?").run(a.id);
  enqueueFetch(a.id);
  res.status(202).json(serializeFull(getArticle(req.user.id, a.id)));
});

apiRouter.delete('/articles/:id', (req, res) => {
  const a = getArticle(req.user.id, asInt(req.params.id));
  if (!a) return res.status(404).json({ error: 'Article not found' });
  deleteArticles(req.user.id, [a.id]);
  res.status(204).end();
});

// Bulk actions on several articles: archive, unarchive, star, unstar, delete, tag (adds tags).
apiRouter.post('/articles/bulk', (req, res) => {
  const { ids, action, tags } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids is required' });
  const owned = ids.map(asInt).filter((id) => getArticle(req.user.id, id));
  const now = nowIso();
  if (action === 'archive' || action === 'unarchive') {
    archiveArticles(req.user.id, owned, action === 'archive');
    return res.json({ updated: owned.length });
  }
  if (action === 'delete') return res.json({ updated: deleteArticles(req.user.id, owned) });
  for (const id of owned) {
    if (action === 'star' || action === 'unstar') db.prepare('UPDATE articles SET starred = ?, updated_at = ? WHERE id = ?').run(action === 'star' ? 1 : 0, now, id);
    else if (action === 'tag' && Array.isArray(tags)) {
      const current = db.prepare('SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = ?').all(id).map((r) => r.name);
      setTags(req.user.id, id, [...current, ...tags]);
    } else return res.status(400).json({ error: 'Unknown action' });
  }
  res.json({ updated: owned.length });
});

// Saved copies of an article's pictures (see lib/images.js). Only the article's owner can load them; the headers
// stop a browser from treating one as anything but a picture.
apiRouter.get('/articles/:id/images/:file', (req, res) => {
  const a = getArticle(req.user.id, asInt(req.params.id));
  const file = a ? imageFile(a.id, req.params.file) : null;
  if (!file) return res.status(404).json({ error: 'Image not found' });
  res.sendFile(file, {
    headers: {
      'Content-Type': IMAGE_MIME[req.params.file.split('.').pop()],
      'Cache-Control': 'private, max-age=2592000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  });
});

// ----- tags -----
apiRouter.get('/tags', (req, res) => res.json(listTags(req.user.id)));
apiRouter.patch('/tags/:id', (req, res) => {
  try { res.json(renameTag(req.user.id, asInt(req.params.id), req.body?.name)); } catch (e) { fail(res, e); }
});
apiRouter.delete('/tags/:id', (req, res) => {
  if (!deleteTag(req.user.id, asInt(req.params.id))) return res.status(404).json({ error: 'Tag not found' });
  res.status(204).end();
});

// ----- read aloud (natural voice) -----
apiRouter.get('/tts/status', async (req, res) => {
  const st = await ttsStatus({ fresh: req.query.fresh === '1' });
  res.json({ ...st, cache: cacheUsage() });
});

// Voice library: browse the Piper catalog, hear samples, follow downloads. Installing and removing is admin-only.
apiRouter.get('/tts/catalog', async (req, res) => {
  try { res.json(await voiceCatalog(req.query.refresh === '1')); } catch (e) { fail(res, e); }
});
apiRouter.get('/tts/downloads', async (req, res) => {
  try { res.json(await voiceDownloads()); } catch (e) { fail(res, e); }
});
apiRouter.get('/tts/sample', async (req, res) => {
  try {
    const file = await voiceSample(String(req.query.voice || ''), req.query.speaker ?? 0);
    res.sendFile(file, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=604800' } });
  } catch (e) { fail(res, e); }
});
apiRouter.post('/admin/tts/voices', requireAdmin, async (req, res) => {
  try { res.status(202).json(await installVoice(String(req.body?.voice || ''))); } catch (e) { fail(res, e); }
});
apiRouter.delete('/admin/tts/voices/:id', requireAdmin, async (req, res) => {
  try { await removeVoice(req.params.id); res.status(204).end(); } catch (e) { fail(res, e); }
});

// A requested voice is previewed exactly as asked, never swapped for another one. The audio headers are set only
// once there is audio, so an error is never labelled (or cached) as a WAV.
apiRouter.get('/tts/preview', async (req, res) => {
  try {
    const requested = String(req.query.voice || '');
    const audio = await previewVoice(requested ? await installedVoice(requested) : await resolveVoice(req, ''));
    res.set('Content-Type', 'audio/wav').set('Cache-Control', 'private, max-age=300').send(audio);
  } catch (e) { fail(res, e); }
});

const offline = (st) => Object.assign(new Error(`The natural voice service is offline${st.error ? `: ${st.error}` : ''}`), { status: 503 });

async function installedVoice(key) {
  let st = await ttsStatus();
  if (st.online && !voiceKeyOk(st, key)) st = await ttsStatus({ fresh: true }); // maybe installed moments ago
  if (!st.online) throw offline(st);
  if (voiceKeyOk(st, key)) return key;
  const v = st.voices.find((x) => x.id === key.split('#')[0]);
  if (v?.supported === false) throw Object.assign(new Error(v.unsupportedReason || "This voice isn't available in this version"), { status: 400 });
  throw Object.assign(new Error('That voice is not installed'), { status: 404 });
}

async function resolveVoice(req, requested) {
  const st = await ttsStatus();
  if (!st.online) throw offline(st);
  const prefs = userPrefs(req.user);
  const voice = [requested, prefs.piperVoice, st.defaultVoice].find((v) => voiceKeyOk(st, v));
  if (!voice) {
    throw Object.assign(new Error(await ttsDownloading()
      ? 'The voices are still downloading. Try again in a minute.'
      : 'No voices are installed. An admin can install voices in Settings > Read aloud > Voice library.'), { status: 503 });
  }
  return voice;
}

apiRouter.post('/articles/:id/audio', async (req, res) => {
  const a = getArticle(req.user.id, asInt(req.params.id));
  if (!a) return res.status(404).json({ error: 'Article not found' });
  if (a.fetch_status !== 'ok') return res.status(409).json({ error: 'The article text is not ready yet' });
  const requested = req.body?.voice ?? '';
  if (typeof requested !== 'string') return res.status(400).json({ error: 'voice must be a string' });
  try {
    const voice = await resolveVoice(req, requested);
    // The article may have been deleted or refetched while the voice service answered.
    const cur = getArticle(req.user.id, a.id);
    if (!cur) return res.status(404).json({ error: 'Article not found' });
    // Someone is waiting to listen: this goes ahead of automatic jobs and stops this article's audio in other voices.
    res.json(serializeTrack(requestTrack(cur, voice, { interactive: true })));
  } catch (e) { fail(res, e); }
});

apiRouter.get('/articles/:id/audio', async (req, res) => {
  const a = getArticle(req.user.id, asInt(req.params.id));
  if (!a) return res.status(404).json({ error: 'Article not found' });
  if (req.query.voice) {
    const t = a.content_hash ? findTrack(a.id, String(req.query.voice), a.content_hash) : null;
    return res.json(serializeTrack(t));
  }
  res.json(a.content_hash ? currentTracks(a).map(serializeTrack) : []);
});

function trackFor(req) {
  const a = getArticle(req.user.id, asInt(req.params.id));
  if (!a) return null;
  return db.prepare('SELECT * FROM audio_tracks WHERE id = ? AND article_id = ?').get(asInt(req.params.trackId), a.id) || null;
}

apiRouter.get('/articles/:id/audio/:trackId.mp3', (req, res) => {
  const t = trackFor(req);
  const file = t && t.status === 'ready' ? trackPath(t) : null;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Audio not found' });
  touchTrack(t.id);
  res.sendFile(file, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' } });
});

apiRouter.get('/articles/:id/audio/:trackId/seg/:n', (req, res) => {
  const t = trackFor(req);
  const n = asInt(req.params.n);
  const file = t && Number.isInteger(n) ? segmentFile(t, n) : null;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Segment not ready' });
  res.sendFile(file, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=600' } });
});

// ----- pronunciation fixes -----
apiRouter.get('/pronunciations', (req, res) => res.json(listPronunciations(req.user.id)));
apiRouter.post('/pronunciations', (req, res) => {
  try {
    const b = req.body || {};
    const out = savePronunciation(req.user.id, { word: b.word, say: b.say, matchCase: bool(b.matchCase) });
    res.status(out.created ? 201 : 200).json(out.entry);
  } catch (e) { fail(res, e); }
});
apiRouter.patch('/pronunciations/:id', (req, res) => {
  try {
    const b = req.body || {};
    res.json(updatePronunciation(req.user.id, asInt(req.params.id), { word: b.word, say: b.say, matchCase: b.matchCase === undefined ? undefined : bool(b.matchCase) }));
  } catch (e) { fail(res, e); }
});
apiRouter.delete('/pronunciations/:id', (req, res) => {
  if (!deletePronunciation(req.user.id, asInt(req.params.id))) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});
// Hear some text the way read aloud would say it (raw=1: exactly as written, without the fixes).
apiRouter.get('/pronunciations/say', async (req, res) => {
  try {
    const text = String(req.query.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SAY + 100);
    if (!text) return res.status(400).json({ error: 'Nothing to say' });
    const spoken = req.query.raw === '1' ? text : applyPronunciations(req.user.id, text).trim();
    if (!spoken) return res.status(400).json({ error: 'That word is skipped, so there is nothing to hear' });
    const requested = String(req.query.voice || '');
    const voice = requested ? await installedVoice(requested) : await resolveVoice(req, '');
    res.set('Content-Type', 'audio/wav').set('Cache-Control', 'private, no-store').send(await speakText(spoken, voice));
  } catch (e) { fail(res, e); }
});

// ----- import / export -----
apiRouter.post('/import', async (req, res) => {
  const urls = extractUrls(req.body?.text).slice(0, 1000);
  if (!urls.length) return res.status(400).json({ error: 'No links found in the text' });
  const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
  const result = { found: urls.length, created: 0, duplicates: 0, invalid: 0 };
  for (const u of urls) {
    try {
      const r = await createArticle(req.user.id, { url: u, tags });
      if (r.duplicate) result.duplicates++; else result.created++;
    } catch { result.invalid++; }
  }
  res.status(201).json(result);
});

apiRouter.get('/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM articles WHERE user_id = ? ORDER BY created_at').all(req.user.id);
  // Exports carry the sites' own picture addresses: the saved copies only open with a sign-in to this server.
  const items = rows.map((a) => {
    const full = serializeFull(a);
    const { contentHtml, segments, contentHash, leadInContent, leadImageOriginal, ...rest } = full;
    return { ...rest, leadImage: a.lead_image, text: a.text_content, ...(req.query.html === '1' ? { contentHtml: originalImageHtml(a.id, contentHtml) } : {}) };
  });
  const pronunciations = listPronunciations(req.user.id).map(({ word, say, matchCase }) => ({ word, say, matchCase }));
  res.set('Content-Disposition', `attachment; filename="${APP_NAME.toLowerCase()}-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: APP_NAME, version: APP_VERSION, exportedAt: nowIso(), count: items.length, articles: items, pronunciations });
});

// ----- me -----
apiRouter.get('/me', (req, res) => res.json({ user: publicUser(req.user), apiKey: req.apiKey ? { name: req.apiKey.name, permission: req.apiKey.permission } : null }));

// Voice keys: a model id, or model id + "#" + one speaker. Ids may have accented letters (pt_PT-tugão-medium).
const VOICE_KEY_RE = /^[\p{L}\p{N}_-]+(#[\p{L}\p{N}_.-]+)?$/u;
const SPEAKER_KEY_RE = /^[\p{L}\p{N}_-]+#[\p{L}\p{N}_.-]+$/u;
// A whole number of days from JSON or a query string (true, "" and 1.5 are not); null/undefined: not given.
const wholeDays = (v, max) => v == null || ((typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max);

apiRouter.patch('/me', (req, res) => {
  const b = req.body || {};
  const p = b.prefs && typeof b.prefs === 'object' ? b.prefs : null;
  // Checked before anything is saved, so a rejected request changes nothing.
  if (p?.piperVoice != null && !(typeof p.piperVoice === 'string' && (p.piperVoice === '' || (p.piperVoice.length <= 100 && VOICE_KEY_RE.test(p.piperVoice))))) {
    return res.status(400).json({ error: 'Unknown voice' });
  }
  // Speakers picked from multi-speaker voices ("model#speaker"); they show up in the player's voice list.
  const speakers = Array.isArray(p?.speakers) ? [...new Set(p.speakers.map(String).filter((k) => SPEAKER_KEY_RE.test(k)))] : null;
  if (speakers?.length > 100) return res.status(400).json({ error: 'You can keep up to 100 speakers' });
  const days = p?.archiveAfterDays;
  if (!wholeDays(days, 3650)) return res.status(400).json({ error: 'archiveAfterDays must be a whole number of days (0 for never)' });
  const keepDays = p?.deleteArchivedAfterDays;
  if (!wholeDays(keepDays, 36500)) return res.status(400).json({ error: 'deleteArchivedAfterDays must be a whole number of days (0 for never)' });
  if (typeof b.displayName === 'string' && b.displayName.trim()) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(b.displayName.trim().slice(0, 80), req.user.id);
  if (p) {
    const cur = userPrefs(req.user);
    const next = { ...cur };
    if (typeof p.piperVoice === 'string') next.piperVoice = p.piperVoice;
    if (p.rate !== undefined && Number.isFinite(Number(p.rate))) next.rate = Math.min(Math.max(Number(p.rate), 0.5), 3);
    if (p.autoAudio !== undefined) next.autoAudio = bool(p.autoAudio);
    if (speakers) next.speakers = speakers;
    for (const k of ['archiveOnFinish', 'archiveOnListen', 'dropAudioOnArchive']) if (p[k] !== undefined) next[k] = bool(p[k]);
    if (days != null) next.archiveAfterDays = Number(days);
    if (keepDays != null) next.deleteArchivedAfterDays = Number(keepDays);
    for (const k of Object.keys(next)) if (!(k in DEFAULT_PREFS)) delete next[k];
    db.prepare('UPDATE users SET prefs_json = ? WHERE id = ?').run(JSON.stringify(next), req.user.id);
    // New periods apply straight away; the answer says how many articles they archived or deleted. (The web app
    // asks before saving a period that deletes anything: see GET /archive/expired.)
    const out = {};
    if (days != null && next.archiveAfterDays > 0 && next.archiveAfterDays !== cur.archiveAfterDays) out.archived = archiveStale(req.user.id);
    if (keepDays != null && next.deleteArchivedAfterDays > 0 && next.deleteArchivedAfterDays !== cur.deleteArchivedAfterDays) out.deleted = purgeArchived(req.user.id);
    return res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)), ...out });
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// How many archived articles a "delete archived articles after N days" period would delete now (default: the
// account's own period).
apiRouter.get('/archive/expired', (req, res) => {
  const days = req.query.days != null ? req.query.days : userPrefs(req.user).deleteArchivedAfterDays;
  if (!wholeDays(days, 36500)) return res.status(400).json({ error: 'days must be a whole number of days' });
  res.json({ days: Number(days), count: expiredArchived(req.user.id, Number(days)).length });
});

apiRouter.post('/me/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (req.user.password_hash && !verifyPassword(currentPassword || '', req.user.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  // Sign out everywhere else.
  deleteUserSessions(req.user.id);
  setSessionCookie(res, createSession(req.user.id, req.headers['user-agent']));
  res.json({ ok: true });
});

apiRouter.post('/me/sessions/logout-others', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.sessionId || '');
  res.json({ ok: true });
});

apiRouter.get('/me/api-keys', (req, res) => res.json(listApiKeys(req.user.id)));
apiRouter.post('/me/api-keys', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the key a name' });
  const k = createApiKey(req.user.id, name, req.body?.permission);
  res.status(201).json({ ...k, name, permission: req.body?.permission === 'read' ? 'read' : 'write' });
});
apiRouter.delete('/me/api-keys/:id', (req, res) => {
  if (!revokeApiKey(req.user.id, asInt(req.params.id))) return res.status(404).json({ error: 'Key not found' });
  res.status(204).end();
});

// ----- admin -----
apiRouter.get('/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM articles a WHERE a.user_id = u.id) AS article_count FROM users u ORDER BY u.created_at`).all();
  res.json(rows.map((u) => ({ ...publicUser(u), articleCount: u.article_count })));
});
apiRouter.post('/admin/users', requireAdmin, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });
  const pw = req.body?.password;
  if (pw && pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const info = db.prepare('INSERT INTO users (email, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)').run(
    email, String(req.body?.displayName || '').trim().slice(0, 80) || email.split('@')[0], pw ? hashPassword(pw) : null, bool(req.body?.isAdmin) ? 1 : 0,
  );
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
});
apiRouter.patch('/admin/users/:id', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(asInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  if (u.id === req.user.id && (b.isAdmin === false || b.disabled === true)) return res.status(400).json({ error: 'You cannot remove your own admin rights or disable yourself' });
  if (b.displayName) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(b.displayName).trim().slice(0, 80), u.id);
  if (b.isAdmin !== undefined) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(bool(b.isAdmin) ? 1 : 0, u.id);
  if (b.disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(bool(b.disabled) ? 1 : 0, u.id);
    if (bool(b.disabled)) deleteUserSessions(u.id);
  }
  if (b.password) {
    if (b.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
    deleteUserSessions(u.id);
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
});
apiRouter.delete('/admin/users/:id', requireAdmin, (req, res) => {
  const id = asInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  for (const a of db.prepare('SELECT id FROM articles WHERE user_id = ?').all(id)) { deleteArticleAudio(a.id); deleteArticleImages(a.id); }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.status(204).end();
});

apiRouter.get('/admin/settings', requireAdmin, (req, res) => res.json(settingsSnapshot()));
apiRouter.put('/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  for (const k of SETTING_KEYS) {
    if (b[k] === undefined) continue;
    if (SECRET_KEYS.includes(k) && b[k] === '••••••••') continue;
    setSetting(k, typeof b[k] === 'boolean' ? String(b[k]) : String(b[k] ?? '').trim());
  }
  // Turning image saving (back) on saves pictures for the articles that were fetched while it was off.
  if (b.save_images !== undefined) backfillImages();
  res.json(settingsSnapshot());
});
apiRouter.get('/admin/info', requireAdmin, async (req, res) => {
  const st = await ttsStatus({ fresh: true });
  const totals = db.prepare('SELECT COUNT(*) AS articles, COALESCE(SUM(word_count), 0) AS words FROM articles').get();
  res.json({ app: APP_NAME, version: APP_VERSION, tts: { ...st, url: cfg('tts_url', 'http://tts:5000') }, audioCache: cacheUsage(), images: imageUsage(), totals, allowPrivateUrls: process.env.ALLOW_PRIVATE_URLS === 'true' });
});
