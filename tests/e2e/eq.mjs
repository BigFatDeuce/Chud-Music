// Equaliser panel (values checked on the real filter nodes during playback), user presets,
// persistence, and the customisation settings (accent colour, interface size).
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('eq');
const profile = tempDir('chud-eq-');
let app, win;
const ROCK = [-4, 5, 3, -2, -4, -1, 2, 5, 6, 6, 6];
const applied = async () => {
  await sleep(500); // filters glide to their target (no zipper noise)
  const a = await win.locator('.eq-panel').getAttribute('data-applied');
  return a ? a.split(',').map(Number) : [];
};
const close = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.15);
const eqSetting = () => win.evaluate(() => window.chud.settings.get().then((s) => s.eq));

try {
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  await sleep(2500);
  await win.locator('button[aria-label="Égaliseur"]').click();
  await sleep(400);
  t.check('panel opens from the player bar', (await win.locator('.eq-panel').count()) === 1 && (await win.locator('.eq-vslider').count()) === 11);
  t.check('off by default: filters flat', close(await applied(), Array(11).fill(0)));

  await win.locator('.eq-preset').click();
  await win.locator('.menu-item:has-text("Rock")').click();
  t.check('preset "Rock" applied to the real filters', close(await applied(), ROCK), (await applied()).join(' '));
  const s1 = await eqSetting();
  t.check('and saved', s1.enabled && s1.preset === 'Rock' && s1.preampDb === -4);
  await win.screenshot({ path: join(shots, 'eq-01-rock.png') });

  // keyboard on the 60 Hz fader: +0.5 dB per arrow
  await win.locator('.eq-vslider[aria-label="60 Hz"]').focus();
  await win.keyboard.press('ArrowUp');
  await win.keyboard.press('ArrowUp');
  const k = await applied();
  t.check('arrow keys move a band (+1 dB), preset becomes "Personnalisé"', Math.abs(k[1] - 6) < 0.15 && (await win.locator('.eq-preset').innerText()).startsWith('Personnalisé'), String(k[1]));

  // mouse: drag the 3k fader to the top
  const box = await win.locator('.eq-vslider[aria-label="3k Hz"]').boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2, box.y + 2, { steps: 5 });
  await win.mouse.up();
  const m = await applied();
  t.check('dragging a fader to the top: +12 dB', Math.abs(m[6] - 12) < 0.6, String(m[6]));
  await win.locator('.eq-vslider[aria-label="3k Hz"]').dblclick();
  t.check('double-click puts it back to 0', Math.abs((await applied())[6]) < 0.15);

  // save as a user preset
  await win.locator('.eq-preset').click();
  await win.locator('.menu-item:has-text("Enregistrer les réglages")').click();
  await win.locator('.dialog input').fill('Mon test');
  await win.locator('.dialog button[type=submit]').click();
  await sleep(300);
  const s2 = await win.evaluate(() => window.chud.settings.get());
  t.check('user preset saved', s2.eqUserPresets.some((p) => p.name === 'Mon test') && s2.eq.preset === 'Mon test');

  // switch off: filters flat again, settings kept
  await win.locator('.eq-head button:text-is("Désactivé")').click();
  t.check('switched off: filters flat, curve kept for later', close(await applied(), Array(11).fill(0)) && (await eqSetting()).gains[0] === 6);
  await win.locator('.eq-head button:text-is("Activé")').click();
  const back = await applied();
  t.check('switched on again: same settings', Math.abs(back[1] - 6) < 0.15);
  await win.keyboard.press('Escape');
  await sleep(300);
  t.check('Escape closes the panel', (await win.locator('.eq-panel').count()) === 0);
  await app.close();

  // restart: settings and user preset come back, and apply to playback
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  await sleep(2500);
  await win.locator('button[aria-label="Égaliseur"]').click();
  const r = await applied();
  t.check('after a restart the equaliser applies the saved settings', Math.abs(r[1] - 6) < 0.15 && Math.abs(r[0] + 4) < 0.15, r.join(' '));
  await win.locator('.eq-preset').click();
  await sleep(300);
  await win.screenshot({ path: join(shots, 'eq-03-menu.png') });
  t.check('and the user preset is in the list', (await win.locator('.menu-item .menu-label:text-is("Mon test")').count()) === 1);
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');

  // customisation
  await gotoNav(win, 'Paramètres');
  await win.locator('.accent-swatch[aria-label="Magenta"]').click();
  await sleep(200);
  const acc = await win.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim()]);
  t.check('accent colour applied over the skin', acc[0] === '#ff3fa4', acc.join(' '));
  await win.locator('.settings-group:has(h3:text-is("Personnalisation"))').screenshot({ path: join(shots, 'eq-02-custom.png') });
  await win.locator('.accent-skin').click();
  await sleep(200);
  t.check('"Skin" restores the skin’s own accent', (await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#c6ff2e');
  const w0 = await win.evaluate(() => window.innerWidth);
  await win.locator('.segmented[aria-label="Taille de l’interface"] button:text-is("Grande")').click();
  await sleep(400);
  const w1 = await win.evaluate(() => window.innerWidth);
  t.check('interface size "Grande" zooms the whole window', Math.abs(w0 / w1 - 1.1) < 0.02, `${w0} → ${w1} CSS px`);
  await win.locator('.segmented[aria-label="Taille de l’interface"] button:text-is("Normale")').click();
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'eq-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
