import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { parseEbur128, type Loudness } from '@shared/replaygain';
import { sql } from './db';
import { ffmpegPath } from './ffmpeg';
import { localId } from './metadata';
import { log } from './log';

// Volume normalisation: the loudness of local files, from their own ReplayGain tags, else measured
// with FFmpeg (EBU R128). Asked for only while normalisation is on, for the track about to play;
// kept in the database, so a file is read once. The files themselves are never written.
// Also here: the sample rate of a file, for gapless playback (renderer audio/joiner-worklet.js).

interface Row {
  stamp: string;
  track_gain: number | null;
  track_peak: number | null;
  album_gain: number | null;
  album_peak: number | null;
  source: 'tags' | 'measured';
}

const inflight = new Map<string, Promise<Loudness | null>>();

export function loudness(path: string): Promise<Loudness | null> {
  const id = localId(path);
  const running = inflight.get(id);
  if (running) return running;
  const p = find(id, path)
    .catch((e) => {
      log('warn', 'loudness', `${path}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function find(id: string, path: string): Promise<Loudness | null> {
  const st = await stat(path);
  const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  const row = sql('SELECT stamp, track_gain, track_peak, album_gain, album_peak, source FROM loudness WHERE track_id = ?').get(id) as Row | undefined;
  if (row?.stamp === stamp) return { trackGain: row.track_gain, trackPeak: row.track_peak, albumGain: row.album_gain, albumPeak: row.album_peak, source: row.source };
  const l = (await fromTags(path)) ?? (await measure(path));
  sql('INSERT OR REPLACE INTO loudness (track_id, stamp, track_gain, track_peak, album_gain, album_peak, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, stamp, l.trackGain, l.trackPeak, l.albumGain, l.albumPeak, l.source);
  return l;
}

type Ratio = { dB?: number; ratio?: number } | undefined;

async function fromTags(path: string): Promise<Loudness | null> {
  const mm = await import('music-metadata');
  try {
    const { common: c } = await mm.parseFile(path, { duration: false, skipCovers: true });
    const db = (r: Ratio): number | null => (r && Number.isFinite(r.dB) ? r.dB! : null);
    const ratio = (r: Ratio): number | null => (r && Number.isFinite(r.ratio) && r.ratio! > 0 ? r.ratio! : null);
    const trackGain = db(c.replaygain_track_gain as Ratio);
    const albumGain = db(c.replaygain_album_gain as Ratio);
    if (trackGain === null && albumGain === null) return null;
    return { trackGain: trackGain ?? albumGain, trackPeak: ratio(c.replaygain_track_peak as Ratio), albumGain, albumPeak: ratio(c.replaygain_album_peak as Ratio), source: 'tags' };
  } catch {
    return null;
  }
}

const rates = new Map<string, number>();
export async function sampleRate(path: string): Promise<number> {
  const id = localId(path);
  const known = rates.get(id);
  if (known !== undefined) return known;
  let rate = 0;
  try {
    const mm = await import('music-metadata');
    const { format } = await mm.parseFile(path, { duration: false, skipCovers: true });
    // Opus is always decoded at 48 kHz, whatever was recorded
    rate = /opus/i.test(format.codec ?? '') ? 48000 : (format.sampleRate ?? 0);
  } catch {
    /* not known */
  }
  if (rates.size > 500) rates.clear();
  rates.set(id, rate);
  return rate;
}

/** One measure at a time: it reads the whole file. */
let last: Promise<unknown> = Promise.resolve();

function measure(path: string): Promise<Loudness> {
  const run = last.then(
    () =>
      new Promise<Loudness>((resolve, reject) => {
        // the bundled FFmpeg only writes FLAC: written to its output, thrown away
        const proc = spawn(
          ffmpegPath(),
          ['-hide_banner', '-nostats', '-i', path, '-vn', '-map_metadata', '-1', '-af', 'ebur128=peak=sample:framelog=verbose', '-c:a', 'flac', '-compression_level', '0', '-f', 'flac', '-'],
          { windowsHide: true },
        );
        let err = '';
        proc.stdout.resume();
        proc.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `FFmpeg ${code}`));
          const m = parseEbur128(err);
          resolve({ trackGain: m?.gain ?? null, trackPeak: m?.peak ?? null, albumGain: null, albumPeak: null, source: 'measured' });
        });
      }),
  );
  last = run.catch(() => {});
  return run;
}
