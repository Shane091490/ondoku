import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, apiEvents } from './api.js';
import { useHashRoute, matchPath, navigate } from './router.jsx';
import { ToastProvider, useToast } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import List from './pages/List.jsx';
import Reader from './pages/Reader.jsx';
import Save from './pages/Save.jsx';
import Settings from './pages/Settings.jsx';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export default function App() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const route = useHashRoute();

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get('/api/auth/status'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    apiEvents.onUnauthorized = () => setStatus((s) => (s ? { ...s, user: null } : s));
  }, []);
  useEffect(() => { if (status?.appName) document.title = status.appName; }, [status?.appName]);

  const setUser = (user) => setStatus((s) => ({ ...s, user, setupNeeded: false }));

  if (!status) {
    return (
      <div className="auth">
        {error ? (
          <div className="empty"><h3>Can't reach the server</h3><p>{error}</p><button className="btn" onClick={refresh}>Try again</button></div>
        ) : <div className="muted">Loading…</div>}
      </div>
    );
  }

  let page;
  if (!status.user) page = <Login status={status} onSignedIn={setUser} />;
  else {
    const { path, query } = route;
    let m;
    if (path === '/' || path === '/queue') page = <List view="queue" query={query} />;
    else if (path === '/starred') page = <List view="starred" query={query} />;
    else if (path === '/archive') page = <List view="archive" query={query} />;
    else if (path === '/all') page = <List view="all" query={query} />;
    else if ((m = matchPath('/read/:id', path))) page = <Reader key={m.id} id={Number(m.id)} query={query} />;
    else if (path === '/save') page = <Save query={query} />;
    else if (path === '/settings' || (m = matchPath('/settings/:tab', path))) page = <Settings tab={m?.tab || 'account'} />;
    else if (path === '/login') { navigate('/', { replace: true }); page = null; }
    else page = <List view="queue" query={query} />;
  }

  return (
    <AppCtx.Provider value={{ status, user: status.user, setUser, refresh }}>
      <ToastProvider>{page}<AppEvents /></ToastProvider>
    </AppCtx.Provider>
  );
}

// App-wide notices: a new version is ready (the service worker updated), and being offline.
function AppEvents() {
  const toast = useToast();
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const updated = () => toast('A new version of the app is ready', { duration: 60000, action: { label: 'Reload', onClick: () => location.reload() } });
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('ondoku:updated', updated);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('ondoku:updated', updated); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [toast]);
  return online ? null : <div className="offline-pill" role="status">Offline · showing what's saved on this device</div>;
}
