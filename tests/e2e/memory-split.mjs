// Splits memory cost: is it playback itself, or the page/animations on screen? npm run build first.
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'chud-mem-'));
const app = await electron.launch({
  args: [join(root, 'out/main/index.js'), ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : []), join(root, 'tests/fixtures/music/Fractale.flac')],
  env: { ...process.env, CHUD_USER_DATA: profile },
});
const win = await app.firstWindow();
await win.waitForSelector('.playerbar');

async function snap(label) {
  await sleep(6000);
  const m = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ type: x.type, mb: Math.round(x.memory.workingSetSize / 1024), priv: Math.round((x.memory.privateBytes ?? 0) / 1024) })));
  const total = m.reduce((s, x) => s + x.mb, 0);
  const priv = m.reduce((s, x) => s + x.priv, 0);
  console.log(`${label.padEnd(36)} working set ${String(total).padStart(4)} MB | private ${String(priv).padStart(4)} MB | ${m.map((x) => `${x.type}:${x.mb}/${x.priv}`).join(' ')}`);
}

await snap('file tab, playing');
await win.locator('.play-btn').click(); // pause
await snap('file tab, paused');
await win.locator('.nav-item:has-text("Accueil")').click();
await snap('home, paused');
await win.locator('.play-btn').click(); // resume
await snap('home, playing');
await win.evaluate(() => window.chud.settings.set({ effects: 'off' }).then(() => (document.documentElement.dataset.effects = 'off')));
await snap('home, playing, effects off');
await win.evaluate(() => document.querySelector('.app').style.display = 'none');
await snap('playing, UI hidden (display:none)');
await app.close();
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
