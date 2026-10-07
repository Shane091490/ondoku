// Settings > Read aloud: the installed voices (pick one, preview, remove, choose speakers of multi-speaker models)
// and the voice library (every Piper voice: listen to a sample, install). Installing and removing is admin-only.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Trash2, Download, Check, LoaderCircle, RefreshCw, Search, Users, X, Plus, TriangleAlert } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Confirm, useToast } from './ui.jsx';
import { groupLabel, groupBy, isMulti, fmtSize, voiceKeyOk } from '../lib/voices.js';
import { relDate } from '../lib/format.js';

const MAX_SPEAKERS = 100; // the server keeps up to 100 picked speakers
const PREVIEW_ERROR = 'Could not play the preview';

export function useSamplePlayer() {
  const toast = useToast();
  const ref = useRef(null);
  const current = useRef(''); // the key playing now (callbacks of an earlier sample outlive the render they saw)
  const [playing, setPlaying] = useState('');
  const play = useCallback((key, url, rate = 1, errorText = 'No sample available for this voice') => {
    ref.current?.pause();
    const stop = () => { if (current.current === key) { current.current = ''; setPlaying(''); } };
    if (current.current === key) { stop(); return; }
    const a = new Audio(url);
    a.playbackRate = rate;
    ref.current = a;
    current.current = key;
    setPlaying(key);
    // Only the newest sample changes the state: pausing one that is still loading also rejects its play().
    a.onended = () => { if (ref.current === a) stop(); };
    a.onerror = () => { if (ref.current === a) { stop(); toast(errorText, { error: true }); } };
    a.play().catch(() => { if (ref.current === a) stop(); });
  }, [toast]);
  useEffect(() => () => ref.current?.pause(), []);
  return { playing, play };
}

export function SampleButton({ sample, k, url, rate, label = 'Listen', name, errorText }) {
  const on = sample.playing === k;
  return (
    <button className="btn small" onClick={() => sample.play(k, url, rate, errorText)} aria-label={`${on ? 'Stop' : label} ${name}`} title={on ? 'Stop' : label}>
      {on ? <Square size={12} fill="currentColor" /> : <Play size={13} />}<span className="hide-sm">{on ? 'Stop' : label}</span>
    </button>
  );
}

export default function VoiceSettings({ onStatus }) {
  const { user, setUser } = useApp();
  const toast = useToast();
  const prefs = user.prefs;
  const [tts, setTts] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [downloads, setDownloads] = useState([]);
  const [removing, setRemoving] = useState(null);
  const sample = useSamplePlayer();
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  // The status also carries the audio cache size the page shows below (removing a voice deletes its audio).
  const loadStatus = useCallback(() => api.get('/api/tts/status?fresh=1').then((t) => { setTts(t); onStatusRef.current?.(t); }).catch(() => setTts({ online: false, voices: [] })), []);
  const loadCatalog = useCallback((refresh) => api.get(`/api/tts/catalog${refresh ? '?refresh=1' : ''}`).then(setCatalog).catch((e) => setCatalog({ error: e.message })), []);
  useEffect(() => { loadStatus(); loadCatalog(); }, [loadStatus, loadCatalog]);

  // Follow downloads (including the default voices fetched on first start) and refresh lists as they finish. Each
  // finished download counts once, by voice and finish time, so a voice removed and installed again shows up too.
  const doneRef = useRef(new Set());
  const active = downloads.some((d) => d.status === 'queued' || d.status === 'downloading');
  useEffect(() => {
    let stop = false;
    let timer = null;
    let busy = false;
    let failures = 0;
    const tick = async () => {
      if (stop || busy) return;
      busy = true;
      clearTimeout(timer);
      try {
        const list = await api.get('/api/tts/downloads');
        if (stop) return;
        failures = 0;
        setDownloads(list);
        const tag = (d) => `${d.voice}@${d.updated}`;
        const finished = list.filter((d) => d.status === 'done' && !doneRef.current.has(tag(d)));
        if (finished.length) {
          finished.forEach((d) => doneRef.current.add(tag(d)));
          // Installed right away, so the Install button doesn't flash back while the catalog reloads.
          const ids = new Set(finished.map((d) => d.voice));
          setCatalog((c) => (c?.voices ? { ...c, voices: c.voices.map((v) => (ids.has(v.id) ? { ...v, installed: true } : v)) } : c));
          loadStatus();
          loadCatalog();
        }
        if (list.some((d) => d.status === 'queued' || d.status === 'downloading')) timer = setTimeout(tick, 1500);
      } catch {
        // The service restarting or a network blip: keep following the downloads, waiting longer each time.
        if (!stop && active) timer = setTimeout(tick, Math.min(30000, 3000 * 2 ** failures++));
      } finally {
        busy = false;
      }
    };
    tick();
    // Back from sleep or another tab, or online again: look now (this also finds downloads started elsewhere).
    const wake = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [active, loadStatus, loadCatalog]);

  // Changes show at once and are saved one at a time, each worked out from the prefs the previous save left, so
  // quick clicks never undo each other. A change is a prefs patch, or a function of the prefs that returns one.
  const userRef = useRef(user);
  userRef.current = user;
  const savedRef = useRef(prefs); // the prefs as the server has them
  const saveQueue = useRef(Promise.resolve());
  const saving = useRef(0);
  function save(change) {
    const patchFor = (p) => (typeof change === 'function' ? change(p) : change);
    if (!saving.current) savedRef.current = userRef.current.prefs;
    const shown = patchFor(userRef.current.prefs);
    if (!shown) return saveQueue.current;
    userRef.current = { ...userRef.current, prefs: { ...userRef.current.prefs, ...shown } };
    setUser(userRef.current);
    saving.current++;
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const patch = patchFor(savedRef.current);
        if (patch) savedRef.current = (await api.patch('/api/me', { prefs: patch })).user.prefs;
      } catch (e) { toast(e.message, { error: true }); }
      // Once the last save is back, show what the server kept (this also undoes a change it refused).
      if (--saving.current === 0) {
        userRef.current = { ...userRef.current, prefs: savedRef.current };
        setUser(userRef.current);
      }
    });
    return saveQueue.current;
  }

  // The voice that reads now: the user's choice if it can be used, else the server's default.
  const currentOf = (p) => (tts && voiceKeyOk(tts.voices, p.piperVoice) ? p.piperVoice : tts?.defaultVoice || '');
  // Adding a speaker also reads with it.
  const addSpeaker = (key) => save((p) => {
    const list = p.speakers || [];
    return { speakers: list.includes(key) ? list : [...list, key], piperVoice: key };
  });
  // Removing the speaker that reads now moves to the model's next picked speaker, or else the model itself, so
  // exactly one voice stays selected.
  const dropSpeaker = (key) => save((p) => {
    const list = p.speakers || [];
    if (!list.includes(key)) return null;
    const speakers = list.filter((k) => k !== key);
    if (currentOf(p) !== key) return { speakers };
    const id = key.split('#')[0];
    const same = list.filter((k) => k.startsWith(`${id}#`));
    const i = same.indexOf(key);
    return { speakers, piperVoice: same[i + 1] || same[i - 1] || id };
  });

  async function install(id) {
    try {
      const d = await api.post('/api/admin/tts/voices', { voice: id });
      setDownloads((list) => [...list.filter((x) => x.voice !== id), d]);
    } catch (e) { toast(e.message, { error: true }); }
  }
  async function remove(v) {
    try { await api.del(`/api/admin/tts/voices/${encodeURIComponent(v.id)}`); }
    catch (e) { if (e.status !== 404) throw e; } // the dialog shows the error; 404 = already removed elsewhere
    save((p) => {
      const list = p.speakers || [];
      const speakers = list.filter((k) => !k.startsWith(`${v.id}#`));
      return speakers.length !== list.length ? { speakers } : null;
    });
    toast(`Removed ${v.name}`);
    loadStatus();
    loadCatalog();
  }

  if (!tts) return <section className="section"><p className="sub"><LoaderCircle size={14} className="spin" /> Checking the voice service…</p></section>;
  if (!tts.online) return <section className="section"><h2>Voices</h2><p className="sub">The voice service is offline{tts.error ? ` (${tts.error})` : ''}. Check that the <code>tts</code> container is running.</p></section>;

  const current = currentOf(prefs);
  return (
    <>
      <InstalledVoices tts={tts} prefs={prefs} current={current} sample={sample} isAdmin={user.isAdmin} downloads={downloads} onPick={(key) => save({ piperVoice: key })} onAdd={addSpeaker} onDrop={dropSpeaker} onRemove={setRemoving} />
      <VoiceLibrary catalog={catalog} downloads={downloads} sample={sample} isAdmin={user.isAdmin} rate={prefs.rate} onInstall={install} onRefresh={() => loadCatalog(true)} />
      {removing && (
        <Confirm
          title={`Remove ${removing.name}?`}
          message={`${groupLabel(removing)}. Audio already made with this voice is deleted too. You can install it again from the voice library.`}
          confirmLabel="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </>
  );
}

function InstalledVoices({ tts, prefs, current, sample, isAdmin, downloads, onPick, onAdd, onDrop, onRemove }) {
  const [open, setOpen] = useState('');
  const groups = groupBy(tts.voices, groupLabel);
  const pending = downloads.filter((d) => d.status === 'queued' || d.status === 'downloading').length;
  return (
    <section className="section">
      <h2 id="your-voices">Your voices</h2>
      <p className="sub">The voice you pick reads every article (you can also switch in the player). {tts.voices.length} installed{pending ? `, ${pending} downloading` : ''}.</p>
      {!tts.voices.length && !pending && (
        <p className="muted">{isAdmin ? 'No voices are installed. Install voices from the voice library below.' : 'No voices are installed. An admin can install voices in Settings > Read aloud > Voice library.'}</p>
      )}
      <div role="radiogroup" aria-labelledby="your-voices">
        {groups.map(([group, voices]) => (
          <div key={group} className="voice-group">
            <div className="group-label">{group}</div>
            {voices.map((v) => {
              const multi = isMulti(v);
              const ok = v.supported !== false; // installed, but this version can't run it: shown, never used
              const picked = ok ? (prefs.speakers || []).filter((k) => k.startsWith(`${v.id}#`)) : [];
              const name = (
                <span className="voice-name">
                  <b>{v.name}</b>
                  {multi && <span className="muted voice-meta"><Users size={12} /> {v.speakers} speakers</span>}
                  {!ok && <span className="voice-warn"><TriangleAlert size={12} /> {v.unsupportedReason || "This voice isn't available in this version"}</span>}
                </span>
              );
              return (
                <div key={v.id} className="voice-item">
                  <div className="voice-row">
                    {!multi || !picked.length ? (
                      <label className={`voice-pick ${ok ? '' : 'off'}`}>
                        <input type="radio" name="voice" disabled={!ok} checked={ok && (current === v.id || (multi && current.startsWith(`${v.id}#`) && !picked.includes(current)))} onChange={() => onPick(v.id)} />
                        {name}
                      </label>
                    ) : <div className="voice-pick off"><span className="radio-spacer" />{name}</div>}
                    {ok && <SampleButton sample={sample} k={`p:${v.id}`} url={`/api/tts/preview?voice=${encodeURIComponent(v.id)}`} rate={prefs.rate} label="Preview" name={v.name} errorText={PREVIEW_ERROR} />}
                    {ok && multi && <button className="btn small ghost" onClick={() => setOpen(open === v.id ? '' : v.id)} aria-expanded={open === v.id}>{open === v.id ? 'Done' : 'Choose speakers'}</button>}
                    {isAdmin && <button className="icon-btn small" onClick={() => onRemove(v)} aria-label={`Remove ${v.name}`} title="Remove"><Trash2 size={15} /></button>}
                  </div>
                  {picked.map((k) => {
                    const speaker = k.split('#')[1];
                    return (
                      <div key={k} className="voice-row sub-row">
                        <label className="voice-pick">
                          <input type="radio" name="voice" checked={current === k} onChange={() => onPick(k)} />
                          <span className="voice-name">{v.name} · <b>{speaker}</b></span>
                        </label>
                        <SampleButton sample={sample} k={`p:${k}`} url={`/api/tts/preview?voice=${encodeURIComponent(k)}`} rate={prefs.rate} label="Preview" name={`${v.name} ${speaker}`} errorText={PREVIEW_ERROR} />
                        <button className="icon-btn small" onClick={() => onDrop(k)} aria-label={`Remove ${speaker} from my voices`} title="Remove from my voices"><X size={15} /></button>
                      </div>
                    );
                  })}
                  {ok && open === v.id && <SpeakerPicker voice={v} prefs={prefs} sample={sample} onAdd={onAdd} onDrop={onDrop} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

const SPEAKER_PAGE = 40;
function SpeakerPicker({ voice, prefs, sample, onAdd, onDrop }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(SPEAKER_PAGE);
  const all = voice.speakerNames.map((name, i) => ({ name, i }));
  const list = q ? all.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())) : all;
  const picked = new Set(prefs.speakers || []);
  const full = picked.size >= MAX_SPEAKERS;
  return (
    <div className="speaker-picker">
      <div className="speaker-head">
        <span className="muted">{full ? `You can keep up to ${MAX_SPEAKERS} speakers. Remove some to add others.` : 'Listen to the speakers and add the ones you like. They appear as voices of their own.'}</span>
        {all.length > 12 && <div className="searchbox" style={{ maxWidth: 220 }}><Search size={14} /><input className="input" value={q} onChange={(e) => { setQ(e.target.value); setLimit(SPEAKER_PAGE); }} placeholder="Find a speaker" aria-label="Find a speaker" /></div>}
      </div>
      <div className="speaker-grid">
        {list.slice(0, limit).map((s) => {
          const key = `${voice.id}#${s.name}`;
          const on = picked.has(key);
          const listening = sample.playing === `s:${key}`;
          return (
            <div key={s.name} className={`speaker ${on ? 'on' : ''}`}>
              <button className="icon-btn small" onClick={() => sample.play(`s:${key}`, `/api/tts/sample?voice=${encodeURIComponent(voice.id)}&speaker=${s.i}`, prefs.rate)} aria-label={`${listening ? 'Stop' : 'Listen to'} ${s.name}`}>
                {listening ? <Square size={11} fill="currentColor" /> : <Play size={13} />}
              </button>
              <span className="speaker-name">{s.name}</span>
              <button className={`btn small ${on ? 'primary' : ''}`} disabled={!on && full} onClick={() => (on ? onDrop(key) : onAdd(key))} aria-label={`Add ${s.name}`} aria-pressed={on}>{on ? <><Check size={13} />Added</> : <><Plus size={13} />Add</>}</button>
            </div>
          );
        })}
      </div>
      {list.length > limit && <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => setLimit(limit + SPEAKER_PAGE * 2)}>Show more ({list.length - limit} left)</button>}
    </div>
  );
}

function VoiceLibrary({ catalog, downloads, sample, isAdmin, rate, onInstall, onRefresh }) {
  const [lang, setLang] = useState('English');
  const [q, setQ] = useState('');
  const [hideInstalled, setHideInstalled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const byVoice = useMemo(() => Object.fromEntries(downloads.map((d) => [d.voice, d])), [downloads]);
  const languages = useMemo(() => {
    if (!catalog?.voices) return [];
    return groupBy(catalog.voices, (v) => v.languageName || v.language).map(([name, list]) => ({ name, count: list.length })).sort((a, b) => (a.name === 'English' ? -1 : b.name === 'English' ? 1 : a.name.localeCompare(b.name)));
  }, [catalog]);

  if (!catalog) return <section className="section"><h2>Voice library</h2><p className="sub"><LoaderCircle size={14} className="spin" /> Loading the Piper voice catalog…</p></section>;
  if (catalog.error) return <section className="section"><h2>Voice library</h2><p className="sub">{catalog.error}</p><button className="btn small" onClick={onRefresh}><RefreshCw size={14} />Try again</button></section>;

  const needle = q.trim().toLowerCase();
  const list = catalog.voices.filter((v) => (lang === 'all' || (v.languageName || v.language) === lang)
    && (!needle || `${v.name} ${v.region} ${v.languageName} ${v.languageNative} ${v.id}`.toLowerCase().includes(needle))
    && (!hideInstalled || !v.installed));
  const groups = groupBy(list, groupLabel);
  const langCount = languages.length;

  return (
    <section className="section">
      <h2>Voice library</h2>
      <p className="sub">All {catalog.voices.length} medium-quality Piper voices in {langCount} languages. Listen to a sample, then {isAdmin ? 'install the ones you want. Voices download once (60–80 MB each) and then run entirely on your server.' : 'ask an administrator to install the ones you want.'}</p>
      <div className="lib-controls">
        <select className="select" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language" style={{ maxWidth: 240 }}>
          <option value="all">All languages ({catalog.voices.length})</option>
          {languages.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.count})</option>)}
        </select>
        <div className="searchbox"><Search size={15} /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search voices" aria-label="Search voices" /></div>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={hideInstalled} onChange={(e) => setHideInstalled(e.target.checked)} /><span>Hide installed</span></label>
      </div>
      {groups.length === 0 && <p className="muted">No voices match.</p>}
      {groups.map(([group, voices]) => (
        <div key={group} className="voice-group">
          <div className="group-label">{group}</div>
          {voices.map((v) => {
            const d = byVoice[v.id];
            const busy = d && (d.status === 'queued' || d.status === 'downloading');
            const pct = d?.total ? Math.min(100, Math.round((d.bytes / d.total) * 100)) : 0;
            return (
              <div key={v.id} className="voice-row lib-row">
                <div className="voice-name">
                  <b>{v.name}</b>
                  <span className="muted voice-meta">{v.speakers > 1 ? <><Users size={12} /> {v.speakers} speakers · </> : null}{fmtSize(v.sizeBytes)}</span>
                  {busy && <div className="dl-bar" title={`${pct}%`}><div style={{ width: `${d.status === 'queued' ? 0 : pct}%` }} /></div>}
                  {d?.status === 'error' && <div className="dl-error">Download failed: {d.error}</div>}
                </div>
                <SampleButton sample={sample} k={`c:${v.id}`} url={`/api/tts/sample?voice=${encodeURIComponent(v.id)}&speaker=0`} rate={rate} label="Sample" name={v.name} />
                {v.supported === false ? <span className="lib-state lib-na" title={v.unsupportedReason || undefined}>Not available in this version</span>
                  : v.installed ? <span className="pill ok lib-state"><Check size={12} style={{ verticalAlign: -2 }} /> Installed</span>
                  : busy ? <span className="pill lib-state"><LoaderCircle size={12} className="spin" style={{ verticalAlign: -2 }} /> {d.status === 'queued' ? 'Queued' : `${pct}%`}</span>
                  : isAdmin ? <button className="btn small lib-state" onClick={() => onInstall(v.id)} aria-label={`Install ${v.name}`}><Download size={13} />Install</button>
                  : <span className="lib-state" />}
              </div>
            );
          })}
        </div>
      ))}
      <p className="muted" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
        Catalog from the rhasspy/piper-voices repository, updated {relDate(new Date(catalog.fetchedAt * 1000).toISOString())}{catalog.stale ? ' (offline copy)' : ''}.{' '}
        <button className="linklike" disabled={refreshing} onClick={async () => { setRefreshing(true); await onRefresh(); setRefreshing(false); }}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
      </p>
    </section>
  );
}
