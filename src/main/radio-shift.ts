import { app, net } from 'electron';
import { createWriteStream, existsSync, mkdirSync, truncate, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { RadioWindow, RecordResult } from '@shared/types';
import { log } from './log';

// Live radio with time shift and recording.
//
// One upstream connection per station, opened here (not by the player): its audio (ICY metadata
// stripped) is kept in memory for the last WINDOW_SEC seconds. The player reads it through
// chud-media://radio/?u=…&from=<seconds>: from the live edge, or from any moment still in
// memory, then on at the pace of the station — rewinding, or pausing and going on later, is just
// reading from further back. Positions are seconds of audio since the station was tuned in
// (bytes ÷ byte rate), so the burst a server sends on connection does not skew them.
//
// Recording writes the same bytes, untouched (no re-encoding), from the moment the person is
// hearing, into a file of the station's own format (MP3, AAC, Ogg…).

const UA = 'ChudMusic/0.1 (+https://github.com/BigFatDeuce/Chud-Music)';
const WINDOW_SEC = 30 * 60;
const MAX_BYTES = 96 * 1024 * 1024;

interface Chunk {
  /** Byte offset of this chunk in the stream (since tuning in). */
  at: number;
  data: Buffer;
}

interface Recording {
  out: WriteStream;
  path: string;
  /** Stream offset of the first byte recorded. */
  from: number;
  bytes: number;
  startedAt: number;
  /** MP3 / AAC: bytes before the first frame header are skipped, so the file starts cleanly. */
  synced: boolean;
}

/** Writes recorded audio; the first bytes up to a frame header are left out (MP3, AAC ADTS). */
function recWrite(rec: Recording, data: Buffer): void {
  if (!rec.synced) {
    let i = 0;
    while (i < data.length - 1 && !(data[i] === 0xff && (data[i + 1]! & 0xe0) === 0xe0)) i++;
    if (i >= data.length - 1) {
      rec.from += data.length;
      return;
    }
    rec.synced = true;
    rec.from += i;
    data = data.subarray(i);
  }
  rec.out.write(data);
  rec.bytes += data.length;
}

class Session {
  readonly url: string;
  chunks: Chunk[] = [];
  /** Bytes received since tuning in. */
  total = 0;
  /** Bytes per second of audio. */
  rate: number;
  private rateKnown: boolean;
  type = 'audio/mpeg';
  ended = false;
  failed = false;
  private abort = new AbortController();
  private waiters = new Set<() => void>();
  private started = Date.now();
  private bytesAt5s = -1;
  rec: Recording | null = null;
  ready: Promise<void>;

  constructor(url: string, kbps: number, onTitle: (title: string) => void) {
    this.url = url;
    this.rate = kbps > 0 ? kbps * 125 : 16000;
    this.rateKnown = kbps > 0;
    this.ready = this.run(onTitle);
  }

  private async run(onTitle: (title: string) => void): Promise<void> {
    let res: Response;
    try {
      res = await net.fetch(this.url, { headers: { 'Icy-MetaData': '1', 'User-Agent': UA }, signal: this.abort.signal });
    } catch (e) {
      this.fail(e);
      return;
    }
    if (!res.ok || !res.body) {
      this.fail(`HTTP ${res.status}`);
      return;
    }
    this.type = res.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg';
    const metaint = Number(res.headers.get('icy-metaint')) || 0;
    const icy = metaint ? new IcyParser(metaint, onTitle) : null;
    const reader = res.body.getReader();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const audio = icy ? icy.push(value) : Buffer.from(value);
          if (audio.length) this.add(audio);
        }
      } catch (e) {
        if (!this.abort.signal.aborted) log('warn', 'radio', `${this.url}: ${e instanceof Error ? e.message : e}`);
      }
      this.ended = true;
      this.wake();
    })();
  }

  private fail(e: unknown): void {
    if (!this.abort.signal.aborted) log('warn', 'radio', `${this.url}: ${e instanceof Error ? e.message : e}`);
    this.failed = true;
    this.ended = true;
    this.wake();
  }

  private add(data: Buffer): void {
    this.chunks.push({ at: this.total, data });
    this.total += data.length;
    // no bit rate given by the directory: measured once, between 5 s and 20 s (after the burst)
    if (!this.rateKnown) {
      const el = Date.now() - this.started;
      if (el >= 5000 && this.bytesAt5s < 0) this.bytesAt5s = this.total;
      else if (el >= 20000 && this.bytesAt5s >= 0) {
        const r = (this.total - this.bytesAt5s) / ((el - 5000) / 1000);
        if (r > 2000 && r < 80000) this.rate = r;
        this.rateKnown = true;
      }
    }
    // keep WINDOW_SEC of audio, and never more than MAX_BYTES
    const keepFrom = this.total - Math.min(MAX_BYTES, WINDOW_SEC * this.rate);
    let drop = 0;
    while (drop < this.chunks.length - 1 && this.chunks[drop + 1]!.at <= keepFrom) drop++;
    if (drop) this.chunks.splice(0, drop);
    if (this.rec) recWrite(this.rec, data);
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }

  /** Resolves when new audio arrives or the stream ends. */
  next(): Promise<void> {
    return new Promise((r) => this.waiters.add(r));
  }

  get oldest(): number {
    return this.chunks[0]?.at ?? this.total;
  }

  /** Index of the chunk holding `byte` (the first one if it is gone already). */
  indexOf(byte: number): number {
    const c = this.chunks;
    let lo = 0;
    let hi = c.length - 1;
    if (hi < 0 || byte <= c[0]!.at) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid]!.at <= byte) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  window(): RadioWindow {
    return { url: this.url, start: this.oldest / this.rate, end: this.total / this.rate, rate: this.rate, ended: this.ended, recording: this.rec ? { path: this.rec.path, seconds: this.rec.bytes / this.rate, start: this.rec.from / this.rate } : null };
  }

  close(): void {
    this.abort.abort();
    this.ended = true;
    this.wake();
  }
}

/** Strips ICY metadata (every `metaint` audio bytes: one length byte ×16, then the text). */
class IcyParser {
  private audioLeft: number;
  private metaLeft = -1;
  private meta: number[] = [];
  constructor(
    private metaint: number,
    private onTitle: (t: string) => void,
  ) {
    this.audioLeft = metaint;
  }
  push(value: Uint8Array): Buffer {
    const out: Buffer[] = [];
    let i = 0;
    while (i < value.length) {
      if (this.audioLeft > 0) {
        const n = Math.min(this.audioLeft, value.length - i);
        out.push(Buffer.from(value.subarray(i, i + n)));
        i += n;
        this.audioLeft -= n;
      } else if (this.metaLeft === -1) {
        this.metaLeft = value[i++]! * 16;
        this.meta = [];
        if (this.metaLeft === 0) {
          this.metaLeft = -1;
          this.audioLeft = this.metaint;
        }
      } else {
        const n = Math.min(this.metaLeft, value.length - i);
        for (let k = 0; k < n; k++) this.meta.push(value[i + k]!);
        i += n;
        this.metaLeft -= n;
        if (this.metaLeft === 0) {
          const text = Buffer.from(this.meta).toString('utf8').replace(/\0+$/, '');
          const m = /StreamTitle='(.*?)';/.exec(text);
          if (m && m[1]!.trim()) this.onTitle(m[1]!.trim());
          this.metaLeft = -1;
          this.audioLeft = this.metaint;
        }
      }
    }
    return Buffer.concat(out);
  }
}

let current: Session | null = null;

function tune(url: string, kbps: number, onTitle: (t: string) => void): Session {
  if (current && current.url === url && !current.ended) return current;
  stop();
  current = new Session(url, kbps, onTitle);
  return current;
}

/** The station closed: no more upstream connection (and a recording in progress is saved). */
export function stop(): RecordResult | null {
  const saved = stopRecording();
  current?.close();
  current = null;
  return saved;
}

/**
 * The player's request: audio from `fromSec` (seconds since tuning in; absent = live edge), then
 * on as it arrives. A finished or failed station is tuned in again when asked for the live edge.
 */
export async function serve(url: string, kbps: number, fromSec: number | null, onTitle: (t: string) => void): Promise<Response> {
  const s = tune(url, kbps, onTitle);
  await s.ready;
  if (s.failed) {
    if (current === s) current = null;
    return new Response(null, { status: 502 });
  }
  // live: 3 s behind the newest audio (the player starts at once, without stuttering); otherwise
  // from the chunk holding that moment (or the oldest one still in memory)
  const want = fromSec === null ? s.total - 3 * s.rate : Math.floor(fromSec * s.rate);
  let i = s.indexOf(want);
  let pos = s.chunks[i]?.at ?? s.total;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for (;;) {
        if (current !== s) return ctrl.close();
        // the chunks may have been trimmed since: find our place again
        if (i >= s.chunks.length || s.chunks[i]!.at !== pos) i = pos >= s.total ? s.chunks.length : s.indexOf(pos);
        const c = s.chunks[i];
        if (c && c.at + c.data.length > pos) {
          const off = Math.max(0, pos - c.at);
          ctrl.enqueue(new Uint8Array(c.data.subarray(off)));
          pos = c.at + c.data.length;
          i++;
          return;
        }
        if (s.ended) return ctrl.close();
        await s.next();
      }
    },
  });
  return new Response(body, { headers: { 'Content-Type': s.type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}

export function radioWindow(): RadioWindow | null {
  return current ? current.window() : null;
}

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/aac': 'aac', 'audio/aacp': 'aac', 'audio/x-aac': 'aac', 'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/x-flac': 'flac' };

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
}

/**
 * Starts recording the station, from `fromSec` (what the person hears) on. `dir` empty = the
 * system's Music folder. Never overwrites a file: a number is added to the name instead.
 */
export function startRecording(name: string, dir: string, fromSec: number | null): RecordResult | null {
  const s = current;
  if (!s || s.ended) return null;
  if (s.rec) return { path: s.rec.path, seconds: s.rec.bytes / s.rate };
  const folder = dir || app.getPath('music');
  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    // folder that cannot be created (removed drive, no permission): nothing is recorded
    log('warn', 'radio', `recording folder ${folder}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  const base = `${name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Radio'} ${stamp(new Date())}`;
  const ext = EXT[s.type] ?? 'mp3';
  let path = join(folder, `${base}.${ext}`);
  for (let n = 2; existsSync(path); n++) path = join(folder, `${base} (${n}).${ext}`);
  const out = createWriteStream(path, { flags: 'wx' });
  out.on('error', (e) => log('warn', 'radio', `recording ${path}: ${e.message}`));
  const from = fromSec === null ? s.total : Math.max(s.oldest, Math.floor(fromSec * s.rate));
  const rec: Recording = { out, path, from, bytes: 0, startedAt: Date.now(), synced: !/mpeg|mp3|aac/.test(s.type) };
  // what is already in memory from that moment on
  if (fromSec !== null) {
    for (let i = s.indexOf(from); i < s.chunks.length; i++) {
      const c = s.chunks[i]!;
      recWrite(rec, c.data.subarray(Math.max(0, from - c.at)));
    }
  }
  s.rec = rec;
  return { path, seconds: rec.bytes / s.rate };
}

/**
 * Stops recording at `toSec` (what the person hears when they stop; null = everything received):
 * the audio after that moment, already written, is cut off the file.
 */
export function stopRecording(toSec: number | null = null): RecordResult | null {
  const s = current;
  const rec = s?.rec;
  if (!s || !rec) return null;
  s.rec = null;
  const keep = toSec === null ? rec.bytes : Math.max(0, Math.min(rec.bytes, Math.floor(toSec * s.rate) - rec.from));
  const done = new Promise<void>((resolve) => {
    rec.out.end(() => {
      if (keep < rec.bytes) truncate(rec.path, keep, (e) => {
        if (e) log('warn', 'radio', `recording ${rec.path}: ${e.message}`);
        resolve();
      });
      else resolve();
    });
  });
  closing.add(done);
  void done.then(() => closing.delete(done));
  return { path: rec.path, seconds: keep / s.rate };
}

const closing = new Set<Promise<void>>();

/**
 * The app is quitting: the station closes, and a recording in progress is written out to the
 * end before the process goes (at most 3 s).
 */
export async function shutdown(): Promise<void> {
  stop();
  if (closing.size) await Promise.race([Promise.all(closing), new Promise((r) => setTimeout(r, 3000))]);
}
