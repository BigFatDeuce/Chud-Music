import { create } from 'zustand';
import { hiddenMatcher, type HiddenArtist } from '@shared/hidden-artists';
import type { Track, WantedTrack, YtAlbumPage, YtArtistPage, YtLinkImport, YtSearchResult, YtSearchType } from '@shared/types';
import { parseMusicLink } from '@shared/links';
import { usePlayer } from './player';
import { useTabs } from './tabs';
import { toast } from './toasts';
import { tr } from '@shared/i18n';

// State of the YouTube Music section, kept across tab switches. Views stack like a browser:
// search results → album / artist pages → back.

export type YtView = { kind: 'search' } | { kind: 'album'; id: string } | { kind: 'artist'; id: string } | { kind: 'link'; id: string };

/** A pasted link being read, then (Spotify) its tracks matched one by one on YouTube Music. */
export interface LinkImport {
  url: string;
  data: YtLinkImport | null;
  error: string | null;
  /** One entry per wanted track, in order: the match, null = not found, undefined = not looked up yet. */
  matches: (Track | null | undefined)[];
}

interface YouTubeState {
  query: string;
  /** The query the current results belong to. */
  searched: string;
  type: YtSearchType;
  layout: 'list' | 'grid';
  result: YtSearchResult | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  stack: YtView[];
  albums: Record<string, YtAlbumPage>;
  artists: Record<string, YtArtistPage>;
  pageError: string | null;
  links: Record<string, LinkImport>;
  setQuery(q: string): void;
  setLayout(l: 'list' | 'grid'): void;
  search(query?: string, type?: YtSearchType): Promise<void>;
  loadMore(): Promise<void>;
  openAlbum(id: string): void;
  openArtist(id: string): void;
  /** Opens a pasted YouTube / Spotify link; false when the text is not one. */
  openLink(text: string): boolean;
  /** Opens the YouTube Music page of an artist named in a local file (search when unsure). */
  findArtist(name: string): Promise<void>;
  back(): void;
  /** Artists hidden from searches and mixes (loaded on demand: Settings, the first hide). */
  hidden: HiddenArtist[] | null;
  loadHidden(): Promise<void>;
  /** Hides an artist; the results on screen lose their tracks, albums and card at once. */
  hideArtist(a: { id: string | null; name: string }): Promise<void>;
  unhideArtist(a: HiddenArtist): Promise<void>;
}

/** The artist to hide for a YouTube track: its first credited artist (the one its id names). */
export function trackArtist(t: Track): { id: string | null; name: string } | null {
  // youtube.ts joins the credited artists with ", " (a name such as "AC/DC" stays whole)
  const name = t.artist ? t.artist.split(", ")[0]!.trim() : null;
  return t.source === 'youtube' && name ? { id: t.ytArtistId ?? null, name } : null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '');
let searchSeq = 0;

export const useYouTube = create<YouTubeState>((set, get) => ({
  query: '',
  searched: '',
  type: 'song',
  layout: 'list',
  result: null,
  loading: false,
  loadingMore: false,
  error: null,
  stack: [{ kind: 'search' }],
  albums: {},
  artists: {},
  pageError: null,
  links: {},
  hidden: null,

  async loadHidden() {
    set({ hidden: await window.chud.youtube.hiddenArtists() });
  },

  async hideArtist(a) {
    const hidden = await window.chud.youtube.hideArtist(a);
    const out = hiddenMatcher(hidden);
    const r = get().result;
    const result: YtSearchResult | null = !r
      ? r
      : r.type === 'song'
        ? { ...r, items: r.items.filter((t) => !out({ artistId: t.ytArtistId, artist: t.artist })) }
        : r.type === 'album'
          ? { ...r, items: r.items.filter((x) => !out(x)) }
          : { ...r, items: r.items.filter((x) => !out({ artistId: x.id, artist: x.name })) };
    set({ hidden, result });
    toast({
      title: tr('hide.done', { name: a.name }),
      body: tr('hide.doneBody'),
      action: { label: tr('common.undo'), run: () => void get().unhideArtist(hidden[0]!) },
    });
  },

  async unhideArtist(a) {
    set({ hidden: await window.chud.youtube.unhideArtist({ id: a.id, name: a.name }) });
  },

  setQuery: (query) => set({ query }),
  setLayout: (layout) => set({ layout }),

  async search(query = get().query, type = get().type) {
    const q = query.trim();
    set({ query, type, stack: [{ kind: 'search' }] });
    if (!q) return set({ result: null, searched: '', error: null });
    const seq = ++searchSeq;
    set({ loading: true, error: null });
    try {
      const result = await window.chud.youtube.search(q, type);
      if (seq === searchSeq) set({ result, searched: q, loading: false });
    } catch (e) {
      if (seq === searchSeq) set({ error: message(e), loading: false, result: null });
    }
  },

  async loadMore() {
    const { result } = get();
    if (!result?.more || get().loadingMore) return;
    set({ loadingMore: true });
    try {
      const next = await window.chud.youtube.more(result.more);
      // same type by construction; merge pages
      set({ result: { ...result, items: [...result.items, ...next.items], more: next.more } as YtSearchResult, loadingMore: false });
    } catch (e) {
      set({ loadingMore: false });
      toast({ kind: 'error', title: tr('yt.moreFailed'), body: message(e) });
    }
  },

  openAlbum(id) {
    useTabs.getState().openSection('youtube');
    set({ stack: [...get().stack, { kind: 'album', id }], pageError: null });
    if (get().albums[id]) return;
    window.chud.youtube.album(id).then(
      (page) => set({ albums: { ...get().albums, [id]: page } }),
      (e) => set({ pageError: message(e) }),
    );
  },

  openArtist(id) {
    useTabs.getState().openSection('youtube');
    set({ stack: [...get().stack, { kind: 'artist', id }], pageError: null });
    if (get().artists[id]) return;
    window.chud.youtube.artist(id).then(
      (page) => set({ artists: { ...get().artists, [id]: page } }),
      (e) => set({ pageError: message(e) }),
    );
  },

  openLink(text) {
    const link = parseMusicLink(text);
    if (!link) return false;
    useTabs.getState().openSection('youtube');
    if (link.provider === 'youtube' && link.kind === 'album') return get().openAlbum(link.id), true;
    if (link.provider === 'youtube' && link.kind === 'artist') return get().openArtist(link.id), true;
    const id = `${link.provider}:${link.kind}:${link.id}`;
    set({ stack: [...get().stack.filter((v) => !(v.kind === 'link' && v.id === id)), { kind: 'link', id }], pageError: null });
    const known = get().links[id];
    if (known && !known.error) return true; // already read (or being read): shown as it is
    const patch = (p: Partial<LinkImport>) => set({ links: { ...get().links, [id]: { ...get().links[id]!, ...p } } });
    set({ links: { ...get().links, [id]: { url: text.trim(), data: null, error: null, matches: [] } } });
    window.chud.youtube.link(link).then(
      (data) => {
        if (data.kind === 'artist' && data.artistId) {
          // a Spotify artist: its YouTube Music page takes the link's place
          set({ stack: get().stack.filter((v) => !(v.kind === 'link' && v.id === id)) });
          get().openArtist(data.artistId);
          return;
        }
        patch({ data, matches: data.tracks ?? data.wanted!.map(() => undefined) });
        if (data.wanted) void matchAll(id, data.wanted);
      },
      (e) => patch({ error: message(e) }),
    );
    return true;
  },

  async findArtist(name) {
    useTabs.getState().openSection('youtube');
    try {
      const id = await window.chud.youtube.findArtist(name);
      if (id) return get().openArtist(id);
    } catch {
      /* offline: the search below says so */
    }
    void get().search(name, 'artist');
  },

  back() {
    const stack = get().stack;
    if (stack.length > 1) set({ stack: stack.slice(0, -1), pageError: null });
  },
}));

/** Looks the wanted tracks up on YouTube Music, 4 at a time, filling the list as they come. */
async function matchAll(id: string, wanted: WantedTrack[]): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const i = next++;
      const found = await window.chud.youtube.match(wanted[i]!).catch(() => null);
      const s = useYouTube.getState();
      const entry = s.links[id];
      if (!entry) return;
      const matches = [...entry.matches];
      matches[i] = found;
      useYouTube.setState({ links: { ...s.links, [id]: { ...entry, matches } } });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/** YouTube Music's native "Start radio" for this track, in its own tab, played from the seed. */
/**
 * "Start mix (Online)" on a local file: the same song is looked up on YouTube Music (title,
 * artist, duration: the matcher used for pasted links) and its mix starts, as for a YouTube track.
 */
export async function startMixOnline(track: Track): Promise<void> {
  const artists = (track.artist ?? '').split(/\s*(?:,|;|&|\bfeat\.?|\bft\.?)\s*/i).filter(Boolean);
  toast({ title: tr('mix.searching'), body: [track.title, track.artist].filter(Boolean).join(' — ') });
  const found = await window.chud.youtube.match({ title: track.title, artists, durationSec: track.durationSec ?? null }).catch(() => null);
  if (!found?.videoId) {
    toast({ kind: 'error', title: tr('mix.notFound'), body: track.title });
    return;
  }
  await startMix(found);
}

export async function startMix(seed: Track): Promise<void> {
  if (!seed.videoId) return;
  try {
    const mix = await window.chud.youtube.mix(seed.videoId);
    if (!mix.tracks.length) throw new Error(tr('yt.mixEmpty'));
    const tabId = useTabs.getState().openMix(seed, mix.tracks);
    usePlayer.getState().playFrom(tabId, tr('mix.title', { title: seed.title }), mix.tracks, 0);
  } catch (e) {
    toast({ kind: 'error', title: tr('yt.mixUnavailable'), body: message(e) });
  }
}

/**
 * A YouTube / YouTube Music / Spotify link pasted into an empty playlist: its tracks, found on
 * YouTube Music (Spotify ones through the same matcher as pasted links), are added in order.
 * `progress` follows the matching; resolves with how many were added and how many were not found.
 */
export async function importLinkIntoPlaylist(playlistId: number, text: string, progress: (done: number, total: number) => void): Promise<{ added: number; missed: number; title: string }> {
  const link = parseMusicLink(text);
  if (!link || link.kind === 'artist') throw new Error(tr('pl.linkUnsupported'));
  let title: string;
  let found: (Track | null)[];
  if (link.provider === 'youtube' && link.kind === 'album') {
    const page = await window.chud.youtube.album(link.id);
    title = page.title;
    found = page.tracks;
  } else {
    const data = await window.chud.youtube.link(link);
    title = data.title;
    if (data.tracks) found = data.tracks;
    else {
      const wanted = data.wanted ?? [];
      found = new Array<Track | null>(wanted.length).fill(null);
      let next = 0;
      let done = 0;
      progress(0, wanted.length);
      const worker = async () => {
        while (next < wanted.length) {
          const i = next++;
          found[i] = await window.chud.youtube.match(wanted[i]!).catch(() => null);
          progress(++done, wanted.length);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    }
  }
  const tracks = found.filter((t): t is Track => !!t?.videoId);
  if (tracks.length) await window.chud.playlists.addTracks(playlistId, tracks);
  return { added: tracks.length, missed: found.length - tracks.length, title };
}
