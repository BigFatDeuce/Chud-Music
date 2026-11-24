import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isAudioPath } from '@shared/audio-formats';

// Files handed to us by Windows (double-click / "Open with") or by a second instance.
// They are queued until the UI says it is ready, so nothing is lost during startup.
// Nothing here touches the file system synchronously: a file on a slow or unreachable network
// share must never delay the window. Existence is checked later, in the background.

export function audioPathsFromArgv(argv: string[], cwd: string): string[] {
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-'))
    .map((a) => resolve(cwd, a))
    .filter((p) => isAudioPath(p));
}

const MAX_EXPANDED = 5000;

/** Audio files stay as they are (not even stat'ed); folders are walked for audio files. */
export async function expandPaths(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip silently
    }
    entries.sort((a, b) => collator.compare(a.name, b.name));
    for (const e of entries) {
      if (out.length >= MAX_EXPANDED) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && isAudioPath(p)) out.push(p);
    }
  }
  for (const p of paths) {
    if (isAudioPath(p)) {
      out.push(p);
      continue;
    }
    const st = await stat(p).catch(() => null);
    if (st?.isDirectory()) await walk(p);
  }
  return out;
}

export class LaunchQueue {
  private pending: string[][] = [];
  private deliver: ((paths: string[]) => void) | null = null;

  push(paths: string[]): void {
    if (!paths.length) return;
    if (this.deliver) this.deliver(paths);
    else this.pending.push(paths);
  }

  /** Called once the renderer has subscribed; flushes everything received so far. */
  attach(deliver: (paths: string[]) => void): void {
    this.deliver = deliver;
    for (const batch of this.pending.splice(0)) deliver(batch);
  }

  detach(): void {
    this.deliver = null;
  }
}
