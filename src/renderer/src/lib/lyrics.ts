import type { LyricsQuery, Track } from '@shared/types';

// Shared by the Lyrics page and the lyrics strip of the docked player bar.

export interface LyricLine {
  t: number;
  text: string;
}

/** LRC → timed lines ("[01:02.34] text", possibly several stamps per line). */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) out.push({ t: Number(s[1]) * 60 + Number(s[2]!.replace(':', '.')), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Index of the line being sung at time t (−1 before the first one). */
export function lineAt(lines: LyricLine[], t: number): number {
  let i = -1;
  for (let k = 0; k < lines.length && lines[k]!.t <= t; k++) i = k;
  return i;
}

/**
 * What to search for the current track. Live radio: the title on air ("Artist - Title"),
 * null when the station does not say what it plays.
 */
export function lyricsQuery(current: Track | null): { query: LyricsQuery | null; key: string; onAir: string | null | undefined } {
  if (!current) return { query: null, key: '', onAir: undefined };
  const onAir = current.source === 'radio' ? (current.onAir ?? null) : undefined;
  const key = `${current.id}|${current.title}|${current.artist}|${onAir ?? ''}`;
  if (onAir === null) return { query: null, key, onAir };
  if (onAir) {
    const air = /^(.+?)\s+[-–]\s+(.+)$/.exec(onAir);
    return { query: { title: air ? air[2]! : onAir, artist: air ? air[1]! : null, album: null, durationSec: null }, key, onAir };
  }
  return { query: { title: current.title, artist: current.artist, album: current.album, durationSec: current.durationSec ?? null }, key, onAir };
}
