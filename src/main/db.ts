import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { backupsDir, userDataDir } from './paths';

// SQLite through Node's built-in driver (no native module to rebuild for Electron/Linux).
// WAL + transactions keep playlists safe on a crash; every schema upgrade is preceded by a
// full backup so an update can never cost the user their data.

const MIGRATIONS: string[] = [
  // v1 — base schema
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE tracks (
    id            TEXT PRIMARY KEY,               -- local:<path> | yt:<videoId>
    source        TEXT NOT NULL CHECK (source IN ('local', 'youtube')),
    path          TEXT,                           -- local only
    file_size     INTEGER,
    mtime_ms      INTEGER,
    yt_video_id   TEXT,                           -- youtube only
    title         TEXT NOT NULL,
    artist        TEXT,
    album         TEXT,
    album_artist  TEXT,
    duration_sec  REAL,
    codec         TEXT,
    cover_ref     TEXT,
    available     INTEGER NOT NULL DEFAULT 1,
    added_at      INTEGER NOT NULL,
    last_played_at INTEGER,
    play_count    INTEGER NOT NULL DEFAULT 0,
    CHECK ((source = 'local' AND path IS NOT NULL AND yt_video_id IS NULL)
        OR (source = 'youtube' AND yt_video_id IS NOT NULL AND path IS NULL))
  );
  CREATE INDEX tracks_artist ON tracks(artist);
  CREATE INDEX tracks_album ON tracks(album);
  CREATE INDEX tracks_added ON tracks(added_at);

  CREATE TABLE library_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);

  CREATE TABLE playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- position-ordered; the same track may appear several times (rowid keeps entries distinct)
  CREATE TABLE playlist_items (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    track_id    TEXT NOT NULL REFERENCES tracks(id),
    added_at    INTEGER NOT NULL
  );
  CREATE INDEX playlist_items_order ON playlist_items(playlist_id, position);

  CREATE TABLE play_history (track_id TEXT NOT NULL, played_at INTEGER NOT NULL, context TEXT);
  CREATE INDEX play_history_time ON play_history(played_at);
  `,
  // v2 — library columns; playlist entries get a stable id (duplicates, drag & drop)
  `
  ALTER TABLE tracks ADD COLUMN in_library INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tracks ADD COLUMN track_no INTEGER;
  ALTER TABLE tracks ADD COLUMN disc_no INTEGER;
  ALTER TABLE tracks ADD COLUMN year INTEGER;
  ALTER TABLE tracks ADD COLUMN genre TEXT;
  CREATE INDEX tracks_in_library ON tracks(in_library);
  CREATE INDEX tracks_path ON tracks(path);

  CREATE TABLE playlist_items_v2 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    track_id    TEXT NOT NULL REFERENCES tracks(id),
    added_at    INTEGER NOT NULL
  );
  INSERT INTO playlist_items_v2 (playlist_id, position, track_id, added_at)
    SELECT playlist_id, position, track_id, added_at FROM playlist_items ORDER BY playlist_id, position;
  DROP TABLE playlist_items;
  ALTER TABLE playlist_items_v2 RENAME TO playlist_items;
  CREATE INDEX playlist_items_order ON playlist_items(playlist_id, position);
  CREATE INDEX playlist_items_track ON playlist_items(track_id);
  `,
  // v3 — files the user removed from the library (by path: rescans must not bring them back)
  `
  CREATE TABLE library_exclusions (path TEXT PRIMARY KEY COLLATE NOCASE, excluded_at INTEGER NOT NULL);
  `,
  // v4 — seconds actually listened, by day / hour / track (radio included), for the statistics.
  // A snapshot of title/artist/album is kept: radio stations and YouTube tracks may have no row.
  `
  CREATE TABLE listen_log (
    day     TEXT NOT NULL,
    hour    INTEGER NOT NULL,
    key     TEXT NOT NULL,
    source  TEXT NOT NULL,
    title   TEXT NOT NULL,
    artist  TEXT,
    album   TEXT,
    seconds INTEGER NOT NULL,
    PRIMARY KEY (day, hour, key)
  );
  CREATE INDEX listen_log_day ON listen_log(day);
  `,
  // v5 — covers found online for local files without one (Library › … › Find missing covers).
  // Kept apart from tracks.cover_ref, which a rescan rewrites from the file itself.
  `
  CREATE TABLE found_covers (
    track_id TEXT PRIMARY KEY,
    ref      TEXT NOT NULL,
    kind     TEXT NOT NULL,
    found_at INTEGER NOT NULL
  );
  `,
  // v6 — speed. The scan looks paths up case-insensitively (one lookup per file found: without
  // this index, each one read the whole table); history lookups by track (which tracks are still
  // referenced, recently played).
  `
  CREATE INDEX tracks_path_nocase ON tracks(path COLLATE NOCASE);
  CREATE INDEX play_history_track ON play_history(track_id, played_at);
  `,
  // v7 — tracks taken out of "Recently played" / "Recently added" by hand (right-click). The
  // history and the library stay as they are (stats keep counting); a track played again, or
  // added again, after `at` comes back.
  `
  CREATE TABLE recent_hidden (
    track_id TEXT NOT NULL,
    list     TEXT NOT NULL,
    at       INTEGER NOT NULL,
    PRIMARY KEY (track_id, list)
  );
  `,
  // v8 — a library folder can be left unscanned (Settings › Library): its tracks stay as they
  // are, nothing reads the folder (no startup scan, no watcher, not in Rescan).
  `
  ALTER TABLE library_folders ADD COLUMN scan INTEGER NOT NULL DEFAULT 1;
  `,
  // v9 — playlists: a picture chosen by hand (a file of the app's own folder), and smart playlists
  // (their description as JSON, shared/smart.ts; no items of their own). Loudness of local files
  // (volume normalisation), kept apart from the tracks: files opened one by one have one too.
  `
  ALTER TABLE playlists ADD COLUMN cover TEXT;
  ALTER TABLE playlists ADD COLUMN smart TEXT;
  CREATE TABLE loudness (
    track_id   TEXT PRIMARY KEY,
    stamp      TEXT NOT NULL,                     -- size:mtime of the file it is about
    track_gain REAL,
    track_peak REAL,
    album_gain REAL,
    album_peak REAL,
    source     TEXT NOT NULL
  );
  `,
];

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not open');
  return db;
}

// Prepared once, reused: the same queries run thousands of times (scans, reloads, plays).
const statements = new Map<string, StatementSync>();
/** A prepared statement for this SQL, compiled on first use. */
export function sql(text: string): StatementSync {
  let st = statements.get(text);
  if (!st) {
    st = getDb().prepare(text);
    statements.set(text, st);
  }
  return st;
}

/** Runs `fn` in a transaction; rolls back on error. */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Accents and case ignored (smart playlists; also an SQL function of that name). */
// A smart playlist asks this of every track of the library: plain text takes the short way, and
// what comes back often (artists, genres) is remembered.
const folded = new Map<string, string>();
export function fold(s: string): string {
  let f = folded.get(s);
  if (f === undefined) {
    // eslint-disable-next-line no-control-regex
    f = /^[\x00-\x7f]*$/.test(s) ? s.toLowerCase() : s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    if (folded.size > 20_000) folded.clear();
    folded.set(s, f);
  }
  return f;
}

const KEEP_BACKUPS = 5;
let db: DatabaseSync | null = null;

export function openDatabase(): DatabaseSync {
  const file = join(userDataDir(), 'chud.db');
  const existed = existsSync(file);
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  db.function('fold', { deterministic: true }, (s) => fold(String(s ?? '')));

  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current < MIGRATIONS.length) {
    if (existed && current > 0) backup(db, current);
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec('BEGIN');
      try {
        db.exec(MIGRATIONS[v]!);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  }
  db.exec(WATCH_TRACKS);
  return db;
}

// Which tracks changed since the interface last asked (library.ts, changes()): it is sent those,
// never the whole library again. Kept by the database itself, so no write can be forgotten;
// temporary: it is empty at each start, when the interface reads everything.
const WATCHED = ['path', 'file_size', 'title', 'artist', 'album', 'album_artist', 'duration_sec', 'codec', 'cover_ref', 'available', 'added_at', 'last_played_at', 'play_count', 'in_library', 'track_no', 'disc_no', 'year', 'genre'];
const WATCH_TRACKS = `
  CREATE TEMP TABLE changed_tracks (id TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TEMP TRIGGER tracks_in AFTER INSERT ON main.tracks BEGIN INSERT OR IGNORE INTO changed_tracks VALUES (NEW.id); END;
  CREATE TEMP TRIGGER tracks_out AFTER DELETE ON main.tracks BEGIN INSERT OR IGNORE INTO changed_tracks VALUES (OLD.id); END;
  CREATE TEMP TRIGGER tracks_up AFTER UPDATE ON main.tracks WHEN ${WATCHED.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ')}
    BEGIN INSERT OR IGNORE INTO changed_tracks VALUES (NEW.id); END;
  CREATE TEMP TRIGGER covers_in AFTER INSERT ON main.found_covers BEGIN INSERT OR IGNORE INTO changed_tracks VALUES (NEW.track_id); END;
  CREATE TEMP TRIGGER covers_up AFTER UPDATE ON main.found_covers BEGIN INSERT OR IGNORE INTO changed_tracks VALUES (NEW.track_id); END;
  CREATE TEMP TRIGGER covers_out AFTER DELETE ON main.found_covers BEGIN INSERT OR IGNORE INTO changed_tracks VALUES (OLD.track_id); END;
`;

function backup(d: DatabaseSync, version: number): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupsDir(), `chud-v${version}-${stamp}.db`);
  d.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const old = readdirSync(backupsDir()).filter((f) => f.endsWith('.db')).sort().reverse().slice(KEEP_BACKUPS);
  for (const f of old) rmSync(join(backupsDir(), f), { force: true });
}

export function kvGet<T>(key: string): T | null {
  const row = sql('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function kvSet(key: string, value: unknown): void {
  sql('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function closeDatabase(): void {
  statements.clear();
  db?.close();
  db = null;
}
