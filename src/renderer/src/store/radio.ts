import { create } from 'zustand';
import type { RadioWindow, Track } from '@shared/types';
import { engine } from '@/audio/engine';
import { useSettings } from './settings';
import { toast } from './toasts';
import { tr } from '@shared/i18n';

// Time shift and recording of the station playing (the audio is kept by the main process:
// main/radio-shift.ts). Positions are seconds of audio since the station was tuned in.
//
// The player reads the station from `base` on; where it is now = base + the element's clock.
// Going back, pausing and going on later, or back to live, all restart the reading from another
// moment of the memory.

interface RadioShiftState {
  /** Where the current reading started (seconds since tuning in). */
  base: number;
  /** The station's memory, refreshed every second while a station plays. */
  win: RadioWindow | null;
  /**
   * Heard behind live because the person went back or paused. Decided when the reading starts,
   * not measured all the time: the gap to the newest audio moves with the station's bursts and
   * the player's buffer, and a measured "live" flickered to "-0:10" and back.
   */
  shifted: boolean;
}

export const useRadioShift = create<RadioShiftState>(() => ({ base: 0, win: null, shifted: false }));

/** Below this delay the station counts as live (the player's own buffer, the server's burst). */
export const LIVE_SLACK = 10;

export const radioSrc = (t: Track, from: number) =>
  `chud-media://radio/?u=${encodeURIComponent(t.streamUrl ?? '')}&k=${t.bitrate && t.bitrate > 0 ? t.bitrate : 0}&from=${from.toFixed(3)}`;

/** Where the person is in the station's memory now. */
export function radioPos(): number {
  return useRadioShift.getState().base + engine.currentTime;
}

/** Where a new reading of this station starts when asked for live: 3 s behind the newest audio. */
export async function liveFrom(t: Track): Promise<number> {
  const w = await window.chud.radio.window();
  useRadioShift.setState({ win: w });
  // another station is being recorded: saved before this one takes its place
  if (w && w.url !== t.streamUrl && w.recording) void window.chud.radio.recordStop().then((r) => r && savedToast(r.path));
  return w && w.url === t.streamUrl && !w.ended ? Math.max(w.start, w.end - 3) : 0;
}

/**
 * Plays the station from `from` (null = live). `wanted` is asked once the station's memory has
 * answered: false = given up meanwhile (another track, cancelled), nothing is loaded.
 */
export async function playRadioFrom(t: Track, from: number | null, wanted?: () => boolean): Promise<void> {
  const at = from === null ? await liveFrom(t) : Math.max(0, from);
  if (wanted && !wanted()) return;
  const w = useRadioShift.getState().win;
  useRadioShift.setState({ base: at, shifted: from !== null && !!w && w.url === t.streamUrl && w.end - at >= LIVE_SLACK });
  tuned = true;
  await engine.loadLocal(radioSrc(t, at), 0);
}

/** Another source plays: the station's connection closes (a recording is saved first). */
let tuned = false;
export function closeRadio(): void {
  if (!tuned) return;
  tuned = false;
  useRadioShift.setState({ win: null, base: 0, shifted: false });
  void window.chud.radio.stop().then((r) => r && savedToast(r.path));
}

function savedToast(path: string): void {
  toast({ title: tr('radio.recSaved'), body: path.split(/[\\/]/).pop(), action: { label: tr('radio.recShow'), run: () => window.chud.shell.showInFolder(path) } });
}

export async function toggleRecording(t: Track): Promise<void> {
  const w = useRadioShift.getState().win;
  try {
    if (w?.recording) {
      // up to what the person hears (the audio further on is in memory, not yet heard)
      const r = await window.chud.radio.recordStop(radioPos());
      if (r) savedToast(r.path);
    } else {
      // from what the person hears (they may be listening back in time)
      const r = await window.chud.radio.record(t.title, useSettings.getState().radioRecordDir, radioPos());
      if (!r) toast({ kind: 'error', title: tr('radio.recFailed') });
    }
  } catch {
    toast({ kind: 'error', title: tr('radio.recFailed') });
  }
  useRadioShift.setState({ win: await window.chud.radio.window().catch(() => null) });
}

// refreshed every second while a station is the current track
let timer: ReturnType<typeof setInterval> | null = null;
export function watchRadio(on: boolean): void {
  if (on && !timer) {
    const tick = () => void window.chud.radio.window().then((win) => useRadioShift.setState({ win }));
    tick();
    timer = setInterval(tick, 1000);
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
  }
}
