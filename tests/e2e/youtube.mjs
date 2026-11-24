// YouTube Music, end to end against the real service (needs Internet): search (titles, albums,
// artists), playback through the official player in the living cover, controls, mixed
// playlists, "Démarrer le mix", the ad blocker status, and that a local file still plays after.
// Screenshots go to tests/output/youtube.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, elapsed, gotoNav, launch, music, npTitle, root, secondInstance, sleep, tempDir, showPlaylists } from './harness.mjs';

const t = createSuite('youtube');
const profile = tempDir('chud-yt-');
const out = join(root, 'tests/output/youtube');
mkdirSync(out, { recursive: true });
const QUERY = process.env.YT_QUERY ?? 'Daft Punk One More Time';
let app, win;

const waitFor = async (fn, ms = 20000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
};

try {
  const errors = [];
  ({ app, win } = await launch(profile));
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && !/youtube|googlevideo|doubleclick|ERR_BLOCKED_BY_CLIENT/i.test(m.text()) && errors.push(m.text()));
  await sleep(1000);

  // ── search
  await gotoNav(win, 'YouTube Music');
  const input = win.locator('.yt-searchbox input');
  await input.fill('daft p');
  const sugg = await waitFor(async () => (await win.locator('.yt-suggest button').count()) > 0, 8000);
  t.check('search suggestions appear while typing', !!sugg);
  await input.fill(QUERY);
  await input.press('Enter');
  const rows = await waitFor(async () => (await win.locator('.page .tl-body .tl-row').count()) >= 5 && true, 20000);
  const firstTitle = rows ? await win.locator('.page .tl-body .tl-row').first().locator('.t-title').innerText() : '';
  t.check('song search returns results in our own list', !!rows, firstTitle);
  await win.screenshot({ path: join(out, '01-search-songs.png') });

  await win.locator('.yt-toolbar button[aria-label="Grille"]').click();
  await sleep(500);
  t.check('grid layout shows cover cards', (await win.locator('.page .album-grid .album-card').count()) >= 5);
  await win.screenshot({ path: join(out, '02-search-grid.png') });
  await win.locator('.yt-toolbar button[aria-label="Liste"]').click();

  await win.locator('.yt-toolbar button:has-text("Albums")').click();
  const albums = await waitFor(async () => (await win.locator('.page .yt-rows .yt-row').count()) > 0, 15000);
  t.check('album search', !!albums);
  await win.locator('.page .yt-rows .yt-row').first().click();
  const albumTracks = await waitFor(async () => (await win.locator('.page .tl-body .tl-row').count()) > 3, 15000);
  t.check('album page lists its tracks', !!albumTracks, await win.locator('.list-hero-title').innerText().catch(() => ''));
  await win.screenshot({ path: join(out, '03-album.png') });
  await win.locator('.yt-back').click();

  await win.locator('.yt-toolbar button:has-text("Artistes")').click();
  const artists = await waitFor(async () => (await win.locator('.page .yt-rows .yt-row').count()) > 0, 15000);
  t.check('artist search', !!artists);
  await win.locator('.page .yt-rows .yt-row').first().click();
  const artistPage = await waitFor(async () => (await win.locator('.page .section-title:has-text("Titres populaires")').count()) > 0, 15000);
  t.check('artist page: popular titles and albums', !!artistPage && (await win.locator('.page .section-title:has-text("Albums")').count()) > 0);
  await win.screenshot({ path: join(out, '04-artist.png') });
  await win.locator('.yt-back').click();
  await win.locator('.yt-toolbar button:has-text("Titres")').click();
  await waitFor(async () => (await win.locator('.page .tl-body .tl-row').count()) >= 5, 15000);

  // ── playback through the official player
  await win.locator('.page .tl-body .tl-row').first().locator('.t-title').dblclick(); // the title: the artist name is a link
  const playing = await waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1 && (await elapsed(win)) >= 2, 30000);
  t.check('YouTube track plays (official player, time advances)', !!playing, `${await npTitle(win)} t=${await elapsed(win)}s`);
  const box = await win.locator('.yt-player.visible').boundingBox();
  t.check('player visible in the living cover, at least 200×200', !!box && box.width >= 200 && box.height >= 200, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'not visible');
  t.check('nothing drawn over the player (no badge, no effect canvas)', (await win.locator('.living-cover-label').count()) === 0 && (await win.locator('.living-cover-frame canvas').count()) === 0);
  t.check('player bar says YouTube', (await win.locator('.np-badges >> text=YouTube').count()) === 1);
  await win.screenshot({ path: join(out, '05-playing.png') });
  const m = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ type: x.type, mb: Math.round(x.memory.workingSetSize / 1024) })));
  console.log(`INFO  memory while YouTube plays: ${m.reduce((s, x) => s + x.mb, 0)} MB — ${m.map((x) => `${x.type}:${x.mb}`).join(', ')}`);

  await win.locator('.play-btn').click();
  await sleep(1200);
  const pausedAt = await elapsed(win);
  await sleep(1500);
  t.check('pause holds the position', (await win.locator('.play-btn[aria-label="Lecture"]').count()) === 1 && (await elapsed(win)) === pausedAt, `${pausedAt}s`);
  await win.evaluate(() => window.document.querySelector('.play-btn')?.click());
  await sleep(500);
  // seek with the keyboard shortcut (same store path as the seek bar)
  await win.locator('.page-title').click();
  for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight');
  await sleep(2500);
  t.check('seeking works (+15 s with the arrow keys)', (await elapsed(win)) >= pausedAt + 12, `${pausedAt}s → ${await elapsed(win)}s`);

  // ── add to a playlist mixed with a local file
  await win.locator('.page .tl-body .tl-row').first().click({ button: 'right' });
  await win.locator('.menu-item:has-text("Ajouter à une playlist")').hover();
  await sleep(300);
  await win.locator('.menu .menu .menu-item:has-text("Nouvelle playlist")').click();
  await win.locator('.dialog input').fill('Mixte');
  await win.locator('.dialog button[type=submit]').click();
  await sleep(600);
  const pl = await win.evaluate(async () => {
    const list = await window.chud.playlists.list();
    const p = list.find((x) => x.name === 'Mixte');
    return p ? window.chud.playlists.get(p.id) : null;
  });
  t.check('YouTube track saved in a playlist (no path stored)', pl?.tracks.length === 1 && pl.tracks[0].source === 'youtube' && !pl.tracks[0].path, pl?.tracks[0]?.id);

  // ── "Démarrer le mix" = YouTube Music's own radio list
  await win.locator('.page .tl-body .tl-row').first().click({ button: 'right' });
  await win.locator('.menu-item:has-text("Démarrer le mix")').click();
  const mixTab = await waitFor(async () => (await win.locator('.tab.active .tab-label').innerText()).startsWith('Mix :'), 20000);
  const mixCount = await win.locator('.page .tl-body .tl-row').count();
  t.check('"Démarrer le mix" opens YouTube Music’s radio in a tab', !!mixTab && mixCount >= 10, `${mixCount} rows rendered`);
  const mixPlays = await waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1 && (await elapsed(win)) >= 1, 30000);
  t.check('the mix plays from the seed', !!mixPlays, await npTitle(win));
  await win.screenshot({ path: join(out, '06-mix.png') });

  await win.locator('button[aria-label="Suivant"]').click();
  const nextPlays = await waitFor(async () => (await elapsed(win)) >= 1 && (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1, 30000);
  t.check('next track in the mix plays', !!nextPlays, await npTitle(win));

  // ── ad blocker status is reported honestly
  const ab = await win.evaluate(() => window.chud.adblock.status());
  t.check('ad blocker active on the YouTube session', ab.enabled && ab.active, JSON.stringify(ab));

  // ── back to a local file: the YouTube player stops and hides
  await secondInstance(profile, join(music, 'Fractale.flac'));
  await win.waitForSelector('.tab >> text=Fichiers ouverts', { timeout: 10000 });
  await win.locator('.toast button:has-text("Lire")').click().catch(() => {});
  const local = await waitFor(async () => (await npTitle(win)) === 'Fractale' && (await elapsed(win)) >= 1, 15000);
  t.check('local file plays after YouTube; player hidden', !!local && (await win.locator('.yt-player.visible').count()) === 0);
  await win.locator('.living-cover').screenshot({ path: join(out, '07-back-to-local.png') });

  await gotoNav(win, 'Paramètres');
  await win.locator('.settings-group:has(h3:text-is("YouTube Music"))').scrollIntoViewIfNeeded();
  t.check('settings show the ad blocker as active', (await win.locator('.settings-group:has(h3:text-is("YouTube Music")) .badge.accent:has-text("Actif")').count()) === 1);
  await win.screenshot({ path: join(out, '08-settings.png') });

  // ad blocker switch: off really detaches it, on re-attaches it
  await win.locator('.settings-group:has(h3:text-is("YouTube Music")) [aria-label="Bloqueur de publicités"] button:text-is("Désactivé")').click();
  await sleep(500);
  const off = await win.evaluate(() => window.chud.adblock.status());
  await win.locator('.settings-group:has(h3:text-is("YouTube Music")) [aria-label="Bloqueur de publicités"] button:text-is("Activé")').click();
  await sleep(800);
  const on = await win.evaluate(() => window.chud.adblock.status());
  t.check('ad blocker switch turns it off and back on', !off.enabled && !off.active && on.enabled && on.active);

  t.check('no console errors from the app', errors.length === 0, errors.slice(0, 3).join(' | '));
  await app.close();

  // ── restart: the YouTube entry comes back from the database and plays from the playlist
  ({ app, win } = await launch(profile));
  await sleep(1500);
  await showPlaylists(win);
  await win.locator('.side-item:has-text("Mixte")').click();
  await win.waitForSelector('.page .tl-body .tl-row', { timeout: 10000 });
  await win.locator('.page .tl-body .tl-row').first().locator('.t-title').dblclick(); // the title: the artist name is a link
  const again = await waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1 && (await elapsed(win)) >= 1, 30000);
  t.check('after restart, the saved YouTube track plays from its playlist', !!again, await npTitle(win));
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
