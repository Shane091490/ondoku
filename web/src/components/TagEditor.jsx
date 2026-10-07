// Edit an article's tags: type to add (Enter or comma), pick from existing tags, click × to remove.
import React, { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '../api.js';
import { Modal, useToast } from './ui.jsx';

export const normTag = (v) => String(v || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase().slice(0, 40);

export function TagEditor({ article, onClose, onSaved }) {
  const toast = useToast();
  const [tags, setTags] = useState(article.tags || []);
  const [input, setInput] = useState('');
  const [all, setAll] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { api.get('/api/tags').then(setAll).catch(() => {}); }, []);

  const typed = normTag(input);
  const add = (raw) => {
    const t = normTag(raw);
    if (t && !tags.includes(t)) setTags((cur) => [...cur, t]);
    setInput('');
    inputRef.current?.focus();
  };
  const suggestions = all
    .filter((t) => !tags.includes(t.name) && (!typed || t.name.includes(typed)))
    .sort((a, b) => (typed ? Number(b.name.startsWith(typed)) - Number(a.name.startsWith(typed)) : 0) || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 16);
  const isNew = typed && !tags.includes(typed) && !all.some((t) => t.name === typed);

  async function save() {
    setBusy(true);
    try {
      const final = typed && !tags.includes(typed) ? [...tags, typed] : tags;
      onSaved(await api.patch(`/api/articles/${article.id}`, { tags: final }));
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Tags" sub={article.title} onClose={onClose}>
      <div className="tag-editor">
        {tags.map((t) => (
          <span key={t} className="chip on">#{t}<button onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}><X size={12} /></button></span>
        ))}
        <input
          ref={inputRef}
          className="tag-input"
          value={input}
          placeholder={tags.length ? 'Add another tag' : 'Type a tag and press Enter'}
          autoFocus
          aria-label="Add a tag"
          onChange={(e) => { const v = e.target.value; if (/[,\n]/.test(v)) v.split(/[,\n]/).forEach((part, i, arr) => (i < arr.length - 1 ? add(part) : setInput(part))); else setInput(v); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (typed) add(typed); else save(); }
            if (e.key === 'Backspace' && !input && tags.length) setTags(tags.slice(0, -1));
          }}
        />
      </div>
      {(suggestions.length > 0 || isNew) && (
        <div className="article-tags" style={{ marginTop: 12 }}>
          {isNew && <button className="chip" onClick={() => add(typed)}><Plus size={12} />Create “{typed}”</button>}
          {suggestions.map((t) => <button key={t.id} className="chip" onClick={() => add(t.name)}>#{t.name} <span className="muted">{t.count}</span></button>)}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12.5, margin: '12px 0 0' }}>Find tagged articles by searching for #tag, or with the Tags filter in the list.</p>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>Save tags</button>
      </div>
    </Modal>
  );
}
