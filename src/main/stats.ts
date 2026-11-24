import type { ListenTick, Stats, StatsPeriod, TrackStats } from '@shared/types';
import { sql } from './db';

// Listening statistics. Two sources:
//  • play_history: a play counted after 30 s (or half a short track), since step 4;
//  • listen_log: seconds actually listened, by day, hour and track (radio included), since v4.
// Everything stays in the local database.

const DAY = 86400_000;
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function recordListening(t: ListenTick): void {
  if (!t.key || !(t.seconds > 0) || t.seconds > 120) return;
  const now = Date.now();
  sql(
      `INSERT INTO listen_log (day, hour, key, source, title, artist, album, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, hour, key) DO UPDATE SET seconds = seconds + excluded.seconds, title = excluded.title, artist = excluded.artist`,
    )
    .run(dayKey(now), new Date(now).getHours(), t.key, t.source, t.title, t.artist ?? null, t.album ?? null, Math.round(t.seconds));
}

/** History of one track and of its artist (the track card in the docked player bar). */
export function getTrackStats(id: string, artist: string | null): TrackStats {
  const h = sql('SELECT COUNT(*) AS n, MIN(played_at) AS first FROM play_history WHERE track_id = ?').get(id) as { n: number; first: number | null };
  const s = (sql('SELECT SUM(seconds) AS s FROM listen_log WHERE key = ?').get(id) as { s: number | null }).s ?? 0;
  const a = artist ? ((sql('SELECT SUM(seconds) AS s FROM listen_log WHERE artist = ? COLLATE NOCASE').get(artist) as { s: number | null }).s ?? 0) : 0;
  return { plays: h.n, seconds: s, artistSeconds: a, firstAt: h.first };
}

export function getStats(period: StatsPeriod): Stats {
  const since = period === 'all' ? 0 : Date.now() - (period === '7d' ? 7 : period === '30d' ? 30 : 365) * DAY;
  const sinceDay = period === 'all' ? '0000' : dayKey(since);
  const q = <T>(text: string, ...args: (string | number)[]) => sql(text).all(...args) as T[];
  const one = <T>(text: string, ...args: (string | number)[]) => sql(text).get(...args) as T;

  const seconds = one<{ s: number | null }>('SELECT SUM(seconds) AS s FROM listen_log WHERE day >= ?', sinceDay).s ?? 0;
  const bySource = q<{ source: string; s: number }>('SELECT source, SUM(seconds) AS s FROM listen_log WHERE day >= ? GROUP BY source', sinceDay);
  const plays = one<{ n: number }>('SELECT COUNT(*) AS n FROM play_history WHERE played_at >= ?', since).n;
  const distinct = one<{ n: number }>('SELECT COUNT(DISTINCT track_id) AS n FROM play_history WHERE played_at >= ?', since).n;
  const days = q<{ day: string; s: number }>('SELECT day, SUM(seconds) AS s FROM listen_log GROUP BY day ORDER BY day');
  const daysInPeriod = days.filter((d) => d.day >= sinceDay);

  // streaks over all time (a day counts with at least one minute)
  const listened = new Set(days.filter((d) => d.s >= 60).map((d) => d.day));
  let current = 0;
  for (let t = Date.now(); listened.has(dayKey(t)) || (current === 0 && dayKey(t) === dayKey(Date.now())); t -= DAY) {
    if (listened.has(dayKey(t))) current++;
    else if (dayKey(t) !== dayKey(Date.now())) break;
    if (current > 3650) break;
  }
  let longest = 0;
  let run = 0;
  let prev = 0;
  for (const d of [...listened].sort()) {
    const t = new Date(`${d}T12:00:00`).getTime();
    run = prev && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }

  const topTracksByPlays = q<{ title: string; artist: string | null; album: string | null; source: string; n: number }>(
    `SELECT t.title, t.artist, t.album, t.source, COUNT(*) AS n FROM play_history h JOIN tracks t ON t.id = h.track_id
     WHERE h.played_at >= ? GROUP BY h.track_id ORDER BY n DESC, MAX(h.played_at) DESC LIMIT 10`,
    since,
  );
  const topTracksByTime = q<{ title: string; artist: string | null; source: string; s: number }>(
    `SELECT title, artist, source, SUM(seconds) AS s FROM listen_log WHERE day >= ? AND source != 'radio' GROUP BY key ORDER BY s DESC LIMIT 10`,
    sinceDay,
  );
  const topArtists = q<{ name: string; s: number; tracks: number }>(
    `SELECT artist AS name, SUM(seconds) AS s, COUNT(DISTINCT key) AS tracks FROM listen_log
     WHERE day >= ? AND source != 'radio' AND artist IS NOT NULL AND artist != '' GROUP BY lower(artist) ORDER BY s DESC LIMIT 10`,
    sinceDay,
  );
  const topAlbums = q<{ name: string; artist: string | null; s: number }>(
    `SELECT album AS name, MAX(artist) AS artist, SUM(seconds) AS s FROM listen_log
     WHERE day >= ? AND source != 'radio' AND album IS NOT NULL AND album != '' GROUP BY lower(album) ORDER BY s DESC LIMIT 10`,
    sinceDay,
  );
  const topStations = q<{ name: string; s: number }>(
    `SELECT title AS name, SUM(seconds) AS s FROM listen_log WHERE day >= ? AND source = 'radio' GROUP BY key ORDER BY s DESC LIMIT 5`,
    sinceDay,
  );
  const hours = Array.from({ length: 24 }, () => 0);
  for (const r of q<{ hour: number; s: number }>('SELECT hour, SUM(seconds) AS s FROM listen_log WHERE day >= ? GROUP BY hour', sinceDay)) hours[r.hour] = r.s;
  const weekdays = Array.from({ length: 7 }, () => 0); // Monday first
  for (const d of daysInPeriod) weekdays[(new Date(`${d.day}T12:00:00`).getDay() + 6) % 7]! += d.s;
  const best = [...daysInPeriod].sort((a, b) => b.s - a.s)[0] ?? null;
  const discovered = one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM (SELECT track_id, MIN(played_at) AS first FROM play_history GROUP BY track_id) WHERE first >= ?',
    since,
  ).n;
  const library = one<{ n: number; s: number | null }>('SELECT COUNT(*) AS n, SUM(duration_sec) AS s FROM tracks WHERE in_library = 1');
  const playlists = one<{ n: number }>('SELECT COUNT(*) AS n FROM playlists').n;
  const measuredSince = one<{ d: string | null }>('SELECT MIN(day) AS d FROM listen_log').d;

  return {
    period,
    seconds,
    bySource: { local: bySource.find((r) => r.source === 'local')?.s ?? 0, youtube: bySource.find((r) => r.source === 'youtube')?.s ?? 0, radio: bySource.find((r) => r.source === 'radio')?.s ?? 0 },
    plays,
    distinctTracks: distinct,
    activeDays: daysInPeriod.filter((d) => d.s >= 60).length,
    streak: { current, longest },
    bestDay: best ? { day: best.day, seconds: best.s } : null,
    discovered,
    topTracksByPlays: topTracksByPlays.map((r) => ({ title: r.title, artist: r.artist, source: r.source, value: r.n })),
    topTracksByTime: topTracksByTime.map((r) => ({ title: r.title, artist: r.artist, source: r.source, value: r.s })),
    topArtists: topArtists.map((r) => ({ title: r.name, artist: `${r.tracks} titre${r.tracks > 1 ? 's' : ''}`, source: 'local', value: r.s })),
    topAlbums: topAlbums.map((r) => ({ title: r.name, artist: r.artist, source: 'local', value: r.s })),
    topStations: topStations.map((r) => ({ title: r.name, artist: null, source: 'radio', value: r.s })),
    hours,
    weekdays,
    library: { tracks: library.n, seconds: library.s ?? 0, playlists },
    measuredSince,
  };
}
