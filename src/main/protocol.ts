import { nativeImage, protocol } from 'electron';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { cacheDir, playlistCoversDir } from './paths';
import { testOffline } from './netpath';
import { serve } from './radio-shift';
import { ytSchemePrivilege } from './yt-player';

// chud-media://file/<encoded path>  — audio files, with Range support (needed for seeking)
// chud-media://cover/<name>         — cover art extracted into the cache
// Only paths the app itself opened are served: the UI cannot read arbitrary files.

export const SCHEME = 'chud-media';

const allowed = new Set<string>();
const allowedAsGiven = new Set<string>();
const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/** Called for every library track at each reload: a path seen before costs one lookup. */
export function allowPath(p: string): void {
  if (allowedAsGiven.has(p)) return;
  allowedAsGiven.add(p);
  allowed.add(norm(p));
}

export const fileUrl = (p: string) => `${SCHEME}://file/${encodeURIComponent(p)}`;
/** Pictures chosen by hand for playlists: kept with the user's data, not in the cache. */
export const playlistCoverUrl = (name: string) => `${SCHEME}://playlist-cover/${encodeURIComponent(name)}`;
export const coverUrl = (name: string) => `${SCHEME}://cover/${encodeURIComponent(name)}`;

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
    ytSchemePrivilege,
  ]);
}

let onRadioTitle: (e: { url: string; title: string }) => void = () => {};
export function setRadioTitleListener(cb: typeof onRadioTitle): void {
  onRadioTitle = cb;
}
export const radioUrl = (stream: string) => `${SCHEME}://radio/?u=${encodeURIComponent(stream)}`;

// Small copies of covers (?s=<px>), in the cache. Decoding and resizing a full-size cover takes
// tens of milliseconds on a slow PC and nativeImage only runs on the main thread, so it is never
// done while a request waits: the original is served this time, and the copy is made in the
// background, one at a time, with a pause between each so the UI and the audio keep their share.
const thumbReady = new Set<string>(); // copies known to exist
const noThumb = new Set<string>(); // originals already small enough (or unreadable): never retried
const thumbQueue = new Map<string, { path: string; size: number }>();
let thumbBusy = false;

const thumbPath = (path: string, size: number) => join(cacheDir('thumbs'), `${size}-${basename(path).replace(/\.\w+$/, '')}.jpg`);

function makeThumb(path: string, size: number, out: string): void {
  try {
    const img = nativeImage.createFromPath(path);
    if (img.isEmpty() || img.getSize().width <= size) {
      noThumb.add(out);
      return;
    }
    writeFileSync(out, img.resize({ width: size, quality: 'good' }).toJPEG(85));
    thumbReady.add(out);
  } catch {
    noThumb.add(out);
  }
}

function pumpThumbs(): void {
  if (thumbBusy) return;
  const next = thumbQueue.entries().next();
  if (next.done) return;
  const [out, { path, size }] = next.value;
  thumbQueue.delete(out);
  thumbBusy = true;
  setTimeout(() => {
    makeThumb(path, size, out);
    thumbBusy = false;
    pumpThumbs();
  }, 15);
}

/** The small copy if it exists; otherwise null (serve the original) and the copy is queued. */
function thumbnail(path: string, size: number): string | null {
  if (!/\.(jpe?g|png)$/i.test(path)) return null;
  const out = thumbPath(path, size);
  if (thumbReady.has(out)) return out;
  if (noThumb.has(out)) return null;
  if (existsSync(out)) {
    thumbReady.add(out);
    return out;
  }
  if (!thumbQueue.has(out)) {
    thumbQueue.set(out, { path, size });
    pumpThumbs();
  }
  return null;
}

/** Forget what is known about the copies (covers removed or replaced). */
export function forgetThumbs(): void {
  thumbReady.clear();
  noThumb.clear();
}

export function handleProtocol(): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    const name = decodeURIComponent(url.pathname.slice(1));
    let path: string;
    if (url.host === 'cover' || url.host === 'playlist-cover') {
      const dir = url.host === 'cover' ? cacheDir('covers') : playlistCoversDir();
      path = join(dir, name);
      if (!resolve(path).startsWith(resolve(dir) + sep)) return new Response(null, { status: 403 });
      // ?s=<px>: a small copy, made once (grids of covers would otherwise decode full-size images)
      const s = Number(url.searchParams.get('s'));
      if (s >= 32 && s <= 1024) path = thumbnail(path, Math.round(s)) ?? path;
    } else if (url.host === 'radio') {
      // live radio relayed (CORS for the audio graph, ICY titles read on the way)
      // (one connection per station, kept in memory for the time shift: radio-shift.ts)
      const stream = url.searchParams.get('u') ?? '';
      if (!/^https?:\/\//i.test(stream)) return new Response(null, { status: 400 });
      const from = url.searchParams.get('from');
      return serve(stream, Number(url.searchParams.get('k')) || 0, from !== null && Number.isFinite(Number(from)) ? Number(from) : null, (title) => onRadioTitle({ url: stream, title }));
    } else if (url.host === 'file') {
      path = name;
      if (!allowed.has(norm(path))) return new Response(null, { status: 403 });
    } else {
      return new Response(null, { status: 404 });
    }

    let size: number;
    try {
      if (testOffline(path)) throw new Error('offline');
      size = (await stat(path)).size;
    } catch {
      return new Response(null, { status: 404 });
    }
    const headers: Record<string, string> = {
      'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*', // lets Web Audio read the samples (EQ, visualiser)
    };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
    if (!m) {
      headers['Content-Length'] = String(size);
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers });
    }
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: 206, headers });
  });
}
