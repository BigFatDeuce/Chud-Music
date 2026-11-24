// Layout checks for portrait 9:16 and narrow windows, with many tabs: nothing cut off,
// every control reachable. Sizes are window content sizes in CSS pixels.
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir, waitScanIdle, showPlaylists } from './harness.mjs';

const t = createSuite('layout');
const profile = tempDir('chud-layout-');
const lib = tempDir('chud-layout-lib-');
cpSync(music, join(lib, 'Albums'), { recursive: true });
let app, win;

/** Elements (by selector) that are present but not fully inside the window. */
const outside = (sels) =>
  win.evaluate((list) => {
    const W = innerWidth, H = innerHeight;
    return list.filter((s) => {
      const el = document.querySelector(s);
      if (!el) return true;
      const r = el.getBoundingClientRect();
      return r.width === 0 || r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1;
    });
  }, sels);

try {
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  await win.evaluate((p) => window.chud.library.addFolder(p), join(lib, 'Albums'));
  await waitScanIdle(win);
  for (let i = 1; i <= 8; i++) await win.evaluate((n) => window.chud.playlists.create(`Playlist numéro ${n}`), i);
  await sleep(600);
  for (const label of ['Playlists', 'YouTube Music', 'Visualiseur', 'Paramètres']) await gotoNav(win, label);
  await showPlaylists(win);
  for (let i = 1; i <= 8; i++) await win.locator(`.side-item:has-text("Playlist numéro ${i}")`).click();
  await sleep(400);

  for (const [w, h] of [[1080, 1920], [720, 1280], [608, 1080], [1320, 840]]) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const b = BrowserWindow.getAllWindows()[0];
      b.unmaximize();
      b.setContentSize(w, h);
    }, [w, h]);
    await sleep(700);
    const tag = `${w}×${h}`;
    const compact = (await win.locator('.app.compact').count()) === 1;

    // nothing wider than the window
    const overflow = await win.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    t.check(`${tag}: no horizontal overflow`, overflow <= 0, `${overflow}px`);

    // player bar: every control inside the window
    const bar = await outside(['.play-btn', 'button[aria-label="Suivant"]', 'button[aria-label="Précédent"]', '.volume .slider', 'button[aria-label="Égaliseur"]', 'button[aria-label="File d’attente"]', '.seek-row .slider']);
    t.check(`${tag}: player bar fully visible (play, next, volume, EQ, queue, seek)`, bar.length === 0, bar.join(', '));

    // tabs: the active one visible, "+" and "all tabs" reachable
    const lastTab = 'Playlist numéro 8';
    await win.evaluate(() => window.dispatchEvent(new Event('resize')));
    await sleep(500);
    const tabsOut = await outside(['.tab-add']);
    const activeVisible = await win.evaluate(() => {
      const a = document.querySelector('.tab.active')?.getBoundingClientRect();
      const s = document.querySelector('.tabs-scroll')?.getBoundingClientRect();
      return !!a && !!s && a.left >= s.left - 1 && a.right <= s.right + 1;
    });
    t.check(`${tag}: active tab and "+" visible`, activeVisible && tabsOut.length === 0);
    if ((await win.locator('.tab-all').count()) === 1) {
      await win.locator('.tab-all').click();
      const items = await win.locator('.menu .menu-item').count();
      await win.locator('.menu .menu-item').first().click();
      await sleep(1300); // smooth scroll across the whole strip
      const first = await win.evaluate(() => {
        const a = document.querySelector('.tab.active')?.getBoundingClientRect();
        const s = document.querySelector('.tabs-scroll')?.getBoundingClientRect();
        return document.querySelector('.tab.active .tab-label')?.textContent + '|' + (!!a && !!s && a.left >= s.left - 1 && a.right <= s.right + 1);
      });
      t.check(`${tag}: "Tous les onglets" lists every tab and brings the chosen one into view`, items === (await win.locator('.tab').count()) && first === 'Accueil|true', `${items} items, ${first}`);
      await win.locator(`.tab:has-text("${lastTab}")`).click();
    }

    // compact: sidebar in a drawer, reachable with the menu button
    if (compact) {
      t.check(`${tag}: sidebar hidden in a drawer`, (await win.locator('.sidebar.drawer:not(.open)').count()) === 1 && (await outside(['.menu-btn'])).length === 0);
      await win.locator('.menu-btn').click();
      await sleep(350);
      const navOk = (await outside(['.sidebar.open .nav'])).length === 0;
      await win.screenshot({ path: join(shots, `layout-${w}x${h}-drawer.png`) });
      await win.locator('.nav-item:has-text("Bibliothèque")').click();
      await sleep(500);
      t.check(`${tag}: menu opens the drawer, a click navigates and closes it`, navOk && (await win.locator('.sidebar.drawer.open').count()) === 0 && (await win.locator('.tab.active .tab-label').innerText()) === 'Bibliothèque');
    } else {
      await gotoNav(win, 'Bibliothèque');
    }
    // library table: no cell past the right edge of the list
    const cut = await win.evaluate(() => {
      const tl = document.querySelector('.page .tl')?.getBoundingClientRect();
      return [...document.querySelectorAll('.page .tl-row .tl-cell')].filter((c) => c.getBoundingClientRect().right > tl.right + 1).length;
    });
    t.check(`${tag}: track list fits (columns adapt)`, cut === 0, `${cut} cells cut`);
    await win.screenshot({ path: join(shots, `layout-${w}x${h}-library.png`) });
  }
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'layout-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
  process.exit(t.finish() ? 1 : 0);
}
