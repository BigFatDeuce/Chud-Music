// Windows integration and robustness: taskbar thumbnail buttons, recovery after the interface
// process crashes, errors written to the local log file.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, elapsed, launch, music, npTitle, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('windows');
const profile = tempDir('chud-win-');
const logFile = join(profile, 'logs', 'chud.log');
let app, win;
const thumbar = () => win.evaluate(() => window.chud.taskbar.state());
const command = (cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('player:command', c), cmd);

try {
  ({ app, win } = await launch(profile, [join(music, '01 - Minuit Chrome.mp3'), join(music, 'Fractale.flac')]));
  await sleep(2500);
  t.check('taskbar buttons show "pause" while playing', (await thumbar()) === 'true|true', await thumbar());
  await command('toggle');
  await sleep(600);
  t.check('taskbar play/pause button pauses', (await win.locator('.play-btn[aria-label="Lecture"]').count()) === 1 && (await thumbar()) === 'false|true');
  await command('next');
  await sleep(1500);
  t.check('taskbar "next" button plays the next track', (await npTitle(win)) === 'Fractale', await npTitle(win));
  t.check('startup written to the log', existsSync(logFile) && /Chud Music .* starting/.test(readFileSync(logFile, 'utf8')));

  // an error in the interface goes to the log file
  await win.evaluate(() => setTimeout(() => { throw new Error('erreur de test 42'); }));
  await sleep(500);
  t.check('interface errors written to the log', readFileSync(logFile, 'utf8').includes('erreur de test 42'));

  // the interface process crashes: the window comes back by itself
  const before = await elapsed(win);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  // the crashed page object is dead for Playwright: query the reloaded page from the main process
  const page = (js) => app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code), js);
  let back = false;
  for (let i = 0; i < 50 && !back; i++) {
    await sleep(300);
    back = await page("!!document.querySelector('.playerbar')").catch(() => false);
  }
  await sleep(1000);
  t.check('after an interface crash the window reloads by itself', back && (await page('location.search')) === '?recovered=1');
  t.check('and says so (toast with the log)', await page("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('L’interface a redémarré'))"));
  const title = await page("document.querySelector('.np-title')?.textContent");
  t.check('playback state restored (same track, paused)', title === 'Fractale' && (await page("!!document.querySelector('.play-btn[aria-label=Lecture]')")), `${title} (was at ${before}s)`);
  t.check('the crash is in the log', /interface process gone: (crashed|killed)/.test(readFileSync(logFile, 'utf8')));
  await app.evaluate(async ({ BrowserWindow }, f) => require('node:fs').writeFileSync(f, (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()), join(shots, 'windows-recovered.png')).catch(() => {});
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
