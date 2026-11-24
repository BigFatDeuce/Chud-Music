// Music links pasted in the YouTube Music search box: YouTube / YouTube Music and Spotify.
// Only the link's kind and id are read here; nothing is fetched.

export type MusicLink =
  | { provider: 'youtube'; kind: 'video'; id: string }
  | { provider: 'youtube'; kind: 'playlist'; id: string; videoId?: string }
  | { provider: 'youtube'; kind: 'album'; id: string }
  | { provider: 'youtube'; kind: 'artist'; id: string }
  | { provider: 'spotify'; kind: 'track' | 'album' | 'playlist' | 'artist'; id: string };

const YT_HOSTS = /^(?:www\.|m\.|music\.)?youtube(?:-nocookie)?\.com$/i;
const VIDEO = /^[\w-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/** The music link in this text (a URL or a spotify: URI), or null when it is not one. */
export function parseMusicLink(input: string): MusicLink | null {
  const text = input.trim();
  const uri = text.match(/^spotify:(track|album|playlist|artist):([A-Za-z0-9]{22})$/);
  if (uri) return { provider: 'spotify', kind: uri[1] as 'track', id: uri[2]! };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || /\s/.test(text)) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    // /track/ID, /intl-fr/album/ID, /embed/playlist/ID
    const i = parts.findIndex((p) => ['track', 'album', 'playlist', 'artist'].includes(p));
    const id = parts[i + 1];
    if (i >= 0 && id && SPOTIFY_ID.test(id)) return { provider: 'spotify', kind: parts[i] as 'track', id };
    return null;
  }

  if (host === 'youtu.be') {
    const id = parts[0];
    return id && VIDEO.test(id) ? { provider: 'youtube', kind: 'video', id } : null;
  }
  if (!YT_HOSTS.test(host)) return null;
  const v = url.searchParams.get('v') ?? undefined;
  const list = url.searchParams.get('list') ?? undefined;
  // a "radio" list (RD…) is generated around the video: the video is what was shared
  if (list && !/^RD/.test(list) && /^[\w-]{10,}$/.test(list)) return { provider: 'youtube', kind: 'playlist', id: list, videoId: v && VIDEO.test(v) ? v : undefined };
  if (v && VIDEO.test(v)) return { provider: 'youtube', kind: 'video', id: v };
  const [head, second] = parts;
  if ((head === 'shorts' || head === 'embed' || head === 'live' || head === 'v') && second && VIDEO.test(second)) return { provider: 'youtube', kind: 'video', id: second };
  if (head === 'browse' && second?.startsWith('MPREb_')) return { provider: 'youtube', kind: 'album', id: second };
  if (head === 'channel' && second && /^UC[\w-]{22}$/.test(second)) return { provider: 'youtube', kind: 'artist', id: second };
  return null;
}
