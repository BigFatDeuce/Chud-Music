// Library › … › Find missing covers / Remove found covers (online: real YouTube Music lookups).
// The pictures go to Chud Music's own cache, never into the music folders: the folders and the
// files are checked byte for byte before and after.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, sleep, tempDir } from './harness.mjs';
import { mp3, png } from './gen-library.mjs';

const t = createSuite('covers');
const profile = tempDir('chud-covers-');
const lib = tempDir('chud-covers-lib-');
let app, win;

// a real album, a real artist with an album that does not exist, nobody at all, and a file
// that has its own cover (never searched, never changed)
const files = [
  ['Daft Punk/Discovery/01.mp3', { title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', track: 1 }],
  ['Daft Punk/Discovery/03.mp3', { title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', track: 3 }],
  ['Stromae/Album fantome/01.mp3', { title: 'Piste qui n existe pas', artist: 'Stromae', album: 'Zqxw Fantome Inexistant 4471', track: 1 }],
  ['Stromae/Album fantome/02.mp3', { title: 'Autre piste absente', artist: 'Stromae', album: 'Zqxw Fantome Inexistant 4471', track: 2 }],
  ['Inconnu/Rien/01.mp3', { title: 'Vprrkt Zlomb', artist: 'Qlorbex Vantrudil Xyzzq', album: 'Xxyqz Wvvblr 9931', track: 1 }],
  ['Inconnu/Rien/02.mp3', { title: 'Vprrkt Zlomb II', artist: 'Qlorbex Vantrudil Xyzzq', album: 'Xxyqz Wvvblr 9931', track: 2 }],
  ['Avec/Pochette/01.mp3', { title: 'One More Time', artist: 'Daft Punk', album: 'Ma pochette', track: 1, cover: png(64, 64, [200, 30, 30]) }],
];
for (const [rel, tags] of files) {
  mkdirSync(join(lib, rel, '..'), { recursive: true });
  writeFileSync(join(lib, rel), mp3(tags));
}

/** Every file under the music folder: path, size, mtime and content hash. */
function snapshot() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${relative(lib, p)}|${statSync(p).size}|${statSync(p).mtimeMs}|${createHash('sha1').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(lib);
  return out.sort().join('\n');
}
const before = snapshot();
const foundDir = join(profile, 'Cache', 'covers', 'found');
const byTitle = async () => Object.fromEntries((await win.evaluate(() => window.chud.library.tracks())).map((x) => [`${x.album}|${x.title}`, x.coverUrl]));
const menu = async () => {
  await win.locator('.lib-actions button[aria-label="Plus d’actions"]').click();
  await sleep(200);
};

try {
  ({ app, win } = await launch(profile));
  // these albums are small (hidden from the grid by default)
  await win.evaluate(() => window.chud.settings.set({ hideSmallAlbums: false }));
  await win.reload();
  await win.waitForSelector('.nav-item');
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await sleep(2500);
  await gotoNav(win, 'Bibliothèque');
  const c0 = await byTitle();
  t.check('7 files scanned, only the one with its own cover has one', Object.keys(c0).length === 7 && Object.values(c0).filter(Boolean).length === 1);

  await menu();
  t.check('menu: remove is disabled while nothing was found', (await win.locator('.menu-item:has-text("Supprimer les pochettes trouvées (0)")').isDisabled()) === true);
  await win.locator('.menu-item:has-text("Trouver les pochettes manquantes")').click();
  const t0 = Date.now();
  await sleep(300);
  const pill = (await win.locator('.scan-pill:has-text("Pochettes")').count()) === 1;
  const early = await win.evaluate(() => window.chud.library.coverStatus());
  t.check('progress shown in the header while searching', pill || !early.running);
  let st;
  while (Date.now() - t0 < 120000) {
    st = await win.evaluate(() => window.chud.library.coverStatus());
    if (!st.running) break;
    await sleep(500);
  }
  t.check('search finished without error', st && !st.running && !st.error, st?.error ?? `${((Date.now() - t0) / 1000).toFixed(1)} s, ${st?.album} album, ${st?.artist} artist, ${st?.none} "?"`);
  await sleep(800);
  const c1 = await byTitle();
  const isFound = (u) => /cover\/found%2F[0-9a-f]+\.jpg/.test(u ?? '');
  t.check('real album: its cover found, for every track', isFound(c1['Discovery|One More Time']) && c1['Discovery|One More Time'] === c1['Discovery|Digital Love'], c1['Discovery|One More Time']);
  t.check('unknown album of a known artist: the artist picture', isFound(c1['Zqxw Fantome Inexistant 4471|Piste qui n existe pas']) && c1['Zqxw Fantome Inexistant 4471|Piste qui n existe pas'] !== c1['Discovery|One More Time'], c1['Zqxw Fantome Inexistant 4471|Piste qui n existe pas']);
  t.check('nothing found: the "?" picture', /found%2Funknown\.svg/.test(c1['Xxyqz Wvvblr 9931|Vprrkt Zlomb'] ?? ''), c1['Xxyqz Wvvblr 9931|Vprrkt Zlomb']);
  t.check('a file with its own cover keeps it', c1['Ma pochette|One More Time'] === c0['Ma pochette|One More Time']);
  const ok = await win.evaluate(async (u) => {
    const r = await fetch(u);
    return r.ok && (r.headers.get('content-type') ?? '').startsWith('image/');
  }, c1['Discovery|One More Time']);
  t.check('found pictures are served to the interface', ok);
  t.check('pictures kept in Chud Music’s cache', existsSync(foundDir) && readdirSync(foundDir).filter((f) => f.endsWith('.jpg')).length >= 2, readdirSync(foundDir).join(', '));
  t.check('music folders and files untouched (byte for byte, no new file)', snapshot() === before);

  await win.locator('.segmented button:has-text("Albums")').click();
  await sleep(600);
  t.check('albums view shows the found covers', (await win.locator('.album-card img[src*="found"]').count()) >= 2);

  // ── they survive a rescan and a restart ──
  await win.evaluate(() => window.chud.library.rescan());
  await sleep(2000);
  await app.close();
  ({ app, win } = await launch(profile));
  await sleep(1500);
  const c2 = await byTitle();
  t.check('found covers kept after a rescan and a restart', c2['Discovery|One More Time'] === c1['Discovery|One More Time'] && c2['Xxyqz Wvvblr 9931|Vprrkt Zlomb'] === c1['Xxyqz Wvvblr 9931|Vprrkt Zlomb']);

  // ── remove them all ──
  await gotoNav(win, 'Bibliothèque');
  await menu();
  const rm = win.locator('.menu-item:has-text("Supprimer les pochettes trouvées (6)")');
  t.check('menu: remove the 6 found covers', (await rm.count()) === 1);
  await rm.click();
  await sleep(300);
  t.check('asks first, and says music files are not touched', /vos fichiers et dossiers de musique ne sont pas touchés/.test(await win.locator('.dialog').innerText()));
  await win.locator('.dialog button[type=submit]').click();
  await sleep(1200);
  const c3 = await byTitle();
  t.check('every found cover gone, the file’s own cover kept', Object.values(c3).filter(Boolean).length === 1 && c3['Ma pochette|One More Time'] === c0['Ma pochette|One More Time']);
  t.check('their pictures deleted from the cache', !existsSync(foundDir) || readdirSync(foundDir).length === 0, existsSync(foundDir) ? readdirSync(foundDir).join(', ') : '');
  t.check('music folders still untouched', snapshot() === before);
} catch (e) {
  t.check('covers run', false, e.message);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
}
process.exit(t.finish() ? 1 : 0);
