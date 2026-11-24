import { access } from 'node:fs/promises';
import type { Track } from '@shared/types';
import { getDb, sql } from './db';
import { localId, type FileMeta } from './metadata';
import { foundCoverRef } from './covers';
import { allowPath, coverUrl } from './protocol';
import { tr } from '@shared/i18n';

// Track rows ⇄ Track objects. A local track is identified by its path, a YouTube track by
// its video id; the CHECK constraint in the schema forbids mixing the two.

export interface TrackRow {
  id: string;
  source: 'local' | 'youtube';
  path: string | null;
  file_size: number | null;
  mtime_ms: number | null;
  yt_video_id: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  duration_sec: number | null;
  codec: string | null;
  cover_ref: string | null;
  available: number;
  added_at: number;
  last_played_at: number | null;
  play_count: number;
  in_library: number;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
  genre: string | null;
}

export const TRACK_COLUMNS =
  'id, source, path, file_size, mtime_ms, yt_video_id, title, artist, album, album_artist, duration_sec, codec, cover_ref, available, added_at, last_played_at, play_count, in_library, track_no, disc_no, year, genre';

/**
 * Marks local files that no longer exist (playlists, history), without blocking: checks run
 * asynchronously, 4 at a time, and whatever is not answered within the budget (a slow or
 * unreachable network share) is left as it was rather than holding the list back.
 */
export async function checkFiles<T extends Track>(tracks: T[], budgetMs = 1500): Promise<T[]> {
  const out = [...tracks];
  const todo = out.map((t, i) => ({ t, i })).filter(({ t }) => t.source === 'local' && t.path && t.available);
  let next = 0;
  const work = Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
    while (next < todo.length) {
      const { t, i } = todo[next++]!;
      if (!(await access(t.path!).then(() => true, () => false))) out[i] = { ...t, available: false, problem: tr('main.fileMissing') };
    }
  }));
  await Promise.race([work, new Promise((r) => setTimeout(r, budgetMs))]);
  return out;
}

/** Average bit rate of a file (kbit/s) from its size and duration: "Find duplicates" keeps the best copy. */
const bitrateOf = (r: TrackRow): number | null => (r.file_size && r.duration_sec && r.duration_sec > 1 ? Math.round((r.file_size * 8) / r.duration_sec / 1000) : null);

export function rowToTrack(r: TrackRow): Track {
  const available = r.available === 1;
  if (r.source === 'local' && r.path && available) allowPath(r.path);
  // a local file without its own cover may have one found online (covers.ts)
  const ref = r.cover_ref ?? (r.source === 'local' ? foundCoverRef(r.id) : undefined);
  const cover = ref ? (r.source === 'local' ? coverUrl(ref) : ref) : null;
  return {
    id: r.id,
    source: r.source,
    title: r.title,
    artist: r.artist,
    album: r.album,
    albumArtist: r.album_artist,
    durationSec: r.duration_sec,
    coverUrl: cover,
    ...(r.source === 'local' ? { path: r.path!, codec: r.codec, bitrateKbps: bitrateOf(r) } : { videoId: r.yt_video_id! }),
    available,
    ...(available ? {} : { problem: r.source === 'local' ? tr('main.fileMissing') : tr('main.ytUnavailable') }),
    trackNo: r.track_no,
    discNo: r.disc_no,
    year: r.year,
    genre: r.genre,
    addedAt: r.added_at,
    playCount: r.play_count,
    lastPlayedAt: r.last_played_at,
  };
}

export function metaToTrack(m: FileMeta): Track {
  return {
    id: localId(m.path),
    source: 'local',
    path: m.path,
    title: m.title,
    artist: m.artist,
    album: m.album,
    albumArtist: m.albumArtist,
    durationSec: m.durationSec,
    codec: m.codec,
    coverUrl: m.coverName ? coverUrl(m.coverName) : null,
    available: true,
    trackNo: m.trackNo,
    discNo: m.discNo,
    year: m.year,
    genre: m.genre,
  };
}

/** Library scanner result → row (insert, or refresh tags of an existing row). */
export function upsertFromMeta(m: FileMeta, inLibrary: boolean, now: number): void {
  sql(
      `INSERT INTO tracks (id, source, path, file_size, mtime_ms, title, artist, album, album_artist, duration_sec, codec, cover_ref,
                           available, added_at, in_library, track_no, disc_no, year, genre)
       VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path = excluded.path, file_size = excluded.file_size, mtime_ms = excluded.mtime_ms, title = excluded.title,
         artist = excluded.artist, album = excluded.album, album_artist = excluded.album_artist, duration_sec = excluded.duration_sec,
         codec = excluded.codec, cover_ref = excluded.cover_ref, available = 1, track_no = excluded.track_no,
         disc_no = excluded.disc_no, year = excluded.year, genre = excluded.genre,
         in_library = MAX(tracks.in_library, excluded.in_library)`,
    )
    .run(localId(m.path), m.path, m.size, m.mtimeMs, m.title, m.artist, m.album, m.albumArtist, m.durationSec, m.codec, m.coverName,
      now, inLibrary ? 1 : 0, m.trackNo, m.discNo, m.year, m.genre);
}

/**
 * Makes sure a track referenced by a playlist or the history has a row. Library rows are
 * authoritative and never overwritten; a YouTube track is never stored with a path.
 */
export function ensureTrackRow(t: Track, now: number): string {
  if (t.source === 'youtube') {
    if (!t.videoId) throw new Error('YouTube track without id');
    const id = `yt:${t.videoId}`;
    sql(
        `INSERT INTO tracks (id, source, yt_video_id, title, artist, album, duration_sec, cover_ref, available, added_at)
         VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, t.videoId, t.title, t.artist, t.album, t.durationSec, t.coverUrl, now);
    return id;
  }
  if (!t.path) throw new Error('local track without path');
  const id = localId(t.path);
  const coverName = t.coverUrl ? decodeURIComponent(t.coverUrl.split('/').pop() ?? '') || null : null;
  sql(
      `INSERT INTO tracks (id, source, path, title, artist, album, album_artist, duration_sec, codec, cover_ref, available, added_at,
                           track_no, disc_no, year, genre)
       VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, t.path, t.title, t.artist, t.album, t.albumArtist ?? null, t.durationSec, t.codec ?? null, coverName, now,
      t.trackNo ?? null, t.discNo ?? null, t.year ?? null, t.genre ?? null);
  return id;
}
