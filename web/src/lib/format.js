// Small display helpers.
export function relDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
export function longDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
export function minutes(n) {
  return n ? `${n} min` : '';
}
// FTS snippets mark matches with \u0002 … \u0003; render them as <mark> without using innerHTML.
export function snippetParts(s) {
  const out = [];
  const re = /\u0002([^\u0003]*)\u0003/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ text: m[1], mark: true });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

// 730 -> "about 2 years" (the "delete archived articles after N days" setting).
export function aboutDays(n) {
  if (n >= 365) { const y = Math.round((n / 365) * 10) / 10; return `about ${y} ${y === 1 ? 'year' : 'years'}`; }
  if (n >= 60) return `about ${Math.round(n / 30.44)} months`;
  if (n >= 14 && n % 7 === 0) return `${n / 7} weeks`;
  return '';
}
