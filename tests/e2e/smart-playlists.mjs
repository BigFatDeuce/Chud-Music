// Smart playlists and playlist pictures, "Recently played" (10 tracks, clear all). Offline.
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync, crc32 } from 'node:zlib';
import { cleanup, createSuite, gotoNav, launch, music, shots, showPlaylists, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('smart-playlists');
const profile = tempDir('chud-smart-');
const lib = tempDir('chud-smart-lib-');
const pics = tempDir('chud-smart-pics-');
let app, win;
const DAY = 86_400_000;
const tracks = () => win.evaluate(() => window.chud.library.tracks());
const list = () => win.evaluate(() => window.chud.playlists.list());
const detail = (id) => win.evaluate((id) => window.chud.playlists.get(id), id);
const titles = () => win.locator('.page .tl-body .tl-row .t-title').allInnerTexts();
const menu = (label) => win.locator(`.menu-item:has-text("${label}")`).first();
const wav = () => {
  const n = 8000;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
};
/** A 64 × 64 red PNG. */
const png = () => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(64, 0);
  head.writeUInt32BE(64, 4);
  head[8] = 8;
  head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, Buffer.from([200, 30, 60]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(Array(64).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
};
/** The file the next file dialog answers with. */
const pick = (path) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: !p, filePaths: p ? [p] : [] }); }, path);
const waitFor = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(120);
  }
  return false;
};
const named = async (name) => (await list()).find((p) => p.name === name);

try {
  copyFileSync(join(music, '01 - Minuit Chrome.mp3'), join(lib, 'Minuit.mp3'));
  copyFileSync(join(music, '02 - Boulevard des Ondes.mp3'), join(lib, 'Boulevard.mp3'));
  copyFileSync(join(music, 'Fractale.flac'), join(lib, 'Fractale.flac'));
  for (let i = 1; i <= 12; i++) writeFileSync(join(lib, `Piste ${String(i).padStart(2, '0')}.wav`), wav());
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await waitScanIdle(win);
  await app.close();
  {
    // a past: played at different times
    const db = new DatabaseSync(join(profile, 'chud.db'));
    const now = Date.now();
    const up = db.prepare('UPDATE tracks SET added_at = ?, last_played_at = ?, play_count = ? WHERE title = ?');
    up.run(now - 400 * DAY, now - 300 * DAY, 2, 'Piste 01');
    up.run(now - 400 * DAY, now - 800 * DAY, 9, 'Piste 02');
    up.run(now - 400 * DAY, now - 5 * DAY, 40, 'Piste 03');
    up.run(now - 400 * DAY, null, 0, 'Piste 04');
    db.close();
  }
  ({ app, win } = await launch(profile));
  await sleep(800);
  const all = await tracks();
  t.check('library: 15 tracks', all.length === 15, String(all.length));

  // ── ready-made ones, from the Playlists page
  const openMenu = async () => {
    await gotoNav(win, 'Playlists');
    await win.locator('[data-new-smart]').click();
    await sleep(300);
  };
  const create = async (...path) => {
    await openMenu();
    for (const p of path) {
      if (p === path.at(-1)) await menu(p).click();
      else await menu(p).hover();
      await sleep(400);
    }
    await sleep(700);
  };
  await openMenu();
  const offered = await win.locator('.menu-item').allInnerTexts();
  const ready = ['Jamais écoutés', 'Redécouverte', 'Ajouts récents', 'Les plus écoutés'];
  t.check('four ready-made ones are offered', ready.every((x) => offered.some((o) => o.includes(x))), offered.join(' | '));
  await win.keyboard.press('Escape');
  await sleep(200);
  await create(ready[0]);
  t.check('"Never played": the twelve never played', (await titles()).length === 12 && !(await titles()).includes('Piste 03'), String((await titles()).length));
  await win.screenshot({ path: join(shots, 'smart-01-never.png') });
  await create(ready[1], '1 an');
  t.check('"Rediscover", one year: the one not played since', (await titles()).join() === 'Piste 02', (await titles()).join());
  await create(ready[1], '6 mois');
  t.check('"Rediscover", six months: the longest forgotten first', (await titles()).join() === 'Piste 02,Piste 01', (await titles()).join());
  await create(ready[2]);
  t.check('"Recently added": the last 30 days', (await titles()).length === 11 && !(await titles()).includes('Piste 04'), String((await titles()).length));
  await create(ready[3]);
  t.check('"Most played": by number of plays', (await titles()).join() === 'Piste 03,Piste 02,Piste 01', (await titles()).join());

  // ── they follow by themselves
  const p5 = all.find((x) => x.title === 'Piste 05');
  await win.evaluate((x) => window.chud.history.record(x, 'test'), p5);
  t.check('a play: the track leaves "Never played" by itself', await waitFor(async () => (await named(ready[0])).count === 11));
  t.check('…and enters the open "Most played"', await waitFor(async () => (await titles()).includes('Piste 05')));
  copyFileSync(join(music, 'Verre Bleu (ALAC).m4a'), join(lib, 'Verre.m4a'));
  t.check('a file added to the folder enters "Recently added"', await waitFor(async () => (await named(ready[2])).count === 12, 20000));

  // ── one's own rules, in the editor
  await openMenu();
  await win.locator('.menu-item').last().click();
  await sleep(500);
  const dlg = win.locator('.smart-dialog');
  await dlg.locator('label.field input').fill('Mes pistes');
  const fill = async (i, field, op, value) => {
    const r = dlg.locator('.smart-rule').nth(i);
    await r.locator('select').first().selectOption(field);
    await r.locator('select').nth(1).selectOption(op);
    if (value !== undefined) await r.locator('.smart-value input').fill(String(value));
  };
  await fill(0, 'title', 'contains', 'piste');
  await dlg.locator('[data-smart-add="rules"]').click();
  await fill(1, 'plays', 'lte', 9);
  await dlg.locator('[data-smart-add="exclude"]').click();
  await fill(2, 'title', 'is', 'PISTE 12');
  const order = dlg.locator('.smart-rule').last();
  await order.locator('select').first().selectOption('title');
  await order.locator('select').nth(1).selectOption('desc');
  await order.locator('input').fill('5');
  await sleep(800);
  t.check('the preview counts them', (await dlg.locator('[data-smart-count]').getAttribute('data-smart-count')) === '5');
  await win.screenshot({ path: join(shots, 'smart-02-editor.png') });
  await dlg.locator('button[type=submit]').click();
  await sleep(900);
  t.check('several rules, an exclusion, an order and a limit', (await titles()).join() === 'Piste 11,Piste 10,Piste 09,Piste 08,Piste 07', (await titles()).join());
  // a track taken out by hand
  await win.locator('.page .tl-body .tl-row').first().click({ button: 'right' });
  await sleep(300);
  const out = win.locator('.menu-item').filter({ hasText: /xclure/ }).first();
  t.check('a track can be excluded by hand', (await out.count()) === 1, (await win.locator('.menu-item').allInnerTexts()).join(' | '));
  await out.click();
  t.check('…the next one takes its place', await waitFor(async () => (await titles()).join() === 'Piste 10,Piste 09,Piste 08,Piste 07,Piste 06'), (await titles()).join());
  // changed afterwards
  await win.locator('.list-hero-actions .btn.ghost').first().click();
  await sleep(500);
  t.check('its rules can be changed; what was excluded by hand is said', (await dlg.locator('.smart-note').count()) === 1);
  await dlg.locator('.smart-note button').click();
  await dlg.locator('.smart-rule').last().locator('input').fill('');
  await dlg.locator('button[type=submit]').click();
  t.check('…no limit, and nothing excluded by hand any more', await waitFor(async () => (await titles()).length === 10), String((await titles()).length));
  const mine = await named('Mes pistes');
  const refused = await win.evaluate(([id, x]) => window.chud.playlists.addTracks(id, [x]).then(() => null, (e) => e.message), [mine.id, all[0]]);
  t.check('nothing can be added to it by hand', !!refused && (await detail(mine.id)).tracks.length === 10);

  // ── export
  const file = join(pics, 'all.json');
  await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, file);
  await win.evaluate(() => window.chud.playlists.exportAll());
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const exp = doc.playlists.find((p) => p.name === 'Mes pistes');
  t.check('exported: its rules, and its tracks for the readers that do not know them', doc.format === 'chud-music-playlists' && doc.version === 1 && exp.smart?.rules.length === 2 && exp.tracks.length === 10);

  // ── pictures
  const image = join(pics, 'a.png');
  writeFileSync(image, png());
  writeFileSync(join(pics, 'fake.png'), 'not a picture');
  const plain = await win.evaluate((x) => window.chud.playlists.create('Simple', x), all.slice(0, 3));
  await gotoNav(win, 'Playlists');
  await sleep(500);
  const card = win.locator('.playlist-card:has-text("Simple")');
  const files = () => readdirSync(join(profile, 'playlist-covers'));
  const change = async (where) => {
    await where.click({ button: 'right' });
    await sleep(300);
    await menu('Changer l').click();
  };
  const coverOf = async () => (await list()).find((p) => p.id === plain).cover;
  await pick(image);
  await change(card);
  t.check('Playlists page, right-click: the picture changes', await waitFor(async () => (await coverOf()) !== null));
  await sleep(800);
  t.check('…and is drawn', (await card.locator('img').first().evaluate((i) => i.naturalWidth)) > 0 && (await card.locator('img').first().getAttribute('src')).includes('playlist-cover'));
  await win.screenshot({ path: join(shots, 'smart-03-cover.png') });
  t.check('…from a copy of its own', files().length === 1 && existsSync(image), files().join());
  await card.click();
  await sleep(800);
  const hero = win.locator('.list-hero-cover');
  t.check('the open playlist shows it', (await hero.locator('img').first().getAttribute('src')).includes('playlist-cover'));
  await hero.click({ button: 'right' });
  await sleep(300);
  const items = await win.locator('.menu-item').allInnerTexts();
  await win.locator('.menu-item').filter({ hasText: /image/ }).nth(1).click();
  t.check('open playlist, right-click on the picture: back to the covers of its tracks', await waitFor(async () => (await coverOf()) === null && files().length === 0), items.join(' | '));
  await pick(join(pics, 'fake.png'));
  await change(hero);
  t.check('a file that is not a picture is refused, and it is said', (await waitFor(async () => (await win.locator('.toast').allInnerTexts()).some((x) => /image/i.test(x)))) && (await coverOf()) === null);
  await pick(image);
  await showPlaylists(win);
  await change(win.locator('.side-item:has-text("Simple")'));
  t.check('sidebar, right-click: the picture changes too', await waitFor(async () => (await coverOf()) !== null));
  await win.evaluate(([id, p]) => window.chud.playlists.setCover(id, p), [mine.id, image]); // a smart one too
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(1000);
  t.check('both are there after a restart', (await list()).filter((p) => p.cover).length === 2 && files().length === 2);
  await win.evaluate((id) => window.chud.playlists.remove(id), plain);
  t.check('a deleted playlist takes its copy along, not the picture it came from', files().length === 1 && existsSync(image), files().join());

  // ── "Recently played": 10, the oldest leaves; clear all
  const now = await tracks();
  for (const x of now.slice(0, 13)) await win.evaluate((x) => window.chud.history.record(x, 'test'), x);
  const recent = await win.evaluate(() => window.chud.library.recentlyPlayed(1000));
  t.check('"Recently played" holds the last 10', recent.length === 10 && recent[0].title === now[12].title && recent.at(-1).title === now[3].title, String(recent.length));
  await win.evaluate(() => window.chudTest.library.getState().reloadTracks()); // (counted behind the interface's back)
  await gotoNav(win, 'Accueil');
  await sleep(700);
  const shelf = win.locator('.section-title:has-text("Écoutés récemment") + .shelf .shelf-item');
  t.check('…on Home too', (await shelf.count()) === 10, String(await shelf.count()));
  await win.locator('[data-clear-recent]').first().click();
  await sleep(700);
  t.check('"Clear all": nothing left there', (await shelf.count()) === 0 && (await win.evaluate(() => window.chud.library.recentlyPlayed(1000))).length === 0);
  const stats = await win.evaluate(() => window.chud.stats.get('all'));
  t.check('…the listening statistics keep every play', stats.plays >= 13, String(stats.plays));
  await win.evaluate((x) => window.chud.history.record(x, 'test'), now[0]);
  await sleep(600);
  t.check('…and a new play shows again', (await win.evaluate(() => window.chud.library.recentlyPlayed(1000))).length === 1);
} catch (e) {
  t.check('no unexpected error', false, e.stack ?? String(e));
  await win?.screenshot({ path: join(shots, 'smart-error.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib, pics);
}
process.exit(t.finish() ? 1 : 0);
