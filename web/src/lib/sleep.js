// Sleep timer for read aloud: stops playback after some minutes, or when the current article ends. It lives outside
// the player so it keeps counting when continuous play moves on to the next article.
import { useEffect, useState } from 'react';

let state = { mode: null, until: 0 }; // mode: 'minutes' | 'end' | null
let timer = null;
let stopPlayback = null; // set by the open player: pauses it
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(state));

function fire() {
  clearTimeout(timer);
  timer = null;
  state = { mode: null, until: 0, firedAt: Date.now() };
  stopPlayback?.();
  notify();
}

export function setSleepMinutes(minutes) {
  clearTimeout(timer);
  state = { mode: 'minutes', until: Date.now() + minutes * 60000 };
  timer = setTimeout(fire, minutes * 60000);
  notify();
}
export function setSleepEndOfArticle() {
  clearTimeout(timer);
  timer = null;
  state = { mode: 'end', until: 0 };
  notify();
}
export function clearSleep() {
  clearTimeout(timer);
  timer = null;
  state = { mode: null, until: 0 };
  notify();
}
export const sleepAtEnd = () => state.mode === 'end';
// Called when an article ends with "end of article" set: playback stops there.
export function sleepEndReached() { if (state.mode === 'end') fire(); }
// Timers can run late on a phone with the screen off; playback progress checks the deadline too.
export function checkSleep() { if (state.mode === 'minutes' && Date.now() >= state.until) fire(); }
export function setSleepStopper(fn) { stopPlayback = fn; }
// The timer went off moments ago (for example while continuous play was moving to the next article): don't start.
export const sleepFiredRecently = () => !!state.firedAt && Date.now() - state.firedAt < 15000;

// { mode, until, left } with left in whole minutes, refreshed every 15 s while a countdown runs.
export function useSleep() {
  const [s, setS] = useState(state);
  const [, tick] = useState(0);
  useEffect(() => {
    listeners.add(setS);
    return () => listeners.delete(setS);
  }, []);
  useEffect(() => {
    if (s.mode !== 'minutes') return undefined;
    const t = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, [s.mode]);
  return { ...s, left: s.mode === 'minutes' ? Math.max(1, Math.ceil((s.until - Date.now()) / 60000)) : 0 };
}
