// Screenshots for the GitHub README (docs/screenshots/readme-*.png): one window size, the test
// fixtures only (generated tracks and covers), a temporary profile. Radio needs Internet.
import { join } from 'node:path';
import { root, cleanup, gotoNav, launch, music, sleep, tempDir, waitScanIdle } from './harness.mjs';

const out = (n) => join(root, 'docs/screenshots', `readme-${n}.png`);
const profile = tempDir('chud-readme-');
let app, win;
const resize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
  const b = BrowserWindow.getAllWindows()[0];
  b.unmaximize();
  b.setContentSize(w, h);
}, [w, h]);
// as a user would: the skin cards in Settings, then back to the home page
const skin = async (name, effects) => {
  await gotoNav(win, 'Paramètres');
  await win.locator(`.skin-card:has-text("${name}")`).click();
  if (effects) await win.locator('.segmented button:has-text("Complets")').first().click();
  await gotoNav(win, 'Accueil');
  await sleep(700);
};

try {
  ({ app, win } = await launch(profile));
  await resize(1320, 820);
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  await gotoNav(win, 'Bibliothèque');
  await win.waitForSelector('.page .tl-body .tl-row');
  await win.locator('.page .tl-row:has-text("Fractale")').first().dblclick();
  await sleep(2500);

  await gotoNav(win, 'Accueil');
  await sleep(1200);
  await win.screenshot({ path: out('accueil') });

  await gotoNav(win, 'Bibliothèque');
  await sleep(800);
  await win.screenshot({ path: out('bibliotheque') });

  await gotoNav(win, 'Visualiseur');
  await win.waitForFunction(() => document.querySelector('.viz-canvas')?.dataset.preset, null, { timeout: 20000 }).catch(() => {});
  await sleep(4000);
  await win.screenshot({ path: out('visualiseur') });

  await gotoNav(win, 'Radio');
  await win.waitForSelector('.radio-country', { timeout: 20000 }).catch(() => {});
  await win.locator('.radio-country:has-text("France")').first().click().catch(() => {});
  await sleep(3500);
  await win.screenshot({ path: out('radio') });

  // the equalizer menu over the home page
  await gotoNav(win, 'Accueil');
  await win.locator('.playerbar button[aria-label="Égaliseur"]').first().click().catch(() => {});
  await sleep(800);
  await win.screenshot({ path: out('egaliseur') });
  await win.keyboard.press('Escape');
  await sleep(400);

  for (const [s, name] of [['cassette', 'Cassette 98'], ['aqua', 'Aqua Glow'], ['platine', 'Platine'], ['signal', 'Signal']]) {
    await skin(name, s === 'signal');
    await sleep(1500);
    await win.screenshot({ path: out(`skin-${s}`) });
  }
  await skin('Chud Nocturne');

  await win.locator('button.mini-open').first().click();
  await sleep(1500);
  await win.screenshot({ path: out('mini') });
  console.log('readme screenshots written to docs/screenshots');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
}
