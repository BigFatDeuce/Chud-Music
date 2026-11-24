// Before/after measurement on a big library (not a pass/fail suite). Run it once with
// CHUD_EXE pointing at the old build, once without (current build), on the same files:
//   BENCH_LIB=<dir> node tests/e2e/bench.mjs
// Measures: first scan, a rescan with nothing changed, the main process's longest stall and its
// total stalled time (event-loop lag > 50 ms) during each, the interface's long tasks (> 50 ms)
// during the scan and while a play is counted, and the memory at the end.
import { existsSync } from 'node:fs';
import { cleanup, launch, music, sleep, tempDir, waitScanIdle, gotoNav } from './harness.mjs';
import { generateLibrary } from './gen-library.mjs';

const lib = process.env.BENCH_LIB;
const [A, B, T] = (process.env.BENCH_SIZE ?? '500,10,4').split(',').map(Number);
if (!existsSync(`${lib}/.done`)) {
  const n = generateLibrary(lib, { artists: A, albums: B, tracks: T, coverPx: 600 });
  (await import('node:fs')).writeFileSync(`${lib}/.done`, String(n));
}
const profile = tempDir('chud-bench-');
const out = {};
const { app, win } = await launch(profile);
try {
  // main process: event-loop lag sampler
  await app.evaluate(() => {
    const s = (globalThis.__lag = { max: 0, total: 0 });
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const lag = now - last - 20;
      if (lag > 50) {
        s.total += lag;
        s.max = Math.max(s.max, lag);
      }
      last = now;
    }, 20);
  });
  const lag = async (reset = true) => app.evaluate((_e, reset) => {
    const r = { ...globalThis.__lag };
    if (reset) Object.assign(globalThis.__lag, { max: 0, total: 0 });
    return r;
  }, reset);
  // interface: long tasks
  await win.evaluate(() => {
    const s = (window.__lt = { n: 0, total: 0, max: 0 });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        s.n++;
        s.total += e.duration;
        s.max = Math.max(s.max, e.duration);
      }
    }).observe({ entryTypes: ['longtask'] });
  });
  const lt = () => win.evaluate(() => {
    const r = { ...window.__lt };
    Object.assign(window.__lt, { n: 0, total: 0, max: 0 });
    return r;
  });
  await gotoNav(win, 'Bibliothèque');
  await lag();
  await lt();

  let t0 = Date.now();
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await sleep(1000);
  await waitScanIdle(win, 1_800_000);
  out.scanSec = (Date.now() - t0) / 1000;
  out.scanTracks = (await win.evaluate(() => window.chud.library.tracks())).length;
  out.scanMainLag = await lag();
  out.scanUiLongTasks = await lt();
  await sleep(3000);
  await lag();
  await lt();

  t0 = Date.now();
  await win.evaluate(() => window.chud.library.rescan());
  await waitScanIdle(win, 1_800_000);
  out.rescanSec = (Date.now() - t0) / 1000;
  out.rescanMainLag = await lag();
  out.rescanUiLongTasks = await lt();

  // a play being counted (the old build reloaded the whole library then)
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win, 120000);
  await sleep(2000);
  await win.locator('input[type="search"], .search input').first().fill('Minuit Chrome').catch(() => {});
  await sleep(800);
  await lag();
  await lt();
  await win.locator('.page .tl-body .tl-row:has-text("Minuit Chrome") .t-title').first().dblclick();
  await sleep(23000);
  out.playMainLag = await lag();
  out.playUiLongTasks = await lt();
  out.playCounted = await win.evaluate(async () => (await window.chud.library.tracks()).some((x) => x.title === 'Minuit Chrome' && x.playCount > 0));
  const mem = await app.evaluate(({ app }) => app.getAppMetrics().reduce((a, m) => a + m.memory.workingSetSize, 0));
  out.memoryMB = Math.round(mem / 1024);
} catch (e) {
  out.error = String(e?.stack ?? e);
} finally {
  await app.close().catch(() => {});
  cleanup(profile);
}
const r = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])) : o);
for (const [k, v] of Object.entries(out)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(r(v)) : v}`);
