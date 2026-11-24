import type { Track } from '@shared/types';

/** YouTube channel names often end with " - Topic" (auto-generated artist channels). */
export function artistName(t: Track): string | null {
  return t.artist?.replace(/\s+-\s+Topic$/i, '').trim() || null;
}

/** The main artist of "A, B, C" or "A feat. B" (not "&": it belongs to names like "Simon & Garfunkel"). */
export function mainArtist(t: Track): string | null {
  return artistName(t)?.split(/\s*,\s*|\s*;\s*|\s+(?:feat|ft)\.?\s+/i)[0]?.trim() || null;
}
