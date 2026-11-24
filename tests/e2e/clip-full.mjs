// Online (real YouTube player): the clip tab full screen across a YouTube video and a local file
// (one thing is full screen whatever plays), the 480p request while the player is small, and the
// spectrum of the player bar during a YouTube track (measured, or moving on its own).
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, showPlaylists, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('clip-full');
const profile = tempDir('chud-clip-full-');
let app, win;
const waitFor = async (fn, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
};
const command = (cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('player:command', c), cmd);
const playing = () => waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1, 40000);
/** What YouTube's own player says, read in its frame. */
const ytInfo = () => app.evaluate(async ({ webContents }) => {
  for (const wc of webContents.getAllWebContents()) {
    const f = wc.mainFrame.framesInSubtree.find((x) => /youtube(-nocookie)?\.com\/embed\//.test(x.url));
    if (f) return f.executeJavaScript(`(() => { const p = document.getElementById('movie_player'); const v = document.querySelector('video'); return p ? { quality: p.getPlaybackQuality(), asked: p.getPreferredQuality ? p.getPreferredQuality() : null, h: v ? v.videoHeight : 0 } : null; })()`);
  }
  return null;
});
const boxes = () => win.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s)?.getBoundingClientRect(); return e ? [Math.round(e.left), Math.round(e.top), Math.round(e.width), Math.round(e.height)] : null; };
  return {
    inner: [0, 0, innerWidth, innerHeight],
    stage: r('.clip-stage'),
    player: r('.yt-player.visible'),
    art: r('.clip-stage .clip-art-img, .clip-stage .clip-vhs'),
    fs: !!document.fullscreenElement,
    attr: document.documentElement.hasAttribute('data-clip-full'),
    // what is really on top in the middle of the screen
    top: ((e) => (!e ? null : e.closest('.living-cover') ? 'yt-player (living cover)' : e.className.toString().slice(0, 40) || e.tagName))(document.elementFromPoint(innerWidth / 2, innerHeight / 2)),
  };
});
const same = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 2);

try {
  ({ app, win } = await launch(profile));
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1400, 900); });
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  const ytTrack = await win.evaluate(() => window.chud.youtube.match({ title: 'Numb', artists: ['Linkin Park'], durationSec: 185 }));
  t.check('a YouTube Music track to play', !!ytTrack?.videoId, ytTrack?.title);
  const local = (await win.evaluate(() => window.chud.library.tracks())).find((x) => x.title === 'Minuit Chrome');
  await win.evaluate((e) => window.chud.playlists.create('Plein écran', e), [ytTrack, local]);
  await showPlaylists(win);
  await win.locator('.side-item:has-text("Plein écran")').click();
  await sleep(700);
  await win.locator('.page .tl-body .tl-row').first().locator('.t-title').dblclick();
  t.check('the YouTube track plays', !!(await playing()));

  // ── small player: 480p at most
  await sleep(6000);
  const small = await ytInfo();
  console.log(`INFO  small player: ${JSON.stringify(small)}`);
  t.check('small player: YouTube is asked for 480p at most, and plays at 480p or less', !!small && small.asked === 'large' && ['large', 'medium', 'small', 'tiny'].includes(small.quality) && small.h <= 480, JSON.stringify(small));

  // ── the spectrum moves
  const feed = await win.evaluate(() => document.querySelector('.spectrum canvas')?.dataset.feed);
  const moves = await win.evaluate(async () => { const cv = document.querySelector('.spectrum canvas'); if (!cv?.offsetWidth) return 'hidden'; const a = cv.toDataURL(); await new Promise((r) => setTimeout(r, 500)); return cv.toDataURL() !== a ? 'animated' : 'static'; });
  t.check('YouTube: the spectrum of the player bar moves', moves === 'animated' && (feed === 'measured' || feed === 'simulated'), `${moves}, feed: ${feed}`);
  // …and still does when the measure hears nothing: levels at zero count as no levels
  await app.evaluate(({ webContents }) => {
    for (const wc of webContents.getAllWebContents()) for (const f of wc.mainFrame.framesInSubtree) if (/youtube(-nocookie)?\.com\/embed\//.test(f.url)) void f.executeJavaScript(`AnalyserNode.prototype.getByteFrequencyData = function (a) { a.fill(0); }`);
  });
  await sleep(4000);
  const feed2 = await win.evaluate(() => document.querySelector('.spectrum canvas')?.dataset.feed);
  const moves2 = await win.evaluate(async () => { const cv = document.querySelector('.spectrum canvas'); const a = cv.toDataURL(); await new Promise((r) => setTimeout(r, 500)); return cv.toDataURL() !== a ? 'animated' : 'static'; });
  t.check('…and still moves when the measure hears nothing (bars on their own)', moves2 === 'animated' && feed2 === 'simulated', `${moves2}, feed: ${feed2}`);

  // ── the clip tab: YouTube's own choice of quality again
  await win.locator('.page .tl-body .tl-row').first().click({ button: 'right' });
  await win.locator('.menu-item:has-text("Ouvrir le clip vidéo")').click();
  await sleep(1500);
  await waitFor(async () => { const b = await boxes(); return same(b.stage, b.player); }, 20000);
  await sleep(6000);
  await playing();
  const big = await ytInfo();
  console.log(`INFO  on the clip stage: ${JSON.stringify(big)}`);
  t.check('clip stage: no limit asked any more (YouTube chooses)', !!big && big.asked === 'auto', JSON.stringify(big));

  // ── full screen with the YouTube video
  await win.locator('.clip-actions button:has-text("Plein écran")').click();
  const full = await waitFor(async () => { const b = await boxes(); return b.fs && b.attr && same(b.stage, b.inner) && same(b.player, b.inner) ? b : null; }, 8000);
  t.check('full screen: the stage and the YouTube player fill the window', !!full, JSON.stringify(full ?? (await boxes())));
  await win.screenshot({ path: join(shots, 'clip-full-youtube.png') }).catch(() => {});

  // ── YouTube → local file: still full screen, the cover shows (no Esc needed for nothing)
  await command('next');
  await sleep(2500);
  const b1 = await boxes();
  t.check('next track is a file: still full screen, its cover fills the stage', b1.fs && b1.attr && same(b1.stage, b1.inner) && !!b1.art && !b1.player, JSON.stringify(b1));
  t.check('…and it is the stage that shows, on top', /clip-art|clip-fx|clip-vhs|clip-stage/.test(b1.top ?? ''), b1.top);
  await win.screenshot({ path: join(shots, 'clip-full-local.png') }).catch(() => {});

  // ── local file → YouTube: the player is back on top, full size (no black screen)
  await command('previous');
  await sleep(1000);
  await command('previous');
  const b2 = await waitFor(async () => { const b = await boxes(); return b.player && same(b.player, b.inner) ? b : null; }, 30000);
  t.check('back to the YouTube track: the player fills the screen again', !!b2 && b2.fs && b2.attr, JSON.stringify(b2 ?? (await boxes())));
  t.check('…and it is the player that shows, on top (not a black stage)', /yt-player/.test(b2?.top ?? ''), b2?.top);
  t.check('…still the same player element', (await win.locator('webview.yt-player').count()) === 1);

  // ── Esc leaves, everything back in place
  await win.keyboard.press('Escape');
  const out = await waitFor(async () => { const b = await boxes(); return !b.fs && !b.attr ? b : null; }, 8000);
  t.check('Esc leaves full screen', !!out && !same(out.stage, out.inner), JSON.stringify(out ?? (await boxes())));
  // leaving the tab while full screen leaves full screen too
  await win.locator('.clip-actions button:has-text("Plein écran")').click();
  await waitFor(async () => (await boxes()).attr, 8000);
  await win.evaluate(() => document.querySelector('.nav-item')?.click());
  const left = await waitFor(async () => { const b = await boxes(); return !b.fs && !b.attr; }, 8000);
  t.check('leaving the clip tab leaves full screen', !!left);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'clip-full-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
