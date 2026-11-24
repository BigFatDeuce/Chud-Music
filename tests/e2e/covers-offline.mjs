// "Find missing covers" when the catalogues do not help (no network needed: CHUD_TEST_COVERS
// answers in their place): out of reach → the search stops and says so, nothing is marked "?";
// "too many requests" → they rest, and the search gives up after three albums nobody could be
// asked about, again without marking anything; they answer and know nothing → the "?" picture.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, sleep, tempDir } from './harness.mjs';
import { mp3 } from './gen-library.mjs';

const t = createSuite('covers-offline');
const profile = tempDir('chud-covers-off-');
const lib = tempDir('chud-covers-off-lib-');
let app, win;

for (let a = 1; a <= 5; a++) {
  mkdirSync(join(lib, `Album ${a}`), { recursive: true });
  writeFileSync(join(lib, `Album ${a}`, '01.mp3'), mp3({ title: `Piste ${a}`, artist: `Artiste ${a}`, album: `Album ${a}`, track: 1 }));
  writeFileSync(join(lib, `Album ${a}`, '02.mp3'), mp3({ title: `Autre ${a}`, artist: `Artiste ${a}`, album: `Album ${a}`, track: 2 }));
}
const mode = (m, rest = '') => app.evaluate((_e, [m, rest]) => { process.env.CHUD_TEST_COVERS = m; process.env.CHUD_TEST_COVERS_REST_MS = rest; }, [m, rest]);
const search = async (timeout = 30000) => {
  await win.evaluate(() => void window.chud.library.findCovers());
  const t0 = Date.now();
  let st;
  await sleep(150);
  while (Date.now() - t0 < timeout) {
    st = await win.evaluate(() => window.chud.library.coverStatus());
    if (!st.running) break;
    await sleep(150);
  }
  return { ...st, ms: Date.now() - t0 };
};
const covers = async () => (await win.evaluate(() => window.chud.library.tracks())).map((x) => x.coverUrl).filter(Boolean);

try {
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await sleep(2500);
  await gotoNav(win, 'Bibliothèque');
  t.check('10 files without cover', (await win.evaluate(() => window.chud.library.tracks())).length === 10 && (await covers()).length === 0);

  await mode('offline');
  let st = await search();
  t.check('catalogues out of reach: the search stops by itself', !st.running && st.done === 0, `${st.ms} ms, done ${st.done}/${st.total}`);
  t.check('…and says why, in the interface language', st.error === 'Les services de pochettes sont injoignables (hors ligne ?)', String(st.error));
  t.check('…nothing is marked "?"', st.saved === 0 && st.none === 0 && (await covers()).length === 0);

  await mode('busy', '300');
  st = await search();
  t.check('"too many requests": gives up after three albums nobody could be asked about', !st.running && st.done === 2 && !!st.error, `${st.ms} ms, done ${st.done}/${st.total}, ${st.error}`);
  t.check('…after letting the catalogues rest, not at once', st.ms >= 600, `${st.ms} ms`);
  t.check('…nothing is marked "?" either', st.saved === 0 && (await covers()).length === 0);

  // a search can be stopped while the catalogues rest
  await mode('busy', '5000');
  await win.evaluate(() => void window.chud.library.findCovers());
  await sleep(600);
  const running = (await win.evaluate(() => window.chud.library.coverStatus())).running;
  await win.evaluate(() => window.chud.library.cancelCovers());
  await sleep(1500);
  st = await win.evaluate(() => window.chud.library.coverStatus());
  t.check('"stop" ends a search that is waiting', running && !st.running && !st.error, JSON.stringify(st));

  await mode('empty', '300');
  await sleep(5200); // the rests asked above are over
  st = await search();
  t.check('catalogues that know nothing: every album gets the "?" picture, no error', !st.running && !st.error && st.none === 5 && st.saved === 10, JSON.stringify(st));
  t.check('…shown on the tracks', (await covers()).length === 10 && (await covers()).every((u) => /found%2Funknown\.svg/.test(u)));
  st = await search();
  t.check('the "?" ones are looked for again by the next search', st.total === 5 && st.none === 5);
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
}
process.exit(t.finish() ? 1 : 0);
