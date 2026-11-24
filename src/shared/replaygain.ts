// Volume normalisation (ReplayGain 2.0): what each local file is multiplied by so that all sound
// equally loud. Pure and without imports: tests/unit/playback.mjs loads this file as it is.

/** What is known of a file's loudness: its own tags, or measured by Chud Music (EBU R128). */
export interface Loudness {
  /** dB to add to reach the reference (-18 LUFS); null: not known. */
  trackGain: number | null;
  /** Highest sample (1 = full scale). */
  trackPeak: number | null;
  albumGain: number | null;
  albumPeak: number | null;
  source: 'tags' | 'measured';
}

/**
 * 'track': every track at the same level. 'album': the tracks of an album keep their differences
 * (files without an album gain use their own).
 */
export type ReplayGainMode = 'off' | 'track' | 'album';

/** The measured loudness the gains aim at. */
export const REFERENCE_LUFS = -18;
const MIN_DB = -24;
const MAX_DB = 15;

/** The factor to apply: never so high that the loudest sample would clip. */
export function replayGainFactor(mode: ReplayGainMode, l: Loudness | null): number {
  if (mode === 'off' || !l) return 1;
  const album = mode === 'album' && l.albumGain !== null;
  const db = album ? l.albumGain : l.trackGain;
  if (db === null || !Number.isFinite(db)) return 1;
  const peak = album ? (l.albumPeak ?? l.trackPeak) : l.trackPeak;
  const factor = Math.pow(10, Math.max(MIN_DB, Math.min(MAX_DB, db)) / 20);
  // without a known peak, only lowering is safe
  if (peak === null || !(peak > 0)) return Math.min(1, factor);
  return Math.min(factor, 1 / peak);
}

/** The summary FFmpeg's ebur128 filter writes → gain and peak; null when there is none (silence). */
export function parseEbur128(text: string): { gain: number; peak: number | null } | null {
  const s = text.slice(text.lastIndexOf('Summary:'));
  const i = /I:\s*(-?[\d.]+|-?inf|nan)\s*LUFS/.exec(s);
  const p = /Peak:\s*(-?[\d.]+|-?inf)\s*dBFS/.exec(s);
  const lufs = i ? Number(i[1]) : NaN;
  if (!Number.isFinite(lufs) || lufs <= -70) return null; // gated out: nothing but silence
  const db = p ? Number(p[1]) : NaN;
  return { gain: REFERENCE_LUFS - lufs, peak: Number.isFinite(db) ? Math.pow(10, db / 20) : null };
}
