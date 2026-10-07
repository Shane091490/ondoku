import React, { useState } from 'react';
import { api } from '../api.js';
import { Logo } from '../components/ui.jsx';

export default function Login({ status, onSignedIn }) {
  const setup = status.setupNeeded;
  const [mode, setMode] = useState(setup ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const hashError = new URLSearchParams(location.hash.split('?')[1] || '').get('error');
  const [error, setError] = useState(hashError || '');
  const oidc = status.oidc?.enabled;
  const oidcOnly = oidc && status.oidc.only && !setup;
  // Keep the page the user was heading to (for example a shared link) through the sign-in.
  const redirect = location.hash.startsWith('#/save') || location.hash.startsWith('#/read') ? `/${location.hash}` : '/';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const out = mode === 'register'
        ? await api.post('/api/auth/register', { email, password, displayName })
        : await api.post('/api/auth/login', { email, password });
      onSignedIn(out.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark"><Logo size={26} /></div>
          <h1>{status.appName}</h1>
          <p>{setup ? 'Create the first account. It becomes the administrator.' : 'Save it now. Read or listen later.'}</p>
        </div>
        <div className="panel">
          {error && <div className="form-error">{error}</div>}
          {!oidcOnly && (
            <form onSubmit={submit}>
              <label className="field">
                <span>Email</span>
                <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!oidc} />
              </label>
              {mode === 'register' && (
                <label className="field">
                  <span>Display name <span className="muted">(optional)</span></span>
                  <input className="input" autoComplete="nickname" value={displayName} placeholder={email ? email.split('@')[0] : ''} onChange={(e) => setDisplayName(e.target.value)} />
                </label>
              )}
              <label className="field">
                <span>Password</span>
                <input className="input" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={mode === 'register' ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
                {mode === 'register' && <small>At least 8 characters.</small>}
              </label>
              <button className={`btn block ${oidc ? '' : 'primary'}`} disabled={busy}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}</button>
            </form>
          )}
          {/* Single sign-on below the email form. */}
          {oidc && (
            <>
              {!oidcOnly && <div className="divider">or</div>}
              <a className="btn primary block" href={`/auth/oidc/login?redirect=${encodeURIComponent(redirect)}`}>Sign in with {status.oidc.name}</a>
            </>
          )}
          {!setup && !oidcOnly && status.registrationEnabled && (
            <p style={{ textAlign: 'center', margin: '16px 0 0', fontSize: 14 }} className="muted">
              {mode === 'login' ? <>No account? <button className="linklike" onClick={() => setMode('register')}>Create one</button></> : <>Have an account? <button className="linklike" onClick={() => setMode('login')}>Sign in</button></>}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
