import { create } from 'zustand';
import type { Track } from '@shared/types';
import type { Sort } from '@/components/TrackList';
import { albumKey } from '@/lib/album';
import { useLibrary } from './library';
import { useTabs } from './tabs';

// The Library page's view (tracks / albums / artists, search, sort, drill-down). It survives tab
// switches, not restarts: it is navigation, not data. Kept here so an artist or album name
// clicked anywhere (playlists, Home, player bar…) can open the Library on it.

export type LibView = 'tracks' | 'albums' | 'artists';
export type Quick = 'all' | 'recent-added' | 'recent-played';
export type Drill = { kind: 'album'; key: string; label: string } | { kind: 'artist'; key: string; label: string } | null;

export const useLibView = create<{ view: LibView; query: string; sort: Sort | null; quick: Quick; drill: Drill }>(() => ({
  view: 'tracks', query: '', sort: null, quick: 'all', drill: null,
}));

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
export const artistKey = (t: Track) => fold(t.artist ?? '');

let ids: Set<string> | null = null;
let idsOf: Track[] | null = null;
/** Whether a local file is in the library (only those can be opened there). */
export function inLibrary(t: Track): boolean {
  const all = useLibrary.getState().tracks;
  if (idsOf !== all) {
    ids = new Set(all.map((x) => x.id));
    idsOf = all;
  }
  return ids!.has(t.id);
}

/** Opens the Library on this track's artist or album (all filters cleared). */
export function openInLibrary(kind: 'artist' | 'album', t: Track): void {
  const drill: Drill = kind === 'album' ? { kind, key: albumKey(t), label: t.album ?? '' } : { kind, key: artistKey(t), label: t.artist ?? '' };
  useLibView.setState({ view: 'tracks', query: '', quick: 'all', sort: null, drill });
  useTabs.getState().openSection('library');
}
