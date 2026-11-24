// Screenshots of the home hero (clock LCD) in the three skins, empty and while playing.
import { join } from 'node:path';
import { cleanup, gotoNav, launch, music, shots, sleep, tempDir } from './harness.mjs';

const profile = tempDir('chud-home-');
let app, win;
try {
  ({ app, win } = await launch(profile));
  await sleep(1200);
  for (const skin of ['nocturne', 'cassette', 'aqua']) {
    await win.evaluate((s) => window.chud.settings.set({ skin: s }).then(() => (document.documentElement.dataset.skin = s)), skin);
    await sleep(400);
    await win.locator('.home-hero').screenshot({ path: join(shots, `home-hero-empty-${skin}.png`) });
  }
  await app.close();
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  await sleep(2500);
  await gotoNav(win, 'Accueil');
  for (const skin of ['nocturne', 'cassette', 'aqua']) {
    await win.evaluate((s) => (document.documentElement.dataset.skin = s), skin);
    await sleep(400);
    await win.locator('.home-hero').screenshot({ path: join(shots, `home-hero-playing-${skin}.png`) });
  }
  await win.setViewportSize?.({ width: 1000, height: 760 }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
  await sleep(600);
  await win.locator('.home-hero').screenshot({ path: join(shots, 'home-hero-narrow.png') });
  await app.close();
  app = null;
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
}
