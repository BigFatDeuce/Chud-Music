// Stability with a big library: 3 000 tagged files, 750 albums with their own cover. The album
// and artist views must draw only what is in sight (small cover copies), and going in and out of
// an artist or album (the × of the filter) must never take the window down — that click used to
// draw every artist at once with full-size covers, which crashed the interface on Linux.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, sleep, tempDir, waitScanIdle } from './harness.mjs';
import { generateLibrary } from './gen-library.mjs';

const t = createSuite('stability');
const profile = tempDir('chud-stab-');
const lib = tempDir('chud-stab-lib-');
const ARTISTS = 250, ALBUMS = 3, TRACKS = 4;
let app, win;
let crashes = 0;

try {
  const n = generateLibrary(lib, { artists: ARTISTS, albums: ALBUMS, tracks: TRACKS, coverPx: 500 });
  console.log(`INFO  generated ${n} files`);

  ({ app, win } = await launch(profile));
  win.on('crash', () => crashes++);
  app.on('window', (w) => w.on('crash', () => crashes++));
  await win.evaluate(() => window.chud.settings.set({ hideSmallAlbums: false }));
  await win.reload();
  await win.waitForSelector('.nav-item');
  const t0 = Date.now();
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await waitScanIdle(win, 600000);
  const count = (await win.evaluate(() => window.chud.library.tracks())).length;
  t.check(`scan of ${n} tagged files with covers`, count === n, `${((Date.now() - t0) / 1000).toFixed(1)} s`);

  await gotoNav(win, 'Bibliothèque');
  await sleep(1500); // the library reloads after the scan
  const page = win.locator('.page').first();
  const scrollTo = (f) => page.evaluate((el, f) => { el.scrollTop = f === 1 ? el.scrollHeight : el.scrollHeight * f; }, f);

  // ── albums: virtualized, small covers ──
  await win.locator('.segmented button:has-text("Albums")').click();
  await sleep(1200);
  const cards = await win.locator('.album-card').count();
  t.check('albums view draws only the rows in sight', cards > 0 && cards < 160, `${cards} cards in the page for ${ARTISTS * ALBUMS} albums`);
  const src = await win.locator('.album-card img').first().getAttribute('src');
  t.check('album covers are asked as small copies', /[?&]s=256\b/.test(src ?? ''), src ?? 'no img');
  await sleep(800);
  const thumbs = join(profile, 'Cache', 'thumbs');
  const nThumbs = existsSync(thumbs) ? readdirSync(thumbs).length : 0;
  t.check('small copies made once, in the app cache', nThumbs > 0 && nThumbs < 200, `${nThumbs} files`);
  await scrollTo(1);
  await sleep(1200);
  const last = `Disque ${ALBUMS - 1} de ${ARTISTS - 1}`;
  t.check('scrolled to the end: the last album is drawn', (await win.locator(`.album-card:has-text("${last}")`).count()) === 1);
  t.check('still few cards after scrolling', (await win.locator('.album-card').count()) < 160);
  await scrollTo(0);

  // ── artists: virtualized ──
  await win.locator('.segmented button:has-text("Artistes")').click();
  await sleep(1200);
  const rowsN = await win.locator('.artist-row').count();
  t.check('artists view draws only the rows in sight', rowsN > 0 && rowsN < 200, `${rowsN} rows for ${ARTISTS} artists`);

  // ── the reported crash: in and out of an artist (×), many times, from everywhere ──
  const heap0 = await win.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  for (let i = 0; i < 12; i++) {
    if (i % 3 === 0) {
      // from a track's artist link (the Titles view), as in the report
      await win.locator('.segmented button:has-text("Titres")').click();
      await sleep(400);
      await scrollTo((i % 6) / 6);
      await sleep(400);
      await win.locator('.page .tl-body .tl-row .yt-meta-link').first().click();
    } else if (i % 3 === 1) {
      await win.locator('.segmented button:has-text("Artistes")').click();
      await sleep(400);
      await scrollTo(i / 12);
      await sleep(400);
      await win.locator('.artist-row').nth(2).click();
    } else {
      await win.locator('.segmented button:has-text("Albums")').click();
      await sleep(400);
      await scrollTo(i / 12);
      await sleep(400);
      await win.locator('.album-card').nth(1).click();
    }
    await win.waitForSelector('.chip.drill', { timeout: 5000 });
    await sleep(300);
    await win.locator('.chip.drill').click();
    await sleep(700);
  }
  const alive = await win.evaluate(() => !!document.querySelector('.playerbar') && !document.querySelector('.fatal'));
  t.check('12 times in and out of an artist / album (×): no crash, no error screen', crashes === 0 && alive, `${crashes} renderer crashes`);
  const after = await win.locator('.artist-row, .album-card').count();
  t.check('the view after × is still virtualized', after > 0 && after < 200, `${after} cards`);

  const heap1 = await win.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, mb: Math.round(m.memory.workingSetSize / 1024) })));
  const renderer = metrics.filter((m) => m.type === 'Tab').reduce((s, m) => Math.max(s, m.mb), 0);
  const gpu = metrics.find((m) => m.type === 'GPU')?.mb ?? 0;
  t.check('interface memory stays bounded', renderer < 1200, `renderer ${renderer} MB, GPU ${gpu} MB, JS heap ${Math.round(heap0 / 1e6)} → ${Math.round(heap1 / 1e6)} MB`);

  // ── fast typing in the search over 3 000 tracks, then the × of the search ──
  await win.locator('.segmented button:has-text("Artistes")').click();
  await win.locator('.search input').pressSequentially('Artiste 12', { delay: 15 });
  await sleep(500);
  const found = await win.locator('.artist-row').count();
  t.check('search narrows the artists', found >= 1 && found < 20, `${found}`);
  await win.locator('.search .icon-btn').click();
  await sleep(600);
  t.check('clearing the search: back to all, still virtualized, no crash', crashes === 0 && (await win.locator('.artist-row').count()) < 200);

  // ── the main process too ──
  t.check('main process answers', (await app.evaluate(() => 42)) === 42);
} catch (e) {
  t.check('stability run', false, e.message);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
}
process.exit(t.finish() ? 1 : 0);
