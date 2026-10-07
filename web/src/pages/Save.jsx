import React, { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, TriangleAlert, BookOpen, Headphones, Inbox } from 'lucide-react';
import { api } from '../api.js';
import { navigate } from '../router.jsx';
import { useToast } from '../components/ui.jsx';

// Landing screen for the share sheet and the bookmarklet: saves the link straight away. With open=1 (the
// bookmarklet) it goes on to the saved article; otherwise it shows a confirmation with Read / Listen buttons.
export default function Save({ query }) {
  const url = query.get('url') || '';
  const title = query.get('title') || '';
  const text = query.get('text') || '';
  const openAfter = query.get('open') === '1';
  const toast = useToast();
  const [state, setState] = useState({ phase: 'saving' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!url && !text) { setState({ phase: 'error', error: 'Nothing to save: the share did not include a link.' }); return; }
    const body = url ? { url } : { text, title };
    api.post('/api/articles', body)
      .then((out) => {
        if (openAfter) {
          toast(out.duplicate ? 'Already in your list' : 'Saved to your queue');
          navigate(`/read/${out.article.id}`, { replace: true });
        } else setState({ phase: 'saved', article: out.article, duplicate: out.duplicate });
      })
      .catch((e) => setState({ phase: 'error', error: e.message }));
  }, [url, text, title]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = state.article;
  return (
    <div className="shell">
      <main className="page">
        <div className="save-screen">
          {state.phase === 'saving' && (<><span className="big-icon"><LoaderCircle size={30} className="spin" /></span><h1>Saving…</h1><p className="muted">{url}</p></>)}
          {state.phase === 'error' && (
            <>
              <span className="big-icon bad"><TriangleAlert size={30} /></span>
              <h1>Couldn't save that</h1>
              <p className="muted">{state.error}</p>
              <div className="inline-actions"><button className="btn" onClick={() => navigate('/', { replace: true })}><Inbox size={16} />Go to queue</button></div>
            </>
          )}
          {state.phase === 'saved' && (
            <>
              <span className="big-icon"><Check size={32} /></span>
              <h1>{state.duplicate ? 'Already in your list' : 'Saved for later'}</h1>
              <p className="muted">{a.status === 'pending' ? 'The article is being fetched in the background.' : a.title}</p>
              <div className="inline-actions">
                <button className="btn primary" onClick={() => navigate(`/read/${a.id}`, { replace: true })}><BookOpen size={16} />Read now</button>
                <button className="btn" onClick={() => navigate(`/read/${a.id}?listen=1`, { replace: true })}><Headphones size={16} />Listen</button>
                <button className="btn ghost" onClick={() => navigate('/', { replace: true })}>Go to queue</button>
              </div>
              {window.opener && <p style={{ marginTop: 18 }}><button className="linklike" onClick={() => window.close()}>Close this window</button></p>}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
