// Smart playlists: a description (rules, exclusions, order, size), and the SQL that answers it.
// Nothing is stored but the description: the tracks are asked for again each time, so the
// playlist follows the library by itself. Pure and without imports: tests/unit/smart.mjs loads
// this file as it is. The query expects a `fold(text)` SQL function (accents and case ignored).

export type SmartTextField = 'title' | 'artist' | 'album' | 'genre' | 'folder';
export type SmartNumberField = 'year' | 'plays' | 'duration';
export type SmartDateField = 'added' | 'played';
export type SmartField = SmartTextField | SmartNumberField | SmartDateField;

export type SmartTextOp = 'contains' | 'notContains' | 'is' | 'isNot' | 'empty';
export type SmartNumberOp = 'eq' | 'gte' | 'lte' | 'unknown';
/** 'played' also takes 'never' and 'ever'; 'before' = longer ago than (and, for 'played', played once). */
export type SmartDateOp = 'within' | 'before' | 'never' | 'ever';
export type SmartOp = SmartTextOp | SmartNumberOp | SmartDateOp;

/** value: text, a number (duration: minutes; dates: days), or nothing (empty, unknown, never, ever). */
export interface SmartRule {
  field: SmartField;
  op: SmartOp;
  value: string | number | null;
}

export type SmartOrder = 'added' | 'plays' | 'played' | 'title' | 'artist' | 'album' | 'year' | 'duration' | 'random';

export interface SmartSpec {
  /** All the rules, or at least one of them. No rule: the whole library. */
  match: 'all' | 'any';
  rules: SmartRule[];
  /** A track that answers any of these is left out… */
  exclude: SmartRule[];
  /** …and so are these tracks, taken out by hand. */
  excludeIds: string[];
  order: SmartOrder;
  desc: boolean;
  /** At most this many tracks (null: no limit). */
  limit: number | null;
}

export const SMART_FIELDS: readonly SmartField[] = ['genre', 'artist', 'album', 'title', 'folder', 'year', 'plays', 'added', 'played', 'duration'];
export const SMART_ORDERS: readonly SmartOrder[] = ['added', 'plays', 'played', 'title', 'artist', 'album', 'year', 'duration', 'random'];

export function opsOf(field: SmartField): readonly SmartOp[] {
  switch (field) {
    case 'year':
    case 'plays':
    case 'duration':
      return field === 'plays' ? ['eq', 'gte', 'lte'] : ['eq', 'gte', 'lte', 'unknown'];
    case 'added':
      return ['within', 'before'];
    case 'played':
      return ['never', 'ever', 'within', 'before'];
    default:
      return ['contains', 'notContains', 'is', 'isNot', 'empty'];
  }
}

export const needsValue = (op: SmartOp): boolean => op !== 'empty' && op !== 'unknown' && op !== 'never' && op !== 'ever';

/** What a new rule on this field starts with. */
export function defaultRule(field: SmartField): SmartRule {
  const op = opsOf(field)[0]!;
  const value = !needsValue(op) ? null : field === 'year' ? 2000 : field === 'plays' ? 0 : field === 'duration' ? 3 : field === 'added' ? 30 : '';
  return { field, op, value };
}

/** The ready-made playlists. */
export type SmartPreset = 'never' | 'rediscover' | 'recent' | 'most' | 'custom';
export function presetSpec(preset: SmartPreset, days = 182): SmartSpec {
  const base: SmartSpec = { match: 'all', rules: [], exclude: [], excludeIds: [], order: 'added', desc: true, limit: null };
  switch (preset) {
    case 'never':
      return { ...base, rules: [{ field: 'played', op: 'never', value: null }] };
    case 'rediscover':
      // the longest forgotten first
      return { ...base, rules: [{ field: 'played', op: 'before', value: days }], order: 'played', desc: false };
    case 'recent':
      return { ...base, rules: [{ field: 'added', op: 'within', value: 30 }] };
    case 'most':
      return { ...base, rules: [{ field: 'plays', op: 'gte', value: 1 }], order: 'plays', limit: 100 };
    default:
      return { ...base, rules: [defaultRule('genre')] };
  }
}

const FIELDS = new Set<string>(SMART_FIELDS);
const ORDERS = new Set<string>(SMART_ORDERS);

function cleanRule(r: unknown): SmartRule | null {
  if (!r || typeof r !== 'object') return null;
  const { field, op, value } = r as Record<string, unknown>;
  if (typeof field !== 'string' || !FIELDS.has(field)) return null;
  const f = field as SmartField;
  if (typeof op !== 'string' || !(opsOf(f) as readonly string[]).includes(op)) return null;
  const o = op as SmartOp;
  if (!needsValue(o)) return { field: f, op: o, value: null };
  if (opsOf(f).includes('contains')) {
    const text = typeof value === 'string' ? value.trim().slice(0, 200) : typeof value === 'number' ? String(value) : '';
    return text ? { field: f, op: o, value: text } : null;
  }
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? { field: f, op: o, value: n } : null;
}

/** A description read from outside (database, import, interface): what is not valid is left out. */
export function cleanSpec(x: unknown): SmartSpec | null {
  if (!x || typeof x !== 'object') return null;
  const s = x as Record<string, unknown>;
  const rules = (v: unknown) => (Array.isArray(v) ? v.map(cleanRule).filter((r): r is SmartRule => r !== null).slice(0, 50) : []);
  const limit = Number(s.limit);
  return {
    match: s.match === 'any' ? 'any' : 'all',
    rules: rules(s.rules),
    exclude: rules(s.exclude),
    excludeIds: Array.isArray(s.excludeIds) ? s.excludeIds.filter((i): i is string => typeof i === 'string') : [],
    order: typeof s.order === 'string' && ORDERS.has(s.order) ? (s.order as SmartOrder) : 'added',
    desc: s.desc !== false,
    limit: s.limit !== null && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : null,
  };
}

const DAY = 86_400_000;
/** A prime under 2³¹: the products below stay exact integers in SQLite. */
const P = 2_147_483_647;
const TEXT: Record<SmartTextField, string> = {
  title: 'title',
  // a track's artist or its album's: "artist is X" finds an album whose tracks name guests
  artist: "COALESCE(artist, '') || char(10) || COALESCE(album_artist, '')",
  album: 'album',
  genre: 'genre',
  folder: 'path',
};

type Param = string | number;

const likeSafe = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function condition(r: SmartRule, fold: (s: string) => string, now: number, params: Param[]): string {
  switch (r.field) {
    case 'year':
    case 'plays':
    case 'duration': {
      const col = r.field === 'year' ? 'year' : r.field === 'plays' ? 'play_count' : 'duration_sec';
      if (r.op === 'unknown') return `(${col} IS NULL OR ${col} = 0)`;
      const n = Number(r.value) * (r.field === 'duration' ? 60 : 1);
      // "= 3 minutes" means 3:00 to 3:59
      if (r.op === 'eq' && r.field === 'duration') {
        params.push(n, n + 60);
        return `(${col} >= ? AND ${col} < ?)`;
      }
      params.push(n);
      const cmp = r.op === 'eq' ? '=' : r.op === 'gte' ? '>=' : '<=';
      // an unknown year or length (empty) answers no comparison
      return r.field === 'plays' ? `(${col} ${cmp} ?)` : `(${col} IS NOT NULL AND ${col} > 0 AND ${col} ${cmp} ?)`;
    }
    case 'added':
      params.push(now - Number(r.value) * DAY);
      return r.op === 'within' ? '(added_at >= ?)' : '(added_at < ?)';
    case 'played':
      if (r.op === 'never') return '(play_count = 0 AND last_played_at IS NULL)';
      if (r.op === 'ever') return '(play_count > 0 OR last_played_at IS NOT NULL)';
      params.push(now - Number(r.value) * DAY);
      return r.op === 'within' ? '(last_played_at >= ?)' : '(last_played_at < ?)';
    default: {
      const col = TEXT[r.field];
      if (r.op === 'empty') return r.field === 'artist' ? "(COALESCE(artist, '') = '' AND COALESCE(album_artist, '') = '')" : `(COALESCE(${col}, '') = '')`;
      const text = fold(String(r.value));
      const value = `fold(COALESCE(${col}, ''))`;
      if (r.op === 'contains' || r.op === 'notContains') {
        params.push(`%${likeSafe(text)}%`);
        return `(${value} ${r.op === 'contains' ? '' : 'NOT '}LIKE ? ESCAPE '\\')`;
      }
      // 'is': the whole value (one of the two names for an artist)
      params.push(`${'\n'}${text}${'\n'}`);
      return `(INSTR(char(10) || ${value} || char(10), ?) ${r.op === 'is' ? '>' : '='} 0)`;
    }
  }
}

const ORDER_SQL: Record<Exclude<SmartOrder, 'random'>, (d: string) => string> = {
  added: (d) => `added_at ${d}, album, disc_no, track_no`,
  plays: (d) => `play_count ${d}, last_played_at ${d}`,
  played: (d) => `last_played_at IS NULL, last_played_at ${d}`,
  title: (d) => `title COLLATE NOCASE ${d}`,
  artist: (d) => `COALESCE(album_artist, artist) IS NULL, COALESCE(album_artist, artist) COLLATE NOCASE ${d}, album COLLATE NOCASE, disc_no, track_no`,
  album: (d) => `album IS NULL, album COLLATE NOCASE ${d}, disc_no, track_no`,
  year: (d) => `year IS NULL, year ${d}, album COLLATE NOCASE, disc_no, track_no`,
  duration: (d) => `duration_sec IS NULL, duration_sec ${d}`,
};

/**
 * The end of "SELECT … FROM tracks …" for this description, with its parameters. Random order is
 * the same all day long (the list does not jump at each refresh) and changes the next day.
 */
export function smartQuery(spec: SmartSpec, fold: (s: string) => string, now: number): { sql: string; params: Param[] } {
  const params: Param[] = [];
  const where = ["source = 'local'", 'in_library = 1', 'available = 1'];
  if (spec.rules.length) where.push(`(${spec.rules.map((r) => condition(r, fold, now, params)).join(spec.match === 'any' ? ' OR ' : ' AND ')})`);
  // an unknown value (NULL) answers no rule: it never leaves a track out
  for (const r of spec.exclude) where.push(`NOT COALESCE(${condition(r, fold, now, params)}, 0)`);
  if (spec.excludeIds.length) {
    where.push('id NOT IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(spec.excludeIds));
  }
  let order: string;
  if (spec.order === 'random') {
    const h = (Math.imul(Math.floor(now / DAY) + 1, 0x9e3779b1) >>> 1) % P;
    order = `(((rowid * rowid) % ${P} * ? + rowid * ?) % ${P})`;
    params.push(h + 1, (h * 48_271) % P + 1);
  } else order = ORDER_SQL[spec.order](spec.desc ? 'DESC' : 'ASC');
  let text = `WHERE ${where.join(' AND ')} ORDER BY ${order}, id`;
  if (spec.limit) {
    text += ' LIMIT ?';
    params.push(spec.limit);
  }
  return { sql: text, params };
}
