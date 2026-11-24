// Settings tools of 1.3.0, offline: "Recently played" holds 10 tracks; scanning can be paused
// per library folder; all playlists can be deleted (asked twice); hidden YouTube Music artists
// are listed only once the list is opened, and brought back from there; a YouTube video refused
// with "Sign in to confirm you're not a bot" is tried once more, then playback moves on with an
// explanation, the track itself not marked unavailable (CHUD_TEST_YT_BLOCKED stands in for
// YouTube's answer).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, npTitle, showPlaylists, sleep, tempDir, waitScanIdle, shots } from './harness.mjs';
import { mp3 } from './gen-library.mjs';

const t = createSuite('settings-tools');
const profile = tempDir('chud-settings-tools-');
const lib = tempDir('chud-settings-tools-lib-');
let app, win;

for (let i = 1; i <= 25; i++) writeFileSync(join(lib, `track-${String(i).padStart(2, '0')}.mp3`), mp3({ title: `Morceau ${i}`, artist: 'Groupe', album: 'Vingt-cinq', track: i }));
const tracks = () => win.evaluate(() => window.chud.library.tracks());
const settings = async () => {
  await gotoNav(win, 'Paramètres');
  await sleep(400);
};

try {
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await waitScanIdle(win);
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  const all = await tracks();
  t.check('library: 25 generated tracks plus the fixtures', all.filter((x) => x.album === 'Vingt-cinq').length === 25);

  // ── "Recently played": 10 tracks, however many were played
  for (const tr of all.filter((x) => x.album === 'Vingt-cinq')) await win.evaluate((x) => window.chud.history.record(x, 'test'), tr);
  const recent = await win.evaluate(() => window.chud.library.recentlyPlayed(1000));
  t.check('"Recently played" holds 10 tracks, even when more are asked for', recent.length === 10, String(recent.length));

  // ── scanning paused for one folder
  await settings();
  const row = win.locator('.setting-row', { hasText: lib });
  await row.locator('[data-folder-scan] button:has-text("Pause")').click();
  await sleep(400);
  t.check('the folder says its scanning is paused', (await row.locator('.badge:has-text("analyse en pause")').count()) === 1 && (await row.locator('[data-folder-scan="off"]').count()) === 1);
  const folders = await win.evaluate(() => window.chud.library.folders());
  t.check('…only that folder', folders.find((f) => f.path === lib)?.scan === false && folders.find((f) => f.path === music)?.scan === true);
  await win.screenshot({ path: join(shots, 'settings-tools-01-folders.png') });
  writeFileSync(join(lib, 'new-one.mp3'), mp3({ title: 'Nouveau', artist: 'Groupe', album: 'Vingt-cinq', track: 26 }));
  await sleep(4000); // a watched folder shows a new file within ~2 s
  t.check('a file added to a paused folder is not picked up', !(await tracks()).some((x) => x.title === 'Nouveau'));
  await win.locator('button:has-text("Réanalyser")').click();
  await sleep(500);
  await waitScanIdle(win);
  t.check('…not even by Rescan, and its tracks stay in the library', !(await tracks()).some((x) => x.title === 'Nouveau') && (await tracks()).filter((x) => x.album === 'Vingt-cinq').length === 25);
  await row.locator('[data-folder-scan] button:has-text("Analyse")').click();
  await sleep(800);
  await waitScanIdle(win);
  t.check('scanning on again: the folder is read at once', (await tracks()).some((x) => x.title === 'Nouveau'));
  const after = await win.evaluate(() => window.chud.library.folders());
  t.check('…and its switch is back on', after.find((f) => f.path === lib)?.scan === true);

  // ── delete all playlists, asked twice
  for (const name of ['Un', 'Deux', 'Trois']) await win.evaluate((n) => window.chud.playlists.create(n, []), name);
  await settings();
  const del = win.locator('[data-remove-all-playlists]');
  await del.scrollIntoViewIfNeeded();
  await del.click();
  await sleep(300);
  t.check('first question: how many, and that files are not touched', /Supprimer les 3 playlists/.test(await win.locator('.dialog').innerText()) && /ne sont pas touchés/.test(await win.locator('.dialog').innerText()));
  await win.locator('.dialog button[type=submit]').click();
  await sleep(300);
  t.check('second question: it cannot be undone', /irréversible/.test(await win.locator('.dialog').innerText()));
  await win.screenshot({ path: join(shots, 'settings-tools-02-delete-all.png') });
  await win.locator('.dialog button.ghost').click();
  await sleep(300);
  t.check('cancelled at the second question: nothing deleted', (await win.evaluate(() => window.chud.playlists.list())).length === 3);
  await del.click();
  await sleep(300);
  await win.locator('.dialog button[type=submit]').click();
  await sleep(300);
  await win.locator('.dialog button[type=submit]').click();
  await sleep(600);
  t.check('confirmed twice: every playlist is gone, a toast says how many', (await win.evaluate(() => window.chud.playlists.list())).length === 0 && (await win.locator('.toast:has-text("3 playlists supprimées")').count()) >= 1);
  t.check('…the library is untouched', (await tracks()).filter((x) => x.album === 'Vingt-cinq').length === 26);

  // ── hidden artists: folded list in Settings › YouTube Music
  await win.evaluate(async () => {
    await window.chud.youtube.hideArtist({ id: 'UC_test_a', name: 'Artiste Masqué' });
    await window.chud.youtube.hideArtist({ id: null, name: 'Autre Artiste' });
  });
  await gotoNav(win, 'Bibliothèque'); // Settings opened afresh, as a person would
  await settings();
  const toggle = win.locator('[data-hidden-artists-toggle]');
  await toggle.scrollIntoViewIfNeeded();
  t.check('Settings opens with the hidden artists folded: names not shown', (await win.locator('[data-hidden-artists]').count()) === 0 && !(await win.locator('.page').innerText()).includes('Artiste Masqué'));
  t.check('…the row says how many', (await win.locator('.setting-row:has-text("Artistes masqués")').innerText()).includes('2 artistes'));
  await toggle.click();
  await sleep(300);
  t.check('opened: both artists, each with Restore', (await win.locator('[data-hidden-artists] .hidden-artist').count()) === 2);
  await win.screenshot({ path: join(shots, 'settings-tools-03-hidden-artists.png') });
  await win.locator('.hidden-artist:has-text("Artiste Masqué") button').click();
  await sleep(400);
  const left = await win.evaluate(() => window.chud.youtube.hiddenArtists());
  t.check('Restore brings one back, the other stays hidden', left.length === 1 && left[0].name === 'Autre Artiste' && (await win.locator('[data-hidden-artists] .hidden-artist').count()) === 1);

  // ── YouTube refuses the video ("not a bot"): one more try, then the next track, explained
  await app.evaluate(() => { process.env.CHUD_TEST_YT_BLOCKED = 'signin'; });
  const local = (await tracks()).find((x) => x.title === 'Minuit Chrome');
  const yt = { id: 'yt:aaaaaaaaaaa', source: 'youtube', videoId: 'aaaaaaaaaaa', title: 'Vidéo refusée', artist: 'Quelqu’un', album: null, durationSec: 200, coverUrl: null, available: true };
  await win.evaluate((e) => window.chud.playlists.create('Refus', e), [yt, local]);
  await showPlaylists(win);
  await win.locator('.side-item:has-text("Refus")').click();
  await sleep(700);
  const t0 = Date.now();
  await win.locator('.page .tl-body .tl-row').first().locator('.t-title').dblclick();
  let toast = 0;
  while (Date.now() - t0 < 25_000 && !(toast = await win.locator('.toast:has-text("pas un robot")').count())) await sleep(300);
  const ms = Date.now() - t0;
  t.check('refused video: explained in a toast (sign-in asked by YouTube, never by Chud Music)', toast >= 1, `${ms} ms`);
  // the player's own error comes at once (an id that does not exist), then the 2.5 s pause and the retry
  t.check('…after one more try, not at once (≥ 2.5 s)', ms >= 2500, `${ms} ms`);
  t.check('…well before the 25 s timeout', ms < 22_000, `${ms} ms`);
  await sleep(2500);
  t.check('…playback moved on to the next track', (await npTitle(win)) === 'Minuit Chrome', await npTitle(win));
  t.check('…the YouTube track is not marked unavailable', (await win.locator('.page .tl-body .tl-row.unavailable').count()) === 0);
  await win.screenshot({ path: join(shots, 'settings-tools-04-yt-blocked.png') });
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
}
process.exit(t.finish() ? 1 : 0);
