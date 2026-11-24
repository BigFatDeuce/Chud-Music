import { hiddenMatcher, withHidden, withoutHidden, type HiddenArtist } from '@shared/hidden-artists';
import { kvGet, kvSet } from './db';

// The YouTube Music artists the person hid (shared/hidden-artists.ts): stored with the other
// settings in the database, read by youtube.ts to leave them out of searches and mixes.

const KEY = 'yt.hiddenArtists';

export function hiddenArtists(): HiddenArtist[] {
  const v = kvGet<HiddenArtist[]>(KEY);
  return Array.isArray(v) ? v.filter((a) => a && typeof a.name === 'string') : [];
}

export function hideArtist(a: { id: string | null; name: string }): HiddenArtist[] {
  const name = String(a.name ?? '').trim();
  if (!name) return hiddenArtists();
  const list = withHidden(hiddenArtists(), { id: typeof a.id === 'string' && a.id ? a.id : null, name, at: Date.now() });
  kvSet(KEY, list);
  return list;
}

export function unhideArtist(a: { id: string | null; name: string }): HiddenArtist[] {
  const list = withoutHidden(hiddenArtists(), { id: typeof a.id === 'string' && a.id ? a.id : null, name: String(a.name ?? '') });
  kvSet(KEY, list);
  return list;
}

/** The test for the current list (read once per search / mix). */
export const isHidden = () => hiddenMatcher(hiddenArtists());
