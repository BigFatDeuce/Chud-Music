// Hidden YouTube Music artists against the real catalogue (network needed): a hidden artist
// leaves searches (songs, albums, artists) and mixes; restored, it comes back. The right-click
// "Hide artist" on a search result takes its tracks off the results on screen at once.
import { cleanup, createSuite, gotoNav, launch, sleep, tempDir } from './harness.mjs';

const t = createSuite('hidden-online');
const profile = tempDir('chud-hidden-online-');
let app, win;
const ARTIST = 'Linkin Park';
const by = (x) => /linkin park/i.test(x.artist ?? x.name ?? '');

try {
  ({ app, win } = await launch(profile));
  const before = await win.evaluate((q) => window.chud.youtube.search(q, 'song'), `${ARTIST} Numb`);
  t.check('before: the search finds the artist’s songs', before.items.some(by), `${before.items.filter(by).length}/${before.items.length}`);
  const seed = before.items.find(by);
  const id = seed.ytArtistId;

  // right-click › Hide artist, on the results shown (its artist column: an album named after it,
  // by someone else, stays)
  await gotoNav(win, 'YouTube Music');
  await win.locator('.page input[type=search], .page input.yt-search, .page input').first().fill(`${ARTIST} Numb`);
  await win.keyboard.press('Enter');
  await win.locator('.page .tl-body .tl-row').first().waitFor({ timeout: 20000 });
  const row = win.locator('.page .tl-body .tl-row', { hasText: ARTIST }).first();
  await row.click({ button: 'right' });
  await win.locator('.menu-item:has-text("Masquer l’artiste")').first().click();
  await sleep(800);
  const shown = await win.locator('.page .tl-body .tl-row').allInnerTexts();
  t.check('right-click › Hide: its tracks leave the results on screen', !shown.some((r) => /linkin park/i.test(r.split('\n')[2] ?? '')), `${shown.length} rows left`);
  t.check('…a toast says so, with Undo', (await win.locator('.toast:has-text("est masqué")').count()) >= 1);

  const hidden = await win.evaluate(() => window.chud.youtube.hiddenArtists());
  t.check('the artist is saved as hidden (by id)', hidden.length === 1 && hidden[0].id === id, JSON.stringify(hidden));
  const songs = await win.evaluate((q) => window.chud.youtube.search(q, 'song'), `${ARTIST} Numb`);
  const albums = await win.evaluate((q) => window.chud.youtube.search(q, 'album'), ARTIST);
  const artists = await win.evaluate((q) => window.chud.youtube.search(q, 'artist'), ARTIST);
  t.check('new searches: no song by it', !songs.items.some(by), `${songs.items.length} songs`);
  t.check('…no album by it', !albums.items.some(by), `${albums.items.length} albums`);
  t.check('…no artist card for it', !artists.items.some((a) => a.id === id), `${artists.items.length} artists`);
  const mix = await win.evaluate((v) => window.chud.youtube.mix(v), seed.videoId);
  t.check('a mix started from one of its songs keeps that song, and nothing else by it', mix.tracks[0]?.videoId === seed.videoId && !mix.tracks.slice(1).some(by), `${mix.tracks.length} tracks`);

  await win.evaluate((a) => window.chud.youtube.unhideArtist(a), hidden[0]);
  const again = await win.evaluate((q) => window.chud.youtube.search(q, 'song'), `${ARTIST} Numb`);
  t.check('restored: it is found again', again.items.some(by));
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
}
process.exit(t.finish() ? 1 : 0);
