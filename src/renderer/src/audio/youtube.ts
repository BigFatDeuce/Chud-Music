import { create } from 'zustand';
import type { EngineEvent } from './engine';
import { tr } from '@shared/i18n';
import type { YtQuality } from '@shared/yt-place';

// Drives the official YouTube player that lives in the living cover's <webview> (see
// main/yt-player.ts). Commands go in over the guest preload, state comes back as events.
// Nothing is downloaded or extracted: YouTube plays its own stream in its own player.

type GuestMsg =
  | { type: 'ready' }
  | { type: 'state'; state: number }
  | { type: 'time'; t: number; d: number; loaded: number }
  | { type: 'error'; code: number }
  | { type: 'log'; message: string }
  | { type: 'levels'; l: number[] };

type Cmd = { op: 'load'; id: string; start: number } | { op: 'play' } | { op: 'pause' } | { op: 'stop' } | { op: 'seek'; t: number } | { op: 'volume'; v: number; muted: boolean } | { op: 'rate'; rate: number };

interface WebviewEl extends HTMLElement {
  send(channel: string, ...args: unknown[]): void;
}

const ERRORS: Record<number, () => string> = {
  2: () => tr('yt.err.2'),
  5: () => tr('yt.err.5'),
  100: () => tr('yt.err.100'),
  101: () => tr('yt.err.101'),
  150: () => tr('yt.err.101'),
  153: () => tr('yt.err.153'),
};

/**
 * Engine error code: YouTube refuses this connection for now and asks, in its player, to sign in
 * "to confirm you're not a bot". Not about the track itself (it is not marked unavailable).
 */
export const YT_BLOCKED = 1999;
/** After a refusal, the next videos are checked sooner and not retried (it holds for a while). */
const BLOCK_MEMORY_MS = 120_000;

/** Whether the living cover should mount the player (from the first YouTube track on). */
export const useYtHost = create<{ mounted: boolean }>(() => ({ mounted: false }));

export class YouTubeEngine {
  private view: WebviewEl | null = null;
  private guestReady = false;
  private queue: Cmd[] = [];
  private listeners = new Set<(e: EngineEvent) => void>();
  private t = 0;
  private tAt = 0;
  private playing = false;
  private duration = 0;
  private loaded = 0;
  private volume: Cmd = { op: 'volume', v: 80, muted: false };
  private rate: Cmd = { op: 'rate', rate: 1 };
  private levelData: Uint8Array | null = null;
  private levelsAt = 0;
  private soundAt = 0;
  private quality: YtQuality | null = null;
  // what was asked last, to ask again once when YouTube refuses it (see watchLoad)
  private asked: { id: string; start: number } | null = null;
  private loadSeq = 0;
  private retried = false;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private blockedAt = -Infinity;

  /**
   * Sound levels of the official player (22 bands, 0–255, about 30 per second), measured inside
   * its own page (main/yt-player.ts): null when none came recently (paused, not measurable).
   */
  get levels(): Uint8Array | null {
    const now = performance.now();
    // levels that stay at zero while the video plays are a measure that hears nothing (the
    // capture is refused, or silent): not levels — the spectrum then moves on its own
    return this.levelData && now - this.levelsAt < 400 && now - this.soundAt < 2500 ? this.levelData : null;
  }

  /** Called by the living cover once its <webview> exists (and with null when it goes). */
  attach(view: WebviewEl | null): void {
    if (this.view === view) return;
    this.view = view;
    this.guestReady = false;
    if (!view) return;
    view.addEventListener('dom-ready', () => {
      this.guestReady = true;
      this.send(this.volume);
      this.send(this.rate);
      const q = this.queue;
      this.queue = [];
      q.forEach((c) => this.send(c));
    });
    view.addEventListener('ipc-message', (e) => {
      const ev = e as unknown as { channel: string; args: GuestMsg[] };
      if (ev.channel === 'yt' && ev.args[0]) this.onGuest(ev.args[0]);
    });
  }

  private send(cmd: Cmd): void {
    if (this.view && this.guestReady) this.view.send('yt-cmd', cmd);
    else if (cmd.op === 'load') this.queue = [...this.queue.filter((c) => c.op !== 'load'), cmd];
    else if (cmd.op === 'stop') this.queue = [];
  }

  private onGuest(m: GuestMsg): void {
    switch (m.type) {
      case 'time':
        this.t = m.t;
        this.tAt = performance.now();
        this.loaded = m.loaded;
        if (m.d > 0 && Math.abs(m.d - this.duration) > 0.5) {
          this.duration = m.d;
          this.emit({ type: 'duration', duration: m.d });
        }
        break;
      case 'state':
        // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
        this.playing = m.state === 1;
        this.tAt = performance.now();
        // a new video starts at YouTube's own choice of quality: ask again
        if (m.state === 1) void window.chud.taskbar.youtubeQuality(this.quality);
        if (m.state === 1) {
          clearTimeout(this.watchTimer);
          this.blockedAt = -Infinity;
          this.emit({ type: 'playing' });
        }
        else if (m.state === 2) this.emit({ type: 'paused' });
        else if (m.state === 0) this.emit({ type: 'ended' });
        else if (m.state === 3) this.emit({ type: 'waiting' });
        break;
      case 'error': {
        this.playing = false;
        clearTimeout(this.watchTimer);
        const seq = this.loadSeq;
        const plain = () => this.emit({ type: 'error', code: 1000 + m.code, message: ERRORS[m.code]?.() ?? tr('yt.err.other', { code: String(m.code) }) });
        // the same codes come with the "not a robot" screen: look at what the player shows
        void window.chud.taskbar.youtubeBlocked().then(
          (b) => seq === this.loadSeq && (b === 'signin' ? this.onBlocked() : plain()),
          () => seq === this.loadSeq && plain(),
        );
        break;
      }
      case 'log':
        console.warn('[yt-player]', m.message);
        break;
      case 'levels':
        if (Array.isArray(m.l)) {
          this.levelData = Uint8Array.from(m.l.slice(0, 64), (v) => Math.max(0, Math.min(255, Number(v) || 0)));
          this.levelsAt = performance.now();
          if (this.levelData.some((v) => v > 0)) this.soundAt = this.levelsAt;
        }
        break;
    }
  }

  on(cb: (e: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }

  /**
   * A video that does not start may be refused by YouTube ("Sign in to confirm you're not a bot",
   * shown inside its player). Seen from here, by reading the player's own screen: asked once more
   * after a pause (it often goes through then), and otherwise reported as YT_BLOCKED so playback
   * moves on with a clear explanation, instead of a silent player and a 25 s wait.
   */
  private watchLoad(delay: number): void {
    clearTimeout(this.watchTimer);
    const seq = this.loadSeq;
    this.watchTimer = setTimeout(() => {
      if (seq !== this.loadSeq || this.playing) return;
      void window.chud.taskbar.youtubeBlocked().then((b) => {
        if (seq !== this.loadSeq || this.playing) return;
        if (b === 'signin') this.onBlocked();
        else if (b === null) this.watchLoad(4000); // still loading (slow network, an ad): look again
      }, () => {});
    }, delay);
  }

  private onBlocked(): void {
    const recent = performance.now() - this.blockedAt < BLOCK_MEMORY_MS;
    if (!this.retried && !recent && this.asked) {
      this.retried = true;
      const { id, start } = this.asked;
      const seq = this.loadSeq;
      setTimeout(() => {
        if (seq !== this.loadSeq) return;
        this.send({ op: 'load', id, start });
        this.watchLoad(7000);
      }, 2500);
      return;
    }
    this.blockedAt = performance.now();
    this.playing = false;
    this.emit({ type: 'error', code: YT_BLOCKED, message: tr('yt.err.bot') });
  }

  load(videoId: string, startAt = 0): void {
    useYtHost.setState({ mounted: true });
    this.loadSeq++;
    this.asked = { id: videoId, start: startAt };
    this.retried = false;
    this.watchLoad(performance.now() - this.blockedAt < BLOCK_MEMORY_MS ? 3000 : 6000);
    this.emit({ type: 'load' });
    this.t = startAt;
    this.tAt = performance.now();
    this.duration = 0;
    this.loaded = 0;
    this.send({ op: 'load', id: videoId, start: startAt });
  }

  play(): void {
    this.send({ op: 'play' });
  }

  pause(): void {
    this.send({ op: 'pause' });
  }

  stop(): void {
    this.loadSeq++;
    clearTimeout(this.watchTimer);
    this.playing = false;
    this.t = 0;
    this.send({ op: 'stop' });
  }

  seek(sec: number): void {
    if (!Number.isFinite(sec)) return;
    this.t = Math.max(0, sec);
    this.tAt = performance.now();
    this.send({ op: 'seek', t: this.t });
  }

  /** Extrapolated between the player's 4 Hz time reports. */
  get currentTime(): number {
    const r = this.rate.op === 'rate' ? this.rate.rate : 1;
    return this.playing ? this.t + ((performance.now() - this.tAt) / 1000) * r : this.t;
  }

  get bufferedEnd(): number {
    return this.loaded * this.duration;
  }

  /**
   * The best picture quality to ask YouTube for (null: its own choice), from where the player
   * shows (shared/yt-place.ts, ytQualityCap). A request: YouTube keeps the last word.
   */
  setQualityCap(cap: YtQuality | null): void {
    if (cap === this.quality) return;
    this.quality = cap;
    if (this.view && this.guestReady) void window.chud.taskbar.youtubeQuality(cap);
  }

  /** Playback speed (YouTube accepts 0.25–2). */
  setRate(rate: number): void {
    this.rate = { op: 'rate', rate };
    this.send(this.rate);
  }

  setVolume(v: number, muted: boolean): void {
    // same perceptual curve as the local engine
    this.volume = { op: 'volume', v: Math.round(v * v * 100), muted };
    this.send(this.volume);
  }
}
