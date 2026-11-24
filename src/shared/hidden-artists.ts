// YouTube Music artists the person hid (right-click › Hide this artist): they no longer show in
// searches, mixes or suggestions. Kept in the main process (kv 'yt.hiddenArtists'); brought back
// one by one in Settings › YouTube Music › Hidden artists. No imports: tested without the app.

export interface HiddenArtist {
  /** YouTube Music channel id, when known (the surest match). */
  id: string | null;
  /** As YouTube writes it; also matched by name, for results that come without an id. */
  name: string;
  /** When it was hidden (ms). */
  at: number;
}

/** Lower case, no accents, no punctuation: "Beyoncé!" and "beyonce" are the same name. */
export const artistKey = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The names in an artist line: "A, B & C feat. D" → A, B, C, D. */
export const splitArtistLine = (line: string): string[] =>
  line
    .split(/\s*(?:,|;|&|\/|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);

/**
 * A test for "is this by a hidden artist?", built once for a whole list of results. True when the
 * item's artist id is hidden, or when one of the names on its artist line is.
 */
export function hiddenMatcher(list: HiddenArtist[]): (item: { artistId?: string | null; artist?: string | null }) => boolean {
  if (!list.length) return () => false;
  const ids = new Set(list.map((a) => a.id).filter((id): id is string => !!id));
  const names = new Set(list.map((a) => artistKey(a.name)).filter(Boolean));
  return (item) => {
    if (item.artistId && ids.has(item.artistId)) return true;
    if (!item.artist) return false;
    // the whole line too: a name with a separator in it ("AC/DC") is one artist
    return names.has(artistKey(item.artist)) || splitArtistLine(item.artist).some((n) => names.has(artistKey(n)));
  };
}

/** Adds an artist (once: same id, or same name when there is no id); newest first. */
export function withHidden(list: HiddenArtist[], a: HiddenArtist): HiddenArtist[] {
  const key = artistKey(a.name);
  const rest = list.filter((x) => !(a.id && x.id === a.id) && artistKey(x.name) !== key);
  return [a, ...rest];
}

/** Brings back the artist with this id or this name (every entry that would still hide it). */
export function withoutHidden(list: HiddenArtist[], a: { id: string | null; name: string }): HiddenArtist[] {
  const key = artistKey(a.name);
  return list.filter((x) => !(a.id && x.id === a.id) && !(key && artistKey(x.name) === key));
}
