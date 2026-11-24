// Very large libraries: the app with N tracks in its database (files themselves are not needed to
// browse). Measures what a person would wait for, and what it costs in memory.
//   node tests/e2e/big-library.mjs [tracks=100000]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, shots, sleep, tempDir } from './harness.mjs';

const N = Number(process.argv[2]) || 100_000;
const t = createSuite(`big-library ${N}`);
const profile = tempDir('chud-big-');
let app, win;
const ms = (x) => `${Math.round(x)} ms`;

function fill() {
  const db = new DatabaseSync(join(profile, 'chud.db'));
  db.exec('BEGIN');
  db.prepare('INSERT INTO library_folders (path, added_at, scan) VALUES (?, ?, 0)').run('Z:\\Musique', 1);
  const ins = db.prepare(`INSERT INTO tracks (id, source, path, file_size, mtime_ms, title, artist, album, album_artist, duration_sec, codec, cover_ref, available, added_at, last_played_at, play_count, in_library, track_no, disc_no, year, genre)
    VALUES (?, 'local', ?, 30000000, 1700000000000, ?, ?, ?, ?, ?, 'FLAC', NULL, 1, ?, ?, ?, 1, ?, 1, ?, ?)`);
  const genres = ['Rock', 'Jazz', 'Électro', 'Classique', 'Hip-hop', 'Folk'];
  const words = ['Lune', 'Nuit', 'Vent', 'Étoile', 'Rivière', 'Soleil', 'Forêt', 'Océan', 'Orage', 'Hiver'];
  const now = Date.now();
  for (let i = 0; i < N; i++) {
    const artist = `Artiste ${String(Math.floor(i / 120)).padStart(5, '0')}`;
    const album = `Album ${words[Math.floor(i / 12) % 10]} ${Math.floor(i / 12) % 10}`;
    const path = `Z:\\Musique\\${artist}\\${album}\\${String((i % 12) + 1).padStart(2, '0')} - ${words[i % 10]} ${i}.flac`;
    ins.run(`local:${path.toLowerCase()}`, path, `${words[i % 10]} ${words[(i * 7) % 10]} ${i}`, artist, album, artist, 120 + (i % 300), now - i * 60_000, i % 3 ? now - i * 400_000 : null, i % 3 ? i % 50 : 0, (i % 12) + 1, 1960 + (i % 65), genres[Math.floor(i / 12) % 6]);
  }
  db.exec('COMMIT');
  db.close();
}

/** Longest time the interface stays without answering while `fn` runs (its frames are watched). */
async function freeze(fn) {
  await win.evaluate(() => {
    window.__max = 0;
    window.__on = true;
    let last = performance.now();
    const f = () => {
      const now = performance.now();
      window.__max = Math.max(window.__max, now - last);
      last = now;
      if (window.__on) setTimeout(f, 0);
    };
    f();
  });
  const t0 = performance.now();
  await fn();
  const total = performance.now() - t0;
  const max = await win.evaluate(() => {
    window.__on = false;
    return window.__max;
  });
  return { total, max };
}
/** The same for the main process. */
const mainFreeze = async (fn) => {
  await app.evaluate(() => {
    globalThis.__m = 0;
    globalThis.__l = performance.now();
    globalThis.__i = setInterval(() => {
      const n = performance.now();
      globalThis.__m = Math.max(globalThis.__m, n - globalThis.__l);
      globalThis.__l = n;
    }, 5);
  });
  await fn();
  return app.evaluate(() => {
    clearInterval(globalThis.__i);
    return globalThis.__m;
  });
};
const memory = () => app.evaluate(({ app }) => Object.fromEntries(app.getAppMetrics().filter((m) => m.type === 'Browser' || m.type === 'Tab').map((m) => [m.type, Math.round(m.memory.workingSetSize / 1024)])));

try {
  const e0 = performance.now();
  ({ app, win } = await launch(profile));
  const emptyBar = performance.now() - e0;
  const empty = await (async () => (await sleep(3000), memory()))();
  await app.close();
  const f0 = performance.now();
  fill();
  console.log(`      database of ${N} tracks written in ${ms(performance.now() - f0)}`);

  const t0 = performance.now();
  ({ app, win } = await launch(profile));
  const bar = performance.now() - t0;
  await win.waitForFunction((n) => window.chudTest?.library?.getState().tracks.length === n, N, { timeout: 60_000, polling: 50 });
  const loaded = performance.now() - t0;
  t.check('the window is up without waiting for the library', bar < emptyBar + 2000 + N / 50, `${ms(bar)} (empty library: ${ms(emptyBar)})`);
  t.check('the whole library is there', loaded < emptyBar + 3000 + N / 10, ms(loaded));
  await sleep(2500);
  const full = await memory();
  console.log(`      memory (MB): ${JSON.stringify(empty)} empty → ${JSON.stringify(full)}`);
  t.check('memory of the interface: under 2 KB per track', (full.Tab - empty.Tab) * 1024 < Math.max(120 * 1024, N * 2), `${full.Tab - empty.Tab} MB`);

  const open = await freeze(async () => {
    await gotoNav(win, 'Bibliothèque');
    await win.waitForSelector('.page .tl-row', { timeout: 30_000 });
  });
  t.check('Library opens', open.max < 2500, `${ms(open.total)}, longest freeze ${ms(open.max)}`);
  await win.screenshot({ path: join(shots, `big-library-${N}.png`) });
  const search = await freeze(async () => {
    await win.locator('.lib-toolbar .search input').fill('etoile 4242');
    await sleep(1500);
  });
  const found = await win.locator('.page-sub').first().innerText();
  t.check('searching', search.max < 1500, `longest freeze ${ms(search.max)} — ${found.split('\n')[0]}`);
  await win.locator('.lib-toolbar .search input').fill('');
  await sleep(1500);
  const sort = await freeze(async () => {
    await win.locator('button:has-text("Durée"), [role=columnheader]:has-text("Durée")').first().click();
    await sleep(1800);
  });
  t.check('sorting', sort.max < 2000, `longest freeze ${ms(sort.max)}`);
  const albums = await freeze(async () => {
    await win.locator('.lib-toolbar [role=tab]:has-text("Albums")').click();
    await win.waitForSelector('.album-card', { timeout: 30_000 });
  });
  t.check('Albums', albums.max < 2500, `${ms(albums.total)}, longest freeze ${ms(albums.max)}`);
  await win.locator('.lib-toolbar [role=tab]').first().click();
  await sleep(1500);

  // one play counted, and one library change: the cost of the everyday
  const oneTrack = await win.evaluate(() => window.chudTest.library.getState().tracks[500]);
  const play = await freeze(async () => {
    await win.evaluate((x) => window.chud.history.record(x, 'test'), oneTrack);
    await sleep(2500);
  });
  t.check('a play counted', play.max < 300, `longest freeze ${ms(play.max)}`);
  let change;
  const mainMax = await mainFreeze(async () => {
    change = await freeze(async () => {
      await win.evaluate((x) => window.chud.library.removeTracks([x.id]), oneTrack);
      await sleep(4000);
    });
  });
  t.check('one track leaves the library: the interface stays fluid', change.max < 700 + N / 150, `longest freeze ${ms(change.max)}`);
  t.check('…and so does the main process', mainMax < 400 + N / 150, ms(mainMax));
  await win.evaluate((x) => window.chud.library.restoreTracks([x.id]), oneTrack);

  // smart playlists over the whole library
  let smart;
  const smartMax = await mainFreeze(async () => {
    smart = await win.evaluate(async () => {
      const a = performance.now();
      const p = await window.chud.playlists.previewSmart({ match: 'all', rules: [{ field: 'genre', op: 'contains', value: 'electro' }, { field: 'artist', op: 'contains', value: 'artiste 000' }], exclude: [{ field: 'title', op: 'contains', value: 'hiver' }], excludeIds: [], order: 'plays', desc: true, limit: 200 });
      return { ms: performance.now() - a, n: p.count };
    });
  });
  t.check('a smart playlist query', smart.ms < 1500 + N / 100, `${ms(smart.ms)}, ${smart.n} tracks, main process held ${ms(smartMax)}`);

  // play everything, shuffled: the snapshot stays small
  const all = await freeze(async () => {
    await win.evaluate(() => {
      const list = window.chudTest.library.getState().tracks;
      window.chudTest.settings.getState().set({ shuffle: true });
      const p = window.chudTest.player.getState();
      p.enqueue([]);
      window.chudTest.player.setState({ ctx: { tabId: 'section:library', label: 'Tout', tracks: list, order: list.map((_, i) => i), pos: 3 }, current: list[3] });
    });
    await sleep(3000);
  });
  t.check('a queue of the whole library', all.max < 1200, `longest freeze ${ms(all.max)}`);
  await app.close();
  const db = new DatabaseSync(join(profile, 'chud.db'));
  const size = db.prepare("SELECT LENGTH(value) AS n FROM kv WHERE key = 'player'").get()?.n ?? 0;
  db.close();
  t.check('…is saved in a few bytes per track', size > 0 && size / N < 160, `${(size / 1024 / 1024).toFixed(1)} MB, ${Math.round(size / N)} bytes each`);
  const r0 = performance.now();
  ({ app, win } = await launch(profile));
  const back = await win.evaluate(() => window.chudTest.player.getState().current?.title ?? null);
  t.check('the next start does not wait for it: the track is there', performance.now() - r0 < emptyBar + 3000 + N / 50 && !!back, ms(performance.now() - r0));
  await win.waitForFunction((n) => window.chudTest?.player.getState().ctx?.tracks.length >= n - 1, N, { timeout: 60_000 });
  t.check('…and comes back at the next start', (await win.evaluate(() => window.chudTest.player.getState().ctx.pos)) === 3);
} catch (e) {
  t.check('no unexpected error', false, e.stack ?? String(e));
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
}
process.exit(t.finish() ? 1 : 0);
