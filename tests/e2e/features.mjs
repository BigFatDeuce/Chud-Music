// New features: sidebar deck switch, "files or folder" chooser, skins Signal and Platine,
// YouTube click lock, audio output, media keys (real key press, only if Chud Music holds the
// key), statistics, mini player.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanup, createSuite, elapsed, gotoNav, launch, music, npTitle, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('features');
const profile = tempDir('chud-features-');
let app, win;
const settings = () => win.evaluate(() => window.chud.settings.get());
const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());

try {
  process.env.CHUD_TEST_MEDIAKEYS = '1';
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac'), join(music, '01 - Minuit Chrome.mp3')]));
  await sleep(2500);

  // ── sidebar deck
  t.check('sidebar shows the cover by default, with a switch', (await win.locator('.deck.cover .living-cover').count()) === 1 && (await win.locator('.deck-switch button').count()) === 2 && (await win.locator('.side-section').count()) === 0);
  await win.evaluate(() => window.chud.playlists.create('Une playlist'));
  await win.locator('.deck-switch button:has-text("Playlists")').click();
  await sleep(300);
  t.check('switch → playlists list, with "+" (new playlist)', (await win.locator('.deck.playlists .side-item:has-text("Une playlist")').count()) === 1 && (await win.locator('.deck-head .icon-btn[aria-label="Nouvelle playlist"]').isVisible()));
  t.check('the choice is saved', (await settings()).sidePanel === 'playlists');
  await win.locator('.deck-switch button:has-text("Pochette")').click();

  // ── files or folder, everywhere
  await win.locator('.tab-add').click();
  const choices = await win.locator('.menu .menu-item').allInnerTexts();
  t.check('"+" offers files or a whole folder', choices.some((c) => c.includes('Des fichiers')) && choices.some((c) => c.includes('Un dossier')), choices.join(' | '));
  t.check('"+" offers the Playlists tab first', choices[0]?.trim() === 'Playlists', choices.join(' | '));
  await win.locator('.menu .menu-item').first().click();
  await sleep(450);
  t.check('"+" › Playlists opens the Playlists tab', (await win.locator('.tab.active').innerText()).includes('Playlists'), await win.locator('.tab.active').innerText().catch(() => ''));

  // ── audio output + YouTube lock (settings)
  t.check('YouTube player click lock on by default', (await settings()).ytClickLock === true);
  await gotoNav(win, 'Paramètres');
  t.check('Settings: no device listing until asked (it wakes a 125 MB service)', (await win.locator('select[aria-label="Sortie audio"] option').count()) === 1);
  await win.locator('select[aria-label="Sortie audio"]').focus();
  await sleep(500);
  t.check('Settings: the output list fills when opened', (await win.locator('select[aria-label="Sortie audio"] option').count()) >= 1);
  await win.locator('.volume .icon-btn').click({ button: 'right' });
  await win.locator('.menu .menu-item').first().waitFor({ timeout: 15_000 }).catch(() => {});
  t.check('right-click on the volume icon: output devices', (await win.locator('.menu .menu-item:has-text("Sortie par défaut")').count()) === 1);
  await win.keyboard.press('Escape');

  // ── media keys: Chud Music takes them once it plays; a real key press reaches it
  const keys = await win.evaluate(() => window.chud.taskbar.mediaKeys());
  t.check('media keys registered for Chud Music after it played', keys.active && keys.registered, JSON.stringify(keys));
  if (keys.registered && process.platform === 'win32') {
    const before = await win.locator('.play-btn').getAttribute('aria-label');
    // VK_MEDIA_PLAY_PAUSE (0xB3), as the keyboard sends it; held by Chud Music, so it reaches nothing else
    execFileSync('powershell', ['-NoProfile', '-Command', "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, System.UIntPtr e);'; [W.K]::keybd_event(0xB3,0,0,[UIntPtr]::Zero); [W.K]::keybd_event(0xB3,0,2,[UIntPtr]::Zero)"]);
    await sleep(800);
    const after = await win.locator('.play-btn').getAttribute('aria-label');
    t.check('the play/pause media key toggles playback', before !== after, `${before} → ${after}`);
    if (after === 'Lecture') await win.locator('.play-btn').click();
  }

  // ── statistics (needs some listening: 25 s)
  await sleep(25000);
  await gotoNav(win, 'Statistiques');
  await sleep(800);
  const tiles = await win.locator('.stat-tile .stat-value').allInnerTexts();
  t.check('statistics: listening time and plays counted', tiles.length >= 4 && !/^0/.test(tiles[0]) && (await win.locator('.stat-rank tr').count()) >= 1, tiles.slice(0, 3).join(' | '));
  await win.screenshot({ path: join(shots, 'features-stats.png') });

  // ── skins
  for (const skin of ['signal', 'platine']) {
    await gotoNav(win, 'Paramètres');
    await win.locator(`.skin-card:has-text("${skin === 'signal' ? 'Signal' : 'Platine'}")`).click();
    await gotoNav(win, 'Accueil');
    await sleep(1200);
    t.check(`skin ${skin} applied`, (await win.evaluate(() => document.documentElement.dataset.skin)) === skin);
    await win.screenshot({ path: join(shots, `features-skin-${skin}.png`) });
  }
  await win.locator('.np-text').screenshot({ path: join(shots, 'features-np-platine.png') });

  // ── mini player
  const normal = await bounds();
  await win.locator('.mini-open').click();
  await sleep(900);
  const small = await bounds();
  t.check('mini player: small window', small.width <= 340 && (await win.locator('.app.mini').count()) === 1, `${small.width}×${small.height}`);
  const visible = async (sel) => (await win.locator(sel).first().isVisible().catch(() => false));
  const controls = await Promise.all(['.play-btn', 'button[aria-label="Suivant"]', 'button[aria-label="Précédent"]', 'button[aria-label="Lecture aléatoire"]', '.transport-buttons button[aria-pressed]:not(.bar-tab-btn)', 'button[aria-label="File d’attente"]', '.mini-expand', '.living-cover'].map(visible));
  t.check('cover, play/pause, next/previous, shuffle, repeat, queue and "Agrandir" visible', controls.every(Boolean), controls.join(','));
  t.check('the rest is hidden (tabs, menu, volume)', !(await visible('.tabstrip')) && !(await visible('.nav')) && !(await visible('.volume')));
  await win.screenshot({ path: join(shots, 'features-mini.png') });
  await win.locator('.mini-expand').click();
  await sleep(900);
  const back = await bounds();
  t.check('"Agrandir" restores the normal window', Math.abs(back.width - normal.width) < 4 && (await win.locator('.app.mini').count()) === 0, `${back.width}×${back.height}`);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'features-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
