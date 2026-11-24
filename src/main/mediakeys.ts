import { globalShortcut, type BrowserWindow } from 'electron';
import { log } from './log';

// Keyboard media keys, registered with the system for Chud Music. Without this, Windows routes
// them to whichever "media session" it considers active — often the embedded YouTube player
// page, even hidden — so they did nothing or the wrong thing. Registering them also means a
// key press reaches Chud Music only once. If another program already holds a key (Spotify…),
// registration fails: that is reported in Settings instead of failing silently.

const KEYS = [
  ['MediaPlayPause', 'toggle'],
  ['MediaNextTrack', 'next'],
  ['MediaPreviousTrack', 'prev'],
  ['MediaStop', 'stop'],
] as const;

let taken: string[] = [];
let active = false;

export function registerMediaKeys(getWin: () => BrowserWindow | null): void {
  taken = [];
  active = true;
  for (const [accel, cmd] of KEYS) {
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => getWin()?.webContents.send('player:command', cmd));
    } catch {
      ok = false;
    }
    if (!ok) taken.push(accel);
  }
  if (taken.length) log('warn', 'main', `media keys held by another program: ${taken.join(', ')}`);
}

/** active: Chud Music has taken the keys (after its first playback in the session). */
export function mediaKeysStatus(): { active: boolean; registered: boolean; taken: string[] } {
  return { active, registered: active && taken.length === 0, taken: [...taken] };
}

export function unregisterMediaKeys(): void {
  globalShortcut.unregisterAll();
}
