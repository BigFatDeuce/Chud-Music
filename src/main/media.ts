import { createHash } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { access, readdir, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { PlayableSource, Track } from '@shared/types';
import { needsTranscode } from '@shared/audio-formats';
import { cacheDir } from './paths';
import { ffmpegPath } from './ffmpeg';
import { testOffline } from './netpath';
import { guessFromFilename, localId, readFileMeta } from './metadata';
import { allowPath, fileUrl } from './protocol';
import { metaToTrack } from './tracks';
import { tr } from '@shared/i18n';

// Files opened individually, and the FFmpeg fallback for codecs Chromium cannot decode
// (ALAC, WMA, AIFF, WavPack, AC3… — see prototype P1).

async function keyFor(path: string): Promise<string> {
  const st = await stat(path);
  return createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
}

const exists = (p: string) => (testOffline(p) ? Promise.resolve(false) : access(p).then(() => true, () => false));
/** Tests only: simulates slow storage (a network share) for files opened individually. */
const SLOW_IO_MS = Number(process.env.CHUD_SLOW_IO_MS) || 0;

export async function probe(paths: string[]): Promise<Track[]> {
  const covers = cacheDir('covers');
  const one = async (path: string): Promise<Track> => {
    if (SLOW_IO_MS) await new Promise((r) => setTimeout(r, SLOW_IO_MS));
    if (!(await exists(path))) {
      const g = guessFromFilename(path);
      return { id: localId(path), source: 'local', path, title: g.title, artist: g.artist, album: null, durationSec: null, coverUrl: null, codec: null, available: false, problem: tr('main.fileMissing') };
    }
    allowPath(path);
    return metaToTrack(await readFileMeta(path, covers));
  };
  // bounded concurrency: a dropped folder of thousands of files must not exhaust file handles,
  // and a hung network share must not take every I/O thread
  const out: Track[] = new Array(paths.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
    while (next < paths.length) {
      const i = next++;
      out[i] = await one(paths[i]!);
    }
  }));
  return out;
}

const inflight = new Map<string, Promise<string>>();

/** Converted files are kept for the next time, the last used first, within this size. */
const TRANSCODE_MAX = 3 * 1024 ** 3;
async function trim(keep: string): Promise<void> {
  const dir = cacheDir('transcode');
  try {
    const files = await Promise.all(
      (await readdir(dir)).filter((f) => f.endsWith('.flac')).map(async (f) => ({ path: join(dir, f), st: await stat(join(dir, f)) })),
    );
    let total = 0;
    for (const f of files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)) {
      total += f.st.size;
      // (one being played is in use: Windows refuses, and it goes the next time)
      if (total > TRANSCODE_MAX && f.path !== keep && Date.now() - f.st.mtimeMs > 3_600_000) await unlink(f.path).catch(() => {});
    }
  } catch {
    /* the cache folder is not readable: nothing to trim */
  }
}

async function transcode(path: string): Promise<string> {
  const out = join(cacheDir('transcode'), `${await keyFor(path)}.flac`);
  if (existsSync(out)) {
    void utimes(out, new Date(), new Date()).catch(() => {}); // used last: kept longest
    return out;
  }
  const running = inflight.get(out);
  if (running) return running;
  const tmp = `${out}.part`;
  const p = new Promise<string>((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', '-map_metadata', '-1', '-c:a', 'flac', '-f', 'flac', tmp], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? tr('main.noFfmpeg') : e.message)));
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          renameSync(tmp, out);
          resolve(out);
          void trim(out);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      } else reject(new Error(err.trim().split('\n').pop() || tr('main.unreadable')));
    });
  }).finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}

/** Tests only: makes preparing a file for playback slow (as a long FFmpeg conversion is). */
const SLOW_RESOLVE_MS = Number(process.env.CHUD_SLOW_RESOLVE_MS) || 0;

export async function resolvePlayable(path: string, codec: string | null | undefined, force = false): Promise<PlayableSource> {
  if (SLOW_RESOLVE_MS) await new Promise((r) => setTimeout(r, SLOW_RESOLVE_MS));
  if (!(await exists(path))) throw new Error(tr('main.fileMissing'));
  allowPath(path);
  if (!force && !needsTranscode(path, codec)) return { url: fileUrl(path), transcoded: false };
  const out = await transcode(path);
  allowPath(out);
  return { url: fileUrl(out), transcoded: true };
}
