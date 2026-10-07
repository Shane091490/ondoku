// Settings > Read aloud > Pronunciation: how read aloud says names, acronyms and other words, in every voice.
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, Check, LoaderCircle } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Switch, useToast } from './ui.jsx';
import { useSamplePlayer, SampleButton } from './VoiceSettings.jsx';

const EMPTY = { word: '', say: '', matchCase: false };
const SAY_ERROR = 'Could not play this. Check that the voice service is online.';

export default function Pronunciations() {
  const { user } = useApp();
  const toast = useToast();
  const sample = useSamplePlayer();
  const [list, setList] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // id of the entry in the form
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const wordRef = useRef(null);
  const { piperVoice: voice, rate = 1 } = user.prefs;
  // raw: say the text exactly as typed; otherwise the saved fixes are applied, as read aloud would.
  const sayUrl = (text, raw) => `/api/pronunciations/say?${new URLSearchParams({ text, ...(raw ? { raw: '1' } : {}), ...(voice ? { voice } : {}) })}`;

  const load = () => api.get('/api/pronunciations').then(setList).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    if (!form.word.trim() || busy) return;
    setBusy(true);
    try {
      if (editing) await api.patch(`/api/pronunciations/${editing}`, form);
      else await api.post('/api/pronunciations', form);
      toast(editing ? 'Saved' : `Added “${form.word.trim()}”`);
      setForm(EMPTY);
      setEditing(null);
      load();
      wordRef.current?.focus();
    } catch (err) { toast(err.message, { error: true }); }
    setBusy(false);
  }
  function edit(p) {
    setEditing(p.id);
    setForm({ word: p.word, say: p.say, matchCase: p.matchCase });
    wordRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    wordRef.current?.focus({ preventScroll: true });
  }
  function cancel() { setEditing(null); setForm(EMPTY); }
  async function remove(p) {
    try {
      await api.del(`/api/pronunciations/${p.id}`);
      if (editing === p.id) cancel();
      load();
      toast(`Removed “${p.word}”`, { action: { label: 'Undo', onClick: () => api.post('/api/pronunciations', { word: p.word, say: p.say, matchCase: p.matchCase }).then(load).catch((e) => toast(e.message, { error: true })) } });
    } catch (err) { toast(err.message, { error: true }); }
  }

  const q = filter.trim().toLowerCase();
  const shown = (list || []).filter((p) => !q || p.word.toLowerCase().includes(q) || p.say.toLowerCase().includes(q));

  return (
    <section className="section">
      <h2>Pronunciation</h2>
      <p className="sub">Fix how read aloud says names, acronyms and other words, in every voice. Spell the replacement the way it sounds: <i>GIF</i> → <i>jif</i>, <i>Nguyen</i> → <i>win</i>, <i>SQL</i> → <i>sequel</i>. Whole words only; leave “Say it as” empty to skip a word. Audio made before a change is made again the next time you play it.</p>
      <form className="pron-form" onSubmit={submit}>
        <label className="field">
          <span>Word</span>
          <input ref={wordRef} className="input" value={form.word} maxLength={100} placeholder="GIF" autoComplete="off" onChange={(e) => setForm({ ...form, word: e.target.value })} />
        </label>
        <label className="field">
          <span>Say it as</span>
          <input className="input" value={form.say} maxLength={200} placeholder="jif" autoComplete="off" onChange={(e) => setForm({ ...form, say: e.target.value })} />
        </label>
        <div className="pron-case" title="Only replace the word when its capital letters match, e.g. US but not us">
          <Switch checked={form.matchCase} onChange={(on) => setForm({ ...form, matchCase: on })} label="Match case" hint="Match case" />
        </div>
        <div className="pron-actions">
          {form.say.trim() && <SampleButton sample={sample} k="form" url={sayUrl(form.say.trim(), true)} rate={rate} name={form.say} errorText={SAY_ERROR} />}
          {editing && <button type="button" className="btn small ghost" onClick={cancel}>Cancel</button>}
          <button className="btn small primary" disabled={!form.word.trim() || busy}>{editing ? <><Check size={14} />Save</> : <><Plus size={14} />Add</>}</button>
        </div>
      </form>

      {list === null ? <p className="muted" style={{ margin: 0 }}><LoaderCircle size={14} className="spin" /> Loading…</p> : list.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>No fixes yet.</p>
      ) : (
        <>
          {list.length > 8 && <input className="input" style={{ maxWidth: 260, margin: '4px 0 8px' }} placeholder="Filter" aria-label="Filter pronunciation fixes" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <div className="table-scroll">
            <table className="table pron-table">
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className={editing === p.id ? 'editing' : ''}>
                    <td>
                      <b>{p.word}</b>
                      {p.matchCase && <span className="pill" style={{ marginLeft: 8 }} title="Only when the capital letters match">Aa</span>}
                    </td>
                    <td className="pron-say">{p.say || <i className="muted">skipped</i>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {p.say && <SampleButton sample={sample} k={`p:${p.id}`} url={sayUrl(p.word)} rate={rate} name={p.word} errorText={SAY_ERROR} />}
                      <button className="icon-btn small" onClick={() => edit(p)} aria-label={`Edit ${p.word}`} title="Edit"><Pencil size={15} /></button>
                      <button className="icon-btn small" onClick={() => remove(p)} aria-label={`Remove ${p.word}`} title="Remove"><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td className="muted" colSpan={3}>Nothing matches “{filter}”.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
