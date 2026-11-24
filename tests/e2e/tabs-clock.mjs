// Offline checks of 0.3.0: tabs dragged left/right (Home and Library stay first, the order is
// kept after a restart, Ctrl+Shift+PgUp/PgDn), the Signal skin's glitch clock (ticks, still when
// effects are off), "Trouver l'artiste sur YouTube Music" on a local file, and the setting
// "Artistes et albums cliquables" (on by default).
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tabLabels, tempDir } from './harness.mjs';

const t = createSuite('tabs-clock');
const profile = tempDir('chud-tabs-');
let app, win;

/** Drags a tab by the mouse to the horizontal centre of another one. */
async function dragTab(from, to) {
  const a = await win.locator(`.tab:has-text("${from}")`).boundingBox();
  const b = await win.locator(`.tab:has-text("${to}")`).boundingBox();
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await win.mouse.down();
  const steps = 14;
  const dx = b.x + b.width / 2 + (b.x > a.x ? 12 : -12) - (a.x + a.width / 2);
  for (let i = 1; i <= steps; i++) {
    await win.mouse.move(a.x + a.width / 2 + (dx * i) / steps, a.y + a.height / 2);
    await sleep(25);
  }
  await win.mouse.up();
  await sleep(500);
}

try {
  ({ app, win } = await launch(profile, [join(music, '01 - Minuit Chrome.mp3')]));
  await sleep(800);
  for (const s of ['Playlists', 'Radio', 'Statistiques']) await gotoNav(win, s);
  const before = await tabLabels(win);
  t.check('tabs open in order', before.join(',').startsWith('Accueil,Bibliothèque') && before.slice(-3).join(',') === 'Playlists,Radio,Statistiques', before.join(', '));

  await dragTab('Playlists', 'Statistiques');
  let order = await tabLabels(win);
  t.check('drag a tab to the right', order.slice(-3).join(',') === 'Radio,Statistiques,Playlists', order.join(', '));
  t.check('the dragged tab becomes the active one', (await win.locator('.tab.active .tab-label').innerText()) === 'Playlists');

  await dragTab('Playlists', 'Accueil');
  order = await tabLabels(win);
  t.check('dragged to the far left, it stops after Home and Library', order[0] === 'Accueil' && order[1] === 'Bibliothèque' && order[2] === 'Playlists', order.join(', '));

  await dragTab('Bibliothèque', 'Statistiques');
  order = await tabLabels(win);
  t.check('Home and Library cannot be dragged', order[0] === 'Accueil' && order[1] === 'Bibliothèque', order.join(', '));
  await dragTab('Accueil', 'Radio');
  order = await tabLabels(win);
  t.check('…Home neither', order[0] === 'Accueil' && order[1] === 'Bibliothèque', order.join(', '));

  // a click is still a click
  await win.locator('.tab:has-text("Radio")').click();
  await sleep(300);
  t.check('a plain click still switches tab', (await win.locator('.tab.active .tab-label').innerText()) === 'Radio');

  await win.locator('.tab:has-text("Radio")').focus();
  await win.keyboard.press('Control+Shift+PageDown');
  await sleep(300);
  const kb = await tabLabels(win);
  const ri = kb.indexOf('Radio');
  t.check('Ctrl+Shift+PgDn moves the active tab right', kb[ri - 1] === 'Statistiques' || ri === kb.length - 1, kb.join(', '));
  await win.keyboard.press('Control+Shift+PageUp');
  await win.keyboard.press('Control+Shift+PageUp');
  await win.keyboard.press('Control+Shift+PageUp');
  await win.keyboard.press('Control+Shift+PageUp');
  await sleep(300);
  const kb2 = await tabLabels(win);
  t.check('Ctrl+Shift+PgUp never goes past Library', kb2[2] === 'Radio' && kb2[0] === 'Accueil', kb2.join(', '));
  await win.screenshot({ path: join(shots, 'tabs-reordered.png') });

  // the order survives a restart
  const saved = await tabLabels(win);
  await sleep(700);
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(800);
  const restored = await tabLabels(win);
  t.check('the order is kept after a restart', restored.join(',') === saved.join(','), restored.join(', '));

  // ── local file: find its artist on YouTube Music (menu entry only: the lookup is online)
  await win.locator('.tab:has-text("Fichiers ouverts")').click();
  await sleep(400);
  await win.locator('.tl-body .tl-row').first().click({ button: 'right' });
  await sleep(300);
  const menu = (await win.locator('.menu-item').allInnerTexts()).join(' / ');
  t.check('local track menu: "Trouver l’artiste sur YouTube Music"', (await win.locator('.menu-item:has-text("Trouver l’artiste sur YouTube Music")').count()) === 1, menu);
  await win.keyboard.press('Escape');

  // ── setting: clickable artists/albums, on by default
  const s = await win.evaluate(() => window.chud.settings.get());
  t.check('"Artistes et albums cliquables" is on by default', s.ytLinks === true);
  await gotoNav(win, 'Paramètres');
  t.check('the setting is in Settings › YouTube Music', (await win.locator('.setting-row:has-text("Artistes et albums cliquables")').count()) === 1);

  // ── Signal skin: the glitch clock
  await win.evaluate(() => window.chud.settings.set({ skin: 'signal', effects: 'full' }));
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(600);
  // wide enough for the clock (it steps aside when the banner is narrow, in every skin)
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1400, 900); });
  await win.locator('.tab:has-text("Accueil")').click();
  await sleep(900);
  t.check('Signal: the Home clock is the timecode one', (await win.locator('.signal-clock.live .sc-time').count()) === 1);
  const sec1 = await win.locator('.sc-sec').innerText();
  await sleep(1600);
  const sec2 = await win.locator('.sc-sec').innerText();
  t.check('its seconds tick', sec1 !== sec2, `${sec1} → ${sec2}`);
  const anim = await win.evaluate(() => {
    const el = document.querySelector('.sc-time');
    return [getComputedStyle(el).animationName, getComputedStyle(el, '::before').animationName, getComputedStyle(document.querySelector('.sc-roll')).animationName];
  });
  t.check('glitch, RGB ghost and roll bar animations run', anim.every((a) => a && a !== 'none'), anim.join(', '));
  const date = await win.locator('.sc-date-typed').innerText();
  const full = await win.locator('.sc-date-full').textContent();
  t.check('the date has typed itself in', date.replace('▌', '') === full, date);
  // screenshots for the eye only (an element screenshot can time out under WSLg: clip the window)
  const shot = async (sel, file) => {
    const b = await win.locator(sel).boundingBox();
    if (b) await win.screenshot({ path: join(shots, file), clip: b, timeout: 10000 }).catch(() => {});
  };
  await shot('.home-hero', 'signal-clock.png');
  // a frame in the middle of a glitch burst (animations paused there), for the eye
  await win.evaluate(() => { for (const a of document.getAnimations()) if (/^sc-(shake|ghost)/.test(a.animationName)) { a.pause(); a.currentTime = 7000 * 0.905; } });
  await shot('.signal-clock', 'signal-clock-glitch.png');
  await win.evaluate(() => { for (const a of document.getAnimations()) if (/^sc-/.test(a.animationName)) a.play(); });
  // the box stays inside the hero, clear of the title
  const box = await win.locator('.signal-clock').boundingBox();
  const hero = await win.locator('.home-hero').boundingBox();
  t.check('the clock sits inside the hero', box.x + box.width <= hero.x + hero.width && box.y >= hero.y, `${Math.round(box.width)}×${Math.round(box.height)}`);
  await win.evaluate(() => window.chud.settings.set({ effects: 'off' }));
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(600);
  await win.locator('.tab:has-text("Accueil")').click();
  await sleep(700);
  t.check('effects off: a still clock (no animation class)', (await win.locator('.signal-clock').count()) === 1 && (await win.locator('.signal-clock.live').count()) === 0);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'tabs-clock-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
