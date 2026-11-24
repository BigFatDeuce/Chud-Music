import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { parse, resolve, sep } from 'node:path';

// Is a library folder on a network share? Such folders are not watched: a recursive watch over
// SMB/NFS either reports nothing (Linux: inotify never sees changes made by other machines, and
// setting it up walks the whole tree over the network) or overflows on bursts and triggers full
// rescans (Windows). They are re-examined periodically instead (library.ts).

const NETWORK_FS = new Set([
  'cifs', 'smb3', 'smbfs', 'nfs', 'nfs4', 'sshfs', 'fuse.sshfs', 'davfs', 'fuse.davfs2', 'fuse.rclone',
  'fuse.gvfsd-fuse', 'afs', 'ceph', 'glusterfs', 'fuse.glusterfs', 'fuse.s3fs', 'ncpfs', 'coda',
]);

/** `net use` output → mapped drive letters ("Z:"), whatever the system language. */
export function parseNetUse(out: string): Set<string> {
  const drives = new Set<string>();
  for (const m of out.matchAll(/(?:^|\s)([A-Za-z]:)\s+\\\\/gm)) drives.add(m[1]!.toUpperCase());
  return drives;
}

/** /proc/mounts → [mount point, fs type] of network file systems, longest mount point first. */
export function parseMounts(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split('\n')) {
    const [, mnt, type] = line.split(' ');
    if (!mnt || !type || !NETWORK_FS.has(type)) continue;
    out.push([mnt.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))), type]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

// shortcut: read once per launch; a drive mapped while the app runs counts as local until the next start
let mapped: Promise<Set<string>> | null = null;
const mappedDrives = () =>
  (mapped ??= new Promise((done) => {
    execFile('net', ['use'], { windowsHide: true, timeout: 5000 }, (err, stdout) => done(err ? new Set() : parseNetUse(String(stdout))));
  }));

export async function isNetworkFolder(path: string): Promise<boolean> {
  if (process.env.CHUD_TEST_NETWORK_FOLDERS === '1') return true; // tests: behave as if every folder were remote
  const p = resolve(path);
  if (process.platform === 'win32') {
    if (/^[\\/]{2}/.test(p)) return true; // \\server\share
    return (await mappedDrives()).has(p.slice(0, 2).toUpperCase());
  }
  if (process.platform === 'linux') {
    try {
      const mounts = parseMounts(await readFile('/proc/mounts', 'utf8'));
      return mounts.some(([m]) => p === m || p.startsWith(m.endsWith('/') ? m : m + '/'));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Is this path there? Asynchronous with a time limit: an unplugged drive or a network share that
 * does not answer must never freeze the app (it counts as unreachable for now).
 */
export function reachable(path: string, ms = 2000): Promise<boolean> {
  if (testOffline(path)) return Promise.resolve(false);
  return Promise.race([access(path).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

/** Tests only: while the file named by CHUD_TEST_OFFLINE exists, the folder it names is "offline". */
export function testOffline(path: string): boolean {
  const flag = process.env.CHUD_TEST_OFFLINE;
  if (!flag) return false;
  try {
    const dir = resolve(readFileSync(flag, 'utf8').trim()).toLowerCase();
    const p = resolve(path).toLowerCase();
    return p === dir || p.startsWith(dir + sep);
  } catch {
    return false;
  }
}

/** What a share is called: \\server\share, a mapped drive, or the mount point. */
async function shareRoot(path: string): Promise<string> {
  const p = resolve(path);
  if (process.env.CHUD_TEST_OFFLINE && process.env.CHUD_TEST_NETWORK_ROOT) return process.env.CHUD_TEST_NETWORK_ROOT;
  if (process.platform === 'win32') return parse(p).root;
  try {
    const mounts = parseMounts(await readFile('/proc/mounts', 'utf8'));
    return mounts.find(([m]) => p === m || p.startsWith(m.endsWith('/') ? m : m + '/'))?.[0] ?? '/';
  } catch {
    return '/';
  }
}

/** For a file that does not play: is it there, is it on a share, does the share answer? */
export async function reach(path: string): Promise<{ file: boolean; network: boolean; share: boolean; root: string }> {
  const [file, network, root] = await Promise.all([reachable(path, 4000), isNetworkFolder(path), shareRoot(path)]);
  const share = file || (await reachable(root, 4000));
  return { file, network, share, root: root.replace(/[\\/]$/, '') || root };
}
