import { tr, type Key } from '@shared/i18n';
import { EQ_BANDS, type EqSettings } from '@shared/types';

// The 10-band equaliser: the same filter definitions feed the playback graph (engine.ts) and
// the curve drawn in the panel, so what is shown is what is applied.

export const EQ_RANGE_DB = 12;
export const EQ_Q = 1.1;

export function createBand(ctx: BaseAudioContext, i: number): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
  b.frequency.value = EQ_BANDS[i]!;
  b.Q.value = EQ_Q;
  return b;
}

/** Our own presets (preamp lowered where bands boost, to keep headroom). */
export const EQ_PRESETS: { name: string; preampDb: number; gains: number[] }[] = [
  { name: 'Plat', preampDb: 0, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Rock', preampDb: -4, gains: [5, 3, -2, -4, -1, 2, 5, 6, 6, 6] },
  { name: 'Pop', preampDb: -3, gains: [-1, 2, 4, 5, 3, 0, -1, -1, -1, -1] },
  { name: 'Électro', preampDb: -5, gains: [6, 5, 1, 0, -2, 2, 1, 1, 5, 5] },
  { name: 'Hip-hop', preampDb: -5, gains: [6, 5, 2, 0, -1, -1, 1, 0, 2, 3] },
  { name: 'Jazz', preampDb: -3, gains: [3, 2, 0, 2, -1, -1, 0, 2, 3, 3] },
  { name: 'Classique', preampDb: 0, gains: [0, 0, 0, 0, 0, 0, -3, -4, -4, -5] },
  { name: 'Acoustique', preampDb: -3, gains: [3, 2, 1, 1, 2, 2, 3, 3, 2, 1] },
  { name: 'Voix', preampDb: -3, gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: 'Loudness', preampDb: -4, gains: [5, 3, 0, -1, -2, -1, 0, 2, 4, 5] },
  { name: 'Basses +', preampDb: -6, gains: [7, 6, 4, 1, 0, 0, 0, 0, 0, 0] },
  { name: 'Aigus +', preampDb: -6, gains: [0, 0, 0, 0, 0, 2, 4, 6, 7, 8] },
];

let curveCtx: OfflineAudioContext | null = null;
let curveBands: BiquadFilterNode[] = [];

/** Total response in dB (preamp included) at each frequency, from real BiquadFilterNodes. */
export function eqCurve(eq: EqSettings, freqs: Float32Array): Float32Array {
  curveCtx ??= new OfflineAudioContext(1, 1, 48000);
  if (!curveBands.length) curveBands = EQ_BANDS.map((_, i) => createBand(curveCtx!, i));
  const total = new Float32Array(freqs.length).fill(eq.enabled ? eq.preampDb : 0);
  if (!eq.enabled) return total;
  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  curveBands.forEach((b, i) => {
    b.gain.value = eq.gains[i] ?? 0;
    b.getFrequencyResponse(freqs as Float32Array<ArrayBuffer>, mag, phase);
    for (let k = 0; k < freqs.length; k++) total[k]! += 20 * Math.log10(Math.max(1e-6, mag[k]!));
  });
  return total;
}

/** Display name of a preset: ours are translated (their stored name stays the French id), the user's are theirs. */
export function presetLabel(name: string): string {
  const i = EQ_PRESETS.findIndex((p) => p.name === name);
  if (i >= 0) return tr(`eq.preset.${i}` as Key);
  return name === 'Personnalisé' ? tr('eq.custom') : name;
}

export const fmtBand = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));
