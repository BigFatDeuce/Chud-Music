import { createHash } from 'node:crypto';
import type { LyricsQuery, LyricsResult } from '@shared/types';
import { kvGet, kvSet } from './db';
import { log } from './log';
import { tr } from '@shared/i18n';

// Lyrics from LRCLIB (https://lrclib.net): a free, open database of lyrics, many of them
// time-synced (LRC). No account, no key. Exact lookup first (title, artist, album, duration),
// then a search. Results are cached locally; "not found" is cached for a week, then retried.

const API = 'https://lrclib.net/api';
const UA = 'Chud Music (https://github.com/BigFatDeuce/Chud-Music)';
const NOT_FOUND_TTL = 7 * 24 * 3600 * 1000;

/** YouTube titles carry noise: "(Official Video)", "[Lyrics]", "feat. X"; channels end in " - Topic". */
export function cleanQuery(q: LyricsQuery): LyricsQuery {
  const title = q.title
    .replace(/\s*[([](official|lyrics?|audio|video|clip|hd|hq|4k|visuali[sz]er|remaster(ed)?|explicit|paroles|clip officiel)[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([]?\s*(feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]?/gi, '')
    .trim();
  const artist = (q.artist ?? '')
    .replace(/\s+-\s+Topic$/i, '')
    .split(/,|&| x | feat\.? | ft\.? /i)[0]!
    .trim();
  // "Artist - Title" in the title itself (common on YouTube)
  const dash = /^(.+?)\s+[-–]\s+(.+)$/.exec(title);
  if (dash && (!artist || dash[1]!.toLowerCase().includes(artist.toLowerCase()))) return { ...q, artist: dash[1]!.trim(), title: dash[2]!.trim() };
  return { ...q, title, artist: artist || null };
}

interface LrclibRecord {
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

async function call<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return (await res.json()) as T;
}

const toResult = (r: LrclibRecord, q: LyricsQuery): LyricsResult => ({
  status: r.instrumental ? 'instrumental' : r.syncedLyrics ? 'synced' : r.plainLyrics ? 'plain' : 'not-found',
  synced: r.syncedLyrics,
  plain: r.plainLyrics,
  matched: { title: r.trackName, artist: r.artistName, album: r.albumName },
  query: q,
  source: 'LRCLIB',
});

export async function getLyrics(raw: LyricsQuery, force = false): Promise<LyricsResult> {
  const q = cleanQuery(raw);
  const key = `lyrics:${createHash('sha1').update(`${q.artist ?? ''}|${q.title}`.toLowerCase()).digest('hex').slice(0, 20)}`;
  const cached = kvGet<LyricsResult & { at: number }>(key);
  if (cached && !force && (cached.status !== 'not-found' || Date.now() - cached.at < NOT_FOUND_TTL)) return cached;
  try {
    let found: LrclibRecord | null = null;
    if (q.artist) {
      found = await call<LrclibRecord>('get', {
        track_name: q.title,
        artist_name: q.artist,
        ...(q.album ? { album_name: q.album } : {}),
        ...(q.durationSec ? { duration: String(Math.round(q.durationSec)) } : {}),
      });
    }
    if (!found) {
      const list = (await call<LrclibRecord[]>('search', q.artist ? { track_name: q.title, artist_name: q.artist } : { q: q.title })) ?? [];
      // closest duration first (when known), synced lyrics preferred
      const score = (r: LrclibRecord) => (q.durationSec && r.duration ? Math.abs(r.duration - q.durationSec) : 0) + (r.syncedLyrics ? 0 : 3);
      found = list.filter((r) => r.plainLyrics || r.syncedLyrics || r.instrumental).filter((r) => !q.durationSec || !r.duration || Math.abs(r.duration - q.durationSec) < 20).sort((a, b) => score(a) - score(b))[0] ?? null;
    }
    const result: LyricsResult = found ? toResult(found, q) : { status: 'not-found', synced: null, plain: null, matched: null, query: q, source: 'LRCLIB' };
    kvSet(key, { ...result, at: Date.now() });
    return result;
  } catch (e) {
    log('warn', 'lyrics', `${q.artist} — ${q.title}: ${e instanceof Error ? e.message : e}`);
    return { status: 'error', synced: null, plain: null, matched: null, query: q, source: 'LRCLIB', error: /fetch|timeout|ENOTFOUND/i.test(String(e)) ? tr('net.lrclib') : String(e) };
  }
}
