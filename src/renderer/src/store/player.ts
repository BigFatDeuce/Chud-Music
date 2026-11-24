import { create } from 'zustand';
import type { RepeatMode, SavedPlayer, SavedTrack, Track } from '@shared/types';
import { chainMode, sameAlbum, sleepStopsAfter } from '@shared/chain';
import { replayGainFactor } from '@shared/replaygain';
import { playerMachine, playerStatus, type PlayerEvent, type PlayerPhase, type PlayerStatus } from '@shared/machines';
import { engine } from '@/audio/engine';
import { YT_BLOCKED } from '@/audio/youtube';
import { useSettings } from './settings';
import { OPENED_TAB, useTabs } from './tabs';
import { toast } from './toasts';
import { onPlaylistChanged, usePlaylists } from './playlists';
import { notePlayed, useLibrary } from './library';
import { tr } from '@shared/i18n';
import { onSleepTime, useSleep } from './sleep';
import { closeRadio, playRadioFrom, radioPos, watchRadio } from './radio';

// Three distinct things, never mixed up:
//  • a saved playlist (database) — only changed by explicit edits;
//  • the playback context — a snapshot of the list playback was started from (a tab),
//    with its order and position; switching context never edits the previous list, and
//    its position is remembered in `resume`;
//  • the "up next" queue — temporary, consumed before the context continues; it outlives the app
//    only with the rest of what was playing (the snapshot).

export interface PlayContext {
  tabId: string;
  label: string;
  tracks: Track[];
  order: number[]; // indices into tracks, shuffled or not
  pos: number; // position in `order`
}

export interface QueueItem {
  key: number;
  track: Track;
}

interface PlayerState {
  ctx: PlayContext | null;
  current: Track | null;
  /** The current track came from the up-next queue (the context position is unchanged). */
  fromQueue: boolean;
  upNext: QueueItem[];
  /** What the interface shows of the playback state (shared/machines.ts). */
  status: PlayerStatus;
  duration: number;
  transcoded: boolean;
  /** Position to resume from after a restart (nothing loaded yet). */
  resumeAt: number;
  resume: Record<string, { trackId: string; time: number }>;
  playFrom(tabId: string, label: string, tracks: Track[], index: number, startAt?: number): void;
  resumeTab(tabId: string, label: string, tracks: Track[]): void;
  jumpTo(pos: number): void;
  /** Plays another version of the current track in its place (the clip tab: the music video of a
   *  YouTube Music song), from the start; the list it was played from gets it too. */
  swapCurrent(track: Track): void;
  playQueued(key: number): void;
  playNext(tracks: Track[]): void;
  enqueue(tracks: Track[]): void;
  removeQueued(keys: number[]): void;
  moveQueued(keys: number[], toIndex: number): void;
  clearQueue(): void;
  /** Out of what remains of the list (positions in its order): the playlist itself is not edited. */
  removeFromContext(positions: number[]): void;
  /** Moves these entries of what remains of the list before position `to`. */
  moveInContext(positions: number[], to: number): void;
  /** Nothing is left to play after the current track: neither queue nor rest of the list. */
  clearAll(): void;
  /** What is playing, the queue, and the rest of the list, in the order they will be played. */
  queueTracks(): Track[];
  toggle(): void;
  next(): void;
  prev(): void;
  seek(sec: number): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  restore(): Promise<void>;
}

function shuffled(n: number, first: number): number[] {
  const rest = [...Array(n).keys()].filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return [first, ...rest];
}

/**
 * What comes after the current track. Asked for twice with nothing changed in between, the answer
 * is the same (a reshuffle included): the track prepared ahead is the one that will play.
 */
type Next =
  | { kind: 'repeat'; track: Track }
  | { kind: 'queue'; item: QueueItem; track: Track }
  | { kind: 'ctx'; ctx: PlayContext; track: Track }
  /** The end of the list: back to its start, at rest. */
  | { kind: 'end' }
  | { kind: 'none' };

function sameNext(a: Next, b: Next): boolean {
  if (a.kind === 'queue' && b.kind === 'queue') return a.item.key === b.item.key;
  if (a.kind === 'ctx' && b.kind === 'ctx') return a.ctx.pos === b.ctx.pos && a.track.id === b.track.id;
  if (a.kind === 'repeat' && b.kind === 'repeat') return a.track.id === b.track.id;
  return a.kind === b.kind;
}
const nextTrack = (n: Next): Track | null => (n.kind === 'end' || n.kind === 'none' ? null : n.track);

/** The list without these entries (indices into its tracks), everything else in place. */
function withoutTracks(ctx: PlayContext, gone: Set<number>): PlayContext {
  const at = new Map<number, number>();
  const tracks = ctx.tracks.filter((_, i) => {
    if (gone.has(i)) return false;
    at.set(i, at.size);
    return true;
  });
  const here = ctx.order[ctx.pos]!;
  const order = ctx.order.filter((i) => !gone.has(i)).map((i) => at.get(i)!);
  return { ...ctx, tracks, order, pos: Math.max(0, order.indexOf(at.get(here)!)) };
}

const trackKey = (t: Track) => (t.entryId != null ? `e${t.entryId}` : t.id);

let generation = 0; // guards against late async results when tracks change quickly
let failures = 0;
let queueSeq = 0;
// Where playback is: the states and the events each one takes are the table of
// shared/machines.ts. `status` (what the interface shows) follows from it.
let phase: PlayerPhase = playerMachine.initial;
// the load on its way: where it starts from, and when it was asked for
let pendingStart = 0;
let loadAt = 0;
// the order the list takes when it starts again, drawn once (peek may be asked several times)
let reshuffle: { of: number[]; order: number[] } | null = null;
// the next track, prepared ahead in the engine
let planned: { key: string; next: Next; transcoded: boolean } | null = null;
let planSeq = 0;
/** How long a share that stopped answering is waited for, and how often it is asked (ms). */
const SHARE_PATIENCE = 120_000;
const SHARE_RETRIES = [1000, 2000, 4000, 8000, 15_000];
/** No sound for this long while a file plays: is its disk or share still there? */
const STALL_MS = 15_000;
/** A second click right after the one that started a load is a double click, not "cancel". */
const CANCEL_AFTER_MS = 500;

/** A YouTube track is the current one and playback is not at rest: its player shows. */
export const isYtLive = (s: { current: Track | null; status: PlayerStatus }): boolean => s.current?.source === 'youtube' && s.status !== 'idle';

/** Set by the store below: the next track may have changed (`force`: prepare it again anyway). */
let replan: (force: boolean) => void = () => {};

export const usePlayer = create<PlayerState>((set, get) => {
  /**
   * The only place the playback state (and so `status`) changes. False, and nothing changed,
   * when the current state does not take this event.
   */
  function go(event: PlayerEvent, patch: Partial<PlayerState> = {}): boolean {
    const to = playerMachine.next(phase, event);
    if (!to) return false;
    const changed = to !== phase;
    phase = to;
    if (changed || Object.keys(patch).length) set({ ...patch, status: playerStatus(to) });
    return true;
  }

  async function start(startAt = 0, forceTranscode = false, explicit?: Track): Promise<void> {
    const { ctx } = get();
    const track = explicit ?? (ctx ? ctx.tracks[ctx.order[ctx.pos]!] : undefined);
    if (!track) return;
    const gen = ++generation;
    pendingStart = startAt;
    loadAt = performance.now();
    go('LOAD', { current: track, fromQueue: !!explicit, duration: track.durationSec ?? 0, transcoded: false, resumeAt: 0 });
    listened = 0;
    counted = false;
    updateMediaSession(track);
    if (track.source !== 'radio') closeRadio();
    if (track.source === 'youtube') {
      if (!track.videoId) return fail(track, tr('play.unavailable'), gen);
      // YouTube's own player, shown in the living cover; it reports back through engine events
      engine.loadYouTube(track.videoId, startAt);
      saveSnapshot();
      setTimeout(() => {
        if (gen === generation && phase === 'loading') fail(track, tr('play.ytTimeout'), gen);
      }, 25_000);
      return;
    }
    if (track.source === 'radio') {
      if (!track.streamUrl) return fail(track, tr('play.noStream'), gen);
      try {
        // relayed by the main process: the equaliser and visualiser hear it, ICY titles come back,
        // and the last 30 minutes stay in memory (time shift, recording: store/radio.ts)
        await playRadioFrom(track, null, () => gen === generation);
        if (gen !== generation) return;
        window.chud.radio.played(track.id.replace(/^radio:/, ''));
        saveSnapshot();
      } catch (e) {
        if (gen !== generation) return;
        fail(track, tr('play.radioDead'), gen);
      }
      return;
    }
    if (!track.path) return fail(track, track.problem ?? tr('play.unavailable'), gen);
    // "unavailable" may be old news (a share that was down): the file itself is asked
    try {
      const src = await window.chud.media.resolve(track.path, track.codec, forceTranscode);
      if (gen !== generation) return;
      const gain = await gainOf(track, 250);
      if (gen !== generation) return;
      set({ transcoded: src.transcoded });
      await engine.loadLocal(src.url, startAt, gain);
      saveSnapshot();
    } catch (e) {
      if (gen !== generation) return;
      if (await waitForShare(track, startAt, gen)) return;
      if (gen === generation) fail(track, e instanceof Error ? e.message : String(e), gen);
    }
  }

  /**
   * The factor for this track (volume normalisation). Not known within `wait` ms (a file measured
   * for the first time): the level of the one before goes on, and follows once measured.
   */
  function gainOf(track: Track, wait: number): Promise<number> {
    const mode = useSettings.getState().replayGain;
    if (mode === 'off' || !track.path) return Promise.resolve(1);
    const known = window.chud.media.loudness(track.path).then((l) => replayGainFactor(useSettings.getState().replayGain, l));
    void known.then((g) => get().current?.id === track.id && engine.kind === 'local' && engine.local.setTrackGain(g));
    return Promise.race([known, new Promise<number>((res) => setTimeout(() => res(engine.local.trackGain), wait))]);
  }

  /**
   * A file that does not open: is it its network share that does not answer? If so, playback
   * waits for it and goes on where it was (cancelled by play/pause or another track). False: the
   * share is there (or it is not one): the file itself is the problem.
   */
  async function waitForShare(track: Track, at: number, gen: number): Promise<boolean> {
    if (track.source !== 'local' || !track.path) return false;
    let r = await window.chud.media.reach(track.path);
    if (gen !== generation) return true;
    if (!r.network || r.share) return false;
    // at rest for the engine, "loading" for the interface
    const wait = ++generation;
    pendingStart = at;
    go('LOAD');
    engine.pause();
    toast({ kind: 'error', title: tr('net.lost', { name: r.root }), body: tr('net.waiting') });
    const until = Date.now() + SHARE_PATIENCE;
    for (let i = 0; Date.now() < until; i++) {
      await new Promise((res) => setTimeout(res, SHARE_RETRIES[Math.min(i, SHARE_RETRIES.length - 1)]));
      if (wait !== generation) return true;
      r = await window.chud.media.reach(track.path);
      if (wait !== generation) return true;
      if (r.share) {
        toast({ title: tr('net.back', { name: r.root }) });
        void start(at, false, get().fromQueue ? track : undefined);
        return true;
      }
    }
    // the track stays the current one, where it was: play tries again
    generation++;
    engine.stop();
    go('CANCEL', { resumeAt: at });
    toast({ kind: 'error', title: tr('net.gaveUp', { name: r.root }), body: tr('net.check') });
    return true;
  }

  /** Playing, but silent for a while: the file's share may be gone without saying so. */
  async function checkStall(): Promise<void> {
    const { current } = get();
    if (current?.source !== 'local') return;
    await waitForShare(current, engine.currentTime, generation);
  }
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  /** `keep`: the track itself is fine (YouTube refused the connection): not marked unavailable. */
  function fail(track: Track, message: string, gen: number, keep = false): void {
    if (gen !== generation) return;
    // once per track: the audio element's error and the refused play() both end up here
    if (!go('FAIL')) return;
    const ctx = get().ctx;
    failures++;
    const problem = message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    if (!keep) useTabs.getState().patchTrack(track.id, { available: false, problem });
    if (ctx && !keep) set({ ctx: { ...ctx, tracks: ctx.tracks.map((t) => (t.id === track.id ? { ...t, available: false, problem } : t)) } });
    // what can be done about it, when that is known
    const hint = track.source === 'radio' ? tr('hint.radio') : track.source !== 'local' ? '' : problem === tr('main.fileMissing') ? tr('hint.missing') : tr('hint.damaged');
    toast({ kind: 'error', title: tr('play.failed', { title: track.title }), body: hint ? `${problem.replace(/[.\s]+$/, '')}. ${hint}` : problem });
    const total = (ctx?.tracks.length ?? 0) + get().upNext.length;
    if (failures < total) setTimeout(() => gen === generation && advance(true), 900);
    else stopAll();
  }

  function stopAll(): void {
    generation++;
    engine.stop();
    go('STOP');
  }

  /**
   * Play/pause while a track is on its way (being prepared, loading, or failed and about to be
   * skipped): it is given up — whatever still sounded stops too — and stays the current track,
   * at rest, where it was going to start.
   */
  function cancelLoad(): void {
    if (!playerMachine.can(phase, 'CANCEL') || performance.now() - loadAt < CANCEL_AFTER_MS) return;
    generation++;
    engine.stop();
    go('CANCEL', { resumeAt: pendingStart });
  }

  function rememberCurrent(): void {
    const { ctx, current, fromQueue } = get();
    if (ctx && current && !fromQueue) set({ resume: { ...get().resume, [ctx.tabId]: { trackId: trackKey(current), time: engine.currentTime } } });
  }

  /** What comes next; `auto` = at the end of the track (repeat). The up-next queue always goes first. */
  function peek(auto: boolean): Next {
    const { repeat, shuffle } = useSettings.getState();
    const { current, upNext, ctx } = get();
    if (auto && repeat === 'one' && failures === 0 && current) return { kind: 'repeat', track: current };
    if (upNext[0]) return { kind: 'queue', item: upNext[0], track: upNext[0].track };
    if (!ctx) return { kind: 'none' };
    // after queued tracks, the context resumes right after the entry it was on
    let pos = ctx.pos + 1;
    let order = ctx.order;
    if (pos >= order.length) {
      if (repeat === 'off' && auto) return { kind: 'end' };
      pos = 0;
      if (shuffle) {
        if (reshuffle?.of !== ctx.order) reshuffle = { of: ctx.order, order: shuffled(ctx.tracks.length, Math.floor(Math.random() * ctx.tracks.length)) };
        order = reshuffle.order;
      }
    }
    const track = ctx.tracks[order[pos]!];
    return track ? { kind: 'ctx', ctx: { ...ctx, order, pos }, track } : { kind: 'none' };
  }

  /** The state once `n` is the current track. */
  function patchFor(n: Next): Partial<PlayerState> {
    if (n.kind === 'queue') return { upNext: get().upNext.filter((q) => q.key !== n.item.key), current: n.track, fromQueue: true };
    if (n.kind === 'ctx') return { ctx: n.ctx, current: n.track, fromQueue: false };
    const { ctx } = get();
    if (n.kind === 'end' && ctx) return { ctx: { ...ctx, pos: 0 }, current: ctx.tracks[ctx.order[0]!] ?? null, fromQueue: false };
    return {};
  }

  /** Moves on; `auto` = end of a track or an error. */
  function advance(auto: boolean): void {
    const n = peek(auto);
    // the sleep timer: the next track is ready, at rest
    if (auto && failures === 0 && sleepStopsAfter(useSleep.getState().sleep, get().current, nextTrack(n))) {
      useSleep.getState().set(null);
      toast({ title: tr('sleep.done') });
      return rest(n);
    }
    if (n.kind === 'repeat') {
      engine.seek(0);
      void engine.play();
    } else if (n.kind === 'none') stopAll();
    else if (n.kind === 'end') rest(n);
    else if (n.kind === 'queue') {
      set({ upNext: get().upNext.filter((q) => q.key !== n.item.key) });
      void start(0, false, n.track);
    } else {
      set({ ctx: n.ctx, fromQueue: false });
      void start();
    }
  }

  /** Playback stops there, `n` being the current track (from its start). */
  function rest(n: Next): void {
    generation++;
    engine.stop();
    go('STOP', { ...patchFor(n), resumeAt: 0, duration: nextTrack(n)?.durationSec ?? get().duration });
    saveSnapshot();
  }

  // ── The next track, prepared ahead (gapless, crossfade) ────────────────────────────────────
  // The engine says when the end is near; the track that will follow is prepared in it; when the
  // engine has gone on to it ('segue'), the player follows. If anything changes meanwhile (queue,
  // shuffle, repeat, sleep timer), what was prepared is dropped and asked for again.

  async function plan(): Promise<void> {
    const seq = ++planSeq;
    planned = null;
    const { current } = get();
    if (current?.source !== 'local' || phase !== 'playing') return;
    const next = peek(true);
    const t = nextTrack(next);
    if (!t?.available || !t.path || sleepStopsAfter(useSleep.getState().sleep, current, t)) return;
    const { gapless, crossfadeSec } = useSettings.getState();
    const crossfade = chainMode(current, t, { gapless, crossfadeSec });
    if (crossfade === null) return;
    try {
      // Chromium loses the first 6.5 ms of an Opus file: heard within an album, so converted there
      const whole = crossfade === 0 && sameAlbum(current, t) && /opus/i.test(t.codec ?? '');
      const src = await window.chud.media.resolve(t.path, t.codec, whole).catch((e) => {
        if (!whole) throw e;
        return window.chud.media.resolve(t.path!, t.codec, false);
      });
      if (seq !== planSeq) return;
      const gain = await gainOf(t, 8000);
      const rates = await Promise.all([current.path!, t.path].map((p) => window.chud.media.sampleRate(p)));
      if (seq !== planSeq) return;
      planned = { key: String(seq), next, transcoded: src.transcoded };
      engine.local.prepare({ key: planned.key, url: src.url, gain, crossfade, rates: [rates[0]!, rates[1]!] });
    } catch {
      /* it will be asked for, and fail, in the normal way */
    }
  }

  /** What follows may not be what was prepared any more. */
  replan = (force) => {
    if (!force && planned && sameNext(planned.next, peek(true))) return;
    planSeq++;
    planned = null;
    engine.local.replan();
  };

  function segue(key: string, duration: number): void {
    const p = planned;
    if (p?.key !== key) return;
    planned = null;
    planSeq++;
    const now = peek(true);
    const n = sameNext(now, p.next) ? now : p.next; // the list itself may be newer than when prepared
    const t = nextTrack(n)!;
    const patch: Partial<PlayerState> = { ...patchFor(n), current: t, duration: duration || t.durationSec || 0, transcoded: p.transcoded, resumeAt: 0 };
    generation++;
    failures = 0;
    listened = 0;
    counted = false;
    if (!go('SEGUE', patch)) set(patch);
    updateMediaSession(t);
    saveSnapshot();
  }

  engine.on((e) => {
    if (e.type === 'load') {
      go('HANDOVER');
      return;
    }
    // While the chosen track is being prepared the engine still holds the previous one: what it
    // reports then (its end, an error, its length) is not about `current`.
    if (phase === 'resolving') return;
    clearTimeout(stallTimer);
    if (e.type === 'near') return void plan();
    if (e.type === 'segue') return segue(e.key, e.duration);
    if (e.type === 'waiting') stallTimer = setTimeout(() => void checkStall(), STALL_MS);
    if (e.type === 'playing') {
      if (go('PLAYING')) failures = 0;
    } else if (e.type === 'paused') {
      if (go('PAUSED')) saveSnapshot();
    } else if (e.type === 'duration') set({ duration: e.duration });
    else if (e.type === 'ended') {
      if (playerMachine.can(phase, 'ENDED')) advance(true);
    } else if (e.type === 'error') {
      const { current, transcoded } = get();
      if (!current || !playerMachine.can(phase, 'FAIL')) return;
      // Chromium refused the original: retry once through FFmpeg before giving up.
      if (current.source === 'local' && !transcoded && e.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) void start(0, true, get().fromQueue ? current : undefined);
      else if (e.code === YT_BLOCKED) fail(current, e.message, generation, true);
      else if (current.source === 'local') {
        const gen = generation;
        const at = engine.currentTime || pendingStart;
        void waitForShare(current, at, gen).then((waiting) => {
          if (!waiting && gen === generation) fail(current, e.code === MediaError.MEDIA_ERR_DECODE ? tr('play.damaged') : e.message || tr('err.playback'), gen);
        });
      } else fail(current, current.source === 'radio' ? tr('play.radioDead') : e.message, generation);
    }
    if (navigator.mediaSession) navigator.mediaSession.playbackState = get().status === 'playing' ? 'playing' : 'paused';
  });

  onSleepTime(() => {
    const { status } = get();
    if (status === 'playing') engine.pause();
    else if (status === 'loading') cancelLoad();
  });

  return {
    ctx: null,
    current: null,
    fromQueue: false,
    upNext: [],
    status: 'idle',
    duration: 0,
    transcoded: false,
    resumeAt: 0,
    resume: {},

    playFrom(tabId, label, tracks, index, startAt = 0) {
      if (!tracks.length) return;
      if (get().ctx && get().ctx!.tabId !== tabId) rememberCurrent();
      failures = 0;
      const order = useSettings.getState().shuffle ? shuffled(tracks.length, index) : [...tracks.keys()];
      set({ ctx: { tabId, label, tracks, order, pos: order.indexOf(index) }, fromQueue: false });
      void start(startAt);
    },

    resumeTab(tabId, label, tracks) {
      const r = get().resume[tabId];
      const idx = r ? tracks.findIndex((t) => trackKey(t) === r.trackId) : -1;
      if (idx >= 0) get().playFrom(tabId, label, tracks, idx, r!.time);
      else get().playFrom(tabId, label, tracks, useSettings.getState().shuffle ? Math.floor(Math.random() * tracks.length) : 0);
    },

    swapCurrent(track) {
      const { ctx, fromQueue, current } = get();
      if (!current) return;
      if (ctx && !fromQueue) {
        const i = ctx.order[ctx.pos]!;
        const tracks = [...ctx.tracks];
        tracks[i] = track;
        set({ ctx: { ...ctx, tracks } });
        void start(0);
      } else void start(0, false, track);
    },

    jumpTo(pos) {
      const { ctx } = get();
      if (!ctx || pos < 0 || pos >= ctx.order.length) return;
      failures = 0;
      set({ ctx: { ...ctx, pos }, fromQueue: false });
      void start();
    },

    playQueued(key) {
      const item = get().upNext.find((q) => q.key === key);
      if (!item) return;
      set({ upNext: get().upNext.filter((q) => q.key !== key) });
      void start(0, false, item.track);
    },

    playNext(tracks) {
      const items = tracks.map((track) => ({ key: ++queueSeq, track }));
      set({ upNext: [...items, ...get().upNext] });
      if (!get().ctx && !get().current) advance(false);
    },

    enqueue(tracks) {
      set({ upNext: [...get().upNext, ...tracks.map((track) => ({ key: ++queueSeq, track }))] });
      if (!get().ctx && !get().current) advance(false);
    },

    removeQueued(keys) {
      const gone = new Set(keys);
      set({ upNext: get().upNext.filter((q) => !gone.has(q.key)) });
    },

    moveQueued(keys, toIndex) {
      const q = get().upNext;
      const moved = new Set(keys);
      const at = Math.max(0, Math.min(toIndex, q.length));
      // before whatever stays from that place on
      set({ upNext: [...q.slice(0, at).filter((x) => !moved.has(x.key)), ...q.filter((x) => moved.has(x.key)), ...q.slice(at).filter((x) => !moved.has(x.key))] });
    },

    clearQueue: () => set({ upNext: [] }),

    removeFromContext(positions) {
      const { ctx } = get();
      if (!ctx) return;
      const gone = new Set(positions.filter((p) => p > ctx.pos).map((p) => ctx.order[p]!));
      if (gone.size) set({ ctx: withoutTracks(ctx, gone) });
    },

    moveInContext(positions, to) {
      const { ctx } = get();
      if (!ctx) return;
      const moved = new Set(positions.filter((p) => p > ctx.pos));
      const at = Math.max(ctx.pos + 1, Math.min(to, ctx.order.length));
      const take = (from: number, end: number, wanted: boolean) => ctx.order.slice(from, end).filter((_, i) => moved.has(from + i) === wanted);
      const n = ctx.order.length;
      set({ ctx: { ...ctx, order: [...take(0, at, false), ...take(0, n, true), ...take(at, n, false)] } });
    },

    clearAll() {
      const { ctx } = get();
      set({ upNext: [], ...(ctx ? { ctx: withoutTracks(ctx, new Set(ctx.order.slice(ctx.pos + 1))) } : {}) });
    },

    queueTracks() {
      const { current, upNext, ctx } = get();
      return [...(current && current.source !== 'radio' ? [current] : []), ...upNext.map((q) => q.track), ...(ctx ? ctx.order.slice(ctx.pos + 1).map((i) => ctx.tracks[i]!) : [])].filter((t) => t.source !== 'radio');
    },

    toggle() {
      const { status, ctx, current, resumeAt, fromQueue } = get();
      if (status === 'playing') engine.pause();
      else if (status === 'loading') cancelLoad();
      // a station goes on from where it was paused (its audio waited in memory)
      else if (status === 'paused' && current?.source === 'radio') {
        go('RETUNE');
        void playRadioFrom(current, radioPos()).catch(() => {});
      } else if (status === 'paused') void engine.play();
      else if (status === 'idle' && (ctx || current)) void start(resumeAt, false, fromQueue ? current ?? undefined : undefined);
    },

    next: () => advance(false),

    prev() {
      const { ctx, fromQueue, current } = get();
      // a station: always the previous station (going back in time is the seek bar's job)
      if ((engine.currentTime > 3 && current?.source !== 'radio') || !ctx) {
        engine.seek(0);
        return;
      }
      if (fromQueue) {
        void start(); // back to the context's current entry
        return;
      }
      if (ctx.pos === 0) {
        engine.seek(0);
        return;
      }
      set({ ctx: { ...ctx, pos: ctx.pos - 1 } });
      void start();
    },

    seek(sec) {
      if (get().status === 'idle') set({ resumeAt: Math.max(0, sec) });
      else engine.seek(sec);
    },

    toggleShuffle() {
      const shuffle = !useSettings.getState().shuffle;
      useSettings.getState().set({ shuffle });
      const { ctx } = get();
      if (!ctx) return;
      const cur = ctx.order[ctx.pos]!;
      const order = shuffle ? shuffled(ctx.tracks.length, cur) : [...ctx.tracks.keys()];
      set({ ctx: { ...ctx, order, pos: order.indexOf(cur) } });
    },

    cycleRepeat() {
      const next: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };
      useSettings.getState().set({ repeat: next[useSettings.getState().repeat] });
    },

    async restore() {
      const s = await window.chud.player.load();
      if (!s || !s.tracks.length) return;
      const pos = Math.min(s.pos, s.order.length - 1);
      // something was started meanwhile (a file opened with the app): it goes first
      if (get().ctx || get().current) return;
      set({
        ctx: { tabId: s.tabId, label: s.label, tracks: s.tracks, order: s.order, pos },
        current: s.queued ?? s.tracks[s.order[pos]!] ?? null,
        fromQueue: !!s.queued,
        upNext: (s.upNext ?? []).map((track) => ({ key: ++queueSeq, track })),
        resumeAt: s.time,
      }); // at start: idle
      if (s.partial) void fillContext(get().ctx!);
    },
  };
});

// ── Listening history: a play counts after 30 s, or half of a short track ────────────────
let listened = 0;
let counted = false;
setInterval(() => {
  const { status, current, duration, ctx } = usePlayer.getState();
  if (status !== 'playing' || !current) return;
  listened++;
  if (!counted && current.source !== 'radio' && listened >= Math.min(30, Math.max(1, (duration || 60) / 2))) {
    counted = true;
    void window.chud.history.record(current, ctx?.label ?? '').then(() => notePlayed(current.id), () => {});
  }
  if (listened % 10 === 0) {
    saveSnapshot();
    // listening time for the statistics (10 s of actual playback)
    window.chud.stats.listen({ key: current.id, source: current.source, title: current.title, artist: current.source === 'radio' ? null : current.artist, album: current.album, seconds: 10 });
  }
}, 1000);

// what was last saved in full: when only the position moved, only the position is sent
let saved: { tracks: Track[]; order: number[]; tabId: string; label: string; upNext: QueueItem[]; queued: Track | null } | null = null;

// the database knows the tracks of the library and of playlists: their id is enough
let libraryIds: { of: Track[]; ids: Set<string> } | null = null;
function savedTracks(tracks: Track[]): SavedTrack[] {
  const of = useLibrary.getState().tracks;
  if (libraryIds?.of !== of) libraryIds = { of, ids: new Set(of.map((t) => t.id)) };
  const { ids } = libraryIds;
  return tracks.map((t) => (t.entryId != null ? [t.id, t.entryId] : ids.has(t.id) ? t.id : t));
}

/** The list restored in part: not saved over the whole one, which is on its way. */
let filling: Track[] | null = null;

async function fillContext(part: PlayContext): Promise<void> {
  filling = part.tracks;
  try {
    const rest = await window.chud.player.rest();
    if (!rest) return;
    const { order } = rest;
    // the library's own tracks, once it is loaded; those it does not have are asked for
    if (!useLibrary.getState().loaded) {
      await new Promise<void>((res) => {
        const off = useLibrary.subscribe((l) => {
          if (!l.loaded) return;
          off();
          res();
        });
      });
    }
    const byId = new Map<string, Track | null>(useLibrary.getState().tracks.map((t) => [t.id, t]));
    const idOf = (s: SavedTrack): string | null => (typeof s === 'string' ? s : Array.isArray(s) ? s[0] : null);
    const unknown = [...new Set(rest.tracks.map(idOf).filter((id): id is string => id !== null && !byId.has(id)))];
    for (let i = 0; i < unknown.length; i += 500) {
      const part = unknown.slice(i, i + 500);
      const got = await window.chud.player.tracks(part);
      part.forEach((id, k) => byId.set(id, got[k] ?? null));
    }
    const all = rest.tracks.map((s): Track | null => {
      const id = idOf(s);
      if (id === null) return s as Track;
      const t = byId.get(id) ?? null;
      return t && Array.isArray(s) ? { ...t, entryId: s[1] } : t;
    });
    const now = usePlayer.getState().ctx;
    if (!now || now.tracks !== part.tracks) return; // something else was started meanwhile
    // a track gone since is left out
    const at = new Map<number, number>();
    const tracks: Track[] = [];
    all.forEach((t, i) => {
      if (!t) return;
      at.set(i, tracks.length);
      tracks.push(t);
    });
    let full = order.filter((i) => at.has(i)).map((i) => at.get(i)!);
    const here = now.tracks[now.order[now.pos]!];
    const key = here && trackKey(here);
    if (now.order !== part.order) {
      // shuffle was turned on or off meanwhile
      const cur = Math.max(0, tracks.findIndex((t) => trackKey(t) === key));
      full = useSettings.getState().shuffle ? shuffled(tracks.length, cur) : [...tracks.keys()];
    }
    const pos = Math.max(0, full.findIndex((i) => trackKey(tracks[i]!) === key));
    filling = null;
    usePlayer.setState({ ctx: { ...now, tracks, order: full, pos } });
  } catch {
    /* the part stays: it plays on as it is */
  } finally {
    filling = null;
  }
}

function saveSnapshot(): void {
  const { ctx, upNext, current, fromQueue, status, resumeAt } = usePlayer.getState();
  if (!ctx || ctx.tracks === filling) return;
  // at rest, nothing is in the engine: the place is the one kept for later
  const time = status === 'idle' ? resumeAt : engine.currentTime;
  const queued = fromQueue ? current : null;
  if (saved && saved.tracks === ctx.tracks && saved.order === ctx.order && saved.tabId === ctx.tabId && saved.label === ctx.label && saved.upNext === upNext && saved.queued?.id === queued?.id) {
    void window.chud.player.savePosition(ctx.pos, time);
    return;
  }
  // moving along the list keeps its tracks; a longer conversion only when they change
  saved = { tracks: ctx.tracks, order: ctx.order, tabId: ctx.tabId, label: ctx.label, upNext, queued };
  const s: SavedPlayer = { tabId: ctx.tabId, label: ctx.label, tracks: savedTracks(ctx.tracks), order: ctx.order, pos: ctx.pos, time, upNext: savedTracks(upNext.map((q) => q.track)), queued };
  void window.chud.player.save(s);
}
window.addEventListener('beforeunload', saveSnapshot);
// the queue is part of it: saved shortly after it changes
let queueTimer: ReturnType<typeof setTimeout> | undefined;
usePlayer.subscribe((s, prev) => {
  if (s.upNext !== prev.upNext || s.ctx !== prev.ctx) {
    replan(false);
    if (prev.ctx) {
      clearTimeout(queueTimer);
      queueTimer = setTimeout(saveSnapshot, 1500);
    }
  }
});
useSleep.subscribe((s, prev) => {
  if (s.sleep !== prev.sleep && (s.sleep?.kind ?? null) !== (prev.sleep?.kind ?? null)) replan(true);
});

/** The list playing was edited (playlist, "Fichiers ouverts"): follow it, keep the current entry. */
function followList(tabId: string, label: string, tracks: Track[]): void {
  const { ctx, current } = usePlayer.getState();
  if (!ctx || ctx.tabId !== tabId || !tracks.length) return;
  const curIdx = current ? tracks.findIndex((t) => trackKey(t) === trackKey(current)) : -1;
  const shuffle = useSettings.getState().shuffle;
  const order = shuffle ? shuffled(tracks.length, Math.max(0, curIdx)) : [...tracks.keys()];
  // the playing track's own details may have just arrived (a file still being read when it started)
  const fresh = curIdx >= 0 ? tracks[curIdx]! : null;
  usePlayer.setState({
    ctx: { ...ctx, label, tracks, order, pos: curIdx >= 0 ? order.indexOf(curIdx) : Math.min(ctx.pos, order.length - 1) },
    ...(fresh && current && fresh !== current && !usePlayer.getState().fromQueue ? { current: { ...current, ...fresh } } : {}),
  });
  if (fresh && current?.pending && !fresh.pending) updateMediaSession(fresh);
}

onPlaylistChanged(async (id) => {
  const { ctx } = usePlayer.getState();
  if (id == null || !ctx || ctx.tabId !== `playlist:${id}`) return;
  const detail = usePlaylists.getState().details[id] ?? (await usePlaylists.getState().loadDetail(id));
  // a smart playlist changes while its tracks are played (plays counted…): what plays stays as it was
  if (detail && !detail.smart) followList(ctx.tabId, detail.name, detail.tracks); // deleted: keep playing the snapshot
});

useTabs.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return;
  const now = s.tabs.find((t) => t.id === OPENED_TAB);
  const before = prev.tabs.find((t) => t.id === OPENED_TAB);
  if (now?.kind === 'files' && before?.kind === 'files' && now.tracks && now.tracks !== before.tracks) followList(now.id, now.title, now.tracks);
});

// Live radio: the title on air, read from the stream by the main process.
window.chud.radio.onTitle(({ url, title }) => {
  const { current } = usePlayer.getState();
  if (current?.source !== 'radio' || current.streamUrl !== url || current.onAir === title) return;
  const next = { ...current, onAir: title, artist: title };
  usePlayer.setState({ current: next });
  updateMediaSession(next);
});

// Windows taskbar thumbnail buttons: report the state, obey the clicks.
usePlayer.subscribe((s) => window.chud.taskbar.report({ playing: s.status === 'playing' || s.status === 'loading', enabled: !!(s.ctx || s.current || s.upNext.length) }));
window.chud.taskbar.report({ playing: false, enabled: false });
window.chud.taskbar.onCommand((cmd) => {
  const p = usePlayer.getState();
  if (cmd === 'toggle') p.toggle();
  else if (cmd === 'next') p.next();
  else if (cmd === 'stop') {
    if (p.status === 'playing' || p.status === 'loading') p.toggle();
  } else p.prev();
});

// Windows media overlay / hardware media keys (System Media Transport Controls)
function updateMediaSession(t: Track): void {
  if (!navigator.mediaSession) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist ?? '',
    album: t.album ?? '',
    artwork: t.coverUrl ? [{ src: t.coverUrl, sizes: '512x512' }] : [],
  });
}

if (navigator.mediaSession) {
  const p = () => usePlayer.getState();
  navigator.mediaSession.setActionHandler('play', () => p().toggle());
  navigator.mediaSession.setActionHandler('pause', () => p().toggle());
  navigator.mediaSession.setActionHandler('nexttrack', () => p().next());
  navigator.mediaSession.setActionHandler('previoustrack', () => p().prev());
  navigator.mediaSession.setActionHandler('seekto', (d) => d.seekTime != null && p().seek(d.seekTime));
}

// Keep the engine in sync with persisted volume / EQ.
/** Applies the chosen output device to local playback and to the YouTube player. */
// the station's memory is watched while a station is the current track
usePlayer.subscribe((s) => watchRadio(s.current?.source === 'radio'));

export async function applyOutput(sinkId: string): Promise<{ local: boolean; youtube: boolean }> {
  const local = await engine.local.setOutput(sinkId);
  const youtube = await window.chud.taskbar.youtubeSink(sinkId);
  return { local, youtube };
}
// the YouTube player can be (re)created later: re-apply on each YouTube track
usePlayer.subscribe((s, prev) => {
  if (s.current?.source === 'youtube' && s.status === 'playing' && prev.status !== 'playing') {
    const id = useSettings.getState().outputDevice;
    if (id !== 'default') void window.chud.taskbar.youtubeSink(id);
  }
});

useSettings.subscribe((s, prev) => {
  if (s.outputDevice !== prev.outputDevice) void applyOutput(s.outputDevice);
  if (s.volume !== prev.volume || s.muted !== prev.muted) engine.setVolume(s.volume, s.muted);
  if (s.eq !== prev.eq) engine.setEq(s.eq);
  if (s.replayGain !== prev.replayGain) {
    const { current } = usePlayer.getState();
    if (s.replayGain === 'off') engine.local.setTrackGain(1);
    else if (current?.source === 'local' && current.path) {
      void window.chud.media.loudness(current.path).then((l) => usePlayer.getState().current?.id === current.id && engine.local.setTrackGain(replayGainFactor(useSettings.getState().replayGain, l)));
    }
  }
  if (s.shuffle !== prev.shuffle || s.repeat !== prev.repeat) replan(false);
  if (s.gapless !== prev.gapless || s.crossfadeSec !== prev.crossfadeSec || s.replayGain !== prev.replayGain) replan(true);
});

// automated tests read the engine's state
if (window.chud.testing) Object.assign(window, { chudTest: { engine, player: usePlayer, settings: useSettings, sleep: useSleep, library: useLibrary } });
