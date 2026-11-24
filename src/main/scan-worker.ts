import { parentPort, workerData } from 'node:worker_threads';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isAudioPath } from '@shared/audio-formats';
import { readFileMeta, type FileMeta } from './metadata';
import { testOffline } from './netpath';

// Library scanner, off the main thread. Walks the requested targets, stats every audio
// file, and only parses tags for files that are new or changed since the last scan.
//
// Several requests are in flight at once (folders listed, files stat'ed, tags read): on a network
// share each one is a round trip, and doing them one after the other spent most of the scan
// waiting. Bounded, so a slow disk or a small NAS is not flooded.

export interface ScanRequest {
  /** Folders or files to (re)examine, by library folder: each group works on its own. */
  groups: string[][];
  /** Known files: path → "size:mtime". Unchanged files are not re-read. */
  known: Record<string, string>;
  /** Files removed from the library by the user (normalised paths): listed as seen, never parsed. */
  skip: Record<string, true>;
  coversDir: string;
}

export type ScanMessage =
  | { type: 'progress'; found: number; parsed: number }
  | { type: 'batch'; metas: FileMeta[] }
  | { type: 'done'; seen: string[]; failed: string[]; denied: string[]; errors: number };

const req = workerData as ScanRequest;
const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const post = (m: ScanMessage) => parentPort!.postMessage(m);

const DIRS_AT_ONCE = 8;
const STATS_AT_ONCE = 16;
const PARSES_AT_ONCE = 4;

/** Runs `fn` on every item pushed to it, at most `n` at a time; `idle()` waits for all of them. */
function pool<T>(n: number, fn: (item: T) => Promise<void>) {
  const queue: T[] = [];
  let running = 0;
  let waiters: (() => void)[] = [];
  const pump = () => {
    while (running < n && queue.length) {
      running++;
      void fn(queue.shift()!).finally(() => {
        running--;
        pump();
      });
    }
    if (!running && !queue.length) {
      for (const w of waiters) w();
      waiters = [];
    }
  };
  return {
    push(item: T) {
      queue.push(item);
      pump();
    },
    get busy() {
      return running > 0 || queue.length > 0;
    },
    idle: () => new Promise<void>((r) => (running || queue.length ? waiters.push(r) : r())),
  };
}

async function run(): Promise<void> {
  const seen: string[] = [];
  /** Folders that could not be read (what they hold is not known). */
  const failed: string[] = [];
  /** Those the system keeps closed (System Volume Information…): reading them again would not help. */
  const denied: string[] = [];
  let parsed = 0;
  let errors = 0;
  let batch: FileMeta[] = [];
  let lastProgress = 0;

  const progress = () => {
    if (Date.now() - lastProgress > 250) {
      lastProgress = Date.now();
      post({ type: 'progress', found: seen.length, parsed });
    }
  };

  const note = (path: string, e: unknown) => {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') (code === 'EPERM' || code === 'EACCES' ? denied : failed).push(path);
  };

  const walk = async (targets: string[]) => {
    const parses = pool<string>(PARSES_AT_ONCE, async (path) => {
      try {
        // read first, then push: `batch.push(await …)` would pick the array before the await, and
        // another parse may have sent and replaced it meanwhile (the file would be lost)
        const meta = await readFileMeta(path, req.coversDir);
        batch.push(meta);
        parsed++;
      } catch {
        errors++;
      }
      if (batch.length >= 200) {
        post({ type: 'batch', metas: batch });
        batch = [];
      }
      progress();
    });

    const stats = pool<string>(STATS_AT_ONCE, async (path) => {
      try {
        if (testOffline(path)) throw new Error('offline');
        const st = await stat(path);
        if (req.known[path] !== `${st.size}:${Math.round(st.mtimeMs)}`) parses.push(path);
      } catch {
        errors++;
      }
      progress();
    });

    const audio = (path: string) => {
      seen.push(path);
      if (!req.skip[norm(path)]) stats.push(path);
    };

    const dirs = pool<string>(DIRS_AT_ONCE, async (dir) => {
      let entries;
      try {
        if (testOffline(dir)) throw new Error('offline');
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        // removed since it was listed: gone. Otherwise (permissions, connection lost): said so, and
        // the scan goes on with the rest
        note(dir, e);
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) dirs.push(p);
        else if (e.isFile() && isAudioPath(p)) audio(p);
      }
    });

    for (const target of targets) {
      let st;
      try {
        if (testOffline(target)) throw new Error('offline');
        st = await stat(target);
      } catch (e) {
        // vanished: the caller will mark what it knew there as missing
        note(target, e);
        continue;
      }
      if (st.isFile()) {
        if (isAudioPath(target)) audio(target);
      } else dirs.push(target);
    }
    // folders feed stats, stats feed tag reading: wait until all three are drained
    while (dirs.busy || stats.busy || parses.busy) {
      await dirs.idle();
      await stats.idle();
      await parses.idle();
    }
  };
  await Promise.all(req.groups.map(walk));
  if (batch.length) post({ type: 'batch', metas: batch });
  post({ type: 'progress', found: seen.length, parsed });
  post({ type: 'done', seen, failed, denied, errors });
}

void run();
