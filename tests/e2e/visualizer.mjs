// Visualiser: butterchurn presets rendering for real (window captures), fed while a local file
// plays, preset navigation, list, automatic cycling setting, fullscreen, persistence.
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('visualizer');
const profile = tempDir('chud-viz-');
let app, win;
const preset = () => win.locator('.viz-canvas').getAttribute('data-preset');
const fps = async () => Number(await win.locator('.viz-canvas').getAttribute('data-fps'));

/** Mean luminance and a coarse fingerprint of the canvas area, from a real window capture. */
async function capture() {
  const box = await win.locator('.viz-canvas').boundingBox();
  return app.evaluate(async ({ BrowserWindow }, r) => {
    const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    const { width, height } = img.getSize();
    const px = img.toBitmap(); // BGRA
    let sum = 0;
    const cells = [];
    for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
      let c = 0;
      for (let k = 0; k < 16; k++) {
        const x = Math.floor(((gx + (k % 4) / 4) * width) / 8), y = Math.floor(((gy + Math.floor(k / 4) / 4) * height) / 8);
        const i = (y * width + x) * 4;
        c += 0.0722 * px[i] + 0.7152 * px[i + 1] + 0.2126 * px[i + 2];
      }
      cells.push(Math.round(c / 16));
      sum += c / 16;
    }
    return { mean: sum / 64, cells };
  }, box);
}
let wiggle = 0;
/** The controls fade out when the mouse rests: move it first, like a user would. */
const wake = async () => { wiggle = 1 - wiggle; await win.mouse.move(500 + wiggle * 40, 380); await sleep(250); };
const diff = (a, b) => a.cells.reduce((s, v, i) => s + Math.abs(v - b.cells[i]), 0) / a.cells.length;

try {
  const errors = [];
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await sleep(2000);

  // start on a fixed, bright preset: the edge check must not depend on a random dark one
  await win.evaluate(() => window.chud.settings.set({ viz: { preset: 'Flexi - crush ice 72', autoCycle: true, cycleSec: 30, random: true } }));
  await app.close();
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await sleep(2000);
  await gotoNav(win, 'Visualiseur');
  await win.waitForFunction(() => document.querySelector('.viz-canvas')?.dataset.preset, null, { timeout: 20000 });
  const first = await preset();
  t.check('presets load and one is shown', !!first && (await win.locator('.viz-preset b').innerText()).length > 0, first);
  await sleep(2500);
  const a = await capture();
  await sleep(700);
  const b = await capture();
  t.check('the canvas really renders (not black)', a.mean > 3, `mean luminance ${a.mean.toFixed(1)}`);
  const dims = await win.evaluate(() => { const c = document.querySelector('.viz-canvas'); const r = Math.min(devicePixelRatio, 1.5); return { w: c.width, h: c.height, cw: Math.round(c.clientWidth * r), ch: Math.round(c.clientHeight * r) }; });
  t.check('rendered at the stage size (fills the whole area)', Math.abs(dims.w - dims.cw) <= 1 && Math.abs(dims.h - dims.ch) <= 1, JSON.stringify(dims));
  const right = a.cells.filter((_, i) => i % 8 >= 6).reduce((s, v) => s + v, 0) + b.cells.filter((_, i) => i % 8 >= 6).reduce((s, v) => s + v, 0);
  t.check('picture reaches the right edge', right > 0, String(right));
  t.check('and it moves', diff(a, b) > 0.5, `frame difference ${diff(a, b).toFixed(2)}`);
  const f = await fps();
  t.check('frame rate while music plays (≥ 30 fps)', f >= 30, `${f} fps`);
  t.check('fed by local playback: no waiting notice', (await win.locator('.viz-notice').count()) === 0);
  t.check('the node feeding it carries the sound while playing', (await win.locator('.viz-canvas').getAttribute('data-signal')) === '1');
  await win.screenshot({ path: join(shots, 'viz-01.png') });

  // controls fade out after a rest, come back on mouse move
  await win.mouse.move(600, 400);
  await sleep(3200);
  t.check('controls hide when the mouse rests', (await win.locator('.viz-stage.idle').count()) === 1);
  await win.mouse.move(640, 420);
  await sleep(300);
  t.check('and come back on mouse move', (await win.locator('.viz-stage.idle').count()) === 0);

  // next / previous
  await wake();
  await win.locator('button[aria-label="Preset suivant"]').click();
  await sleep(600);
  const second = await preset();
  t.check('"Preset suivant" changes the preset', second && second !== first, second);
  await wake();
  await win.locator('button[aria-label="Preset précédent"]').click();
  await sleep(600);
  t.check('"Preset précédent" goes back to the one shown before', (await preset()) === first);
  await sleep(3000);
  await win.screenshot({ path: join(shots, 'viz-02.png') });

  // keyboard
  await win.keyboard.press('n');
  await sleep(600);
  t.check('N key: next preset', (await preset()) !== first);

  // preset list with search
  await wake();
  await win.locator('button[aria-label="Liste des presets"]').click();
  await sleep(300);
  const count = Number(await win.locator('.viz-drawer header span').innerText());
  t.check('preset list (base + extra packs)', count >= 250, `${count} presets`);
  await win.locator('.viz-drawer input').fill('geiss');
  await sleep(200);
  const hits = await win.locator('.viz-item').count();
  const pickName = await win.locator('.viz-item').nth(1).getAttribute('title');
  await win.locator('.viz-item').nth(1).click();
  await sleep(800);
  t.check('search and pick from the list', hits > 0 && hits < count && (await preset()) === pickName, `${hits} results → ${pickName}`);
  await sleep(2500);
  await win.screenshot({ path: join(shots, 'viz-03-list.png') });
  await win.keyboard.press('Escape');
  await sleep(300);

  // automatic cycling setting
  await wake();
  await win.locator('.viz-cycle button:has-text("60 s")').click();
  await sleep(300);
  const s1 = await win.evaluate(() => window.chud.settings.get());
  t.check('cycling interval saved', s1.viz.autoCycle && s1.viz.cycleSec === 60);

  // fullscreen
  await wake();
  await win.locator('button[aria-label="Plein écran"]').click();
  await sleep(1200);
  t.check('fullscreen on the visualiser only', await win.evaluate(() => document.fullscreenElement?.classList.contains('viz-stage') ?? false));
  await win.screenshot({ path: join(shots, 'viz-04-fullscreen.png') });
  await wake();
  await win.locator('button[aria-label="Quitter le plein écran"]').click({ force: true });
  await sleep(1000);
  t.check('leave fullscreen', await win.evaluate(() => !document.fullscreenElement));

  // paused: the visualiser keeps drawing, the notice only appears with nothing loaded
  const m = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ type: x.type, mb: Math.round(x.memory.workingSetSize / 1024) })));
  console.log(`INFO  memory with the visualiser: ${m.reduce((s, x) => s + x.mb, 0)} MB — ${m.map((x) => `${x.type}:${x.mb}`).join(', ')}`);

  // leaving the page stops it and frees the WebGL context
  const shown = await preset();
  await gotoNav(win, 'Accueil');
  t.check('leaving the page removes the canvas', (await win.locator('.viz-canvas').count()) === 0);
  t.check('no console errors (CSP, WASM, WebGL)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await app.close();

  // restart: last preset and settings remembered
  ({ app, win } = await launch(profile));
  await sleep(1200);
  await gotoNav(win, 'Visualiseur');
  await win.waitForFunction(() => document.querySelector('.viz-canvas')?.dataset.preset, null, { timeout: 20000 });
  t.check('last preset remembered after a restart', (await preset()) === shown, await preset());
  t.check('nothing playing: says it is waiting for music', (await win.locator('.viz-notice:has-text("En attente de musique")').count()) === 1);
  await sleep(1500);
  t.check('control: nothing played yet, so no signal reaches it', (await win.locator('.viz-canvas').getAttribute('data-signal')) === '0');
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'viz-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
