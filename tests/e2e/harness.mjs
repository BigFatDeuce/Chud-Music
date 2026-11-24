// Shared helpers for the end-to-end tests. Set CHUD_EXE to test the packaged app
// (e.g. dist/win-unpacked/Chud Music.exe) instead of the development build.
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const music = join(root, 'tests/fixtures/music');
export const shots = join(root, 'tests/output');
mkdirSync(shots, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const main = process.env.CHUD_MAIN ?? join(root, 'out/main/index.js');
const exe = process.env.CHUD_EXE;

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(...dirs) {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp dir, best effort */ }
  }
}

export function createSuite(name) {
  const results = [];
  return {
    check(label, ok, detail = '') {
      results.push({ label, ok });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n[${name}] ${results.length - failed}/${results.length} checks passed${exe ? ' (packaged app)' : ''}`);
      return failed;
    },
  };
}

// Tests run quietly in the background: off-screen window, no focus stolen, sound muted.
// Set CHUD_TEST_VISIBLE=1 to watch a run.
const quiet = process.env.CHUD_TEST_VISIBLE ? {} : { CHUD_TEST_QUIET: '1' };
// the catch-up scan at start waits 30 s in real use; 1 s in tests (unless a test sets it)
const startScan = () => ({ CHUD_STARTUP_SCAN_MS: process.env.CHUD_STARTUP_SCAN_MS ?? '1000' });
// The checks read French labels: the interface is in French whatever the system language
// (unless a test sets CHUD_LANG itself).
const lang = () => ({ CHUD_LANG: process.env.CHUD_LANG ?? 'fr' });

export async function launch(profile, args = []) {
  const env = { ...process.env, ...quiet, ...lang(), ...startScan(), CHUD_USER_DATA: profile };
  const app = await electron.launch(exe ? { executablePath: exe, args, env } : { args: [main, ...args], env });
  const win = await app.firstWindow();
  await win.waitForSelector('.playerbar');
  return { app, win };
}

/** Simulates Explorer launching the app again with files (forwarded to the running instance). */
export function secondInstance(profile, ...files) {
  const env = { ...process.env, ...quiet, ...lang(), ...startScan(), CHUD_USER_DATA: profile };
  return new Promise((res) => {
    const p = exe ? spawn(exe, files, { env, stdio: 'ignore' }) : spawn(electronPath, [main, ...files], { env, stdio: 'ignore' });
    p.on('exit', (code) => res(code));
  });
}

export const parseTime = (s) => {
  const m = /(-?)(\d+):(\d\d)/.exec(s ?? '');
  return m ? Number(m[2]) * 60 + Number(m[3]) : NaN;
};
export const npTitle = (win) => win.locator('.np-title').innerText();
export const elapsed = async (win) => parseTime(await win.locator('.seek-row .time').first().innerText());
export const tabLabels = (win) => win.locator('.tab .tab-label').allInnerTexts();

/** Page transitions keep the outgoing page in the DOM for ~200 ms: wait it out. */
export async function gotoTab(win, label) {
  await win.locator(`.tab:has-text("${label}")`).click();
  await sleep(450);
}
export async function gotoNav(win, label) {
  await win.locator(`.nav-item:has-text("${label}")`).click();
  await sleep(450);
}
export async function waitScanIdle(win, timeout = 60000) {
  const t0 = Date.now();
  await sleep(300);
  while (Date.now() - t0 < timeout) {
    if (!(await win.evaluate(() => window.chud.library.status())).running) return Date.now() - t0;
    await sleep(200);
  }
  throw new Error('scan did not finish');
}

/** The sidebar box shows the cover by default: switch it to the playlists (the choice is saved). */
export async function showPlaylists(win) {
  const btn = win.locator('.deck-switch button:has-text("Playlists")');
  if ((await btn.getAttribute('aria-selected')) !== 'true') {
    await btn.click();
    await sleep(250);
  }
}
