import type { Track } from '@shared/types';

// What makes an album, for local files. Tags alone are not enough: two albums can share a name
// (and even an artist: an original and a remaster, a rip from another source…). Playing "the
// album" then interleaved them (track 1 of one, track 1 of the other…), so the next track jumped
// to the other album. The folder settles it: tracks of one album sit in one folder. A folder
// named "CD1", "Disc 2", "Disk 3"… counts as its parent, so a multi-disc album stays one album.

const strip = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** Artists and albums come back for each of their tracks: folded once. */
const foldedOf = new Map<string, string>();
function fold(s: string): string {
  let f = foldedOf.get(s);
  if (f === undefined) {
    f = strip(s);
    if (foldedOf.size > 100_000) foldedOf.clear();
    foldedOf.set(s, f);
  }
  return f;
}
const DISC_DIR = /^(cd|dis[ck]|disque|volume|vol\.?)\s*\d+$/i;

/** Folder of a file → what albumFolder says of it (worked out once: sorting asks very often). */
const folders = new Map<string, string>();

/** The folder an album lives in ('' for a track without path: YouTube, radio). */
export function albumFolder(t: Track): string {
  if (!t.path) return '';
  const dir = t.path.slice(0, Math.max(t.path.lastIndexOf('/'), t.path.lastIndexOf('\\')));
  let f = folders.get(dir);
  if (f === undefined) {
    f = folderOf(t.path);
    if (folders.size > 50_000) folders.clear();
    folders.set(dir, f);
  }
  return f;
}

function folderOf(path: string): string {
  const parts = path.split(/[\\/]+/);
  parts.pop(); // file name
  while (parts.length > 1 && DISC_DIR.test(parts[parts.length - 1]!.trim())) parts.pop();
  return fold(parts.join('/'));
}

/** Album identity: album artist (else artist), album title, and its folder. */
export const albumKey = (t: Track): string => `${fold(t.albumArtist ?? t.artist ?? '')}|${fold(t.album ?? '')}|${albumFolder(t)}`;

/** Album order that never mixes two albums of the same name: title, artist, folder, then disc and track. */
export function albumOrder(cmp: (a: string | null | undefined, b: string | null | undefined) => number) {
  return (a: Track, b: Track): number =>
    cmp(a.album, b.album) ||
    cmp(a.albumArtist ?? a.artist, b.albumArtist ?? b.artist) ||
    (albumFolder(a) < albumFolder(b) ? -1 : albumFolder(a) > albumFolder(b) ? 1 : 0) ||
    (a.discNo ?? 1) - (b.discNo ?? 1) ||
    (a.trackNo ?? 0) - (b.trackNo ?? 0) ||
    cmp(a.title, b.title);
}
