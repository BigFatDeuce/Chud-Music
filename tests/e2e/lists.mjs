// Offline checks of the lists batch (after 0.5.0): two albums of the same name in two folders are
// never interleaved (the next track stays in its album), search inside a playlist, artist and
// album names of local files open the Library on them, Home › Random can be drawn again, the list
// follows the playing track, small albums hidden from Library › Albums (setting), picture effects
// in the clip tab, a second click on the clip / visualizer buttons closes their tab, and the mini
// player hides those two buttons.
import { copyFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, root, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('lists');
const profile = tempDir('chud-lists-');
const lib2 = tempDir('chud-lists-music-');
let app, win;
const rows = () => win.locator('.page .tl-body .tl-row');
const titles = () => win.locator('.page .tl-body .tl-row .t-title').allInnerTexts();
const activeTab = () => win.locator('.tab.active .tab-label').innerText();

// two copies of one album "Reanimation" (Linkin Park), in two folders, 2 tracks each (tags
// rewritten on copies of the fixtures: the fixtures themselves are never touched)
const ffmpeg = process.platform === 'win32' ? join(root, 'build/vendor/ffmpeg/ffmpeg.exe') : join(root, 'build/vendor/ffmpeg-linux/ffmpeg');
const src = join(music, '01 - Minuit Chrome.mp3');
for (const [dir, ed] of [['Reanimation', 'A'], ['Reanimation (2024)', 'B']]) {
  mkdirSync(join(lib2, dir), { recursive: true });
  for (const n of [1, 2]) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', src, '-map', '0:a', '-c:a', 'flac', '-metadata', `title=Track ${n}${ed}`, '-metadata', 'artist=Linkin Park', '-metadata', 'album_artist=Linkin Park', '-metadata', 'album=Reanimation', '-metadata', `track=${n}`, join(lib2, dir, `0${n}.flac`)]);
  }
}
// a disc folder counts as its album's folder
mkdirSync(join(lib2, 'Double', 'CD1'), { recursive: true });
mkdirSync(join(lib2, 'Double', 'CD2'), { recursive: true });
for (const [d, n] of [['CD1', 1], ['CD2', 2]]) execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', src, '-map', '0:a', '-c:a', 'flac', '-metadata', `title=Disc ${n}`, '-metadata', 'artist=Duo', '-metadata', 'album=Double', '-metadata', `disc=${n}`, '-metadata', 'track=1', join(lib2, 'Double', d, '01.flac')]);

try {
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  await win.evaluate((p) => window.chud.library.addFolder(p), lib2);
  await waitScanIdle(win);
  await gotoNav(win, 'Bibliothèque');
  await sleep(500);

  // ── same-name albums
  await win.locator('.search input').fill('reanimation');
  await sleep(400);
  const order = await titles();
  t.check('two "Reanimation" albums: never interleaved in the list', order.join() === 'Track 1A,Track 2A,Track 1B,Track 2B' || order.join() === 'Track 1B,Track 2B,Track 1A,Track 2A', order.join(', '));
  await win.locator('.page .tl-body .tl-row:has-text("Track 1A") .t-title').dblclick();
  await sleep(900);
  await win.locator('.transport-buttons button[aria-label="Suivant"]').click();
  await sleep(900);
  t.check('…the next track stays in the same album', (await win.locator('.np-title').innerText()) === 'Track 2A', await win.locator('.np-title').innerText());
  await win.locator('.search input').fill('');

  // ── small albums hidden by default
  await win.locator('.segmented button:has-text("Albums")').click();
  await sleep(400);
  t.check('Albums: albums of fewer than 4 tracks hidden by default', (await win.locator('.album-card').count()) === 0 && (await win.locator('.albums-hidden').count()) === 1, await win.locator('.albums-hidden').innerText().catch(() => ''));
  await win.locator('.albums-hidden button').click();
  await sleep(400);
  const cards = await win.locator('.album-card b, .album-card .album-title').allInnerTexts().catch(() => []);
  const nCards = await win.locator('.album-card').count();
  t.check('…"Les afficher": all albums, the two Reanimation apart, the double album as one', nCards === 7, `${nCards}: ${cards.join(', ')}`);
  t.check('…the setting is off now (Settings › Library)', (await win.evaluate(() => window.chud.settings.get())).hideSmallAlbums === false);
  await win.locator('.segmented button:has-text("Titres")').click();
  await sleep(300);

  // ── clickable artist / album of local files
  await win.locator('.page .tl-body .tl-row:has-text("Verre Bleu") .tl-artist [role="link"]').click();
  await sleep(500);
  t.check('artist name of a local file → the Library on that artist', (await win.locator('.chip.drill').innerText()).includes('Aqua Glow') && (await titles()).join() === 'Verre Bleu', await win.locator('.chip.drill').innerText());
  await win.locator('.chip.drill').click();
  await sleep(300);
  await win.locator('.segmented button:has-text("Titres")').click();
  await sleep(300);

  // ── playlist: search, album link, follows the playing track
  const ids = await win.evaluate(() => window.chud.library.tracks().then((ts) => ts.filter((x) => !/Track|Disc/.test(x.title))));
  const many = Array.from({ length: 50 }, () => ids).flat();
  await win.evaluate((tracks) => window.chud.playlists.create('Grosse liste', tracks), many);
  await gotoNav(win, 'Playlists');
  await sleep(500);
  await win.locator('.playlist-card:has-text("Grosse liste")').click();
  await sleep(900);
  const total = await win.locator('.list-hero-stats').innerText().catch(() => '');
  t.check('a playlist of 300 entries is open', /300/.test(total), total);
  await win.locator('.pl-toolbar .search input').fill('cassettes');
  await sleep(500);
  const found = await win.locator('.pl-found').innerText().catch(() => '');
  t.check('playlist search: by artist, accents and case ignored', /100/.test(found) && (await titles()).every((x) => x === 'Minuit Chrome' || x === 'Boulevard des Ondes'), found);
  await win.locator('.pl-toolbar .search input').fill('zzzz');
  await sleep(400);
  t.check('…nothing found: says so', (await win.locator('.page .empty').innerText()).includes('Aucun morceau'));
  await win.locator('.pl-toolbar .search input').fill('');
  await sleep(400);
  // the list follows the playing track
  await rows().first().locator('.t-title').dblclick();
  await sleep(700);
  await win.evaluate(() => window.chud.settings.set({ shuffle: true }));
  const inView = () => win.evaluate(() => {
    const r = document.querySelector('.page .tl-body .tl-row.current');
    if (!r) return false;
    const b = r.getBoundingClientRect();
    return b.top >= 0 && b.bottom <= innerHeight;
  });
  // jump far: play the last row through the list itself (scroll to it, play, scroll back up)
  await win.evaluate(() => { const s = document.querySelector('.page'); s.scrollTop = s.scrollHeight; });
  await sleep(500);
  await rows().last().locator('.t-title').dblclick();
  await sleep(500);
  await win.evaluate(() => { const s = document.querySelector('.page'); s.scrollTop = 0; });
  await sleep(400);
  await win.locator('.transport-buttons button[aria-label="Précédent"]').click();
  await sleep(1200);
  t.check('the list scrolls to the playing track when it changes', await inView());
  await win.evaluate(() => window.chud.settings.set({ shuffle: false }));

  // ── Home › Random: drawn again
  await win.locator('.tab:has-text("Accueil")').click();
  await sleep(600);
  const pick = () => win.evaluate(() => {
    const h = [...document.querySelectorAll('.page .section-title')].find((e) => e.textContent === 'Au hasard');
    return [...h.nextElementSibling.querySelectorAll('.shelf-item b')].map((b) => b.textContent).join('|');
  });
  const p1 = await pick();
  let changed = false;
  for (let i = 0; i < 5 && !changed; i++) {
    await win.locator('.shelf-refresh').click();
    await sleep(250);
    changed = (await pick()) !== p1;
  }
  t.check('Home › Random: the refresh button draws another list', changed);

  // ── clip tab: effects on a local file, toggled
  await gotoNav(win, 'Bibliothèque');
  await win.locator('.page .tl-body .tl-row:has-text("Fractale") .t-title').dblclick();
  await sleep(800);
  await win.locator('.transport-buttons .bar-tab-btn').first().click();
  await sleep(700);
  t.check('clip tab: 5 effect buttons under the picture', (await win.locator('.clip-fx .clip-fx-btn').count()) === 5);
  const under = await win.evaluate(() => document.querySelector('.clip-fx').getBoundingClientRect().top >= document.querySelector('.clip-stage').getBoundingClientRect().bottom - 1);
  t.check('…placed under the stage', under);
  await win.locator('.clip-fx-btn[data-fx="vhs"]').click();
  await win.locator('.clip-fx-btn[data-fx="glitch"]').click();
  await sleep(300);
  const fx = await win.evaluate(() => {
    const s = document.querySelector('.clip-stage');
    return { cls: s.className, on: document.querySelectorAll('.clip-fx-btn.on').length, over: !!s.querySelector('.clip-fx-over') };
  });
  t.check('…one effect at a time: Glitch replaces VHS', fx.cls.includes('fx-glitch') && !fx.cls.includes('fx-vhs') && fx.on === 1 && fx.over, JSON.stringify(fx));
  await win.screenshot({ path: join(shots, 'clip-fx.png') });
  await win.locator('.clip-fx-btn[data-fx="glitch"]').click();
  await sleep(200);
  t.check('…a second click turns it off', !(await win.locator('.clip-stage').getAttribute('class')).includes('fx-glitch') && (await win.locator('.clip-fx-btn.on').count()) === 0);
  await win.locator('.clip-fx-btn[data-fx="vhs"]').click();

  // ── second click on the bar buttons closes their tab
  await win.locator('.transport-buttons .bar-tab-btn').first().click();
  await sleep(500);
  t.check('clip button again while its tab is shown: the tab closes', (await win.locator('.tab:has-text("Clip vidéo")').count()) === 0, await activeTab());
  await win.locator('.transport-buttons button[aria-label="Visualiseur"]').click();
  await sleep(500);
  t.check('visualizer button: opens it', (await activeTab()) === 'Visualiseur');
  await win.locator('.transport-buttons button[aria-label="Visualiseur"]').click();
  await sleep(500);
  t.check('…again: closes it', (await win.locator('.tab:has-text("Visualiseur")').count()) === 0, await activeTab());

  // the effects are remembered
  await win.locator('.transport-buttons .bar-tab-btn').first().click();
  await sleep(500);
  t.check('clip effects remembered', (await win.locator('.clip-fx-btn.on').count()) === 1);

  // ── mini player: the clip and visualizer buttons step aside, the cover is shown
  await win.locator('.mini-open').click();
  await sleep(900);
  const mini = await win.evaluate(() => ({
    tabBtns: [...document.querySelectorAll('.transport-buttons .bar-tab-btn')].filter((b) => b.offsetWidth > 0).length,
    cover: document.querySelector('.living-cover')?.getBoundingClientRect().width ?? 0,
    overflow: document.querySelector('.transport-buttons').scrollWidth - document.querySelector('.transport-buttons').clientWidth,
  }));
  t.check('mini player: clip/visualizer buttons hidden, nothing overflows, cover shown', mini.tabBtns === 0 && mini.overflow <= 1 && mini.cover > 150, JSON.stringify(mini));
  await win.screenshot({ path: join(shots, 'mini-clip.png') });
  await win.locator('.mini-expand').click();
  await sleep(500);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'lists-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib2);
  process.exit(t.finish() ? 1 : 0);
}
