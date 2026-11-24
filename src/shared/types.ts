import type { HiddenArtist } from './hidden-artists';
import type { MusicLink } from './links';
import type { LangPref } from './i18n';
import type { UpdateState } from './machines';
import type { Loudness, ReplayGainMode } from './replaygain';
import type { SmartSpec } from './smart';
// Types shared by the main process, the preload bridge and the UI.

/** 'radio': a live internet station; never stored in the database (playlists, history). */
export type TrackSource = 'local' | 'youtube' | 'radio';

/** A playable item. Local and YouTube tracks are never confused: a YouTube track has no path. */
export interface Track {
  /** Stable id: `local:<absolute path>` or `yt:<videoId>`. */
  id: string;
  source: TrackSource;
  /** Live radio: the station's stream URL (played through chud-media://radio). */
  streamUrl?: string;
  /** Live radio: the station's bit rate in kbit/s, when the directory gives it (time shift). */
  bitrate?: number | null;
  /** Live radio: what is on air ("Artist - Title"), when the station says. */
  onAir?: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  /** chud-media:// URL of the cover, or a remote thumbnail for YouTube. */
  coverUrl: string | null;
  /** Local only. */
  path?: string;
  /** Local only: codec as reported by music-metadata, e.g. "FLAC", "ALAC". */
  codec?: string | null;
  /** Local only, when known: average bit rate of the file in kbit/s (its size over its duration). */
  bitrateKbps?: number | null;
  /** YouTube only. */
  videoId?: string;
  /** YouTube only, when known: the artist page / album page to open from this track (not persisted). */
  ytArtistId?: string | null;
  ytAlbumId?: string | null;
  /** False when the file is missing/unreadable or the video is gone. */
  available: boolean;
  /** Why the track is unavailable, shown to the user. */
  problem?: string;
  /** Still being read (slow disk or network share): shown as a loading row, playable. */
  pending?: boolean;
  albumArtist?: string | null;
  trackNo?: number | null;
  discNo?: number | null;
  year?: number | null;
  genre?: string | null;
  /** ms since epoch — library only */
  addedAt?: number;
  playCount?: number;
  lastPlayedAt?: number | null;
  /** Set when the track is an entry of a saved playlist (entries are distinct even for the same track). */
  entryId?: number;
}

export interface LibraryFolder {
  path: string;
  addedAt: number;
  trackCount: number;
  /** Scanned (at startup, on changes, by Rescan). Off: its tracks stay as they are, nothing reads the folder. */
  scan: boolean;
  /** The folder itself is unreachable (unplugged drive, deleted…). */
  missing: boolean;
}

export interface ScanStatus {
  running: boolean;
  found: number;
  parsed: number;
  lastScanAt: number | null;
  watching: boolean;
  /** Folders that did not answer: what they hold stays in the library, they are read again later. */
  unread: number;
}

/** Progress of Library › … › Find missing covers. */
export interface CoverStatus {
  running: boolean;
  /** Albums (or single tracks) looked up so far, out of `total`. */
  done: number;
  total: number;
  /** Found: album / song covers, artist pictures, nothing ("?"). */
  album: number;
  artist: number;
  none: number;
  error: string | null;
}

export interface PlaylistSummary {
  id: number;
  /** A picture chosen by hand instead of the mosaic (chud-media:// URL), or null. */
  cover: string | null;
  /** A smart playlist: its description; its tracks follow the library (shared/smart.ts). */
  smart: SmartSpec | null;
  name: string;
  count: number;
  durationSec: number;
  /** Up to 4 distinct covers, for mosaics. */
  covers: string[];
  updatedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  /** Entries in order; each carries its `entryId`. */
  tracks: Track[];
}

/** Restores what was playing (paused) after a restart: the list, its place in it, the queue. */
export interface PlayerSnapshot {
  tabId: string;
  label: string;
  tracks: Track[];
  order: number[];
  pos: number;
  time: number;
  /** The "up next" queue. */
  upNext?: Track[];
  /** The track playing when it came from the queue (it is not in `tracks`). */
  queued?: Track | null;
  /** A very long list: only the tracks around the place; the rest follows (player.rest). */
  partial?: boolean;
}

/**
 * A track of the snapshot as it is saved: its id when the database knows it (with its playlist
 * entry), else the track itself. A queue of 100 000 tracks stays small.
 */
export type SavedTrack = string | [id: string, entryId: number] | Track;
export interface SavedPlayer extends Omit<PlayerSnapshot, 'tracks' | 'upNext'> {
  tracks: SavedTrack[];
  upNext?: SavedTrack[];
}

export interface PlayableSource {
  url: string;
  /** True when FFmpeg had to convert the file because Chromium cannot decode it. */
  transcoded: boolean;
}

export type SkinId = 'nocturne' | 'cassette' | 'aqua' | 'platine' | 'signal';
export type EffectsLevel = 'full' | 'reduced' | 'off';
export type RepeatMode = 'off' | 'all' | 'one';

export interface Settings {
  skin: SkinId;
  effects: EffectsLevel;
  volume: number; // 0..1
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  eq: EqSettings;
  /** Ad blocking in the YouTube player session (Ghostery engine, uBlock Origin filter lists). */
  adblock: boolean;
  viz: VizSettings;
  /** The YouTube player ignores clicks and hover (no accidental pause); the app's own buttons control it. */
  ytClickLock: boolean;
  /** Audio output device id ('default': the system's). */
  outputDevice: string;
  /** Its name, shown without listing devices again. */
  outputLabel: string | null;
  /** Sidebar box under the menu: the living cover or the playlists. */
  sidePanel: 'cover' | 'playlists';
  /** Look for a new version on GitHub at startup and every 6 hours. */
  autoUpdateCheck: boolean;
  /** Equaliser presets saved by the user. */
  eqUserPresets: { name: string; preampDb: number; gains: number[] }[];
  /** Accent colour over the skin's own (#rrggbb), or null for the skin's. */
  accent: string | null;
  /** Interface size (zoom factor): 0.9, 1, 1.1, 1.25. */
  uiScale: number;
  /** Artist and album names of YouTube Music tracks open their pages in the app. */
  ytLinks: boolean;
  /** Library › Albums: albums of fewer than SMALL_ALBUM tracks are not shown (singles, bits of albums). */
  hideSmallAlbums: boolean;
  /** Home sections the person turned off in Settings › Home. */
  homeHidden: HomeSection[];
  /** Folder of radio recordings ('' = the system's Music folder). */
  radioRecordDir: string;
  /** The tracks of a list follow each other without a gap (local files). */
  gapless: boolean;
  /** Crossfade between tracks, in seconds (0: none; consecutive tracks of an album are never crossfaded). */
  crossfadeSec: number;
  /** Volume normalisation of local files. */
  replayGain: ReplayGainMode;
  /** Interface language: 'system' follows the operating system (English when it is not offered). */
  language: LangPref;
}

export interface UpdateStatus {
  /** The updater's state as the interface shows it (shared/machines.ts). */
  state: UpdateState;
  current: string;
  /** The newer version, when there is one. */
  version: string | null;
  notes: string | null;
  /** Download progress, 0–100. */
  progress: number;
  error: string | null;
  checkedAt: number | null;
  /** True when the update can be downloaded and installed from the app; otherwise the
   *  button opens the GitHub releases page. */
  inApp: boolean;
  releaseUrl: string;
}

/** Visualiser (butterchurn / MilkDrop presets). Independent from the skin. */
export interface VizSettings {
  /** Last preset shown (its name in the preset pack). */
  preset: string | null;
  /** Change preset automatically every `cycleSec` seconds. */
  autoCycle: boolean;
  cycleSec: number;
  /** Random order when cycling (otherwise alphabetical). */
  random: boolean;
}

export interface EqSettings {
  enabled: boolean;
  preampDb: number;
  /** Gains in dB for EQ_BANDS, in order. */
  gains: number[];
  preset: string;
}

/** Winamp-style 10-band graphic EQ centre frequencies (Hz). */
export const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const;

export const DEFAULT_SETTINGS: Settings = {
  skin: 'nocturne',
  effects: 'full',
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off',
  eq: { enabled: false, preampDb: 0, gains: EQ_BANDS.map(() => 0), preset: 'Plat' },
  adblock: true,
  viz: { preset: null, autoCycle: true, cycleSec: 30, random: true },
  sidePanel: 'cover',
  outputDevice: 'default',
  outputLabel: null,
  ytClickLock: true,
  autoUpdateCheck: true,
  eqUserPresets: [],
  accent: null,
  uiScale: 1,
  ytLinks: true,
  hideSmallAlbums: true,
  homeHidden: [],
  radioRecordDir: '',
  gapless: true,
  crossfadeSec: 0,
  replayGain: 'off',
  language: 'system',
};

/** The Home page's sections below the clock, each can be hidden (Settings › Home). */
export const HOME_SECTIONS = ['recentPlayed', 'random', 'recentAdded', 'shortcuts', 'keyboard'] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

/** Albums with fewer tracks than this are hidden from Library › Albums while hideSmallAlbums is on. */
export const SMALL_ALBUM = 4;

// ── YouTube Music (public catalogue, no account) ─────────────────────────────────────────
export type YtSearchType = 'song' | 'album' | 'artist';

/** See `taskbar.youtubeBlocked`. */
export type YtBlock = 'signin' | 'error' | null;

/** "Recently played" holds this many tracks (Home, Library). */
export const RECENT_PLAYED = 10;

/** Longest crossfade offered (s). */
export const MAX_CROSSFADE = 12;

export interface YtAlbumItem {
  id: string;
  title: string;
  artist: string | null;
  artistId: string | null;
  year: string | null;
  /** "Album", "Single", "EP"… when YouTube says so. */
  kind: string | null;
  coverUrl: string | null;
}

export interface YtArtistItem {
  id: string;
  name: string;
  subtitle: string | null;
  coverUrl: string | null;
}

export type YtSearchResult =
  | { type: 'song'; items: Track[]; more: string | null }
  | { type: 'album'; items: YtAlbumItem[]; more: string | null }
  | { type: 'artist'; items: YtArtistItem[]; more: string | null };

export interface YtAlbumPage extends YtAlbumItem {
  subtitle: string | null;
  tracks: Track[];
}

export interface YtArtistPage {
  id: string;
  name: string;
  coverUrl: string | null;
  songs: Track[];
  albums: YtAlbumItem[];
  singles: YtAlbumItem[];
}

/** YouTube Music's own "Start radio" list for a seed track (playlist RDAMVM<videoId>). */
export interface YtMix {
  playlistId: string;
  tracks: Track[];
}

/** A track named by another service (Spotify), to look up on YouTube Music. */
export interface WantedTrack {
  title: string;
  artists: string[];
  durationSec: number | null;
}

/** What a pasted YouTube / Spotify link holds. YouTube tracks come as they are; Spotify
 *  tracks are only names, matched one by one on YouTube Music (`youtube.match`). */
export interface YtLinkImport {
  source: 'youtube' | 'spotify';
  kind: 'track' | 'album' | 'playlist' | 'artist';
  title: string;
  /** Artist or owner, when the service says. */
  subtitle: string | null;
  tracks?: Track[];
  wanted?: WantedTrack[];
  /** kind 'artist': the YouTube Music artist page to open. */
  artistId?: string;
  /** The service lists only part of a long playlist (Spotify: its first 100 tracks). */
  truncated: boolean;
}

export interface AdblockStatus {
  enabled: boolean;
  /** Filter engine loaded and attached to the YouTube session. */
  active: boolean;
  /** Why it is not active (offline on first run, load error…). */
  error: string | null;
  /** Requests blocked in the YouTube session since launch. */
  blocked: number;
  /** Times YouTube's own player reported an ad playing (diagnostic, since launch). */
  adsSeen: number;
  /** Last time the engine was rebuilt because a list changed upstream. */
  listsUpdatedAt: number | null;
  /** Last successful check of the lists against their sources (hourly). */
  listsCheckedAt: number | null;
  lists: AdblockList[];
  /** Network + cosmetic filters in the engine. */
  filters: number;
  checking: boolean;
  /** Never built yet: lists are downloaded the first time YouTube Music is used. */
  waiting: boolean;
}

export interface RadioCountry {
  code: string;
  name: string;
  count: number;
}

export interface RadioStation {
  id: string;
  name: string;
  url: string;
  favicon: string | null;
  tags: string[];
  country: string;
  countryCode: string;
  homepage: string | null;
  codec: string;
  bitrate: number | null;
  votes: number;
}

/** Time-shift memory of the station playing, in seconds of audio since it was tuned in. */
export interface RadioWindow {
  /** Stream URL of the station. */
  url: string;
  /** Oldest moment still in memory. */
  start: number;
  /** Live edge. */
  end: number;
  /** Bytes per second. */
  rate: number;
  ended: boolean;
  recording: RecordResult | null;
}

export interface RecordResult {
  path: string;
  seconds: number;
  /** Where the recording started (seconds since tuning in). */
  start?: number;
}

export type StatsPeriod = '7d' | '30d' | '365d' | 'all';

/** One track (and its artist) in the listening history, for the track card. */
export interface TrackStats {
  /** Plays counted (after 30 s, or half a short track). */
  plays: number;
  /** Seconds actually listened to this track / to this artist (all sources). */
  seconds: number;
  artistSeconds: number;
  /** First play, ms since epoch. */
  firstAt: number | null;
}

export interface ListenTick {
  key: string;
  source: TrackSource;
  title: string;
  artist: string | null;
  album: string | null;
  seconds: number;
}

export interface StatsRow {
  title: string;
  artist: string | null;
  source: string;
  /** plays, or seconds — depending on the list */
  value: number;
}

export interface Stats {
  period: StatsPeriod;
  seconds: number;
  bySource: { local: number; youtube: number; radio: number };
  plays: number;
  distinctTracks: number;
  activeDays: number;
  streak: { current: number; longest: number };
  bestDay: { day: string; seconds: number } | null;
  discovered: number;
  topTracksByPlays: StatsRow[];
  topTracksByTime: StatsRow[];
  topArtists: StatsRow[];
  topAlbums: StatsRow[];
  topStations: StatsRow[];
  /** seconds listened per hour of day (0–23) */
  hours: number[];
  /** seconds listened per weekday, Monday first */
  weekdays: number[];
  library: { tracks: number; seconds: number; playlists: number };
  /** first day with measured listening time */
  measuredSince: string | null;
}

export interface LyricsQuery {
  title: string;
  artist: string | null;
  album?: string | null;
  durationSec?: number | null;
}

export interface LyricsResult {
  status: 'synced' | 'plain' | 'instrumental' | 'not-found' | 'error';
  /** LRC text ("[mm:ss.xx] line"), when time-synced lyrics exist. */
  synced: string | null;
  plain: string | null;
  /** What the database matched. */
  matched: { title: string; artist: string; album: string | null } | null;
  /** The query actually sent (after cleaning YouTube-style titles). */
  query: LyricsQuery;
  source: 'LRCLIB';
  error?: string;
}

export interface AdblockList {
  id: string;
  title: string;
  /** When this list was last downloaded (i.e. last changed upstream). */
  updatedAt: number | null;
}

/** What the UI persists to restore its tabs on next launch. */
export interface SessionSnapshot {
  tabs: PersistedTab[];
  activeTabId: string | null;
}

export type PersistedTab =
  | { id: string; kind: 'section'; section: SectionId }
  | { id: string; kind: 'files'; title: string; paths: string[] }
  | { id: string; kind: 'playlist'; playlistId: number }
  | { id: string; kind: 'mix'; title: string; seed: Track; tracks: Track[] }
  | { id: string; kind: 'clip' };

export type SectionId = 'home' | 'library' | 'playlists' | 'youtube' | 'lyrics' | 'radio' | 'visualizer' | 'stats' | 'settings';

/** The API the preload script exposes on `window.chud`. */
export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  userData: string;
  cache: string;
}

export interface ChudApi {
  platform: string;
  /** Interface language, resolved by the main process (sent synchronously at startup). */
  lang: string;
  /** Automated tests only: the playback engine is reachable from the page. */
  testing: boolean;
  /** Reloads the interface (after a language change). */
  reload(): void;
  /** Windows taskbar thumbnail buttons (previous / play-pause / next). */
  taskbar: {
    report(s: { playing: boolean; enabled: boolean }): void;
    /** What the taskbar shows ("playing|enabled"), for tests. */
    state(): Promise<string>;
    onCommand(cb: (cmd: 'prev' | 'toggle' | 'next' | 'stop') => void): () => void;
    /** Media keys registered for Chud Music, or held by another program. */
    mediaKeys(): Promise<{ active: boolean; registered: boolean; taken: string[] }>;
    /** Routes the YouTube player's sound to an output device; false if YouTube refused. */
    youtubeSink(sinkId: string): Promise<boolean>;
    /**
     * Asks the YouTube player for at most this picture quality ('large' is 480p; null: its own
     * choice). Answers the quality it then reports, or null when there is no player yet.
     */
    youtubeQuality(cap: 'large' | null): Promise<string | null>;
    /** What the official player shows when it refuses to play: 'signin' (YouTube asks to sign in
     *  to prove this is not a robot), 'error' (its own error screen), or null. */
    youtubeBlocked(): Promise<YtBlock>;
  };
  /** Writes an interface error to the local log file. */
  logError(message: string): void;
  /** Opens the logs folder in Explorer. */
  openLogs(): void;
  /** Interface zoom (the whole window content). */
  setZoom(factor: number): void;
  appInfo(): Promise<AppInfo>;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    onMaximizedChange(cb: (maximized: boolean) => void): () => void;
    /** Mini player window on/off (restores the previous size and position). */
    mini(on: boolean): Promise<void>;
    onTop(on: boolean): Promise<void>;
  };
  files: {
    /** Native "Open" dialog; resolves to the chosen paths (empty if cancelled). */
    pick(): Promise<string[]>;
    /** Folder picker; resolves to the chosen folder or null. */
    pickFolder(): Promise<string | null>;
    /** Absolute path of a File dropped onto the window. */
    pathForFile(file: File): string;
    /** Expands dropped folders into the audio files they contain (recursive, sorted). */
    expand(paths: string[]): Promise<string[]>;
    /** Files passed on the command line / by Windows when the app was launched or re-launched. */
    onOpen(cb: (paths: string[]) => void): () => void;
    /** Tells the main process the UI is ready to receive files (flushes the launch queue). */
    ready(): void;
  };
  media: {
    probe(paths: string[]): Promise<Track[]>;
    /** Playable URL for a local file; `forceTranscode` after Chromium refused the original. */
    resolve(path: string, codec: string | null | undefined, forceTranscode?: boolean): Promise<PlayableSource>;
    /** Is this file there, and is it on a network share (`root`: its name) that answers? */
    reach(path: string): Promise<{ file: boolean; network: boolean; share: boolean; root: string }>;
    /** Volume normalisation: from the file's tags, else measured (takes a moment, once per file). */
    loudness(path: string): Promise<Loudness | null>;
    /** Sample rate the file is decoded at (Hz); 0 = not known. */
    sampleRate(path: string): Promise<number>;
  };
  library: {
    folders(): Promise<LibraryFolder[]>;
    /** Without a path, shows a folder picker. Resolves to the added path, or null if cancelled. */
    addFolder(path?: string): Promise<string | null>;
    removeFolder(path: string): Promise<void>;
    /** Turns scanning of one folder on or off (on: it is scanned once right away). */
    setFolderScan(path: string, on: boolean): Promise<void>;
    /** A full scan now (Library › …, Settings); the delayed startup scan is then dropped. */
    rescan(): Promise<void>;
    /** Looks online for the covers of library tracks without one (resolves when done). */
    findCovers(): Promise<void>;
    cancelCovers(): Promise<void>;
    /** Deletes every cover found online (Chud Music's own pictures): how many links went. */
    removeFoundCovers(): Promise<number>;
    /** Right-click › Remove the found cover: those tracks only (they are not searched again). */
    removeFoundCoverOf(trackIds: string[]): Promise<number>;
    coverStatus(): Promise<CoverStatus & { saved: number }>;
    onCoverStatus(cb: (s: CoverStatus & { saved: number }) => void): () => void;
    /** Removes tracks from the library index only: files on disk are never touched. */
    removeTracks(ids: string[]): Promise<void>;
    restoreTracks(ids: string[]): Promise<void>;
    /** Brings back every file removed from the library. */
    restoreAll(): Promise<void>;
    /** Stops following all folders and empties the library (playlists and files untouched). */
    clear(): Promise<void>;
    excludedCount(): Promise<number>;
    tracks(): Promise<Track[]>;
    status(): Promise<ScanStatus>;
    /** The library in pages: `next` is where the following page starts (first page: 0). */
    page(after: number): Promise<{ tracks: Track[]; next: number | null }>;
    /** What changed since the last call (or the first page): tracks to put or replace, and to take out. */
    changes(): Promise<{ tracks: Track[]; gone: string[]; more: boolean }>;
    recentlyPlayed(limit: number): Promise<Track[]>;
    /** Takes tracks out of "Recently played" / "Recently added" (history and library unchanged). */
    hideRecent(list: 'played' | 'added', ids: string[]): Promise<void>;
    /** Empties "Recently played" (the history itself, statistics and play counts are kept). */
    clearRecent(): Promise<void>;
    /** Tracks taken out of "Recently added": id → when. */
    hiddenAdded(): Promise<Record<string, number>>;
    onChanged(cb: () => void): () => void;
    onStatus(cb: (s: ScanStatus) => void): () => void;
  };
  playlists: {
    list(): Promise<PlaylistSummary[]>;
    get(id: number): Promise<PlaylistDetail | null>;
    create(name: string, tracks?: Track[]): Promise<number>;
    rename(id: number, name: string): Promise<void>;
    /** Picks an image (file dialog, or `path`) as the playlist's picture; false = cancelled. */
    setCover(id: number, path?: string): Promise<boolean>;
    /** Back to the mosaic of the tracks' covers. */
    clearCover(id: number): Promise<void>;
    /** A smart playlist: created, or its description changed. */
    createSmart(name: string, spec: SmartSpec): Promise<number>;
    setSmart(id: number, spec: SmartSpec): Promise<void>;
    /** Tracks a description gives now (the editor's preview). */
    previewSmart(spec: SmartSpec): Promise<{ count: number; durationSec: number; sample: Track[] }>;
    remove(id: number): Promise<void>;
    /** Deletes every playlist (the tracks themselves, files and library, are untouched). How many. */
    removeAll(): Promise<number>;
    /** Inserts at `index` (default: end). The same track may be added several times. */
    addTracks(id: number, tracks: Track[], index?: number): Promise<void>;
    removeEntries(id: number, entryIds: number[]): Promise<void>;
    /** New complete order of entry ids. */
    reorder(id: number, entryIds: number[]): Promise<void>;
    /** YouTube Music entries that are also in the library (same song): the local track for each. */
    localSwaps(id: number): Promise<{ entryId: number; from: Track; to: Track }[]>;
    /** Puts those local tracks in place of the entries; how many were replaced. */
    applySwaps(id: number, swaps: { entryId: number; trackId: string }[]): Promise<number>;
    /** Save dialog; M3U8 (local files) or JSON (everything, YouTube included). */
    exportOne(id: number): Promise<string | null>;
    exportAll(): Promise<string | null>;
    /** Open dialog; M3U/M3U8 or Chud JSON. Resolves to the number of playlists created. */
    importFiles(): Promise<number>;
    onChanged(cb: (id: number | null) => void): () => void;
  };
  history: {
    record(track: Track, context: string): Promise<void>;
  };
  player: {
    load(): Promise<PlayerSnapshot | null>;
    /** The whole list of a partial snapshot, as it was saved… */
    rest(): Promise<{ tracks: SavedTrack[]; order: number[] } | null>;
    /** …and its tracks, by id (null: gone since). */
    tracks(ids: string[]): Promise<(Track | null)[]>;
    save(s: SavedPlayer | null): Promise<void>;
    /** Only the place in the queue and the time (the queue itself unchanged since the last save). */
    savePosition(pos: number, time: number): Promise<void>;
  };
  shell: {
    showInFolder(path: string): void;
    /** Windows "Default apps" page for Chud Music. */
    openDefaultApps(): void;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<void>;
  };
  session: {
    load(): Promise<SessionSnapshot | null>;
    save(s: SessionSnapshot): Promise<void>;
  };
  youtube: {
    search(query: string, type: YtSearchType): Promise<YtSearchResult>;
    /** Next page of a search; the token comes from `more`. */
    more(token: string): Promise<YtSearchResult>;
    suggest(query: string): Promise<string[]>;
    album(id: string): Promise<YtAlbumPage>;
    artist(id: string): Promise<YtArtistPage>;
    mix(videoId: string): Promise<YtMix>;
    /** Artists hidden from searches and mixes (newest first), and changing that list. */
    hiddenArtists(): Promise<HiddenArtist[]>;
    hideArtist(a: { id: string | null; name: string }): Promise<HiddenArtist[]>;
    unhideArtist(a: { id: string | null; name: string }): Promise<HiddenArtist[]>;
    /** Reads a pasted YouTube or Spotify link (track, album, playlist). */
    link(link: MusicLink): Promise<YtLinkImport>;
    /** The same track on YouTube Music, or null when nothing close enough is found. */
    match(track: WantedTrack): Promise<Track | null>;
    /** The YouTube Music artist page id for this name (Spotify artist, local artist). */
    findArtist(name: string): Promise<string | null>;
    /** The official music video of a track, or null (the video clip tab). */
    musicVideo(track: WantedTrack): Promise<Track | null>;
    /** Opens the track on music.youtube.com in the user's browser. */
    openExternal(videoId: string): void;
  };
  radio: {
    countries(): Promise<RadioCountry[]>;
    stations(countryCode: string): Promise<RadioStation[]>;
    search(name: string): Promise<RadioStation[]>;
    favorites(): Promise<RadioStation[]>;
    setFavorites(list: RadioStation[]): Promise<void>;
    /** Tells the directory a station was played (it ranks stations by plays). */
    played(id: string): void;
    /** Title currently on air ("Artist - Title"), read from the stream. */
    onTitle(cb: (e: { url: string; title: string }) => void): () => void;
    /** Time-shift memory of the station playing (null: none). */
    window(): Promise<RadioWindow | null>;
    /** Closes the station's connection (another source plays); saves a recording in progress. */
    stop(): Promise<RecordResult | null>;
    /** Records from `from` (seconds since tuning in, null = live) into `dir` ('' = Music folder). */
    record(name: string, dir: string, from: number | null): Promise<RecordResult | null>;
    /** Stops at `to` (what is heard; null = all received): the rest is cut off the file. */
    recordStop(to?: number | null): Promise<RecordResult | null>;
    /** The system's Music folder (default place of recordings). */
    musicDir(): Promise<string>;
  };
  stats: {
    listen(t: ListenTick): void;
    get(period: StatsPeriod): Promise<Stats>;
    track(id: string, artist: string | null): Promise<TrackStats>;
  };
  lyrics: {
    /** force: ignore the cache (manual retry or a corrected search). */
    get(q: LyricsQuery, force?: boolean): Promise<LyricsResult>;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<void>;
    /** Downloads in-app, or opens the GitHub releases page when that is not possible. */
    download(): Promise<void>;
    /** Restarts into the installer once downloaded. */
    install(): void;
    openReleases(): void;
    onStatus(cb: (s: UpdateStatus) => void): () => void;
  };
  adblock: {
    status(): Promise<AdblockStatus>;
    /** Checks the filter lists now; resolves to true if a list had changed. */
    check(): Promise<boolean>;
    /** YouTube Music is about to be used: builds the engine if it never was. */
    warm(): void;
    onStatus(cb: (s: AdblockStatus) => void): () => void;
  };
}
