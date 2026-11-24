import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Packaged: the LGPL build shipped next to the app. In development: the same build once
// built (scripts/build-ffmpeg.sh), so tests exercise what ships; otherwise whatever is in PATH.
export function ffmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = app.isPackaged ? join(process.resourcesPath, 'ffmpeg', exe) : join(__dirname, '../../build/vendor', process.platform === 'win32' ? 'ffmpeg' : 'ffmpeg-linux', exe);
  return existsSync(bundled) ? bundled : 'ffmpeg';
}
