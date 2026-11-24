// Playback of 1.4, offline: gapless (what comes out of the speakers is recorded and measured),
// crossfade, volume normalisation, sleep timer, the queue, and resuming after a restart.
//   node tests/e2e/playback.mjs [gapless|crossfade|gain|sleep|queue|resume|long …]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanup, createSuite, launch, root, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const only = process.argv.slice(2);
const part = (name) => !only.length || only.includes(name);
const t = createSuite('playback');
const profile = tempDir('chud-playback-');
const lib = tempDir('chud-playback-lib-');
const bundled = join(root, 'build/vendor', process.platform === 'win32' ? 'ffmpeg/ffmpeg.exe' : 'ffmpeg-linux/ffmpeg');
const ffmpeg = existsSync(bundled) ? bundled : 'ffmpeg';
/** MP3, AAC… need an encoder the bundled FFmpeg does not have: checked when one is in the PATH. */
const full = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';

const RATE = 44100;
const HZ = 437;
/** 16-bit stereo WAV: the samples `from`…`to` of one endless sine (cut anywhere, it fits back). */
function wav(from, to, amp = 0.4, rate = RATE, hz = HZ) {
  const n = to - from;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(32767 * amp * Math.sin((2 * Math.PI * hz * (from + i)) / rate));
    b.writeInt16LE(v, 44 + i * 4);
    b.writeInt16LE(v, 46 + i * 4);
  }
  return b;
}
function make(dir, name, data, { ext = 'flac', codec = ['-c:a', 'flac'], bin = ffmpeg, tags = {} } = {}) {
  mkdirSync(join(lib, dir), { recursive: true });
  const src = join(lib, `${name}.tmp`);
  writeFileSync(src, data);
  const out = join(lib, dir, `${name}.${ext}`);
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'wav', '-i', src, ...codec, ...meta, out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${name}: ${r.stderr}`);
  return out;
}

let app, win;
/** Records what leaves the equaliser (before the volume) for `sec` seconds, in the page. */
const record = (sec) =>
  win.evaluate(
    async ([sec, url]) => {
      const { context, node } = window.chudTest.engine.local.tap();
      if (!window.__recReady) window.__recReady = context.audioWorklet.addModule(url);
      await window.__recReady;
      const r = new AudioWorkletNode(context, 'chud-test-recorder', { numberOfOutputs: 1, processorOptions: { seconds: sec } });
      node.connect(r);
      r.connect(context.destination); // pulled by the output; writes nothing to it
      window.__rec = await new Promise((done) => (r.port.onmessage = (e) => done(e.data)));
      node.disconnect(r);
      r.disconnect();
    },
    [sec, pathToFileURL(join(root, 'tests/e2e/recorder-worklet.js')).href],
  );
/**
 * In the recording, how far it is from one steady sine: the longest silence, and the worst
 * departure from what the two samples before say (a click), relative to the sine itself.
 */
const steadiness = (hz, skip = 0.3) =>
  win.evaluate(
    ([hz, skip]) => {
      const x = window.__rec;
      const rate = window.chudTest.engine.local.tap().context.sampleRate;
      const c = 2 * Math.cos((2 * Math.PI * hz) / rate);
      let amp = 0;
      const a = Math.floor(skip * rate);
      const b = x.length - a;
      for (let i = a; i < b; i++) amp = Math.max(amp, Math.abs(x[i]));
      let worst = 0;
      let at = 0;
      let silent = 0;
      let longest = 0;
      for (let i = a; i < b; i++) {
        const r = Math.abs(x[i] - c * x[i - 1] + x[i - 2]);
        if (r > worst) [worst, at] = [r, i];
        if (Math.abs(x[i]) < amp * 0.001) longest = Math.max(longest, ++silent);
        else silent = 0;
      }
      return { amp, click: worst / amp, at: at / rate, silenceMs: (longest * 1000) / rate };
    },
    [hz, skip],
  );
const st = () => win.evaluate(() => { const p = window.chudTest.player.getState(); return { title: p.current?.title, status: p.status, up: p.upNext.map((q) => q.track.title), pos: p.ctx?.pos, left: p.ctx ? p.ctx.order.slice(p.ctx.pos + 1).map((i) => p.ctx.tracks[i].title) : [], fromQueue: p.fromQueue, resumeAt: p.resumeAt, time: window.chudTest.engine.currentTime, chain: window.chudTest.engine.local.chainState }; });
const set = (patch) => win.evaluate((p) => window.chudTest.settings.getState().set(p), patch);
const byAlbum = async (album) => {
  const all = await win.evaluate(() => window.chud.library.tracks());
  return all.filter((x) => x.album === album).sort((a, b) => a.trackNo - b.trackNo);
};
const play = async (tracks, i = 0, at = 0) => {
  await stop(); // "playing" is then about this one
  await sleep(60);
  await win.evaluate(([tracks, i, at]) => window.chudTest.player.getState().playFrom('section:library', 'Test', tracks, i, at), [tracks, i, at]);
};
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await st();
    if (fn(s)) return s;
    if (Date.now() - t0 > ms) return null;
    await sleep(40);
  }
};
const stop = () => win.evaluate(() => { const p = window.chudTest.player.getState(); if (p.status === 'playing') p.toggle(); });

// ── files ────────────────────────────────────────────────────────────────────────────────
const CUTS = [0, 5 * RATE + 17, 10 * RATE + 931, 15 * RATE + 4];
const sets = [['Continu FLAC', {}]];
if (/libmp3lame/.test(full)) sets.push(['Continu MP3', { ext: 'mp3', codec: ['-c:a', 'libmp3lame', '-b:a', '320k'], bin: 'ffmpeg' }]);
if (/libopus/.test(full)) sets.push(['Continu Opus', { ext: 'opus', codec: ['-c:a', 'libopus', '-b:a', '192k'], bin: 'ffmpeg' }]);
if (/ aac /.test(full)) sets.push(['Continu AAC', { ext: 'm4a', codec: ['-c:a', 'aac', '-b:a', '256k'], bin: 'ffmpeg' }]);
sets.push(['Continu WAV→ALAC', { ext: 'm4a', codec: ['-c:a', 'alac'], bin: 'ffmpeg' }]);
for (const [album, o] of sets) {
  if (o.bin === 'ffmpeg' && !full) continue;
  for (let i = 0; i < 3; i++) make(album.replace('→', '-'), `${album.replace('→', '-')} ${i + 1}`, wav(CUTS[i], CUTS[i + 1]), { ...o, tags: { title: `${album} ${i + 1}`, artist: 'Sinus', album, album_artist: 'Sinus', track: i + 1 } });
}
for (const [i, hz] of [[1, 400], [2, 700], [3, 1100]]) make('Fondu', `Fondu ${i}`, wav(0, 8 * RATE, 0.4, RATE, hz), { tags: { title: `Fondu ${i}`, artist: `Artiste ${i}`, album: `Single ${i}`, track: 1 } });
make('Niveaux', 'Fort', wav(0, 12 * RATE, 0.9, RATE, 997), { tags: { title: 'Fort', artist: 'N', album: 'Niveaux', track: 1 } });
make('Niveaux', 'Faible', wav(0, 12 * RATE, 0.02, RATE, 997), { tags: { title: 'Faible', artist: 'N', album: 'Niveaux', track: 2 } });
make('Niveaux', 'Etiqueté', wav(0, 12 * RATE, 0.5, RATE, 997), { tags: { title: 'Étiqueté', artist: 'N', album: 'Niveaux', track: 3, REPLAYGAIN_TRACK_GAIN: '-6.00 dB', REPLAYGAIN_TRACK_PEAK: '0.5', REPLAYGAIN_ALBUM_GAIN: '-3.00 dB', REPLAYGAIN_ALBUM_PEAK: '0.9' } });

try {
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), lib);
  await waitScanIdle(win);
  await set({ volume: 1 });

  if (part('gapless')) {
    for (const [album, o] of sets) {
      if (o.bin === 'ffmpeg' && !full) continue;
      const tracks = await byAlbum(album);
      if (tracks.length !== 3) {
        t.check(`${album}: the three files are in the library`, false, String(tracks.length));
        continue;
      }
      await play(tracks);
      await until((s) => s.status === 'playing');
      await sleep(300);
      await record(12.5);
      const s = await steadiness(HZ);
      const now = await st();
      const lossless = /FLAC|ALAC/.test(album);
      t.check(`${album}: three files, one continuous sound (no silence)`, s.silenceMs < 1.5, `longest ${s.silenceMs.toFixed(2)} ms`);
      // (a lossy encoder rings at both ends of each file: 25 to 46 % when FFmpeg decodes them end to end)
      t.check(`${album}: …and no click`, s.click < (lossless ? 0.08 : 0.6), `${(s.click * 100).toFixed(2)} % at ${s.at.toFixed(2)} s`);
      t.check(`${album}: the player followed, on the third track`, now.title === `${album} 3` && now.status === 'playing' && now.chain.joiner, JSON.stringify(now.title));
      const clock = now.time;
      await sleep(1000);
      const d = (await st()).time - clock;
      t.check(`${album}: its position runs from its own start`, clock > 0.5 && clock < 5.2 && d > 0.5 && d < 1.6, `${clock.toFixed(2)} +${d.toFixed(2)}`);
      const end = await until((x) => x.status === 'idle', 6000);
      t.check(`${album}: at the end of the list, back to its start, at rest`, end?.title === `${album} 1`, JSON.stringify(end?.title));
    }

    const tracks = await byAlbum('Continu FLAC');
    // pause just after a join: nothing is skipped or repeated
    await play(tracks, 0, 3.5);
    await until((s) => s.title === 'Continu FLAC 2' && s.status === 'playing');
    await sleep(400);
    await stop();
    const p1 = await st();
    await sleep(600);
    const p2 = await st();
    t.check('pause after a join: the position stays', p1.status === 'paused' && Math.abs(p2.time - p1.time) < 0.02 && p1.time < 1.3, `${p1.time.toFixed(2)} → ${p2.time.toFixed(2)}`);
    await win.evaluate(() => window.chudTest.player.getState().toggle());
    await sleep(800);
    const p3 = await st();
    t.check('…and goes on from there', p3.status === 'playing' && p3.time > p1.time && p3.time < p1.time + 1.2, p3.time.toFixed(2));
    // seek back from the last moment
    await win.evaluate(() => window.chudTest.player.getState().seek(4.6));
    await sleep(120);
    await win.evaluate(() => window.chudTest.player.getState().seek(1));
    await sleep(1500);
    const sk = await st();
    t.check('seeking back at the last moment stays on the track', sk.title === 'Continu FLAC 2' && sk.time > 1.5 && sk.time < 3.2, `${sk.title} ${sk.time.toFixed(2)}`);
    // the queue changes while the next one is prepared
    await win.evaluate(() => window.chudTest.player.getState().seek(2));
    const other = (await byAlbum('Single 2'))[0];
    await sleep(700);
    const before = (await st()).chain.step;
    await win.evaluate((x) => window.chudTest.player.getState().playNext([x]), other);
    const q = await until((s) => s.title !== 'Continu FLAC 2', 5000);
    t.check('a track put next at the last moment is the one that plays', q?.title === 'Fondu 2' && q.fromQueue && !q.up.length, `${q?.title} (prepared: ${before})`);
    // repeat one
    await set({ repeat: 'one' });
    await play(tracks, 0, 3.8);
    await sleep(300);
    await until((s) => s.status === 'playing');
    await record(3.5);
    const r1 = await st();
    const r1s = await steadiness(HZ);
    t.check('repeat one: the track follows itself, without a gap', r1.title === 'Continu FLAC 1' && r1.time < 4 && r1.status === 'playing' && r1s.silenceMs < 1.5, `${r1.time.toFixed(2)} s, ${r1.status}, silence ${r1s.silenceMs.toFixed(2)} ms`);
    await set({ repeat: 'off' });
    // off: a simple change
    await set({ gapless: false });
    await play(tracks, 0, 3);
    await until((s) => s.status === 'playing');
    const prepared = await until((s) => s.chain.step !== null, 1800);
    const off = await until((s) => s.title === 'Continu FLAC 2');
    t.check('gapless off: nothing is prepared, the next track still plays', !prepared && !!off);
    await set({ gapless: true });
    await stop();
  }

  if (part('crossfade')) {
    await set({ crossfadeSec: 2 });
    const tracks = [(await byAlbum('Single 1'))[0], (await byAlbum('Single 2'))[0], (await byAlbum('Single 3'))[0]];
    await play(tracks, 0, 4);
    await until((s) => s.status === 'playing');
    await record(5);
    const f = await win.evaluate(() => {
      const x = window.__rec;
      const rate = window.chudTest.engine.local.tap().context.sampleRate;
      const level = (hz, at, len = 0.1) => {
        let re = 0, im = 0;
        const a = Math.floor(at * rate), n = Math.floor(len * rate);
        for (let i = 0; i < n; i++) { const w = (2 * Math.PI * hz * i) / rate; re += x[a + i] * Math.cos(w); im += x[a + i] * Math.sin(w); }
        return (2 * Math.hypot(re, im)) / n;
      };
      return Array.from({ length: 48 }, (_, i) => [level(400, i * 0.1), level(700, i * 0.1)]);
    });
    const both = f.filter(([a, b]) => a > 0.04 && b > 0.04).length / 10;
    const sum = f.slice(3, 47).map(([a, b]) => Math.hypot(a, b));
    t.check('crossfade: both tracks are heard for about 2 seconds', both > 1.2 && both < 2.4, `${both.toFixed(1)} s`);
    t.check('…with a steady power', Math.min(...sum) > 0.32 && Math.max(...sum) < 0.48, `${Math.min(...sum).toFixed(2)}–${Math.max(...sum).toFixed(2)}`);
    t.check('…and the first one is gone afterwards', f.at(-1)[0] < 0.002 && f.at(-1)[1] > 0.3);
    const s1 = await st();
    t.check('the player follows', s1.title === 'Fondu 2' && s1.status === 'playing', s1.title);
    // pause in the middle of a crossfade
    await win.evaluate(() => window.chudTest.player.getState().seek(5.5));
    await until((s) => s.chain.fading);
    await sleep(500);
    await stop();
    await sleep(300);
    const ps = await st();
    t.check('pause in the middle of a crossfade: the new track, paused, the old one silent', ps.status === 'paused' && ps.title === 'Fondu 3' && !ps.chain.fading, `${ps.title} ${ps.time.toFixed(2)}`);
    await win.evaluate(() => window.chudTest.player.getState().toggle());
    await sleep(500);
    t.check('…and goes on', (await st()).status === 'playing');
    // consecutive tracks of an album: never
    const album = await byAlbum('Continu FLAC');
    await play(album, 0, 2);
    await until((s) => s.status === 'playing');
    await record(4.5);
    const al = await steadiness(HZ);
    t.check('consecutive tracks of an album stay gapless', (await st()).title === 'Continu FLAC 2' && al.silenceMs < 1.5 && al.click < 0.08, `${al.silenceMs.toFixed(2)} ms, click ${(al.click * 100).toFixed(1)} %`);
    await set({ crossfadeSec: 0 });
    await stop();
  }

  if (part('gain')) {
    const [loud, quiet, tagged] = await byAlbum('Niveaux');
    const measured = await win.evaluate((ps) => Promise.all(ps.map((p) => window.chud.media.loudness(p))), [loud.path, quiet.path, tagged.path]);
    t.check('a loud file and a faint one are measured', measured[0].source === 'measured' && measured[0].trackGain < -10 && measured[1].trackGain > 10, measured.map((m) => m.trackGain?.toFixed(1)).join(' / '));
    t.check('a tagged file says its own gain', measured[2].source === 'tags' && measured[2].trackGain === -6 && measured[2].albumGain === -3);
    await set({ replayGain: 'track' });
    const level = async (track) => {
      await play([track]);
      await until((s) => s.status === 'playing');
      await sleep(700);
      await record(1);
      return (await steadiness(997)).amp;
    };
    const a = await level(loud);
    const b = await level(quiet);
    const d = 20 * Math.log10(a / b);
    t.check('both play at the same level (within 1 dB), 33 dB apart in their files', Math.abs(d) < 3.5 && a < 0.5, `${a.toFixed(3)} / ${b.toFixed(3)} (${d.toFixed(1)} dB)`);
    const c = await level(tagged);
    t.check('tag, by track: -6 dB', Math.abs(c - 0.25) < 0.01, c.toFixed(3));
    await set({ replayGain: 'album' });
    const e = await level(tagged);
    t.check('tag, by album: -3 dB', Math.abs(e - 0.354) < 0.01, e.toFixed(3));
    await set({ replayGain: 'off' });
    await sleep(1200);
    await record(0.6);
    const off = (await steadiness(997, 0.1)).amp;
    t.check('off: the file as it is, without starting again', Math.abs(off - 0.5) < 0.02, off.toFixed(3));
    await stop();
  }

  if (part('sleep')) {
    const tracks = [(await byAlbum('Single 1'))[0], (await byAlbum('Single 2'))[0]];
    await win.locator('.sleep-btn').click();
    await sleep(250);
    const menu = await win.locator('.ctx-menu, .menu, [role=menu]').first().innerText().catch(() => '');
    t.check('the sleep timer lists its choices', /Dans 5 minutes/.test(menu) && /À la fin du morceau/.test(menu) && /À la fin de l’album/.test(menu), menu.slice(0, 60).replace(/\n/g, ' | '));
    await win.keyboard.press('Escape');
    await play(tracks);
    await until((s) => s.status === 'playing');
    await win.evaluate(() => window.chudTest.sleep.getState().set({ kind: 'time', at: Date.now() + 2500 }));
    await sleep(1200);
    t.check('its button shows the time left', /s$/.test(await win.locator('.sleep-left').innerText()));
    const p = await until((s) => s.status === 'paused', 4000);
    t.check('time: playback pauses', !!p && p.title === 'Fondu 1');
    await sleep(600);
    t.check('…and the timer is over', (await win.evaluate(() => window.chudTest.sleep.getState().sleep)) === null);
    // end of the track, even with the next one ready
    await play(tracks, 0, 5);
    await until((s) => s.status === 'playing');
    await win.evaluate(() => window.chudTest.sleep.getState().set({ kind: 'track' }));
    const e = await until((s) => s.status === 'idle', 6000);
    t.check('end of the track: it stops, the next one ready', e?.title === 'Fondu 2' && (await win.evaluate(() => window.chudTest.sleep.getState().sleep)) === null, e?.title);
    // end of the album
    const album = await byAlbum('Continu FLAC');
    await win.evaluate(() => window.chudTest.sleep.getState().set({ kind: 'album' }));
    await play([album[1], album[2], tracks[0]], 0, 4);
    const inAlbum = await until((s) => s.title === 'Continu FLAC 3' && s.status === 'playing', 5000);
    const after = await until((s) => s.status === 'idle', 8000);
    t.check('end of the album: the album goes on, then it stops', !!inAlbum && after?.title === 'Fondu 1', after?.title);
  }

  if (part('queue')) {
    const album = await byAlbum('Continu FLAC');
    const many = await win.evaluate(() => window.chud.library.tracks());
    const list = many.slice().sort((a, b) => a.title.localeCompare(b.title));
    await play(list);
    await until((s) => s.status === 'playing');
    await stop();
    await win.evaluate((x) => window.chudTest.player.getState().enqueue(x), album);
    if (!(await win.locator('.queue').count())) await win.locator('.player-right button[aria-label="File d’attente"]').click();
    await sleep(400);
    const rows = win.locator('.queue [data-q]');
    const titles = async () => (await st()).up;
    t.check('the queue holds the three tracks, the rest of the list below', (await titles()).length === 3 && (await rows.count()) > 6);
    // reorder by drag
    await rows.nth(2).dragTo(rows.nth(0));
    await sleep(300);
    t.check('dragging reorders the queue', (await titles()).join() === 'Continu FLAC 3,Continu FLAC 1,Continu FLAC 2', (await titles()).join());
    const left0 = (await st()).left;
    const c = win.locator('.queue [data-q^="c"]');
    await c.nth(3).dragTo(c.nth(0));
    await sleep(300);
    const left1 = (await st()).left;
    t.check('dragging reorders the rest of the list', left1[0] === left0[3] && left1[1] === left0[0] && left1.length === left0.length, left1.slice(0, 4).join());
    // several at once
    await c.nth(0).click();
    await c.nth(2).click({ modifiers: ['Shift'] });
    await sleep(150);
    t.check('Shift selects a range', /3 morceaux sélectionnés/.test(await win.locator('.queue-selection').innerText()));
    await win.screenshot({ path: join(shots, 'playback-queue.png') });
    await win.keyboard.press('Delete');
    await sleep(300);
    t.check('Del removes them all at once', (await st()).left.length === left1.length - 3 && (await st()).left[0] === left1[3]);
    await rows.nth(0).click();
    await rows.nth(2).click({ modifiers: ['Control'] });
    await win.locator('[data-queue-remove-selected]').click();
    await sleep(300);
    t.check('Ctrl selects one by one; the button removes them', (await titles()).join() === 'Continu FLAC 1', (await titles()).join());
    t.check('the library list itself is untouched', (await win.evaluate(() => window.chud.library.tracks())).length === many.length);
    // save as a playlist
    const want = [(await st()).title, ...(await titles()), ...(await st()).left];
    await win.locator('[data-queue-save]').click();
    await sleep(300);
    await win.locator('.dialog input').fill('Ma file');
    await win.locator('.dialog button[type=submit]').click();
    await sleep(600);
    const pl = (await win.evaluate(() => window.chud.playlists.list())).find((p) => p.name === 'Ma file');
    const saved = pl && (await win.evaluate((id) => window.chud.playlists.get(id), pl.id)).tracks.map((x) => x.title);
    t.check('the queue is saved as a playlist, in its order', JSON.stringify(saved) === JSON.stringify(want), `${saved?.length} / ${want.length}`);
    await win.locator('[data-queue-clear]').click();
    await sleep(300);
    const cl = await st();
    t.check('everything is cleared, the current track stays', cl.up.length === 0 && cl.left.length === 0 && !!cl.title);
    await win.locator('.player-right button[aria-label="File d’attente"]').click();
  }

  if (part('long')) {
    // a long session, hurried: dozens of changes (gapless, crossfade), pauses, seeks, the output
    // suspended and back (as a sleep of the computer does), normalisation on
    const errors = [];
    win.on('pageerror', (e) => errors.push(e.message));
    const all = [...(await byAlbum('Continu FLAC')), (await byAlbum('Single 1'))[0], (await byAlbum('Single 2'))[0], ...(await byAlbum('Continu MP3')), (await byAlbum('Single 3'))[0]];
    await set({ repeat: 'all', crossfadeSec: 1, replayGain: 'track', shuffle: false });
    const memory = () => app.evaluate(({ app }) => Math.round(app.getAppMetrics().find((m) => m.type === 'Tab').memory.workingSetSize / 1024));
    await play(all, 0);
    await until((s) => s.status === 'playing');
    await sleep(3000);
    const m0 = await memory();
    let last = (await st()).title;
    let changes = 0;
    let stuck = 0;
    let moved = performance.now();
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 100_000) {
      await sleep(250);
      const s = await st();
      if (s.title !== last) {
        changes++;
        last = s.title;
        moved = performance.now();
      } else if (performance.now() - moved > 12_000) {
        stuck++;
        moved = performance.now();
      }
      n++;
      // most of the time a jump near the end; now and then something else
      if (n % 8 === 0) await win.evaluate(() => { const p = window.chudTest.player.getState(); if (p.status === 'playing') p.seek(Math.max(0, p.duration - 1.8)); });
      if (n % 45 === 0) { await stop(); await sleep(150); await win.evaluate(() => window.chudTest.player.getState().toggle()); }
      if (n % 70 === 0) { await win.evaluate(() => window.chudTest.engine.local.tap().context.suspend()); await sleep(700); await win.evaluate(() => window.chudTest.engine.local.tap().context.resume()); }
      if (n % 60 === 0) await win.evaluate(() => window.chudTest.player.getState().next());
    }
    const s = await st();
    t.check('a long session: dozens of changes, never stuck', changes >= 25 && stuck === 0 && s.status === 'playing', `${changes} changes, stuck ${stuck}, ${s.status}`);
    const m1 = await memory();
    t.check('…memory does not pile up', m1 - m0 < 120, `${m0} → ${m1} MB`);
    t.check('…without an error', errors.length === 0, errors.slice(0, 3).join(' | '));
    await record(1.5);
    t.check('…and there is sound', (await steadiness(437)).amp > 0.02);
    await set({ repeat: 'off', crossfadeSec: 0, replayGain: 'off' });
    await stop();
  }

  if (part('resume')) {
    const list = (await win.evaluate(() => window.chud.library.tracks())).sort((a, b) => a.title.localeCompare(b.title));
    await play(list, 2);
    await until((s) => s.status === 'playing');
    const q = await byAlbum('Continu FLAC');
    await win.evaluate((x) => window.chudTest.player.getState().enqueue(x), q);
    await win.evaluate(() => window.chudTest.player.getState().next());
    await until((s) => s.status === 'playing' && s.title === 'Continu FLAC 1');
    await win.evaluate(() => window.chudTest.player.getState().seek(2.5));
    await sleep(700);
    await stop();
    const before = await st();
    await app.close();
    ({ app, win } = await launch(profile));
    await sleep(1500);
    const s = await st();
    t.check('restart: the queued track, its position and the queue are back, at rest', s.title === 'Continu FLAC 1' && s.status === 'idle' && s.fromQueue && Math.abs(s.resumeAt - before.time) < 0.3 && s.up.join() === 'Continu FLAC 2,Continu FLAC 3', `${s.title} ${s.resumeAt?.toFixed(2)} [${s.up}]`);
    t.check('…and its place in the list', s.left.join() === before.left.join() && s.pos === before.pos);
    await win.evaluate(() => window.chudTest.player.getState().toggle());
    const r = await until((x) => x.status === 'playing');
    t.check('play goes on from there', !!r && r.title === 'Continu FLAC 1' && r.time > before.time - 0.3 && r.time < before.time + 1.5, r?.time.toFixed(2));
    // killed (no chance to say goodbye): the last save is at most 10 s old
    await win.evaluate(() => window.chudTest.player.getState().next());
    await until((x) => x.title === 'Continu FLAC 2' && x.status === 'playing');
    await sleep(2500);
    const pid = await app.evaluate(() => process.pid); // (app.process() is a shell, on Windows)
    process.kill(pid, 'SIGKILL');
    await sleep(3000); // its other processes
    ({ app, win } = await launch(profile));
    await sleep(1500);
    const k = await st();
    t.check('after a crash: the same track and queue', k.title === 'Continu FLAC 2' && k.up.join() === 'Continu FLAC 3', `${k.title} [${k.up}]`);
  }
} catch (e) {
  t.check('no unexpected error', false, e.stack ?? String(e));
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
}
process.exit(t.finish() ? 1 : 0);
