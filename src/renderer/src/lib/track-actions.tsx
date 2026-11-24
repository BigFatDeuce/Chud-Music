import { Clapperboard, ArrowDown, ArrowUp, Disc3, ExternalLink, EyeOff, FolderOpen, ImageOff, ListEnd, ListMusic, ListPlus, ListStart, Play, Plus, Radio, UserRound, X } from 'lucide-react';
import type { Track } from '@shared/types';
import type { MenuItem } from '@/components/ContextMenu';
import { prompt } from '@/components/Dialog';
import { usePlayer } from '@/store/player';
import { usePlaylists } from '@/store/playlists';
import { toast } from '@/store/toasts';
import { startMix, startMixOnline, trackArtist, useYouTube } from '@/store/youtube';
import { mainArtist } from './artist';
import { CLIP_TAB, useTabs } from '@/store/tabs';
import { tr } from '@shared/i18n';

export async function createPlaylistWith(tracks: Track[] = [], suggested = tr('pl.new')): Promise<number | null> {
  const name = await prompt({ title: tr('pl.new'), label: tr('common.name'), initial: suggested, confirm: tr('common.create') });
  if (!name) return null;
  const id = await usePlaylists.getState().create(name, tracks);
  toast({ title: tr('pl.created', { name }), body: tracks.length ? tr('n.tracks', { n: tracks.length }) : undefined });
  return id;
}

export function addToPlaylistItems(tracks: Track[], exclude?: number): MenuItem[] {
  // a smart playlist's tracks come from its rules: nothing can be added to it
  const lists = usePlaylists.getState().list.filter((p) => p.id !== exclude && !p.smart);
  return [
    { label: tr('pl.newEllipsis'), icon: <Plus size={15} />, onSelect: () => void createPlaylistWith(tracks) },
    ...(lists.length ? [{ separator: true } as MenuItem] : []),
    ...lists.map((p) => ({ label: p.name, icon: <ListMusic size={15} />, onSelect: () => void usePlaylists.getState().addTracks(p.id, tracks) })),
  ];
}

interface Opts {
  /** Play these tracks within their list. */
  play?: () => void;
  /** The playlist these tracks are shown in (left out of "Ajouter à une playlist"). */
  excludePlaylist?: number;
  /** Removal from the list they are shown in (playlist, library, tab). Never deletes files. */
  remove?: { label: string; run: () => void };
  /** Reordering in the list they are shown in ("Fichiers ouverts"); undefined = not possible there. */
  move?: { up?: () => void; down?: () => void };
}

/** Plays the track (in its list when `play` is given, else on its own) and shows the video clip tab. */
export function openVideoClip(track: Track, play?: () => void): void {
  const p = usePlayer.getState();
  if (p.current?.id !== track.id) (play ?? (() => p.playFrom(CLIP_TAB, track.title, [track], 0)))();
  useTabs.getState().openClip();
}

/** Right-click on the cover of what is playing: its folder, its artist, the clip tab. */
export function nowPlayingMenu(track: Track): MenuItem[] {
  const items: MenuItem[] = [];
  if (track.source === 'radio') return items;
  items.push({ label: tr('menu.openClip'), icon: <Clapperboard size={15} />, onSelect: () => useTabs.getState().openClip() });
  if (track.source === 'youtube') {
    if (track.ytArtistId) items.push({ label: tr('menu.goArtist'), icon: <UserRound size={15} />, onSelect: () => useYouTube.getState().openArtist(track.ytArtistId!) });
    if (track.ytAlbumId) items.push({ label: tr('menu.goAlbum'), icon: <Disc3 size={15} />, onSelect: () => useYouTube.getState().openAlbum(track.ytAlbumId!) });
    if (track.videoId) items.push({ label: tr('menu.openYtm'), icon: <ExternalLink size={15} />, onSelect: () => window.chud.youtube.openExternal(track.videoId!) });
    const who = trackArtist(track);
    if (who) items.push({ label: tr('hide.artist', { name: who.name }), icon: <EyeOff size={15} />, onSelect: () => void useYouTube.getState().hideArtist(who) });
    return items;
  }
  const artist = mainArtist(track);
  if (artist) items.push({ label: tr('menu.findArtistYtm'), icon: <UserRound size={15} />, onSelect: () => void useYouTube.getState().findArtist(artist) });
  if (track.path) items.push({ label: tr('menu.showInFolder'), icon: <FolderOpen size={15} />, onSelect: () => window.chud.shell.showInFolder(track.path!) });
  return items;
}

const FOUND_COVER = `chud-media://cover/${encodeURIComponent('found/')}`;

export function trackMenu(tracks: Track[], opts: Opts = {}): MenuItem[] {
  const p = usePlayer.getState();
  const n = tracks.length;
  const single = n === 1 ? tracks[0]! : null;
  const items: MenuItem[] = [];
  if (opts.play) items.push({ label: n > 1 ? tr('menu.playN', { n }) : tr('common.play'), icon: <Play size={15} />, onSelect: opts.play, hint: tr('menu.doubleClick') });
  if (tracks.some((t) => t.source === 'radio')) return items; // live stations: nothing to queue or save
  items.push(
    { label: tr('menu.playNext'), icon: <ListStart size={15} />, onSelect: () => { p.playNext(tracks); toast({ title: tr('menu.playNextDone'), body: tr('n.tracks', { n }) }); } },
    { label: tr('menu.enqueue'), icon: <ListEnd size={15} />, onSelect: () => { p.enqueue(tracks); toast({ title: tr('menu.enqueued'), body: tr('n.tracks', { n }) }); } },
    { label: tr('menu.addToPlaylist'), icon: <ListPlus size={15} />, submenu: addToPlaylistItems(tracks, opts.excludePlaylist) },
  );
  if (opts.move) {
    items.push(
      { separator: true },
      { label: tr('menu.moveUp'), icon: <ArrowUp size={15} />, hint: 'Alt+↑', disabled: !opts.move.up, onSelect: opts.move.up },
      { label: tr('menu.moveDown'), icon: <ArrowDown size={15} />, hint: 'Alt+↓', disabled: !opts.move.down, onSelect: opts.move.down },
    );
  }
  if (opts.remove) {
    items.push({ separator: true }, { label: opts.remove.label, icon: <X size={15} />, danger: true, hint: tr('key.del'), onSelect: opts.remove.run });
  }
  if (single?.source === 'youtube' && single.videoId) {
    items.push({ separator: true }, { label: tr('menu.startMix'), icon: <Radio size={15} />, onSelect: () => void startMix(single) });
    if (single.ytArtistId) items.push({ label: tr('menu.goArtist'), icon: <UserRound size={15} />, onSelect: () => useYouTube.getState().openArtist(single.ytArtistId!) });
    if (single.ytAlbumId) items.push({ label: tr('menu.goAlbum'), icon: <Disc3 size={15} />, onSelect: () => useYouTube.getState().openAlbum(single.ytAlbumId!) });
    items.push({ label: tr('menu.openClip'), icon: <Clapperboard size={15} />, onSelect: () => openVideoClip(single, opts.play) });
    items.push({ label: tr('menu.openYtm'), icon: <ExternalLink size={15} />, onSelect: () => window.chud.youtube.openExternal(single.videoId!) });
    const who = trackArtist(single);
    if (who) items.push({ label: tr('hide.artist', { name: who.name }), icon: <EyeOff size={15} />, onSelect: () => void useYouTube.getState().hideArtist(who) });
  }
  const artist = single && single.source !== 'youtube' ? mainArtist(single) : null;
  if (single?.source === 'local')
    items.push(
      { separator: true },
      { label: tr('menu.startMixOnline'), icon: <Radio size={15} />, onSelect: () => void startMixOnline(single) },
      { label: tr('menu.openClip'), icon: <Clapperboard size={15} />, onSelect: () => openVideoClip(single, opts.play) },
    );
  if (artist) items.push({ label: tr('menu.findArtistYtm'), icon: <UserRound size={15} />, onSelect: () => void useYouTube.getState().findArtist(artist) });
  if (single?.source === 'local' && single.path) {
    items.push({ label: tr('menu.showInFolder'), icon: <FolderOpen size={15} />, onSelect: () => window.chud.shell.showInFolder(single.path!) });
  }
  // covers found online by Chud Music (Library › … › Find missing covers), not the files' own
  const found = tracks.filter((t) => t.source === 'local' && t.coverUrl?.startsWith(FOUND_COVER));
  if (found.length) {
    items.push({ separator: true }, {
      label: tr('cov.removeSome', { n: found.length }),
      icon: <ImageOff size={15} />,
      onSelect: () => void window.chud.library.removeFoundCoverOf(found.map((t) => t.id)).then((k) => k && toast({ title: tr('cov.removedSome', { n: k }), body: tr('cov.removedSomeBody') })),
    });
  }
  return items;
}
