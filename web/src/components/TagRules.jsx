// Settings > Tags > Auto-tag rules: tag articles by their site, title or text when they're first saved.
import React, { useEffect, useState } from 'react';
import { Plus, Trash2, WandSparkles, LoaderCircle } from 'lucide-react';
import { api } from '../api.js';
import { useToast } from './ui.jsx';

const KINDS = [['site', 'Site is'], ['title', 'Title contains'], ['text', 'Text contains']];
const LABEL = Object.fromEntries(KINDS);
const PLACEHOLDER = { site: 'foxnews.com', title: 'Ukraine', text: 'climate change' };

export default function TagRules({ onApplied }) {
  const toast = useToast();
  const [rules, setRules] = useState(null);
  const [form, setForm] = useState({ kind: 'site', pattern: '', tag: '' });
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/tag-rules').then(setRules).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/api/tag-rules', form);
      toast(`New articles from ${r.kind === 'site' ? r.pattern : `“${r.pattern}”`} get #${r.tag}`);
      setForm({ ...form, pattern: '' });
      load();
    } catch (err) { toast(err.message, { error: true }); }
    setBusy(false);
  }
  async function remove(r) {
    try { await api.del(`/api/tag-rules/${r.id}`); load(); } catch (err) { toast(err.message, { error: true }); }
  }
  async function applyAll() {
    setBusy(true);
    try {
      const r = await api.post('/api/tag-rules/apply');
      toast(r.updated ? `Tagged ${r.updated} saved ${r.updated === 1 ? 'article' : 'articles'}` : 'No saved articles needed new tags');
      onApplied?.();
    } catch (err) { toast(err.message, { error: true }); }
    setBusy(false);
  }

  return (
    <section className="section">
      <h2>Auto-tag rules</h2>
      <p className="sub">Tag articles automatically when they're saved, by their site or by words in the title or text (whole words, any case). Rules only add tags.</p>
      <form className="rule-form" onSubmit={add}>
        <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Match on">
          {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <input className="input" value={form.pattern} maxLength={100} placeholder={PLACEHOLDER[form.kind]} aria-label={form.kind === 'site' ? 'Site' : 'Word or phrase'} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
        <input className="input" value={form.tag} maxLength={40} placeholder="tag" aria-label="Tag to add" onChange={(e) => setForm({ ...form, tag: e.target.value })} />
        <button className="btn small primary" disabled={busy || !form.pattern.trim() || !form.tag.trim()}><Plus size={14} />Add rule</button>
      </form>
      {rules === null ? <p className="muted" style={{ margin: 0 }}><LoaderCircle size={14} className="spin" /> Loading…</p> : rules.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>No rules yet.</p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="table rule-table">
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{LABEL[r.kind]}</td>
                    <td><b>{r.pattern}</b></td>
                    <td><span className="tag">#{r.tag}</span></td>
                    <td style={{ textAlign: 'right' }}><button className="icon-btn small" onClick={() => remove(r)} aria-label={`Remove the rule for ${r.pattern}`} title="Remove"><Trash2 size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn small" style={{ marginTop: 10 }} disabled={busy} onClick={applyAll}><WandSparkles size={14} />Apply to saved articles</button>
        </>
      )}
    </section>
  );
}
