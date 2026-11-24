// Pasted links in YouTube Music, against the real services (needs Internet): Spotify album,
// track, playlist and artist, YouTube video, playlist, album and artist pages; tracks matched on
// YouTube Music, saved as a playlist; clickable artists/albums (and the setting that turns them
// off); "Trouver l'artiste sur YouTube Music" from a local file. Screenshots: tests/output/links.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, root, sleep, tempDir } from './harness.mjs';

const t = createSuite('links');
const profile = tempDir('chud-links-');
const out = join(root, 'tests/output/links');
mkdirSync(out, { recursive: true });
let app, win;

const waitFor = async (fn, ms = 30000, step = 300) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
};

/** Pastes a link into the YouTube Music search box (a real paste event, as Ctrl+V does). */
async function paste(text) {
  await gotoNav(win, 'YouTube Music');
  if (await win.locator('.yt-back').count()) {
    // back to the search view
    while (await win.locator('.yt-back').count()) {
      await win.locator('.yt-back').click();
      await sleep(200);
    }
  }
  const input = win.locator('.yt-searchbox input');
  await input.fill('');
  await input.focus();
  await win.evaluate((s) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', s);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}
const rows = () => win.locator('.page .tl-body .tl-row');
const heroTitle = () => win.locator('.list-hero-title').innerText().catch(() => '');
/** Waits until every Spotify track has been looked up; returns [found, total]. */
async function matched(ms = 120000) {
  const done = await waitFor(async () => (await win.locator('.list-hero').count()) && (await win.locator('.link-progress').count()) === 0, ms, 500);
  const stats = await win.locator('.list-hero-stats').innerText().catch(() => '');
  const m = /(\d+) sur (\d+)/.exec(stats);
  return done && m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

try {
  const errors = [];
  ({ app, win } = await launch(profile, [join(music, '01 - Minuit Chrome.mp3')]));
  win.on('pageerror', (e) => errors.push(e.message));
  await sleep(800);

  await gotoNav(win, 'YouTube Music');
  const hint = await win.locator('.yt-link-hint').innerText().catch(() => '');
  t.check('YouTube Music: a small hint says links can be pasted', /YouTube/.test(hint) && /Spotify/.test(hint), hint);
  await win.screenshot({ path: join(out, '00-hint.png') });

  // ── Spotify album (18 tracks)
  let t0 = Date.now();
  await paste('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
  const [aFound, aTotal] = await matched();
  t.check('Spotify album: tracks found on YouTube Music', aTotal === 18 && aFound >= 15, `${aFound}/${aTotal} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  t.check('…titled after the album, marked Spotify', (await heroTitle()) === 'Global Warming' && /Spotify/.test(await win.locator('.list-hero-kicker').innerText()));
  t.check('…listed in a playable list', (await rows().count()) === aFound);
  await win.screenshot({ path: join(out, '01-spotify-album.png') });
  // save as a playlist
  await win.locator('.list-hero-actions button:has-text("Enregistrer en playlist")').click();
  await sleep(400);
  await win.locator('.dialog button:has-text("Créer")').click();
  await sleep(800);
  const pl = await win.evaluate(() => window.chud.playlists.list());
  t.check('"Enregistrer en playlist" creates it with the found tracks', pl.some((p) => p.name === 'Global Warming' && p.count === aFound), pl.map((p) => `${p.name}:${p.count}`).join(', '));
  t.check('…and opens it', (await win.locator('.tab.active .tab-label').innerText()) === 'Global Warming');

  // ── Spotify track
  await paste('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x');
  const [tFound] = await matched(30000);
  const first = await rows().first().innerText().catch(() => '');
  t.check('Spotify track: the same song on YouTube Music', tFound === 1 && /Never Gonna Give You Up/i.test(first) && /Rick Astley/i.test(first), first.replace(/\n/g, ' · '));

  // ── Spotify playlist (50 tracks): how many are found, how long it takes
  t0 = Date.now();
  await paste('https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd');
  const [pFound, pTotal] = await matched(180000);
  t.check('Spotify playlist: most tracks found', pTotal >= 30 && pFound / pTotal >= 0.85, `${pFound}/${pTotal} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const missing = await win.locator('h2.section-title:has-text("Introuvables")').count();
  t.check('…tracks not found are listed apart (or none)', pFound === pTotal ? missing === 0 : missing === 1);
  await win.screenshot({ path: join(out, '02-spotify-playlist.png') });

  // ── Spotify artist: its YouTube Music page
  await paste('https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi');
  await waitFor(async () => /Daft Punk/i.test(await heroTitle()), 30000);
  t.check('Spotify artist: opens the YouTube Music artist page', /Daft Punk/i.test(await heroTitle()) && /Artiste/.test(await win.locator('.list-hero-kicker').innerText()), await heroTitle());

  // ── YouTube video
  await paste('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await waitFor(async () => (await rows().count()) === 1, 30000);
  const vid = await rows().first().innerText().catch(() => '');
  t.check('YouTube video: the track, with its artist', /Never Gonna Give You Up/i.test(vid) && /Rick Astley/i.test(vid), vid.replace(/\n/g, ' · '));
  // clickable artist (on by default)
  const artistLink = rows().first().locator('.yt-meta-link').first();
  t.check('YouTube Music artist names are links', (await artistLink.count()) === 1);
  await artistLink.click();
  await waitFor(async () => /Rick Astley/i.test(await heroTitle()), 30000);
  t.check('clicking the artist opens its page', /Rick Astley/i.test(await heroTitle()));
  await win.screenshot({ path: join(out, '03-artist-from-link.png') });

  // ── YouTube playlist (≥ 100 videos, read in pages)
  t0 = Date.now();
  await paste('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI');
  // the list is virtualised: count from the header ("N titres")
  const ytCount = async () => Number(/(\d+) titres/.exec(await win.locator('.list-hero-stats').innerText().catch(() => ''))?.[1] ?? 0);
  await waitFor(async () => (await ytCount()) > 100, 60000);
  t.check('YouTube playlist: all its pages read', (await ytCount()) > 100, `${await ytCount()} tracks, ${((Date.now() - t0) / 1000).toFixed(1)} s, "${await heroTitle()}"`);

  // ── YouTube Music album and artist pages
  await paste('https://music.youtube.com/browse/MPREb_7ltM34kr0mH');
  await waitFor(async () => (await heroTitle()) === 'Discovery', 30000);
  t.check('YouTube Music album link: opens the album', (await heroTitle()) === 'Discovery');
  const albumLink = win.locator('.page .tl-body .tl-row .yt-meta-link');
  t.check('album page: artists are links', (await albumLink.count()) > 0);

  // ── a link that leads nowhere, and plain text
  await paste('https://open.spotify.com/track/0000000000000000000000');
  await waitFor(async () => (await win.locator('.empty h3:has-text("Impossible d’ouvrir ce lien")').count()) === 1, 30000);
  const dead = await win.locator('.empty p').innerText().catch(() => '');
  t.check('a dead link says so (not found)', (await win.locator('.empty h3:has-text("Impossible d’ouvrir ce lien")').count()) === 1 && /introuvable/.test(dead), dead);
  await gotoNav(win, 'YouTube Music');
  while (await win.locator('.yt-back').count()) await win.locator('.yt-back').click();
  await win.locator('.yt-searchbox input').fill('daft punk around the world');
  await win.locator('.yt-searchbox input').press('Enter');
  await waitFor(async () => (await rows().count()) > 3, 20000);
  t.check('plain text is still a search', (await rows().count()) > 3 && (await win.locator('.yt-link-hint').count()) === 1);

  // ── the setting turns the links off
  await win.evaluate(() => window.chud.settings.set({ ytLinks: false }));
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(800);
  await gotoNav(win, 'YouTube Music');
  await win.locator('.yt-searchbox input').fill('daft punk around the world');
  await win.locator('.yt-searchbox input').press('Enter');
  await waitFor(async () => (await rows().count()) > 3, 20000);
  t.check('setting off: artist and album names are plain text', (await rows().count()) > 3 && (await win.locator('.page .yt-meta-link').count()) === 0);
  await win.evaluate(() => window.chud.settings.set({ ytLinks: true }));

  // ── local file: find its artist on YouTube Music (a made-up artist: the artist search shows)
  await win.locator('.tab:has-text("Fichiers ouverts")').click().catch(() => {});
  await sleep(400);
  const local = win.locator('.page .tl-body .tl-row').first();
  if (await local.count()) {
    await local.click({ button: 'right' });
    await sleep(300);
    await win.locator('.menu-item:has-text("Trouver l’artiste sur YouTube Music")').click();
    const opened = await waitFor(async () => (await win.locator('.tab.active .tab-label').innerText()) === 'YouTube Music' && ((await win.locator('.list-hero-kicker:has-text("Artiste")').count()) || (await win.locator('.yt-toolbar button[aria-checked="true"]:has-text("Artistes")').count())), 30000);
    t.check('local file › "Trouver l’artiste sur YouTube Music" opens YouTube Music on that artist', !!opened, await win.locator('.yt-searchbox input').inputValue().catch(() => ''));
    await win.screenshot({ path: join(out, '04-find-artist.png') });
  } else t.check('local file in "Fichiers ouverts"', false);

  t.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
