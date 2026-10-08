// Continuous play: when an article finishes, the next one in the queue starts. "Next" follows the queue's order on
// this device (its Sort choice) after the current article, skipping articles already played in this listening
// session and ones without text yet.
import { api, qs } from '../api.js';
import { recall } from './prefs.js';

const played = new Set();

export function startListeningSession() { played.clear(); }
export function markPlayed(id) { played.add(id); }

export async function nextInQueue(currentId) {
  played.add(currentId);
  const sort = recall('sort.queue', 'newest');
  const { items } = await api.get(`/api/articles${qs({ view: 'queue', sort, limit: 200 })}`);
  const playable = (a) => a.id !== currentId && a.status === 'ok' && a.wordCount > 0 && !played.has(a.id);
  const at = items.findIndex((a) => a.id === currentId);
  return (at === -1 ? null : items.slice(at + 1).find(playable)) || items.find(playable) || null;
}

// Gets the next article's audio made while the current one plays, behind anything else the server is doing.
export function prepareAudio(articleId, voice) {
  return api.post(`/api/articles/${articleId}/audio`, { voice: voice || undefined, background: true }).catch(() => null);
}
