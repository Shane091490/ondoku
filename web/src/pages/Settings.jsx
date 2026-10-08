import React, { useEffect, useRef, useState } from 'react';
import { LogOut, KeyRound, Plus, Trash2, Copy, Download, Bookmark, Play, LoaderCircle, Check, Users, Server, AudioLines, UserRound, Link2, Tag, Pencil, BookOpen, Rss } from 'lucide-react';
import { api } from '../api.js';
import { Link } from '../router.jsx';
import { useApp } from '../App.jsx';
import Header from '../components/Header.jsx';
import VoiceSettings from '../components/VoiceSettings.jsx';
import Pronunciations from '../components/Pronunciations.jsx';
import TagRules from '../components/TagRules.jsx';
import Feeds from '../components/Feeds.jsx';
import { Modal, Confirm, Switch, useToast } from '../components/ui.jsx';
import { normTag } from '../components/TagEditor.jsx';
import { bytes, relDate, aboutDays } from '../lib/format.js';
import { useInstall, promptInstall } from '../lib/pwa.js';

const TABS = [
  ['account', 'Account', UserRound],
  ['reading', 'Reading', BookOpen],
  ['listen', 'Read aloud', AudioLines],
  ['saving', 'Saving', Link2],
  ['feeds', 'Feeds', Rss],
  ['tags', 'Tags', Tag],
  ['api', 'API keys', KeyRound],
  ['admin', 'Admin', Server],
];

export default function Settings({ tab }) {
  const { user } = useApp();
  const tabs = TABS.filter(([k]) => k !== 'admin' || user.isAdmin);
  const current = tabs.some(([k]) => k === tab) ? tab : 'account';
  return (
    <div className="shell">
      <Header view="settings" />
      <main className="page settings">
        <h1>Settings</h1>
        <nav className="settings-nav">
          {tabs.map(([k, label, Icon]) => <Link key={k} to={`/settings/${k}`} className={`chip ${current === k ? 'on' : ''}`}><Icon size={14} />{label}</Link>)}
        </nav>
        {current === 'account' && <Account />}
        {current === 'reading' && <Reading />}
        {current === 'listen' && <Listen />}
        {current === 'saving' && <Saving />}
        {current === 'feeds' && <Feeds />}
        {current === 'tags' && <TagsSettings />}
        {current === 'api' && <ApiKeys />}
        {current === 'admin' && <Admin />}
      </main>
    </div>
  );
}

function Account() {
  const { user, setUser, refresh } = useApp();
  const toast = useToast();
  const [name, setName] = useState(user.displayName);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });

  async function saveName(e) {
    e.preventDefault();
    try { const r = await api.patch('/api/me', { displayName: name }); setUser(r.user); toast('Saved'); } catch (err) { toast(err.message, { error: true }); }
  }
  async function changePassword(e) {
    e.preventDefault();
    try { await api.post('/api/me/password', pw); setPw({ currentPassword: '', newPassword: '' }); toast('Password changed. Other devices were signed out.'); } catch (err) { toast(err.message, { error: true }); }
  }
  async function logout() {
    await api.post('/api/auth/logout');
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch { /* no cache api */ }
    refresh();
  }
  return (
    <>
      <section className="section">
        <h2>Profile</h2>
        <p className="sub">Signed in as <b>{user.email}</b>{user.oidc ? ' (single sign-on linked)' : ''}.</p>
        <form onSubmit={saveName} className="inline-actions" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}><span>Display name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="btn" disabled={!name.trim() || name === user.displayName}>Save</button>
        </form>
      </section>
      <section className="section">
        <h2>{user.hasPassword ? 'Change password' : 'Set a password'}</h2>
        <p className="sub">{user.hasPassword ? 'Changing it signs out your other devices.' : 'Lets you sign in with your email as well as single sign-on.'}</p>
        <form onSubmit={changePassword}>
          <div className="grid2">
            {user.hasPassword && <label className="field"><span>Current password</span><input className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></label>}
            <label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></label>
          </div>
          <button className="btn" disabled={pw.newPassword.length < 8}>Update password</button>
        </form>
      </section>
      <section className="section">
        <h2>Sessions</h2>
        <div className="inline-actions">
          <button className="btn" onClick={() => api.post('/api/me/sessions/logout-others').then(() => toast('Signed out everywhere else'))}>Sign out other devices</button>
          <button className="btn danger" onClick={logout}><LogOut size={16} />Sign out</button>
        </div>
      </section>
    </>
  );
}

function Listen() {
  const { user, setUser } = useApp();
  const toast = useToast();
  const prefs = user.prefs;
  const [cache, setCache] = useState(null);
  async function save(patch) {
    try { const r = await api.patch('/api/me', { prefs: patch }); setUser(r.user); } catch (e) { toast(e.message, { error: true }); }
  }
  return (
    <>
      {/* VoiceSettings reloads the status after voices are removed or installed; the cache line follows it. */}
      <VoiceSettings onStatus={(t) => setCache(t.cache || null)} />
      <section className="section">
        <h2>Playback</h2>
        <p className="sub">Articles are read by Piper on your server. The paragraph being read is highlighted, and playback keeps going with your phone's screen locked.</p>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>Default speed</span>
          <select className="select" value={prefs.rate} onChange={(e) => save({ rate: Number(e.target.value) })}>
            {[0.8, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </label>
        <SettingSwitch
          label="Prepare audio automatically"
          hint="Generate the audio for every newly saved article in the background, so it's ready the moment you press play. Uses server CPU and about 0.5 MB per minute of audio."
          checked={!!prefs.autoAudio}
          onChange={(on) => save({ autoAudio: on })}
        />
        <SettingSwitch
          label="Play the next article automatically"
          hint="When an article ends, read aloud carries on with the next one in your queue, like a playlist. Also in the player, and Play queue on the Queue list starts it."
          checked={!!prefs.continuousPlay}
          onChange={(on) => save({ continuousPlay: on })}
        />
        {cache && <p className="muted" style={{ fontSize: 13, margin: 0 }}>Audio cache: {cache.tracks} tracks, {bytes(cache.bytes)}.</p>}
      </section>
      <Pronunciations />
    </>
  );
}

function SettingSwitch({ label, hint, checked, onChange, disabled }) {
  return (
    <div className="setting-switch">
      <div className="setting-text"><b>{label}</b>{hint && <small>{hint}</small>}</div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

const ARCHIVE_DAYS = [[0, 'Never'], [7, 'After 7 days'], [14, 'After 14 days'], [30, 'After 30 days'], [90, 'After 90 days']];
const DEFAULT_KEEP_DAYS = 730;

function Reading() {
  const { user, setUser } = useApp();
  const toast = useToast();
  const p = user.prefs;
  const keep = p.deleteArchivedAfterDays;
  const [keepDraft, setKeepDraft] = useState(null); // days being typed, saved on Enter or leaving the field
  const [confirmPurge, setConfirmPurge] = useState(null); // { days, count } waiting for a yes
  const cancelKeep = useRef(false);
  const lastKeep = useRef(keep || DEFAULT_KEEP_DAYS);
  if (keep > 0) lastKeep.current = keep;

  async function save(patch) {
    try {
      const r = await api.patch('/api/me', { prefs: patch });
      setUser(r.user);
      if (r.archived) toast(`Archived ${r.archived} older ${r.archived === 1 ? 'article' : 'articles'}`);
      if (r.deleted) toast(`Deleted ${r.deleted} old archived ${r.deleted === 1 ? 'article' : 'articles'}`);
    } catch (e) { toast(e.message, { error: true }); }
  }
  // A shorter period can delete articles straight away: say how many and ask first.
  async function applyKeep(n) {
    try {
      const { count } = await api.get(`/api/archive/expired?days=${n}`);
      if (count > 0) setConfirmPurge({ days: n, count }); else await save({ deleteArchivedAfterDays: n });
    } catch (e) { toast(e.message, { error: true }); }
  }
  function commitKeep() {
    const raw = keepDraft;
    setKeepDraft(null);
    if (cancelKeep.current) { cancelKeep.current = false; return; }
    if (raw == null || raw.trim() === '' || raw === String(keep)) return; // emptied: keep the saved value
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 36500) { toast('Enter a whole number of days, from 1 to 36500', { error: true }); return; }
    if (n !== keep) applyKeep(n);
  }
  const days = ARCHIVE_DAYS.some(([d]) => d === p.archiveAfterDays) ? ARCHIVE_DAYS : [...ARCHIVE_DAYS, [p.archiveAfterDays, `After ${p.archiveAfterDays} days`]];
  const about = keep > 0 ? aboutDays(keep) : '';
  return (
    <section className="section">
      <h2>Archiving</h2>
      <p className="sub">Keep the queue to what you haven't read yet. Archived articles stay under Archive and in search, and you can move any of them back.</p>
      <SettingSwitch label="Archive when I finish reading" hint="When you scroll to the end of an article. A message lets you undo it." checked={p.archiveOnFinish} onChange={(on) => save({ archiveOnFinish: on })} />
      <SettingSwitch label="Archive when read aloud finishes" hint="When the last paragraph has been read to you." checked={p.archiveOnListen} onChange={(on) => save({ archiveOnListen: on })} />
      <div className="setting-switch">
        <div className="setting-text">
          <b>Archive articles left in the queue</b>
          <small>Articles saved longer ago than this that you haven't opened since are moved to the archive. Starred articles stay. Checked every hour.</small>
        </div>
        <select className="select" style={{ width: 'auto', flex: 'none' }} aria-label="Archive articles left in the queue" value={p.archiveAfterDays} onChange={(e) => save({ archiveAfterDays: Number(e.target.value) })}>
          {days.map(([d, label]) => <option key={d} value={d}>{label}</option>)}
        </select>
      </div>
      <SettingSwitch label="Remove the audio when archiving" hint="Frees the space an archived article's read-aloud audio takes. It is made again if you listen later." checked={p.dropAudioOnArchive} onChange={(on) => save({ dropAudioOnArchive: on })} />
      <div className="setting-switch">
        <div className="setting-text">
          <b>Delete old archived articles</b>
          <small>
            Archived articles are deleted for good, with their audio and saved pictures, this many days after you archived them. Starred articles are kept. Checked every hour.
            {keep > 0 ? ` Now: ${keep} days${about ? ` (${about})` : ''}.` : ' Now: never.'}
          </small>
        </div>
        <div className="days-control">
          {keep > 0 && (
            <label className="days-input">
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={36500}
                step={1}
                value={keepDraft ?? keep}
                aria-label="Days in the archive before an article is deleted"
                onChange={(e) => setKeepDraft(e.target.value)}
                onBlur={commitKeep}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') { cancelKeep.current = true; e.currentTarget.blur(); }
                }}
              />
              <span>days</span>
            </label>
          )}
          <Switch checked={keep > 0} label="Delete old archived articles" onChange={(on) => (on ? applyKeep(lastKeep.current) : save({ deleteArchivedAfterDays: 0 }))} />
        </div>
      </div>
      {confirmPurge && (
        <Confirm
          title={`Delete ${confirmPurge.count} archived ${confirmPurge.count === 1 ? 'article' : 'articles'} now?`}
          message={`${confirmPurge.count === 1 ? 'It was' : 'They were'} archived more than ${confirmPurge.days} days ago. Their audio and saved pictures go too, and this can't be undone. Starred articles are never deleted.`}
          confirmLabel="Delete"
          onClose={() => setConfirmPurge(null)}
          onConfirm={() => save({ deleteArchivedAfterDays: confirmPurge.days })}
        />
      )}
    </section>
  );
}

function Saving() {
  const { status } = useApp();
  const toast = useToast();
  const linkRef = useRef(null);
  const [importText, setImportText] = useState('');
  const origin = location.origin;
  // Opens a normal tab (no size features, which would make it a popup) straight on the saved article.
  // "noopener" keeps the article's page from getting a handle on the app's tab.
  const code = `javascript:(()=>{window.open('${origin}/share?open=1&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'_blank','noopener')})()`;
  // React blocks javascript: URLs in JSX, so set the bookmarklet href directly.
  useEffect(() => { linkRef.current?.setAttribute('href', code); }, [code]);

  async function runImport() {
    try { const r = await api.post('/api/import', { text: importText }); toast(`Added ${r.created} of ${r.found} links${r.duplicates ? ` (${r.duplicates} already saved)` : ''}`); setImportText(''); } catch (e) { toast(e.message, { error: true }); }
  }
  return (
    <>
      <InstallApp />
      <section className="section">
        <h2>Bookmarklet</h2>
        <p className="sub">Drag this button to your bookmarks bar. Click it on any article to save it and open it here in a new tab.</p>
        <div className="inline-actions">
          <a ref={linkRef} className="bookmarklet" onClick={(e) => { e.preventDefault(); toast('Drag it to your bookmarks bar'); }}><Bookmark size={15} />Save to {status.appName}</a>
          <button className="btn small" onClick={() => navigator.clipboard.writeText(code).then(() => toast('Copied'))}><Copy size={14} />Copy code</button>
        </div>
      </section>
      <section className="section">
        <h2>Share from your phone</h2>
        <p className="sub" style={{ marginBottom: 8 }}><b>Android:</b> install the app from <b>Chrome</b> (above, or <i>Install app</i> in Chrome's menu), and {status.appName} appears in the share menu of any app. Brave and Firefox can only add it as a home-screen shortcut, which the share menu doesn't list.</p>
        <p className="sub" style={{ marginBottom: 0 }}><b>iPhone / iPad:</b> create an <i>API key</i>, then a Shortcut that receives URLs from the share sheet and runs <i>Get contents of URL</i>: POST <code>{origin}/api/v1/articles</code>, header <code>Authorization: Bearer &lt;key&gt;</code>, JSON body <code>{'{"url": "Shortcut Input"}'}</code>.</p>
      </section>
      <section className="section">
        <h2>Import links</h2>
        <p className="sub">Paste anything containing links, such as an export from Pocket, Instapaper or your browser. Each link is saved and fetched in the background.</p>
        <textarea className="textarea" rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="https://…" />
        <div style={{ marginTop: 10 }}><button className="btn" disabled={!/https?:\/\//.test(importText)} onClick={runImport}>Import</button></div>
      </section>
      <section className="section">
        <h2>Export</h2>
        <p className="sub">Everything you've saved, with text, tags and reading state, as JSON.</p>
        <div className="inline-actions">
          <a className="btn" href="/api/export" download><Download size={16} />Download export</a>
          <a className="btn ghost" href="/api/export?html=1" download>Include formatted HTML</a>
        </div>
      </section>
      <SharedLinks />
    </>
  );
}

// Articles shared with a public link, with how often each was opened.
function SharedLinks() {
  const toast = useToast();
  const [shares, setShares] = useState(null);
  const load = () => api.get('/api/shares').then(setShares).catch(() => setShares([]));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function stop(sh) {
    try { await api.del(`/api/articles/${sh.articleId}/share`); toast('Stopped sharing'); load(); } catch (e) { toast(e.message, { error: true }); }
  }
  return (
    <section className="section">
      <h2>Shared links</h2>
      <p className="sub">Articles anyone can read with their link, without signing in. Share one from its ⋯ menu with <i>Share a public link</i>.</p>
      {!shares ? <p className="muted" style={{ margin: 0 }}><LoaderCircle size={14} className="spin" /> Loading…</p> : shares.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Nothing is shared.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <tbody>
              {shares.map((sh) => (
                <tr key={sh.articleId}>
                  <td><a href={`#/read/${sh.articleId}`}><b>{sh.title}</b></a><div className="muted" style={{ fontSize: 12.5 }}>Shared {relDate(sh.createdAt)} · opened {sh.views} {sh.views === 1 ? 'time' : 'times'}</div></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn small ghost" onClick={() => navigator.clipboard.writeText(sh.url).then(() => toast('Link copied'))}><Copy size={13} />Copy</button>
                    <button className="btn small ghost" onClick={() => stop(sh)}>Stop sharing</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Installing as an app: the browser's own dialog where there is one (Chrome, Edge, Android), steps for Safari on
// iPhone/iPad, and what the share menu needs on Android (an app installed by Chrome, not a shortcut).
function InstallApp() {
  const { status } = useApp();
  const toast = useToast();
  const inst = useInstall();
  const name = status.appName;
  let body;
  if (inst.webapk) body = <p className="sub" style={{ margin: 0 }}>{name} is installed as an Android app on this phone, so it's in other apps' share menu (in some apps, scroll the list or tap <i>More</i> to find it).</p>;
  else if (inst.shortcutOnly) {
    body = (
      <p className="sub" style={{ margin: 0 }}>
        {inst.shortcutOnly} adds web apps to the home screen as shortcuts, and Android's share menu doesn't list shortcuts. To share articles to {name} from other apps, open <b>{location.host}</b> in <b>Chrome</b> and choose <i>Install app</i> in its menu (then remove the {inst.shortcutOnly} shortcut). You can keep using {inst.shortcutOnly} for everything else.
      </p>
    );
  } else if (inst.installed) {
    body = (
      <p className="sub" style={{ margin: 0 }}>
        {name} is running as an installed app on this device.
        {inst.android && <> If it isn't in other apps' share menu, it was added as a shortcut: remove it, open <b>{location.host}</b> in <b>Chrome</b> and choose <i>Install app</i> (not <i>Add to Home screen → Create shortcut</i>).</>}
      </p>
    );
  } else if (inst.canPrompt) {
    body = (
      <>
        <p className="sub">Put {name} on your home screen or in your apps: it opens in its own window, appears in the share menu on Android, and keeps the articles you open readable offline.</p>
        <button className="btn primary" onClick={async () => { if (await promptInstall()) toast(`${name} is installed`); }}><Download size={16} />Install {name}</button>
      </>
    );
  } else if (inst.ios) body = <p className="sub" style={{ margin: 0 }}>In Safari, tap the <b>Share</b> button, then <b>Add to Home Screen</b>. {name} then opens full screen from its icon and keeps the articles you open readable offline.</p>;
  else if (!window.isSecureContext) body = <p className="sub" style={{ margin: 0 }}>Installing works from the site's secure <b>https://</b> address, not from {location.host}.</p>;
  else body = <p className="sub" style={{ margin: 0 }}>Use your browser's menu: <i>Install app</i>, <i>Install {name}</i> or <i>Add to Home screen</i>. (Firefox on a computer can't install web apps.)</p>;
  return (
    <section className="section">
      <h2>Install the app</h2>
      {body}
    </section>
  );
}

function ApiKeys() {
  const toast = useToast();
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [created, setCreated] = useState(null);
  const [revoke, setRevoke] = useState(null);
  const load = () => api.get('/api/me/api-keys').then(setKeys).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e) {
    e.preventDefault();
    try { const k = await api.post('/api/me/api-keys', { name, permission: readOnly ? 'read' : 'write' }); setCreated(k); setName(''); load(); } catch (err) { toast(err.message, { error: true }); }
  }
  return (
    <>
      <section className="section">
        <h2>API keys</h2>
        <p className="sub">Let other apps and scripts save and read articles as you. Send the key as <code>Authorization: Bearer &lt;key&gt;</code> to <code>{location.origin}/api/v1/…</code>. Keys can't manage accounts, keys or server settings.</p>
        <form onSubmit={create} className="inline-actions" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
          <label className="field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. iPhone shortcut" /></label>
          <label className="check" style={{ marginBottom: 10 }}><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /><span>Read-only</span></label>
          <button className="btn primary" disabled={!name.trim()}><Plus size={16} />Create key</button>
        </form>
        {keys.length === 0 ? <p className="muted" style={{ margin: 0 }}>No keys yet.</p> : (
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td><b>{k.name}</b></td>
                    <td><code>{k.prefix}…</code></td>
                    <td><span className={`pill ${k.permission === 'read' ? '' : 'accent'}`}>{k.permission === 'read' ? 'Read-only' : 'Read & write'}</span></td>
                    <td className="muted">{k.lastUsed ? relDate(k.lastUsed) : 'Never'}</td>
                    <td style={{ textAlign: 'right' }}><button className="icon-btn small" onClick={() => setRevoke(k)} aria-label={`Revoke ${k.name}`}><Trash2 size={16} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="section">
        <h2>Example</h2>
        <pre className="secret" style={{ borderStyle: 'solid', borderColor: 'var(--border)', whiteSpace: 'pre-wrap' }}>{`curl -X POST ${location.origin}/api/v1/articles \\
  -H "Authorization: Bearer od_…" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com/story", "tags": ["later"]}'`}</pre>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>The full reference is in <code>docs/API.md</code> in the project.</p>
      </section>
      {created && (
        <Modal title="Copy your new key" sub="This is the only time it's shown." onClose={() => setCreated(null)}>
          <div className="secret">{created.secret}</div>
          <div className="modal-actions">
            <button className="btn primary" onClick={() => navigator.clipboard.writeText(created.secret).then(() => toast('Copied'))}><Copy size={15} />Copy</button>
            <button className="btn" onClick={() => setCreated(null)}>Done</button>
          </div>
        </Modal>
      )}
      {revoke && <Confirm title="Revoke this key?" message={`Apps using “${revoke.name}” will stop working.`} confirmLabel="Revoke" onClose={() => setRevoke(null)} onConfirm={async () => { await api.del(`/api/me/api-keys/${revoke.id}`); load(); }} />}
    </>
  );
}

function TagsSettings() {
  const toast = useToast();
  const [tags, setTags] = useState(null);
  const [del, setDel] = useState(null);
  const load = () => api.get('/api/tags').then(setTags).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function rename(t, name) {
    const clean = normTag(name);
    if (!clean || clean === t.name) return;
    const merging = tags.some((x) => x.name === clean && x.id !== t.id);
    try { setTags(await api.patch(`/api/tags/${t.id}`, { name: clean })); toast(merging ? `Merged #${t.name} into #${clean}` : `Renamed to #${clean}`); } catch (e) { toast(e.message, { error: true }); }
  }
  return (
    <>
    <section className="section">
      <h2>Tags</h2>
      <p className="sub">Tag articles from their ⋯ menu, from the tag row under an article's title, or by adding #tags after a link when you save it. Search for #tag to find them. Renaming a tag to the name of another one merges the two.</p>
      {!tags ? <p className="muted"><LoaderCircle size={14} className="spin" /> Loading…</p> : tags.length === 0 ? <p className="muted" style={{ margin: 0 }}>No tags yet.</p> : (
        <div className="table-scroll">
          <table className="table">
            <tbody>
              {tags.map((t) => <TagRow key={t.id} t={t} onRename={rename} onDelete={() => setDel(t)} />)}
            </tbody>
          </table>
        </div>
      )}
      {del && <Confirm title={`Delete #${del.name}?`} message={`The tag is removed from ${del.count} ${del.count === 1 ? 'article' : 'articles'}. The articles stay.`} onClose={() => setDel(null)} onConfirm={async () => { await api.del(`/api/tags/${del.id}`); toast(`Deleted #${del.name}`); load(); }} />}
    </section>
    <TagRules onApplied={load} />
    </>
  );
}

function TagRow({ t, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  return (
    <tr>
      <td>
        {editing ? (
          <input
            className="input"
            defaultValue={t.name}
            autoFocus
            aria-label={`New name for ${t.name}`}
            style={{ maxWidth: 260, height: 34 }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); } }}
            onBlur={(e) => { const v = e.target.value; setEditing(false); if (!cancelled.current) onRename(t, v); cancelled.current = false; }}
          />
        ) : <a className="chip" href={`#/all?tag=${encodeURIComponent(t.name)}`} title="Show these articles">#{t.name}</a>}
      </td>
      <td className="muted">{t.count} {t.count === 1 ? 'article' : 'articles'}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button className="btn small ghost" onClick={() => setEditing(true)}><Pencil size={13} />Rename</button>
        <button className="icon-btn small" onClick={onDelete} aria-label={`Delete tag ${t.name}`} title="Delete"><Trash2 size={15} /></button>
      </td>
    </tr>
  );
}

const SETTING_FIELDS = [
  ['public_url', 'Public URL', 'https://read.example.com: used for single sign-on callbacks'],
  ['registration_enabled', 'Open registration', 'Let anyone create an account. (The first account can always be created.)', 'bool', false],
  ['oidc_issuer', 'OIDC issuer', 'https://login.example.com/realms/home'],
  ['oidc_client_id', 'OIDC client ID', ''],
  ['oidc_client_secret', 'OIDC client secret', ''],
  ['oidc_name', 'Sign-in button label', 'Single sign-on'],
  ['oidc_only', 'OIDC only', 'Hide the email and password form, so everyone signs in with single sign-on.', 'bool', false],
  ['oidc_auto_create', 'Create accounts on first SSO login', 'Make an account the first time someone signs in with single sign-on. Off: an admin has to add them first.', 'bool', true],
  ['oidc_admin_claim', 'Admin claim', 'e.g. groups'],
  ['oidc_admin_value', 'Admin claim value', 'e.g. ondoku-admins'],
  ['tts_url', 'TTS service URL', 'http://tts:5000'],
  ['default_voice', 'Default natural voice', 'e.g. en_US-lessac-medium'],
  ['audio_cache_mb', 'Audio cache limit (MB)', '2048'],
  ['save_images', 'Save article images on this server', "Download each article's pictures when it is saved, so it keeps them if the site changes or removes them. Turning this on also saves them for older articles.", 'bool', true],
];

function Admin() {
  const { user } = useApp();
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState({});
  const [info, setInfo] = useState(null);
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState(null);
  const [resetFor, setResetFor] = useState(null);

  const load = () => {
    api.get('/api/admin/users').then(setUsers).catch((e) => toast(e.message, { error: true }));
    api.get('/api/admin/settings').then(setSettings).catch(() => {});
    api.get('/api/admin/info').then(setInfo).catch(() => {});
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function updateUser(u, body) {
    try { await api.patch(`/api/admin/users/${u.id}`, body); load(); } catch (e) { toast(e.message, { error: true }); }
  }
  async function saveSettings() {
    try { setSettings(await api.put('/api/admin/settings', draft)); setDraft({}); toast('Settings saved'); load(); } catch (e) { toast(e.message, { error: true }); }
  }
  // On/off settings save as soon as they are switched.
  async function saveSwitch(key, label, on) {
    try { setSettings(await api.put('/api/admin/settings', { [key]: on ? 'true' : 'false' })); toast(`${label}: ${on ? 'on' : 'off'}`); } catch (e) { toast(e.message, { error: true }); }
  }
  const [confirmOidcOnly, setConfirmOidcOnly] = useState(false);

  return (
    <>
      <section className="section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h2 style={{ flex: 1, margin: 0 }}><Users size={16} style={{ verticalAlign: -2, marginRight: 6 }} />Users</h2>
          <button className="btn small" onClick={() => setAdding(true)}><Plus size={14} />Add user</button>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Email</th><th>Articles</th><th>Role</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.email}</b><div className="muted" style={{ fontSize: 12.5 }}>{u.displayName}{u.oidc ? ' · SSO' : ''}{!u.hasPassword ? ' · no password' : ''}</div></td>
                  <td>{u.articleCount}</td>
                  <td>{u.disabled ? <span className="pill bad">Disabled</span> : u.isAdmin ? <span className="pill accent">Admin</span> : <span className="pill">User</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {u.id !== user.id && (
                      <>
                        <button className="btn small ghost" onClick={() => updateUser(u, { isAdmin: !u.isAdmin })}>{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
                        <button className="btn small ghost" onClick={() => updateUser(u, { disabled: !u.disabled })}>{u.disabled ? 'Enable' : 'Disable'}</button>
                        <button className="btn small ghost" onClick={() => setResetFor(u)}>Password</button>
                        <button className="icon-btn small" onClick={() => setDel(u)} aria-label={`Delete ${u.email}`}><Trash2 size={15} /></button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {info && (
        <section className="section">
          <h2>Status</h2>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Version</dt><dd>{info.app} {info.version}</dd>
            <dt>Articles</dt><dd>{info.totals.articles.toLocaleString()} ({info.totals.words.toLocaleString()} words)</dd>
            <dt>Natural voice</dt><dd>{info.tts.online ? <span className="pill ok"><Check size={12} style={{ verticalAlign: -2 }} /> Online</span> : <span className="pill bad">Offline</span>} <span className="muted">{info.tts.url}</span>{info.tts.error && <div className="muted">{info.tts.error}</div>}</dd>
            <dt>Voices</dt><dd>{info.tts.voices.map((v) => v.id).join(', ') || 'none'}</dd>
            <dt>Audio cache</dt><dd>{info.audioCache.tracks} tracks, {bytes(info.audioCache.bytes)}</dd>
            {info.images && <><dt>Saved images</dt><dd>{info.images.files.toLocaleString()} pictures from {info.images.articles.toLocaleString()} articles, {bytes(info.images.bytes)}{info.images.failed ? <span className="muted"> · {info.images.failed} could not be downloaded (shown from their sites)</span> : ''}{info.images.queued ? <span className="muted"> · {info.images.queued} more articles in progress</span> : ''}{!info.images.enabled ? <span className="muted"> · saving is off</span> : ''}</dd></>}
            <dt>Private URLs</dt><dd>{info.allowPrivateUrls ? 'Allowed (ALLOW_PRIVATE_URLS=true)' : 'Blocked'}</dd>
          </dl>
        </section>
      )}


      {settings && (
        <section className="section">
          <h2>Server settings</h2>
          <p className="sub">Values saved here override the environment. Leave a text field empty to use the environment value shown as its placeholder. Switches take effect immediately; text fields need Save settings.</p>
          {SETTING_FIELDS.map(([k, label, hint, type, fallback]) => {
            const s = settings[k];
            if (type === 'bool') {
              const raw = s.value !== '' ? s.value : s.envValue;
              const on = raw == null || raw === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
              const oidcReady = !!((settings.oidc_issuer.value || settings.oidc_issuer.envValue) && (settings.oidc_client_id.value || settings.oidc_client_id.envValue));
              const blocked = k === 'oidc_only' && !oidcReady && !on;
              return (
                <div key={k} className="setting-switch">
                  <div className="setting-text">
                    <b>{label}</b>
                    <small>{hint}{blocked ? ' Set up the OIDC issuer and client ID first.' : ''}{s.value === '' && s.envValue ? ' (Currently set in the environment.)' : ''}</small>
                  </div>
                  <Switch
                    checked={on}
                    disabled={blocked}
                    label={label}
                    onChange={(next) => (k === 'oidc_only' && next ? setConfirmOidcOnly(true) : saveSwitch(k, label, next))}
                  />
                </div>
              );
            }
            const value = draft[k] ?? s.value;
            return (
              <label key={k} className="field">
                <span>{label}</span>
                <input className="input" type={k.includes('secret') ? 'password' : 'text'} value={value} placeholder={s.envValue ? `${s.envValue} (from environment)` : hint} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} autoComplete="off" />
              </label>
            );
          })}
          <button className="btn primary" disabled={!Object.keys(draft).length} onClick={saveSettings}>Save settings</button>
          {confirmOidcOnly && (
            <Confirm
              title="Turn on OIDC only?"
              message="The email and password form disappears from the sign-in page, so everyone, including you, has to sign in with single sign-on. Check that single sign-on works before turning this on."
              confirmLabel="Turn on"
              danger={false}
              onClose={() => setConfirmOidcOnly(false)}
              onConfirm={() => saveSwitch('oidc_only', 'OIDC only', true)}
            />
          )}
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>SSO callback URL: <code>{(settings.public_url.value || settings.public_url.envValue || location.origin).replace(/\/$/, '')}/auth/oidc/callback</code></p>
        </section>
      )}

      {adding && <AddUser onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {resetFor && <ResetPassword u={resetFor} onClose={() => setResetFor(null)} onSave={async (password) => { await updateUser(resetFor, { password }); setResetFor(null); toast('Password set'); }} />}
      {del && <Confirm title={`Delete ${del.email}?`} message={`Their ${del.articleCount} saved articles and audio are deleted too.`} onClose={() => setDel(null)} onConfirm={async () => { await api.del(`/api/admin/users/${del.id}`); load(); }} />}
    </>
  );
}

function AddUser({ onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ email: '', displayName: '', password: '', isAdmin: false });
  async function save(e) {
    e.preventDefault();
    try { await api.post('/api/admin/users', f); onDone(); } catch (err) { toast(err.message, { error: true }); }
  }
  return (
    <Modal title="Add user" sub="They sign in with this email. Leave the password empty for single sign-on only." onClose={onClose}>
      <form onSubmit={save}>
        <label className="field"><span>Email</span><input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoFocus /></label>
        <label className="field"><span>Display name</span><input className="input" value={f.displayName} placeholder={f.email.split('@')[0]} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></label>
        <label className="field"><span>Password</span><input className="input" type="password" minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></label>
        <label className="check"><input type="checkbox" checked={f.isAdmin} onChange={(e) => setF({ ...f, isAdmin: e.target.checked })} /><span>Administrator</span></label>
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary">Add user</button></div>
      </form>
    </Modal>
  );
}

function ResetPassword({ u, onClose, onSave }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title={`New password for ${u.email}`} sub="They will be signed out everywhere." onClose={onClose}>
      <input className="input" type="password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="new-password" />
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={pw.length < 8} onClick={() => onSave(pw)}>Set password</button></div>
    </Modal>
  );
}
