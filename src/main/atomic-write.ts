// Writing a picture of the cache (covers, thumbnails, playlist pictures) all at once: to a
// temporary file next to it, then renamed. Their names come from their content and a file already
// there is never written again, so a write cut short (the app closed, the PC turned off, two scans
// writing the same cover at the same moment) must never leave a truncated picture under the final
// name: it would be shown broken for ever. Only node:fs: tests/unit/atomic-write.mjs loads it as
// it is.
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';

let seq = 0;
const partOf = (path: string) => `${path}.${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}.part`;

/** For files named after their content: when another writer got there first, its file stays. */
export async function writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const part = partOf(path);
  try {
    await writeFile(part, data);
    await rename(part, path);
  } catch (e) {
    await rm(part, { force: true }).catch(() => {});
    if (!existsSync(path)) throw e; // renaming over a file being read can fail on Windows: same content
  }
}

export function writeFileAtomicSync(path: string, data: Uint8Array | string): void {
  const part = partOf(path);
  try {
    writeFileSync(part, data);
    renameSync(part, path);
  } catch (e) {
    try {
      rmSync(part, { force: true });
    } catch {
      /* nothing more to do */
    }
    if (!existsSync(path)) throw e;
  }
}
