// Installing Ondoku as an app, and noticing new versions. The browser's install prompt (Chrome, Edge, Android) is
// kept for an Install button instead of the browser's own banner; Safari on iPhone/iPad has no prompt and is
// installed from the Share menu ("Add to Home Screen"). On Android only an app Chrome builds (a WebAPK) appears in
// other apps' share menu: Brave and Firefox add home-screen shortcuts instead, which the share menu doesn't list.
import { useEffect, useState } from 'react';

let deferredPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
// iPadOS reports itself as a Mac; touch support tells them apart.
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isTouch = () => window.matchMedia?.('(pointer: coarse)').matches;
export const isAndroid = () => /Android/.test(navigator.userAgent);

// A WebAPK opens the app with an android-app://org.chromium.webapk.… referrer. Remembered for the session, since
// it is only there on the first page load.
const WEBAPK_KEY = 'readlog.webapk';
let launchedAsWebApk = false;
try {
  launchedAsWebApk = document.referrer.startsWith('android-app://org.chromium.webapk.') || sessionStorage.getItem(WEBAPK_KEY) === '1';
  if (launchedAsWebApk) sessionStorage.setItem(WEBAPK_KEY, '1');
} catch { /* storage blocked */ }
// Brave reports itself as Chrome; it can be told apart only through navigator.brave.
let brave = false;
navigator.brave?.isBrave?.().then((b) => { brave = !!b; notify(); }).catch(() => {});

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // A new service worker takes over at once (it skips waiting); tell the page so it can offer a reload. Not on
  // the very first visit, when there was no worker before.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) window.dispatchEvent(new Event('ondoku:updated'));
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // An installed app can stay open for days: look for a new version when it comes back to the foreground.
      let checked = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || Date.now() - checked < 3600000) return;
        checked = Date.now();
        reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}

// What the install UI should offer on this device: { canPrompt, installed, ios, android, webapk, shortcutOnly }.
// shortcutOnly names a browser that can only add a home-screen shortcut on Android (no share menu entry).
export function useInstall() {
  const read = () => ({
    canPrompt: !!deferredPrompt,
    installed: isStandalone(),
    ios: isIOS(),
    android: isAndroid(),
    webapk: launchedAsWebApk,
    shortcutOnly: isAndroid() ? (brave ? 'Brave' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : null) : null,
  });
  const [state, setState] = useState(read);
  useEffect(() => {
    const fn = () => setState(read());
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return state;
}

// Shows the browser's install dialog. Resolves true when the app was installed.
export async function promptInstall() {
  const e = deferredPrompt;
  if (!e) return false;
  deferredPrompt = null;
  notify();
  await e.prompt();
  const choice = await e.userChoice.catch(() => null);
  return choice?.outcome === 'accepted';
}
