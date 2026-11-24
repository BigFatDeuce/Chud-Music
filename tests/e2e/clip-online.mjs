// The video clip tab with YouTube Music (needs Internet): a song is swapped for its official
// music video (same title/artist/cover, other video id), the YouTube player itself is laid over
// the stage (never recreated), the lyrics sit beside it, "Large" and the next track keep the
// layout, and leaving the tab gives the player back to the sidebar.
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('clip-online');
const profile = tempDir('chud-clip-online-');
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
/** The YouTube player against the stage of the clip tab. */
const onStage = () => win.evaluate(() => {
  const p = document.querySelector('.yt-player.visible')?.getBoundingClientRect();
  const s = document.querySelector('.clip-stage')?.getBoundingClientRect();
  if (!p || !s) return null;
  return { w: Math.round(p.width), h: Math.round(p.height), fits: Math.abs(p.left - s.left) < 2 && Math.abs(p.top - s.top) < 2 && Math.abs(p.width - s.width) < 2 && Math.abs(p.height - s.height) < 2 };
});

try {
  ({ app, win } = await launch(profile));
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1400, 900); });
  await sleep(400);
  // the lookup itself
  const mv = await win.evaluate(() => window.chud.youtube.musicVideo({ title: 'Numb', artists: ['Linkin Park'], durationSec: 185 }));
  t.check('music video lookup: "Numb" → an official video', !!mv && !!mv.videoId, mv ? `${mv.title} (${mv.videoId}, ${mv.durationSec}s)` : 'none');

  await gotoNav(win, 'YouTube Music');
  await win.locator('.yt-searchbox input').fill('Linkin Park Numb');
  await win.locator('.yt-searchbox input').press('Enter');
  await win.waitForSelector('.page .tl-body .tl-row', { timeout: 20000 });
  const row = win.locator('.page .tl-body .tl-row').first();
  await row.click({ button: 'right' });
  await sleep(300);
  const items = await win.locator('.menu-item').allInnerTexts();
  const ci = items.findIndex((m) => m.includes('Ouvrir le clip vidéo'));
  const yi = items.findIndex((m) => m.includes('Ouvrir dans YouTube Music'));
  t.check('YouTube track menu: "Ouvrir le clip vidéo" just above "Ouvrir dans YouTube Music"', ci >= 0 && yi === ci + 1, items.join(' / '));
  await win.keyboard.press('Escape');
  await sleep(200);
  await row.locator('.t-title').dblclick();
  await waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1);
  const before = await win.evaluate(() => document.querySelector('.np-title').textContent);
  // open the clip tab from the menu of the row
  await row.click({ button: 'right' });
  await win.locator('.menu-item:has-text("Ouvrir le clip vidéo")').click();
  await sleep(800);
  t.check('the clip tab opens', (await win.locator('.tab.active .tab-label').innerText()) === 'Clip vidéo');
  const fit = await waitFor(async () => { const s = await onStage(); return s?.fits ? s : null; }, 20000);
  t.check('the YouTube player is laid over the stage, full size', !!fit && fit.w >= 400, JSON.stringify(fit ?? (await onStage())));
  t.check('…the same player element (one webview only)', (await win.locator('webview.yt-player').count()) === 1);
  // swap to the music video (playback restarts on it)
  await sleep(4000);
  await waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1, 20000);
  const after = await win.evaluate(() => document.querySelector('.np-title').textContent);
  t.check('still the same song shown (title kept after the swap)', after === before, `${before} → ${after}`);
  await waitFor(async () => (await win.locator('.clip-lyrics .clip-line, .clip-lyrics .clip-plain').count()) > 0, 20000);
  t.check('lyrics beside the video', (await win.locator('.clip-lyrics .clip-line, .clip-lyrics .clip-plain').count()) > 0);
  await win.screenshot({ path: join(shots, 'clip-youtube.png') });
  await win.locator('.clip-actions button:has-text("Large")').click();
  await sleep(1200);
  const wide = await waitFor(async () => { const s = await onStage(); return s?.fits ? s : null; }, 5000);
  t.check('"Large": the player follows the bigger stage', !!wide && wide.w > (fit?.w ?? 0), JSON.stringify(wide));
  await win.screenshot({ path: join(shots, 'clip-youtube-wide.png') });
  await win.locator('.clip-actions button:has-text("À côté")').click();
  await sleep(400);

  await gotoNav(win, 'YouTube Music');
  await sleep(1200);
  const back = await win.evaluate(() => {
    const p = document.querySelector('.yt-player.visible')?.getBoundingClientRect();
    const side = document.querySelector('.sidebar')?.getBoundingClientRect();
    return !!p && !!side && p.left >= side.left - 1 && p.right <= side.right + 1;
  });
  t.check('leaving the tab: the player goes back to the sidebar', back);
  t.check('…and keeps playing', (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'clip-online-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
