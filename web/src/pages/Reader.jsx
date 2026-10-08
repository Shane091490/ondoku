import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Headphones, Star, Archive, ArchiveRestore, Ellipsis, ExternalLink, Copy, Share2, RotateCw, ClipboardPaste, Trash2,
  Tag, Type, LoaderCircle, TriangleAlert, Minus, Plus, Pencil, Check, Globe, Link2Off,
} from 'lucide-react';
import { api } from '../api.js';
import { goBack, navigate } from '../router.jsx';
import { useApp } from '../App.jsx';
import { Menu, Modal, Confirm, Switch, useToast } from '../components/ui.jsx';
import { PasteTextModal } from '../components/PasteText.jsx';
import { TagEditor } from '../components/TagEditor.jsx';
import { useReadAloud, Player } from '../components/Player.jsx';
import { useDisplay, setDisplay, FONTS, WIDTHS, THEMES } from '../lib/prefs.js';
import { longDate, minutes } from '../lib/format.js';
import { nextInQueue, prepareAudio, markPlayed, startListeningSession } from '../lib/playlist.js';
import { sleepAtEnd, sleepEndReached, sleepFiredRecently } from '../lib/sleep.js';

let ttsCache = null;

export default function Reader({ id, query }) {
  const [article, setArticle] = useState(null);
  const [error, setError] = useState('');
  const [tts, setTts] = useState(ttsCache);

  const load = useCallback(async (open) => {
    try {
      setArticle(await api.get(`/api/articles/${id}${open ? '?open=1' : ''}`));
    } catch (e) {
      setError(e.status === 404 ? 'This article no longer exists.' : e.message);
    }
  }, [id]);

  useEffect(() => { load(true); }, [load]);
  useEffect(() => {
    api.get('/api/tts/status').then((t) => { ttsCache = t; setTts(t); }).catch(() => setTts({ online: false, voices: [] }));
  }, []);
  useEffect(() => {
    if (article?.status !== 'pending') return undefined;
    const t = setInterval(() => load(false), 2000);
    return () => clearInterval(t);
  }, [article?.status, load]);

  if (error) {
    return (
      <div className="auth"><div className="empty"><TriangleAlert size={40} /><h3>{error}</h3><button className="btn" onClick={() => navigate('/')}>Back to your queue</button></div></div>
    );
  }
  if (!article) return <div className="auth"><LoaderCircle className="spin" size={28} color="var(--muted)" /></div>;
  return (
    <ReaderView
      key={article.contentHash || article.status} article={article} setArticle={setArticle} reload={() => load(false)} tts={tts}
      autoListen={query.get('listen') === '1'} continued={query.get('next') === '1'} queueStart={query.get('queue') === '1'}
    />
  );
}

// continued: opened by continuous play after the previous article ended; queueStart: "Play queue" in the list.
function ReaderView({ article: a, setArticle, reload, tts, autoListen, continued, queueStart }) {
  const { user, setUser, status } = useApp();
  const toast = useToast();
  const display = useDisplay();
  const containerRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const [barHidden, setBarHidden] = useState(false);
  const [progress, setProgress] = useState(a.progress || 0);
  const [modal, setModal] = useState(null);
  const ready = a.status === 'ok' && a.segments.length > 1;

  // Archiving a finished article (Settings > Reading). At most once per visit: after an undo it stays put.
  const auto = useRef({ done: false, timer: null, above: false, openedAt: Date.now() });
  const live = useRef({});
  async function autoArchive(how) {
    if (auto.current.done || live.current.archived) return;
    auto.current.done = true;
    const out = await patch({ archived: true, progress: 1 });
    if (!out) return;
    toast(how === 'listen' ? 'Finished listening · archived' : 'Finished · archived', { action: { label: 'Undo', onClick: () => patch({ archived: false }) } });
  }
  // Continuous play: the next article in the queue is worked out (and its audio prepared) once listening starts, and
  // takes over when this one ends, unless the sleep timer says to stop at the end of the article.
  const continuousOn = !!user.prefs.continuousPlay;
  const [upNext, setUpNext] = useState(null);
  const moving = useRef(false);
  async function playNext({ atEnd = false } = {}) {
    if (moving.current) return false;
    let next = upNext;
    if (!next) { try { next = await nextInQueue(a.id); } catch { next = null; } }
    if (!next) { if (atEnd) toast('That was the last article in your queue'); return false; }
    moving.current = true;
    navigate(`/read/${next.id}?listen=1&next=1`, { replace: true });
    return true;
  }
  const ra = useReadAloud({
    article: a, containerRef, user, setUser, appName: status.appName,
    onFinished: () => { if (user.prefs.archiveOnListen) autoArchive('listen'); },
    onEnded: () => {
      if (sleepAtEnd()) { sleepEndReached(); toast('Sleep timer: stopped at the end of the article'); return; }
      if (live.current.continuousOn) playNext({ atEnd: true });
    },
    onNextTrack: () => {
      if (!live.current.continuousOn || !live.current.upNext) return false;
      playNext();
      return true;
    },
  });
  useEffect(() => {
    if (!ra.open || !continuousOn) { setUpNext(null); return undefined; }
    let current = true;
    markPlayed(a.id);
    nextInQueue(a.id).then((n) => {
      if (!current) return;
      setUpNext(n);
      if (n) prepareAudio(n.id, ra.state?.voice || user.prefs.piperVoice);
    }).catch(() => {});
    return () => { current = false; };
  }, [ra.open, continuousOn, a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function toggleContinuous() {
    try { const r = await api.patch('/api/me', { prefs: { continuousPlay: !continuousOn } }); setUser(r.user); } catch (e) { toast(e.message, { error: true }); }
  }
  live.current = { archived: a.archived, prefs: user.prefs, listening: ra.open, ready, autoArchive, continuousOn, upNext };

  // Reaching the end counts once the reader has scrolled through the article (it started above the end, and the
  // page is long enough to scroll) and spent a little time on it: a quarter of its reading time, 8 to 30 seconds.
  // While read aloud is open, its own setting decides instead.
  const minDwell = Math.min(30, Math.max(8, (a.readingMinutes || 1) * 15)) * 1000;
  function checkFinished(p) {
    const f = auto.current;
    const l = live.current;
    if (p < 0.9) { f.above = true; clearTimeout(f.timer); f.timer = null; return; }
    if (p < 0.97 || !f.above || f.done || l.archived || l.listening || !l.ready || !l.prefs.archiveOnFinish) return;
    if (document.documentElement.scrollHeight - window.innerHeight < window.innerHeight * 0.5) return;
    const wait = minDwell - (Date.now() - f.openedAt);
    if (wait <= 0) l.autoArchive('read');
    else if (!f.timer) {
      f.timer = setTimeout(() => {
        f.timer = null;
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        checkFinished(window.scrollY / max);
      }, wait + 50);
    }
  }
  useEffect(() => () => clearTimeout(auto.current.timer), []);

  // Restore the reading position, then keep it saved.
  useEffect(() => {
    if (!ready || !(a.progress > 0.02 && a.progress < 0.97)) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, a.progress * max);
    }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let lastY = window.scrollY;
    let saveTimer = null;
    let lastSaved = a.progress || 0;
    const onScroll = () => {
      const y = window.scrollY;
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const p = Math.min(1, Math.max(0, y / max));
      setProgress(p);
      setScrolled(y > 120);
      checkFinished(p);
      if (Math.abs(y - lastY) > 6) { setBarHidden(y > lastY && y > 200); lastY = y; }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (Math.abs(p - lastSaved) < 0.01) return;
        lastSaved = p;
        api.patch(`/api/articles/${a.id}`, { progress: p }).catch(() => {});
      }, 1200);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); clearTimeout(saveTimer); };
  }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (queueStart) startListeningSession();
    // Continuous play arriving just after the sleep timer went off: stay quiet.
    if (autoListen && ready && !(continued && sleepFiredRecently())) ra.start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function patch(body, msg) {
    try {
      const out = await api.patch(`/api/articles/${a.id}`, body);
      setArticle((cur) => ({ ...cur, ...out, audio: cur.audio }));
      if (msg) toast(msg);
      return out;
    } catch (e) { toast(e.message, { error: true }); return null; }
  }

  async function archive() {
    const next = !a.archived;
    await patch({ archived: next, ...(next ? { progress: 1 } : {}) });
    if (next) {
      ra.close();
      toast('Archived', { action: { label: 'Undo', onClick: () => api.patch(`/api/articles/${a.id}`, { archived: false }).then(() => navigate(`/read/${a.id}`)) } });
      goBack('/');
    } else toast('Moved back to the queue');
  }

  async function refetch() {
    try { setArticle({ ...(await api.post(`/api/articles/${a.id}/refetch`)), audio: [] }); toast('Fetching the page again…'); } catch (e) { toast(e.message, { error: true }); }
  }

  async function share() {
    const url = a.url;
    if (navigator.share) { try { await navigator.share({ title: a.title, url }); } catch { /* cancelled */ } } else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  }

  useEffect(() => {
    const onKey = (e) => {
      if (modal || e.metaKey || e.ctrlKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (e.key === 'Escape' && !ra.open) goBack('/');
      else if (e.key === 's') patch({ starred: !a.starred });
      else if (e.key === 'a' && ready) archive();
      else if (e.key === 'l' && ready && !ra.open) ra.start();
      else if (e.key === 'o' && a.url) window.open(a.url, '_blank', 'noopener');
      else if (e.key === 'p') setDisplay({ showPhotos: !display.showPhotos });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const style = { '--reading-font': FONTS[display.font], '--reading-size': `${display.size}px`, '--reading-lh': display.lineHeight, '--measure': WIDTHS[display.width] };
  const site = a.siteName || a.domain;

  return (
    <div className="shell">
      <header className={`reader-bar ${scrolled ? 'scrolled' : ''} ${barHidden && !ra.open ? 'hidden' : ''}`}>
        <div className="reader-bar-inner">
          <button className="icon-btn" onClick={() => goBack('/')} aria-label="Back" title="Back"><ArrowLeft size={20} /></button>
          <div className="bar-title">{a.title}</div>
          <Menu label="Display" className="display-panel" trigger={({ toggle }) => <button className="icon-btn" onClick={toggle} aria-label="Display settings" title="Display"><Type size={19} /></button>}>
            <DisplayPanel display={display} />
          </Menu>
          {ready && <button className={`icon-btn ${ra.open ? 'on' : ''}`} onClick={() => (ra.open ? ra.close() : ra.start())} aria-label="Listen" title="Listen (l)"><Headphones size={19} /></button>}
          <button className={`icon-btn ${a.starred ? 'on' : ''}`} onClick={() => patch({ starred: !a.starred })} aria-label={a.starred ? 'Unstar' : 'Star'} aria-pressed={a.starred} title="Star (s)"><Star size={19} fill={a.starred ? 'currentColor' : 'none'} /></button>
          <button className="icon-btn hide-sm" onClick={archive} aria-label={a.archived ? 'Move to queue' : 'Archive'} title={a.archived ? 'Move to queue' : 'Archive (a)'}>{a.archived ? <ArchiveRestore size={19} /> : <Archive size={19} />}</button>
          <Menu label="More" trigger={({ toggle }) => <button className="icon-btn" onClick={toggle} aria-label="More actions"><Ellipsis size={19} /></button>}>
            <button className="show-sm-only" onClick={archive}>{a.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{a.archived ? 'Move to queue' : 'Archive'}</button>
            <button onClick={() => setModal('tags')}><Tag size={15} />Edit tags</button>
            <button onClick={() => setModal('title')}><Pencil size={15} />Rename</button>
            {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Open original</a>}
            {a.url && <button onClick={share}>{navigator.share ? <Share2 size={15} /> : <Copy size={15} />}{navigator.share ? 'Share link' : 'Copy link'}</button>}
            {a.status === 'ok' && <button onClick={() => setModal('public')}><Globe size={15} />{a.share ? 'Public link' : 'Share a public link'}</button>}
            {a.url && <button onClick={refetch}><RotateCw size={15} />Fetch again</button>}
            <button onClick={() => setModal('paste')}><ClipboardPaste size={15} />Paste the text</button>
            <hr />
            <button className="danger" onClick={() => setModal('delete')}><Trash2 size={15} />Delete</button>
          </Menu>
        </div>
        <div className="read-progress" style={{ width: `${progress * 100}%` }} />
      </header>

      <article className={`article ${ra.open ? 'listening' : ''} ${display.showPhotos ? '' : 'no-photos'} ${display.showLinks ? '' : 'no-links'}`} style={style} ref={containerRef} lang={a.lang || undefined}>
        <div className="article-kicker">
          {a.url ? <a href={a.url} target="_blank" rel="noopener noreferrer">{site}</a> : <span>{site || 'Pasted text'}</span>}
          {a.publishedAt && <span className="when">{longDate(a.publishedAt)}</span>}
        </div>
        <h1 className="article-title" data-seg="0">{a.title}</h1>
        {a.byline && <div className="article-byline">{/^by\s/i.test(a.byline) ? a.byline : `By ${a.byline}`}</div>}
        <div className="article-facts">
          {a.readingMinutes > 0 && <span>{minutes(a.readingMinutes)} read</span>}
          {a.wordCount > 0 && <span className="dot">{a.wordCount.toLocaleString()} words</span>}
          {a.source !== 'url' && <span className="dot">{a.source === 'text' ? 'Pasted text' : 'Supplied HTML'}</span>}
          {a.feed && <span className="dot">From {a.feed.title}</span>}
          {a.share && <span className="dot"><Globe size={12} style={{ verticalAlign: -1 }} /> Shared publicly</span>}
        </div>
        <div className="article-tags">
          {a.tags.map((t) => <a key={t} className="chip" href={`#/all?tag=${encodeURIComponent(t)}`}>#{t}</a>)}
          <button className="chip add-tag" onClick={() => setModal('tags')}><Tag size={12} />{a.tags.length ? 'Edit tags' : 'Add tags'}</button>
        </div>
        <hr className="article-rule" />

        {a.status === 'pending' && (
          <div className="reader-notice"><span className="status pending"><LoaderCircle size={15} className="spin" />Fetching and cleaning up the article…</span></div>
        )}
        {a.status === 'failed' && (
          <div className="reader-notice failed">
            <b>Couldn't get the article text.</b>
            <div style={{ marginTop: 4, color: 'var(--text-soft)' }}>{a.error}</div>
            <div className="actions">
              <button className="btn small" onClick={refetch}><RotateCw size={14} />Try again</button>
              <button className="btn small" onClick={() => setModal('paste')}><ClipboardPaste size={14} />Paste the text</button>
              {a.url && <a className="btn small ghost" href={a.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />Open original</a>}
            </div>
          </div>
        )}

        {display.showPhotos && a.leadImage && !a.leadInContent && a.status === 'ok' && (
          <figure className="lead-figure"><img src={a.leadImage} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }} /></figure>
        )}
        {/* Sanitized on the server (DOMPurify) and protected by a strict CSP. */}
        <div className="article-body" dangerouslySetInnerHTML={{ __html: a.contentHtml }} />

        {ready && (
          <div className="article-end">
            {a.url && <div className="source">Source: <a href={a.url} target="_blank" rel="noopener noreferrer">{a.url}</a></div>}
            <button className="btn primary" onClick={archive}>{a.archived ? <><ArchiveRestore size={17} />Move back to queue</> : <><Check size={17} />Done, archive it</>}</button>
            <button className="btn ghost" onClick={() => goBack('/')}>Back to list</button>
          </div>
        )}
      </article>

      {ra.open && <Player ra={ra} tts={tts} article={a} continuous={{ on: continuousOn, upNext, toggle: toggleContinuous, skip: () => playNext() }} />}

      {modal === 'paste' && <PasteTextModal article={a} onClose={() => setModal(null)} onSaved={(out) => { setModal(null); ra.close(); setArticle({ ...out, audio: [] }); }} />}
      {modal === 'tags' && <TagEditor article={a} onClose={() => setModal(null)} onSaved={(out) => { setArticle((cur) => ({ ...cur, ...out, audio: cur.audio })); setModal(null); }} />}
      {modal === 'public' && <PublicLinkModal article={a} onClose={() => setModal(null)} onChange={(share) => setArticle((cur) => ({ ...cur, share }))} />}
      {modal === 'title' && <TitleModal article={a} onClose={() => setModal(null)} onSave={async (title) => { await patch({ title }); setModal(null); reload(); }} />}
      {modal === 'delete' && (
        <Confirm
          title="Delete this article?"
          message="It and any generated audio will be removed for good."
          onClose={() => setModal(null)}
          onConfirm={async () => { ra.close(); await api.del(`/api/articles/${a.id}`); toast('Deleted'); navigate('/', { replace: true }); }}
        />
      )}
    </div>
  );
}

function DisplayPanel({ display: d }) {
  const swatch = { night: ['#141416', '#ebe7df'], black: ['#000', '#e3dfd7'], sepia: ['#f3ead7', '#3a2f22'], light: ['#fbfaf7', '#1f1d1a'] };
  return (
    <div data-keep-open>
      <div className="row2">
        <span className="label">Photos</span>
        <Switch checked={d.showPhotos} onChange={(on) => setDisplay({ showPhotos: on })} label="Show photos" hint={d.showPhotos ? 'Shown' : 'Hidden'} />
      </div>
      <div className="row2">
        <span className="label">Links</span>
        <Switch checked={d.showLinks} onChange={(on) => setDisplay({ showLinks: on })} label="Show links" hint={d.showLinks ? 'Shown' : 'Hidden'} />
      </div>
      <div className="label" style={{ marginBottom: 8 }}>Theme</div>
      <div className="themes">
        {THEMES.map((t) => (
          <button key={t} className={`theme-swatch ${d.theme === t ? 'on' : ''}`} style={{ background: swatch[t][0], color: swatch[t][1] }} onClick={() => setDisplay({ theme: t })} aria-label={`${t} theme`} title={t[0].toUpperCase() + t.slice(1)}>Aa</button>
        ))}
      </div>
      <div className="label" style={{ marginBottom: 8 }}>Typeface</div>
      <div className="fonts">
        <button className={d.font === 'serif' ? 'on' : ''} style={{ fontFamily: 'var(--serif)' }} onClick={() => setDisplay({ font: 'serif' })}>Serif</button>
        <button className={d.font === 'sans' ? 'on' : ''} style={{ fontFamily: 'var(--ui)' }} onClick={() => setDisplay({ font: 'sans' })}>Sans</button>
        <button className={d.font === 'hyper' ? 'on' : ''} style={{ fontFamily: 'var(--hyper)' }} onClick={() => setDisplay({ font: 'hyper' })} title="Atkinson Hyperlegible">Legible</button>
      </div>
      <div className="row2">
        <span className="label">Size</span>
        <div className="stepper">
          <button onClick={() => setDisplay({ size: Math.max(14, d.size - 1) })} aria-label="Smaller text"><Minus size={15} /></button>
          <span>{d.size}</span>
          <button onClick={() => setDisplay({ size: Math.min(28, d.size + 1) })} aria-label="Larger text"><Plus size={15} /></button>
        </div>
      </div>
      <div className="row2">
        <span className="label">Spacing</span>
        <div className="seg-control">
          {[[1.5, 'Tight'], [1.7, 'Normal'], [1.9, 'Loose']].map(([v, l]) => <button key={v} className={d.lineHeight === v ? 'on' : ''} onClick={() => setDisplay({ lineHeight: v })}>{l}</button>)}
        </div>
      </div>
      <div className="row2" style={{ marginBottom: 0 }}>
        <span className="label">Width</span>
        <div className="seg-control">
          {['narrow', 'medium', 'wide'].map((w) => <button key={w} className={d.width === w ? 'on' : ''} onClick={() => setDisplay({ width: w })}>{w[0].toUpperCase() + w.slice(1)}</button>)}
        </div>
      </div>
    </div>
  );
}

function TitleModal({ article, onClose, onSave }) {
  const [title, setTitle] = useState(article.title);
  return (
    <Modal title="Rename" onClose={onClose}>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) onSave(title.trim()); }} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!title.trim()} onClick={() => onSave(title.trim())}>Save</button>
      </div>
    </Modal>
  );
}

// A public link anyone can open without signing in, until sharing stops.
function PublicLinkModal({ article, onClose, onChange }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const share = article.share;
  async function create() {
    setBusy(true);
    try { onChange(await api.post(`/api/articles/${article.id}/share`)); } catch (e) { toast(e.message, { error: true }); }
    setBusy(false);
  }
  async function stop() {
    setBusy(true);
    try { await api.del(`/api/articles/${article.id}/share`); onChange(null); toast('Stopped sharing'); onClose(); } catch (e) { toast(e.message, { error: true }); }
    setBusy(false);
  }
  async function send() {
    if (navigator.share) { try { await navigator.share({ title: article.title, url: share.url }); } catch { /* cancelled */ } } else { await navigator.clipboard.writeText(share.url); toast('Link copied'); }
  }
  return (
    <Modal title="Public link" sub={share ? 'Anyone with this link can read the article, with its pictures, without signing in.' : 'Create a link that anyone can open to read this article, with its pictures, without signing in. Nothing about your account is shown, and you can stop sharing at any time.'} onClose={onClose}>
      {share ? (
        <>
          <input className="input" readOnly value={share.url} onFocus={(e) => e.target.select()} aria-label="Public link" />
          <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>Opened {share.views} {share.views === 1 ? 'time' : 'times'}. Search engines are asked not to list it.</p>
          <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
            <button className="btn danger ghost" disabled={busy} onClick={stop}><Link2Off size={15} />Stop sharing</button>
            <span style={{ flex: 1 }} />
            <a className="btn ghost" href={share.url} target="_blank" rel="noopener noreferrer">Open</a>
            <button className="btn primary" onClick={send}>{navigator.share ? <Share2 size={15} /> : <Copy size={15} />}{navigator.share ? 'Share' : 'Copy'}</button>
          </div>
        </>
      ) : (
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={create}><Globe size={15} />Create link</button>
        </div>
      )}
    </Modal>
  );
}
