import { app } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

// User data (database, settings, backups) lives in the OS profile — never in the install folder,
// so updates and uninstalls cannot touch it. Caches go to the OS cache location.

export function userDataDir(): string {
  return app.getPath('userData'); // %APPDATA%\Chud Music  |  ~/.config/Chud Music
}

export function cacheDir(...sub: string[]): string {
  const base = process.env.CHUD_USER_DATA
    ? join(process.env.CHUD_USER_DATA, 'Cache') // isolated test profile
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Chud Music', 'Cache')
      : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'chud-music');
  const dir = join(base, ...sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Pictures chosen for playlists. */
export function playlistCoversDir(): string {
  const dir = join(userDataDir(), 'playlist-covers');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function backupsDir(): string {
  const dir = join(userDataDir(), 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}
