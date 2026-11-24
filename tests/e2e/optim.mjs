// 0.9 optimisations: cover thumbnails made in the background (never while a request waits),
// network folders checked periodically instead of watched, lighter effects by default on a modest
// PC, a play that does not reload the whole library, and the player snapshot reduced to the
// position when the queue has not changed.
import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, sleep, tempDir, waitScanIdle } from './harness.mjs';
import { generateLibrary } from './gen-library.mjs';

const t = createSuite('optim');
const dirs = [];
const temp = (p) => {
  const d = tempDir(p);
  dirs.push(d);
  return d;
};
let app, win;

/** Counts calls of some ipcMain.handle channels (wraps the registered handlers). */
async function spy(channels) {
  return app.evaluate(({ ipcMain }, channels) => {
    const h = ipcMain._invokeHandlers;
    if (!h) return false;
    globalThis.__calls = Object.fromEntries(channels.map((c) => [c, 0]));
    for (const c of channels) {
      const orig = h.get(c);
      if (!orig) continue;
      h.set(c, (...a) => {
        globalThis.__calls[c]++;
        return orig(...a);
      });
    }
    return true;
  }, channels);
}
const calls = () => app.evaluate(() => globalThis.__calls);

try {
  // ── 1. thumbnails: the original at once, the small copy made afterwards ──
  {
    const profile = temp('chud-opt-a-');
    const lib = temp('chud-opt-lib-');
    generateLibrary(lib, { artists: 2, albums: 2, tracks: 3, coverPx: 1200 });
    ({ app, win } = await launch(profile));
    await win.evaluate((p) => window.chud.library.addFolder(p), lib);
    await waitScanIdle(win);
    const cover = await win.evaluate(async () => (await window.chud.library.tracks()).find((x) => x.coverUrl?.startsWith('chud-media://cover/'))?.coverUrl);
    const get = (u) => win.evaluate(async (u) => {
      const t0 = performance.now();
      const n = (await (await fetch(u)).arrayBuffer()).byteLength;
      return { n, ms: performance.now() - t0 };
    }, u);
    const full = await get(cover);
    const first = await get(`${cover}?s=200`);
    t.check('first request for a small copy answers with the original, without waiting for a resize', first.n === full.n, `${first.n} bytes in ${first.ms.toFixed(0)} ms (original ${full.n})`);
    await sleep(1500);
    const second = await get(`${cover}?s=200`);
    t.check('…the small copy is made in the background and served next time', second.n > 0 && second.n < full.n / 2, `${second.n} bytes in ${second.ms.toFixed(0)} ms`);
    const thumbs = readdirSync(join(profile, 'Cache', 'thumbs'));
    t.check('…kept in the app cache', thumbs.some((f) => f.startsWith('200-')), thumbs.join(', '));
    const width = (u) => win.evaluate((u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i.naturalWidth); i.onerror = () => r(-1); i.src = u; }), u);
    const w1 = await width(`${cover}?s=1024&n=1`);
    await sleep(1000);
    const w2 = await width(`${cover}?s=1024&n=2`);
    t.check('a 1024 px copy of a 1200 px cover: the original first, then the copy', w1 === 1200 && w2 === 1024, `${w1} px, then ${w2} px`);

    // ── 4. a play updates its row and "recently played" without reloading the library ──
    await app.close();
    ({ app, win } = await launch(temp('chud-opt-e-')));
    await win.evaluate((p) => window.chud.library.addFolder(p), music);
    await waitScanIdle(win);
    await gotoNav(win, 'Bibliothèque');
    await sleep(500);
    const spying = await spy(['library:tracks', 'library:recently-played', 'player:save', 'player:save-position']);
    if (!spying) console.log('INFO  ipcMain internals not reachable: IPC counts skipped');
    await win.locator('.page .tl-body .tl-row:has-text("Minuit Chrome") .t-title').first().dblclick();
    // 40 s track: the play counts after 20 s; the snapshot is saved every 10 s
    await sleep(22500);
    const c = spying ? await calls() : null;
    const played = await win.evaluate(async () => (await window.chud.library.tracks()).filter((x) => x.playCount > 0).length);
    t.check('the play is counted', played >= 1, `${played} track(s) with plays`);
    if (c) {
      t.check('…without reloading the whole library', c['library:tracks'] === 0, JSON.stringify(c));
      t.check('…"recently played" alone refreshed', c['library:recently-played'] >= 1);
      t.check('snapshot: the queue sent once, then only the position', c['player:save'] === 1 && c['player:save-position'] >= 2);
    }
    await win.locator('.segmented button:has-text("Titres")').click().catch(() => {});
    await win.locator('button:has-text("Écoutés récemment")').click();
    await sleep(500);
    t.check('"Écoutés récemment" lists it', (await win.locator('.page .tl-body .tl-row').count()) >= 1);
    await app.close();
    app = null;
  }

  // ── 2. network folders: no watcher, checked periodically ──
  {
    const profile = temp('chud-opt-b-');
    const lib = temp('chud-opt-net-');
    copyFileSync(join(music, '01 - Minuit Chrome.mp3'), join(lib, 'a.mp3'));
    process.env.CHUD_TEST_NETWORK_FOLDERS = '1';
    process.env.CHUD_NETWORK_POLL_MS = '4000';
    ({ app, win } = await launch(profile));
    delete process.env.CHUD_TEST_NETWORK_FOLDERS;
    delete process.env.CHUD_NETWORK_POLL_MS;
    await win.evaluate((p) => window.chud.library.addFolder(p), lib);
    await waitScanIdle(win);
    const st = await win.evaluate(() => window.chud.library.status());
    t.check('a network folder is scanned once added', (await win.evaluate(() => window.chud.library.tracks())).length === 1);
    t.check('…but not watched', st.watching === false);
    copyFileSync(join(music, 'Fractale.flac'), join(lib, 'b.flac'));
    let n = 1;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && n < 2) {
      await sleep(500);
      n = (await win.evaluate(() => window.chud.library.tracks())).length;
    }
    t.check('…a new file there is picked up by the periodic check', n === 2, `${((Date.now() - t0) / 1000).toFixed(1)} s (every 4 s here, 60 min in real use)`);
    await app.close();
    app = null;
  }

  // ── 3. modest PC: lighter effects by default, the user's choice wins ──
  {
    const profile = temp('chud-opt-c-');
    process.env.CHUD_LOW_END = '1';
    ({ app, win } = await launch(profile));
    const eff = await win.evaluate(() => document.documentElement.dataset.effects);
    t.check('modest PC: effects start "reduced"', eff === 'reduced', eff);
    await win.evaluate(() => window.chud.settings.set({ effects: 'full' }));
    await app.close();
    ({ app, win } = await launch(profile));
    const eff2 = await win.evaluate(() => document.documentElement.dataset.effects);
    t.check('…a choice made in Settings is kept', eff2 === 'full', eff2);
    await app.close();
    delete process.env.CHUD_LOW_END;
    process.env.CHUD_LOW_END = '0';
    ({ app, win } = await launch(temp('chud-opt-d-')));
    t.check('other PCs: full effects', (await win.evaluate(() => document.documentElement.dataset.effects)) === 'full');
    delete process.env.CHUD_LOW_END;
  }
} catch (e) {
  t.check('no crash', false, String(e?.stack ?? e));
} finally {
  await app?.close().catch(() => {});
  cleanup(...dirs);
  t.finish();
}
