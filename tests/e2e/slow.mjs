// Files on slow storage (a network share): simulated with CHUD_SLOW_IO_MS, which delays the
// reading of each opened file in the main process. The app must open at once, show the files
// as loading rows, start playing without waiting for the tags, and fill the rows in later.
import { join } from 'node:path';
import { cleanup, createSuite, elapsed, launch, music, npTitle, secondInstance, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('slow');
const profile = tempDir('chud-slow-');
const DELAY = 5000;
process.env.CHUD_SLOW_IO_MS = String(DELAY);
let app, win;
const rows = () => win.locator('.page .tl-body .tl-row');

try {
  const t0 = Date.now();
  ({ app, win } = await launch(profile, [join(music, '01 - Minuit Chrome.mp3'), join(music, 'Fractale.flac'), join(music, 'Media Classique.wma')]));
  const shown = Date.now() - t0;
  t.check(`window ready without waiting for the files (< ${DELAY / 1000} s)`, shown < DELAY - 1000, `${shown} ms`);
  await win.waitForSelector('.tab.active >> text=Fichiers ouverts', { timeout: 4000 });
  await sleep(600);
  const pending = await win.locator('.page .tl-row.pending').count();
  t.check('the 3 files appear at once as loading rows', (await rows().count()) === 3 && pending === 3, `${pending} pending`);
  t.check('names guessed from the file names meanwhile', (await rows().first().locator('.t-title').innerText()) === 'Minuit Chrome');
  t.check('loading animation and counter shown', (await win.locator('.page .tl-row.pending .shimmer, .page .tl-row.pending .shimmer-text').count()) > 0 && (await win.locator('.loading-badge').innerText()).includes('3 fichiers en chargement'));
  await win.screenshot({ path: join(shots, 'slow-01-loading.png') });
  await sleep(1500);
  t.check('playback starts without waiting for the tags', (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1 && (await elapsed(win)) >= 1, `${await npTitle(win)} t=${await elapsed(win)}s`);
  t.check('the interface stays responsive meanwhile', await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(true)))));

  await win.waitForFunction(() => !document.querySelector('.page .tl-row.pending'), null, { timeout: DELAY * 3 });
  t.check('rows filled in once read (tags, codec)', (await win.locator('.page .tl-row:has-text("Les Cassettes")').count()) === 1 && (await win.locator('.page .tl-row .badge:has-text("FLAC")').count()) === 1);
  t.check('player bar updated with the real tags', (await win.locator('.np-artist').innerText()).includes('Les Cassettes'));
  await win.screenshot({ path: join(shots, 'slow-02-filled.png') });

  // more files arriving while slow: they join as loading rows, playback continues
  const before = await elapsed(win);
  await secondInstance(profile, join(music, 'Verre Bleu (ALAC).m4a'));
  await sleep(800);
  t.check('a file opened later joins as a loading row, playback not interrupted', (await win.locator('.page .tl-row.pending').count()) === 1 && (await elapsed(win)) >= before);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'slow-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
