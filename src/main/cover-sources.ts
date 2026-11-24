import { net } from 'electron';
import { tr } from '@shared/i18n';
import { norm, similarity } from './youtube';

// Where "Find missing covers" looks: public music catalogues with a documented search that
// needs no account and no key, asked one after the other until one knows the album:
//
//   Deezer   api.deezer.com   — albums, songs and artist pictures (1000 px)
//   iTunes   itunes.apple.com — albums and songs (600 px), when Deezer does not know
//
// (Not YouTube Music any more: its unofficial search is slower, changes without notice and
// refuses requests after a few hundred albums.) Only the artist, album and title tags of the
// files without cover are sent, and only when the search is started by hand.
//
// A source that answers "too many requests" is left alone for a minute: the search goes on with
// the other one, and an album nobody could be asked about is not marked "?" — it is looked for
// again next time. No connection at all stops the search (CoverSourceError).

export class CoverSourceError extends Error {}

export interface WantedCover {
  album: string | null;
  artist: string | null;
  title: string;
  durationSec: number | null;
}

/** `url`: the picture; `asked`: at least one source answered (found or not). */
export interface CoverAnswer {
  url: string | null;
  asked: boolean;
}

type Json = Record<string, unknown>;

class Busy extends Error {}

// CHUD_TEST_COVERS (tests only): 'busy' — every catalogue answers "too many requests";
// 'offline' — none can be reached; 'empty' — they answer and know nothing. No request is made.
// CHUD_TEST_COVERS_REST_MS shortens the rest.
const restMs = () => Number(process.env.CHUD_TEST_COVERS_REST_MS) || 60_000;
const resting = new Map<string, number>();
let failures = 0;

async function getJson(source: string, url: string): Promise<Json | null> {
  const test = process.env.CHUD_TEST_COVERS;
  if (test === 'busy') throw new Busy(source);
  if (test === 'offline') throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
  if (test === 'empty') return {};
  const res = await net.fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 403 || res.status === 429 || res.status === 503) throw new Busy(source);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as Json | null;
  // Deezer says "quota exceeded" in the body of a 200
  const err = body?.error as { code?: number } | undefined;
  if (err) {
    if (err.code === 4) throw new Busy(source);
    return null;
  }
  return body;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const q = encodeURIComponent;

/** Same title (or very close) by the same artist: the rule of the former YouTube Music lookup. */
function best<T extends { title: string; artist: string; url: string }>(found: T[], title: string, artist: string | null): T | null {
  return (
    found
      .filter((a) => a.url)
      .map((a) => {
        const t = norm(a.title) === norm(title) ? 1 : similarity(a.title, title);
        const by = !artist ? 0.5 : a.artist && (norm(a.artist).includes(norm(artist)) || norm(artist).includes(norm(a.artist))) ? 1 : similarity(a.artist, artist);
        return { a, s: t * 0.65 + by * 0.35, t, by };
      })
      .filter((x) => x.t >= 0.75 && x.by >= 0.5)
      .sort((x, y) => y.s - x.s)[0]?.a ?? null
  );
}

/** Deezer puts a grey placeholder where it has no picture: its address has an empty name. */
const deezerPic = (u: unknown): string => (/\/images\/(cover|artist)\/\//.test(str(u)) ? '' : str(u));
/** iTunes gives a 100 px address; the same picture exists in 600 px. */
const itunesPic = (u: unknown): string => str(u).replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1');

interface Source {
  name: string;
  album(album: string, artist: string | null): Promise<string | null>;
  song(title: string, artist: string, durationSec: number | null): Promise<string | null>;
  artist?(name: string): Promise<string | null>;
}

const deezer: Source = {
  name: 'Deezer',
  async album(album, artist) {
    const read = async (query: string) =>
      list((await getJson('Deezer', `https://api.deezer.com/search/album?q=${q(query)}&limit=10`))?.data).map((a) => ({ title: str(a.title), artist: str((a.artist as Json | undefined)?.name), url: deezerPic(a.cover_xl ?? a.cover_big) }));
    // exact fields first, then free words (tags are rarely written as the catalogue writes them)
    const strict = artist ? best(await read(`artist:"${artist}" album:"${album}"`), album, artist) : null;
    return (strict ?? best(await read([album, artist].filter(Boolean).join(' ')), album, artist))?.url ?? null;
  },
  async song(title, artist, durationSec) {
    const found = list((await getJson('Deezer', `https://api.deezer.com/search/track?q=${q(`artist:"${artist}" track:"${title}"`)}&limit=10`))?.data)
      .filter((t) => !durationSec || !t.duration || Math.abs(Number(t.duration) - durationSec) <= 30)
      .map((t) => ({ title: str(t.title), artist: str((t.artist as Json | undefined)?.name), url: deezerPic((t.album as Json | undefined)?.cover_xl ?? (t.album as Json | undefined)?.cover_big) }));
    return best(found, title, artist)?.url ?? null;
  },
  async artist(name) {
    const found = list((await getJson('Deezer', `https://api.deezer.com/search/artist?q=${q(name)}&limit=5`))?.data);
    // the same name only: a picture of somebody else is worse than none
    return deezerPic(found.find((a) => norm(str(a.name)) === norm(name) && deezerPic(a.picture_xl ?? a.picture_big))?.picture_xl) || null;
  },
};

const itunes: Source = {
  name: 'iTunes',
  async album(album, artist) {
    const found = list((await getJson('iTunes', `https://itunes.apple.com/search?term=${q([album, artist].filter(Boolean).join(' '))}&media=music&entity=album&limit=10`))?.results).map((a) => ({
      title: str(a.collectionName),
      artist: str(a.artistName),
      url: itunesPic(a.artworkUrl100),
    }));
    return best(found, album, artist)?.url ?? null;
  },
  async song(title, artist, durationSec) {
    const found = list((await getJson('iTunes', `https://itunes.apple.com/search?term=${q(`${title} ${artist}`)}&media=music&entity=song&limit=10`))?.results)
      .filter((t) => !durationSec || !t.trackTimeMillis || Math.abs(Number(t.trackTimeMillis) / 1000 - durationSec) <= 30)
      .map((t) => ({ title: str(t.trackName), artist: str(t.artistName), url: itunesPic(t.artworkUrl100) }));
    return best(found, title, artist)?.url ?? null;
  },
};

const SOURCES = [deezer, itunes];

/** Asks each source in turn; a busy one rests, an unreachable network stops everything. */
async function ask(fn: (s: Source) => Promise<string | null> | undefined): Promise<CoverAnswer> {
  let asked = false;
  for (const s of SOURCES) {
    if ((resting.get(s.name) ?? 0) > Date.now()) continue;
    const call = fn(s);
    if (!call) continue;
    try {
      const url = await call;
      asked = true;
      failures = 0;
      if (url) return { url, asked };
    } catch (e) {
      if (e instanceof Busy) {
        resting.set(s.name, Date.now() + restMs());
        continue;
      }
      // one source out of reach is skipped; the network itself being down stops the search
      if (++failures >= SOURCES.length) {
        failures = 0;
        throw new CoverSourceError(tr('net.covers'));
      }
    }
  }
  return { url: null, asked };
}

/** The cover of an album, else (single track, or no album tag) of the song itself. */
export async function findCover(want: WantedCover, single: boolean): Promise<CoverAnswer> {
  const album = want.album ? await ask((s) => s.album(want.album!, want.artist)) : { url: null, asked: true };
  if (album.url || !want.artist || (want.album && !single)) return album;
  const song = await ask((s) => s.song(want.title, want.artist!, want.durationSec));
  return { url: song.url, asked: album.asked && song.asked };
}

/** A picture of the artist (the same name only). */
export function findArtistPicture(name: string): Promise<CoverAnswer> {
  return ask((s) => s.artist?.(name));
}

/** Every source is resting: nothing can be asked for a moment. */
export function coverSourcesResting(): number {
  const now = Date.now();
  const left = SOURCES.map((s) => (resting.get(s.name) ?? 0) - now);
  return left.every((ms) => ms > 0) ? Math.min(...left) : 0;
}
