import { net } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic-write';
import { join } from 'node:path';
import type { CoverStatus } from '@shared/types';
import { coversMachine, coversRunning, type CoversEvent, type CoversPhase } from '@shared/machines';
import { tx, sql } from './db';
import { log } from './log';
import { cacheDir } from './paths';
import { forgetThumbs } from './protocol';
import { CoverSourceError, coverSourcesResting, findArtistPicture, findCover, type CoverAnswer } from './cover-sources';
import { tr } from '@shared/i18n';

// Covers for local files that have none (Library › … › Find missing covers).
//
// Looked up in public music catalogues (cover-sources.ts: Deezer, then iTunes): the album's
// cover, else the song's, else a picture of the artist, else a "?" image. The pictures are kept
// in Chud Music's own cache folder (covers/found) and linked to the tracks in the database
// (found_covers): nothing is ever written into the music folders, and the files themselves are
// not touched. A rescan does not lose them (the cover of the file itself, if one appears later,
// always wins). "Remove found covers" deletes exactly these pictures and links.

const SUB = 'found';
const UNKNOWN = `${SUB}/unknown.svg`;
const UNKNOWN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#1c1f26"/><text x="100" y="138" font-family="Segoe UI, Ubuntu, Cantarell, sans-serif" font-size="120" font-weight="700" text-anchor="middle" fill="#6b7280">?</text></svg>`;

const dir = () => cacheDir('covers', SUB);

let found: Map<string, string> | null = null;
/** The found cover of a track (cover_ref relative to the covers cache), if any. */
export function foundCoverRef(trackId: string): string | undefined {
  found ??= new Map((sql("SELECT track_id, ref FROM found_covers WHERE kind != 'removed'").all() as { track_id: string; ref: string }[]).map((r) => [r.track_id, r.ref]));
  return found.get(trackId);
}

// The search is a machine (shared/machines.ts, coversMachine): `phase` is its only state,
// changed in go(); `running` and `error`, which the interface reads, follow from it.
let phase: CoversPhase = coversMachine.initial;
const status: CoverStatus = { running: false, done: 0, total: 0, album: 0, artist: 0, none: 0, error: null };
let emit: (channel: 'library:changed' | 'covers:status', payload?: unknown) => void = () => {};

export function initCovers(e: typeof emit): void {
  emit = e;
}

export function coverStatus(): CoverStatus & { saved: number } {
  return { ...status, saved: (sql("SELECT COUNT(*) AS n FROM found_covers WHERE kind != 'removed'").get() as { n: number }).n };
}

function set(patch: Partial<CoverStatus>): void {
  Object.assign(status, patch);
  emit('covers:status', coverStatus());
}

/** Takes an event; false when the current state does not take it. */
function go(event: CoversEvent, error: string | null = null): boolean {
  const next = coversMachine.next(phase, event);
  if (!next) return false;
  phase = next;
  set({ running: coversRunning(phase), error: phase === 'failed' ? error : null });
  return true;
}
/** Still searching (asked again after each wait: "stop" may have come meanwhile). */
const searching = () => phase === 'searching';

const fold = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

interface Row {
  id: string;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  duration_sec: number | null;
}

async function download(url: string): Promise<string | null> {
  if (!/^https:\/\//i.test(url)) return null;
  const name = `${SUB}/${createHash('sha1').update(url).digest('hex').slice(0, 24)}.jpg`;
  const out = join(cacheDir('covers'), name);
  if (existsSync(out)) return name;
  const res = await net.fetch(url);
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
  writeFileAtomicSync(out, buf);
  return name;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Looks for the covers of every library track without one (the "?" ones are tried again).
 * Tracks are grouped by album (same album artist, album and folder): one search per album.
 */
export async function findMissing(): Promise<void> {
  if (!coversMachine.can(phase, 'START')) return;
  const rows = sql(
      `SELECT id, path, title, artist, album, album_artist, duration_sec FROM tracks
       WHERE source = 'local' AND in_library = 1 AND cover_ref IS NULL
         AND id NOT IN (SELECT track_id FROM found_covers WHERE kind != 'none')`,
    )
    .all() as unknown as Row[];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const folder = r.path.replace(/[\\/][^\\/]*$/, '');
    const key = r.album ? `a|${fold(r.album_artist ?? r.artist)}|${fold(r.album)}|${fold(folder)}` : `s|${r.id}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  Object.assign(status, { done: 0, total: groups.size, album: 0, artist: 0, none: 0 });
  go('START');
  const artists = new Map<string, CoverAnswer>();
  const save = (ids: string[], ref: string, kind: 'album' | 'artist' | 'none') => {
    tx(() => {
      const st = sql('INSERT OR REPLACE INTO found_covers (track_id, ref, kind, found_at) VALUES (?, ?, ?, ?)');
      for (const id of ids) st.run(id, ref, kind, Date.now());
    });
    found = null;
  };
  let n = 0;
  let unanswered = 0;
  let failure: string | null = null;
  try {
    dir(); // creates covers/found
    writeFileSync(join(cacheDir('covers'), UNKNOWN), UNKNOWN_SVG);
    for (const g of groups.values()) {
      // every catalogue asked for a rest ("too many requests"): wait for the first one back
      for (let left = coverSourcesResting(); left > 0 && searching(); left = coverSourcesResting()) await pause(Math.min(left, 1000));
      if (!searching()) break;
      const first = g[0]!;
      const artist = first.album_artist ?? first.artist;
      let ref: string | null = null;
      let kind: 'album' | 'artist' | 'none' = 'none';
      // the album, else (single track, or no album tag) the song itself
      const cover = await findCover({ album: first.album, artist, title: first.title, durationSec: first.duration_sec }, g.length === 1);
      let asked = cover.asked;
      if (cover.url) {
        ref = await download(cover.url).catch(() => null);
        if (ref) kind = 'album';
      }
      // else a picture of the artist (one search per artist)
      if (!ref && artist) {
        const k = fold(artist);
        if (!artists.has(k)) artists.set(k, await findArtistPicture(artist));
        const pic = artists.get(k)!;
        asked &&= pic.asked;
        if (pic.url) {
          ref = await download(pic.url).catch(() => null);
          if (ref) kind = 'artist';
        }
        // not answered this time: asked again for the next album of this artist
        if (!pic.asked) artists.delete(k);
      }
      // "?" only when the catalogues answered and none knew: an album nobody could be asked
      // about (a catalogue resting) is left as it is, and looked for again by the next search
      if (ref || asked) {
        save(g.map((r) => r.id), ref ?? UNKNOWN, ref ? kind : 'none');
        status[ref ? kind : 'none']++;
        unanswered = 0;
      } else if (++unanswered >= 3) {
        // three albums in a row nobody could be asked about, rests included: the catalogues are
        // not answering today — stop rather than wait for ever
        throw new CoverSourceError(tr('net.covers'));
      }
      set({ done: ++n });
      if (n % 20 === 0) emit('library:changed');
      await pause(150); // gentle with the catalogues
    }
  } catch (e) {
    // offline, or no catalogue answering: stop here, nothing is marked "?" for that
    failure = e instanceof Error ? e.message : String(e);
    log('warn', 'covers', failure);
  } finally {
    // whatever happened, the search is over (never left "running")
    go(failure === null ? 'DONE' : 'FAIL', failure);
    emit('library:changed');
  }
}

export function cancelFind(): void {
  go('STOP');
}

/**
 * Right-click › Remove the found cover, on some tracks. The track is marked "removed" (no cover,
 * and the next search leaves it alone: the cover was wrong); a picture no other track uses any
 * more is deleted with its small copies. "Remove found covers" (all) clears these marks too.
 */
export function removeFoundFor(trackIds: string[]): number {
  const refs = new Set<string>();
  let n = 0;
  tx(() => {
    for (const id of trackIds) {
      const r = sql("SELECT ref FROM found_covers WHERE track_id = ? AND kind != 'removed'").get(id) as { ref: string } | undefined;
      if (!r) continue;
      refs.add(r.ref);
      sql("UPDATE found_covers SET kind = 'removed', found_at = ? WHERE track_id = ?").run(Date.now(), id);
      n++;
    }
  });
  found = null;
  const thumbs = cacheDir('thumbs');
  for (const ref of refs) {
    if (ref === UNKNOWN || sql("SELECT 1 FROM found_covers WHERE ref = ? AND kind != 'removed' LIMIT 1").get(ref)) continue;
    const stem = ref.replace(/^.*\//, '').replace(/\.\w+$/, '');
    for (const f of [join(cacheDir('covers'), ref), ...readdirSync(thumbs).filter((f) => f.replace(/^\d+-/, '').replace(/\.\w+$/, '') === stem).map((f) => join(thumbs, f))]) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* in use: harmless, nothing links to it any more */
      }
    }
  }
  if (refs.size) forgetThumbs();
  if (n) {
    emit('covers:status', coverStatus());
    emit('library:changed');
  }
  return n;
}

/** Deletes every cover found by the tool (its own pictures only) and their links. */
export function removeFound(): number {
  go('STOP');
  const n = (sql('SELECT COUNT(*) AS n FROM found_covers').get() as { n: number }).n;
  sql('DELETE FROM found_covers').run();
  found = null;
  const d = dir();
  const mine = readdirSync(d);
  const stems = new Set(mine.map((f) => f.replace(/\.\w+$/, '')));
  const thumbs = cacheDir('thumbs');
  const gone = [...mine.map((f) => join(d, f)), ...readdirSync(thumbs).filter((f) => stems.has(f.replace(/^\d+-/, '').replace(/\.\w+$/, ''))).map((f) => join(thumbs, f))];
  for (const f of gone) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* in use: removed next time */
    }
  }
  forgetThumbs();
  set({ album: 0, artist: 0, none: 0, done: 0, total: 0 });
  emit('library:changed');
  return n;
}
