// Large library: 4 000 files in 200 folders. Measures scan time, rescan time, virtualization,
// scroll smoothness, search latency and memory. Needs ffmpeg (generates its own files).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('perf');
const profile = tempDir('chud-perf-');
const lib = tempDir('chud-perf-lib-');
const seeds = tempDir('chud-perf-seeds-');
const N_SEEDS = 20, ARTISTS = 40, ALBUMS = 5, PER_ALBUM = 20; // 4 000 files
let app, win;

try {
  for (let i = 0; i < N_SEEDS; i++) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${200 + i * 20}:duration=2`, '-b:a', '32k',
      '-metadata', `title=Morceau ${i}`, '-metadata', `artist=Seed ${i}`, join(seeds, `s${i}.mp3`)]);
  }
  let n = 0;
  for (let a = 0; a < ARTISTS; a++) {
    for (let b = 0; b < ALBUMS; b++) {
      const dir = join(lib, `Artiste ${a}`, `Album ${b}`);
      mkdirSync(dir, { recursive: true });
      for (let k = 0; k < PER_ALBUM; k++) copyFileSync(join(seeds, `s${n++ % N_SEEDS}.mp3`), join(dir, `${String(k + 1).padStart(2, '0')} - Piste ${n}.mp3`));
    }
  }
  console.log(`INFO  generated ${n} files`);

  ({ app, win } = await launch(profile));
  const t0 = Date.now();
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await waitScanIdle(win, 300000);
  const scanMs = Date.now() - t0;
  const count = (await win.evaluate(() => window.chud.library.tracks())).length;
  t.check(`first scan of ${n} files`, count === n, `${(scanMs / 1000).toFixed(1)} s (${Math.round(n / (scanMs / 1000))} fichiers/s)`);

  const t1 = Date.now();
  await win.evaluate(() => window.chud.library.rescan());
  await waitScanIdle(win, 120000);
  t.check('rescan with nothing changed is fast (stat only)', Date.now() - t1 < 15000, `${((Date.now() - t1) / 1000).toFixed(1)} s`);

  await gotoNav(win, 'Bibliothèque');
  await sleep(800);
  const domRows = await win.locator('.page .tl-body .tl-row').count();
  t.check('list is virtualized (few DOM rows for thousands of tracks)', domRows < 80, `${domRows} rows in the DOM for ${count} tracks`);

  // scroll the whole list and record frame times
  const frames = await win.evaluate(async () => {
    const page = document.querySelector('.page');
    const times = [];
    let last = performance.now();
    let running = true;
    const tick = (now) => { times.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const step = page.scrollHeight / 120;
    for (let i = 0; i < 120; i++) { page.scrollTop += step; await new Promise((r) => requestAnimationFrame(r)); }
    running = false;
    times.sort((a, b) => a - b);
    return { p50: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] };
  });
  t.check('scrolling stays smooth (95th percentile frame < 33 ms)', frames.p95 < 33, `p50 ${frames.p50.toFixed(1)} ms, p95 ${frames.p95.toFixed(1)} ms, max ${frames.max.toFixed(1)} ms`);

  const searchMs = await win.evaluate(async () => {
    const input = document.querySelector('.search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const t0 = performance.now();
    setter.call(input, 'seed 19'); // 200 of the 4 000 tracks carry this artist tag
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (/^200 morceaux/.test(document.querySelector('.page-sub')?.textContent ?? '')) return performance.now() - t0;
    }
    return -1;
  });
  t.check('search result in under 300 ms', searchMs > 0 && searchMs < 300, `${searchMs.toFixed(0)} ms`);

  const m = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ type: x.type, mb: Math.round(x.memory.workingSetSize / 1024) })));
  console.log(`INFO  memory with ${count} tracks loaded (idle): ${m.reduce((s, x) => s + x.mb, 0)} MB — ${m.map((x) => `${x.type}:${x.mb}`).join(', ')}`);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib, seeds);
  process.exit(t.finish() ? 1 : 0);
}
