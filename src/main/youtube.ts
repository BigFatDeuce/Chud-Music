import { randomUUID } from 'node:crypto';
import { Innertube } from 'youtubei.js';
import type { Track, YtAlbumItem, YtAlbumPage, YtArtistItem, YtArtistPage, YtMix, YtSearchResult, YtSearchType, YtLinkImport, WantedTrack } from '@shared/types';
import type { MusicLink } from '@shared/links';
import { tr } from '@shared/i18n';
import { isHidden } from './yt-hidden';

// YouTube Music public catalogue through InnerTube (youtubei.js, unofficial: the user chose
// "Option B"). No account, no cookies, no player/stream data: only metadata, and playback
// always goes through YouTube's official embedded player. Everything is mapped here into our
// own types so the UI never sees YouTube's structures (and a provider swap stays local).

// youtubei.js node classes are loosely typed for our needs: read them through this shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

let client: Promise<Innertube> | null = null;
function yt(): Promise<Innertube> {
  client ??= Innertube.create({ retrieve_player: false, lang: 'fr', location: 'FR' }).catch((e) => {
    client = null; // retry on next call (offline at first try…)
    throw e;
  });
  return client;
}

/** A user-facing message instead of InnerTube internals. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LinkError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|network/i.test(msg)) throw new Error(tr('net.ytm'));
    throw new Error(tr('yt.unexpected', { detail: msg.slice(0, 120) }));
  }
}

const text = (v: Node): string | null => (v == null ? null : typeof v === 'string' ? v : (v.text ?? null)) || null;

/** Largest thumbnail; YouTube Music image URLs are resized server-side, so ask for 544 px. */
function cover(thumbs: Node): string | null {
  const list: Node[] = Array.isArray(thumbs) ? thumbs : (thumbs?.contents ?? []);
  if (!list.length) return null;
  const best = list.reduce((a: Node, b: Node) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
  const url: string = best.url ?? '';
  return url.replace(/=w\d+-h\d+/, '=w544-h544') || null;
}

function songToTrack(s: Node, fallback: { artist?: string | null; artistId?: string | null; album?: string | null; albumId?: string | null; cover?: string | null } = {}): Track | null {
  const videoId: string | undefined = s.video_id ?? s.id;
  if (!videoId || typeof videoId !== 'string') return null;
  const artists: Node[] = s.artists ?? s.authors ?? [];
  const artist = artists.length ? artists.map((a) => a.name).join(', ') : (typeof s.author === 'string' ? s.author : (s.author?.name ?? fallback.artist ?? null));
  return {
    id: `yt:${videoId}`,
    source: 'youtube',
    videoId,
    title: text(s.title) ?? tr('main.untitled'),
    artist,
    album: s.album?.name ?? fallback.album ?? null,
    durationSec: s.duration?.seconds ?? null,
    coverUrl: cover(s.thumbnail ?? s.thumbnails) ?? fallback.cover ?? null,
    available: true,
    ytArtistId: artists[0]?.channel_id ?? fallback.artistId ?? null,
    ytAlbumId: s.album?.id ?? fallback.albumId ?? null,
  };
}

function albumItem(a: Node): YtAlbumItem | null {
  if (!a?.id) return null;
  const sub = text(a.subtitle);
  return {
    id: a.id,
    title: text(a.title) ?? tr('main.untitled'),
    artist: a.author?.name ?? a.artists?.[0]?.name ?? null,
    artistId: a.author?.channel_id ?? a.artists?.[0]?.channel_id ?? null,
    year: a.year ?? sub?.match(/\b(19|20)\d{2}\b/)?.[0] ?? null,
    kind: sub && !/^\d{4}$/.test(sub) ? (sub.split('•')[0]!.trim() || null) : null,
    coverUrl: cover(a.thumbnail ?? a.thumbnails),
  };
}

function artistItem(a: Node): YtArtistItem | null {
  if (!a?.id) return null;
  return { id: a.id, name: a.name ?? text(a.title) ?? tr('col.artist'), subtitle: text(a.subtitle), coverUrl: cover(a.thumbnail ?? a.thumbnails) };
}

const compact = <T>(xs: (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

/** Search results, without the artists the person hid (yt-hidden.ts). */
function mapItems(type: YtSearchType, items: Node[]): YtSearchResult['items'] {
  const hidden = isHidden();
  if (type === 'song') return compact(items.filter((i) => i.item_type === 'song' || i.item_type === 'video').map((i) => songToTrack(i))).filter((t) => !hidden({ artistId: t.ytArtistId, artist: t.artist }));
  if (type === 'album') return compact(items.map(albumItem)).filter((a) => !hidden(a));
  return compact(items.map(artistItem)).filter((a) => !hidden({ artistId: a.id, artist: a.name }));
}

// Continuations are kept server-side (here) and referenced by an opaque token.
const pages = new Map<string, { type: YtSearchType; page: Node }>();
function remember(type: YtSearchType, page: Node): string | null {
  if (!page?.has_continuation) return null;
  const token = randomUUID();
  pages.set(token, { type, page });
  if (pages.size > 30) pages.delete(pages.keys().next().value!);
  return token;
}

export function search(query: string, type: YtSearchType): Promise<YtSearchResult> {
  return guard(async () => {
    const res = await (await yt()).music.search(query, { type });
    const shelf = res.contents?.find((c: Node) => c.type === 'MusicShelf') as Node;
    return { type, items: mapItems(type, shelf?.contents ?? []), more: remember(type, res) } as YtSearchResult;
  });
}

export function more(token: string): Promise<YtSearchResult> {
  return guard(async () => {
    const entry = pages.get(token);
    if (!entry) throw new Error(tr('yt.expired'));
    pages.delete(token);
    const next = await entry.page.getContinuation();
    const items: Node[] = next.contents?.contents ?? [];
    return { type: entry.type, items: mapItems(entry.type, items), more: remember(entry.type, next) } as YtSearchResult;
  });
}

export function suggest(query: string): Promise<string[]> {
  return guard(async () => {
    const sections = await (await yt()).music.getSearchSuggestions(query);
    return sections
      .flatMap((s: Node) => s.contents ?? [])
      .filter((c: Node) => c.type === 'SearchSuggestion')
      .map((c: Node) => text(c.suggestion))
      .filter((x: string | null): x is string => !!x)
      .slice(0, 8);
  });
}

export function album(id: string): Promise<YtAlbumPage> {
  return guard(async () => {
    const res: Node = await (await yt()).music.getAlbum(id);
    const h = res.header ?? {};
    const sub = text(h.subtitle);
    const artistRun = h.strapline_text_one?.runs?.[0] ?? h.author;
    const base: YtAlbumItem = {
      id,
      title: text(h.title) ?? tr('col.album'),
      artist: text(h.strapline_text_one) ?? h.author?.name ?? null,
      artistId: artistRun?.endpoint?.payload?.browseId ?? h.author?.channel_id ?? null,
      year: sub?.match(/\b(19|20)\d{2}\b/)?.[0] ?? null,
      kind: sub ? (sub.split('•')[0]!.trim() || null) : null,
      coverUrl: cover(h.thumbnail),
    };
    const fallback = { artist: base.artist, artistId: base.artistId, album: base.title, albumId: id, cover: base.coverUrl };
    const tracks = compact<Track>((res.contents ?? []).map((t: Node) => songToTrack(t, fallback)));
    return { ...base, subtitle: text(h.second_subtitle), tracks };
  });
}

export function artist(id: string): Promise<YtArtistPage> {
  return guard(async () => {
    const res: Node = await (await yt()).music.getArtist(id);
    const name = text(res.header?.title) ?? tr('col.artist');
    const sections: Node[] = res.sections ?? [];
    const top = sections.find((s) => s.type === 'MusicShelf');
    const albumShelves = sections.filter((s) => s.type === 'MusicCarouselShelf' && s.contents?.some((c: Node) => c.item_type === 'album'));
    const shelfAlbums = (s: Node) => compact<YtAlbumItem>((s?.contents ?? []).filter((c: Node) => c.item_type === 'album').map(albumItem)).map((a) => ({ ...a, artist: a.artist ?? name, artistId: a.artistId ?? id }));
    return {
      id,
      name,
      coverUrl: cover(res.header?.thumbnail),
      songs: compact<Track>((top?.contents ?? []).map((t: Node) => songToTrack(t, { artist: name, artistId: id }))),
      albums: shelfAlbums(albumShelves[0]),
      singles: shelfAlbums(albumShelves[1]),
    };
  });
}

export function mix(videoId: string): Promise<YtMix> {
  return guard(async () => {
    const panel: Node = await (await yt()).music.getUpNext(videoId, true);
    const items: Node[] = (panel.contents ?? []).map((c: Node) => (c.type === 'PlaylistPanelVideoWrapper' ? c.primary : c)).filter((c: Node) => c?.type === 'PlaylistPanelVideo');
    // the seed stays (it was chosen), hidden artists leave the rest of the mix
    const hidden = isHidden();
    const tracks = compact(items.map((i) => songToTrack(i))).filter((t) => t.videoId === videoId || !hidden({ artistId: t.ytArtistId, artist: t.artist }));
    return { playlistId: panel.playlist_id ?? `RDAMVM${videoId}`, tracks };
  });
}

// ── Pasted links: YouTube / YouTube Music and Spotify ───────────────────────────────────
// A YouTube link already names YouTube tracks: they are read as they are. A Spotify link only
// names songs: their titles and artists are read from Spotify's public embed page (the one any
// website can show, no account, no key) and each one is then looked up on YouTube Music.

const ytTracks = (items: Node[]) => compact<Track>(items.filter((i) => !i.item_type || i.item_type === 'song' || i.item_type === 'video').map((i) => songToTrack(i)));

async function youtubeVideo(videoId: string): Promise<Track | null> {
  const panel: Node = await (await yt()).music.getUpNext(videoId, false);
  const items: Node[] = (panel.contents ?? []).map((c: Node) => (c.type === 'PlaylistPanelVideoWrapper' ? c.primary : c));
  const own = items.find((c: Node) => c?.video_id === videoId) ?? items[0];
  return own ? songToTrack(own) : null;
}

async function youtubePlaylist(id: string): Promise<{ title: string | null; tracks: Track[]; truncated: boolean }> {
  let page: Node = await (await yt()).music.getPlaylist(id);
  const title = text(page.header?.title);
  const tracks = ytTracks(page.items ?? page.contents ?? []);
  // long playlists come in pages of ~100: read up to 1000 tracks
  while (page.has_continuation && tracks.length < 1000) {
    page = await page.getContinuation();
    tracks.push(...ytTracks(page.items ?? page.contents?.contents ?? page.contents ?? []));
  }
  return { title, tracks, truncated: !!page.has_continuation };
}

const SPOTIFY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/** The public embed page of a Spotify track, album or playlist: its JSON data. */
async function spotifyEntity(kind: string, id: string): Promise<Node> {
  let res: Response;
  try {
    res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: { 'user-agent': SPOTIFY_UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new LinkError(tr('link.spotifyOffline'));
  }
  if (res.status === 404) throw new LinkError(tr('link.notFound'));
  if (!res.ok) throw new LinkError(tr('link.spotifyFailed', { status: res.status }));
  const html = await res.text();
  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
  if (!json) throw new LinkError(tr('link.spotifyUnreadable'));
  // a well-formed page without the item: a wrong or deleted id
  const entity = JSON.parse(json)?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new LinkError(tr('link.notFound'));
  return entity;
}

const splitArtists = (s: string | null | undefined) => (s ?? '').split(/\s*,\s*/).map((a) => a.trim()).filter(Boolean);

/** Errors of our own (link unreadable, not found): shown as they are by `guard`. */
class LinkError extends Error {}

export function link(l: MusicLink): Promise<YtLinkImport> {
  return guard(() => readLink(l));
}

async function readLink(l: MusicLink): Promise<YtLinkImport> {
  const fail = (msg: string) => new LinkError(msg);
  if (l.provider === 'youtube') {
    if (l.kind === 'playlist') {
      try {
        const pl = await youtubePlaylist(l.id);
        if (pl.tracks.length) {
          const albums = new Set(pl.tracks.map((t) => t.album));
          const album = albums.size === 1 ? pl.tracks[0]!.album : null;
          return { source: 'youtube', kind: album && !pl.title ? 'album' : 'playlist', title: pl.title ?? album ?? tr('link.ytPlaylist'), subtitle: album ? pl.tracks[0]!.artist : null, tracks: pl.tracks, truncated: pl.truncated };
        }
      } catch (e) {
        // a private or deleted playlist: the video it was shared from, if any
        if (!l.videoId) throw e instanceof LinkError ? e : fail(tr('link.notFound'));
      }
      if (!l.videoId) throw fail(tr('link.emptyPlaylist'));
    }
    if (l.kind !== 'video' && l.kind !== 'playlist') throw fail(tr('link.notFound'));
    const videoId = l.kind === 'playlist' ? l.videoId! : l.id;
    const track = await youtubeVideo(videoId);
    if (!track) throw fail(tr('link.notFound'));
    return { source: 'youtube', kind: 'track', title: track.title, subtitle: track.artist, tracks: [track], truncated: false };
  }
  if (l.kind === 'artist') {
    // a Spotify artist: the YouTube Music artist of the same name
    const name: string = (await spotifyEntity('artist', l.id)).name;
    const artistId = name ? await findArtistId(name) : null;
    if (!artistId) throw fail(tr('link.artistNotFound', { name: name ?? '?' }));
    return { source: 'spotify', kind: 'artist', title: name, subtitle: null, artistId, truncated: false };
  }
  const e = await spotifyEntity(l.kind, l.id);
  const wanted: WantedTrack[] =
    l.kind === 'track'
      ? [{ title: e.title ?? e.name, artists: (e.artists ?? []).map((a: Node) => a.name).filter(Boolean), durationSec: e.duration ? Math.round(e.duration / 1000) : null }]
      : (e.trackList ?? []).map((t: Node) => ({ title: t.title, artists: splitArtists(t.subtitle), durationSec: t.duration ? Math.round(t.duration / 1000) : null })).filter((t: WantedTrack) => t.title);
  if (!wanted.length) throw fail(tr('link.emptyPlaylist'));
  const subtitle = l.kind === 'track' ? wanted[0]!.artists.join(', ') : (e.subtitle ?? null);
  // the embed page lists the first 100 tracks of a playlist
  return { source: 'spotify', kind: l.kind, title: e.title ?? e.name ?? 'Spotify', subtitle, wanted, truncated: l.kind === 'playlist' && wanted.length >= 100 };
}

/** Lower case, no accents, no punctuation, without "(feat. …)", "- Remastered 2011"… */
export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[([](?:feat|ft|with|prod)\.?\s[^)\]]*[)\]]/g, ' ')
    .replace(/\s+(?:feat|ft)\.?\s.*$/g, ' ')
    .replace(/\s-\s.*\b(?:remaster(?:ed)?|version|mono|stereo|edit|live|mix)\b.*$/g, ' ')
    .replace(/[([][^)\]]*\b(?:remaster(?:ed)?|official|video|audio|lyrics?|clip|hd|4k)\b[^)\]]*[)\]]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
/** Share of words in common (Dice coefficient on words). */
export function similarity(a: string, b: string): number {
  const x = norm(a).split(' ').filter(Boolean);
  const y = norm(b).split(' ').filter(Boolean);
  if (!x.length || !y.length) return 0;
  const pool = [...y];
  let common = 0;
  for (const w of x) {
    const i = pool.indexOf(w);
    if (i >= 0) {
      common++;
      pool.splice(i, 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

/** Words of fan uploads and altered versions: "Letra", "lyrics", "cover", "sped up"… */
const ALTERED = /\b(?:letra|lyrics?|paroles|traduc\w*|subtitulad\w*|legendad\w*|cover|karaoke|instrumental|nightcore|sped up|slowed|reverb|8d|bass boosted|remix|live|acoustic|acustic\w*)\b/;

function score(c: Track, want: WantedTrack): number {
  const title = similarity(c.title, want.title);
  const who = norm(c.artist ?? '');
  const names = want.artists.map(norm).filter(Boolean);
  // the artist is the uploader (best), or only named in the video title (weaker: anyone can)
  const byArtist = names.some((a) => who.includes(a));
  const named = !byArtist && names.some((a) => norm(c.title).includes(a));
  if (title < 0.5 || (!byArtist && !named && title < 0.9)) return 0;
  let s = title * 0.6 + (byArtist ? 0.3 : named ? 0.15 : 0);
  // "Song (Letra)" by someone else is not the song, unless that is what was asked for
  const altered = c.title.toLowerCase().match(ALTERED)?.[0];
  if (altered && !want.title.toLowerCase().includes(altered)) s -= 0.3;
  if (want.durationSec && c.durationSec) {
    const d = Math.abs(want.durationSec - c.durationSec);
    s += d <= 3 ? 0.1 : d <= 10 ? 0.05 : d > 30 ? -0.2 : 0;
  }
  return s;
}

export function match(want: WantedTrack): Promise<Track | null> {
  return guard(async () => {
    const q = [want.title, ...want.artists.slice(0, 2)].join(' ');
    // songs first (studio versions, with their album and artist pages), then videos
    for (const type of ['song', 'video'] as const) {
      const res = await (await yt()).music.search(q, { type });
      const shelf = res.contents?.find((c: Node) => c.type === 'MusicShelf') as Node;
      const found = compact<Track>((shelf?.contents ?? []).slice(0, 8).map((i: Node) => songToTrack(i)));
      const best = found.map((c) => ({ c, s: score(c, want) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.6) return best.c;
    }
    return null;
  });
}

/** The YouTube Music artist page of this name: the same name first, else a close one. */
export function findArtist(name: string): Promise<string | null> {
  return guard(() => findArtistId(name));
}
async function findArtistId(name: string): Promise<string | null> {
  {
    const res = await (await yt()).music.search(name, { type: 'artist' });
    const shelf = res.contents?.find((c: Node) => c.type === 'MusicShelf') as Node;
    const found = compact<YtArtistItem>((shelf?.contents ?? []).map(artistItem));
    const same = found.find((a) => norm(a.name) === norm(name));
    return (same ?? found.find((a) => similarity(a.name, name) >= 0.5))?.id ?? null;
  }
}

/**
 * The music video of a track (the "video clip" tab): a YouTube video by the artist's own
 * channel, or titled as the official video. Null when none is close enough.
 */
export function musicVideo(want: WantedTrack): Promise<Track | null> {
  return guard(async () => {
    const q = [want.title, ...want.artists.slice(0, 1)].join(' ');
    const res = await (await yt()).music.search(`${q} official video`, { type: 'video' });
    const shelf = res.contents?.find((c: Node) => c.type === 'MusicShelf') as Node;
    const found = compact<Track>((shelf?.contents ?? []).slice(0, 8).map((i: Node) => songToTrack(i)));
    const names = want.artists.map(norm).filter(Boolean);
    const scored = found.map((c) => {
      let s = score({ ...c, durationSec: null }, { ...want, durationSec: null });
      if (!s) return { c, s };
      const official = /\b(official|officiel|oficial|offiziell|ufficiale)\b|\bm\/?v\b|\bclip\b/i.test(c.title);
      const byArtist = names.some((a) => norm(c.artist ?? '').includes(a)) || /vevo/i.test(c.artist ?? '');
      if (!official && !byArtist) return { c, s: 0 };
      s += (official ? 0.1 : 0) + (byArtist ? 0.1 : 0);
      // a clip can be longer than the song (intro, outro), not shorter
      if (want.durationSec && c.durationSec && c.durationSec < want.durationSec - 20) s -= 0.3;
      return { c, s };
    });
    const best = scored.sort((a, b) => b.s - a.s)[0];
    return best && best.s >= 0.75 ? best.c : null;
  });
}
