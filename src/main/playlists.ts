import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from './atomic-write';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { PlaylistDetail, PlaylistSummary, Track } from '@shared/types';
import { cleanSpec, smartQuery, type SmartSpec } from '@shared/smart';
import { fold, getDb, tx, sql } from './db';
import { readFileMeta } from './metadata';
import { log } from './log';
import { cacheDir, playlistCoversDir } from './paths';
import { forgetThumbs, isPlaylistThumb, playlistCoverUrl } from './protocol';
import { ensureTrackRow, metaToTrack, rowToTrack, TRACK_COLUMNS, type TrackRow } from './tracks';
import { tr } from '@shared/i18n';
import { m3uVideoId } from '@shared/links';
import { norm } from './youtube';

// Saved playlists. Only explicit user actions change them: opening files, playing, or
// closing tabs never does. Every write runs in a transaction.

type Emit = (id: number | null) => void;
let emit: Emit = () => {};
export function initPlaylists(e: Emit): void {
  emit = e;
}

function touch(id: number): void {
  sql('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/** For what edits entries: a smart playlist has none of its own. */
function assertExists(id: number): void {
  const row = sql('SELECT smart FROM playlists WHERE id = ?').get(id) as { smart: string | null } | undefined;
  if (!row) throw new Error(tr('main.plNotFound'));
  if (row.smart) throw new Error(tr('smart.noAdd'));
}

const COVER_SEED = Math.floor(Math.random() * 0x7fffffff);
/** A stable pseudo-random rank (FNV-1a of the launch seed, the playlist and the cover). */
function coverRank(id: number, url: string): number {
  let h = 0x811c9dc5 ^ COVER_SEED ^ Math.imul(id, 0x9e3779b1);
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function list(): PlaylistSummary[] {
  const rows = sql(
      `SELECT p.id, p.name, p.updated_at, p.cover, p.smart, COUNT(i.id) AS count, COALESCE(SUM(t.duration_sec), 0) AS dur
       FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id LEFT JOIN tracks t ON t.id = i.track_id
       GROUP BY p.id ORDER BY p.name COLLATE NOCASE`,
    )
    .all() as { id: number; name: string; updated_at: number; cover: string | null; smart: string | null; count: number; dur: number }[];
  const coverStmt = sql(
    `SELECT DISTINCT t.source, t.cover_ref FROM playlist_items i JOIN tracks t ON t.id = i.track_id
     WHERE i.playlist_id = ? AND t.cover_ref IS NOT NULL`,
  );
  return rows.map((r) => {
    const smart = parseSmart(r.smart);
    const sum = smart ? smartSummary(r.id, smart) : null;
    // 4 covers drawn at random among all the playlist's covers (not the first albums only). The
    // draw is fixed for the session (seeded at launch): the mosaic does not change at every
    // refresh of the list, only at the next launch.
    const urls = new Set<string>();
    for (const c of sum?.covers ?? (coverStmt.all(r.id) as { source: string; cover_ref: string }[])) urls.add(rowToTrack({ source: c.source, cover_ref: c.cover_ref, available: 0 } as TrackRow).coverUrl!);
    const covers = [...urls].sort((a, b) => coverRank(r.id, a) - coverRank(r.id, b)).slice(0, 4);
    return { id: r.id, name: r.name, count: sum?.count ?? r.count, durationSec: sum?.durationSec ?? r.dur, covers, updatedAt: r.updated_at, cover: r.cover ? playlistCoverUrl(r.cover) : null, smart };
  });
}

export function get(id: number): PlaylistDetail | null {
  const summary = list().find((p) => p.id === id);
  if (!summary) return null;
  if (summary.smart) return { ...summary, tracks: smartTracks(summary.smart) };
  const rows = sql(`SELECT i.id AS entry_id, ${TRACK_COLUMNS.split(', ').map((c) => `t.${c}`).join(', ')}
              FROM playlist_items i JOIN tracks t ON t.id = i.track_id WHERE i.playlist_id = ? ORDER BY i.position`)
    .all(id) as unknown as (TrackRow & { entry_id: number })[];
  return { ...summary, tracks: rows.map((r) => ({ ...rowToTrack(r), entryId: r.entry_id })) };
}

export function create(name: string, tracks: Track[] = []): number {
  const clean = name.trim() || tr('pl.new');
  const id = tx(() => {
    const now = Date.now();
    const r = sql('INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)').run(clean, now, now);
    const pid = Number(r.lastInsertRowid);
    insertTracks(pid, tracks, 0, now);
    return pid;
  });
  emit(id);
  return id;
}

// ── Smart playlists ──────────────────────────────────────────────────────────────────────
// Only their description is stored; their tracks are asked for each time (shared/smart.ts).
// When the library or the plays change, those whose result changed are announced like any edit.

function parseSmart(json: string | null): SmartSpec | null {
  if (!json) return null;
  try {
    return cleanSpec(JSON.parse(json));
  } catch {
    return cleanSpec({}); // unreadable: still a smart playlist, of the whole library
  }
}

/** Runs the query of a description on these columns (compiled once per distinct query text). */
function smartRows<T>(columns: string, spec: SmartSpec): T[] {
  const q = smartQuery(spec, fold, Date.now());
  return getDb().prepare(`SELECT ${columns} FROM tracks ${q.sql}`).all(...q.params) as T[];
}

const smartTracks = (spec: SmartSpec): Track[] => smartRows<TrackRow>(TRACK_COLUMNS, spec).map((r) => rowToTrack(r));

interface SmartSum {
  /** The first ones. */
  ids: string[];
  count: number;
  durationSec: number;
  covers: { source: string; cover_ref: string }[];
  /** Changes when the tracks or their order do. */
  signature: string;
}
/** The last result of each: the list of playlists does not run every query again. */
const sums = new Map<number, SmartSum>();

function summarise(spec: SmartSpec): SmartSum {
  const rows = smartRows<{ id: string; duration_sec: number | null; cover_ref: string | null }>('id, duration_sec, cover_ref', spec);
  const hash = createHash('sha1');
  const refs = new Set<string>();
  let durationSec = 0;
  for (const r of rows) {
    hash.update(r.id).update('\n');
    durationSec += r.duration_sec ?? 0;
    if (r.cover_ref) refs.add(r.cover_ref);
  }
  return { ids: rows.slice(0, 5).map((r) => r.id), count: rows.length, durationSec, covers: [...refs].map((cover_ref) => ({ source: 'local', cover_ref })), signature: hash.digest('hex') };
}

function smartSummary(id: number, spec: SmartSpec): SmartSum {
  let s = sums.get(id);
  if (!s) sums.set(id, (s = summarise(spec)));
  return s;
}

let smartTimer: ReturnType<typeof setTimeout> | undefined;
let smartDue = 0;
/** The library or the plays changed: smart playlists are looked at again, in a moment. */
export function refreshSmart(delay = 1500): void {
  const due = Date.now() + delay;
  if (smartTimer && smartDue <= due && delay > 1500) return; // during a scan: at most every 10 s
  clearTimeout(smartTimer);
  smartDue = due;
  smartTimer = setTimeout(() => void (async () => {
    smartTimer = undefined;
    try {
      for (const r of sql('SELECT id, smart FROM playlists WHERE smart IS NOT NULL').all() as { id: number; smart: string }[]) {
        const before = sums.get(r.id);
        const now = summarise(parseSmart(r.smart)!);
        sums.set(r.id, now);
        if (before?.signature !== now.signature) emit(r.id);
        await new Promise((next) => setImmediate(next)); // a very large library: one at a time
      }
    } catch (e) {
      log('warn', 'smart', e instanceof Error ? e.message : String(e)); // the database closes on quit
    }
  })(), delay);
}

/** Dates go by too ("in the last 30 days"): looked at again every half hour. */
const clock = setInterval(() => refreshSmart(0), 1_800_000);
clock.unref();

export function shutdownPlaylists(): void {
  clearInterval(clock);
  clearTimeout(smartTimer);
}

export function createSmart(name: string, raw: unknown): number {
  const spec = cleanSpec(raw) ?? cleanSpec({})!;
  const now = Date.now();
  const id = Number(sql('INSERT INTO playlists (name, created_at, updated_at, smart) VALUES (?, ?, ?, ?)').run(name.trim() || tr('smart.new'), now, now, JSON.stringify(spec)).lastInsertRowid);
  emit(id);
  return id;
}

export function setSmart(id: number, raw: unknown): void {
  const spec = cleanSpec(raw);
  if (!spec) throw new Error(tr('main.plNotFound'));
  // only a playlist that is smart already: the entries of another one are never hidden this way
  const r = sql('UPDATE playlists SET smart = ?, updated_at = ? WHERE id = ? AND smart IS NOT NULL').run(JSON.stringify(spec), Date.now(), id);
  if (!r.changes) throw new Error(tr('main.plNotFound'));
  sums.delete(id);
  emit(id);
}

export function previewSmart(raw: unknown): { count: number; durationSec: number; sample: Track[] } {
  const spec = cleanSpec(raw) ?? cleanSpec({})!;
  const { count, durationSec, ids } = summarise(spec);
  const get = sql(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`);
  return { count, durationSec, sample: ids.map((id) => rowToTrack(get.get(id) as unknown as TrackRow)) };
}

// ── Pictures chosen by hand ──────────────────────────────────────────────────────────────
// The image is copied (the original is never touched): it stays when the original goes.

export const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] as const;
const MAX_COVER = 20 * 1024 * 1024;

/** What the file really is, whatever its name says. */
function imageType(b: Buffer): string | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.toString('latin1', 0, 2) === 'BM') return 'bmp';
  return null;
}

export async function setCover(id: number, path: string): Promise<void> {
  const row = sql('SELECT cover FROM playlists WHERE id = ?').get(id) as { cover: string | null } | undefined;
  if (!row) throw new Error(tr('main.plNotFound'));
  if ((await stat(path)).size > MAX_COVER) throw new Error(tr('main.imageTooBig'));
  const data = await readFile(path);
  const type = imageType(data);
  if (!type) throw new Error(tr('main.notAnImage'));
  const name = `${id}-${createHash('sha1').update(data).digest('hex').slice(0, 16)}.${type}`;
  await writeFileAtomic(join(playlistCoversDir(), name), data);
  sql('UPDATE playlists SET cover = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  if (row.cover && row.cover !== name) dropCoverFile(row.cover);
  emit(id);
}

export function clearCover(id: number): void {
  const row = sql('SELECT cover FROM playlists WHERE id = ?').get(id) as { cover: string | null } | undefined;
  if (!row?.cover) return;
  sql('UPDATE playlists SET cover = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
  dropCoverFile(row.cover);
  emit(id);
}

/** Only ever a copy Chud Music made, in its own folder. */
function dropCoverFile(name: string): void {
  if (!/^\d+-[0-9a-f]{16}\.\w+$/.test(name)) return;
  rmSync(join(playlistCoversDir(), name), { force: true });
  // and its small copies, which nothing else would ever remove
  try {
    const thumbs = cacheDir('thumbs');
    for (const f of readdirSync(thumbs)) if (isPlaylistThumb(f, name)) rmSync(join(thumbs, f), { force: true });
  } catch {
    /* no thumbnail folder yet, or a copy in use: harmless, nothing links to it any more */
  }
  forgetThumbs();
}

export function rename(id: number, name: string): void {
  const clean = name.trim();
  if (!clean) throw new Error(tr('main.nameEmpty'));
  sql('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(clean, Date.now(), id);
  emit(id);
}

export function remove(id: number): void {
  const row = sql('SELECT cover FROM playlists WHERE id = ?').get(id) as { cover: string | null } | undefined;
  sums.delete(id);
  tx(() => {
    sql('DELETE FROM playlists WHERE id = ?').run(id); // entries cascade
    sql('DELETE FROM tracks WHERE in_library = 0 AND id NOT IN (SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history)').run();
  });
  if (row?.cover) dropCoverFile(row.cover);
  emit(id);
}

/** Settings › Playlists › Delete all playlists (asked twice in the interface). */
export function removeAll(): number {
  const all = sql('SELECT id, cover FROM playlists').all() as { id: number; cover: string | null }[];
  const ids = all.map((r) => r.id);
  sums.clear();
  tx(() => {
    sql('DELETE FROM playlists').run(); // entries cascade
    sql('DELETE FROM tracks WHERE in_library = 0 AND id NOT IN (SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history)').run();
  });
  for (const r of all) if (r.cover) dropCoverFile(r.cover);
  for (const id of ids) emit(id);
  return ids.length;
}

function insertTracks(id: number, tracks: Track[], index: number, now: number): void {
  if (!tracks.length) return;
  const d = getDb();
  d.prepare('UPDATE playlist_items SET position = position + ? WHERE playlist_id = ? AND position >= ?').run(tracks.length, id, index);
  const ins = d.prepare('INSERT INTO playlist_items (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)');
  tracks.forEach((t, i) => ins.run(id, index + i, ensureTrackRow(t, now), now));
}

export function addTracks(id: number, tracks: Track[], index?: number): void {
  tx(() => {
    assertExists(id);
    const count = (sql('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(id) as { n: number }).n;
    insertTracks(id, tracks, Math.max(0, Math.min(index ?? count, count)), Date.now());
    touch(id);
  });
  emit(id);
}

function renumber(id: number, entryIds: number[]): void {
  const up = sql('UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?');
  entryIds.forEach((e, i) => up.run(i, e, id));
}

export function removeEntries(id: number, entryIds: number[]): void {
  tx(() => {
    assertExists(id);
    const del = sql('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?');
    for (const e of entryIds) del.run(e, id);
    const rest = (sql('SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position').all(id) as { id: number }[]).map((r) => r.id);
    renumber(id, rest);
    touch(id);
  });
  emit(id);
}

// ── YouTube Music entries → the same song in the library ──────────────────────────────────
// A local file plays without the network and in full quality: the playlist's "…" menu offers to
// put them in place of the YouTube Music entries. Same title (normalised: accents, "(Official
// Video)", "feat." left out), one artist in common, durations within 5 s when both are known,
// and never a live/remix/cover version for the original or the other way round.

/** "A, B & C feat. D" → the names, normalised ("ArtistVEVO", "Artist - Topic" → "artist"). */
const artistsOf = (...names: (string | null)[]) =>
  new Set(names.flatMap((n) => (n ?? '').split(/\s*(?:,|;|&|\/|\bx\b|\bfeat\.?|\bft\.?)\s*/i)).map((a) => norm(a.replace(/vevo$|\s-\s*topic$/i, ''))).filter(Boolean));

export interface LocalSwap {
  entryId: number;
  from: Track;
  to: Track;
}

export function localSwaps(id: number): LocalSwap[] {
  const entries = (get(id)?.tracks ?? []).filter((t) => t.source === 'youtube');
  if (!entries.length) return [];
  const byTitle = new Map<string, TrackRow[]>();
  for (const r of sql(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE source = 'local' AND in_library = 1 AND available = 1`).all() as unknown as TrackRow[]) {
    const k = norm(r.title);
    const list = byTitle.get(k);
    if (list) list.push(r);
    else byTitle.set(k, [r]);
  }
  // another recording (a "(Lyrics)" or "(Official Video)" upload is the same one)
  const altered = (s: string) => s.toLowerCase().match(/\b(?:cover|karaoke|instrumental|nightcore|sped up|slowed|reverb|8d|remix|live|acoustic|acustic\w*|demo|unplugged)\b/)?.[0] ?? '';
  const swaps: LocalSwap[] = [];
  for (const yt of entries) {
    const who = artistsOf(yt.artist);
    let best: TrackRow | null = null;
    let bestGap = Infinity;
    for (const r of byTitle.get(norm(yt.title)) ?? []) {
      if (altered(r.title) !== altered(yt.title)) continue;
      if (![...artistsOf(r.artist, r.album_artist)].some((a) => who.has(a))) continue;
      const gap = yt.durationSec && r.duration_sec ? Math.abs(yt.durationSec - r.duration_sec) : 0;
      if (gap > 5 || gap >= bestGap) continue;
      best = r;
      bestGap = gap;
    }
    if (best) swaps.push({ entryId: yt.entryId!, from: yt, to: rowToTrack(best) });
  }
  return swaps;
}

/** Puts these local tracks in place of the entries (position kept); only local library tracks. */
export function applySwaps(id: number, swaps: { entryId: number; trackId: string }[]): number {
  let n = 0;
  tx(() => {
    assertExists(id);
    const up = sql('UPDATE playlist_items SET track_id = ? WHERE id = ? AND playlist_id = ?');
    for (const s of swaps) {
      if (!sql("SELECT 1 FROM tracks WHERE id = ? AND source = 'local' AND in_library = 1").get(s.trackId)) continue;
      n += Number(up.run(s.trackId, s.entryId, id).changes);
    }
    sql('DELETE FROM tracks WHERE in_library = 0 AND id NOT IN (SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history)').run();
    touch(id);
  });
  emit(id);
  return n;
}

export function reorder(id: number, entryIds: number[]): void {
  tx(() => {
    assertExists(id);
    const current = (sql('SELECT id FROM playlist_items WHERE playlist_id = ?').all(id) as { id: number }[]).map((r) => r.id);
    // Refuse anything that is not exactly a permutation: a stale UI must never lose entries.
    const wanted = new Set(entryIds);
    if (current.length !== entryIds.length || wanted.size !== entryIds.length || !current.every((e) => wanted.has(e))) throw new Error(tr('main.badOrder'));
    renumber(id, entryIds);
    touch(id);
  });
  emit(id);
}

// ── Export / import ──────────────────────────────────────────────────────────────────────

interface ExportedTrack {
  source: Track['source'];
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  path?: string;
  videoId?: string;
  coverUrl?: string | null;
}

interface ChudPlaylistFile {
  format: 'chud-music-playlists';
  version: 1;
  exportedAt: string;
  /** `smart`: the description of a smart playlist; its `tracks` are those of the moment, for the
   *  readers that do not know it (Chud Music < 1.4, Chud Music More). */
  playlists: { name: string; tracks: ExportedTrack[]; smart?: SmartSpec }[];
}

const exportable = (t: Track): ExportedTrack => ({
  source: t.source, title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec,
  ...(t.source === 'local' ? { path: t.path } : { videoId: t.videoId, coverUrl: t.coverUrl }),
});

export function exportJson(ids: number[], file: string): void {
  const data: ChudPlaylistFile = {
    format: 'chud-music-playlists',
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists: ids.map((id) => get(id)!).filter(Boolean).map((p) => ({ name: p.name, tracks: p.tracks.map(exportable), ...(p.smart ? { smart: p.smart } : {}) })),
  };
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function exportM3u(id: number, file: string): { skipped: number } {
  const p = get(id);
  if (!p) throw new Error(tr('main.plNotFound'));
  const lines = ['#EXTM3U', `#PLAYLIST:${p.name}`];
  let skipped = 0;
  for (const t of p.tracks) {
    const secs = Math.round(t.durationSec ?? -1);
    const label = `${t.artist ? `${t.artist} - ` : ''}${t.title}`;
    if (t.source === 'local' && t.path) lines.push(`#EXTINF:${secs},${label}`, t.path);
    else if (t.videoId) lines.push(`#EXTINF:${secs},${label}`, `https://music.youtube.com/watch?v=${t.videoId}`);
    else skipped++;
  }
  writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
  return { skipped };
}

/** Imports one file; resolves to the number of playlists created. */
export async function importFile(file: string): Promise<number> {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (/\.json$/i.test(file)) {
    const data = JSON.parse(text) as ChudPlaylistFile;
    if (data.format !== 'chud-music-playlists') throw new Error(tr('main.notChudJson'));
    for (const p of data.playlists) {
      const spec = p.smart ? cleanSpec(p.smart) : null;
      if (spec) {
        createSmart(p.name, spec);
        continue;
      }
      const tracks = p.tracks
        .filter((t) => (t.source === 'local' ? !!t.path : !!t.videoId))
        .map((t): Track => ({ ...t, id: '', available: true, coverUrl: t.source === 'youtube' ? t.coverUrl ?? null : null }));
      create(p.name, tracks);
    }
    return data.playlists.length;
  }
  // M3U / M3U8: local paths (relative to the playlist file) and YouTube Music links
  const base = dirname(file);
  const name = /#PLAYLIST:(.+)/.exec(text)?.[1]?.trim() ?? file.split(/[\\/]/).pop()!.replace(/\.m3u8?$/i, '');
  const tracks: Track[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // the same reading as a pasted link (shared/links.ts): not a pattern found anywhere in the line
    const videoId = m3uVideoId(line);
    if (videoId) {
      tracks.push({ id: '', source: 'youtube', videoId, title: tr('main.ytTrack'), artist: null, album: null, durationSec: null, coverUrl: null, available: true });
      continue;
    }
    const path = isAbsolute(line) ? line : resolve(base, line);
    try {
      tracks.push(metaToTrack(await readFileMeta(path, cacheDir('covers'))));
    } catch {
      // missing file: keep it in the playlist, flagged unavailable, rather than silently dropping it
      tracks.push({ id: '', source: 'local', path, title: path.split(/[\\/]/).pop()!, artist: null, album: null, durationSec: null, coverUrl: null, available: false });
    }
  }
  create(name, tracks);
  return 1;
}
