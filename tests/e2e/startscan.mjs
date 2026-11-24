// The catch-up scan at start waits (30 s in real use; 4 s here), and is not made at all when the
// library is scanned by hand meanwhile (Library › … › Scan the library).
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, sleep, tempDir, waitScanIdle } from './harness.mjs';

process.env.CHUD_STARTUP_SCAN_MS = '4000';
const t = createSuite('startscan');
const profile = tempDir('chud-startscan-');
const lib = tempDir('chud-startscan-lib-');
mkdirSync(join(lib, 'A'));
copyFileSync(join(music, '01 - Minuit Chrome.mp3'), join(lib, 'A', 'un.mp3'));
let app, win;
const status = () => win.evaluate(() => window.chud.library.status());
const count = async () => (await win.evaluate(() => window.chud.library.tracks())).length;

try {
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await waitScanIdle(win);
  const first = (await status()).lastScanAt;
  t.check('folder added: scanned at once', (await count()) === 1 && !!first);
  await app.close();

  // ── a file added while the app is closed: found by the delayed scan, not before ──
  copyFileSync(join(music, '02 - Boulevard des Ondes.mp3'), join(lib, 'A', 'deux.mp3'));
  const launchedAt = Date.now();
  ({ app, win } = await launch(profile));
  await sleep(Math.max(0, 2000 - (Date.now() - launchedAt)));
  const early = await status();
  t.check('no scan in the first seconds after start', early.lastScanAt === first && !early.running && (await count()) === 1);
  await sleep(4500);
  await waitScanIdle(win);
  const late = await status();
  t.check('the delayed scan ran and found the new file', late.lastScanAt > first && (await count()) === 2, `${((late.lastScanAt - launchedAt) / 1000).toFixed(1)} s after launch`);
  await app.close();

  // ── scanned by hand from the menu right after start: the delayed scan is dropped ──
  // (no new file this time: the folder watcher may look again at a file just read for the
  // first time, which would blur what is measured here)
  ({ app, win } = await launch(profile));
  await gotoNav(win, 'Bibliothèque');
  await win.locator('.lib-actions button[aria-label="Plus d’actions"]').click();
  const item = win.locator('.menu-item:has-text("Scanner la bibliothèque")');
  t.check('the library menu offers a manual scan', (await item.count()) === 1);
  await item.click();
  await waitScanIdle(win);
  const manual = await status();
  t.check('manual scan done', (await count()) === 2 && manual.lastScanAt > late.lastScanAt);
  await sleep(6000);
  const after = await status();
  t.check('no second scan once the delay is over', after.lastScanAt === manual.lastScanAt && !after.running);
} catch (e) {
  t.check('startscan run', false, e.message);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
}
process.exit(t.finish() ? 1 : 0);
