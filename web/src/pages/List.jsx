import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Link2, Plus, Search, Star, Archive, ArchiveRestore, Headphones, Ellipsis, ExternalLink, Copy, Trash2, RotateCw, ClipboardPaste,
  LoaderCircle, TriangleAlert, Tag, ArrowUpDown, X, Inbox, Library, Check, LayoutList, Minus, Settings2, Smartphone,
} from 'lucide-react';
import { api, qs } from '../api.js';
import { Link, navigate } from '../router.jsx';
import Header from '../components/Header.jsx';
import { useApp } from '../App.jsx';
import { Menu, Modal, Confirm, useToast } from '../components/ui.jsx';
import { PasteTextModal } from '../components/PasteText.jsx';
import { TagEditor } from '../components/TagEditor.jsx';
import { relDate, minutes, snippetParts, aboutDays } from '../lib/format.js';
import { recall, remember, useDisplay, setDisplay, stepListScale, LIST_SCALES } from '../lib/prefs.js';
import { useInstall, promptInstall, isTouch } from '../lib/pwa.js';

const PAGE = 40;
const SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['shortest', 'Shortest first'],
  ['longest', 'Longest first'],
];
const EMPTY = {
  queue: { icon: Inbox, title: 'Your queue is clear', text: 'Paste a link above, share from your phone, or use the bookmarklet in Settings.' },
  starred: { icon: Star, title: 'Nothing starred yet', text: 'Star the pieces worth keeping and they collect here.' },
  archive: { icon: Archive, title: 'The archive is empty', text: 'Articles you finish move here.' },
  all: { icon: Library, title: 'Nothing saved yet', text: 'Paste a link above to save your first article.' },
};

export default function List({ view, query }) {
  const toast = useToast();
  const { user, status } = useApp();
  const keepDays = user.prefs.deleteArchivedAfterDays;
  const tag = query.get('tag') || '';
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState(() => recall(`sort.${view}`, 'newest'));
  const [data, setData] = useState({ items: [], total: 0, counts: null });
  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState([]);
  const [pasteFor, setPasteFor] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [tagFor, setTagFor] = useState(null);
  const limitRef = useRef(PAGE);
  const searchRef = useRef(null);
  const display = useDisplay();
  const compact = display.listLayout === 'compact';

  useEffect(() => { setSort(recall(`sort.${view}`, 'newest')); limitRef.current = PAGE; }, [view]);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async ({ quiet } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const out = await api.get(`/api/articles${qs({ view, q: debounced, tag, sort: debounced ? 'relevance' : sort, limit: limitRef.current })}`);
      setData(out);
    } catch (e) {
      if (!quiet) toast(e.message, { error: true });
    } finally {
      setLoading(false);
    }
  }, [view, debounced, tag, sort, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/api/tags').then(setTags).catch(() => {}); }, [data.counts?.all]);

  // While pages are being fetched, refresh quietly so titles and text appear on their own.
  const pending = data.items.some((a) => a.status === 'pending') || data.counts?.pending > 0;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(() => load({ quiet: true }), 2500);
    return () => clearInterval(t);
  }, [pending, load]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const patchLocal = (id, patch) => setData((d) => ({ ...d, items: d.items.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const removeLocal = (id) => setData((d) => ({ ...d, items: d.items.filter((a) => a.id !== id), total: d.total - 1 }));

  async function update(a, patch, { undoLabel } = {}) {
    const leaves = (view === 'queue' && patch.archived) || (view === 'archive' && patch.archived === false) || (view === 'starred' && patch.starred === false);
    if (leaves) removeLocal(a.id); else patchLocal(a.id, patch);
    try {
      await api.patch(`/api/articles/${a.id}`, patch);
      if (undoLabel) {
        const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, a[k]]));
        toast(undoLabel, { action: { label: 'Undo', onClick: async () => { await api.patch(`/api/articles/${a.id}`, undo); load({ quiet: true }); } } });
      }
      load({ quiet: true });
    } catch (e) {
      toast(e.message, { error: true });
      load({ quiet: true });
    }
  }

  async function retry(a) {
    patchLocal(a.id, { status: 'pending', error: null });
    try { await api.post(`/api/articles/${a.id}/refetch`); load({ quiet: true }); } catch (e) { toast(e.message, { error: true }); }
  }

  function changeSort(s) { setSort(s); remember(`sort.${view}`, s); limitRef.current = PAGE; }
  function setTag(t) { navigate(`${view === 'queue' ? '/' : `/${view}`}${t ? `?tag=${encodeURIComponent(t)}` : ''}`); }

  const empty = EMPTY[view];
  const searching = !!debounced;

  return (
    <div className="shell">
      <Header view={view} counts={data.counts} />
      <main className="page">
        {view === 'queue' && <InstallCard appName={status.appName} />}
        {view !== 'archive' && <AddBar onSaved={() => load({ quiet: true })} onPasteText={() => setPasteFor({})} />}

        <div className="toolbar">
          <SearchBox value={q} onChange={setQ} tags={tags} inputRef={searchRef} />
          <Menu label="Filter by tag" trigger={({ toggle }) => <button className={`chip ${tag ? 'on' : ''}`} onClick={toggle}><Tag size={13} />{tag || 'Tags'}</button>}>
            <div className="menu-label">Filter by tag</div>
            {tags.length === 0 && <div className="menu-empty">No tags yet. Tag an article from its ⋯ menu, or add #tags after a link when you save it.</div>}
            {tag && <button onClick={() => setTag('')}><X size={15} />Clear filter</button>}
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {tags.map((t) => (
                <button key={t.id} onClick={() => setTag(t.name)}>
                  <Tag size={15} />{t.name}<span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{t.count}</span>
                  {tag === t.name && <Check size={15} className="sel" />}
                </button>
              ))}
            </div>
            {tags.length > 0 && <><hr /><a href="#/settings/tags"><Settings2 size={15} />Manage tags</a></>}
          </Menu>
          {!searching && (
            <Menu label="Sort" trigger={({ toggle }) => <button className="chip" onClick={toggle} title="Sort"><ArrowUpDown size={13} /><span className="hide-sm">{SORTS.find((s) => s[0] === sort)?.[1]}</span></button>}>
              <div className="menu-label">Sort</div>
              {SORTS.map(([k, label]) => <button key={k} onClick={() => changeSort(k)}>{label}{sort === k && <Check size={15} className="sel" />}</button>)}
            </Menu>
          )}
          <Menu label="View" className="display-panel" trigger={({ toggle }) => <button className="chip" onClick={toggle} title="Layout and text size" aria-label="Layout and text size"><LayoutList size={13} /><span className="hide-sm">View</span></button>}>
            <ViewPanel display={display} />
          </Menu>
        </div>

        {tag && (
          <div className="list-meta"><span>Tagged <b style={{ color: 'var(--text)' }}>{tag}</b></span><button className="linklike" onClick={() => setTag('')}>Show all</button></div>
        )}
        {searching && !loading && <div className="list-meta"><span>{data.total} {data.total === 1 ? 'match' : 'matches'} for “{debounced}”</span></div>}
        {view === 'archive' && keepDays > 0 && data.items.length > 0 && (
          <div className="list-meta archive-note">
            <span>Deleted {keepDays} days{aboutDays(keepDays) ? ` (${aboutDays(keepDays)})` : ''} after archiving. Starred articles are kept.</span>
            <Link to="/settings/reading" className="linklike">Change</Link>
          </div>
        )}

        {!loading && data.items.length === 0 ? (
          searching || tag ? (
            <div className="empty"><Search size={40} /><h3>No matches</h3><p>Try other words, or look in another list.</p></div>
          ) : (
            <div className="empty"><empty.icon size={44} /><h3>{empty.title}</h3><p>{empty.text}</p></div>
          )
        ) : (
          <ul className={`rows ${compact ? 'compact' : ''}`} style={{ '--list-scale': display.listScale }}>
            {data.items.map((a) => (
              <ArticleRow
                key={a.id}
                a={a}
                compact={compact}
                onStar={() => update(a, { starred: !a.starred })}
                onArchive={() => update(a, { archived: !a.archived }, { undoLabel: a.archived ? 'Moved back to the queue' : 'Archived' })}
                onRetry={() => retry(a)}
                onPaste={() => setPasteFor(a)}
                onDelete={() => setConfirmDelete(a)}
                onTag={setTag}
                onEditTags={() => setTagFor(a)}
              />
            ))}
          </ul>
        )}
        {loading && data.items.length === 0 && <div className="empty"><LoaderCircle className="spin" size={28} /></div>}
        {data.items.length < data.total && (
          <div className="load-more"><button className="btn" onClick={() => { limitRef.current += PAGE; load({ quiet: true }); }}>Show more</button></div>
        )}
      </main>

      {pasteFor && <PasteTextModal article={pasteFor.id ? pasteFor : null} onClose={() => setPasteFor(null)} onSaved={(art) => { setPasteFor(null); load({ quiet: true }); if (!pasteFor.id) navigate(`/read/${art.id}`); }} />}
      {tagFor && (
        <TagEditor
          article={tagFor}
          onClose={() => setTagFor(null)}
          onSaved={(out) => { setTagFor(null); patchLocal(out.id, { tags: out.tags }); api.get('/api/tags').then(setTags).catch(() => {}); load({ quiet: true }); }}
        />
      )}
      {confirmDelete && (
        <Confirm
          title="Delete this article?"
          message={`“${confirmDelete.title}” and its saved audio will be removed for good.`}
          onClose={() => setConfirmDelete(null)}
          onConfirm={async () => { await api.del(`/api/articles/${confirmDelete.id}`); removeLocal(confirmDelete.id); toast('Deleted'); load({ quiet: true }); }}
        />
      )}
    </div>
  );
}

// Search box. Typing "#" suggests your tags; Enter or Tab (or a click) completes the tag. The server treats each #tag as a
// filter and the remaining words as a full-text search (which also matches tag names).
function SearchBox({ value, onChange, tags, inputRef }) {
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const before = value.slice(0, caret);
  const m = /(^|\s)#"?([^\s#"]*)$/.exec(before);
  const partial = m ? m[2].toLowerCase() : null;
  const hashAt = m ? before.length - m[0].length + m[1].length : -1; // position of the "#" being typed
  // Tags already in the search (other than the one being typed) aren't suggested again.
  const already = new Set([...value.slice(0, Math.max(hashAt, 0)).matchAll(/(^|\s)#(?:"([^"]+)"|([^\s#"]+))/g)].map((x) => (x[2] || x[3]).toLowerCase()));
  const suggestions = partial === null ? [] : tags
    .filter((t) => t.name.includes(partial) && !already.has(t.name))
    .sort((a, b) => Number(b.name.startsWith(partial)) - Number(a.name.startsWith(partial)) || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8);
  const open = focused && suggestions.length > 0;
  useEffect(() => { setActive(0); }, [partial]);

  function pick(t) {
    const start = hashAt;
    const token = /\s/.test(t.name) ? `#"${t.name}"` : `#${t.name}`;
    const rest = value.slice(caret).replace(/^\S*/, '');
    const next = `${value.slice(0, start)}${token} ${rest.replace(/^\s+/, '')}`;
    onChange(next);
    const pos = start + token.length + 1;
    setCaret(pos);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos, pos); });
  }
  const sync = (e) => setCaret(e.target.selectionStart ?? e.target.value.length);
  return (
    <div className="searchbox">
      <Search size={16} />
      <input
        ref={inputRef}
        className="input"
        type="search"
        placeholder="Search, or #tag"
        value={value}
        aria-label="Search articles or tags"
        role="combobox"
        aria-expanded={open}
        aria-controls="tag-suggestions"
        aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); sync(e); }}
        onSelect={sync}
        onFocus={(e) => { setFocused(true); sync(e); }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % suggestions.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + suggestions.length) % suggestions.length); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggestions[active]); }
          else if (e.key === 'Escape') { e.preventDefault(); setFocused(false); }
        }}
      />
      {open && (
        <ul className="suggest" id="tag-suggestions" role="listbox" aria-label="Tags">
          {suggestions.map((t, i) => (
            <li key={t.id} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(t); }} onMouseEnter={() => setActive(i)}>
              <Tag size={14} /><span className="suggest-name">{t.name}</span><span className="muted">{t.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// List layout and text size (per device). Standard shows the summary, tags and buttons; Compact shows only the
// photo, title, source and time.
function ViewPanel({ display }) {
  const pct = Math.round(display.listScale * 100);
  return (
    <div data-keep-open>
      <div className="label" style={{ marginBottom: 8 }}>Layout</div>
      <div className="seg-control layout-choice" role="radiogroup" aria-label="Layout" style={{ marginBottom: 14 }}>
        <button role="radio" aria-checked={display.listLayout !== 'compact'} className={display.listLayout !== 'compact' ? 'on' : ''} onClick={() => setDisplay({ listLayout: 'standard' })}>Standard</button>
        <button role="radio" aria-checked={display.listLayout === 'compact'} className={display.listLayout === 'compact' ? 'on' : ''} onClick={() => setDisplay({ listLayout: 'compact' })}>Compact</button>
      </div>
      <div className="row2" style={{ marginBottom: 0 }}>
        <span className="label">Text size</span>
        <div className="stepper">
          <button onClick={() => setDisplay({ listScale: stepListScale(display.listScale, -1) })} disabled={display.listScale <= LIST_SCALES[0]} aria-label="Smaller text"><Minus size={15} /></button>
          <span aria-live="polite">{pct}%</span>
          <button onClick={() => setDisplay({ listScale: stepListScale(display.listScale, 1) })} disabled={display.listScale >= LIST_SCALES[LIST_SCALES.length - 1]} aria-label="Larger text"><Plus size={15} /></button>
        </div>
      </div>
    </div>
  );
}

function AddBar({ onSaved, onPasteText }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  async function save(e) {
    e.preventDefault();
    // "#tags" typed after the link tag the article ("#" right after a URL character is a fragment, not a tag).
    const tagRe = /(^|\s)#(?:"([^"]+)"|([^\s#"]+))/g;
    const tags = [...url.matchAll(tagRe)].map((m) => (m[2] || m[3]).trim()).filter(Boolean);
    const value = url.replace(tagRe, ' ').trim();
    if (!value) return;
    setBusy(true);
    try {
      const out = await api.post('/api/articles', { url: value, ...(tags.length ? { tags } : {}) });
      setUrl('');
      if (out.created) {
        toast(`Saved ${out.created.length} ${out.created.length === 1 ? 'link' : 'links'}${out.duplicates.length ? `, ${out.duplicates.length} already saved` : ''}${out.invalid.length ? `, ${out.invalid.length} skipped` : ''}`);
      } else if (out.duplicate) toast('Already saved. Moved it to the top of your queue.');
      onSaved();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="addbar" onSubmit={save}>
        <div className="addbar-wrap">
          <Link2 size={17} />
          <input className="input" type="text" inputMode="url" placeholder="Paste a link to save…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Article link" autoComplete="off" autoCapitalize="off" spellCheck="false" />
        </div>
        <button className="btn primary" disabled={busy || !url.trim()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}<span>Save</span></button>
      </form>
      <div className="addbar-links">
        <span className="hide-sm">Tip: add #tags after the link</span>
        <button className="linklike" onClick={onPasteText}>Paste text instead</button>
        <button className="linklike" onClick={() => setImportOpen(true)}>Add many links</button>
      </div>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); onSaved(); }} />}
    </>
  );
}

function ImportModal({ onClose, onDone }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const count = (text.match(/https?:\/\/[^\s<>"']+/gi) || []).length;
  async function go() {
    setBusy(true);
    try {
      const r = await api.post('/api/import', { text });
      toast(`Added ${r.created} of ${r.found} links${r.duplicates ? ` (${r.duplicates} already saved)` : ''}`);
      onDone();
    } catch (e) { toast(e.message, { error: true }); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add many links" sub="Paste anything containing links: a list, an export from another app, an email. Every http(s) link is saved and fetched in the background." onClose={onClose}>
      <textarea className="textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'https://…\nhttps://…'} autoFocus />
      <div className="modal-actions">
        <span className="muted" style={{ marginRight: 'auto', alignSelf: 'center', fontSize: 13 }}>{count} {count === 1 ? 'link' : 'links'} found</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!count || busy} onClick={go}>Save links</button>
      </div>
    </Modal>
  );
}

// Phones: a card offering to install the app (the browser's install dialog, or the Safari steps), until it's
// installed or dismissed.
function InstallCard({ appName }) {
  const inst = useInstall();
  const [hidden, setHidden] = useState(() => recall('installDismissed', false));
  if (hidden || inst.installed || !isTouch() || !(inst.canPrompt || inst.ios)) return null;
  const dismiss = () => { remember('installDismissed', true); setHidden(true); };
  return (
    <div className="install-card" role="region" aria-label={`Install ${appName}`}>
      <span className="install-icon"><Smartphone size={18} /></span>
      <div className="install-text">
        <b>Install {appName} on this phone</b>
        <span>{!inst.canPrompt
          ? 'Tap Share, then Add to Home Screen. It opens full screen and keeps the articles you open readable offline.'
          : inst.shortcutOnly
            ? `It opens like an app and keeps the articles you open readable offline. To share articles to it from other apps, install it from Chrome: ${inst.shortcutOnly} adds a shortcut the share menu doesn't list.`
            : 'It opens like an app, shows up in the share menu, and keeps the articles you open readable offline.'}</span>
      </div>
      <div className="install-actions">
        {inst.canPrompt && <button className="btn small primary" onClick={() => promptInstall()}>Install</button>}
        <button className="btn small ghost" onClick={dismiss}>Not now</button>
      </div>
    </div>
  );
}

// Swiping a row on a touch screen: left runs onLeft (archive, or back to the queue), right runs onRight (star).
// The row follows the finger and acts when let go past a third of its width (at most 110px). Mostly vertical moves
// scroll the page as usual, and touches at the screen edges are left to the system's back gesture.
function useSwipe(onLeft, onRight) {
  const ref = useRef(null);
  const [drag, setDrag] = useState({ dx: 0, active: false });
  const actions = useRef({ onLeft, onRight });
  actions.current = { onLeft, onRight };
  useEffect(() => {
    const el = ref.current;
    if (!el || !isTouch()) return undefined;
    let x0 = 0, y0 = 0, mode = null, cur = 0, frame = 0;
    const show = (dx, active) => { cur = dx; cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setDrag({ dx, active })); };
    const start = (e) => {
      if (e.touches.length !== 1 || e.target.closest('.menu')) { mode = 'off'; return; }
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      mode = x0 < 24 || x0 > window.innerWidth - 24 ? 'off' : null;
    };
    const move = (e) => {
      if (mode === 'off' || mode === 'scroll') return;
      const dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (!mode) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        mode = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'swipe' : 'scroll';
        if (mode === 'scroll') return;
      }
      e.preventDefault();
      show(dx, true);
    };
    const end = () => {
      if (mode === 'swipe') {
        const limit = Math.min(110, el.offsetWidth / 3);
        if (cur <= -limit) actions.current.onLeft?.();
        else if (cur >= limit) actions.current.onRight?.();
      }
      mode = null;
      show(0, false);
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, []);
  const armed = Math.abs(drag.dx) >= Math.min(110, (ref.current?.offsetWidth || 330) / 3);
  return { ref, ...drag, armed };
}

function ArticleRow({ a, compact, onStar, onArchive, onRetry, onPaste, onDelete, onTag, onEditTags }) {
  const toast = useToast();
  const [imgOk, setImgOk] = useState(true);
  // A swipe gives no other sign of a star in the compact layout (its star button is hidden on touch screens).
  const swipe = useSwipe(onArchive, () => { onStar(); toast(a.starred ? 'Unstarred' : 'Starred'); });
  const href = `/read/${a.id}`;
  const pending = a.status === 'pending';
  const failed = a.status === 'failed';
  const thumb = a.leadImage && imgOk && !failed;
  const site = a.siteName || a.domain || 'Pasted text';
  const thumbLink = thumb && (
    <Link to={href} className="row-thumb" tabIndex={-1} aria-hidden="true">
      <img className="thumb" src={a.leadImage} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
    </Link>
  );
  const starBtn = <button className={`icon-btn small ${a.starred ? 'on' : ''}`} title={a.starred ? 'Unstar' : 'Star'} aria-label={a.starred ? 'Unstar' : 'Star'} aria-pressed={a.starred} onClick={onStar}><Star size={17} fill={a.starred ? 'currentColor' : 'none'} /></button>;
  const archiveBtn = <button className="icon-btn small" title={a.archived ? 'Move to queue' : 'Archive'} aria-label={a.archived ? 'Move to queue' : 'Archive'} onClick={onArchive}>{a.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}</button>;
  const moreMenu = (
    <Menu label="More actions" trigger={({ toggle }) => <button className="icon-btn small" aria-label="More actions" onClick={toggle}><Ellipsis size={17} /></button>}>
      {compact && !failed && <button disabled={pending} onClick={() => navigate(`${href}?listen=1`)}><Headphones size={15} />Listen</button>}
      {compact && <button onClick={onStar}><Star size={15} fill={a.starred ? 'currentColor' : 'none'} />{a.starred ? 'Unstar' : 'Star'}</button>}
      {compact && <button onClick={onArchive}>{a.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{a.archived ? 'Move to queue' : 'Archive'}</button>}
      <button onClick={onEditTags}><Tag size={15} />{a.tags.length ? 'Edit tags' : 'Add tags'}</button>
      {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Open original</a>}
      {a.url && <button onClick={() => navigator.clipboard.writeText(a.url).then(() => toast('Link copied'))}><Copy size={15} />Copy link</button>}
      {a.url && !pending && <button onClick={onRetry}><RotateCw size={15} />Fetch again</button>}
      <button onClick={onPaste}><ClipboardPaste size={15} />Paste the text</button>
      <hr />
      <button className="danger" onClick={onDelete}><Trash2 size={15} />Delete</button>
    </Menu>
  );
  const progress = a.progress > 0.02 && !a.archived && <div className="row-progress" style={{ width: `${Math.round(a.progress * 100)}%` }} />;
  // The row slides over a hint of what letting go will do.
  const swipeHint = swipe.dx !== 0 && (
    <div className={`swipe-hint ${swipe.dx < 0 ? 'left' : 'right'} ${swipe.armed ? 'armed' : ''}`} aria-hidden="true">
      {swipe.dx < 0
        ? <>{a.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}{a.archived ? 'Move to queue' : 'Archive'}</>
        : <><Star size={18} fill={a.starred ? 'none' : 'currentColor'} />{a.starred ? 'Unstar' : 'Star'}</>}
    </div>
  );
  const itemProps = { ref: swipe.ref, className: `row-item ${swipe.active ? 'swiping' : ''}` };
  const slide = swipe.dx ? { transform: `translateX(${swipe.dx}px)` } : undefined;

  // Compact: only the photo, title, source and time. The buttons appear on hover (devices with a mouse); touch
  // screens get the ⋯ menu, which then also has Star and Archive.
  if (compact) {
    return (
      <li {...itemProps}>
        {swipeHint}
        <div className={`row compact ${pending ? 'pending' : ''} ${thumb ? 'has-thumb' : ''}`} style={slide}>
          {thumbLink}
          <Link to={href} className="row-link">
            <h2 className="row-title">{a.title}</h2>
            <div className="row-meta">
              {a.starred && <Star size={12} fill="currentColor" className="row-star" aria-label="Starred" />}
              <span className="site">{site}</span>
              {pending && <span className="status pending dot"><LoaderCircle size={12} className="spin" />Fetching…</span>}
              {failed && <span className="status failed dot"><TriangleAlert size={12} />Couldn't fetch</span>}
              <span className="dot">{relDate(a.createdAt)}</span>
            </div>
          </Link>
          <div className="row-actions compact-actions">{starBtn}{archiveBtn}{moreMenu}</div>
          {progress}
        </div>
      </li>
    );
  }

  return (
    <li {...itemProps}>
      {swipeHint}
      <div className={`row ${pending ? 'pending' : ''} ${thumb ? 'has-thumb' : ''}`} style={slide}>
        {/* Photo in its own column on the left; the text, tags and buttons line up in the column beside it. */}
        {thumbLink}
        <div className="row-body">
          <Link to={href} className="row-link">
            <h2 className="row-title">{a.title}</h2>
            <div className="row-meta">
              <span className="site">{site}</span>
              {pending && <span className="status pending dot"><LoaderCircle size={13} className="spin" />Fetching article…</span>}
              {failed && <span className="status failed dot"><TriangleAlert size={13} />Couldn't fetch</span>}
              {!pending && !failed && a.readingMinutes > 0 && <span className="dot">{minutes(a.readingMinutes)}</span>}
              <span className="dot">{relDate(a.createdAt)}</span>
            </div>
            {a.snippet ? (
              <p className="row-excerpt">{snippetParts(a.snippet).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</p>
            ) : failed ? (
              <p className="row-error">{a.error}</p>
            ) : a.excerpt ? <p className="row-excerpt">{a.excerpt}</p> : null}
          </Link>
          {a.tags.length > 0 && (
            <div className="row-tags" style={{ marginTop: -2, marginBottom: 6 }}>
              {a.tags.map((t) => <button key={t} className="tag" style={{ border: 0, cursor: 'pointer' }} onClick={() => onTag(t)}>#{t}</button>)}
            </div>
          )}
          <div className="row-actions">
            {failed ? (
              <>
                <button className="btn small" onClick={onRetry}><RotateCw size={14} />Retry</button>
                <button className="btn small ghost" onClick={onPaste}><ClipboardPaste size={14} />Paste text</button>
              </>
            ) : (
              <button className="icon-btn small" title="Listen" aria-label="Listen" disabled={pending} onClick={() => navigate(`${href}?listen=1`)}><Headphones size={17} /></button>
            )}
            <span className="spacer" />
            {starBtn}
            {archiveBtn}
            {moreMenu}
          </div>
        </div>
        {progress}
      </div>
    </li>
  );
}
