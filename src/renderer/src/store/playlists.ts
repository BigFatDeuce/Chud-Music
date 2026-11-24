import { create } from 'zustand';
import type { PlaylistDetail, PlaylistSummary, Track } from '@shared/types';
import { toast } from './toasts';
import { tr } from '@shared/i18n';

interface PlaylistsState {
  list: PlaylistSummary[];
  details: Record<number, PlaylistDetail>;
  loadList(): Promise<void>;
  loadDetail(id: number): Promise<PlaylistDetail | null>;
  create(name: string, tracks?: Track[]): Promise<number>;
  addTracks(id: number, tracks: Track[], index?: number): Promise<void>;
}

export const usePlaylists = create<PlaylistsState>((set, get) => ({
  list: [],
  details: {},
  async loadList() {
    set({ list: await window.chud.playlists.list() });
  },
  async loadDetail(id) {
    const d = await window.chud.playlists.get(id);
    const details = { ...get().details };
    if (d) details[id] = d;
    else delete details[id];
    set({ details });
    return d;
  },
  async create(name, tracks) {
    const id = await window.chud.playlists.create(name, tracks);
    await get().loadList();
    return id;
  },
  async addTracks(id, tracks, index) {
    if (!tracks.length) return;
    if (get().list.find((p) => p.id === id)?.smart) {
      toast({ kind: 'error', title: tr('smart.noAdd'), body: tr('smart.noAddBody') });
      return;
    }
    await window.chud.playlists.addTracks(id, tracks, index);
    const name = get().list.find((p) => p.id === id)?.name ?? tr('common.playlist');
    toast({ title: tr('pl.addedTo', { name }), body: tr('n.tracks', { n: tracks.length }) });
  },
}));

const listeners = new Set<(id: number | null) => void>();
/** Lets other stores react to playlist edits (e.g. the player refreshing its context). */
export function onPlaylistChanged(cb: (id: number | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

window.chud.playlists.onChanged(async (id) => {
  const s = usePlaylists.getState();
  await s.loadList();
  if (id != null && s.details[id]) await s.loadDetail(id); // refreshed, or dropped if deleted
  for (const l of listeners) l(id);
});
