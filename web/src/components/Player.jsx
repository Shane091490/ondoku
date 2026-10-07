import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, X, LoaderCircle, Check, AudioLines, ChevronDown } from 'lucide-react';
import { api } from '../api.js';
import { Menu } from './ui.jsx';
import { NaturalEngine } from '../lib/naturalEngine.js';
import { voiceChoices, groupBy } from '../lib/voices.js';
import { useApp } from '../App.jsx';
import { clock } from '../lib/format.js';

const RATES = [0.8, 1, 1.15, 1.3, 1.5, 1.75, 2];

// Connects the natural-voice (Piper) engine to the rendered article: highlights and follows the block being read,
// lets a tap on any paragraph jump there, and remembers where listening stopped. onFinished runs when playback
// reaches the end after a real share of the article was listened to (not just its last paragraph).
export function useReadAloud({ article, containerRef, user, setUser, appName, onFinished }) {
  const prefs = user.prefs;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);
  const engineRef = useRef(null);
  const lastEl = useRef(null);
  const userScrollAt = useRef(0);
  const saveTimer = useRef(null);
  const heard = useRef(new Set()); // paragraphs reached since the player was opened
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const total = article.segments.length;

  const getElement = useCallback((seg) => containerRef.current?.querySelector(`[data-seg="${seg}"]`), [containerRef]);

  const onSegment = useCallback((seg) => {
    heard.current.add(seg);
    const el = getElement(seg);
    if (lastEl.current && lastEl.current !== el) lastEl.current.classList.remove('speaking');
    if (el) {
      el.classList.add('speaking');
      lastEl.current = el;
      const r = el.getBoundingClientRect();
      const offscreen = r.top < 70 || r.bottom > window.innerHeight - 150;
      if (offscreen && Date.now() - userScrollAt.current > 4000) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => api.patch(`/api/articles/${article.id}`, { listenSeg: seg }).catch(() => {}), 1500);
  }, [getElement, article.id]);

  // Remember manual scrolling so auto-follow doesn't fight the reader.
  useEffect(() => {
    const mark = () => { userScrollAt.current = Date.now(); };
    window.addEventListener('wheel', mark, { passive: true });
    window.addEventListener('touchmove', mark, { passive: true });
    return () => { window.removeEventListener('wheel', mark); window.removeEventListener('touchmove', mark); };
  }, []);

  const savePrefs = useCallback((patch) => {
    api.patch('/api/me', { prefs: patch }).then((r) => setUser(r.user)).catch(() => {});
  }, [setUser]);

  const createEngine = useCallback(() => {
    engineRef.current?.destroy();
    const engine = new NaturalEngine({
      total, rate: prefs.rate, onState: setState, onSegment,
      onEnd: () => { if (heard.current.size >= Math.max(1, Math.ceil((total - 1) * 0.3))) finishedRef.current?.(); },
      articleId: article.id, voice: prefs.piperVoice,
      meta: { title: article.title, site: article.siteName || article.domain, image: article.leadImage, app: appName },
    });
    engineRef.current = engine;
    return engine;
  }, [total, prefs.rate, prefs.piperVoice, onSegment, article, appName]);

  function startSeg() {
    const resume = article.listenSeg > 0 && article.listenSeg < total - 1 ? article.listenSeg : 0;
    if (resume) return resume;
    if (window.scrollY < 250) return 0;
    // Start from the first paragraph on screen when the reader has scrolled down.
    for (let i = 1; i < total; i++) {
      const el = getElement(i);
      if (el && el.getBoundingClientRect().bottom > 80) return i;
    }
    return 0;
  }

  const start = useCallback((fromSeg) => {
    const seg = fromSeg ?? startSeg();
    heard.current = new Set();
    const engine = createEngine();
    setOpen(true);
    engine.start(seg);
    engine.play(seg);
  }, [createEngine]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    lastEl.current?.classList.remove('speaking');
    lastEl.current = null;
    setState(null);
    setOpen(false);
  }, []);

  const setRate = (r) => { engineRef.current?.setRate(r); savePrefs({ rate: r }); };
  const setVoice = (v) => { engineRef.current?.setVoice(v); savePrefs({ piperVoice: v }); };

  // Tap a paragraph to read from there.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !open) return undefined;
    const onClick = (e) => {
      if (e.target.closest('a, button, input')) return;
      if (window.getSelection()?.toString()) return;
      const block = e.target.closest('[data-seg]');
      if (!block) return;
      const seg = Number(block.getAttribute('data-seg'));
      userScrollAt.current = 0;
      const eng = engineRef.current;
      if (!eng) return;
      eng.wantPlay = true;
      eng.jump(seg);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [open, containerRef]);

  // Space toggles play/pause while the player is open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
      if (e.key === ' ') { e.preventDefault(); engineRef.current?.toggle(); }
      if (e.key === 'ArrowRight' && e.altKey) engineRef.current?.next();
      if (e.key === 'ArrowLeft' && e.altKey) engineRef.current?.prev();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => { document.body.classList.toggle('has-player', open); return () => document.body.classList.remove('has-player'); }, [open]);
  useEffect(() => () => { engineRef.current?.destroy(); clearTimeout(saveTimer.current); }, []);

  return { open, state, start, close, setRate, setVoice, engine: engineRef };
}

export function Player({ ra, tts, article }) {
  const s = ra.state || { status: 'loading', seg: 0, total: article.segments.length, rate: 1 };
  const eng = ra.engine.current;
  const playing = ['playing', 'buffering', 'loading'].includes(s.status) || (s.status === 'preparing' && eng?.wantPlay);
  const [scrub, setScrub] = useState(null);

  const nextRate = () => {
    const i = RATES.findIndex((r) => Math.abs(r - s.rate) < 0.01);
    ra.setRate(RATES[(i + 1) % RATES.length]);
  };

  const { user } = useApp();
  const voices = voiceChoices(tts?.voices, user.prefs, s.voice);
  const current = voices.find((v) => v.key === s.voice);

  let label;
  if (s.status === 'error') label = <b>{s.error}</b>;
  else if (s.prep && s.status !== 'playing') label = <><b>Preparing natural voice</b>{s.prep.total ? ` · ${Math.round((s.prep.done / s.prep.total) * 100)}%` : '…'}</>;
  else if (s.status === 'buffering') label = <b>Waiting for the next paragraph…</b>;
  else if (s.status === 'loading') label = <b>Starting…</b>;
  else if (s.status === 'ended') label = <b>Finished</b>;
  else label = <>Paragraph <b>{Math.max(1, s.seg)}</b> of {Math.max(1, s.total - 1)}</>;

  const fullAudio = s.ready && s.duration;
  const scrubValue = scrub ?? (fullAudio ? s.time : s.seg);
  const scrubMax = fullAudio ? s.duration : Math.max(1, s.total - 1);

  return (
    <div className="player" role="region" aria-label="Read aloud">
      <div className="player-card">
        <div className="player-top">
          <div className="what" aria-live="polite">{label}</div>
          {voices.length > 0 && (
            <Menu up label="Voice" className="voice-menu" trigger={({ toggle }) => <button className="voice-btn" onClick={toggle} aria-label="Choose voice" title="Choose voice"><AudioLines size={14} />{current?.label || 'Voice'}<ChevronDown size={14} /></button>}>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {groupBy(voices, (v) => v.group).map(([group, list]) => (
                  <React.Fragment key={group}>
                    <div className="menu-label">{group}</div>
                    {list.map((v) => (
                      <button key={v.key} role="menuitemradio" aria-checked={s.voice === v.key} onClick={() => ra.setVoice(v.key)}>
                        <span style={{ minWidth: 0 }}><span style={{ display: 'block' }}>{v.label}</span><span className="muted" style={{ fontSize: 12 }}>{v.hint}</span></span>
                        {s.voice === v.key && <Check size={15} className="sel" />}
                      </button>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </Menu>
          )}
          <button className="icon-btn small" onClick={ra.close} aria-label="Close player" title="Close"><X size={18} /></button>
        </div>
        <div className="player-main">
          <button className="icon-btn" onClick={() => eng?.prev()} aria-label="Previous paragraph" title="Previous paragraph"><SkipBack size={20} /></button>
          <button className="play-btn" onClick={() => eng?.toggle()} aria-label={playing ? 'Pause' : 'Play'}>
            {s.status === 'loading' || s.status === 'buffering' || (s.status === 'preparing' && eng?.wantPlay) ? <LoaderCircle size={22} className="spin" /> : playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" style={{ marginLeft: 3 }} />}
          </button>
          <button className="icon-btn" onClick={() => eng?.next()} aria-label="Next paragraph" title="Next paragraph"><SkipForward size={20} /></button>
          <div className="player-scrub">
            <input
              type="range" min={0} max={scrubMax} step={1} value={Math.min(scrubValue, scrubMax)}
              aria-label={fullAudio ? 'Position' : 'Paragraph'}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={() => commit()} onKeyUp={() => commit()} onTouchEnd={() => commit()}
            />
            <div className="player-times">
              {fullAudio ? <><span>{clock(scrubValue)}</span><span>-{clock(s.duration - scrubValue)}</span></> : <><span>¶ {Math.max(1, scrubValue)}</span><span>{Math.max(1, s.total - 1)}</span></>}
            </div>
          </div>
          <button className="speed-btn" onClick={nextRate} aria-label="Playback speed" title="Playback speed">{s.rate}×</button>
        </div>
        {s.prep && s.prep.total > 0 && <div className="prep-bar" aria-hidden="true"><div style={{ width: `${Math.round((s.prep.done / s.prep.total) * 100)}%` }} /></div>}
        {s.status === 'preparing' && !eng?.wantPlay && <div className="player-note">Generating audio on your server. Press play to start listening as soon as the first paragraph is ready.</div>}
      </div>
    </div>
  );

  function commit() {
    if (scrub == null) return;
    if (fullAudio) eng?.seekTo(scrub); else eng?.jump(scrub);
    setScrub(null);
  }
}
