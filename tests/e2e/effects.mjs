// Canvas UI effects: HTML-in-canvas is live, covers (cross-origin chud-media://) render inside the
// effect canvases without tainting them, the glitch fires on track change, the ripple on click,
// and Effets = Réduits removes every effect canvas. Screenshots go to tests/output/effects.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, root, secondInstance, sleep, tempDir } from './harness.mjs';

const t = createSuite('effects');
const profile = tempDir('chud-fx-');
const out = join(root, 'tests/output/effects');
mkdirSync(out, { recursive: true });
let app, win;

// mean |pixel - previous pixel| over a canvas, to tell a drawn cover from an empty/black frame
const coverStats = (sel) =>
  win.evaluate((sel) => {
    const src = document.querySelector(sel);
    if (!src) return null;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    try {
      g.drawImage(src, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data;
      let lum = 0;
      for (let i = 0; i < d.length; i += 4) lum += d[i] + d[i + 1] + d[i + 2];
      return { tainted: false, meanLum: lum / (d.length / 4) / 3 };
    } catch {
      return { tainted: true, meanLum: -1 };
    }
  }, sel);

try {
  const errors = [];
  ({ app, win } = await launch(profile));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  win.on('pageerror', (e) => errors.push(e.message));
  await sleep(1200);

  const support = await win.evaluate(() => {
    const c = document.createElement('canvas');
    return typeof c.getContext('2d').drawElementImage === 'function' && typeof c.requestPaint === 'function';
  });
  t.check('HTML-in-canvas is enabled', support);
  t.check('idle living cover runs the VHS effect', (await win.locator('.living-cover-frame canvas').count()) === 2);
  await win.locator('.living-cover').screenshot({ path: join(out, 'vhs-idle.png') });

  // two covered files opened like an Explorer double-click: "Fichiers ouverts" tab, autoplay (nothing was playing)
  await secondInstance(profile, join(music, 'Fractale.flac'), join(music, '01 - Minuit Chrome.mp3'));
  await win.waitForSelector('.tab >> text=Fichiers ouverts', { timeout: 10000 });
  await sleep(2500);
  // the 2D source canvas holds the captured HTML: a tainted capture would throw on read
  const output = '.living-cover-frame canvas:first-of-type';
  const stats = await coverStats(output);
  t.check('cover captured into the effect canvas without tainting it', stats && !stats.tainted && stats.meanLum > 20, JSON.stringify(stats));
  await win.locator('.living-cover').screenshot({ path: join(out, 'cover.png') });

  await win.locator('button[aria-label="Suivant"]').click();
  await sleep(140);
  await win.locator('.living-cover').screenshot({ path: join(out, 'glitch-burst.png') });
  await sleep(900);
  await win.locator('.living-cover').screenshot({ path: join(out, 'after-glitch.png') });

  await gotoNav(win, 'Accueil');
  await sleep(600);
  const host = win.locator('.resume-art-host');
  t.check('home shows the resumable track with a ripple cover', (await host.count()) === 1 && (await host.locator('canvas').count()) === 2);
  const before = await win.evaluate(() => document.querySelector('.np-title')?.textContent);
  const box = await host.boundingBox();
  await win.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await sleep(250);
  await host.screenshot({ path: join(out, 'ripple.png') });
  const status = await win.evaluate(() => document.querySelector('.play-btn')?.getAttribute('aria-label'));
  t.check('clicking the cover toggles playback', status === 'Lecture', `${before} → bouton ${status}`);

  // Effets = Réduits: every effect canvas disappears, content stays
  await gotoNav(win, 'Paramètres');
  await win.locator('.segmented button:has-text("Réduits")').click();
  await gotoNav(win, 'Accueil');
  await sleep(400);
  t.check('reduced effects: no effect canvas left', (await win.locator('.living-cover-frame canvas, .resume-art-host canvas').count()) === 0 && (await win.locator('.living-cover-frame img').count()) === 1);

  t.check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
