// Voice choices for the player and settings. A voice key is a model id ("en_US-lessac-high") or, for models with
// many speakers, model id + "#" + speaker ("en_GB-vctk-medium#p239"). Multi-speaker models appear through the
// speakers the user picked in Settings (or with their first speaker until they pick some).
export const groupLabel = (v) => (v.languageName ? `${v.languageName}${v.region ? ` (${v.region})` : ''}` : v.language);
export const isMulti = (v) => (v.speakerNames || []).length > 1;

// Whether a key can be read with, as the server decides it: an installed voice this version supports, and (after
// the one "#") one of its speakers.
export function voiceKeyOk(voices = [], key = '') {
  const parts = String(key || '').split('#');
  const v = parts.length <= 2 && voices.find((x) => x.id === parts[0]);
  return !!v && v.supported !== false && (parts.length === 1 || (v.speakerNames || []).includes(parts[1]));
}

// currentKey is the voice reading now. It is always offered, even a speaker the user hasn't picked (the admin's
// default voice, for example), so the player can show it as selected.
export function voiceChoices(voices = [], prefs = {}, currentKey = '') {
  const out = [];
  const current = voiceKeyOk(voices, currentKey) ? currentKey : '';
  for (const v of voices) {
    if (v.supported === false) continue; // installed, but this version can't run it
    const base = { group: groupLabel(v), hint: v.region || v.language };
    if (!isMulti(v)) { out.push({ ...base, key: v.id, label: v.name }); continue; }
    const picked = (prefs.speakers || []).filter((k) => k.startsWith(`${v.id}#`) && voiceKeyOk([v], k));
    const shown = current.startsWith(`${v.id}#`) && !picked.includes(current) ? [...picked, current] : picked;
    shown.forEach((k) => out.push({ ...base, key: k, label: `${v.name} · ${k.split('#')[1]}` }));
    if (!picked.length || current === v.id) out.push({ ...base, key: v.id, label: v.name, hint: `${base.hint} · speaker ${v.speakerNames[0]}` });
  }
  return out;
}

export function groupBy(list, fn) {
  const map = new Map();
  for (const item of list) {
    const k = fn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return [...map.entries()];
}

export function fmtSize(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
