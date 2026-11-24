// "Find duplicates…" of a playlist: which entries repeat another one, and which copy stays.
// Nothing is imported: tests/unit/duplicates.mjs loads this file as it is, without the app.
//
// Two entries are the same song when they are the same track, or have the same title and artist
// (accents and case aside) and durations within 3 s — the same song on several albums of an
// artist, the local file and its YouTube Music twin…
//
// Of the copies of a song, the BEST one stays (not the first one found):
//   1. a lossless file (FLAC, ALAC, WAV, AIFF, WavPack, APE, TTA, DSD)
//   2. any other file — the higher bit rate first (a 320 kbit/s MP3 before a 128 kbit/s one)
//   3. the YouTube Music track (needs the network, lower bit rate)
// and with the same quality, the first of them in the playlist.
//
// A video file (mp4, webm…) is never the duplicate of a piece of music with the same title: it
// is only compared with other videos, and the better one (higher bit rate) stays.

export interface DupTrack {
  id: string;
  source: string;
  title: string;
  artist: string | null;
  durationSec: number | null;
  /** Local only. */
  path?: string;
  codec?: string | null;
  /** Local only: average bit rate of the whole file, in kbit/s (size / duration). */
  bitrateKbps?: number | null;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
const ext = (path: string | undefined) => (path ?? '').split('.').pop()?.toLowerCase() ?? '';

const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi']);
const LOSSLESS_EXT = new Set(['flac', 'wav', 'aiff', 'aif', 'aifc', 'alac', 'wv', 'ape', 'tta', 'dsf']);
const LOSSLESS_CODEC = /^(flac|alac|pcm|wavpack|monkey|tta|dsd|aiff)|lossless/i;

/** A local video file (by its extension: a picture track is not read from the file). */
export function isVideoFile(t: DupTrack): boolean {
  return t.source === 'local' && VIDEO_EXT.has(ext(t.path));
}

export function isLossless(t: DupTrack): boolean {
  return t.source === 'local' && !isVideoFile(t) && (LOSSLESS_EXT.has(ext(t.path)) || LOSSLESS_CODEC.test(t.codec ?? ''));
}

/** Higher is better; only compared between copies of the same song, of the same kind. */
export function qualityRank(t: DupTrack): number {
  const rate = Math.max(0, Math.min(99_999, Math.round(t.bitrateKbps ?? 0)));
  if (t.source !== 'local') return 0;
  return (isLossless(t) ? 200_000 : 100_000) + rate;
}

/**
 * The entries to take out, in playlist order: every copy of a song but the best one.
 * The same track twice is a duplicate whatever its durations.
 */
export function duplicateEntries<T extends DupTrack>(tracks: T[]): T[] {
  // songs met so far, by title + artist + kind: each is the list of its copies
  const songs = new Map<string, T[][]>();
  const order = new Map<T, number>();
  tracks.forEach((t, i) => {
    order.set(t, i);
    const key = `${fold(t.title)}\u0000${fold(t.artist ?? '')}\u0000${isVideoFile(t) ? 'video' : 'audio'}`;
    const list = songs.get(key) ?? [];
    if (!songs.has(key)) songs.set(key, list);
    const copies = list.find((c) => c.some((o) => o.id === t.id || !o.durationSec || !t.durationSec || Math.abs(o.durationSec - t.durationSec) <= 3));
    if (copies) copies.push(t);
    else list.push([t]);
  });
  const out: T[] = [];
  for (const list of songs.values()) {
    for (const copies of list) {
      if (copies.length < 2) continue;
      // the best copy stays; with the same quality, the first one (the sort is stable)
      const keep = [...copies].sort((a, b) => qualityRank(b) - qualityRank(a))[0]!;
      out.push(...copies.filter((c) => c !== keep));
    }
  }
  return out.sort((a, b) => order.get(a)! - order.get(b)!);
}
