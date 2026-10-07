import React, { useState } from 'react';
import { api } from '../api.js';
import { Modal, useToast } from './ui.jsx';

// Save pasted text as a new article, or replace the text of one that could not be fetched.
export function PasteTextModal({ article, onClose, onSaved }) {
  const toast = useToast();
  const [title, setTitle] = useState(article?.title || '');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const out = article
        ? await api.put(`/api/articles/${article.id}/content`, { title, text })
        : (await api.post('/api/articles', { title, text, url: url.trim() || undefined })).article;
      toast(article ? 'Text replaced' : 'Saved');
      onSaved(out);
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={article ? 'Paste the article text' : 'Save pasted text'}
      sub={article ? 'For pages behind a login or paywall: copy the text from your browser and paste it here. It replaces what was fetched.' : 'Paste text from anywhere. Blank lines separate paragraphs.'}
      onClose={onClose}
      width={620}
    >
      <label className="field"><span>Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional: the first line is used if empty" /></label>
      {!article && <label className="field"><span>Source link <span className="muted">(optional)</span></span><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" /></label>}
      <label className="field"><span>Text</span><textarea className="textarea" rows={12} value={text} onChange={(e) => setText(e.target.value)} autoFocus /></label>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !text.trim()} onClick={save}>{article ? 'Replace text' : 'Save'}</button>
      </div>
    </Modal>
  );
}
