// The state machines of the player and of the updater (src/shared/machines.ts), in the real app:
// what used to go wrong when their states were implicit.
// 1. A track is chosen while the previous one is about to end, and the new one takes a while to
//    prepare (FFmpeg conversion, simulated with CHUD_SLOW_RESOLVE_MS): the end of the OLD track
//    must not be taken for the end of the new one (which was skipped, never played).
// 2. A station that does not answer: one error notification (the audio element's error and the
//    refused play() both reported it: two notifications, counted as two failures), in the
//    interface language.
// 3. An update is known; a later check fails (offline): the update stays offered.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, npTitle, sleep, tempDir } from './harness.mjs';

const t = createSuite('machines');
const profiles = [];
const fresh = () => {
  const p = tempDir('chud-machines-');
  profiles.push(p);
  return p;
};
const f = (name) => join(music, name);
let app, win, server;

try {
  // ── 1. the end of the previous track while the next one is being prepared
  process.env.CHUD_SLOW_RESOLVE_MS = '3000';
  ({ app, win } = await launch(fresh(), [f('01 - Minuit Chrome.mp3'), f('02 - Boulevard des Ondes.mp3'), f('Fractale.flac')]));
  await win.waitForFunction(() => document.querySelector('.play-btn')?.dataset.playing !== undefined, null, { timeout: 20000 });
  await win.waitForFunction(() => !document.querySelector('.page .tl-row.pending'), null, { timeout: 15000 });
  const first = await npTitle(win);
  // to about one second before the end of the first track
  const box = await win.locator('.seek-row .slider').boundingBox();
  const dur = await win.locator('.seek-row .slider').getAttribute('aria-valuetext');
  const m = /(\d+):(\d\d)\D+(\d+):(\d\d)/.exec(dur ?? '');
  const total = m ? Number(m[3]) * 60 + Number(m[4]) : 40;
  await win.mouse.click(box.x + box.width * (1 - 1.2 / total), box.y + box.height / 2);
  await sleep(150);
  await win.locator('.tl-row:has-text("Boulevard des Ondes")').locator('.t-title').dblclick();
  // the first track ends while the second is still being prepared (3 s)
  await sleep(2000);
  t.check('the chosen track is shown while it is prepared', (await npTitle(win)) === 'Boulevard des Ondes', `${first} → ${await npTitle(win)}`);
  await win.waitForFunction(() => document.querySelector('.play-btn')?.dataset.playing !== undefined, null, { timeout: 15000 }).catch(() => {});
  await sleep(500);
  t.check('the end of the previous track does not skip the chosen one', (await npTitle(win)) === 'Boulevard des Ondes' && (await win.locator('.play-btn').getAttribute('data-playing')) !== null, `now playing: ${await npTitle(win)}`);

  // ── 1b. play/pause while a track is on its way gives it up
  const label = () => win.locator('.play-btn').getAttribute('aria-label');
  const isPlaying = async () => (await win.locator('.play-btn').getAttribute('data-playing')) !== null;
  await win.locator('.tl-row:has-text("Fractale")').locator('.t-title').dblclick();
  await sleep(900);
  t.check('while a track loads, the button offers to give it up', (await label()) === 'Annuler le chargement' && (await npTitle(win)) === 'Fractale', await label());
  await win.locator('.play-btn').click();
  await sleep(300);
  t.check('…a click stops everything at once (the previous track too)', (await label()) === 'Lecture' && !(await isPlaying()), await label());
  await sleep(4000); // well past the 3 s the track needed
  t.check('…and it does not start behind our back', (await label()) === 'Lecture' && !(await isPlaying()) && (await npTitle(win)) === 'Fractale', `${await label()} — ${await npTitle(win)}`);
  // a double click on play is not "play, then give up"
  await win.locator('.play-btn').dblclick();
  await win.waitForFunction(() => document.querySelector('.play-btn')?.dataset.playing !== undefined, null, { timeout: 15000 }).catch(() => {});
  t.check('the track given up plays when asked again (a double click is one request)', (await isPlaying()) && (await npTitle(win)) === 'Fractale' && (await label()) === 'Pause', `${await label()} — ${await npTitle(win)}`);
  await app.close();
  delete process.env.CHUD_SLOW_RESOLVE_MS;

  // ── 2. a station that does not answer, 3. an update check that fails after one that succeeded
  let apiDown = false;
  server = createServer((req, res) => {
    if (req.url.startsWith('/api/latest') && !apiDown) return res.end(JSON.stringify({ tag_name: 'v9.9.1', name: 'Chud Music 9.9.1', body: 'Notes', html_url: 'https://github.com/BigFatDeuce/Chud-Music/releases/tag/v9.9.1' }));
    res.statusCode = req.url.startsWith('/api/') ? 500 : 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.CHUD_RELEASES_API = `${base}/api/latest`;
  process.env.CHUD_UPDATE_FEED = `${base}/empty/`;
  const dead = (id, name) => ({ id, name, url: `${base}/${id}`, favicon: null, tags: ['test'], country: 'France', countryCode: 'FR', homepage: null, codec: 'MP3', bitrate: 128, votes: 1 });
  ({ app, win } = await launch(fresh()));
  await win.evaluate((list) => Promise.all([window.chud.radio.setFavorites(list), window.chud.settings.set({ autoUpdateCheck: false })]), [dead('dead-1', 'Station Muette'), dead('dead-2', 'Radio Silence')]);
  await win.reload(); // favourites and settings are read at start
  await win.waitForSelector('.playerbar');
  await gotoNav(win, 'Radio');
  await sleep(600);
  // every notification seen during 4 s (they leave after 4.5 s)
  const seen = new Map();
  await win.locator('.radio-row:has-text("Station Muette") .radio-play').click();
  for (let i = 0; i < 16; i++) {
    await sleep(250);
    const texts = await win.locator('.toast.error .toast-text').allInnerTexts();
    for (const [name] of [['Station Muette'], ['Radio Silence']]) seen.set(name, Math.max(seen.get(name) ?? 0, texts.filter((x) => x.includes(name)).length));
    seen.set('text', [...new Set([...(seen.get('text') ?? []), ...texts])]);
  }
  const text = (seen.get('text') ?? []).join(' | ').replace(/\s*\n\s*/g, ' — ');
  t.check('a dead station: one error notification, not two', seen.get('Station Muette') === 1, `${seen.get('Station Muette')} notification(s)`);
  t.check('…counted as one failure: the next station is tried too', seen.get('Radio Silence') === 1, `${seen.get('Radio Silence')} notification(s) for the second station`);
  t.check('…said in the interface language', /Cette radio ne répond pas/.test(text) && !/MEDIA_ELEMENT|DEMUXER|PIPELINE/i.test(text), text);
  t.check('…and the player is back to rest', (await win.locator('.play-btn').getAttribute('data-playing')) === null);

  const status = () => win.evaluate(() => window.chud.updates.status());
  await win.evaluate(() => window.chud.updates.check());
  const found = await status();
  t.check('an update is found', found.state === 'available' && found.version === '9.9.1', `${found.state} ${found.version}`);
  apiDown = true;
  await win.evaluate(() => window.chud.updates.check());
  const after = await status();
  t.check('a later check that fails keeps the update offered', after.state === 'available' && after.version === '9.9.1', `${after.state} ${after.error ?? ''}`);
  apiDown = false;
  await win.evaluate(() => window.chud.updates.check());
  t.check('…and the next one that answers still finds it', (await status()).state === 'available');
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  server?.close();
  cleanup(...profiles);
  process.exit(t.finish() ? 1 : 0);
}
