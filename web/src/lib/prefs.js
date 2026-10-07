// Per-device display settings (theme, reader font/size/width, list layout and text size), kept in localStorage.
import { useEffect, useState } from 'react';

const KEY = 'readlog.reader';
export const DEFAULT_DISPLAY = { theme: 'night', font: 'serif', size: 19, lineHeight: 1.7, width: 'medium', showPhotos: true, showLinks: false, listLayout: 'standard', listScale: 1 };
// Text size steps for the article list (1 = 100%).
export const LIST_SCALES = [0.85, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
export function stepListScale(current, dir) {
  const i = LIST_SCALES.findIndex((v) => v >= current - 0.001);
  const at = i === -1 ? LIST_SCALES.length - 1 : i;
  return LIST_SCALES[Math.min(LIST_SCALES.length - 1, Math.max(0, at + dir))];
}
export const WIDTHS = { narrow: '34em', medium: '40em', wide: '48em' };
export const FONTS = { serif: 'var(--serif)', sans: 'var(--ui)', hyper: 'var(--hyper)' };
export const THEMES = ['night', 'black', 'sepia', 'light'];
const THEME_COLORS = { night: '#141416', black: '#000000', sepia: '#f3ead7', light: '#fbfaf7' };

function load() {
  try { return { ...DEFAULT_DISPLAY, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULT_DISPLAY }; }
}
let current = load();
const listeners = new Set();

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.night);
}
applyTheme(current.theme);

export function setDisplay(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ }
  if (patch.theme) applyTheme(patch.theme);
  listeners.forEach((fn) => fn(current));
}
export function useDisplay() {
  const [d, setD] = useState(current);
  useEffect(() => { listeners.add(setD); return () => listeners.delete(setD); }, []);
  return d;
}

// Small per-device memory for list view choices.
export function remember(key, value) {
  try { localStorage.setItem(`readlog.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
}
export function recall(key, fallback) {
  try { const v = localStorage.getItem(`readlog.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
