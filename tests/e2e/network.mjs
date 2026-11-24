// Shares that come and go: two library folders standing for two NAS (the tests' own switch makes
// a folder "offline": netpath.ts, testOffline). Offline test: no network is used.
//   metadata cache, a NAS down while the other works, back by itself, a folder lost during a scan,
//   playback waiting for a share, restart while a NAS is off, messages.
import { copyFileSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('network');
const profile = tempDir('chud-net-');
const base = tempDir('chud-net-nas-');
const A = join(base, 'NAS-A');
const B = join(base, 'NAS-B');
const flag = join(base, 'offline.txt');
Object.assign(process.env, { CHUD_TEST_NETWORK_FOLDERS: '1', CHUD_TEST_OFFLINE: flag, CHUD_TEST_NETWORK_ROOT: A, CHUD_RETRY_MS: '1000' });
let app, win;
const offline = (dir) => (dir ? writeFileSync(flag, dir) : rmSync(flag, { force: true }));
const tracks = () => win.evaluate(() => window.chud.library.tracks());
const of = async (dir) => (await tracks()).filter((x) => x.path.toLowerCase().startsWith(dir.toLowerCase()));
const status = () => win.evaluate(() => window.chud.library.status());
const rescan = async () => {
  await win.evaluate(() => window.chud.library.rescan());
  await waitScanIdle(win);
};
const waitFor = async (fn, ms = 12_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
};
const player = () => win.evaluate(() => { const p = window.chudTest.player.getState(); return { title: p.current?.title, status: p.status, time: window.chudTest.engine.currentTime }; });
const shown = () => win.evaluate(() => window.chudTest.library.getState().tracks.map((x) => ({ path: x.path, available: x.available })));

try {
  for (const d of [A, B]) for (const al of ['Album 1', 'Album 2']) mkdirSync(join(d, al), { recursive: true });
  for (const [d, n] of [[A, 'a'], [B, 'b']]) {
    copyFileSync(join(music, '01 - Minuit Chrome.mp3'), join(d, 'Album 1', `${n}1.mp3`));
    copyFileSync(join(music, '02 - Boulevard des Ondes.mp3'), join(d, 'Album 1', `${n}2.mp3`));
    copyFileSync(join(music, 'Fractale.flac'), join(d, 'Album 2', `${n}3.flac`));
  }
  ({ app, win } = await launch(profile));
  for (const d of [A, B]) {
    await win.evaluate((p) => window.chud.library.addFolder(p), d);
    await waitScanIdle(win);
  }
  t.check('two shares at once: three tracks from each', (await of(A)).length === 3 && (await of(B)).length === 3);

  // ── metadata cache
  await rescan();
  const again = await status();
  t.check('scanned again: 6 files seen, none read again', again.found === 6 && again.parsed === 0, `${again.found} seen, ${again.parsed} read`);
  copyFileSync(join(music, 'Fractale.flac'), join(B, 'Album 1', 'b1.mp3')); // another content under the same name
  await rescan();
  t.check('a file that changed: that one only', (await status()).parsed === 1, String((await status()).parsed));

  // ── a NAS goes down, the other goes on
  offline(A);
  copyFileSync(join(music, '02 - Boulevard des Ondes.mp3'), join(B, 'Album 2', 'b4.mp3'));
  await rescan();
  const down = await of(A);
  t.check('a NAS is off: its tracks stay in the library, marked unavailable', down.length === 3 && down.every((x) => !x.available), down.map((x) => x.available).join());
  t.check('…the other one is read normally', (await of(B)).length === 4 && (await of(B)).every((x) => x.available));
  t.check('…the interface follows', await waitFor(async () => (await shown()).filter((x) => !x.available).length === 3));
  await gotoNav(win, 'Paramètres');
  const row = win.locator('.setting-row', { hasText: A });
  await row.scrollIntoViewIfNeeded();
  t.check('Settings say so, and what to do', await waitFor(async () => /NAS/.test((await row.innerText()).replace(A, ''))), (await row.innerText()).replace(/\n/g, ' ').slice(0, 220));
  await win.screenshot({ path: join(shots, 'network-01-offline.png') });
  offline(null);
  t.check('back: found again by itself', await waitFor(async () => (await of(A)).every((x) => x.available)));
  await waitScanIdle(win);
  t.check('…and not read again', (await status()).parsed === 0, String((await status()).parsed));

  // ── a folder is lost during a scan
  offline(join(A, 'Album 1'));
  await rescan();
  t.check('a folder that does not answer during a scan: its tracks stay', (await of(A)).length === 3 && (await of(A)).every((x) => x.available));
  t.check('…and it is said', (await status()).unread === 1 && (await waitFor(async () => (await win.locator('[data-scan-unread]').count()) === 1)), JSON.stringify(await status()));
  offline(null);
  t.check('…it is read again by itself', await waitFor(async () => (await status()).unread === 0));
  unlinkSync(join(A, 'Album 1', 'a2.mp3'));
  await rescan();
  t.check('a file really deleted does leave the library', (await of(A)).length === 2);

  // ── playback: the share drops between two tracks
  const listA = (await of(A)).sort((x, y) => x.path.localeCompare(y.path));
  await win.evaluate((x) => window.chudTest.player.getState().playFrom('section:library', 'T', x, 0), listA);
  await waitFor(async () => (await player()).status === 'playing');
  await win.evaluate(() => window.chudTest.player.getState().seek(1));
  offline(A);
  await win.evaluate(() => window.chudTest.player.getState().next());
  t.check('the share does not answer: playback waits instead of skipping', await waitFor(async () => (await win.locator('.toast').allInnerTexts()).some((x) => /répond|réseau|partage/i.test(x))), (await win.locator('.toast').allInnerTexts()).join(' / ').replace(/\n/g, ' '));
  await sleep(1500);
  const waiting = await player();
  t.check('…on that track', waiting.status === 'loading' && waiting.title === listA[1].title, JSON.stringify(waiting));
  offline(null);
  t.check('back: it plays', await waitFor(async () => (await player()).status === 'playing' && (await player()).title === listA[1].title, 20_000), JSON.stringify(await player()));
  await win.evaluate(() => window.chudTest.player.getState().toggle());

  // ── a file that is not there any more: what to do
  const before = (await of(B))[0];
  unlinkSync(before.path);
  await win.evaluate((x) => window.chudTest.player.getState().playFrom('section:library', 'T', [x], 0), before);
  t.check('a missing file: the message says what to do', await waitFor(async () => (await win.locator('.toast').allInnerTexts()).some((x) => /relancez l’analyse/.test(x))), (await win.locator('.toast').allInnerTexts()).join(' / ').replace(/\n/g, ' '));

  // ── restart while a NAS is off
  await rescan();
  const n = (await tracks()).length;
  offline(A);
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(3500);
  await waitScanIdle(win);
  t.check('restart with a NAS off: nothing is lost', (await tracks()).length === n && (await of(A)).every((x) => !x.available), `${(await tracks()).length} / ${n}`);
  offline(null);
  t.check('…and it comes back by itself', await waitFor(async () => (await of(A)).every((x) => x.available)));
  // both at once
  offline(base);
  await rescan();
  t.check('both off: everything stays', (await tracks()).length === n);
  offline(null);
  t.check('both back', await waitFor(async () => (await tracks()).every((x) => x.available)));
} catch (e) {
  t.check('no unexpected error', false, e.stack ?? String(e));
  await win?.screenshot({ path: join(shots, 'network-error.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, base);
}
process.exit(t.finish() ? 1 : 0);
