import { Worker } from 'node:worker_threads';
import { watch, type FSWatcher } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { LibraryFolder, ScanStatus, Track } from '@shared/types';
import { isAudioPath } from '@shared/audio-formats';
import { kvGet, kvSet, tx, sql } from './db';
import { log } from './log';
import { cacheDir } from './paths';
import { localId } from './metadata';
import { isNetworkFolder, reachable } from './netpath';
import { rowToTrack, TRACK_COLUMNS, upsertFromMeta, type TrackRow } from './tracks';
import type { ScanMessage, ScanRequest } from './scan-worker';
import workerPath from './scan-worker?modulePath';

// The library indexes the user's folders without ever touching them. Files that disappear
// are marked unavailable (never deleted from playlists); files that move are re-linked.

type Emit = (channel: 'library:changed' | 'library:status', payload?: unknown) => void;

const status: ScanStatus = { running: false, found: 0, parsed: 0, lastScanAt: null, watching: false, unread: 0 };
let emit: Emit = () => {};
const watchers = new Map<string, FSWatcher>();
let queue: Promise<void> = Promise.resolve();

const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
/** norm() of a path that is whole already (the database's, the scanner's): much faster. */
const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const isUnder = (p: string, dir: string) => norm(p) === norm(dir) || norm(p).startsWith(norm(dir) + sep);
/** isUnder for many paths against the same folders (each folder normalised once). */
function underAny(dirs: string[]): (p: string) => boolean {
  const ds = dirs.map(norm);
  return (p) => {
    const n = key(p);
    return ds.some((d) => n === d || n.startsWith(d + sep));
  };
}

export function initLibrary(e: Emit): void {
  emit = e;
  status.lastScanAt = kvGet<number>('library.lastScanAt');
  for (const f of scannedFolderPaths()) void startWatching(f);
  // Catch up with changes made while the app was closed (stat-only for unchanged files), 30 s
  // after start so the app is up and playing first; skipped if a scan was asked for meanwhile.
  startupTimer = setTimeout(() => {
    startupTimer = undefined;
    if (!scannedSinceStart && scannedFolderPaths().length) void rescan();
  }, STARTUP_SCAN_DELAY);
}

const STARTUP_SCAN_DELAY = Number(process.env.CHUD_STARTUP_SCAN_MS) || 30_000;
let startupTimer: ReturnType<typeof setTimeout> | undefined;
/** Lets the rest of the app work for a moment (long loops over a very large library). */
const breathe = () => new Promise<void>((r) => setImmediate(r));
const CHUNK = 2000;
/** Runs `fn` on slices of a list, the app staying responsive in between. */
async function inChunks<T>(list: T[], fn: (part: T[]) => void): Promise<void> {
  for (let i = 0; i < list.length && !closing; i += CHUNK) {
    fn(list.slice(i, i + CHUNK));
    if (i + CHUNK < list.length) await breathe();
  }
}

/** A full scan was started (by hand, or a folder added): the delayed startup scan is not needed. */
let scannedSinceStart = false;

/** Library › … › Scan the library: a full scan now (the delayed startup scan is then dropped). */
export function scanNow(): Promise<void> {
  scannedSinceStart = true;
  clearTimeout(startupTimer);
  startupTimer = undefined;
  return rescan();
}

function listFolderPaths(): string[] {
  return (sql('SELECT path FROM library_folders ORDER BY path').all() as { path: string }[]).map((r) => r.path);
}

/** The folders whose scanning is on (Settings › Library, one switch per folder). */
function scannedFolderPaths(): string[] {
  return (sql('SELECT path FROM library_folders WHERE scan = 1 ORDER BY path').all() as { path: string }[]).map((r) => r.path);
}

/**
 * Scanning of one folder on or off. Off: no watcher, no startup scan, left out of Rescan — its
 * tracks stay in the library as they are. On again: watched, and scanned once right away.
 */
export function setFolderScan(path: string, on: boolean): void {
  const row = sql('SELECT path FROM library_folders WHERE path = ?').get(path) as { path: string } | undefined;
  if (!row) return;
  sql('UPDATE library_folders SET scan = ? WHERE path = ?').run(on ? 1 : 0, path);
  if (on) {
    void startWatching(path);
    void enqueueScan([path]);
  } else stopWatching(path);
  emit('library:changed');
}

export async function folders(): Promise<LibraryFolder[]> {
  const rows = sql('SELECT path, added_at, scan FROM library_folders ORDER BY path').all() as { path: string; added_at: number; scan: number }[];
  // a folder left unscanned is not touched at all, not even to see whether it is there
  const reach = await Promise.all(rows.map((r) => (r.scan ? reachable(r.path) : true)));
  // one pass over the tracks (folders never nest: a parent folder absorbs its sub-folders)
  const dirs = rows.map((r) => norm(r.path));
  const counts = new Array<number>(rows.length).fill(0);
  for (const { path } of sql('SELECT path FROM tracks WHERE in_library = 1 AND available = 1').all() as { path: string }[]) {
    const n = key(path);
    const i = dirs.findIndex((d) => n === d || n.startsWith(d + sep));
    if (i >= 0) counts[i]!++;
  }
  return rows.map((r, i) => ({ path: r.path, addedAt: r.added_at, trackCount: counts[i]!, missing: !reach[i], scan: r.scan !== 0 }));
}

export function addFolder(path: string): void {
  const p = resolve(path);
  const existing = listFolderPaths();
  if (existing.some((f) => isUnder(p, f))) return; // already covered by a parent folder
  tx(() => {
    // a new parent folder absorbs its sub-folders
    for (const f of existing.filter((f) => isUnder(f, p))) sql('DELETE FROM library_folders WHERE path = ?').run(f);
    sql('INSERT INTO library_folders (path, added_at) VALUES (?, ?)').run(p, Date.now());
  });
  for (const f of existing.filter((f) => isUnder(f, p))) stopWatching(f);
  // adding a folder explicitly brings back the files removed from it earlier
  for (const e of excludedPaths()) if (isUnder(e, p)) sql('DELETE FROM library_exclusions WHERE path = ?').run(e);
  void startWatching(p);
  void enqueueScan([p]);
}

// ── Removing from the library ─────────────────────────────────────────────────────────────
// Only the index changes: files on disk are never deleted, moved or renamed. A removed file
// stays out of the library across rescans (exclusion by path); playlists and history keep it.

function excludedPaths(): string[] {
  return (sql('SELECT path FROM library_exclusions').all() as { path: string }[]).map((r) => r.path);
}

export function excludedCount(): number {
  return (sql('SELECT COUNT(*) AS n FROM library_exclusions').get() as { n: number }).n;
}

export function removeTracks(ids: string[]): void {
  tx(() => {
    for (const id of ids) {
      const row = sql("SELECT path FROM tracks WHERE id = ? AND source = 'local' AND in_library = 1").get(id) as { path: string } | undefined;
      if (!row) continue;
      sql('UPDATE tracks SET in_library = 0 WHERE id = ?').run(id);
      sql('INSERT OR REPLACE INTO library_exclusions (path, excluded_at) VALUES (?, ?)').run(row.path, Date.now());
    }
  });
  emit('library:changed');
}

/** Undo of removeTracks (rows are kept until the next prune, so their stats survive). */
export function restoreTracks(ids: string[]): void {
  const back: string[] = [];
  tx(() => {
    for (const id of ids) {
      const row = sql("SELECT path FROM tracks WHERE id = ? AND source = 'local'").get(id) as { path: string } | undefined;
      if (!row) continue;
      sql('DELETE FROM library_exclusions WHERE path = ?').run(row.path);
      sql('UPDATE tracks SET in_library = 1 WHERE id = ?').run(id);
      back.push(row.path);
    }
  });
  emit('library:changed');
  if (back.length) void enqueueScan(back); // refreshes availability and tags
}

/** Brings back every removed file still under a library folder. */
export function restoreAll(): void {
  sql('DELETE FROM library_exclusions').run();
  emit('library:changed');
  void rescan();
}

/** Empties the library: folders are no longer followed, the index is cleared. */
export function clearLibrary(): void {
  for (const f of listFolderPaths()) stopWatching(f);
  tx(() => {
    sql('DELETE FROM library_folders').run();
    sql('DELETE FROM library_exclusions').run();
    sql('UPDATE tracks SET in_library = 0 WHERE in_library = 1').run();
    pruneOrphans();
  });
  emit('library:changed');
}

export function removeFolder(path: string): void {
  stopWatching(path);
  tx(() => {
    sql('DELETE FROM library_folders WHERE path = ?').run(path);
    const rows = sql('SELECT id, path FROM tracks WHERE in_library = 1').all() as { id: string; path: string }[];
    const stillCovered = listFolderPaths();
    for (const r of rows) {
      if (isUnder(r.path, path) && !stillCovered.some((f) => isUnder(r.path, f))) {
        sql('UPDATE tracks SET in_library = 0 WHERE id = ?').run(r.id);
      }
    }
    pruneOrphans();
  });
  emit('library:changed');
}

/** Rows that are neither in the library nor referenced by a playlist or the history are dropped. */
function pruneOrphans(): void {
  sql('DELETE FROM tracks WHERE in_library = 0 AND id NOT IN (SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history)').run();
}

export function rescan(): Promise<void> {
  const roots = scannedFolderPaths();
  return roots.length ? enqueueScan(roots) : Promise.resolve();
}

export function getStatus(): ScanStatus {
  return { ...status };
}

export function libraryTracks(): Track[] {
  const rows = sql(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE in_library = 1`).all() as unknown as TrackRow[];
  return rows.map((r) => rowToTrack(r));
}

// The library crosses to the interface in pages (a first one is enough to show something), then
// only as changes (db.ts keeps the list of the tracks that changed).

const PAGE = 2500;

/** Library tracks after this row, and where the next page starts (null: that was the last). */
export function tracksPage(after: number): { tracks: Track[]; next: number | null } {
  if (!after) sql('DELETE FROM changed_tracks').run(); // all of it is about to be read
  const rows = sql(`SELECT rowid AS rid, ${TRACK_COLUMNS} FROM tracks WHERE in_library = 1 AND rowid > ? ORDER BY rowid LIMIT ?`).all(after, PAGE) as unknown as (TrackRow & { rid: number })[];
  return { tracks: rows.map((r) => rowToTrack(r)), next: rows.length === PAGE ? rows.at(-1)!.rid : null };
}

/** What changed since the last call: tracks of the library to put or replace, others to take out. */
export function changes(): { tracks: Track[]; gone: string[]; more: boolean } {
  const ids = (sql('SELECT id FROM changed_tracks LIMIT ?').all(PAGE) as { id: string }[]).map((r) => r.id);
  const tracks: Track[] = [];
  const gone: string[] = [];
  const get = sql(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ? AND in_library = 1`);
  const done = sql('DELETE FROM changed_tracks WHERE id = ?');
  for (const id of ids) {
    const row = get.get(id) as unknown as TrackRow | undefined;
    if (row) tracks.push(rowToTrack(row));
    else gone.push(id);
    done.run(id);
  }
  return { tracks, gone, more: ids.length === PAGE };
}

export function recentlyPlayed(limit: number): Track[] {
  const rows = sql(
      `SELECT ${TRACK_COLUMNS} FROM tracks WHERE id IN (
         SELECT h.track_id FROM play_history h LEFT JOIN recent_hidden r ON r.track_id = h.track_id AND r.list = 'played'
         GROUP BY h.track_id HAVING MAX(h.played_at) > COALESCE(MAX(r.at), 0) ORDER BY MAX(h.played_at) DESC LIMIT ?
       ) ORDER BY last_played_at DESC`,
    )
    .all(limit) as unknown as TrackRow[];
  return rows.map((r) => rowToTrack(r));
}

/** Takes tracks out of "Recently played" or "Recently added" (nothing else changes). */
export function hideRecent(list: 'played' | 'added', ids: string[]): void {
  const now = Date.now();
  tx(() => {
    for (const id of ids) sql('INSERT OR REPLACE INTO recent_hidden (track_id, list, at) VALUES (?, ?, ?)').run(id, list, now);
  });
}

/** "Clear all" of "Recently played": every track of it out of the list; nothing else changes. */
export function clearRecentlyPlayed(): void {
  sql("INSERT OR REPLACE INTO recent_hidden (track_id, list, at) SELECT DISTINCT track_id, 'played', ? FROM play_history").run(Date.now());
}

/** Tracks taken out of "Recently added": id → when (added again later = shown again). */
export function hiddenAdded(): Record<string, number> {
  const rows = sql("SELECT track_id, at FROM recent_hidden WHERE list = 'added'").all() as { track_id: string; at: number }[];
  return Object.fromEntries(rows.map((r) => [r.track_id, r.at]));
}

function setStatus(patch: Partial<ScanStatus>): void {
  Object.assign(status, patch);
  emit('library:status', { ...status });
}

/** Scans are serialised: a watcher burst during a full scan waits its turn. */
function enqueueScan(targets: string[]): Promise<void> {
  queue = queue
    .then(() => (closing ? undefined : scan(targets)))
    .catch((e) => {
      log('warn', 'library', `scan failed: ${e instanceof Error ? e.message : String(e)}`);
      if (status.running && !closing) setStatus({ running: false });
    });
  return queue;
}

let activeWorker: Worker | null = null;
let closing = false;

/** No news from the scanner for this long: a share hangs; it is stopped, and tried again later. */
const STALLED = Number(process.env.CHUD_SCAN_STALL_MS) || 180_000;

async function scan(targets: string[]): Promise<void> {
  const roots = scannedFolderPaths(); // folders whose scanning is off are never read
  // A root that is unreachable (unplugged drive, network share down) is never treated as
  // "everything was deleted": its tracks are only flagged unavailable until it comes back.
  const reach = await Promise.all(roots.map((r) => reachable(r)));
  const offline = roots.filter((_, i) => !reach[i]);
  if (offline.length) {
    const isOffline = underAny(offline);
    const rows = (sql("SELECT id, path FROM tracks WHERE source = 'local' AND in_library = 1 AND available = 1").all() as { id: string; path: string }[]).filter((r) => isOffline(r.path));
    await inChunks(rows, (part) => tx(() => {
      for (const r of part) sql('UPDATE tracks SET available = 0 WHERE id = ?').run(r.id);
    }));
    for (const r of offline) awaitReturn(r);
    emit('library:changed');
  }
  targets = targets.filter((t) => roots.some((r) => isUnder(t, r) && !offline.includes(r)));
  if (!targets.length || closing) return;
  setStatus({ running: true, found: 0, parsed: 0 });

  const knownRows = sql("SELECT id, path, file_size, mtime_ms, available, in_library FROM tracks WHERE source = 'local'").all() as {
    id: string; path: string; file_size: number | null; mtime_ms: number | null; available: number; in_library: number;
  }[];
  const inTarget = underAny(targets);
  const inTargets: typeof knownRows = [];
  await inChunks(knownRows, (part) => {
    for (const r of part) if (inTarget(r.path)) inTargets.push(r);
  });
  // (a file of a share that was away is known too: it is not read again if it did not change)
  const known: Record<string, string> = {};
  for (const r of inTargets) if (r.file_size != null) known[r.path] = `${r.file_size}:${r.mtime_ms}`;

  const startedAt = Date.now();
  const inserted: string[] = [];
  const excluded = new Set(excludedPaths().map(norm));
  const skip: Record<string, true> = {};
  for (const p of excluded) skip[p] = true;
  // each library folder has its own share of the work: a slow NAS does not hold the others back
  const groups = roots.map((r) => targets.filter((t) => isUnder(t, r))).filter((g) => g.length);
  const req: ScanRequest = { groups, known, skip, coversDir: cacheDir('covers') };

  let { seen, failed, denied } = await new Promise<{ seen: string[]; failed: string[]; denied: string[] }>((res, rej) => {
    const w = new Worker(workerPath, { workerData: req });
    activeWorker = w;
    let stalled: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(stalled);
      stalled = setTimeout(() => {
        void w.terminate();
        for (const g of groups) for (const t of g) retryLater(t);
        rej(new Error('the scanner got no answer from the disk or the share'));
      }, STALLED);
      stalled.unref?.();
    };
    alive();
    w.on('message', (m: ScanMessage) => {
      alive();
      // a failure while saving (database closed on quit, disk full…) stops this scan only,
      // never the app: it is thrown from an event handler, outside the promise
      try {
        onMessage(m);
      } catch (e) {
        void w.terminate();
        rej(e);
      }
    });
    const onMessage = (m: ScanMessage) => {
      if (m.type === 'progress') setStatus({ found: m.found, parsed: m.parsed });
      else if (m.type === 'batch') {
        tx(() => {
          for (const meta of m.metas) {
            if (excluded.has(norm(meta.path))) continue;
            const before = sql('SELECT 1 FROM tracks WHERE id = ?').get(localId(meta.path));
            upsertFromMeta(meta, true, startedAt);
            if (!before) inserted.push(meta.path);
          }
        });
        emit('library:changed');
      } else if (m.type === 'done') res(m);
    };
    w.on('error', rej);
    w.on('exit', (code) => {
      clearTimeout(stalled);
      if (activeWorker === w) activeWorker = null;
      if (code !== 0) rej(new Error(`scan worker exited with ${code}`));
    });
  });

  // A folder that could not be read, or a root that went away meanwhile: nothing is known of what
  // is (still) in there, so what is in the library stays, and it is read again in a moment.
  for (const r of roots) {
    if (groups.some((g) => isUnder(g[0]!, r)) && !(await reachable(r))) {
      failed = [...failed.filter((f) => !isUnder(f, r)), r];
      awaitReturn(r);
    }
  }
  for (const f of failed) retryLater(f);
  const notRead = underAny([...failed, ...denied]);
  const seenSet = new Set<string>();
  await inChunks(seen, (part) => {
    for (const p of part) seenSet.add(key(p));
  });
  // In the scanned area, everything known but not seen is gone (deleted, moved, renamed).
  const gone: string[] = [];
  await inChunks(inTargets, (part) => tx(() => {
    for (const r of part) {
      const k = key(r.path);
      if (seenSet.has(k)) {
        const inLibrary = excluded.has(k) ? r.in_library : 1; // still on disk, still out of the library
        if (!r.available || r.in_library !== inLibrary) sql('UPDATE tracks SET in_library = ?, available = 1 WHERE id = ?').run(inLibrary, r.id);
      } else if (!notRead(r.path)) gone.push(r.id);
    }
  }));
  tx(() => {
    for (const id of gone) sql('UPDATE tracks SET available = 0 WHERE id = ?').run(id);
    relinkMoved(inserted);
    // Still gone after re-linking: leave the library. Kept (flagged) only if a playlist or the
    // history still points to it, so nothing the user built silently disappears.
    if (!gone.length) return;
    const referenced = new Set((sql('SELECT track_id AS id FROM playlist_items UNION SELECT track_id FROM play_history').all() as { id: string }[]).map((r) => r.id));
    for (const id of gone) {
      if (referenced.has(id)) sql('UPDATE tracks SET in_library = 0 WHERE id = ?').run(id);
      else sql('DELETE FROM tracks WHERE id = ?').run(id);
    }
  });

  setStatus({ running: false, lastScanAt: Date.now() });
  kvSet('library.lastScanAt', status.lastScanAt);
  emit('library:changed');
}

// ── What did not answer ───────────────────────────────────────────────────────────────────
// A library folder that is away (NAS off, drive unplugged) is looked for again, more and more
// rarely; once back it is watched and scanned. A folder that could not be read is read again.

const BACK_MIN = Number(process.env.CHUD_RETRY_MS) || 15_000;
const BACK_MAX = 5 * 60_000;
const away = new Map<string, { wait: number; timer: ReturnType<typeof setTimeout> }>();

function awaitReturn(root: string, wait = BACK_MIN): void {
  if (closing || away.has(root)) return;
  log('info', 'library', `folder not reachable, looked for again: ${root}`);
  const look = (w: number) => {
    const timer = setTimeout(() => void (async () => {
      if (closing || !scannedFolderPaths().includes(root)) return void away.delete(root);
      if (!(await reachable(root))) return look(Math.min(w * 2, BACK_MAX));
      away.delete(root);
      log('info', 'library', `folder back: ${root}`);
      void startWatching(root);
      void enqueueScan([root]);
    })(), w);
    timer.unref?.();
    away.set(root, { wait: w, timer });
  };
  look(wait);
}

const retries = new Map<string, { wait: number; timer: ReturnType<typeof setTimeout> | undefined }>();

function retryLater(target: string): void {
  if (closing || away.has(target)) return;
  const before = retries.get(target);
  if (before?.timer) return;
  const wait = before ? Math.min(before.wait * 2, BACK_MAX) : BACK_MIN;
  const timer = setTimeout(() => {
    const r = retries.get(target);
    if (r) r.timer = undefined;
    void enqueueScan([target]).then(() => {
      // read this time: forgotten (a new failure has set a timer again)
      if (!retries.get(target)?.timer) retries.delete(target);
      setStatus({ unread: retries.size });
    });
  }, wait);
  timer.unref?.();
  retries.set(target, { wait, timer });
  setStatus({ unread: retries.size });
}

/**
 * A missing track that a playlist references, and a newly found file with the same size and
 * duration, are the same song moved or renamed: playlists follow it to its new location.
 */
function relinkMoved(newPaths: string[]): void {
  if (!newPaths.length) return;
  const missing = sql(
    `SELECT id, file_size, duration_sec, play_count, last_played_at, added_at FROM tracks
     WHERE source = 'local' AND available = 0 AND id IN (SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history)`,
  ).all() as { id: string; file_size: number; duration_sec: number | null; play_count: number; last_played_at: number | null; added_at: number }[];
  if (!missing.length) return;
  // the new files, read once and grouped by size (not once per missing track)
  type Fresh = { id: string; file_size: number; duration_sec: number | null };
  const bySize = new Map<number, Fresh[]>();
  for (const p of newPaths) {
    const f = sql('SELECT id, file_size, duration_sec FROM tracks WHERE id = ?').get(localId(p)) as Fresh | undefined;
    if (!f) continue;
    const list = bySize.get(f.file_size);
    if (list) list.push(f);
    else bySize.set(f.file_size, [f]);
  }
  for (const old of missing) {
    const list = bySize.get(old.file_size);
    if (!list) continue;
    const i = list.findIndex((f) => f.id !== old.id && (old.duration_sec == null || f.duration_sec == null || Math.abs(old.duration_sec - f.duration_sec) <= 0.5));
    if (i < 0) continue;
    const fresh = list.splice(i, 1)[0]!;
    sql('UPDATE playlist_items SET track_id = ? WHERE track_id = ?').run(fresh.id, old.id);
    sql('UPDATE play_history SET track_id = ? WHERE track_id = ?').run(fresh.id, old.id);
    sql('UPDATE tracks SET play_count = play_count + ?, last_played_at = COALESCE(?, last_played_at), added_at = MIN(added_at, ?) WHERE id = ?')
      .run(old.play_count, old.last_played_at, old.added_at, fresh.id);
    sql('DELETE FROM tracks WHERE id = ?').run(old.id);
  }
}

// ── Watching ──────────────────────────────────────────────────────────────────────────────

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Network folders: no watcher, a scan of them now and then (netpath.ts says why). */
const polled = new Set<string>();
const POLL_EVERY = Number(process.env.CHUD_NETWORK_POLL_MS) || 60 * 60_000;
let pollTimer: ReturnType<typeof setInterval> | undefined;

function setPolled(folder: string, on: boolean): void {
  if (on) polled.add(folder);
  else polled.delete(folder);
  if (polled.size && !pollTimer) {
    pollTimer = setInterval(() => {
      if (!status.running && polled.size) void enqueueScan([...polled]);
    }, POLL_EVERY);
    pollTimer.unref?.();
  } else if (!polled.size && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function startWatching(folder: string): Promise<void> {
  if (watchers.has(folder) || polled.has(folder)) return;
  if (await isNetworkFolder(folder)) {
    log('info', 'library', `network folder, checked every ${Math.round(POLL_EVERY / 60_000)} min instead of watched: ${folder}`);
    setPolled(folder, true);
    return;
  }
  if (!(await reachable(folder))) return awaitReturn(folder);
  if (watchers.has(folder) || closing) return;
  try {
    const w = watch(folder, { recursive: true }, (_event, name) => {
      if (!name) {
        pending.add(folder);
      } else {
        const full = resolve(folder, name.toString());
        // a plain file event for a non-audio file is irrelevant; directories matter (moves)
        if (isAudioPath(full) || !/\.[a-z0-9]{1,5}$/i.test(full)) pending.add(full);
      }
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushPending, 1500);
    });
    // e.g. drive unplugged: its tracks are flagged, and it is watched again once it is back
    w.on('error', () => {
      stopWatching(folder);
      void enqueueScan([folder]);
    });
    watchers.set(folder, w);
  } catch {
    /* folder unreachable: it is shown as missing in Settings */
  }
  setStatus({ watching: watchers.size > 0 });
}

function stopWatching(folder: string): void {
  setPolled(folder, false);
  watchers.get(folder)?.close();
  watchers.delete(folder);
  setStatus({ watching: watchers.size > 0 });
}

function flushPending(): void {
  // collapse to the smallest set of targets (a path under another pending path is redundant)
  const all = [...pending].sort((a, b) => a.length - b.length);
  pending.clear();
  const targets: string[] = [];
  for (const p of all) if (!targets.some((t) => isUnder(p, t))) targets.push(p);
  void enqueueScan(targets);
}

export function stopAllWatchers(): void {
  for (const f of [...watchers.keys(), ...polled]) stopWatching(f);
}

/** The app is quitting: no new scan, the one running is stopped (before the database closes). */
export function shutdownLibrary(): void {
  closing = true;
  clearTimeout(startupTimer);
  clearTimeout(flushTimer);
  for (const r of [...away.values(), ...retries.values()]) clearTimeout(r.timer);
  stopAllWatchers();
  void activeWorker?.terminate();
  activeWorker = null;
}
