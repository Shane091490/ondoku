// Tiny hash router: #/path?query. No dependency, works offline and behind any proxy path.
import React, { useEffect, useState } from 'react';

function parse() {
  const h = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const [p, q = ''] = h.split('?');
  const path = (p.startsWith('/') ? p : '/' + p).replace(/\/+$/, '') || '/';
  return { path, query: new URLSearchParams(q) };
}

let navDepth = 0;
let skipNext = false;
window.addEventListener('hashchange', () => { if (skipNext) { skipNext = false; return; } navDepth++; });

export function useHashRoute() {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const h = () => setR(parse());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return r;
}
export function navigate(to, { replace = false } = {}) {
  const target = '#' + (to.startsWith('/') ? to : '/' + to);
  if (replace) {
    skipNext = true;
    history.replaceState(null, '', location.pathname + location.search + target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else location.hash = target;
}
// Go back inside the app; fall back to a route when the app was opened directly on a deep page.
export function goBack(fallback = '/') {
  if (navDepth > 0) { navDepth -= 2; history.back(); } else navigate(fallback, { replace: true });
}
export function matchPath(pattern, path) {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
export function Link({ to, children, ...rest }) {
  return <a href={'#' + to} {...rest}>{children}</a>;
}
