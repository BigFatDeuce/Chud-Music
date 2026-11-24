import type { PlayerSnapshot, SavedPlayer, SavedTrack, Track } from '@shared/types';
import { sql } from './db';
import { rowToTrack, TRACK_COLUMNS, type TrackRow } from './tracks';

// What was playing, saved as ids (the database has the tracks), read back as tracks.

function hydrate(saved: SavedTrack[]): (Track | null)[] {
  return saved.map((s) => {
    if (typeof s === 'object' && !Array.isArray(s)) return s;
    const [id, entryId] = Array.isArray(s) ? s : [s];
    const row = sql(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`).get(id) as unknown as TrackRow | undefined;
    return row ? { ...rowToTrack(row), ...(entryId !== undefined ? { entryId } : {}) } : null;
  });
}

/** Longer lists come back in two steps: what is around the place, then the rest (mostly tracks of
 *  the library, which the interface has by then). */
const LONG = 1500;
const BEFORE = 50;
const AFTER = 450;
let pending: SavedPlayer | null = null;

export function loadPlayer(s: SavedPlayer): PlayerSnapshot {
  pending = null;
  if (s.tracks.length <= LONG) return hydratePlayer(s);
  pending = s;
  const start = Math.max(0, s.pos - BEFORE);
  const around = s.order.slice(start, s.pos + AFTER);
  return { ...hydratePlayer({ ...s, tracks: around.map((i) => s.tracks[i]!), order: around.map((_, i) => i), pos: s.pos - start }), partial: true };
}

export function playerRest(): { tracks: SavedTrack[]; order: number[] } | null {
  const s = pending;
  pending = null;
  return s && { tracks: s.tracks, order: s.order };
}

export const playerTracks = (ids: string[]): (Track | null)[] => hydrate(ids);

/** The snapshot as the interface takes it; a track gone since is left out (the place follows). */
function hydratePlayer(s: SavedPlayer): PlayerSnapshot {
  const all = hydrate(s.tracks);
  const upNext = hydrate(s.upNext ?? []).filter((t): t is Track => t !== null);
  if (!all.includes(null)) return { ...s, tracks: all as Track[], upNext };
  const at = new Map<number, number>();
  const tracks: Track[] = [];
  all.forEach((t, i) => {
    if (!t) return;
    at.set(i, tracks.length);
    tracks.push(t);
  });
  const here = s.order[s.pos];
  const kept = (i: number) => at.has(i);
  const order = s.order.filter(kept).map((i) => at.get(i)!);
  // the track itself is gone: the one that followed it, from its start
  const stays = here !== undefined && kept(here);
  const pos = Math.max(0, Math.min(order.length - 1, s.order.slice(0, s.pos).filter(kept).length));
  return { ...s, tracks, order, pos, time: stays ? s.time : 0, upNext };
}
