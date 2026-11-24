import { create } from 'zustand';
import type { PersistedTab, SectionId, SessionSnapshot, Track } from '@shared/types';
import { guessFromFilename, localIdOf } from '@shared/filenames';
import { onPlaylistChanged, usePlaylists } from './playlists';
import { tr } from '@shared/i18n';

// Tabs are views. The "files" tab ("Fichiers ouverts", only one) collects files opened
// individually (Explorer double-click, drag & drop outside a playlist, Open dialog): each
// opening adds to it. It is NOT a playlist and opening files never modifies a playlist,
// the queue, or what is currently playing. A "playlist" tab shows a saved playlist; closing it
// deletes nothing. A "mix" tab holds YouTube Music's own radio for a seed track: also a
// temporary list, until the user saves it as a playlist.

export type Tab =
  | { id: string; kind: 'section'; section: SectionId }
  | { id: string; kind: 'files'; title: string; paths: string[]; tracks: Track[] | null }
  | { id: string; kind: 'playlist'; playlistId: number }
  | { id: string; kind: 'mix'; title: string; seed: Track; tracks: Track[] }
  | { id: string; kind: 'clip' };

export const PINNED: SectionId[] = ['home', 'library'];
export const OPENED_TAB = 'files:opened';
/** The video clip tab (one at most): what is playing, big, with its lyrics. */
export const CLIP_TAB = 'clip';
export const OPENED_TITLE = tr('files.title');
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // Windows paths

export const SECTION_LABEL: Record<SectionId, string> = {
  home: tr('section.home'),
  library: tr('section.library'),
  playlists: tr('section.playlists'),
  youtube: tr('section.youtube'),
  lyrics: tr('section.lyrics'),
  radio: tr('section.radio'),
  visualizer: tr('section.visualizer'),
  stats: tr('section.stats'),
  settings: tr('section.settings'),
};

interface TabsState {
  tabs: Tab[];
  activeId: string;
  restored: boolean;
  openSection(section: SectionId): void;
  openPlaylist(id: number): void;
  /** Opens (or shows) the video clip tab. */
  openClip(): void;
  /** Opens (or replaces) the mix tab of this seed track; returns its id. */
  openMix(seed: Track, tracks: Track[]): string;
  /** Adds these files to "Fichiers ouverts" (focused); resolves once metadata is loaded with
   *  the index of the first of them in the tab. Files already there are not duplicated. */
  openFiles(paths: string[]): Promise<{ first: number }>;
  /** Takes files out of "Fichiers ouverts" (the files themselves are untouched). */
  removeOpened(paths: string[]): void;
  /** Moves rows of "Fichiers ouverts" (indices) so they sit before row `to` of the current
   *  order (`to` = length: at the end); returns their new indices. */
  moveOpened(indices: number[], to: number): number[];
  /** New order of the movable tabs (every tab but Home and Library, which stay first). */
  reorder(ids: string[]): void;
  /** Moves a tab one place left or right (never before Home and Library). */
  shift(id: string, dir: 1 | -1): void;
  activate(id: string): void;
  close(id: string): void;
  /** The player bar's buttons: opens that tab, or closes it when it is already the one shown. */
  toggleTab(id: string, open: () => void): void;
  cycle(dir: 1 | -1): void;
  patchTrack(trackId: string, patch: Partial<Track>): void;
  restore(): Promise<void>;
}

export const sectionId = (s: SectionId) => `section:${s}`;
/** Home and Library: always open, always the first two tabs. */
export const isPinned = (t: Tab) => t.kind === 'section' && PINNED.includes(t.section);
type FilesTab = Extract<Tab, { kind: 'files' }>;
const opened = (tabs: Tab[]) => tabs.find((t): t is FilesTab => t.id === OPENED_TAB && t.kind === 'files');

/** A row for a file not read yet: name guessed from the file name, loading animation. */
function placeholder(path: string): Track {
  const g = guessFromFilename(path);
  return { id: localIdOf(path, window.chud.platform), source: 'local', path, title: g.title, artist: g.artist, album: null, durationSec: null, coverUrl: null, codec: null, available: true, pending: true };
}

/**
 * Reads files' tags a few at a time and fills their rows as answers come back, so a slow disk
 * or network share delays only its own rows, never the app or the other files.
 */
async function fillOpened(paths: string[]): Promise<void> {
  const queue = [...paths];
  const worker = async () => {
    while (queue.length) {
      const batch = queue.splice(0, 4);
      const tracks = await window.chud.media.probe(batch).catch(() => null);
      if (!tracks) continue;
      const s = useTabs.getState();
      const tab = opened(s.tabs);
      if (!tab?.tracks) return;
      const byPath = new Map(tracks.map((t) => [t.path!.toLowerCase(), t]));
      const filled = tab.tracks.map((t) => (t.pending && t.path && byPath.get(t.path.toLowerCase())) || t);
      useTabs.setState({ tabs: s.tabs.map((x) => (x.id === OPENED_TAB ? { ...tab, tracks: filled } : x)) });
    }
  };
  await Promise.all([worker(), worker()]);
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: PINNED.map((s) => ({ id: sectionId(s), kind: 'section', section: s })),
  activeId: sectionId('home'),
  restored: false,

  openSection(section) {
    const id = sectionId(section);
    if (!get().tabs.some((t) => t.id === id)) set({ tabs: [...get().tabs, { id, kind: 'section', section }] });
    set({ activeId: id });
  },

  toggleTab(id, open) {
    if (get().activeId === id) get().close(id);
    else open();
  },

  openPlaylist(playlistId) {
    const id = `playlist:${playlistId}`;
    if (!get().tabs.some((t) => t.id === id)) set({ tabs: [...get().tabs, { id, kind: 'playlist', playlistId }] });
    set({ activeId: id });
  },

  openClip() {
    if (!get().tabs.some((t) => t.id === CLIP_TAB)) set({ tabs: [...get().tabs, { id: CLIP_TAB, kind: 'clip' }] });
    set({ activeId: CLIP_TAB });
  },

  openMix(seed, tracks) {
    const id = `mix:${seed.videoId ?? seed.id}`;
    const tab: Tab = { id, kind: 'mix', title: tr('mix.title', { title: seed.title }), seed, tracks };
    const exists = get().tabs.some((t) => t.id === id);
    set({ tabs: exists ? get().tabs.map((t) => (t.id === id ? tab : t)) : [...get().tabs, tab], activeId: id });
    return id;
  },

  async openFiles(paths) {
    if (!opened(get().tabs)) set({ tabs: [...get().tabs, { id: OPENED_TAB, kind: 'files', title: OPENED_TITLE, paths: [], tracks: [] }] });
    set({ activeId: OPENED_TAB });
    const tab = opened(get().tabs)!;
    const fresh = paths.filter((p, i) => !tab.paths.some((k) => samePath(k, p)) && paths.findIndex((q) => samePath(q, p)) === i);
    // the rows appear at once; their tags fill in as each file is read
    const next: FilesTab = { ...tab, paths: [...tab.paths, ...fresh], tracks: [...(tab.tracks ?? tab.paths.map(placeholder)), ...fresh.map(placeholder)] };
    set({ tabs: get().tabs.map((t) => (t.id === OPENED_TAB ? next : t)) });
    void fillOpened(fresh);
    return { first: Math.max(0, next.paths.findIndex((k) => samePath(k, paths[0]!))) };
  },

  removeOpened(paths) {
    const tab = opened(get().tabs);
    if (!tab) return;
    const keep = (p: string) => !paths.some((x) => samePath(x, p));
    const next: FilesTab = { ...tab, paths: tab.paths.filter(keep), tracks: tab.tracks?.filter((t) => !t.path || keep(t.path)) ?? null };
    set({ tabs: get().tabs.map((t) => (t.id === OPENED_TAB ? next : t)) });
  },

  moveOpened(indices, to) {
    const tab = opened(get().tabs);
    if (!tab?.tracks) return [];
    const n = tab.tracks.length;
    const moving = [...new Set(indices)].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
    if (!moving.length) return [];
    const rest = [...Array(n).keys()].filter((i) => !moving.includes(i));
    const at = rest.filter((i) => i < to).length;
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    const moved = moving.map((_, k) => at + k);
    if (order.every((v, i) => v === i)) return moved;
    const tracks = order.map((i) => tab.tracks![i]!);
    // paths follow the rows (one row per path; rebuilt from the rows if they ever differ)
    const paths = tab.paths.length === n ? order.map((i) => tab.paths[i]!) : tracks.map((t) => t.path!).filter(Boolean);
    set({ tabs: get().tabs.map((t) => (t.id === OPENED_TAB ? { ...tab, paths, tracks } : t)) });
    return moved;
  },

  reorder(ids) {
    const tabs = get().tabs;
    const pinned = tabs.filter(isPinned);
    const movable = tabs.filter((t) => !isPinned(t));
    const byId = new Map(movable.map((t) => [t.id, t]));
    const next = ids.map((id) => byId.get(id)).filter((t): t is Tab => !!t);
    // a tab missing from `ids` (opened meanwhile) keeps its place at the end
    for (const t of movable) if (!ids.includes(t.id)) next.push(t);
    if (next.every((t, i) => t === movable[i])) return;
    set({ tabs: [...pinned, ...next] });
  },

  shift(id, dir) {
    const ids = get().tabs.filter((t) => !isPinned(t)).map((t) => t.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    get().reorder(ids);
  },

  activate(id) {
    if (get().tabs.some((t) => t.id === id)) set({ activeId: id });
  },

  close(id) {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    const tab = tabs[idx];
    if (!tab || (tab.kind === 'section' && PINNED.includes(tab.section))) return;
    const next = tabs.filter((t) => t.id !== id);
    set({ tabs: next, activeId: activeId === id ? (next[Math.min(idx, next.length - 1)] ?? next[0]!).id : activeId });
  },

  cycle(dir) {
    const { tabs, activeId } = get();
    const i = tabs.findIndex((t) => t.id === activeId);
    set({ activeId: tabs[(i + dir + tabs.length) % tabs.length]!.id });
  },

  patchTrack(trackId, patch) {
    set({
      tabs: get().tabs.map((t) =>
        (t.kind === 'files' || t.kind === 'mix') && t.tracks?.some((x) => x.id === trackId)
          ? { ...t, tracks: t.tracks!.map((x) => (x.id === trackId ? { ...x, ...patch } : x)) }
          : t,
      ),
    });
  },

  async restore() {
    const snap = await window.chud.session.load();
    if (snap?.tabs.length) {
      // Earlier versions opened one tab per batch of files: merge them into "Fichiers ouverts".
      const filesPaths: string[] = [];
      for (const t of snap.tabs) if (t.kind === 'files') for (const p of t.paths) if (!filesPaths.some((k) => samePath(k, p))) filesPaths.push(p);
      const firstFiles = snap.tabs.findIndex((t) => t.kind === 'files');
      const tabs: Tab[] = snap.tabs.flatMap((t, i): Tab[] =>
        t.kind !== 'files' ? [t] : i === firstFiles ? [{ id: OPENED_TAB, kind: 'files', title: OPENED_TITLE, paths: filesPaths, tracks: filesPaths.map(placeholder) }] : [],
      );
      if (snap.activeTabId?.startsWith('files:')) snap.activeTabId = OPENED_TAB;
      for (const s of [...PINNED].reverse()) if (!tabs.some((t) => t.id === sectionId(s))) tabs.unshift({ id: sectionId(s), kind: 'section', section: s });
      // Home and Library first, in that order; the others keep the order they were left in
      const ordered = [...PINNED.map((s) => tabs.find((t) => t.id === sectionId(s))!), ...tabs.filter((t) => !isPinned(t))];
      set({ tabs: ordered, activeId: ordered.some((t) => t.id === snap.activeTabId) ? snap.activeTabId! : ordered[0]!.id });
      // Re-read the files in the background, row by row; missing ones come back flagged, never dropped.
      void fillOpened(filesPaths);
    }
    set({ restored: true });
  },
}));

// Persist the open tabs (debounced) so they come back after a restart.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useTabs.subscribe((s, prev) => {
  if (!s.restored || (s.tabs === prev.tabs && s.activeId === prev.activeId)) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snap: SessionSnapshot = {
      activeTabId: s.activeId,
      tabs: s.tabs.map((t): PersistedTab => (t.kind === 'files' ? { id: t.id, kind: 'files', title: t.title, paths: t.paths } : t)),
    };
    void window.chud.session.save(snap);
  }, 400);
});

// A deleted playlist closes its tab.
onPlaylistChanged((id) => {
  if (id == null || usePlaylists.getState().list.some((p) => p.id === id)) return;
  useTabs.getState().close(`playlist:${id}`);
});
