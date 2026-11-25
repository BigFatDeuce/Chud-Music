import { app, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import electronUpdater from 'electron-updater';
import { sha512File, UPDATE_PUBLIC_KEY, verifyUpdate } from './update-signature';
import type { UpdateStatus } from '@shared/types';
import { updateMachine, updateState, type UpdateEvent, type UpdatePhase } from '@shared/machines';
import { tr } from '@shared/i18n';
import { log } from './log';

// Updates published as GitHub releases of BigFatDeuce/Chud-Music (installers only, no code).
//  • In-app: electron-updater reads latest.yml from the latest release, downloads the
//    installer (SHA-512 checked), checks our own signature of it (update-signature.ts) and runs
//    it on restart. User data lives in %APPDATA%, outside
//    the install folder: an update never touches it (and the installer never deletes it).
//  • Fallback (development build, Linux package without AppImage, or a release published
//    without latest.yml): the GitHub API tells whether a newer version exists, and the button
//    opens the releases page instead.

const OWNER = 'BigFatDeuce';
const REPO = 'Chud-Music';
export const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
const API_LATEST = process.env.CHUD_RELEASES_API ?? `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const CHECK_EVERY = 6 * 3600 * 1000;

const { autoUpdater } = electronUpdater;
let notify: (s: UpdateStatus) => void = () => {};
// Development runs report Electron's own version: read ours from package.json there.
export const currentVersion = (): string => {
  if (app.isPackaged) return app.getVersion();
  try {
    return (JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return app.getVersion();
  }
};
const status: UpdateStatus = { state: 'idle', current: currentVersion(), version: null, notes: null, progress: 0, error: null, checkedAt: null, inApp: false, releaseUrl: RELEASES_URL };
// Where the updater is: the states and the events each one takes are the table of
// shared/machines.ts. `status.state` (what the interface shows) follows from it.
let phase: UpdatePhase = updateMachine.initial;
/**
 * The only place the state changes. False, and nothing changed (the details in `patch` are not
 * applied either), when the current state does not take this event.
 */
function go(event: UpdateEvent, patch: Partial<Omit<UpdateStatus, 'state'>> = {}): boolean {
  const to = updateMachine.next(phase, event);
  if (!to) return false;
  phase = to;
  Object.assign(status, patch, { state: updateState(to) });
  notify({ ...status });
  return true;
}
export const updateStatus = (): UpdateStatus => ({ ...status });

/**
 * In-app install is possible for the Windows installer's copy (its uninstaller sits next to the
 * exe) and the Linux AppImage. The portable exe, the zip, the .deb, .rpm and .tar.gz only tell
 * about a new version and open the releases page: an installer must not appear over them.
 */
const inAppPossible = () =>
  app.isPackaged &&
  ((process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE && existsSync(join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`))) || !!process.env.APPIMAGE);

function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** GitHub API: is there a newer release? (no in-app install from here) */
async function checkViaApi(): Promise<void> {
  const res = await fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Chud-Music-updater' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return void go('NOT_FOUND', { checkedAt: Date.now(), error: null }); // nothing published yet
  if (!res.ok) throw new Error(tr('upd.githubStatus', { status: String(res.status) }));
  const r = (await res.json()) as { tag_name?: string; name?: string; body?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
  const version = (r.tag_name ?? r.name ?? '').replace(/^v/, '');
  if (version && newer(version, status.current)) go('FOUND', { version, notes: r.body ?? null, inApp: false, releaseUrl: r.html_url ?? RELEASES_URL, checkedAt: Date.now(), error: null });
  else go('NOT_FOUND', { checkedAt: Date.now(), error: null });
}

let checking: Promise<void> | null = null;
export function checkForUpdates(): Promise<void> {
  checking ??= (async () => {
    // downloading or downloaded: nothing to look for any more
    if (!go('CHECK', { error: null })) return;
    try {
      if (inAppPossible()) {
        try {
          const r = await autoUpdater.checkForUpdates();
          const v = r?.updateInfo.version;
          if (v && newer(v, status.current)) {
            feedFile = basename(new URL(r.updateInfo.files[0]?.url ?? r.updateInfo.path, 'https://x/').pathname);
            const notes = typeof r.updateInfo.releaseNotes === 'string' ? r.updateInfo.releaseNotes : (r.updateInfo.releaseNotes?.map((n) => n.note).join('\n') ?? null);
            return void go('FOUND', { version: v, notes, inApp: true, checkedAt: Date.now() });
          }
          return void go('NOT_FOUND', { checkedAt: Date.now() });
        } catch {
          // no latest.yml in the release (or no release at all): ask the API instead
        }
      }
      await checkViaApi();
    } catch (e) {
      // an update found earlier stays offered when GitHub cannot be reached this time
      if (phase === 'rechecking') go('CHECK_FAILED');
      else go('CHECK_FAILED', { error: /fetch|network|ENOTFOUND|timeout/i.test(String(e)) ? tr('net.github') : e instanceof Error ? e.message : String(e), checkedAt: Date.now() });
    }
  })().finally(() => (checking = null));
  return checking;
}

// The installer named by the release feed when the update was found ("Chud-Music-Setup-1.5.0.exe"):
// its signature is published beside it as "<name>.sig".
let feedFile: string | null = null;
// The isolated test profile may check against a test key (tests/e2e/updates.mjs); never otherwise.
const publicKey = () => (process.env.CHUD_USER_DATA && process.env.CHUD_UPDATE_PUBKEY) || UPDATE_PUBLIC_KEY;
const signatureUrl = (version: string, file: string): string =>
  process.env.CHUD_UPDATE_FEED ? new URL(`${encodeURIComponent(file)}.sig`, process.env.CHUD_UPDATE_FEED).href : `${RELEASES_URL}/download/v${encodeURIComponent(version)}/${encodeURIComponent(file)}.sig`;

/** Null when the downloaded installer carries our signature, else why not (for the log). */
async function signatureProblem(downloaded: string | undefined, version: string | null): Promise<string | null> {
  if (!downloaded || !version || !feedFile) return 'nothing to check';
  const res = await fetch(signatureUrl(version, feedFile), { headers: { 'User-Agent': 'Chud-Music-updater' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return `no signature (${res.status})`;
  const sig = (await res.text()).slice(0, 200);
  return verifyUpdate(version, await sha512File(downloaded), sig, publicKey()) ? null : 'wrong signature';
}

/** Downloads the update in-app, or opens the releases page when that is not possible. */
export async function downloadUpdate(): Promise<void> {
  if (!status.inApp) {
    void shell.openExternal(status.releaseUrl);
    return;
  }
  // one download at a time, and only of an update that was found (a notification's button can
  // be clicked after the state has moved on)
  if (!go('DOWNLOAD', { progress: 0, error: null })) return;
  let files: string[];
  try {
    files = await autoUpdater.downloadUpdate();
  } catch (e) {
    go('DOWNLOAD_FAILED', { error: tr('upd.downloadFailed', { error: e instanceof Error ? e.message : String(e) }), inApp: false });
    return;
  }
  // SHA-512 checked by electron-updater against latest.yml; now our own signature, before the
  // update is offered for install. Refused: only the releases page is offered (manual download).
  let problem: string | null;
  try {
    problem = await signatureProblem(files.find((f) => !f.endsWith('.blockmap')), status.version);
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  if (problem) {
    log('warn', 'updates', `update ${status.version} refused: ${problem}`);
    go('DOWNLOAD_FAILED', { error: tr('upd.unsigned'), inApp: false });
    return;
  }
  go('DOWNLOADED', { progress: 100 });
}

/** Quits, runs the installer (same folder, data untouched) and restarts Chud Music. */
export function installUpdate(): void {
  if (status.state === 'downloaded') autoUpdater.quitAndInstall(false, true);
}

export function openReleases(): void {
  void shell.openExternal(status.releaseUrl);
}

export function initUpdater(onStatus: (s: UpdateStatus) => void, autoCheck: boolean): void {
  notify = onStatus;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false; // the user decides when
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  // Tests point the updater at a local feed instead of GitHub.
  if (process.env.CHUD_UPDATE_FEED) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.CHUD_UPDATE_FEED });
    autoUpdater.logger = console;
  }
  // failures are reported through the promises above; without a listener, an 'error' event
  // would be thrown in the main process
  autoUpdater.on('error', (e) => log('warn', 'updates', e instanceof Error ? e.message : String(e)));
  autoUpdater.on('download-progress', (p) => go('PROGRESS', { progress: Math.round(p.percent) }));
  // the download ends in downloadUpdate(), once the signature is checked (not on 'update-downloaded')
  setAutoCheck(autoCheck, 8000);
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Automatic checks on or off (the setting applies at once, not at the next launch). */
export function setAutoCheck(on: boolean, firstDelay = 0): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (!on) return;
  setTimeout(() => void checkForUpdates(), firstDelay).unref();
  timer = setInterval(() => void checkForUpdates(), CHECK_EVERY);
  timer.unref();
}
