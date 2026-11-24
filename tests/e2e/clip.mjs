// Offline checks of 0.4.0: the "Synced Lyrics" / "Lyrics" button of the player bar (LRCLIB is
// stubbed in the main process), the visualizer button after "repeat", the menu on the playing
// cover, the video clip tab with a local file (cover, tape placeholder, lyrics beside / under),
// Home's "Au hasard" shelf, the badges in a 9:16 window, wider scrollbars, and the Signal skin
// (no scanlines over the window, glitchy buttons, the periodic glitch on the playing cover).
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('clip');
const profile = tempDir('chud-clip-');
let app, win;

const LRC = '[00:00.00] Première ligne\n[00:02.00] Deuxième ligne\n[00:04.00] Troisième ligne\n[00:30.00] Fin';

/** LRCLIB answers, without the network: synced for one title, plain for another, nothing else. */
async function stubLyrics() {
  await app.evaluate(({ ipcMain }, lrc) => {
    ipcMain.removeHandler('lyrics:get');
    ipcMain.handle('lyrics:get', (_e, q) => {
      const base = { matched: null, query: q, source: 'LRCLIB' };
      if (q.title === 'Minuit Chrome') return { ...base, status: 'synced', synced: lrc, plain: 'Première ligne' };
      if (q.title === 'Boulevard des Ondes') return { ...base, status: 'plain', synced: null, plain: 'Des paroles\nsans minutage' };
      return { ...base, status: 'not-found', synced: null, plain: null };
    });
  }, LRC);
}
const playRow = async (title) => {
  await win.locator(`.page .tl-body .tl-row:has-text("${title}") .t-title`).first().dblclick();
  await sleep(900);
};
const activeTab = () => win.locator('.tab.active .tab-label').innerText();

try {
  ({ app, win } = await launch(profile));
  await stubLyrics();
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  await gotoNav(win, 'Bibliothèque');
  await sleep(500);

  // ── the lyrics button, beside the badges (local files only)
  await playRow('Minuit Chrome');
  const btn = win.locator('.np-badges .np-lyrics-btn');
  await btn.waitFor({ timeout: 5000 }).catch(() => {});
  t.check('synced lyrics: a "Paroles synchronisées" button after the badges', (await btn.count()) === 1 && (await btn.innerText()).trim() === 'Paroles synchronisées' && (await btn.getAttribute('class')).includes('synced'));
  const order = await win.evaluate(() => [...document.querySelector('.np-badges').children].map((e) => e.className));
  t.check('…placed to the right of "Local" and the quality badge', order[order.length - 1].includes('np-lyrics-btn') && order.length >= 3, order.join(' | '));
  t.check('…it is animated', (await btn.evaluate((e) => getComputedStyle(e).animationName)) !== 'none');
  await btn.click();
  await sleep(500);
  t.check('…a click opens the Lyrics page', (await activeTab()) === 'Paroles');
  await gotoNav(win, 'Bibliothèque');
  await playRow('Boulevard des Ondes');
  await sleep(300);
  t.check('plain lyrics: a "Paroles" button', (await btn.count()) === 1 && (await btn.innerText()).trim() === 'Paroles');
  await playRow('Sans Tags');
  await sleep(300);
  t.check('no lyrics: no button', (await btn.count()) === 0);

  // ── visualizer button, right after repeat
  const transport = await win.evaluate(() => [...document.querySelectorAll('.transport-buttons > button')].map((b) => b.getAttribute('aria-label')));
  t.check('a visualizer button right after "repeat"', transport[transport.length - 1] === 'Visualiseur' && /Répét/i.test(transport[transport.length - 2] ?? ''), transport.join(', '));
  await win.locator('.transport-buttons button[aria-label="Visualiseur"]').click();
  await sleep(600);
  t.check('…it opens the visualizer', (await activeTab()) === 'Visualiseur');

  // ── right-click on the playing cover (player bar)
  await gotoNav(win, 'Bibliothèque');
  await playRow('Minuit Chrome');
  await win.locator('.np-cover').click({ button: 'right' });
  await sleep(300);
  const coverMenu = await win.locator('.menu-item').allInnerTexts();
  t.check('cover menu: clip, artist on YouTube Music, folder', ['Ouvrir le clip vidéo', 'Trouver l’artiste sur YouTube Music', 'Afficher dans l’Explorateur'].every((l) => coverMenu.some((m) => m.includes(l))), coverMenu.join(' / '));
  await win.keyboard.press('Escape');
  await sleep(200);

  // ── track menu: "Ouvrir le clip vidéo" → the clip tab
  await win.locator('.page .tl-body .tl-row:has-text("Minuit Chrome")').first().click({ button: 'right' });
  await sleep(300);
  t.check('track menu: "Ouvrir le clip vidéo"', (await win.locator('.menu-item:has-text("Ouvrir le clip vidéo")').count()) === 1);
  await win.locator('.menu-item:has-text("Ouvrir le clip vidéo")').click();
  await sleep(900);
  t.check('…the clip tab opens', (await activeTab()) === 'Clip vidéo' && (await win.locator('.clip-page').count()) === 1);
  t.check('a local file with a cover: its cover, big', (await win.locator('.clip-stage .clip-art-img').count()) === 1);
  t.check('synced lyrics beside it', (await win.locator('.clip-lyrics .clip-line').count()) === 4);
  const side = await win.evaluate(() => {
    const s = document.querySelector('.clip-stage').getBoundingClientRect();
    const l = document.querySelector('.clip-lyrics').getBoundingClientRect();
    return { right: l.left >= s.right - 1, ratio: s.width / s.height };
  });
  t.check('…on the right of a 16:9 stage', side.right && Math.abs(side.ratio - 16 / 9) < 0.05, JSON.stringify(side));
  await sleep(2600);
  t.check('…the current line follows the music', (await win.locator('.clip-line.on').count()) === 1);
  await win.screenshot({ path: join(shots, 'clip-beside.png') });
  await win.locator('.clip-actions button:has-text("Large")').click();
  await sleep(400);
  const wide = await win.evaluate(() => {
    const s = document.querySelector('.clip-stage').getBoundingClientRect();
    const l = document.querySelector('.clip-lyrics').getBoundingClientRect();
    return { below: l.top >= s.bottom - 1, wider: s.width };
  });
  t.check('"Large": the lyrics go under the video', (await win.locator('.clip-page.wide').count()) === 1 && wide.below, JSON.stringify(wide));
  await win.screenshot({ path: join(shots, 'clip-wide.png') });

  // the next track stays in the clip tab, in the same layout; a file without cover nor artist →
  // the tape placeholder, cropped, playing while the music plays
  await win.locator('.transport-buttons button[aria-label="Suivant"]').click();
  await sleep(1200);
  const title = await win.locator('.np-title').innerText();
  t.check('next track: the clip tab stays, still "Large"', (await activeTab()) === 'Clip vidéo' && (await win.locator('.clip-page.wide').count()) === 1, title);
  // walk to the file without tags
  for (let i = 0; i < 6 && (await win.locator('.np-title').innerText()) !== 'Sans Tags'; i++) {
    await win.locator('.transport-buttons button[aria-label="Suivant"]').click();
    await sleep(900);
  }
  const tape = await win.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const v = document.querySelector('.clip-vhs video');
    return v && { playing: !v.paused, loop: v.loop, muted: v.muted, transform: getComputedStyle(v).transform, w: v.videoWidth, h: v.videoHeight };
  });
  t.check('no cover nor artist: the tape video, looping, muted, playing', !!tape && tape.playing && tape.loop && tape.muted && tape.w === 1280, JSON.stringify(tape));
  const sc = tape && /matrix\(([\d.]+)/.exec(tape.transform);
  t.check('…scaled so the black bars leave the frame', !!sc && Math.abs(Number(sc[1]) - 1.345) < 0.01, tape?.transform);
  await win.screenshot({ path: join(shots, 'clip-tape.png') });
  await win.locator('.play-btn').click();
  await sleep(500);
  t.check('…and pauses with the music', await win.evaluate(() => document.querySelector('.clip-vhs video')?.paused === true));
  await win.locator('.play-btn').click();
  await win.locator('.clip-actions button:has-text("À côté")').click();
  await sleep(300);

  // ── Home: "Au hasard" between recently played and recently added
  await win.locator('.tab:has-text("Accueil")').click();
  await sleep(600);
  const titles = await win.locator('.page .section-title').allInnerTexts();
  const ri = titles.indexOf('Au hasard');
  // (a play of a few seconds is not history: "Écoutés récemment" may be absent here)
  t.check('Home: "Au hasard" between "Écoutés récemment" and "Ajoutés récemment"', ri >= 0 && titles[ri + 1] === 'Ajoutés récemment' && (ri === 0 || titles[ri - 1] === 'Écoutés récemment'), titles.join(', '));
  const pick = async () => win.evaluate(() => {
    const h = [...document.querySelectorAll('.page .section-title')].find((e) => e.textContent === 'Au hasard');
    return [...h.nextElementSibling.querySelectorAll('.shelf-item b')].map((b) => b.textContent);
  });
  const p1 = await pick();
  t.check('…library tracks', p1.length === 6, p1.join(', '));
  await gotoNav(win, 'Bibliothèque');
  await win.locator('.tab:has-text("Accueil")').click();
  await sleep(600);
  t.check('…the same picks for the whole session', (await pick()).join() === p1.join());

  // ── scrollbars 1.5× wider
  const sb = await win.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;width:100px;height:100px;overflow:scroll';
    document.body.appendChild(d);
    const w = d.offsetWidth - d.clientWidth;
    d.remove();
    return w;
  });
  t.check('scrollbars are 15 px wide', sb === 15, `${sb} px`);

  // ── 9:16: badges and lyrics button under the title
  await gotoNav(win, 'Bibliothèque');
  await playRow('Minuit Chrome');
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(608, 1080); });
  await sleep(900);
  const compact = await win.evaluate(() => {
    const b = document.querySelector('.np-badges');
    const title = document.querySelector('.np-title').getBoundingClientRect();
    const r = b?.getBoundingClientRect();
    const l = document.querySelector('.np-lyrics-btn')?.getBoundingClientRect();
    return { compact: document.querySelector('.app').classList.contains('compact'), shown: !!r && r.height > 0 && getComputedStyle(b).display !== 'none', under: !!r && r.top >= title.bottom - 1, lyrics: !!l && l.width > 0 && l.right <= window.innerWidth };
  });
  t.check('9:16: the badges and the lyrics button show under the title', compact.compact && compact.shown && compact.under && compact.lyrics, JSON.stringify(compact));
  await win.screenshot({ path: join(shots, 'compact-badges.png') });

  // ── Signal skin
  await win.evaluate(() => window.chud.settings.set({ skin: 'signal', effects: 'full' }));
  await app.close();
  ({ app, win } = await launch(profile));
  await stubLyrics();
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1400, 900); });
  await gotoNav(win, 'Bibliothèque');
  await sleep(400);
  await playRow('Minuit Chrome');
  t.check('Signal: no scanlines over the window', await win.evaluate(() => { const g = document.querySelector('.grain'); return !g || getComputedStyle(g).display === 'none'; }));
  const fx = await win.evaluate(() => ({
    play: getComputedStyle(document.querySelector('.play-btn')).animationName,
    corners: getComputedStyle(document.querySelector('.play-btn'), '::before').content,
    cover: getComputedStyle(document.querySelector('.np-cover[data-playing] > *')).animationName,
    living: document.querySelector('.living-cover[data-playing] .living-cover-art') ? getComputedStyle(document.querySelector('.living-cover-art')).animationName : 'absent',
    radius: getComputedStyle(document.querySelector('.play-btn')).borderRadius,
    vol: getComputedStyle(document.querySelector('.volume .slider-fill')).backgroundImage,
  }));
  t.check('Signal: the play button is square with corners, and breathes while playing', fx.play === 'signal-play-breathe' && fx.radius === '4px' && fx.corners !== 'none', JSON.stringify(fx));
  t.check('Signal: the volume is a segmented meter', fx.vol.startsWith('repeating-linear-gradient'));
  t.check('Signal: the playing covers glitch now and then', fx.cover === 'signal-cover-glitch' && (fx.living === 'signal-cover-glitch' || fx.living === 'absent'), `${fx.cover} / ${fx.living}`);
  await win.locator('.transport-buttons button[aria-label="Suivant"]').hover();
  await sleep(80);
  const hov = await win.evaluate(() => {
    const b = document.querySelector('.transport-buttons button[aria-label="Suivant"]');
    return [getComputedStyle(b).filter, getComputedStyle(b.querySelector('svg')).animationName];
  });
  t.check('Signal: hovering a button splits it red/cyan and makes it lose sync', hov[0].includes('drop-shadow') && hov[1] === 'signal-btn-sync', hov.join(' / '));
  // a frame in the middle of the cover glitch, for the eye
  await win.evaluate(() => { for (const a of document.getAnimations()) if (a.animationName === 'signal-cover-glitch') { a.pause(); a.currentTime = 11000 * 0.958; } });
  const bar = await win.locator('.playerbar').boundingBox();
  await win.screenshot({ path: join(shots, 'signal-playerbar.png'), clip: bar, timeout: 10000 }).catch(() => {});
  await win.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
  await win.evaluate(() => window.chud.settings.set({ effects: 'off' }));
  await app.close();
  ({ app, win } = await launch(profile));
  await stubLyrics();
  await gotoNav(win, 'Bibliothèque');
  await sleep(400);
  await playRow('Minuit Chrome');
  t.check('Signal, effects off: nothing moves', await win.evaluate(() => getComputedStyle(document.querySelector('.play-btn')).animationName === 'none' && getComputedStyle(document.querySelector('.np-cover > *')).animationName === 'none'));
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'clip-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
