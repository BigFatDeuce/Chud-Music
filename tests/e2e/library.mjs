// Library, playlists, queue, watcher, persistence and migration — on the real app.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanup, createSuite, gotoNav, launch, music, npTitle, shots, sleep, tempDir, waitScanIdle, showPlaylists } from './harness.mjs';

const t = createSuite('library');
const profile = tempDir('chud-lib-e2e-');
const lib = tempDir('chud-lib-folder-');
cpSync(music, join(lib, 'Albums'), { recursive: true });
let app, win;
const api = (fn, ...a) => win.evaluate(fn, ...a);
const rows = () => win.locator('.page .tl-body .tl-row');
const rowTitles = async () => (await win.locator('.page .tl-body .tl-row .t-title').allInnerTexts());

try {
  // ── migration v1 → v2 keeps data and makes a backup first ──
  {
    const db = new DatabaseSync(join(profile, 'chud.db'));
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tracks (id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('local','youtube')), path TEXT, file_size INTEGER, mtime_ms INTEGER, yt_video_id TEXT, title TEXT NOT NULL, artist TEXT, album TEXT, album_artist TEXT, duration_sec REAL, codec TEXT, cover_ref TEXT, available INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL, last_played_at INTEGER, play_count INTEGER NOT NULL DEFAULT 0,
        CHECK ((source = 'local' AND path IS NOT NULL AND yt_video_id IS NULL) OR (source = 'youtube' AND yt_video_id IS NOT NULL AND path IS NULL)));
      CREATE TABLE library_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
      CREATE TABLE playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE playlist_items (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, position INTEGER NOT NULL, track_id TEXT NOT NULL REFERENCES tracks(id), added_at INTEGER NOT NULL);
      CREATE TABLE play_history (track_id TEXT NOT NULL, played_at INTEGER NOT NULL, context TEXT);
      INSERT INTO tracks (id, source, yt_video_id, title, artist, added_at) VALUES ('yt:abcdefghijk', 'youtube', 'abcdefghijk', 'Ancien morceau YouTube', 'Test', 1);
      INSERT INTO playlists (name, created_at, updated_at) VALUES ('Playlist v1', 1, 1);
      INSERT INTO playlist_items VALUES (1, 0, 'yt:abcdefghijk', 1);
      PRAGMA user_version = 1;`);
    db.close();
  }

  ({ app, win } = await launch(profile));
  const v1 = await api(() => window.chud.playlists.list());
  t.check('migration v1→v2 keeps existing playlists', v1.length === 1 && v1[0].name === 'Playlist v1' && v1[0].count === 1);
  t.check('backup written before migrating', existsSync(join(profile, 'backups')) && readdirSync(join(profile, 'backups')).some((n) => n.startsWith('chud-v1-')));
  const v1d = await api(() => window.chud.playlists.get(1));
  t.check('YouTube entry kept as a YouTube track (no path)', v1d.tracks[0].source === 'youtube' && !v1d.tracks[0].path && v1d.tracks[0].videoId === 'abcdefghijk');

  // ── library scan ──
  // every album shown here (the fixtures' albums are small: hidden by default since 0.6)
  await api(() => window.chud.settings.set({ hideSmallAlbums: false }));
  await win.reload(); // the interface reads the settings at start
  await win.waitForSelector('.nav-item');
  await api((p) => window.chud.library.addFolder(p), lib);
  const scanMs = await waitScanIdle(win);
  await gotoNav(win, 'Bibliothèque');
  await sleep(500);
  t.check('folder scanned: 6 tracks listed', (await rows().count()) === 6, `${scanMs} ms`);
  t.check('covers shown in the list', (await win.locator('.page .tl-body .t-thumb img').count()) >= 4);

  await win.locator('.search input').fill('cassettes');
  await sleep(400);
  t.check('search (by artist, case/accents-insensitive)', JSON.stringify((await rowTitles()).sort()) === JSON.stringify(['Boulevard des Ondes', 'Minuit Chrome']));
  await win.locator('.search input').fill('lumieres');
  await sleep(400);
  t.check('search ignores accents (lumieres → Lumières 2003)', JSON.stringify(await rowTitles()) === JSON.stringify(['Verre Bleu']));
  await win.locator('.search input').fill('');
  await win.locator('.tl-head .tl-cell:has-text("Durée")').click();
  await sleep(300);
  const byDur = await rowTitles();
  t.check('sort by duration', byDur[0] === 'Sans Tags' && byDur[byDur.length - 1] === 'Fractale', byDur.join(', '));
  await win.locator('.segmented button:has-text("Albums")').click();
  await sleep(300);
  t.check('albums view groups tracks', (await win.locator('.album-card').count()) === 4);
  await win.locator('.album-card:has-text("Néon Boulevard")').click();
  await sleep(400);
  t.check('album drill-down in track order', JSON.stringify(await rowTitles()) === JSON.stringify(['Minuit Chrome', 'Boulevard des Ondes']));
  await win.locator('.chip.drill').click();
  await win.locator('.segmented button:has-text("Titres")').click();
  await win.locator('.tl-head .tl-cell:has-text("Durée")').click(); // desc
  await win.locator('.tl-head .tl-cell:has-text("Durée")').click(); // off → default order
  await sleep(300);

  // ── playlists through the UI ──
  await rows().filter({ hasText: 'Minuit Chrome' }).click({ button: 'right' });
  await win.locator('.menu-item:has-text("Ajouter à une playlist")').hover();
  await win.locator('.menu .menu .menu-item:has-text("Nouvelle playlist")').click();
  await win.locator('.dialog input').fill('Soirée');
  await win.locator('.dialog button[type=submit]').click();
  await sleep(600);
  // the same track again + two others, through the context menu of a multi-selection
  await rows().filter({ hasText: 'Minuit Chrome' }).locator('.t-title').click();
  await rows().filter({ hasText: 'Fractale' }).locator('.t-title').click({ modifiers: ['Control'] });
  await rows().filter({ hasText: 'Verre Bleu' }).locator('.t-title').click({ modifiers: ['Control'] });
  await rows().filter({ hasText: 'Verre Bleu' }).click({ button: 'right' });
  await win.locator('.menu-item:has-text("Ajouter à une playlist")').hover();
  await win.locator('.menu .menu .menu-item:has-text("Soirée")').click();
  await sleep(600);
  await showPlaylists(win);
  await win.locator('.side-item:has-text("Soirée")').click();
  await sleep(600);
  let titles = await rowTitles();
  t.check('playlist created and filled from the context menu', titles.length === 4, titles.join(', '));
  t.check('same track can appear twice in a playlist', titles.filter((x) => x === 'Minuit Chrome').length === 2);
  t.check('count and duration shown', /4 morceaux/.test(await win.locator('.list-hero-stats').innerText()));

  // drag & drop reorder: move the 3rd entry to the top (compared by entry id, not title)
  const entries = async () => (await api(() => window.chud.playlists.list().then((l) => window.chud.playlists.get(l.find((p) => p.name === 'Soirée').id)))).tracks.map((x) => x.entryId);
  const beforeDrag = await entries();
  await rows().nth(2).dragTo(rows().nth(0), { targetPosition: { x: 200, y: 4 } });
  await sleep(800);
  const afterDrag = await entries();
  titles = await rowTitles();
  t.check('drag & drop reorders the playlist', JSON.stringify(afterDrag) === JSON.stringify([beforeDrag[2], beforeDrag[0], beforeDrag[1], beforeDrag[3]]), titles.join(', '));
  const orderAfterDrag = titles;

  // Delete key removes the selected entry (only that entry, not its duplicate)
  await rows().nth(1).locator('.t-title').click();
  const removed = (await rowTitles())[1];
  await win.keyboard.press('Delete');
  await sleep(600);
  titles = await rowTitles();
  t.check('Delete removes exactly one entry', titles.length === 3 && JSON.stringify(titles) === JSON.stringify(orderAfterDrag.filter((_, i) => i !== 1)), `removed ${removed}: ${orderAfterDrag.join('|')} → ${titles.join('|')}`);

  // rename (double-click on the title)
  await win.locator('.list-hero-title').dblclick();
  await win.locator('.dialog input').fill('Soirée électro');
  await win.locator('.dialog button[type=submit]').click();
  await sleep(500);
  t.check('rename', (await win.locator('.side-item:has-text("Soirée électro")').count()) === 1 && (await win.locator('.tab:has-text("Soirée électro")').count()) === 1);

  // ── queue: "play next" goes before the rest of the context ──
  await rows().nth(0).locator('.t-title').dblclick();
  await sleep(1200);
  const playing = await npTitle(win);
  await gotoNav(win, 'Bibliothèque');
  await rows().filter({ hasText: 'Média Classique' }).click({ button: 'right' });
  await win.locator('.menu-item:has-text("Lire ensuite")').click();
  await win.locator('button[aria-label="File d’attente"]').click();
  await sleep(500);
  t.check('queue panel lists the queued track', (await win.locator('.queue .q-row:has-text("Média Classique")').count()) === 1);
  await win.screenshot({ path: join(shots, '10-queue.png') });
  await win.locator('button[aria-label="Suivant"]').click();
  await sleep(2500);
  t.check('"Lire ensuite" plays before the rest of the playlist', (await npTitle(win)) === 'Média Classique', `${playing} → ${await npTitle(win)}`);
  await win.locator('button[aria-label="Suivant"]').click();
  await sleep(1500);
  const ctxAfter = await npTitle(win);
  t.check('then the playlist continues where it was', ctxAfter === orderAfterDrag.filter((_, i) => i !== 1)[1], ctxAfter);
  await win.locator('button[aria-label="Fermer la file d’attente"]').click();

  // ── watcher: new file appears, moved file is followed by the playlist, deleted file leaves ──
  copyFileSync(join(music, 'Fractale.flac'), join(lib, 'Albums', 'Fractale (copie).flac'));
  await sleep(2500);
  await waitScanIdle(win);
  t.check('new file detected by the watcher', (await api(() => window.chud.library.tracks())).length === 7);
  mkdirSync(join(lib, 'Rangé'));
  renameSync(join(lib, 'Albums', 'Verre Bleu (ALAC).m4a'), join(lib, 'Rangé', 'Verre Bleu.m4a'));
  await sleep(2500);
  await waitScanIdle(win);
  const pl = await api(() => window.chud.playlists.list().then((l) => window.chud.playlists.get(l.find((p) => p.name === 'Soirée électro').id)));
  const vb = pl.tracks.find((x) => x.title === 'Verre Bleu');
  t.check('moved file: playlist follows it to its new path', vb && vb.available && vb.path.includes('Rangé'), vb?.path);
  unlinkSync(join(lib, 'Albums', 'Fractale (copie).flac'));
  await sleep(2500);
  await waitScanIdle(win);
  t.check('deleted file leaves the library', (await api(() => window.chud.library.tracks())).length === 6);

  // a play counts once really listened to (30 s, or half of a short track): Sans Tags is 25 s
  await gotoNav(win, 'Bibliothèque');
  await rows().filter({ hasText: 'Sans Tags' }).locator('.t-title').dblclick();
  await sleep(14000);
  t.check('play counted after listening long enough', (await api(() => window.chud.library.recentlyPlayed(10))).some((x) => x.title === 'Sans Tags'));

  // ── persistence ──
  const before = await api(() => window.chud.playlists.list().then((l) => window.chud.playlists.get(l.find((p) => p.name === 'Soirée électro').id)));
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(1000);
  const after = await api(() => window.chud.playlists.list().then((l) => window.chud.playlists.get(l.find((p) => p.name === 'Soirée électro').id)));
  t.check('playlist and its custom order survive a restart', JSON.stringify(after.tracks.map((x) => x.entryId)) === JSON.stringify(before.tracks.map((x) => x.entryId)));
  t.check('queue is temporary (empty after restart)', (await api(() => document.querySelectorAll('.count-dot').length)) === 0);
  t.check('listening history survives a restart', (await api(() => window.chud.library.recentlyPlayed(10))).some((x) => x.title === 'Sans Tags'));

  // ── delete with confirmation closes its tab ──
  await win.locator('.side-item:has-text("Soirée électro")').click();
  await sleep(500);
  await win.locator('button[aria-label="Plus d’actions"]').click();
  await win.locator('.menu-item:has-text("Supprimer")').click();
  await win.locator('.dialog button[type=submit]').click();
  await sleep(800);
  t.check('delete playlist (after confirmation) closes its tab', (await win.locator('.tab:has-text("Soirée électro")').count()) === 0 && (await api(() => window.chud.playlists.list())).length === 1);
  t.check('audio files untouched by playlist deletion', existsSync(join(lib, 'Albums', '01 - Minuit Chrome.mp3')));
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'library-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
  process.exit(t.finish() ? 1 : 0);
}
