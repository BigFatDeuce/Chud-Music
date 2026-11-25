import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { writeFileAtomic } from './atomic-write';
import { guessFromFilename, localIdOf } from '@shared/filenames';
import { basename, extname, join, resolve } from 'node:path';

// Tag reading shared by the main process (files opened individually) and the library
// scanner worker. No Electron imports here: this module also runs in a worker thread.

export interface FileMeta {
  path: string;
  size: number;
  mtimeMs: number;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  durationSec: number | null;
  codec: string | null;
  /** File name of the extracted cover in the covers cache (content-addressed). */
  coverName: string | null;
  /** Tags could not be read: values come from the file name. */
  untagged: boolean;
}

/** Track ids are case-insensitive on Windows, like its file system. */
export function localId(path: string): string {
  return localIdOf(resolve(path), process.platform);
}

export { guessFromFilename };

let mm: typeof import('music-metadata') | null = null;

export async function readFileMeta(path: string, coversDir: string): Promise<FileMeta> {
  mm ??= await import('music-metadata');
  const st = await stat(path); // async: a slow network share must not freeze the app
  const guess = guessFromFilename(path);
  const base: FileMeta = {
    path, size: st.size, mtimeMs: Math.round(st.mtimeMs), title: guess.title, artist: guess.artist, album: null, albumArtist: null,
    trackNo: null, discNo: null, year: null, genre: null, durationSec: null, codec: null, coverName: null, untagged: true,
  };
  try {
    // Without `duration`, the length comes from the headers (MP3: Xing/VBRI frame count, or the
    // bit rate): asking for it made music-metadata read MP3 files without such a header from end
    // to end (a whole file over the network for each). Only when the headers give none (some
    // Ogg/Opus) is the precise reading done.
    let m = await mm.parseFile(path, { duration: false });
    if (m.format.duration == null) m = await mm.parseFile(path, { duration: true });
    const c = m.common;
    let coverName: string | null = null;
    const pic = c.picture?.[0];
    if (pic) {
      // Content-addressed: every track of an album shares one cover file.
      coverName = `${createHash('sha1').update(pic.data).digest('hex').slice(0, 24)}.${pic.format.includes('png') ? 'png' : 'jpg'}`;
      const out = join(coversDir, coverName);
      if (!(await stat(out).then(() => true, () => false))) await writeFileAtomic(out, pic.data);
    }
    return {
      ...base,
      title: c.title?.trim() || guess.title,
      artist: c.artist?.trim() || c.albumartist?.trim() || guess.artist,
      album: c.album?.trim() || null,
      albumArtist: c.albumartist?.trim() || null,
      trackNo: c.track?.no ?? null,
      discNo: c.disk?.no ?? null,
      year: c.year ?? null,
      genre: c.genre?.[0]?.trim() || null,
      durationSec: m.format.duration ?? null,
      codec: m.format.codec ?? null,
      coverName,
      untagged: false,
    };
  } catch {
    return base; // unreadable tags are not fatal: playback decides whether the file is usable
  }
}
