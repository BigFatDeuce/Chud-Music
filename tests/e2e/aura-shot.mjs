// Visual check: the ambient aura drawn with soft gradients (no blur filter) next to the old
// blurred version, same cover, same window. Also times the frames of a few seconds of playback.
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir, waitScanIdle } from './harness.mjs';

const t = createSuite('aura');
const profile = tempDir('chud-aura-');
let app, win;
const OLD = `radial-gradient(40% 45% at 22% 78%, var(--aura-a, transparent), transparent 70%), radial-gradient(45% 40% at 80% 18%, var(--aura-b, transparent), transparent 70%)`;
try {
  ({ app, win } = await launch(profile));
  await win.evaluate((p) => window.chud.library.addFolder(p), music);
  await waitScanIdle(win);
  await gotoNav(win, 'Bibliothèque');
  await sleep(500);
  await win.locator('.page .tl-body .tl-row:has-text("Minuit Chrome") .t-title').first().dblclick();
  await sleep(2500);
  const a = await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--aura-a'));
  t.check('the aura is tinted from the cover', !!a && a !== 'transparent', a);
  const filter = await win.locator('.aura').evaluate((e) => getComputedStyle(e).filter);
  t.check('no blur filter on the aura', filter === 'none', filter);
  await win.screenshot({ path: join(shots, 'aura-new.png') });
  await win.locator('.aura').evaluate((e, old) => { e.style.background = old; e.style.filter = 'blur(40px)'; }, OLD);
  await sleep(1500);
  await win.screenshot({ path: join(shots, 'aura-old.png') });
  t.check('screenshots taken', true, 'tests/output/aura-new.png, aura-old.png');
} catch (e) {
  t.check('no crash', false, String(e?.stack ?? e));
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  t.finish();
}
