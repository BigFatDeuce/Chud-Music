import { create } from 'zustand';
import { engine } from '@/audio/engine';
import { getLang } from '@shared/i18n';

// Playback speed, for local files and YouTube alike (pitch kept). Remembered on this computer
// (a convenience: nothing else depends on it); the button above the timer shows it when ≠ 1×.

export const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2] as const;
const KEY = 'chud.rate';

const read = (): number => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return (SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
};

export const useRate = create<{ rate: number; set(rate: number): void }>((set) => ({
  rate: read(),
  set(rate) {
    engine.setRate(rate);
    try {
      localStorage.setItem(KEY, String(rate));
    } catch {
      /* not remembered */
    }
    set({ rate });
  },
}));
engine.setRate(useRate.getState().rate);

export const fmtRate = (r: number) => `${new Intl.NumberFormat(getLang()).format(r)}×`;
