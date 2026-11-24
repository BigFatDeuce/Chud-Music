import { create } from 'zustand';
import { RECENT_PLAYED, type CoverStatus, type LibraryFolder, type ScanStatus, type Track } from '@shared/types';
import { toast } from './toasts';
import { tr } from '@shared/i18n';

interface LibraryState {
  tracks: Track[];
  folders: LibraryFolder[];
  status: ScanStatus;
  recentlyPlayed: Track[];
  /** Tracks taken out of "Recently added" by hand: id → when (see `inRecentAdded`). */
  hiddenAdded: Record<string, number>;
  /** Out of "Recently played" / "Recently added" (right-click › Remove from…): nothing else changes. */
  hideRecent(list: 'played' | 'added', tracks: Track[]): Promise<void>;
  /** Files the user removed from the library (kept out of rescans). */
  excluded: number;
  loaded: boolean;
  /** Library › … › Find missing covers: progress, and how many tracks have a found cover. */
  covers: CoverStatus & { saved: number };
  findCovers(): Promise<void>;
  /** Everything: tracks and folders (start, folders added or removed). */
  load(): Promise<void>;
  /** The tracks only (what changes during scans and plays). */
  reloadTracks(): Promise<void>;
  /** The folders, with their reachability and counts (asks the disks: not on every change). */
  loadFolders(): Promise<void>;
  /** "Recently played" › Clear all: the list only, history and statistics stay. */
  clearRecent(): Promise<void>;
  /** Out of the library, with an undo toast. Files on disk are never touched. */
  removeTracks(tracks: Track[]): Promise<void>;
  clear(): Promise<void>;
  addFolder(path?: string): Promise<string | null>;
  removeFolder(path: string): Promise<void>;
  rescan(): Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  tracks: [],
  folders: [],
  status: { running: false, found: 0, parsed: 0, lastScanAt: null, watching: false, unread: 0 },
  recentlyPlayed: [],
  hiddenAdded: {},
  excluded: 0,
  loaded: false,
  covers: { running: false, done: 0, total: 0, album: 0, artist: 0, none: 0, error: null, saved: 0 },
  async findCovers() {
    let failed: string | null = null;
    await window.chud.library.findCovers().catch((e: unknown) => {
      failed = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    });
    const c = await window.chud.library.coverStatus();
    if (failed && !c.error) c.error = failed;
    useLibrary.setState({ covers: c });
    if (c.error) toast({ kind: 'error', title: tr('cov.failed'), body: c.error });
    else toast({ title: tr('cov.done'), body: tr('cov.summary', { album: c.album, artist: c.artist, none: c.none }) });
  },
  async load() {
    await Promise.all([get().reloadTracks(), get().loadFolders()]);
  },
  async reloadTracks() {
    const first = !get().loaded;
    const [, status, recentlyPlayed, excluded, hiddenAdded] = await Promise.all([
      first ? loadTracks() : applyChanges(),
      window.chud.library.status(),
      window.chud.library.recentlyPlayed(RECENT_PLAYED),
      window.chud.library.excludedCount(),
      window.chud.library.hiddenAdded(),
    ]);
    set({ status, recentlyPlayed, excluded, hiddenAdded, loaded: true });
  },
  async hideRecent(list, picked) {
    const ids = picked.map((t) => t.id);
    if (!ids.length) return;
    const gone = new Set(ids);
    // at once on screen, the database follows
    if (list === 'played') set({ recentlyPlayed: get().recentlyPlayed.filter((t) => !gone.has(t.id)) });
    else set({ hiddenAdded: { ...get().hiddenAdded, ...Object.fromEntries(ids.map((id) => [id, Date.now()])) } });
    await window.chud.library.hideRecent(list, ids);
    if (list === 'played') set({ recentlyPlayed: await window.chud.library.recentlyPlayed(RECENT_PLAYED) });
  },
  async clearRecent() {
    set({ recentlyPlayed: [] });
    await window.chud.library.clearRecent();
    toast({ title: tr('rec.cleared'), body: tr('rec.clearedBody') });
  },
  async loadFolders() {
    set({ folders: await window.chud.library.folders() });
  },
  async removeTracks(list) {
    const ids = list.filter((t) => t.source === 'local').map((t) => t.id);
    if (!ids.length) return;
    // optimistic: the rows leave at once, the database follows
    const gone = new Set(ids);
    set({ tracks: get().tracks.filter((t) => !gone.has(t.id)) });
    await window.chud.library.removeTracks(ids);
    toast({
      title: ids.length > 1 ? tr('lib.removedN', { n: ids.length }) : tr('lib.removedOne', { title: list[0]!.title }),
      body: tr('lib.fileStays'),
      action: { label: tr('common.undo'), run: () => void window.chud.library.restoreTracks(ids) },
    });
  },
  async clear() {
    await window.chud.library.clear();
    await get().load();
  },
  addFolder: async (path) => {
    const p = await window.chud.library.addFolder(path);
    if (p) await get().load();
    return p;
  },
  removeFolder: async (path) => {
    await window.chud.library.removeFolder(path);
    await get().load();
  },
  rescan: () => window.chud.library.rescan(),
}));

// The library comes from the main process in pages, at the start (the first one shows at once);
// afterwards only what changed does. Very large libraries: the same text (an artist, an album) is
// kept once in memory, not once per track.

const texts = new Map<string, string>();
function once<T extends string | null | undefined>(s: T): T {
  if (!s) return s;
  const known = texts.get(s);
  if (known !== undefined) return known as T;
  texts.set(s, s);
  return s;
}
function slim(tracks: Track[]): Track[] {
  for (const t of tracks) {
    t.artist = once(t.artist);
    t.album = once(t.album);
    t.albumArtist = once(t.albumArtist);
    t.genre = once(t.genre);
    t.codec = once(t.codec);
    t.coverUrl = once(t.coverUrl);
    if (t.problem) t.problem = once(t.problem);
  }
  return tracks;
}

async function loadTracks(): Promise<void> {
  const all: Track[] = [];
  let after: number | null = 0;
  while (after !== null) {
    const page: { tracks: Track[]; next: number | null } = await window.chud.library.page(after);
    const start = after === 0;
    for (const t of slim(page.tracks)) all.push(t);
    after = page.next;
    if (start && after !== null) useLibrary.setState({ tracks: all.slice() });
  }
  useLibrary.setState({ tracks: all });
}

async function applyChanges(): Promise<void> {
  const put = new Map<string, Track>();
  const gone = new Set<string>();
  for (;;) {
    const c = await window.chud.library.changes();
    for (const t of slim(c.tracks)) {
      put.set(t.id, t);
      gone.delete(t.id);
    }
    for (const id of c.gone) {
      gone.add(id);
      put.delete(id);
    }
    if (!c.more) break;
  }
  if (!put.size && !gone.size) return;
  const out: Track[] = [];
  let changed = false;
  for (const t of useLibrary.getState().tracks) {
    const n = put.get(t.id);
    if (n) {
      out.push(n);
      put.delete(t.id);
      changed = true;
    } else if (gone.has(t.id)) changed = true;
    else out.push(t);
  }
  for (const t of put.values()) out.push(t);
  if (changed || put.size) useLibrary.setState({ tracks: out });
}

// Reloads are grouped. Changes in a burst make one reload, 300 ms after the last; during a scan, at
// most one every 3 s (the scan's end always brings a last one). Never two at once.
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let reloading: Promise<void> | null = null;
let again = false;
let lastReload = 0;
function reloadNow(): void {
  if (reloading) {
    again = true;
    return;
  }
  lastReload = Date.now();
  reloading = useLibrary
    .getState()
    .reloadTracks()
    .catch(() => {})
    .finally(() => {
      reloading = null;
      if (again) {
        again = false;
        scheduleLibraryReload();
      }
    });
}
export function scheduleLibraryReload(): void {
  clearTimeout(reloadTimer);
  const scanning = useLibrary.getState().status.running;
  const wait = scanning ? Math.max(300, 3000 - (Date.now() - lastReload)) : 300;
  reloadTimer = setTimeout(reloadNow, wait);
}

/** Still in "Recently added": not taken out by hand since it was (last) added. */
export const inRecentAdded = (t: Track, hidden: Record<string, number>): boolean => !(hidden[t.id]! >= (t.addedAt ?? 0));

/**
 * A play was counted: that track's count and date change here, and the short "recently played"
 * list is asked again — not the whole library.
 */
export function notePlayed(id: string): void {
  const { tracks } = useLibrary.getState();
  const i = tracks.findIndex((t) => t.id === id);
  if (i >= 0) {
    const next = tracks.slice();
    next[i] = { ...tracks[i]!, playCount: (tracks[i]!.playCount ?? 0) + 1, lastPlayedAt: Date.now() };
    useLibrary.setState({ tracks: next });
  }
  void window.chud.library.recentlyPlayed(RECENT_PLAYED).then((recentlyPlayed) => useLibrary.setState({ recentlyPlayed }));
}

window.chud.library.onChanged(scheduleLibraryReload);
window.chud.library.onStatus((status) => {
  const was = useLibrary.getState().status.running;
  useLibrary.setState({ status });
  // a scan ended: folder counts and reachability may have changed
  if (was && !status.running) void useLibrary.getState().loadFolders();
});
window.chud.library.onCoverStatus((covers) => useLibrary.setState({ covers }));
void window.chud.library.coverStatus().then((covers) => useLibrary.setState({ covers }));
