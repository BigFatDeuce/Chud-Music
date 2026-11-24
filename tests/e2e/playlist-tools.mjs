// Playlists: sorting by column, "Find duplicates…", a link pasted into an empty playlist.
// Home: "Remove from Recently played / Recently added" (right-click), sections hidden from
// Settings › Home, the big centred clock in every skin. Library: the "#" column shows a
// 6-digit number whole (142527 used to read "42527").
// Offline, except the link import itself: CHUD_ONLINE=1 also fills a playlist from a Spotify album.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanup, createSuite, gotoNav, launch, music, shots, showPlaylists, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('playlist-tools');
const profile = tempDir('chud-pltools-');
const big = tempDir('chud-pltools-big-');
let app, win;
const tracks = () => win.evaluate(() => window.chud.library.tracks());
const titles = () => win.locator('.page .tl-body .tl-row .t-title').allInnerTexts();
const yt = (videoId, title, artist, durationSec) => ({ id: `yt:${videoId}`, source: 'youtube', videoId, title, artist, album: null, durationSec, coverUrl: null, available: true });
const shelf = (name) => win.locator(`.section-title:has-text("${name}") + .shelf .shelf-item`);
const openPlaylist = async (name) => {
  await showPlaylists(win);
  await win.locator(`.side-item:has-text("${name}")`).click();
  await sleep(600);
};
const plMenu = async (item) => {
  await win.locator('.list-hero-actions button[aria-label="Plus d’actions"]').click();
  await win.locator(`.menu-item:has-text("${item}")`).click();
};

try {
  // ── a library, two plays in the history
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  const lib = await tracks();
  await app.close();
  const byTitle = (s) => lib.find((x) => x.title === s);
  const [minuit, boulevard, verre] = ['Minuit Chrome', 'Boulevard des Ondes', 'Verre Bleu'].map((s) => lib.find((x) => x.title.startsWith(s)));
  {
    const db = new DatabaseSync(join(profile, 'chud.db'));
    const now = Date.now();
    for (const [x, at] of [[minuit, now - 60_000], [boulevard, now - 30_000]]) {
      db.prepare('INSERT INTO play_history (track_id, played_at, context) VALUES (?, ?, ?)').run(x.id, at, 'test');
      db.prepare('UPDATE tracks SET last_played_at = ?, play_count = play_count + 1 WHERE id = ?').run(at, x.id);
    }
    db.close();
  }

  ({ app, win } = await launch(profile));
  await sleep(800);

  // ── Home › Recently played › right-click › Remove from "Recently played"
  t.check('Home: two recently played', (await shelf('Écoutés récemment').count()) === 2);
  await shelf('Écoutés récemment').first().click({ button: 'right' });
  const rp = win.locator('.menu-item:has-text("Retirer de « Écoutés récemment »")');
  t.check('…right-click offers "Retirer de « Écoutés récemment »"', (await rp.count()) === 1);
  await win.screenshot({ path: join(shots, 'pltools-01-recent-menu.png') });
  await rp.click();
  await sleep(700);
  t.check('…the track leaves the shelf', (await shelf('Écoutés récemment').count()) === 1);
  const hist = await win.evaluate(() => window.chud.stats.get('all'));
  t.check('…the history (stats) keeps both plays', JSON.stringify(hist).includes('"plays":2') || hist.plays === 2, `plays ${hist.plays}`);
  t.check('…the library keeps the track', (await tracks()).length === lib.length);

  // ── Home › Recently added
  const added0 = await shelf('Ajoutés récemment').count();
  await shelf('Ajoutés récemment').first().click({ button: 'right' });
  await win.locator('.menu-item:has-text("Retirer de « Ajoutés récemment »")').click();
  await sleep(700);
  t.check('Home: "Retirer de « Ajoutés récemment »" takes one out', (await shelf('Ajoutés récemment').count()) === added0 - 1, `${added0} → ${await shelf('Ajoutés récemment').count()}`);

  // ── Library › the same views
  await gotoNav(win, 'Bibliothèque');
  await win.locator('.chip:has-text("Ajoutés récemment")').click();
  await sleep(500);
  const inAdded = (await titles()).length;
  t.check('Library › Ajoutés récemment: the one taken out is not there', inAdded === added0 - 1, `${inAdded}`);
  await win.locator('.page .tl-body .tl-row').first().locator('.t-title').click();
  await win.locator('.page .tl-body .tl-row').first().click({ button: 'right' });
  const libItem = win.locator('.menu-item:has-text("Retirer de « Ajoutés récemment »")');
  t.check('…its right-click says "Retirer de « Ajoutés récemment »" (not "from the library")', (await libItem.count()) === 1 && (await win.locator('.menu-item:has-text("bibliothèque")').count()) === 0);
  await libItem.click();
  await sleep(600);
  t.check('…one less', (await titles()).length === inAdded - 1);
  await win.locator('.chip:has-text("Écoutés récemment")').click();
  await sleep(500);
  t.check('Library › Écoutés récemment: one left', (await titles()).length === 1);
  await win.locator('.chip:has-text("Tout")').first().click();
  await sleep(500);
  t.check('Library › Tout: every track still there', (await titles()).length === lib.length);
  await app.close();

  // after a restart: still out, and played again = back in
  ({ app, win } = await launch(profile));
  await gotoNav(win, 'Accueil');
  await sleep(500);
  const rs = [await shelf('Écoutés récemment').count(), await shelf('Ajoutés récemment').count()];
  t.check('after a restart: still taken out', rs[0] === 1 && rs[1] === added0 - 2, `played ${rs[0]}, added ${rs[1]}`);
  await app.close();
  {
    const db = new DatabaseSync(join(profile, 'chud.db'));
    db.prepare('INSERT INTO play_history (track_id, played_at, context) VALUES (?, ?, ?)').run(boulevard.id, Date.now(), 'test');
    db.prepare('UPDATE tracks SET last_played_at = ? WHERE id = ?').run(Date.now(), boulevard.id);
    db.close();
  }
  ({ app, win } = await launch(profile));
  await gotoNav(win, 'Accueil');
  await sleep(500);
  const back2 = await shelf('Écoutés récemment').allInnerTexts();
  t.check('a track taken out and played again comes back', back2.length === 2, back2.map((x) => x.split('\n')[0]).join(' | '));

  // ── Settings › Home: sections hidden
  await gotoNav(win, 'Paramètres');
  const homeRows = await win.locator('[data-home]').count();
  t.check('Settings › Accueil: 5 sections', homeRows === 5);
  for (const k of ['keyboard', 'random', 'shortcuts']) await win.locator(`[data-home=${k}] button:has-text("Masquée")`).click();
  await win.locator('.settings-group:has([data-home])').screenshot({ path: join(shots, 'pltools-02-settings-home.png') });
  await gotoNav(win, 'Accueil');
  const heads = await win.locator('.section-title').allInnerTexts();
  t.check('Home: Clavier, Au hasard, Raccourcis hidden; the others shown', !heads.some((h) => /Clavier|Au hasard|Raccourcis/.test(h)) && heads.some((h) => h.includes('Écoutés récemment')) && heads.some((h) => h.includes('Ajoutés récemment')), heads.join(' | '));
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(600);
  t.check('…kept after a restart', !(await win.locator('.section-title').allInnerTexts()).some((h) => h.includes('Clavier')));
  await gotoNav(win, 'Paramètres');
  for (const k of ['keyboard', 'random', 'shortcuts']) await win.locator(`[data-home=${k}] button:has-text("Affichée")`).click();
  await gotoNav(win, 'Accueil');
  t.check('…and shown again', (await win.locator('.section-title:has-text("Clavier")').count()) === 1);

  // ── the clock: big and centred, every skin
  const skins = await (async () => {
    await gotoNav(win, 'Paramètres');
    return win.locator('.skin-card').count();
  })();
  for (let i = 0; i < skins; i++) {
    await gotoNav(win, 'Paramètres');
    await win.locator('.skin-card').nth(i).click();
    const name = await win.locator('.skin-card').nth(i).locator('b').innerText();
    await gotoNav(win, 'Accueil');
    await sleep(500);
    const m = await win.evaluate(() => {
      const hero = document.querySelector('.home-hero').getBoundingClientRect();
      const lcd = document.querySelector('.hero-lcd').getBoundingClientRect();
      const clock = document.querySelector('.hero-lcd .clock');
      const others = [...document.querySelectorAll('.home-hero-main > *')].map((e) => e.getBoundingClientRect());
      return {
        off: Math.abs(lcd.top + lcd.height / 2 - (hero.top + hero.height / 2)),
        right: hero.right - lcd.right,
        width: Math.round(hero.width),
        stacked: lcd.bottom <= document.querySelector('.home-hero-main').getBoundingClientRect().top + 1,
        hoff: Math.abs(lcd.left + lcd.width / 2 - (hero.left + hero.width / 2)),
        size: parseFloat(getComputedStyle(clock).fontSize),
        inside: lcd.left >= hero.left && lcd.right <= hero.right,
        overlap: others.some((o) => o.right > lcd.left + 1 && o.left < lcd.right - 1 && o.top < lcd.bottom - 1 && o.bottom > lcd.top + 1),
        clipped: clock.scrollWidth > clock.clientWidth + 1,
      };
    });
    t.check(`clock (${name}): on the right, centred top to bottom, ≥ 56 px, nothing over it`, (m.stacked ? m.hoff < 3 : m.off < 3 && m.right < 60) && m.size >= 56 && m.inside && !m.overlap && !m.clipped, JSON.stringify(m));
    await win.locator('.home-hero').screenshot({ path: join(shots, `pltools-03-clock-${i}.png`) });
  }
  // a narrow window: still there, still inside
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 700));
  await sleep(500);
  const narrow = await win.evaluate(() => {
    const hero = document.querySelector('.home-hero').getBoundingClientRect();
    const lcd = document.querySelector('.hero-lcd')?.getBoundingClientRect();
    const main = document.querySelector('.home-hero-main').getBoundingClientRect();
    if (!lcd) return { shown: false };
    // either beside the text on the right, or on its own line above it, centred
    const right = lcd.left >= main.right - 1 && hero.right - lcd.right < 60;
    const above = lcd.bottom <= main.top + 1 && Math.abs(lcd.left + lcd.width / 2 - (hero.left + hero.width / 2)) < 3;
    return { shown: lcd.width > 0, inside: lcd.left >= hero.left && lcd.right <= hero.right, placed: right ? 'right' : above ? 'above' : 'wrong', width: Math.round(hero.width) };
  });
  t.check('narrow window: the clock stays, inside the box', narrow.shown && narrow.inside && narrow.placed !== 'wrong', JSON.stringify(narrow));
  await win.locator('.home-hero').screenshot({ path: join(shots, 'pltools-04-clock-narrow.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
  await gotoNav(win, 'Paramètres');
  await win.locator('.skin-card').first().click();

  // ── playlist: sort by column, back to its own order
  const order = [verre, minuit, boulevard];
  await win.evaluate((e) => window.chud.playlists.create('Trier', e), order);
  await openPlaylist('Trier');
  const own = await titles();
  await win.locator('[role=columnheader].tl-title').click();
  await sleep(300);
  const asc = await titles();
  await win.locator('[role=columnheader].tl-title').click();
  await sleep(300);
  const desc = await titles();
  await win.locator('[role=columnheader].tl-title').click();
  await sleep(300);
  const back = await titles();
  const sortedAsc = [...own].sort((a, b) => a.localeCompare(b, 'fr'));
  t.check('playlist: Titre sorts A→Z', asc.join() === sortedAsc.join(), asc.join(' | '));
  t.check('…then Z→A', desc.join() === [...sortedAsc].reverse().join(), desc.join(' | '));
  t.check('…then the playlist’s own order', back.join() === own.join(), back.join(' | '));
  await win.locator('[role=columnheader].tl-artist').click();
  await sleep(300);
  t.check('…Artiste sorts too', (await win.locator('[role=columnheader].tl-artist.sorted').count()) === 1);
  const pid = await win.evaluate(() => window.chud.playlists.list().then((l) => l.find((p) => p.name === 'Trier').id));
  const before = (await win.evaluate((id) => window.chud.playlists.get(id), pid)).tracks.map((x) => x.title);
  t.check('…sorting never rewrites the playlist', before.join() === own.join());

  // ── duplicates
  const entries = [minuit, boulevard, minuit, yt('d1', 'Minuit Chrome', 'Les Cassettes', minuit.durationSec), yt('d2', 'minuit chrome', 'les cassettes', 999), verre, boulevard];
  const did = await win.evaluate((e) => window.chud.playlists.create('Doublons', e), entries);
  await openPlaylist('Doublons');
  await plMenu('Trouver les doublons');
  await win.locator('.dialog').waitFor({ timeout: 3000 });
  const text = await win.locator('.dialog').innerText();
  t.check('duplicates: asks first, counts 3', /Retirer 3 doublons/.test(text), text.replace(/\s+/g, ' ').slice(0, 160));
  await win.screenshot({ path: join(shots, 'pltools-05-dupes.png') });
  await win.locator('.dialog button:has-text("Annuler")').click();
  await sleep(300);
  t.check('…"Annuler" leaves the playlist alone', (await win.evaluate((id) => window.chud.playlists.get(id), did)).tracks.length === 7);
  await plMenu('Trouver les doublons');
  await win.locator('.dialog button[type=submit]').click();
  await sleep(800);
  const left = (await win.evaluate((id) => window.chud.playlists.get(id), did)).tracks.map((x) => `${x.source}:${x.title}${x.durationSec === 999 ? '(999)' : ''}`);
  t.check('…removed: the first of each stays, a far longer version is not a duplicate', left.length === 4 && left[0] === `local:${minuit.title}` && left.some((x) => x.includes('(999)')), left.join(' | '));
  t.check('…a toast counts them', (await win.locator('.toast:has-text("3 doublons retirés")').count()) >= 1);
  await plMenu('Trouver les doublons');
  await sleep(500);
  t.check('…again: "Aucun doublon"', (await win.locator('.toast:has-text("Aucun doublon")').count()) >= 1 && (await win.locator('.dialog').count()) === 0);
  t.check('the library is unchanged', (await tracks()).length === lib.length);
  t.check('every file knows its average bit rate (the best copy of a duplicate is kept)', (await tracks()).every((x) => x.bitrateKbps > 0), (await tracks()).map((x) => `${x.codec}:${x.bitrateKbps}`).join(', '));

  // ── an empty playlist: paste a link
  await win.evaluate(() => window.chud.playlists.create('Vide', []));
  const eid = await win.evaluate(() => window.chud.playlists.list().then((l) => l.find((p) => p.name === 'Vide').id));
  await openPlaylist('Vide');
  const field = win.locator('.pl-link input');
  t.check('empty playlist: a field to paste a link', (await field.count()) === 1 && /Spotify/.test(await field.getAttribute('placeholder')));
  await win.locator('.page .empty').screenshot({ path: join(shots, 'pltools-06-empty-link.png') });
  await field.fill('https://www.deezer.com/fr/playlist/123');
  await field.press('Enter');
  await sleep(400);
  t.check('…an unsupported link: said so, nothing added', (await win.locator('.toast:has-text("n’est pas reconnu")').count()) >= 1 && (await win.evaluate((id) => window.chud.playlists.get(id), eid)).tracks.length === 0);
  if (process.env.CHUD_ONLINE) {
    await field.fill('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    await field.press('Enter');
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000 && !(await win.locator('.toast:has-text("ajouté")').count())) await sleep(500);
    const got = (await win.evaluate((id) => window.chud.playlists.get(id), eid)).tracks;
    t.check('online: a Spotify album fills the empty playlist (YouTube Music tracks)', got.length > 5 && got.every((x) => x.source === 'youtube'), `${got.length} tracks in ${Math.round((Date.now() - t0) / 1000)} s`);
    await win.screenshot({ path: join(shots, 'pltools-07-link-done.png') });
  }
  await app.close();


  // ── a library of 142,527 tracks: the "#" column shows the last number whole
  ({ app, win } = await launch(big));
  await app.close();
  {
    const db = new DatabaseSync(join(big, 'chud.db'));
    db.exec('BEGIN');
    const ins = db.prepare("INSERT INTO tracks (id, source, path, title, artist, album, duration_sec, codec, available, added_at, in_library) VALUES (?, 'local', ?, ?, 'Artiste', 'Album', 180, 'mp3', 1, ?, 1)");
    for (let i = 1; i <= 142527; i++) ins.run(`big${i}`, `Z:\\big\\${i}.mp3`, `Titre ${String(i).padStart(6, '0')}`, 1_600_000_000_000 + i);
    db.exec('COMMIT');
    db.close();
  }
  ({ app, win } = await launch(big, []));
  await gotoNav(win, 'Bibliothèque');
  await win.locator('[role=columnheader].tl-title').click();
  await sleep(800);
  await win.evaluate(() => (document.querySelector('.page').scrollTop = 1e12));
  await sleep(1200);
  const last = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.page .tl-body .tl-row')];
    const r = rows[rows.length - 1];
    const n = r?.querySelector('.tl-num');
    return n ? { text: n.innerText.trim(), whole: n.scrollWidth <= n.clientWidth + 1, title: r.querySelector('.t-title')?.innerText } : null;
  });
  t.check('142 527 tracks: the last row reads "142527", whole', last?.text?.includes('142527') && last.whole, JSON.stringify(last));
  await win.screenshot({ path: join(shots, 'pltools-08-big-library.png') });
} catch (e) {
  t.check('no crash', false, String(e?.stack ?? e));
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, big);
  t.finish();
}
