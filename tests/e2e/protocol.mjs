// The chud-media:// protocol in the real app: byte ranges as Chromium
// and other clients send them, and only files the app opened are served. The page asks with
// fetch(); the answers are compared with the file read from disk.
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, launch, music, sleep, tempDir } from './harness.mjs';

const t = createSuite('protocol');
const profile = tempDir('chud-proto-');
const files = tempDir('chud-proto-files-');
let app, win;

try {
  const path = join(files, 'Range test.mp3');
  copyFileSync(join(music, '01 - Minuit Chrome.mp3'), path);
  const bytes = readFileSync(path);
  const size = bytes.length;
  ({ app, win } = await launch(profile, [path]));
  await win.waitForFunction(() => document.querySelectorAll('.page .tl-body .tl-row').length === 1, null, { timeout: 15000 });
  await sleep(1000);
  const ask = (p, range) =>
    win.evaluate(async ({ p, range }) => {
      const url = `chud-media://file/${encodeURIComponent(p)}`;
      try {
        const r = await fetch(url, { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(5000) });
        const b = new Uint8Array(await r.arrayBuffer());
        return { status: r.status, length: b.length, first: Array.from(b.slice(0, 4)), contentRange: r.headers.get('content-range') };
      } catch (e) {
        return { error: String(e) };
      }
    }, { p, range });
  const same = (r, from, to) => r.length === to - from + 1 && r.first.join() === Array.from(bytes.subarray(from, from + 4)).join();

  let r = await ask(path, null);
  t.check('whole file: 200, every byte', r.status === 200 && same(r, 0, size - 1), JSON.stringify(r));
  r = await ask(path, 'bytes=100-199');
  t.check('one range: 206 and exactly those bytes', r.status === 206 && same(r, 100, 199) && r.contentRange === `bytes 100-199/${size}`, JSON.stringify(r));
  r = await ask(path, 'bytes=-50');
  t.check('the last bytes (suffix)', r.status === 206 && same(r, size - 50, size - 1), JSON.stringify(r));
  r = await ask(path, `bytes=${size}-`);
  t.check('past the end: 416 with the size', r.status === 416 && r.contentRange === `bytes */${size}`, JSON.stringify(r));
  r = await ask(path, 'bytes=8-2');
  t.check('a reversed range: the whole file, not an error', r.status === 200 && same(r, 0, size - 1), JSON.stringify(r));
  r = await ask(path, 'bytes=2-3,5-6');
  t.check('several ranges: the whole file, not the first range alone', r.status === 200 && same(r, 0, size - 1), JSON.stringify(r));
  r = await ask(join(files, 'not opened.mp3'), null);
  t.check('a file the app did not open: refused', r.status === 403, JSON.stringify(r));
  r = await win.evaluate(async () => {
    try {
      return (await fetch('chud-media://file/%E0%A4%A')).status;
    } catch (e) {
      return String(e);
    }
  });
  t.check('a broken address: refused, not an error', r === 400, String(r));
  r = await win.evaluate(async () => (await fetch('chud-media://cover/..%2F..%2Fsecret.txt')).status);
  t.check('a cover outside the cover folder: refused', r === 403 || r === 404, String(r));

  // the small copies of a playlist picture have their own names, and go with it
  const thumbs = join(profile, 'Cache', 'thumbs');
  const pl = await win.evaluate(() => window.chud.playlists.create('Thumbs'));
  const plId = typeof pl === 'number' ? pl : pl.id;
  await win.evaluate(([id, p]) => window.chud.playlists.setCover(id, p), [plId, join(music, '..', 'covers', 'neon.png')]);
  const cover = (await win.evaluate(() => window.chud.playlists.list())).find((p) => p.id === plId).cover;
  const stem = decodeURIComponent(cover.split('/').pop()).replace(/\.\w+$/, '');
  // every small copy of this picture, whatever its name
  const small = () => (existsSync(thumbs) ? readdirSync(thumbs).filter((f) => f.includes(stem)) : []);
  for (let i = 0; i < 40 && !small().length; i++) {
    await win.evaluate(async (u) => (await fetch(`${u}?s=64`)).status, cover);
    await sleep(150);
  }
  t.check('a playlist picture: its small copy is named apart from the covers', small().join() === `64-pl-${stem}.jpg`, small().join());
  await win.evaluate((id) => window.chud.playlists.clearCover(id), plId);
  t.check('…and is deleted with the picture', small().length === 0, small().join());
} catch (e) {
  t.check('no unexpected error', false, e.stack ?? String(e));
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, files);
}
process.exit(t.finish() ? 1 : 0);
