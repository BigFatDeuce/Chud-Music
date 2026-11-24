// Screenshots of the main screens in one skin (SKIN=platine node tests/e2e/shot-skin.mjs).
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, gotoNav, launch, music, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const skin = process.env.SKIN ?? 'platine';
const profile = tempDir('chud-skin-');
const lib = tempDir('chud-skin-lib-');
cpSync(music, join(lib, 'Albums'), { recursive: true });
let app, win;
const shot = (name) => win.screenshot({ path: join(shots, `skin-${skin}-${name}.png`) });
try {
  ({ app, win } = await launch(profile));
  await win.evaluate((s) => window.chud.settings.set({ skin: s }), skin);
  await win.evaluate(async (p) => {
    await window.chud.library.addFolder(p);
  }, join(lib, 'Albums'));
  await waitScanIdle(win);
  await app.close();
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  await sleep(2500);
  await gotoNav(win, 'Accueil');
  await shot('1-home');
  await gotoNav(win, 'Bibliothèque');
  await win.locator('.tl-row').nth(1).locator('.t-title').click();
  await shot('2-library');
  await win.locator('.tl-row').nth(1).click({ button: 'right' });
  await sleep(350);
  await shot('3-menu');
  await win.keyboard.press('Escape');
  await gotoNav(win, 'Paramètres');
  await shot('4-settings');
  await gotoNav(win, 'YouTube Music');
  await shot('5-youtube');
  await gotoNav(win, 'Visualiseur');
  await sleep(3000);
  await win.mouse.move(700, 500);
  await sleep(300);
  await shot('6-visualizer');
  await app.close();
  app = null;
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
}
