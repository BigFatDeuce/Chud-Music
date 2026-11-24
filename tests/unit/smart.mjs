// Smart playlists (src/shared/smart.ts), without the app: the query is run on a real SQLite
// database with the same columns, so what is checked is what comes out.
//   node tests/unit/smart.mjs
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function load(file) {
  const js = stripTypeScriptTypes(readFileSync(new URL(`../../src/shared/${file}`, import.meta.url), 'utf8'));
  const out = join(mkdtempSync(join(tmpdir(), 'chud-unit-')), file.replace(/\.ts$/, '.mjs'));
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}
const { smartQuery, presetSpec, cleanSpec, opsOf, defaultRule, SMART_FIELDS, SMART_ORDERS } = await load('smart.ts');

let failed = 0;
let count = 0;
const check = (label, ok, detail = '') => {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const NOW = Date.UTC(2026, 10, 22);
const DAY = 86_400_000;
const db = new DatabaseSync(':memory:');
db.function('fold', { deterministic: true }, fold);
db.exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, source TEXT, path TEXT, title TEXT, artist TEXT, album TEXT, album_artist TEXT, genre TEXT, year INTEGER,
  duration_sec REAL, play_count INTEGER, last_played_at INTEGER, added_at INTEGER, in_library INTEGER, available INTEGER, disc_no INTEGER, track_no INTEGER)`);
const add = (id, o = {}) => {
  const r = { source: 'local', path: `C:\\m\\${id}.mp3`, title: id, artist: 'Groupe', album: 'Disque', album_artist: null, genre: 'Rock', year: 2000, duration_sec: 200, play_count: 0, last_played_at: null, added_at: NOW - 400 * DAY, in_library: 1, available: 1, disc_no: 1, track_no: 1, ...o };
  db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, r.source, r.path, r.title, r.artist, r.album, r.album_artist, r.genre, r.year, r.duration_sec, r.play_count, r.last_played_at, r.added_at, r.in_library, r.available, r.disc_no, r.track_no);
};
add('a', { genre: 'Électro', year: 1999, play_count: 10, last_played_at: NOW - 2 * DAY, duration_sec: 185 });
add('b', { genre: 'electro house', year: 2005, play_count: 3, last_played_at: NOW - 200 * DAY, duration_sec: 60 });
add('c', { genre: 'Rock', year: 2010, added_at: NOW - 5 * DAY });
add('d', { genre: 'Jazz', year: null, artist: 'Invité', album_artist: 'Grand Orchestre', play_count: 7, last_played_at: NOW - 400 * DAY, duration_sec: 600 });
add('e', { genre: null, year: 1980, title: '100% pur_jus', added_at: NOW - 29 * DAY });
add('gone', { available: 0 });
add('out', { in_library: 0 });

const run = (spec) => {
  const q = smartQuery(cleanSpec(spec), fold, NOW);
  return db.prepare(`SELECT id FROM tracks ${q.sql}`).all(...q.params).map((r) => r.id);
};
const set = (a) => [...a].sort().join('');
const one = (field, op, value) => set(run({ rules: [{ field, op, value }] }));
const is = (label, got, want) => check(label, got === want, got === want ? '' : `${got} ≠ ${want}`);

is('no rule: the whole library, without missing files or tracks out of it', set(run({})), 'abcde');
is('genre contains, accents and case ignored', one('genre', 'contains', 'ÉLECTRO'), 'ab');
is('genre is', one('genre', 'is', 'electro'), 'a');
is('genre is not', one('genre', 'isNot', 'electro'), 'bcde');
is('genre does not contain', one('genre', 'notContains', 'electro'), 'cde');
is('genre empty', one('genre', 'empty', null), 'e');
is('artist is: the album artist counts too', one('artist', 'is', 'grand orchestre'), 'd');
is('artist is: not part of a name', one('artist', 'is', 'orchestre'), '');
is('% and _ are plain characters', one('title', 'contains', '100% pur_'), 'e');
is('…which do not match anything else', one('title', 'contains', '%'), 'e');
is('folder contains', one('folder', 'contains', 'c:\\m\\b'), 'b');
is('year at least', one('year', 'gte', 2005), 'bc');
is('year at most leaves unknown years out', one('year', 'lte', 1999), 'ae');
is('year unknown', one('year', 'unknown', null), 'd');
is('plays at least', one('plays', 'gte', 5), 'ad');
is('plays = 0', one('plays', 'eq', 0), 'ce');
is('duration = 3 minutes is 3:00 to 3:59', one('duration', 'eq', 3), 'ace');
is('duration at most 1 minute', one('duration', 'lte', 1), 'b');
is('added in the last 30 days', one('added', 'within', 30), 'ce');
is('added longer ago', one('added', 'before', 30), 'abd');
is('never played', one('played', 'never', null), 'ce');
is('played once at least', one('played', 'ever', null), 'abd');
is('played within', one('played', 'within', 30), 'a');
is('not played for 6 months (but played once)', one('played', 'before', 182), 'bd');
is('all the rules', set(run({ match: 'all', rules: [{ field: 'genre', op: 'contains', value: 'electro' }, { field: 'year', op: 'gte', value: 2000 }] })), 'b');
is('any of the rules', set(run({ match: 'any', rules: [{ field: 'genre', op: 'is', value: 'jazz' }, { field: 'year', op: 'lte', value: 1980 }] })), 'de');
is('exclusions, rule by rule', set(run({ exclude: [{ field: 'genre', op: 'contains', value: 'electro' }, { field: 'plays', op: 'gte', value: 5 }] })), 'ce');
is('exclusion "any", with a rule that compares unknown years: NULL never hides a track', set(run({ exclude: [{ field: 'year', op: 'gte', value: 2005 }] })), 'ade');
is('exclusion by last play: never played tracks stay', set(run({ exclude: [{ field: 'played', op: 'within', value: 30 }] })), 'bcde');
is('tracks left out by hand', set(run({ excludeIds: ['a', 'c'] })), 'bde');
is('order by plays', run({ order: 'plays', desc: true }).slice(0, 3).join(''), 'adb');
is('order by last play, oldest first, unplayed last', run({ order: 'played', desc: false }).join('').slice(0, 3), 'dba');
is('order by year, unknown last both ways', run({ order: 'year', desc: true }).at(-1) + run({ order: 'year', desc: false }).at(-1), 'dd');
is('maximum number of tracks, after ordering', run({ order: 'plays', desc: true, limit: 2 }).join(''), 'ad');
const r1 = run({ order: 'random' }).join('');
is('random order is stable', run({ order: 'random' }).join(''), r1);
check('…and whole', set(r1) === 'abcde');
check('…and not the natural one for ever', new Set([0, 1, 2, 3, 4, 5].map((d) => { const q = smartQuery(cleanSpec({ order: 'random' }), fold, NOW + d * DAY); return db.prepare(`SELECT id FROM tracks ${q.sql}`).all(...q.params).map((r) => r.id).join(''); })).size > 1);

is('preset: never played', set(run(presetSpec('never'))), 'ce');
is('preset: rediscover 6 months', run(presetSpec('rediscover', 182)).join(''), 'db');
is('preset: rediscover 1 year', run(presetSpec('rediscover', 365)).join(''), 'd');
is('preset: recently added', set(run(presetSpec('recent'))), 'ce');
is('preset: most played, in order', run(presetSpec('most')).join(''), 'adb');

// whatever is stored or imported, the query stays valid
for (const f of SMART_FIELDS)
  for (const op of opsOf(f)) {
    let ok = true;
    try {
      run({ rules: [{ field: f, op, value: 5 }], exclude: [{ field: f, op, value: "x' OR 1=1 --" }] });
    } catch (e) {
      ok = String(e);
    }
    check(`query for ${f} ${op}`, ok === true, ok === true ? '' : ok);
  }
for (const o of SMART_ORDERS) check(`order ${o}`, run({ order: o }).length === 5 && run({ order: o, desc: false }).length === 5);
const junk = cleanSpec({ rules: [{ field: 'nope', op: 'is', value: 1 }, { field: 'year', op: 'contains', value: 1 }, { field: 'genre', op: 'is', value: '  ' }, { field: 'year', op: 'gte', value: 'abc' }, null], order: 'DROP TABLE', limit: -3 });
check('invalid rules, order and size are left out', junk.rules.length === 0 && junk.order === 'added' && junk.limit === null);
check('nothing at all is not a description', cleanSpec(null) === null && cleanSpec('x') === null);
check('every field starts with a rule of its own', SMART_FIELDS.every((f) => defaultRule(f).field === f));

console.log(`\n[smart] ${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
