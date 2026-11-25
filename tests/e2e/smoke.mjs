// Files opened individually, tabs, playback, skins, restart. Uses an isolated profile.
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, elapsed, gotoNav, gotoTab, launch, music, npTitle, secondInstance, shots, sleep, tabLabels, tempDir } from './harness.mjs';

const t = createSuite('smoke');
const profile = tempDir('chud-e2e-');
const scratch = tempDir('chud-e2e-files-');
const f = (n) => join(music, n);
let app, win;

try {
  const OPENED = 'Fichiers ouverts';
  const filesTabs = async () => (await tabLabels(win)).filter((l) => l === OPENED).length;
  const rowCount = () => win.locator('.page .tl-body .tl-row').count();

  // 1 — launched by Windows with a file (double-click in Explorer)
  ({ app, win } = await launch(profile, [f('01 - Minuit Chrome.mp3')]));
  await win.waitForSelector(`.tab.active >> text=${OPENED}`, { timeout: 10000 });
  await sleep(2500);
  t.check('launch file opens in "Fichiers ouverts"', (await filesTabs()) === 1 && (await rowCount()) === 1);
  t.check('launch file plays automatically', (await npTitle(win)) === 'Minuit Chrome' && (await elapsed(win)) >= 1, `${await npTitle(win)}, badges: ${(await win.locator('.np-badges').allInnerTexts()).join(' ')}, t=${await elapsed(win)}s`);
  t.check('metadata + cover read', (await win.locator('.np-artist').innerText()).includes('Les Cassettes') && (await win.locator('.np-cover img').count()) === 1);
  await win.screenshot({ path: join(shots, '01-launch-file.png') });

  // 2 — more files double-clicked while playing → forwarded, added to the SAME tab
  // (far enough apart to arrive as two batches: still a single offer to play)
  const tBefore = await elapsed(win);
  await Promise.all([secondInstance(profile, f('Fractale.flac')), sleep(900).then(() => secondInstance(profile, f('Verre Bleu (ALAC).m4a')))]);
  await win.waitForFunction(() => document.querySelectorAll('.page .tl-body .tl-row').length === 3, null, { timeout: 10000 });
  await sleep(800);
  const labels2 = await tabLabels(win);
  t.check('second instance forwards files (no new window)', app.windows().length === 1, labels2.join(' | '));
  t.check('files opened in several times pile up in one tab', (await filesTabs()) === 1 && (await rowCount()) === 3, labels2.join(' | '));
  t.check('current playback NOT interrupted', (await npTitle(win)) === 'Minuit Chrome' && (await elapsed(win)) > tBefore, `${tBefore}s → ${await elapsed(win)}s`);
  t.check('user offered to play the new files', (await win.locator('.toast >> text=Lire').count()) === 1 && /2/.test(await win.locator('.toast', { hasText: 'Lire' }).innerText()), (await win.locator('.toast').allInnerTexts()).join(' / ').slice(0, 200));
  await win.screenshot({ path: join(shots, '02-second-instance.png') });

  // 3 — play them from the toast: starts at the first new file
  await win.locator('.toast button:has-text("Lire")').click();
  await sleep(2000);
  t.check('toast action plays the first new file', (await npTitle(win)) === 'Fractale');

  // 4 — ALAC goes through FFmpeg
  await win.locator('.tl-row:has-text("Verre Bleu")').locator('.t-title').dblclick();
  await sleep(2500);
  t.check('ALAC plays through FFmpeg fallback', (await npTitle(win)) === 'Verre Bleu' && (await win.locator('.np-badges >> text=FFmpeg').count()) === 1 && (await elapsed(win)) >= 1, `${await npTitle(win)}, badges: ${(await win.locator('.np-badges').allInnerTexts()).join(' ')}, t=${await elapsed(win)}s`);

  // 5 — the same file opened again is not duplicated
  await secondInstance(profile, f('01 - Minuit Chrome.mp3'));
  await sleep(1500);
  t.check('a file opened twice is not duplicated', (await filesTabs()) === 1 && (await rowCount()) === 3);

  // 6 — WMA, untagged file, corrupt file, file that disappears: same tab again
  copyFileSync(f('Fractale.flac'), join(scratch, 'Disparu.flac'));
  writeFileSync(join(scratch, 'Corrompu.mp3'), 'ceci n’est pas de l’audio'.repeat(200));
  await secondInstance(profile, f('Media Classique.wma'), f('Artiste Mystère - Sans Tags.mp3'), join(scratch, 'Corrompu.mp3'), join(scratch, 'Disparu.flac'));
  await win.waitForFunction(() => document.querySelectorAll('.page .tl-body .tl-row').length === 7, null, { timeout: 10000 });
  await win.waitForFunction(() => !document.querySelector('.page .tl-row.pending'), null, { timeout: 15000 }); // tags read
  t.check('a batch of 4 files joins the same tab', (await filesTabs()) === 1 && (await rowCount()) === 7);
  t.check('untagged file: title/artist guessed from filename', (await win.locator('.tl-row:has-text("Sans Tags") .t-artist').innerText()) === 'Artiste Mystère');
  // playback follows the grown list: "next" from Verre Bleu reaches the new files
  await win.locator('.toast .icon-btn[aria-label="Fermer"]').first().click().catch(() => {});
  await win.locator('button[aria-label="Suivant"]').click();
  await sleep(2500);
  t.check('playing list follows the tab as it grows', (await npTitle(win)) === 'Média Classique', await npTitle(win));
  t.check('WMA plays through FFmpeg fallback', (await npTitle(win)) === 'Média Classique' && (await elapsed(win)) >= 1);
  await win.locator('.tl-row:has-text("Corrompu")').locator('.t-title').dblclick();
  // the corrupt file is tried natively, then through FFmpeg, then skipped: wait for that (slower on Linux/WSL)
  await win.waitForFunction(() => !!document.querySelector('.tl-row.unavailable .badge.warn') && document.querySelector('.np-title')?.textContent === 'Fractale', null, { timeout: 15000 }).catch(() => {});
  await sleep(500);
  const afterCorrupt = await npTitle(win);
  // Disparu.flac is a copy of Fractale.flac, so its tag title is "Fractale"
  t.check('corrupt file: error shown, marked, skipped — no crash', (await win.locator('.tl-row:has-text("Corrompu") .badge.warn').count()) === 1 && afterCorrupt === 'Fractale' && (await win.locator('.tl-row.current').count()) === 1, `now playing: ${afterCorrupt}; row: ${await win.locator('.tl-row:has-text("Corrompu")').first().innerText().catch(() => '?')}; current: ${await win.locator('.tl-row.current').count()}`);

  // Delete takes a file out of the tab, never off the disk
  await win.locator('.tl-row:has-text("Sans Tags")').locator('.t-title').click();
  await win.keyboard.press('Delete');
  await sleep(500);
  t.check('Delete removes the file from the tab only', (await rowCount()) === 6 && (await win.locator('.tl-row:has-text("Sans Tags")').count()) === 0 && existsSync(f('Artiste Mystère - Sans Tags.mp3')));

  // reorder "Fichiers ouverts": Alt+↑/↓, right-click › Monter / Descendre, drag & drop; playback follows
  const order = () => win.locator('.page .tl-body .tl-row .t-title').allInnerTexts();
  const playingBefore = await npTitle(win);
  let o0 = await order();
  await win.locator('.page .tl-body .tl-row').nth(1).locator('.t-title').click();
  await win.keyboard.press('Alt+ArrowUp');
  await sleep(300);
  let o1 = await order();
  t.check('Alt+↑ moves the selected file up, it stays selected', o1[0] === o0[1] && o1[1] === o0[0] && (await win.locator('.page .tl-body .tl-row').nth(0).getAttribute('aria-selected')) === 'true', o1.join(' | '));
  await win.keyboard.press('Alt+ArrowDown');
  await sleep(300);
  t.check('Alt+↓ moves it back down', JSON.stringify(await order()) === JSON.stringify(o0));
  const lastRow = win.locator('.page .tl-body .tl-row').nth(o0.length - 1);
  await lastRow.click({ button: 'right' });
  const downDisabled = await win.locator('.menu .menu-item:has-text("Descendre")').isDisabled();
  await win.locator('.menu .menu-item:has-text("Monter")').click();
  await sleep(300);
  o1 = await order();
  t.check('right-click › Monter (Descendre disabled on the last row)', downDisabled && o1[o0.length - 2] === o0[o0.length - 1] && o1[o0.length - 1] === o0[o0.length - 2], o1.join(' | '));
  const rowsL = win.locator('.page .tl-body .tl-row');
  await rowsL.nth(0).dragTo(rowsL.nth(3), { targetPosition: { x: 200, y: 4 } });
  await sleep(400);
  const o2 = await order();
  t.check('drag & drop reorders the tab', o2[2] === o1[0] && o2[0] === o1[1], o2.join(' | '));
  t.check('playback not interrupted by the reordering, current row still marked', (await npTitle(win)) === playingBefore && (await win.locator('.tl-row.current').count()) === 1, await npTitle(win));
  const reordered = o2;

  // 7 — skins
  for (const [skin, name] of [['cassette', 'Cassette 98'], ['aqua', 'Aqua Glow'], ['nocturne', 'Chud Nocturne']]) {
    await gotoNav(win, 'Paramètres');
    await win.locator(`.skin-card:has-text("${name}")`).click();
    await gotoTab(win, OPENED);
    t.check(`skin ${name} applied`, (await win.evaluate(() => document.documentElement.dataset.skin)) === skin);
    await win.screenshot({ path: join(shots, `06-skin-${skin}.png`) });
  }

  const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, mb: Math.round(m.memory.workingSetSize / 1024) })));
  const totalMb = metrics.reduce((s, m) => s + m.mb, 0);
  console.log(`INFO  memory while playing (working set, all processes): ${totalMb} MB — ${metrics.map((m) => `${m.type}:${m.mb}`).join(', ')}`);
  t.check('memory regression guard (< 1 GB working set)', totalMb < 1024, `${totalMb} MB`);

  const before = await tabLabels(win);
  await app.close();

  // 8 — restart: tabs come back, the deleted file is flagged instead of breaking anything
  unlinkSync(join(scratch, 'Disparu.flac'));
  ({ app, win } = await launch(profile));
  await sleep(1500);
  const after = await tabLabels(win);
  t.check('tabs restored after restart', JSON.stringify(before) === JSON.stringify(after), after.join(' | '));
  t.check('skin restored after restart', (await win.evaluate(() => document.documentElement.dataset.skin)) === 'nocturne');
  t.check('last playback restored (paused) after restart', (await npTitle(win)) !== 'Rien en lecture', await npTitle(win));
  await gotoTab(win, OPENED);
  await win.waitForFunction(() => !document.querySelector('.page .tl-row.pending'), null, { timeout: 15000 }).catch(() => {});
  t.check('the new order of "Fichiers ouverts" is kept after restart', JSON.stringify((await win.locator('.page .tl-body .tl-row .t-title').allInnerTexts()).map((x) => x.replace(/^(Fractale|Disparu)$/, '?'))) === JSON.stringify(reordered.map((x) => x.replace(/^(Fractale|Disparu)$/, '?'))), (await win.locator('.page .tl-body .tl-row .t-title').allInnerTexts()).join(' | '));
  t.check('missing file flagged after restart', (await win.locator('.tl-row:has-text("Disparu") >> text=Fichier introuvable').count()) === 1, (await win.locator('.tl-row:has-text("Disparu"), .tl-row:has-text("Fractale")').allInnerTexts().catch(() => [])).join(' | ').replace(/\s+/g, ' '));
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, scratch);
  process.exit(t.finish() ? 1 : 0);
}
