// How two tracks follow each other, and when the sleep timer stops playback. Pure and without
// imports: tests/unit/playback.mjs loads this file as it is.

/** The few fields these decisions look at. */
export interface ChainTrack {
  id: string;
  source: string;
  album: string | null;
  artist: string | null;
  albumArtist?: string | null;
  trackNo?: number | null;
  discNo?: number | null;
  path?: string;
}

const key = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const folder = (p: string | undefined) => (p ?? '').replace(/[\\/][^\\/]*$/, '');

/** Both belong to the same album (same name, and same album artist, or same folder when not said). */
export function sameAlbum(a: ChainTrack, b: ChainTrack): boolean {
  if (!key(a.album) || key(a.album) !== key(b.album) || a.source !== b.source) return false;
  if (key(a.albumArtist) && key(b.albumArtist)) return key(a.albumArtist) === key(b.albumArtist);
  return (!!a.path && folder(a.path) === folder(b.path)) || key(a.artist) === key(b.artist);
}

/** `b` is the track after `a` on their album (the next number, or the first of the next disc). */
export function nextOnAlbum(a: ChainTrack, b: ChainTrack): boolean {
  if (!sameAlbum(a, b) || a.trackNo == null || b.trackNo == null) return false;
  const da = a.discNo ?? 1;
  const db = b.discNo ?? 1;
  return da === db ? b.trackNo === a.trackNo + 1 : db === da + 1 && b.trackNo === 1;
}

/**
 * How `b` follows `a`: a crossfade of that many seconds, 0 = gapless, null = a simple change.
 * Consecutive tracks of an album (live recordings, classical works) are never crossfaded.
 */
export function chainMode(a: ChainTrack, b: ChainTrack, o: { gapless: boolean; crossfadeSec: number }): number | null {
  if (a.source !== 'local' || b.source !== 'local') return null;
  if (o.crossfadeSec > 0 && a.id !== b.id && !nextOnAlbum(a, b)) return o.crossfadeSec;
  return o.gapless ? 0 : null;
}

/** The sleep timer: at a time (ms since epoch), at the end of the track, or of the album. */
export type Sleep = { kind: 'time'; at: number } | { kind: 'track' } | { kind: 'album' };

/** Does playback stop when `current` ends? (`next`: what would play; null: nothing.) */
export function sleepStopsAfter(sleep: Sleep | null, current: ChainTrack | null, next: ChainTrack | null): boolean {
  if (!sleep || sleep.kind === 'time' || !current) return false;
  if (sleep.kind === 'track') return true;
  return !next || next.id === current.id || !sameAlbum(current, next);
}
