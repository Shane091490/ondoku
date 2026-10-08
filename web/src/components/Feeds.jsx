// Settings > Feeds: follow sites and RSS/Atom feeds. New posts are saved to the queue, with the feed's tags.
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, RotateCw, Pause, Play, Pencil, LoaderCircle, TriangleAlert, Rss } from 'lucide-react';
import { api } from '../api.js';
import { Confirm, useToast } from './ui.jsx';
import { relDate } from '../lib/format.js';

const splitTags = (v) => v.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);

export default function Feeds() {
  const toast = useToast();
  const [feeds, setFeeds] = useState(null);
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);
  const load = () => api.get('/api/feeds').then(setFeeds).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/api/feeds', { url, tags: splitTags(tags) });
      toast(`Following ${r.feed.title}${r.added ? `: saved ${r.added} recent ${r.added === 1 ? 'post' : 'posts'}` : ''}`);
      setUrl('');
      setTags('');
      load();
    } catch (err) { toast(err.message, { error: true }); }
    setBusy(false);
  }
  async function patch(f, body) {
    try { const out = await api.patch(`/api/feeds/${f.id}`, body); setFeeds((list) => list.map((x) => (x.id === f.id ? out : x))); } catch (err) { toast(err.message, { error: true }); }
  }
  async function check(f) {
    setFeeds((list) => list.map((x) => (x.id === f.id ? { ...x, checking: true } : x)));
    try {
      const r = await api.post(`/api/feeds/${f.id}/check`);
      setFeeds((list) => list.map((x) => (x.id === f.id ? r.feed : x)));
      toast(r.feed.lastError ? `${r.feed.title}: ${r.feed.lastError}` : r.added ? `Saved ${r.added} new ${r.added === 1 ? 'post' : 'posts'}` : 'Nothing new', r.feed.lastError ? { error: true } : undefined);
    } catch (err) { toast(err.message, { error: true }); load(); }
  }

  return (
    <section className="section">
      <h2>Follow sites and feeds</h2>
      <p className="sub">New posts from the sites you follow are saved to your queue. Paste a feed's address, or just the site's: {' '}
        Ondoku looks for its RSS or Atom feed. The first check saves the 3 newest posts; after that every new one, checked every hour.</p>
      <form className="feed-form" onSubmit={add}>
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com or its feed address" aria-label="Site or feed address" inputMode="url" autoCapitalize="off" spellCheck="false" />
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags (optional)" aria-label="Tags for its articles" />
        <button className="btn small primary" disabled={busy || !url.trim()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}Follow</button>
      </form>
      {feeds === null ? <p className="muted" style={{ margin: 0 }}><LoaderCircle size={14} className="spin" /> Loading…</p> : feeds.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>You don't follow any feeds yet.</p>
      ) : (
        <ul className="feed-list">
          {feeds.map((f) => <FeedRow key={f.id} f={f} onCheck={() => check(f)} onPatch={(b) => patch(f, b)} onRemove={() => setRemoving(f)} />)}
        </ul>
      )}
      {removing && (
        <Confirm
          title={`Unfollow ${removing.title}?`}
          message="No more posts are saved from it. The articles it already saved stay."
          confirmLabel="Unfollow"
          onClose={() => setRemoving(null)}
          onConfirm={async () => { await api.del(`/api/feeds/${removing.id}`); toast(`Unfollowed ${removing.title}`); load(); }}
        />
      )}
    </section>
  );
}

function FeedRow({ f, onCheck, onPatch, onRemove }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const status = f.checking ? 'Checking…'
    : f.lastError ? null
      : f.lastCheckedAt ? `Checked ${relDate(f.lastCheckedAt)}` : 'Not checked yet';
  return (
    <li className={`feed-row ${f.active ? '' : 'paused'}`}>
      <span className="feed-icon"><Rss size={16} /></span>
      <div className="feed-main">
        <div className="feed-title">
          {f.siteUrl ? <a href={f.siteUrl} target="_blank" rel="noopener noreferrer">{f.title}</a> : f.title}
          {!f.active && <span className="pill">Paused</span>}
        </div>
        <div className="feed-meta">
          <span>{f.saved} saved</span>
          {status && <span>{status}</span>}
          {f.lastError && <span className="feed-error"><TriangleAlert size={12} />{f.lastError}</span>}
        </div>
        {editing ? (
          <input
            className="input feed-tags-input"
            defaultValue={f.tags.join(', ')}
            autoFocus
            placeholder="tags, separated by commas"
            aria-label={`Tags for ${f.title}`}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); } }}
            onBlur={(e) => { setEditing(false); if (!cancelled.current) onPatch({ tags: splitTags(e.target.value) }); cancelled.current = false; }}
          />
        ) : (
          <div className="row-tags" style={{ marginTop: 6 }}>
            {f.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
            <button className="linklike" onClick={() => setEditing(true)}><Pencil size={11} /> {f.tags.length ? 'Edit tags' : 'Add tags'}</button>
          </div>
        )}
      </div>
      <div className="feed-actions">
        <button className="icon-btn small" onClick={onCheck} disabled={f.checking} aria-label={`Check ${f.title} now`} title="Check now"><RotateCw size={15} className={f.checking ? 'spin' : ''} /></button>
        <button className="icon-btn small" onClick={() => onPatch({ active: !f.active })} aria-label={f.active ? `Pause ${f.title}` : `Resume ${f.title}`} title={f.active ? 'Pause' : 'Resume'}>{f.active ? <Pause size={15} /> : <Play size={15} />}</button>
        <button className="icon-btn small" onClick={onRemove} aria-label={`Unfollow ${f.title}`} title="Unfollow"><Trash2 size={15} /></button>
      </div>
    </li>
  );
}
