// Right-click › Remove the found cover (one track or a selection), and a playlist's
// "Replace with my local files…" (YouTube Music entries that are also in the library). Offline:
// the found covers are written into the database the way the cover finder does, and the
// YouTube Music entries are plain playlist data (nothing is played from YouTube).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanup, createSuite, gotoNav, launch, music, shots, showPlaylists, sleep, tempDir, waitScanIdle } from './harness.mjs';
import { png } from './gen-library.mjs';

const t = createSuite('swaps');
const profile = tempDir('chud-swaps-');
let app, win;
const tracks = () => win.evaluate(() => window.chud.library.tracks());
const row = (title) => win.locator(`.page .tl-body .tl-row:has-text("${title}")`);
const yt = (videoId, title, artist, durationSec) => ({ id: `yt:${videoId}`, source: 'youtube', videoId, title, artist, album: null, durationSec, coverUrl: null, available: true });

try {
  // ── a library, then two "found" covers for the two files without one (as covers.ts saves them)
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  const bare = (await tracks()).filter((x) => !x.coverUrl);
  await app.close();
  const found = join(profile, 'Cache', 'covers', 'found');
  mkdirSync(found, { recursive: true });
  writeFileSync(join(found, 'aaaaaaaaaaaaaaaaaaaaaaaa.jpg'), png(600, 600, [200, 40, 90]));
  const db = new DatabaseSync(join(profile, 'chud.db'));
  const ins = db.prepare("INSERT INTO found_covers (track_id, ref, kind, found_at) VALUES (?, 'found/aaaaaaaaaaaaaaaaaaaaaaaa.jpg', 'album', 1)");
  for (const x of bare) ins.run(x.id);
  db.close();
  t.check('two library files without a cover', bare.length === 2, bare.map((x) => x.title).join(', '));

  ({ app, win } = await launch(profile));
  await gotoNav(win, 'Bibliothèque');
  await sleep(600);
  t.check('…they show the found cover', (await tracks()).filter((x) => x.coverUrl?.includes('found%2F')).length === 2);

  // a track with its own cover: no such menu entry
  await row('Minuit Chrome').locator('.t-title').click();
  await row('Minuit Chrome').click({ button: 'right' });
  t.check('a file with its own cover: no "remove found cover"', (await win.locator('.menu-item:has-text("pochette trouvée")').count()) === 0);
  await win.keyboard.press('Escape');

  // one track
  const [a, b] = bare;
  await row(a.title).locator('.t-title').click();
  await row(a.title).click({ button: 'right' });
  const one = win.locator('.menu-item:has-text("Retirer la pochette trouvée")');
  t.check('one track: "Retirer la pochette trouvée"', (await one.count()) === 1);
  await win.screenshot({ path: join(shots, 'swaps-01-cover-menu.png') });
  await one.click();
  await sleep(800);
  let now = await tracks();
  t.check('…that track has no cover any more', !now.find((x) => x.id === a.id).coverUrl);
  t.check('…the other one keeps it', !!now.find((x) => x.id === b.id).coverUrl);
  t.check('…the picture stays while another track uses it', existsSync(join(found, 'aaaaaaaaaaaaaaaaaaaaaaaa.jpg')));
  t.check('…a toast says so', (await win.locator('.toast:has-text("Pochette trouvée retirée")').count()) >= 1);

  // a selection of several (the one already removed is not counted again)
  await row(a.title).locator('.t-title').click();
  await row(b.title).locator('.t-title').click({ modifiers: ['Control'] });
  await row('Minuit Chrome').locator('.t-title').click({ modifiers: ['Control'] });
  await row(b.title).click({ button: 'right' });
  const label = await win.locator('.menu-item:has-text("pochette")').allInnerTexts();
  t.check('a selection: counts only the tracks with a found cover', label.some((l) => l.includes('Retirer la pochette trouvée')), label.join(' | '));
  await win.locator('.menu-item:has-text("Retirer la pochette trouvée")').click();
  await sleep(800);
  now = await tracks();
  t.check('…removed', !now.find((x) => x.id === b.id).coverUrl && !!now.find((x) => x.title === 'Minuit Chrome').coverUrl);
  t.check('…the picture, used by nobody now, is deleted', !existsSync(join(found, 'aaaaaaaaaaaaaaaaaaaaaaaa.jpg')));
  const st = await win.evaluate(() => window.chud.library.coverStatus());
  t.check('…"Remove found covers" no longer counts them', st.saved === 0, `saved ${st.saved}`);
  await app.close();
  const db2 = new DatabaseSync(join(profile, 'chud.db'));
  const kinds = db2.prepare('SELECT kind FROM found_covers').all().map((r) => r.kind);
  db2.close();
  t.check('…and the next search leaves them alone (marked "removed")', kinds.length === 2 && kinds.every((k) => k === 'removed'), kinds.join(', '));

  // ── a playlist with YouTube Music entries
  ({ app, win } = await launch(profile));
  const local = await tracks();
  const minuit = local.find((x) => x.title === 'Minuit Chrome');
  const entries = [
    yt('vid1', 'Minuit Chrome (Official Video)', 'Les Cassettes', 41), // the same song: replaced
    yt('vid2', 'Une autre chanson', 'Quelqu’un', 200), // not in the library
    yt('vid3', 'Minuit Chrome (Live)', 'Les Cassettes', 41), // a live version: not the same
    minuit, // already local
    yt('vid4', 'Boulevard des Ondes', 'Les Cassettes', 300), // same title, far too long
    yt('vid5', 'Boulevard des ondes', 'Les Cassettes, Invité', 35), // same song, featured artist
    yt('vid6', 'Verre Bleu (Lyrics)', 'Aqua Glow', 31), // a lyrics upload: the same recording
  ];
  const plId = await win.evaluate((e) => window.chud.playlists.create('Mélange', e), entries);
  const swaps = await win.evaluate((id) => window.chud.playlists.localSwaps(id), plId);
  t.check('3 entries found in the library', swaps.length === 3, swaps.map((s) => `${s.from.title} → ${s.to.title}`).join(' | '));
  await showPlaylists(win);
  await win.locator('.side-item:has-text("Mélange")').click();
  await sleep(600);
  await win.locator('.list-hero-actions button[aria-label="Plus d’actions"]').click();
  await win.locator('.menu-item:has-text("Remplacer par mes fichiers locaux")').click();
  await win.locator('.dialog').waitFor({ timeout: 3000 });
  const text = await win.locator('.dialog').innerText();
  t.check('a confirmation lists the songs', /Remplacer 3 morceaux par vos fichiers locaux/.test(text) && text.includes('Minuit Chrome') && text.includes('Boulevard des Ondes'), text.replace(/\s+/g, ' ').slice(0, 160));
  await win.screenshot({ path: join(shots, 'swaps-02-confirm.png') });
  await win.locator('.dialog button[type=submit]').click();
  await sleep(1000);
  const after = await win.evaluate((id) => window.chud.playlists.get(id), plId);
  const kinds2 = after.tracks.map((x) => `${x.source}:${x.title}`);
  t.check('replaced in place, the rest untouched', after.tracks.length === 7 && after.tracks[6].source === 'local' && after.tracks[0].source === 'local' && after.tracks[0].title === 'Minuit Chrome' && after.tracks[1].source === 'youtube' && after.tracks[2].source === 'youtube' && after.tracks[4].source === 'youtube' && after.tracks[5].source === 'local', kinds2.join(' | '));
  t.check('a toast counts them', (await win.locator('.toast:has-text("3 morceaux remplacés par vos fichiers")').count()) >= 1);
  // again: nothing left to replace
  await win.locator('.list-hero-actions button[aria-label="Plus d’actions"]').click();
  await win.locator('.menu-item:has-text("Remplacer par mes fichiers locaux")').click();
  await sleep(600);
  t.check('second time: "none in your library"', (await win.locator('.toast:has-text("Aucun morceau YouTube Music")').count()) >= 1 && (await win.locator('.dialog').count()) === 0);
  const files = (await tracks()).length;
  t.check('the library itself is unchanged', files === local.length);
} catch (e) {
  t.check('no crash', false, String(e?.stack ?? e));
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  t.finish();
}
