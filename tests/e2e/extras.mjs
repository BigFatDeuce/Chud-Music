// Offline checks of 0.5.0: the video clip button left of "shuffle", the playback speed chip above
// the timer (menu, 1.5× really plays faster, right-click back to 1×, kept after a restart),
// "Start mix (Online)" first of the local part of a track's menu, the ad blocker last in its
// Settings box with its statistics under it, and the Signal skin on the page buttons (Library).
import { join } from 'node:path';
import { cleanup, createSuite, elapsed, gotoNav, launch, music, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('extras');
const profile = tempDir('chud-extras-');
let app, win;
const playRow = async (title) => {
  await win.locator(`.page .tl-body .tl-row:has-text("${title}") .t-title`).first().dblclick();
  await sleep(900);
};

try {
  ({ app, win } = await launch(profile));
  // the fixtures' albums are small (hidden by default): show them; the interface reads the settings at start
  await win.evaluate(() => window.chud.settings.set({ hideSmallAlbums: false }));
  await win.reload();
  await win.waitForSelector('.nav-item');
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  await gotoNav(win, 'Bibliothèque');
  await sleep(400);

  // ── clip button, left of shuffle
  const labels = await win.evaluate(() => [...document.querySelectorAll('.transport-buttons > button')].map((b) => b.getAttribute('aria-label')));
  t.check('a video clip button left of "shuffle"', labels[0] === 'Ouvrir le clip vidéo' && labels[1] === 'Lecture aléatoire', labels.join(', '));
  t.check('…disabled while nothing plays', await win.locator('.transport-buttons > button').first().isDisabled());
  await playRow('Fractale');
  await win.locator('.transport-buttons > button').first().click();
  await sleep(700);
  t.check('…a click opens the clip tab (local file)', (await win.locator('.tab.active .tab-label').innerText()) === 'Clip vidéo' && (await win.locator('.clip-page').count()) === 1);

  // ── playback speed
  const chip = win.locator('.speed-btn');
  const place = await win.evaluate(() => {
    const c = document.querySelector('.speed-btn').getBoundingClientRect();
    const tm = document.querySelector('.seek-row .time.right').getBoundingClientRect();
    return { above: c.bottom <= tm.top + 1, right: Math.abs(c.right - tm.right) < 2 };
  });
  t.check('a speed chip right above the remaining time', place.above && place.right, JSON.stringify(place));
  t.check('…showing 1×', (await chip.innerText()).trim() === '1×');
  await chip.click();
  await sleep(250);
  const speeds = await win.locator('.menu-item').allInnerTexts();
  t.check('…a click lists the speeds', speeds.length === 8 && speeds.some((s) => s.includes('1,5×')) && speeds.some((s) => s.includes('normale')), speeds.join(' / '));
  await win.locator('.menu-item:has-text("1,5×")').click();
  await sleep(300);
  t.check('…1,5× chosen: the chip is highlighted', (await chip.innerText()).trim() === '1,5×' && (await chip.getAttribute('class')).includes('on'));
  await win.locator('.seek-row').hover();
  const a = await elapsed(win);
  await sleep(4000);
  const b = await elapsed(win);
  t.check('…the music really plays faster (≈ 6 s in 4 s)', b - a >= 5 && b - a <= 7, `${a}s → ${b}s`);
  await chip.click({ button: 'right' });
  await sleep(300);
  t.check('…right-click: back to 1×', (await chip.innerText()).trim() === '1×');
  await chip.click();
  await win.locator('.menu-item:has-text("0,75×")').click();
  await sleep(300);

  // ── local track menu: "Start mix (Online)" first of the local part
  await gotoNav(win, 'Bibliothèque');
  await win.locator('.page .tl-body .tl-row:has-text("Minuit Chrome")').first().click({ button: 'right' });
  await sleep(300);
  const items = await win.locator('.menu-item').allInnerTexts();
  const mi = items.findIndex((m) => m.includes('Démarrer le mix (en ligne)'));
  t.check('local track menu: "Start mix (Online)", then the clip, the artist, the folder', mi > 0 && items[mi + 1]?.includes('Ouvrir le clip vidéo') && items[mi + 2]?.includes('Trouver l’artiste'), items.join(' / '));
  const sep = await win.evaluate(() => {
    const el = [...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('Démarrer le mix (en ligne)'));
    return el?.previousElementSibling && !el.previousElementSibling.classList.contains('menu-item');
  });
  t.check('…right after a separator (first of its part)', sep);
  await win.keyboard.press('Escape');

  // ── Settings: the ad blocker last in its box, statistics under it
  await gotoNav(win, 'Paramètres');
  const box = await win.evaluate(() => {
    const g = [...document.querySelectorAll('.settings-group')].find((e) => e.querySelector('h3')?.textContent === 'YouTube Music');
    const rows = [...g.querySelectorAll('.setting-row')];
    const last = rows[rows.length - 1];
    return { last: last.textContent.includes('Bloqueur de publicités'), sw: !!last.querySelector('.segmented button'), after: last.nextElementSibling ? last.nextElementSibling.tagName : 'none' };
  });
  t.check('Settings › YouTube Music: the ad blocker is the last row, with its On/Off switch', box.last && box.sw, JSON.stringify(box));
  t.check('…its statistics (when active) come right under it', box.after === 'none' || box.after === 'DL', box.after);

  // the speed is remembered
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(500);
  t.check('the speed is kept after a restart', (await win.locator('.speed-btn').innerText()).trim() === '0,75×');
  await win.locator('.speed-btn').click({ button: 'right' }).catch(() => {});

  // ── Signal: page buttons too
  await win.evaluate(() => window.chud.settings.set({ skin: 'signal', effects: 'full' }));
  await app.close();
  ({ app, win } = await launch(profile));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(1400, 900); });
  await gotoNav(win, 'Bibliothèque');
  await sleep(500);
  const lib = await win.evaluate(() => {
    const fab = document.querySelector('.lib-actions .play-fab');
    return { radius: getComputedStyle(fab).borderRadius, corners: getComputedStyle(fab, '::before').content, bg: getComputedStyle(fab).backgroundColor };
  });
  t.check('Signal: the Library play button is the square glitch one', lib.radius === '4px' && lib.corners !== 'none' && lib.bg === 'rgb(11, 11, 14)', JSON.stringify(lib));
  const shuffle = win.locator('.lib-actions .icon-btn').first();
  await shuffle.hover();
  await sleep(80);
  const hov = await shuffle.evaluate((b) => [getComputedStyle(b).filter, getComputedStyle(b.querySelector('svg')).animationName]);
  t.check('Signal: the Library shuffle button splits and loses sync on hover', hov[0].includes('drop-shadow') && hov[1] === 'signal-btn-sync', hov.join(' / '));
  await win.screenshot({ path: join(shots, 'signal-library-buttons.png'), clip: (await win.locator('.lib-actions').boundingBox()) ?? undefined, timeout: 10000 }).catch(() => {});
  await win.locator('.segmented button:has-text("Albums")').click();
  await sleep(400);
  await win.locator('.album-card').first().hover();
  await sleep(400);
  const ap = await win.evaluate(() => { const e = document.querySelector('.album-card .album-play'); const s = getComputedStyle(e); return { pos: s.position, radius: s.borderRadius, op: s.opacity }; });
  t.check('Signal: album play buttons too, still laid over the cover', ap.pos === 'absolute' && ap.radius === '4px' && Number(ap.op) > 0.9, JSON.stringify(ap));
  await win.screenshot({ path: join(shots, 'signal-albums.png') });
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'extras-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
