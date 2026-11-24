import { app, nativeImage, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { tr } from '@shared/i18n';

// Windows taskbar: previous / play-pause / next under the window's thumbnail (like Windows
// Media Player). The interface reports the player state; clicks are sent back as commands.

export interface ThumbarState {
  playing: boolean;
  /** Something loaded or queued: the buttons can act. */
  enabled: boolean;
}

const dir = () => (app.isPackaged ? join(process.resourcesPath, 'thumbar') : join(__dirname, '../../build/thumbar'));
let icons: Record<'prev' | 'play' | 'pause' | 'next', Electron.NativeImage> | null = null;
let last = '';

export function updateThumbar(win: BrowserWindow, s: ThumbarState): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  const key = `${s.playing}|${s.enabled}`;
  if (key === last) return;
  last = key;
  icons ??= {
    prev: nativeImage.createFromPath(join(dir(), 'prev.png')),
    play: nativeImage.createFromPath(join(dir(), 'play.png')),
    pause: nativeImage.createFromPath(join(dir(), 'pause.png')),
    next: nativeImage.createFromPath(join(dir(), 'next.png')),
  };
  const send = (cmd: string) => () => win.webContents.send('player:command', cmd);
  const flags: Electron.ThumbarButton['flags'] = s.enabled ? [] : ['disabled'];
  win.setThumbarButtons([
    { tooltip: tr('player.prev'), icon: icons.prev, click: send('prev'), flags },
    { tooltip: s.playing ? tr('player.pause') : tr('player.play'), icon: s.playing ? icons.pause : icons.play, click: send('toggle'), flags },
    { tooltip: tr('player.next'), icon: icons.next, click: send('next'), flags },
  ]);
}

/** For tests: what the taskbar currently shows. */
export const thumbarState = () => last;
