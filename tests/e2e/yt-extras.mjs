// Online checks of 0.5.0 (needs Internet): subtitles always off in the YouTube player (player API,
// option + hidden caption layer in its frame), the playback speed applied to YouTube, and
// "Start mix (Online)" on a local file (the YouTube Music lookup is stubbed to a known song so
// the flow is tested whatever the fixture is; the matcher itself is covered by links.mjs).
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('yt-extras');
const profile = tempDir('chud-yt-extras-');
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
/** Runs code in the YouTube player page (ours) or in YouTube's own embed frame inside it. */
const inPlayer = (code, embed = false) => app.evaluate(async ({ webContents }, [code, embed]) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('chud-yt://player/'));
  if (!wc) return null;
  const frame = embed ? wc.mainFrame.framesInSubtree.find((f) => /youtube(-nocookie)?\.com\/embed\//.test(f.url)) : wc.mainFrame;
  return frame ? frame.executeJavaScript(code) : null;
}, [code, embed]);

try {
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);

  // ── "Start mix (Online)" on a local file
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('yt:match');
    ipcMain.handle('yt:match', () => ({ id: 'yt:kXYiU_JCYtU', source: 'youtube', videoId: 'kXYiU_JCYtU', title: 'Numb', artist: 'Linkin Park', album: null, durationSec: 188, coverUrl: null }));
  });
  await gotoNav(win, 'Bibliothèque');
  await sleep(400);
  await win.locator('.page .tl-body .tl-row:has-text("Minuit Chrome")').first().click({ button: 'right' });
  await sleep(300);
  await win.locator('.menu-item:has-text("Démarrer le mix (en ligne)")').click();
  const mixTab = await waitFor(async () => { const l = await win.locator('.tab.active .tab-label').innerText(); return /Numb/.test(l) ? l : null; }, 30000);
  t.check('"Start mix (Online)": the mix of the same song opens in a tab', !!mixTab, mixTab ?? (await win.locator('.tab.active .tab-label').innerText()));
  await waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1, 30000);
  const np = await win.locator('.np-badges .badge').first().innerText();
  t.check('…and plays it from YouTube Music', np === 'YouTube' && (await win.locator('.page .tl-body .tl-row').count()) > 5, `${np}, ${await win.locator('.page .tl-body .tl-row').count()} tracks`);
  await sleep(2500);

  // ── subtitles off
  const cc = await waitFor(() => inPlayer(`(() => {
    const s = document.getElementById('chud-no-cc');
    const c = document.querySelector('.ytp-caption-window-container');
    const r = { style: !!s, layerShown: !!c && getComputedStyle(c).display !== 'none', segments: [...document.querySelectorAll('.ytp-caption-segment')].filter((e) => e.offsetWidth > 0).length };
    return r.style ? r : null;
  })()`, true), 20000);
  t.check('YouTube: the caption layer is hidden inside the player frame', !!cc && cc.style && !cc.layerShown && cc.segments === 0, JSON.stringify(cc));
  await sleep(5500);
  // the state inside YouTube's own player (the outer API reports the available track, not the shown one)
  const inner = await inPlayer(`(() => { const m = document.getElementById('movie_player'); return m ? JSON.stringify({ on: m.isSubtitlesOn?.(), track: m.getOption?.('captions', 'track') ?? {} }) : 'none'; })()`, true);
  const st = inner && inner !== 'none' ? JSON.parse(inner) : null;
  t.check('YouTube: subtitles off in the player (no track shown)', !!st && st.on === false && Object.keys(st.track).length === 0, inner);
  // a video turning them on again is switched off within a second
  await inPlayer(`(() => { const m = document.getElementById('movie_player'); try { m.toggleSubtitles(); } catch {} return m.isSubtitlesOn?.(); })()`, true);
  await sleep(1800);
  const again = await inPlayer(`document.getElementById('movie_player').isSubtitlesOn?.()`, true);
  t.check('…turned on by the video: switched off again', again === false, String(again));

  await win.locator('.speed-btn').click();
  await win.locator('.menu-item:has-text("1,5×")').click();
  await sleep(1200);
  const rate = await inPlayer('player.getPlaybackRate()');
  t.check('YouTube: 1,5× chosen → the official player plays at 1.5', rate === 1.5, String(rate));
  const a = await inPlayer('player.getCurrentTime()');
  await sleep(4000);
  const b = await inPlayer('player.getCurrentTime()');
  t.check('…and really goes faster (≈ 6 s in 4 s)', b - a > 5 && b - a < 7.2, `${a?.toFixed(1)} → ${b?.toFixed(1)}`);
  await win.screenshot({ path: join(shots, 'yt-extras.png') });
  await win.locator('.speed-btn').click({ button: 'right' });
  await sleep(1000);
  t.check('…back to 1×', (await inPlayer('player.getPlaybackRate()')) === 1);

  // ── clip tab with YouTube: effects disabled (the player is never altered); mini player keeps the video
  await win.locator('.transport-buttons .bar-tab-btn').first().click();
  await sleep(1500);
  t.check('clip tab, YouTube: the effect buttons are shown disabled', (await win.locator('.clip-fx-btn:disabled').count()) === 5 && (await win.locator('.clip-fx-note').count()) === 1);
  const where = () => win.evaluate(() => {
    const p = document.querySelector('.yt-player.visible')?.getBoundingClientRect();
    const c = document.querySelector('.living-cover')?.getBoundingClientRect();
    return p && c ? { w: Math.round(p.width), h: Math.round(p.height), inCover: p.left >= c.left - 1 && p.right <= c.right + 1 && p.top >= c.top - 1 && p.bottom <= c.bottom + 1, inClip: document.querySelector('.living-cover').classList.contains('in-clip') } : null;
  });
  await win.locator('.mini-open').click();
  await sleep(1500);
  const m = await where();
  t.check('mini player while the clip tab is shown: the video is in the mini player (≥ 200 px)', !!m && !m.inClip && m.inCover && m.w >= 200 && m.h >= 200, JSON.stringify(m));
  await win.screenshot({ path: join(shots, 'mini-yt-clip.png') });
  await win.locator('.mini-expand').click();
  await sleep(1500);
  const back = await win.evaluate(() => {
    const p = document.querySelector('.yt-player.visible')?.getBoundingClientRect();
    const s = document.querySelector('.clip-stage')?.getBoundingClientRect();
    return !!p && !!s && Math.abs(p.left - s.left) < 2 && Math.abs(p.width - s.width) < 2;
  });
  t.check('…back to the normal window: the video returns onto the clip stage', back);

  // ── narrow window, menu drawer open over the clip tab: the player is never under the drawer
  const drawerSpot = () => win.evaluate(() => {
    const p = document.querySelector('.yt-player.visible')?.getBoundingClientRect();
    const a = document.querySelector('.sidebar.drawer.open')?.getBoundingClientRect();
    const nav = document.querySelector('.sidebar .nav')?.getBoundingClientRect();
    if (!p || !a || !nav) return null;
    const el = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2);
    return {
      w: Math.round(p.width),
      h: Math.round(p.height),
      inDrawer: p.left >= a.left - 1 && p.right <= a.right + 1 && p.top >= nav.bottom - 1 && p.bottom <= a.bottom + 1,
      beside: p.left >= a.right - 1 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1,
      // the player may let clicks through (locked): what is there must be the player's own frame
      onTop: !!el?.closest('.living-cover'),
    };
  });
  const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
  for (const [w, h, want, label] of [[900, 1000, 'inDrawer', 'tall window: in the drawer, under the menu'], [700, 600, 'beside', 'short window: beside the drawer']]) {
    await setSize(w, h);
    await sleep(1200);
    await win.locator('.menu-btn').click();
    await sleep(1200);
    const d = await drawerSpot();
    t.check(`drawer open over the clip tab, ${label} (≥ 200 px, nothing over it)`, !!d && d[want] && d.onTop && d.w >= 200 && d.h >= 200, JSON.stringify(d));
    await win.screenshot({ path: join(shots, `yt-drawer-${want}.png`) });
    await win.locator('.menu-btn').click();
    await sleep(1200);
  }
  const back2 = await win.evaluate(() => {
    const p = document.querySelector('.yt-player.visible')?.getBoundingClientRect();
    const s = document.querySelector('.clip-stage')?.getBoundingClientRect();
    return !!p && !!s && Math.abs(p.left - s.left) < 2 && Math.abs(p.width - s.width) < 2;
  });
  t.check('…drawer closed: the video is back on the clip stage', back2);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'yt-extras-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
