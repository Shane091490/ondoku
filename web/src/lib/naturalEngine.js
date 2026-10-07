// Read aloud with the server's Piper voices. The server renders one clip per block; while it works, finished
// clips play one after another, and once the whole article is done playback moves to the single MP3 (which keeps
// playing with the phone locked and supports seeking). The track manifest maps time to blocks for highlighting.
import { api } from '../api.js';

export class NaturalEngine {
  constructor({ articleId, total, voice, rate, meta, onState, onSegment, onEnd }) {
    this.kind = 'natural';
    this.articleId = articleId;
    this.total = total;
    this.voice = voice || '';
    this.rate = rate || 1;
    this.meta = meta || {};
    this.onState = onState;
    this.onSegment = onSegment;
    this.onEnd = onEnd;
    this.track = null;
    this.mode = null; // 'full' | 'clips'
    this.n = 0; // manifest index of the current block
    this.seg = 0;
    this.status = 'loading';
    this.wantPlay = false;
    this.error = '';
    this.destroyed = false;
    this.gen = 0; // counts requests for a track; answers to an earlier one (another voice) are dropped
    this.retried = false; // asked again once already after the track disappeared
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.bind();
  }

  bind() {
    const a = this.audio;
    // mode stays null while only the silent unlock clip has played; ignore its events.
    a.addEventListener('timeupdate', () => { if (this.mode) this.onTime(); });
    a.addEventListener('playing', () => { if (this.mode) this.emit({ status: 'playing' }); });
    a.addEventListener('pause', () => { if (this.mode && !a.ended && this.status === 'playing') this.emit({ status: 'paused' }); });
    a.addEventListener('waiting', () => { if (this.mode && this.wantPlay) this.emit({ status: 'buffering' }); });
    a.addEventListener('ended', () => { if (this.mode) this.onClipEnded(); });
    a.addEventListener('ratechange', () => { if (Math.abs(a.playbackRate - this.rate) > 0.01) a.playbackRate = this.rate; });
    a.addEventListener('error', () => {
      if (!a.src || this.destroyed || !this.mode) return;
      this.emit({ status: 'error', error: 'The audio could not be played' });
    });
  }

  emit(patch = {}) {
    Object.assign(this, patch);
    if (this.destroyed) return;
    const t = this.track;
    this.onState?.({
      engine: 'natural',
      status: this.status,
      seg: this.seg,
      total: this.total,
      rate: this.rate,
      voice: this.voice,
      error: this.error,
      mode: this.mode,
      time: this.currentTime(),
      duration: t?.status === 'ready' ? t.duration : null,
      prep: t && t.status !== 'ready' ? { done: t.segmentsDone, total: t.segmentsTotal, status: t.status } : null,
      ready: t?.status === 'ready',
      trackError: t?.status === 'failed' ? t.error : null,
    });
  }

  currentTime() {
    const t = this.track;
    if (!t) return 0;
    if (this.mode === 'full') return this.audio.currentTime || 0;
    const entry = t.segments[this.n];
    return entry ? entry.start + (this.audio.currentTime || 0) : 0;
  }

  // Request (or find) the track for this voice and follow it until it is ready. retry: asking again after the
  // track disappeared (see trackLost).
  async start(fromSeg, retry = false) {
    const gen = ++this.gen;
    clearTimeout(this.pollTimer);
    if (!retry) this.retried = false;
    this.seg = fromSeg || 0;
    this.emit({ status: 'loading', error: '' });
    let track;
    try {
      track = await api.post(`/api/articles/${this.articleId}/audio`, { voice: this.voice || undefined });
    } catch (e) {
      if (gen === this.gen) this.emit({ status: 'error', error: e.message });
      return;
    }
    if (this.destroyed || gen !== this.gen) return; // another voice was picked meanwhile
    this.track = track;
    this.voice = track.voice;
    if (this.track.status !== 'ready') this.poll();
    this.emit({ status: this.track.status === 'ready' ? 'paused' : 'preparing' });
    if (this.wantPlay) this.play(this.seg);
  }

  async poll() {
    clearTimeout(this.pollTimer);
    if (this.destroyed || !this.track || this.track.status === 'ready') return;
    const gen = this.gen;
    let t;
    try {
      t = await api.get(`/api/articles/${this.articleId}/audio?voice=${encodeURIComponent(this.voice)}`);
    } catch { /* keep trying */ }
    if (this.destroyed || gen !== this.gen) return;
    if (t === null) { this.trackLost(); return; }
    if (t) this.track = t;
    if (this.track.status === 'failed') { this.emit({ status: 'error', error: this.track.error || 'The voice could not be generated' }); return; }
    // Waiting for the next clip: carry on as soon as it exists.
    if (this.wantPlay && (this.status === 'preparing' || this.status === 'buffering')) this.resumeWaiting();
    this.emit();
    if (this.track.status !== 'ready') this.pollTimer = setTimeout(() => this.poll(), 2000);
  }

  // The track was deleted while it was being made: its voice was removed, or this article's audio was asked for in
  // another voice. Ask once more (the server falls back to another voice if this one is gone); if that track
  // disappears too, stop and say so instead of waiting forever.
  trackLost() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.mode = null;
    if (this.retried) {
      this.track = { ...this.track, status: 'failed', error: 'The audio for this article was stopped. Press play to try again.' };
      this.emit({ status: 'error', error: this.track.error });
      return;
    }
    this.retried = true;
    this.track = null;
    this.start(this.seg, true);
  }

  entryIndexForSeg(seg) {
    const segs = this.track?.segments || [];
    let idx = segs.findIndex((e) => e.seg >= seg);
    if (idx === -1) idx = segs.length ? (this.track.status === 'ready' ? segs.length - 1 : -1) : -1;
    return idx;
  }

  resumeWaiting() {
    const idx = this.entryIndexForSeg(this.seg);
    if (idx >= 0) this.playEntry(idx);
  }

  playEntry(idx) {
    const t = this.track;
    const entry = t.segments[idx];
    if (!entry) return;
    this.n = idx;
    this.setSeg(entry.seg);
    if (t.status === 'ready') {
      if (this.mode !== 'full') {
        this.mode = 'full';
        this.audio.src = t.url;
      }
      const seek = () => { this.audio.currentTime = entry.start + 0.01; this.go(); };
      if (this.audio.readyState >= 1) seek(); else this.audio.addEventListener('loadedmetadata', seek, { once: true });
    } else {
      this.mode = 'clips';
      this.audio.src = `/api/articles/${this.articleId}/audio/${t.id}/seg/${entry.n}`;
      this.go();
    }
    this.updateMediaSession();
  }

  go() {
    this.audio.playbackRate = this.rate;
    this.audio.play().then(() => this.emit({ status: 'playing' })).catch((e) => {
      if (e.name === 'NotAllowedError') this.emit({ status: 'paused', wantPlay: false });
      else if (e.name !== 'AbortError') this.emit({ status: 'error', error: e.message });
    });
  }

  onClipEnded() {
    if (this.mode === 'full') {
      this.wantPlay = false;
      this.emit({ status: 'ended' });
      this.onEnd?.();
      return;
    }
    const nextIdx = this.n + 1;
    const t = this.track;
    if (nextIdx >= t.segmentsTotal && t.segmentsTotal > 0) { this.wantPlay = false; this.emit({ status: 'ended' }); this.onEnd?.(); return; }
    if (nextIdx < t.segments.length) { this.playEntry(nextIdx); return; }
    // The next clip isn't rendered yet.
    this.seg = (t.segments[this.n]?.seg ?? this.seg) + 1;
    this.emit({ status: 'buffering' });
  }

  onTime() {
    if (this.mode !== 'full' || !this.track) { this.emitThrottled(); return; }
    const time = this.audio.currentTime;
    const segs = this.track.segments;
    let idx = this.n;
    if (!segs[idx] || time < segs[idx].start || time >= segs[idx].end) {
      idx = segs.findIndex((e) => time >= e.start && time < e.end);
      if (idx === -1) idx = segs.length - 1;
    }
    if (idx !== this.n || segs[idx]?.seg !== this.seg) { this.n = idx; this.setSeg(segs[idx].seg); }
    this.emitThrottled();
  }

  emitThrottled() {
    const now = performance.now();
    if (now - (this.lastEmit || 0) < 250) return;
    this.lastEmit = now;
    this.emit();
    if (this.mode === 'full' && 'mediaSession' in navigator && this.audio.duration) {
      try { navigator.mediaSession.setPositionState({ duration: this.audio.duration, playbackRate: this.rate, position: Math.min(this.audio.currentTime, this.audio.duration) }); } catch { /* unsupported */ }
    }
  }

  setSeg(seg) {
    if (seg === this.seg && this.reported === seg) return;
    this.seg = seg;
    this.reported = seg;
    this.onSegment?.(seg);
  }

  // Mobile browsers only allow audio started from a tap. When the real audio isn't ready yet, play a short
  // silent clip during the tap so the element may start playing on its own later.
  unlock() {
    if (this.unlocked || this.mode) return;
    this.unlocked = true;
    try {
      const rate = 8000;
      const samples = rate / 10;
      const buf = new ArrayBuffer(44 + samples * 2);
      const v = new DataView(buf);
      const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples * 2, true);
      this.audio.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      this.audio.play().catch(() => {});
    } catch { /* best effort */ }
  }

  play(fromSeg) {
    if (fromSeg != null) this.seg = Math.max(0, Math.min(fromSeg, this.total - 1));
    this.wantPlay = true;
    if (!this.track || this.track.status !== 'ready') this.unlock();
    if (!this.track) { if (this.status === 'error') this.start(this.seg); return; } // the request failed: try again
    if (this.track.status === 'failed') { this.start(this.seg); return; }
    const sameSpot = fromSeg == null && this.audio.src && this.audio.paused && !this.audio.ended && this.status === 'paused';
    if (sameSpot) { this.go(); return; }
    const idx = this.entryIndexForSeg(this.seg);
    if (idx >= 0) this.playEntry(idx);
    else this.emit({ status: this.track.status === 'ready' ? 'paused' : 'preparing' });
  }

  pause() {
    this.wantPlay = false;
    this.audio.pause();
    this.emit({ status: this.track?.status === 'ready' || this.audio.src ? 'paused' : this.status === 'preparing' ? 'preparing' : 'paused' });
  }

  toggle() {
    if (this.wantPlay && this.status !== 'paused' && this.status !== 'ended' && this.status !== 'error') this.pause();
    else this.play(this.status === 'ended' ? 0 : undefined);
  }

  jump(seg) {
    seg = Math.max(0, Math.min(seg, this.total - 1));
    const idx = this.entryIndexForSeg(seg);
    this.seg = seg;
    this.onSegment?.(seg);
    if (idx >= 0 && (this.wantPlay || this.status === 'playing')) this.playEntry(idx);
    else if (idx >= 0 && this.track?.status === 'ready') {
      this.n = idx;
      const entry = this.track.segments[idx];
      if (this.mode !== 'full') { this.mode = 'full'; this.audio.src = this.track.url; }
      const seek = () => { this.audio.currentTime = entry.start + 0.01; this.emit(); };
      if (this.audio.readyState >= 1) seek(); else this.audio.addEventListener('loadedmetadata', seek, { once: true });
    } else this.emit();
  }

  next() { this.jump(this.seg + 1); }
  prev() {
    // Like a music player: first press restarts the current block, a quick second press goes back one.
    const entry = this.track?.segments[this.n];
    if (entry && this.currentTime() - entry.start > 2.5) this.jump(this.seg); else this.jump(this.seg - 1);
  }

  seekTo(seconds) {
    if (!this.track || this.track.status !== 'ready') return;
    if (this.mode !== 'full') { this.mode = 'full'; this.audio.src = this.track.url; }
    const doSeek = () => { this.audio.currentTime = Math.max(0, Math.min(seconds, this.track.duration - 0.1)); this.onTime(); };
    if (this.audio.readyState >= 1) doSeek(); else this.audio.addEventListener('loadedmetadata', doSeek, { once: true });
  }
  skip(delta) { if (this.mode === 'full') this.seekTo(this.audio.currentTime + delta); else if (delta > 0) this.next(); else this.prev(); }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
    this.emit();
  }

  async setVoice(voice) {
    if (voice === this.voice) return;
    clearTimeout(this.pollTimer);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.mode = null;
    this.voice = voice;
    this.track = null;
    await this.start(this.seg); // keeps playing if it was (start() plays when wantPlay is set)
  }

  updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({
        title: this.meta.title || 'Article',
        artist: this.meta.site || '',
        album: this.meta.app || 'Ondoku',
        artwork: this.meta.image ? [{ src: this.meta.image, sizes: '512x512' }] : [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      ms.setActionHandler('play', () => this.play());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('nexttrack', () => this.next());
      ms.setActionHandler('seekbackward', (d) => this.skip(-(d.seekOffset || 15)));
      ms.setActionHandler('seekforward', (d) => this.skip(d.seekOffset || 30));
      ms.setActionHandler('seekto', (d) => this.seekTo(d.seekTime));
    } catch { /* some actions unsupported */ }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.pollTimer);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = null; for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto']) navigator.mediaSession.setActionHandler(a, null); } catch { /* ignore */ }
    }
  }
}
