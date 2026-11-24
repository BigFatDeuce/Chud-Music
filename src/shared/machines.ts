// The state machines that cross a boundary (several modules, or the two processes), as data:
// for each state, the events it takes and where they lead. An event a state does not list
// changes nothing — the code asks, the table decides. Whoever owns a machine keeps its current
// state in one variable and changes it in one function (`go`): store/player.ts for playback,
// main/updater.ts for updates, main/adblock.ts for the ad blocker, main/covers.ts for the search
// of missing covers. A state that only follows from others is not a table but a pure function:
// shared/yt-place.ts (where the YouTube player shows, its quality, the clip tab full screen,
// what feeds the spectrum) and shared/duplicates.ts (which copy of a song stays).
//
// Nothing is imported here, on purpose: tests/unit/machines.mjs loads this file as it is, without
// the app, and checks every table (and that docs/ANALYSE-TECHNIQUE.md §34 shows the same ones).
// The other, smaller state machines of the app are listed there too, with where they live.

export interface Machine<S extends string, E extends string> {
  readonly name: string;
  readonly initial: S;
  readonly table: { readonly [K in S]: { readonly [P in E]?: S } };
  /** Where `event` leads from `state`; null when that state does not take it. */
  next(state: S, event: E): S | null;
  can(state: S, event: E): boolean;
}

export function defineMachine<S extends string, E extends string>(name: string, initial: S, table: Machine<S, E>['table']): Machine<S, E> {
  const next = (state: S, event: E): S | null => table[state][event] ?? null;
  return { name, initial, table, next, can: (state, event) => next(state, event) !== null };
}

// ── Playback ────────────────────────────────────────────────────────────────────────────────
//
//   idle       nothing loaded in the engine (start, end of the list, everything failed)
//   resolving  a track was chosen and is being prepared (file checked, FFmpeg conversion, station
//              tuned in): the engine still holds — and may still play — the PREVIOUS track, so
//              nothing it reports is about the chosen one
//   loading    the engine has the chosen track and is getting it to play
//   playing / paused
//   failed     the track could not be played; the next one is tried in a moment (or playback
//              stops when every track failed)
//
//   LOAD      a track is chosen (any way: click, next, end of the previous one, retry via FFmpeg)
//   HANDOVER  the engine takes the new media: from here on, its events are about it
//   PLAYING, PAUSED, ENDED   reported by the engine (ENDED leads nowhere by itself: where it is
//             taken, the player moves on; elsewhere it is the end of something already left)
//   SEGUE     the engine went on to the next track by itself (gapless, crossfade): it is the current
//             one now, and plays already
//   RETUNE    a paused station goes on from where it was paused (read again from memory)
//   FAIL      once per track, however many times the failure is reported
//   CANCEL    play/pause pressed while a track is on its way: it is given up, and stays the
//             current track, at rest (pressed again, it is loaded again)
//   STOP      nothing left to play

export type PlayerPhase = 'idle' | 'resolving' | 'loading' | 'playing' | 'paused' | 'failed';
export type PlayerEvent = 'LOAD' | 'HANDOVER' | 'PLAYING' | 'PAUSED' | 'ENDED' | 'SEGUE' | 'RETUNE' | 'FAIL' | 'CANCEL' | 'STOP';

export const playerMachine = defineMachine<PlayerPhase, PlayerEvent>('player', 'idle', {
  // PLAYING: the YouTube player can be started from its own page
  idle: { LOAD: 'resolving', PLAYING: 'playing', STOP: 'idle' },
  resolving: { LOAD: 'resolving', HANDOVER: 'loading', FAIL: 'failed', CANCEL: 'idle', STOP: 'idle' },
  loading: { LOAD: 'resolving', HANDOVER: 'loading', PLAYING: 'playing', ENDED: 'loading', FAIL: 'failed', CANCEL: 'idle', STOP: 'idle' },
  // HANDOVER: a station read from another moment (time shift) without leaving the state
  playing: { LOAD: 'resolving', HANDOVER: 'playing', PLAYING: 'playing', PAUSED: 'paused', ENDED: 'playing', SEGUE: 'playing', FAIL: 'failed', STOP: 'idle' },
  // ENDED: a file that ends is paused by the browser just before it reports the end
  paused: { LOAD: 'resolving', HANDOVER: 'paused', PLAYING: 'playing', ENDED: 'paused', RETUNE: 'loading', FAIL: 'failed', STOP: 'idle' },
  // CANCEL: the next track is not tried
  failed: { LOAD: 'resolving', CANCEL: 'idle', STOP: 'idle' },
});

/** What the interface shows. */
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused';
export const playerStatus = (phase: PlayerPhase): PlayerStatus => (phase === 'resolving' || phase === 'failed' ? 'loading' : phase);

// ── Updates ─────────────────────────────────────────────────────────────────────────────────
//
//   rechecking  an update is already known and GitHub is asked again (every 6 hours): it stays
//               offered meanwhile, and if GitHub cannot be reached
//   downloaded  nothing more happens until the restart that installs it

export type UpdatePhase = 'idle' | 'checking' | 'none' | 'available' | 'rechecking' | 'downloading' | 'downloaded' | 'error';
export type UpdateEvent = 'CHECK' | 'FOUND' | 'NOT_FOUND' | 'CHECK_FAILED' | 'DOWNLOAD' | 'PROGRESS' | 'DOWNLOADED' | 'DOWNLOAD_FAILED';

export const updateMachine = defineMachine<UpdatePhase, UpdateEvent>('updates', 'idle', {
  idle: { CHECK: 'checking' },
  checking: { FOUND: 'available', NOT_FOUND: 'none', CHECK_FAILED: 'error' },
  none: { CHECK: 'checking' },
  error: { CHECK: 'checking' },
  available: { CHECK: 'rechecking', DOWNLOAD: 'downloading' },
  rechecking: { FOUND: 'available', NOT_FOUND: 'none', CHECK_FAILED: 'available', DOWNLOAD: 'downloading' },
  downloading: { PROGRESS: 'downloading', DOWNLOADED: 'downloaded', DOWNLOAD_FAILED: 'available' },
  downloaded: {},
});

/** What the interface shows (UpdateStatus.state). */
export type UpdateState = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'error';
export const updateState = (phase: UpdatePhase): UpdateState => (phase === 'rechecking' ? 'available' : phase);

// ── Ad blocker (its filter engine; "enabled" is a setting of its own, beside it) ─────────────
//
//   unbuilt     at start, before the saved engine was looked for
//   waiting     no saved engine (first use): built when YouTube Music is first used
//   building    lists downloaded and engine built, none running yet
//   ready       an engine runs in the YouTube session
//   refreshing  an engine runs, and the lists are being checked against their sources
//   failed      no engine could be built (offline at first use…): tried again at the next use
//
//   LOADED / NO_ENGINE   the engine saved last time was read, or there is none
//   CHECK, CHECK_OK, CHECK_FAILED   the lists checked (hourly, by hand, at first use); a check
//               that fails while an engine runs changes nothing: it goes on blocking

export type AdblockPhase = 'unbuilt' | 'waiting' | 'building' | 'ready' | 'refreshing' | 'failed';
export type AdblockEvent = 'LOADED' | 'NO_ENGINE' | 'CHECK' | 'CHECK_OK' | 'CHECK_FAILED';

export const adblockMachine = defineMachine<AdblockPhase, AdblockEvent>('adblock', 'unbuilt', {
  unbuilt: { LOADED: 'ready', NO_ENGINE: 'waiting', CHECK: 'building' },
  waiting: { CHECK: 'building' },
  // LOADED / NO_ENGINE: a check asked for before the saved engine was read
  building: { LOADED: 'refreshing', NO_ENGINE: 'building', CHECK_OK: 'ready', CHECK_FAILED: 'failed' },
  ready: { CHECK: 'refreshing' },
  refreshing: { CHECK_OK: 'ready', CHECK_FAILED: 'ready' },
  failed: { CHECK: 'building' },
});

// ── Missing covers (Library › … › Find missing covers) ──────────────────────────────────────
//
//   searching  albums are looked up one after the other
//   stopping   "stop" was asked (or the found covers are being removed): the album in progress
//              ends, nothing more is asked
//   failed     the search stopped by itself (no connection): said once, until the next search
//
//   START  the menu entry; refused while a search runs (one at a time)
//   STOP   asked from the menu, by "Remove found covers", or when the app closes
//   DONE / FAIL   the loop ended; a failure while stopping is not one (it was being given up)

export type CoversPhase = 'idle' | 'searching' | 'stopping' | 'failed';
export type CoversEvent = 'START' | 'STOP' | 'DONE' | 'FAIL';

export const coversMachine = defineMachine<CoversPhase, CoversEvent>('covers', 'idle', {
  idle: { START: 'searching' },
  searching: { STOP: 'stopping', DONE: 'idle', FAIL: 'failed' },
  stopping: { DONE: 'idle', FAIL: 'idle' },
  failed: { START: 'searching' },
});

/** What the interface shows of it (CoverStatus.running). */
export const coversRunning = (phase: CoversPhase): boolean => phase === 'searching' || phase === 'stopping';

/** What the interface shows of it (AdblockStatus), with the "enabled" setting. */
export const adblockFlags = (phase: AdblockPhase, enabled: boolean): { active: boolean; checking: boolean; waiting: boolean } => ({
  active: enabled && (phase === 'ready' || phase === 'refreshing'),
  checking: phase === 'building' || phase === 'refreshing',
  waiting: phase === 'waiting',
});
