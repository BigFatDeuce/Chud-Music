import { create } from 'zustand';
import type { Sleep } from '@shared/chain';
import { engine } from '@/audio/engine';
import { toast } from './toasts';
import { tr } from '@shared/i18n';

// The sleep timer: playback pauses at a time (the sound goes down over the last seconds), or stops
// at the end of the track or of the album (store/player.ts asks sleepStopsAfter). Not remembered
// from one launch to the next.

interface SleepState {
  sleep: Sleep | null;
  set(sleep: Sleep | null): void;
}

/** Tests shorten it with the minutes. */
const FADE_MS = 8000;

export const useSleep = create<SleepState>((set) => ({
  sleep: null,
  set(sleep) {
    engine.setFade(1);
    set({ sleep });
  },
}));

/** Set by the player: pauses whatever plays. */
let pause: () => void = () => {};
export function onSleepTime(cb: () => void): void {
  pause = cb;
}

/** Milliseconds left before it pauses (null: no time set). */
export const sleepLeft = (s: Sleep | null): number | null => (s?.kind === 'time' ? Math.max(0, s.at - Date.now()) : null);

setInterval(() => {
  const { sleep } = useSleep.getState();
  const left = sleepLeft(sleep);
  if (left === null) return;
  if (left > 0) {
    if (left < FADE_MS) engine.setFade(Math.max(0.02, left / FADE_MS));
    return;
  }
  pause();
  useSleep.setState({ sleep: null });
  setTimeout(() => engine.setFade(1), 300); // the volume comes back once nothing sounds any more
  toast({ title: tr('sleep.done') });
}, 250);
