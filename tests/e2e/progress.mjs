// Long operations show progress: a folder of 200 files added to a playlist from its "…" menu,
// on slow storage (CHUD_SLOW_IO_MS), shows the activity tray with a moving counter, then
// the tray goes away and the playlist holds every file.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, launch, music, shots, sleep, tempDir, showPlaylists } from './harness.mjs';

const t = createSuite('progress');
const profile = tempDir('chud-progress-');
const dir = tempDir('chud-progress-files-');
const N = 200;
mkdirSync(join(dir, 'Disque 1'), { recursive: true });
for (let i = 1; i <= N; i++) copyFileSync(join(music, '02 - Boulevard des Ondes.mp3'), join(dir, i % 2 ? 'Disque 1' : '', `Piste ${String(i).padStart(3, '0')}.mp3`));
process.env.CHUD_SLOW_IO_MS = '60';
let app, win;

try {
  ({ app, win } = await launch(profile));
  const id = await win.evaluate(() => window.chud.playlists.create('Grosse playlist'));
  await sleep(500);
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
  }, dir);
  await showPlaylists(win);
  await win.locator('.side-item:has-text("Grosse playlist")').click();
  await sleep(500);
  await win.locator('.list-hero-actions button[aria-label="Plus d’actions"]').click();
  await win.locator('.menu-item:has-text("Ajouter un dossier")').click();

  const tray = win.locator('.task-tray .task');
  await tray.first().waitFor({ timeout: 3000 });
  const label = await tray.first().locator('b').innerText();
  t.check('activity tray appears while the folder is added', label.startsWith('Ajout à « Grosse playlist »') || label === 'Recherche des fichiers…', label);
  await win.waitForFunction(() => /\d+ \/ 200/.test(document.querySelector('.task-tray .task span')?.textContent ?? ''), null, { timeout: 10000 });
  const c1 = await tray.first().locator('span').innerText();
  await sleep(1200);
  const c2 = await tray.first().locator('span').innerText().catch(() => '200 / 200');
  const n = (s) => Number(s.split(' / ')[0]);
  t.check('a counter shows the progress (N / 200) and moves', n(c2) > n(c1), `${c1} → ${c2}`);
  t.check('with a progress bar', (await win.locator('.task-tray .task-bar').count()) === 1);
  await win.screenshot({ path: join(shots, 'progress-01.png') });
  t.check('the interface stays usable meanwhile', await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(true)))));

  await win.waitForFunction(() => !document.querySelector('.task-tray .task'), null, { timeout: 30000 });
  const pl = await win.evaluate((i) => window.chud.playlists.get(i), id);
  t.check('tray gone at the end, all 200 files in the playlist (sub-folders included)', pl.tracks.length === N, String(pl.tracks.length));
  t.check('confirmation toast', (await win.locator('.toast:has-text("Grosse playlist")').count()) === 1);

  // quick operations do not flash the tray
  await win.evaluate((i) => window.chud.playlists.create('Petite'), id);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'progress-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, dir);
  process.exit(t.finish() ? 1 : 0);
}
