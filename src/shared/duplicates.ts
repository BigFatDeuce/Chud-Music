// "Find duplicates…" of a playlist: which entries repeat another one, and which copy stays.
// Nothing is imported: tests/unit/duplicates.mjs loads this file as it is, without the app.
//
// Two entries are the same song when they are the same track, or have the same title and artist
// (accents and case aside) and known durations within 3 s — the same song on several albums of an
// artist, the local file and its YouTube Music twin… Copies form a group only when all of their
// durations lie within 3 s (no chain of near durations), and a track of unknown duration is only
// the duplicate of itself. Only playlist entries are taken out, after asking; never a file.
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
  const order = new Map<T, number>();
  const out: T[] = [];
  // 1. the same track again is always a duplicate, even when its entries carry different titles
  //    or artists (an entry saved before its tags changed…): its first entry stands for it
  const seen = new Set<string>();
  // the first entry of each track, by title + artist + kind, in playlist order
  const songs = new Map<string, T[]>();
  tracks.forEach((t, i) => {
    order.set(t, i);
    if (seen.has(t.id)) return void out.push(t);
    seen.add(t.id);
    const key = `${fold(t.title)}\u0000${fold(t.artist ?? '')}\u0000${isVideoFile(t) ? 'video' : 'audio'}`;
    songs.set(key, [...(songs.get(key) ?? []), t]);
  });
  const known = (t: T) => typeof t.durationSec === 'number' && Number.isFinite(t.durationSec) && t.durationSec > 0;
  for (const firsts of songs.values()) {
    // 2. different tracks are copies of one song only when ALL their durations lie within 3 s:
    //    sorted by duration, each group spans 3 s from its shortest track, so 180, 183 and 186 s
    //    are not chained into one song, and the playlist order changes nothing. A track whose
    //    duration is unknown is told apart from every other one (it cannot be checked).
    const timed = firsts.filter(known).sort((a, b) => a.durationSec! - b.durationSec! || order.get(a)! - order.get(b)!);
    const groups: T[][] = [];
    for (const t of timed) {
      const g = groups[groups.length - 1];
      if (g && t.durationSec! - g[0]!.durationSec! <= 3) g.push(t);
      else groups.push([t]);
    }
    for (const copies of groups) {
      if (copies.length < 2) continue;
      // the best copy stays; with the same quality, the first one in the playlist
      const keep = [...copies].sort((a, b) => qualityRank(b) - qualityRank(a) || order.get(a)! - order.get(b)!)[0]!;
      for (const c of copies) if (c !== keep) out.push(c); // its other entries are already out (1.)
    }
  }
  return out.sort((a, b) => order.get(a)! - order.get(b)!);
}
