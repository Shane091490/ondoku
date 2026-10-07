// Thin fetch wrapper for the JSON API (session cookie auth).
export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
export const apiEvents = { onUnauthorized: null };

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'You appear to be offline');
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (res.status === 401 && !url.startsWith('/api/auth/')) apiEvents.onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || (typeof data === 'string' && data) || res.statusText, data);
  return data;
}
export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};
export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v != null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}
