import { create } from 'zustand';
import type { LyricsResult } from '@shared/types';
import { lyricsQuery } from '@/lib/lyrics';
import { usePlayer } from './player';

// The lyrics of what is playing, looked up once per track (the main process caches LRCLIB's
// answers): the "Synced Lyrics" / "Lyrics" button of the player bar and the video clip tab read
// them here. The Lyrics page and the docked strip keep their own requests (same cache).

interface NowLyrics {
  /** The track (lyricsQuery key) these lyrics belong to. */
  key: string;
  result: LyricsResult | null;
}

export const useNowLyrics = create<NowLyrics>(() => ({ key: '', result: null }));

let asked = '';
function refresh(): void {
  const current = usePlayer.getState().current;
  const { query, key } = lyricsQuery(current);
  if (key === asked) return;
  asked = key;
  useNowLyrics.setState({ key, result: null });
  if (!query) return;
  void window.chud.lyrics.get(query).then(
    (result) => key === asked && useNowLyrics.setState({ key, result }),
    () => {},
  );
}
usePlayer.subscribe((s, prev) => {
  if (s.current !== prev.current) refresh();
});
refresh();

/** 'synced' | 'plain' when the playing track has lyrics, null otherwise (or not known yet). */
export function useLyricsKind(): 'synced' | 'plain' | null {
  const status = useNowLyrics((s) => s.result?.status);
  return status === 'synced' ? 'synced' : status === 'plain' ? 'plain' : null;
}
