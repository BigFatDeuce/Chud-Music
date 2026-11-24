// Visual tour: screenshots of the main views with a real library. npm run build first.
import { _electron as electron } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const shots = join(root, 'tests/output/tour');
mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'chud-tour-'));
const lib = mkdtempSync(join(tmpdir(), 'chud-tour-lib-'));
cpSync(join(root, 'tests/fixtures/music'), join(lib, 'Musique'), { recursive: true });

const app = await electron.launch({ args: [join(root, 'out/main/index.js')], env: { ...process.env, CHUD_USER_DATA: profile } });
const win = await app.firstWindow();
const errors = [];
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('.playerbar');
const shot = async (n) => { await sleep(500); await win.screenshot({ path: join(shots, `${n}.png`) }); };

// Canvas UI effects need HTML-in-canvas; report whether it is live and the effect canvases exist
const fx = await win.evaluate(() => {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  return { htmlInCanvas: typeof ctx.drawElementImage === 'function' && typeof c.requestPaint === 'function', webgl2: !!document.createElement('canvas').getContext('webgl2') };
});
console.log('effects support:', fx);
await sleep(800);
await shot('00-home-empty'); // VHS "no signal" screen in the living cover

await win.evaluate((p) => window.chud.library.addFolder(p), lib);
await sleep(2500);
await win.locator('.nav-item:has-text("Bibliothèque")').click();
await shot('01-library-tracks');
await win.locator('.segmented button:has-text("Albums")').click();
await shot('02-library-albums');
await win.locator('.segmented button:has-text("Artistes")').click();
await shot('03-library-artists');
await win.locator('.segmented button:has-text("Titres")').click();
await sleep(400);
await win.locator('.search input').fill('cassettes');
await shot('04-search');
await win.locator('.search input').fill('');

// create a playlist from the context menu
await win.locator('.tl-body .tl-row').first().click({ button: 'right' });
await shot('05-context-menu');
await win.locator('.menu-item:has-text("Ajouter à une playlist")').hover();
await sleep(300);
await win.locator('.menu .menu .menu-item:has-text("Nouvelle playlist")').click();
await win.locator('.dialog input').fill('Synthwave du soir');
await shot('06-dialog');
await win.locator('.dialog button[type=submit]').click();
await sleep(600);
// add all tracks via selection + drag onto the sidebar playlist
await win.locator('.tl-body .tl-row').first().locator('.t-title').click();
await win.keyboard.press('Control+a');
await showPlaylists(win);
await win.locator('.tl-body .tl-row').nth(2).dragTo(win.locator('.side-item:has-text("Synthwave du soir")'));
await sleep(800);
await win.locator('.side-item:has-text("Synthwave du soir")').click();
await sleep(600);
await win.locator('.tl-body .tl-row').nth(1).locator('.t-title').dblclick();
await sleep(1500);
await shot('07-playlist');
// track change: the living cover glitches for ~0.45 s
await win.locator('button[aria-label="Suivant"]').click();
await sleep(120);
await win.screenshot({ path: join(shots, '07b-glitch.png'), clip: { x: 0, y: 380, width: 280, height: 320 } });
await sleep(800);
await win.locator('button[aria-label="File d’attente"]').click();
await shot('08-queue');
await win.locator('button[aria-label="Fermer la file d’attente"]').click();
await win.locator('.nav-item:has-text("Accueil")').click();
await shot('09-home');
await win.locator('.nav-item:has-text("Playlists")').click();
await shot('10-playlists');
await win.locator('.nav-item:has-text("Paramètres")').click();
await shot('11-settings');
for (const [skin, name] of [['cassette', 'Cassette 98'], ['aqua', 'Aqua Glow']]) {
  await win.locator(`.skin-card:has-text("${name}")`).click();
  await win.locator('.nav-item:has-text("Accueil")').click();
  await shot(`12-home-${skin}`);
  await win.locator('.nav-item:has-text("Paramètres")').click();
}
await win.locator('.skin-card:has-text("Chud Nocturne")').click();

console.log('console errors:', errors.length ? errors : 'none');
await app.close();
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
rmSync(lib, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
