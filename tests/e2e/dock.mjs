// YouTube player placement (needs Internet): in the sidebar when it fits, docked in the player
// bar otherwise (playlists shown, narrow window, short window at a large interface size);
// sidebar menu never scrolls at the normal size; Signal title keeps its width; long country
// names in Radio stay on one line.
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir, showPlaylists } from './harness.mjs';

const t = createSuite('dock');
const profile = tempDir('chud-dock-');
let app, win;
const waitFor = async (fn, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
};
const resize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
  const b = BrowserWindow.getAllWindows()[0];
  b.unmaximize();
  b.setContentSize(w, h);
}, [w, h]);
/** Where the YouTube player is, its size, and whether it sits exactly on the bar slot. */
const place = () => win.evaluate(() => {
  const p = document.querySelector('.yt-player.visible')?.getBoundingClientRect();
  const slot = document.querySelector('.np-yt-slot')?.getBoundingClientRect();
  const bar = document.querySelector('.playerbar')?.getBoundingClientRect();
  const side = document.querySelector('.sidebar')?.getBoundingClientRect();
  if (!p) return null;
  const inBar = !!bar && p.top >= bar.top - 1 && p.bottom <= bar.bottom + 1;
  const onSlot = !!slot && Math.abs(p.left - slot.left) < 2 && Math.abs(p.top - slot.top) < 2;
  const inSide = !!side && p.left >= side.left - 1 && p.right <= side.right + 1 && p.bottom <= side.bottom + 1;
  return { w: Math.round(p.width), h: Math.round(p.height), inBar, onSlot, inSide, inWindow: p.left >= 0 && p.top >= 0 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1 };
});
/** Where the controls are, from the left and from the bottom of the window. */
const controls = () => win.evaluate(() => ['.play-btn', '.seek-row', '.volume', 'button[aria-label="Suivant"]'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(innerHeight - r.bottom)]; }));
/** Links of the strip fully visible inside it (not cut off). */
const linksInside = () => win.evaluate(() => { const s = document.querySelector('.np-stage'); const p = s.getBoundingClientRect(); return [...s.querySelectorAll('.np-card-links a')].filter((l) => { const r = l.getBoundingClientRect(); return r.width > 0 && r.right <= p.right + 1 && r.bottom <= p.bottom + 1; }).length; });
/** The little spectrum: does its picture change? (YouTube: levels measured in the player's page) */
const spectrumMoves = () => win.evaluate(async () => { const cv = document.querySelector('.spectrum canvas'); if (!cv?.offsetWidth) return 'hidden'; const a = cv.toDataURL(); await new Promise((r) => setTimeout(r, 400)); return cv.toDataURL() !== a ? 'animated' : 'static'; });
const stage = () => win.evaluate(() => { const e = document.querySelector('.np-stage'); return e ? { view: e.dataset.view, text: e.innerText.trim(), h: Math.round(e.getBoundingClientRect().height), links: [...e.querySelectorAll('.np-card-links a')].map((a) => a.href) } : null; });

try {
  ({ app, win } = await launch(profile));
  await resize(1320, 840);
  await sleep(500);
  const normalControls = await controls();
  await gotoNav(win, 'YouTube Music');
  await win.locator('.yt-searchbox input').fill('Linkin Park Over Each Other');
  await win.locator('.yt-searchbox input').press('Enter');
  await win.waitForSelector('.page .tl-body .tl-row', { timeout: 20000 });
  await win.locator('.page .tl-body .tl-row').first().locator('.t-title').dblclick(); // the title: the artist name is a link
  await waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1);
  await sleep(1500);

  let p = await place();
  t.check('normal window, cover shown: YouTube player in the sidebar (≥ 200 px)', !!p && p.inSide && p.w >= 200 && p.h >= 200, JSON.stringify(p));
  const navScroll = await win.evaluate(() => { const n = document.querySelector('.nav'); return n.scrollHeight - n.clientHeight; });
  t.check('menu does not scroll at the normal size', navScroll <= 1, `${navScroll}px`);

  await showPlaylists(win);
  await sleep(800);
  p = await place();
  t.check('playlists shown: player docked in the player bar, on its slot, ≥ 200 px', !!p && p.inBar && p.onSlot && p.w >= 200, JSON.stringify(p));
  const dockedControls = await controls();
  const moved = dockedControls.map((c, i) => Math.max(Math.abs(c[0] - normalControls[i][0]), Math.abs(c[1] - normalControls[i][1])));
  t.check('docked: buttons, seek bar and volume stay exactly where they are in the normal bar', moved.every((d) => d <= 1), JSON.stringify({ normalControls, dockedControls }));
  await waitFor(async () => (await stage())?.text.length > 20, 15000);
  let st = await stage();
  t.check('docked: the strip above the controls is filled (lyrics or track card)', !!st && ['synced', 'plain', 'card'].includes(st.view) && st.text.length > 20 && st.h >= 90, st ? `${st.view}, ${st.h}px: ${st.text.slice(0, 60)}` : 'none');
  t.check('docked: with the lyrics, the track info and the 5 links fit beside them', st?.view === 'card' || (st?.links.length === 5 && (await linksInside()) === 5 && (await win.locator('.np-stage-aside .np-info:visible').count()) === 1), st?.view);
  t.check('YouTube: the spectrum of the player bar moves with the music', (await spectrumMoves()) === 'animated');
  const listH = await win.locator('.deck.playlists .side-list').evaluate((e) => Math.round(e.getBoundingClientRect().height));
  t.check('the sidebar list keeps the room (no cover under it)', listH > 150, `${listH}px`);
  await win.screenshot({ path: join(shots, 'dock-01-playlists.png') });
  await win.locator('.deck-switch button:has-text("Pochette")').click();
  await sleep(600);
  p = await place();
  t.check('back to the cover: player back in the sidebar', !!p && p.inSide, JSON.stringify(p));

  // small 16/9 window: compact bar, the strip beside the player with lyrics/card and links
  await resize(960, 540);
  await sleep(1200);
  st = await stage();
  const strip169 = await win.evaluate(() => { const s = document.querySelector('.np-stage').getBoundingClientRect(); const y = document.querySelector('.np-yt-slot').getBoundingClientRect(); return { w: Math.round(s.width), h: Math.round(s.height), beside: s.left >= y.right - 1 && s.top >= y.top - 1 }; });
  t.check('small 16/9 window: lyrics or card beside the player, with the 5 links', !!st && st.text.length > 20 && strip169.beside && strip169.h >= 100 && (await linksInside()) === 5, `${st?.view} ${JSON.stringify(strip169)}`);
  await win.screenshot({ path: join(shots, 'dock-06-169.png') });

  // narrow window (16/9 resized, portrait…)
  await resize(760, 900);
  await sleep(900);
  p = await place();
  t.check('narrow window: player docked in the bar, fully visible', !!p && p.inBar && p.onSlot && p.inWindow && p.w >= 200, JSON.stringify(p));
  const panelsOk = await win.evaluate(() => {
    const bar = document.querySelector('.playerbar').getBoundingClientRect();
    return getComputedStyle(document.documentElement).getPropertyValue('--bar-h').trim() === `${Math.round(bar.height)}px`;
  });
  t.check('panels above the bar follow its new height', panelsOk);
  await win.screenshot({ path: join(shots, 'dock-02-narrow.png') });

  // every window size: wherever the player is (sidebar or bar), never under YouTube's 200 × 200
  const small = [];
  for (const [w, h] of [[980, 700], [1040, 760], [1100, 640], [1160, 820], [1240, 700], [1320, 900], [1440, 760], [1600, 1000]]) {
    await resize(w, h);
    await sleep(700);
    const q = await place();
    if (!q || q.w < 200 || q.h < 200 || !q.inWindow) small.push(`${w}×${h}: ${q ? `${q.w}×${q.h}` : 'hidden'}`);
  }
  t.check('any window size: player ≥ 200 × 200 and fully visible', small.length === 0, small.join(', '));

  // large interface size, normal window: the menu stays whole; the player docks if needed
  await resize(1320, 840);
  await win.evaluate(() => window.chud.setZoom(1.25));
  await sleep(1000);
  const big = await win.evaluate(() => { const n = document.querySelector('.nav'); return n.scrollHeight - n.clientHeight; });
  p = await place();
  t.check('"Très grande" size: menu without scrollbar, YouTube player still ≥ 200 px and visible', big <= 1 && !!p && p.w >= 200 && p.inWindow, `menu overflow ${big}px, player ${JSON.stringify(p)}`);
  await win.screenshot({ path: join(shots, 'dock-03-zoom125.png') });
  await win.evaluate(() => window.chud.setZoom(1));
  await sleep(500);

  // no lyrics (an instrumental): the track card, with where to learn more about the artist
  await showPlaylists(win);
  await gotoNav(win, 'YouTube Music');
  await win.locator('.yt-searchbox input').fill('Ludovico Einaudi Experience');
  await win.locator('.yt-searchbox input').press('Enter');
  await win.waitForFunction(() => document.querySelector('.page .tl-body .tl-row')?.textContent.includes('Einaudi'), null, { timeout: 20000 });
  await win.locator('.page .tl-body .tl-row').first().locator('.t-title').dblclick(); // the title: the artist name is a link
  await waitFor(async () => { const s = await stage(); return s?.view === 'card' && s.links.length > 0 && !/Recherche des paroles/i.test(s.text); }, 30000);
  st = await stage();
  const hosts = (st?.links ?? []).map((h) => new URL(h).host);
  t.check('no lyrics: track card with the reason, the artist and links (YouTube Music, Wikipédia, Grokipedia, Last.fm, Discogs)',
    !!st && st.view === 'card' && /instrumental|indisponibles/i.test(st.text) && st.text.includes('Einaudi') &&
      ['music.youtube.com', 'fr.wikipedia.org', 'grokipedia.com', 'www.last.fm', 'www.discogs.com'].every((h) => hosts.includes(h)) && st.links.every((h) => h.startsWith('https://')),
    st ? `${st.text.slice(0, 80)} | ${hosts.join(', ')}` : 'none');
  await win.screenshot({ path: join(shots, 'dock-05-card.png') });

  // Signal skin, effects on: the title keeps its width
  await win.evaluate(() => window.chud.settings.set({ skin: 'signal', effects: 'full' }));
  await app.close();
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  await resize(1320, 840);
  await sleep(2500);
  const npw = await win.evaluate(() => [document.querySelector('.np-text')?.getBoundingClientRect().width ?? 0, document.querySelector('.np .fx-sized')?.getBoundingClientRect().width ?? 0]);
  t.check('Signal: title and artist keep their width in the player bar', npw[0] >= 120 && npw[1] >= 60 && (await win.locator('.np-sweep').count()) === 1, npw.map(Math.round).join(' / '));
  await win.locator('.np').screenshot({ path: join(shots, 'dock-04-signal-title.png') });

  // Signal home: the dither lens over the whole "Now playing" box, which stays usable
  await gotoNav(win, 'Accueil');
  await sleep(1200);
  const hero = await win.locator('.home-hero').boundingBox();
  for (let i = 0; i < 16; i++) {
    await win.mouse.move(hero.x + 60 + i * 14, hero.y + hero.height / 2 + Math.sin(i / 3) * 30);
    await sleep(40);
  }
  await sleep(500);
  await win.screenshot({ path: join(shots, 'dock-07-signal-hero.png'), clip: hero });
  await win.locator('.home-hero button:has-text("Pause"):visible').click();
  await sleep(500);
  t.check('Signal home: dither lens over the "Now playing" box, its button still works', (await win.locator('.home-hero .hero-dither canvas').count()) === 2 && (await win.locator('.play-btn[aria-label="Lecture"]').count()) === 1);

  // Radio: a long country name stays on one line
  await gotoNav(win, 'Radio');
  await waitFor(async () => (await win.locator('.radio-country').count()) > 50, 20000);
  const tall = await win.evaluate(() => [...document.querySelectorAll('.radio-country')].filter((e) => e.getBoundingClientRect().height > 34 || e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  t.check('Radio: every country on one line, nothing overlapping', tall.length === 0, tall.slice(0, 3).join(' | '));
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'dock-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
