// Offline checks of the radio time shift and recording, with a station served from this process
// (an MP3 fixture looped at its real pace, ICY titles every 8 KB): the station plays live, can be
// taken back in time with the seek bar and brought back to live, resumes where it was paused
// (the audio waited in memory), records what is heard into the chosen folder without re-encoding,
// and closes its connection when another source plays. The record button sits right of the
// visualizer without moving the play button.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, root, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('radio-shift');
const profile = tempDir('chud-radio-shift-');
const recDir = tempDir('chud-radio-rec-');
let app, win, server;

// ── the station: the fixture's audio frames (ID3 tag left out), looped at its own pace
let mp3 = readFileSync(join(music, '01 - Minuit Chrome.mp3'));
if (mp3.subarray(0, 3).toString() === 'ID3') {
  const size = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  mp3 = mp3.subarray(10 + size);
}
const ffmpeg = process.platform === 'win32' ? join(root, 'build/vendor/ffmpeg/ffmpeg.exe') : join(root, 'build/vendor/ffmpeg-linux/ffmpeg');
let probe = '';
try {
  execFileSync(ffmpeg, ['-hide_banner', '-i', join(music, '01 - Minuit Chrome.mp3')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  probe = String(e.stderr ?? '');
}
const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe);
const seconds = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 40;
const rate = Math.round(mp3.length / seconds); // bytes per second
const METAINT = 8192;
let connections = 0;
let open = 0;

server = createServer((req, res) => {
  if (!req.url.startsWith('/stream')) return res.writeHead(404).end();
  connections++;
  open++;
  const icy = req.headers['icy-metadata'] === '1';
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', ...(icy ? { 'icy-metaint': String(METAINT) } : {}) });
  let off = 0;
  let toMeta = METAINT;
  let n = 0;
  const send = (bytes) => {
    const out = [];
    while (bytes > 0) {
      const take = Math.min(bytes, mp3.length - off, icy ? toMeta : Infinity);
      out.push(mp3.subarray(off, off + take));
      off = (off + take) % mp3.length;
      bytes -= take;
      if (icy) {
        toMeta -= take;
        if (toMeta === 0) {
          const text = Buffer.from(n++ % 4 === 0 ? `StreamTitle='Test Artist - Song ${n}';` : '');
          const len = Math.ceil(text.length / 16);
          const meta = Buffer.alloc(1 + len * 16);
          meta[0] = len;
          text.copy(meta, 1);
          out.push(meta);
          toMeta = METAINT;
        }
      }
    }
    res.write(Buffer.concat(out));
  };
  send(rate * 4); // the usual burst on connection
  const id = setInterval(() => send(Math.round(rate / 10)), 100);
  req.on('close', () => {
    clearInterval(id);
    open--;
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const station = { id: 'test-station', name: 'Station Test', url: `http://127.0.0.1:${port}/stream`, favicon: null, tags: ['test'], country: 'France', countryCode: 'FR', homepage: null, codec: 'MP3', bitrate: Math.round((rate * 8) / 1000), votes: 1 };

const timeText = () => win.locator('.seek-row .time').first().innerText();
const behind = async () => {
  const s = await timeText();
  const m = /^-(\d+):(\d+)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
const rwin = () => win.evaluate(() => window.chud.radio.window());

try {
  ({ app, win } = await launch(profile));
  await win.evaluate(([s, dir]) => Promise.all([window.chud.radio.setFavorites([s]), window.chud.settings.set({ radioRecordDir: dir })]), [station, recDir]);
  await win.reload(); // favourites and settings are read at start
  await win.waitForSelector('.playerbar');
  await gotoNav(win, 'Radio');
  await sleep(600);
  await win.locator('.radio-row:has-text("Station Test") .radio-play').click();
  await win.waitForFunction(() => document.querySelector('.play-btn')?.dataset.playing !== undefined, null, { timeout: 15000 });
  await sleep(1500);
  t.check('the station plays, shown live', (await win.locator('.seek-row .time.live').count()) === 1 && (await win.locator('.np-title').innerText()) === 'Station Test', await timeText());
  t.check('one connection to the station, ICY stripped (title read)', connections === 1, `${connections} connection(s)`);

  // record button right of the visualizer, the play button still in the middle
  const place = await win.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const viz = r('.transport-buttons button[aria-label="Visualiseur"]');
    const rec = r('.transport-buttons .rec-btn');
    const play = r('.play-btn');
    const tb = r('.transport-buttons');
    return { gap: Math.round(rec.left - viz.right), sameRow: Math.abs(rec.top - viz.top) < 4, centre: Math.round(play.left + play.width / 2 - (tb.left + tb.width / 2)) };
  });
  t.check('record button right of the visualizer, the play button stays centred', place.gap >= 6 && place.gap <= 14 && place.sameRow && Math.abs(place.centre) <= 1, JSON.stringify(place));

  // ── back in time with the seek bar
  await sleep(9000);
  const w1 = await rwin();
  t.check('the station is kept in memory while it plays', w1 && w1.end - w1.start >= 10, JSON.stringify(w1));
  const box = await win.locator('.seek-row .slider').boundingBox();
  await win.mouse.click(box.x + box.width * 0.15, box.y + box.height / 2);
  await sleep(2500);
  const b1 = await behind();
  t.check('seek bar: back in time, the delay is shown', b1 >= 6, await timeText());
  const p1 = await win.evaluate(() => document.querySelector('.play-btn').dataset.playing !== undefined);
  await sleep(2000);
  const b1b = await behind();
  t.check('…and it plays on from there (delay steady)', p1 && Math.abs(b1b - b1) <= 2, `${b1} s → ${b1b} s`);
  await win.screenshot({ path: join(shots, 'radio-shift.png') });

  // ── back to live
  await win.locator('.radio-live-btn').click();
  await sleep(2500);
  t.check('"Direct": back to live', (await win.locator('.seek-row .time.live').count()) === 1 && (await win.locator('.radio-live-btn').isDisabled()), await timeText());
  t.check('…still one connection to the station', connections === 1 && open === 1, `${connections} connection(s), ${open} open`);

  // ── pause, then play again: goes on from where it was
  await win.locator('.play-btn').click();
  const endPaused = (await rwin()).end;
  await sleep(8000);
  const endLater = (await rwin()).end;
  t.check('while paused, the station keeps coming into memory', endLater - endPaused >= 6, `${(endLater - endPaused).toFixed(1)} s`);
  await win.locator('.play-btn').click();
  await sleep(2500);
  const b2 = await behind();
  t.check('play again: it goes on from where it was paused', b2 >= 6 && b2 <= 14, await timeText());

  // ── recording, from what is heard
  await win.locator('.rec-btn').click();
  await sleep(500);
  t.check('record: the button shows it records', (await win.locator('.rec-btn.recording').count()) === 1);
  await sleep(4000);
  await win.locator('.rec-btn').click();
  await sleep(800);
  const files = readdirSync(recDir);
  const file = files[0] ? join(recDir, files[0]) : null;
  const head = file ? readFileSync(file).subarray(0, 2) : Buffer.alloc(2);
  const size = file ? statSync(file).size : 0;
  t.check('stop: one MP3 saved in the chosen folder, named after the station', files.length === 1 && /^Station Test \d{4}-\d\d-\d\d \d\dh\d\d\.mp3$/.test(files[0]), files.join(', '));
  t.check('…the station’s own audio, about the time recorded (no re-encoding)', head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && size >= rate * 3 && size <= rate * 8, `${size} bytes, ${(size / rate).toFixed(1)} s`);
  t.check('…a notification offers to show it', (await win.locator('.toast:has-text("Enregistrement sauvegardé") button:has-text("Afficher")').count()) === 1);

  // ── another source: the station is closed
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  await gotoNav(win, 'Bibliothèque');
  await sleep(500);
  await win.locator('.page .tl-body .tl-row .t-title').first().dblclick();
  await sleep(1500);
  t.check('a local file plays: the station’s connection is closed, normal seek bar', (await rwin()) === null && open === 0 && (await win.locator('.rec-btn').count()) === 0 && (await win.locator('.radio-live-btn').count()) === 0, `${open} open`);
  t.check('recordings are never deleted', existsSync(file));

  // ── quitting while recording: the file is written out to the end before the app goes
  await gotoNav(win, 'Radio');
  await sleep(500);
  await win.locator('.radio-row:has-text("Station Test") .radio-play').click();
  await win.waitForSelector('.rec-btn', { timeout: 15000 });
  await sleep(1500);
  await win.locator('.rec-btn').click();
  await sleep(3500);
  await app.close();
  app = null;
  const second = readdirSync(recDir).filter((f) => f !== files[0]);
  const f2 = second[0] ? join(recDir, second[0]) : null;
  const h2 = f2 ? readFileSync(f2).subarray(0, 2) : Buffer.alloc(2);
  const s2 = f2 ? statSync(f2).size : 0;
  t.check('quit while recording: the recording is saved, complete', second.length === 1 && h2[0] === 0xff && (h2[1] & 0xe0) === 0xe0 && s2 >= rate * 2, `${second.join(', ')} ${s2} bytes`);
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'radio-shift-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  server.close();
  cleanup(profile, recDir);
  process.exit(t.finish() ? 1 : 0);
}
