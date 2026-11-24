import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { userDataDir } from './paths';

// Local diagnostic log: %APPDATA%\Chud Music\logs\chud.log (kept under 1 MB, one previous file
// kept as chud.old.log). It never leaves the machine; the user can open the folder from Settings.

const MAX = 1024 * 1024;

export const logsDir = (): string => {
  const dir = join(userDataDir(), 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
};

export function log(level: 'info' | 'warn' | 'error', source: string, message: string): void {
  try {
    const file = join(logsDir(), 'chud.log');
    try {
      if (statSync(file).size > MAX) renameSync(file, join(logsDir(), 'chud.old.log'));
    } catch {
      /* no file yet */
    }
    appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${message.replace(/\s+$/, '')}\n`);
  } catch {
    /* logging must never break the app */
  }
}

/** Main-process errors that would otherwise only reach a console nobody sees. */
export function captureMainErrors(): void {
  process.on('uncaughtException', (e) => log('error', 'main', e.stack ?? String(e)));
  process.on('unhandledRejection', (e) => log('error', 'main', e instanceof Error ? (e.stack ?? e.message) : String(e)));
}
