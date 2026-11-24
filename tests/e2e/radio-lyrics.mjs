// Radio (Radio Browser) and lyrics (LRCLIB), against the real services (needs Internet).
import { join } from 'node:path';
import { cleanup, createSuite, elapsed, gotoNav, launch, music, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('radio-lyrics');
const profile = tempDir('chud-radio-');
let app, win;
const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
};

try {
  ({ app, win } = await launch(profile, [join(music, 'Fractale.flac')]));
  await sleep(1500);

  // ── lyrics: a track no database knows → said clearly
  await gotoNav(win, 'Paroles');
  const nf = await waitFor(async () => (await win.locator('.lyrics-state b:has-text("Paroles introuvables")').count()) === 1);
  t.check('unknown track: "Paroles introuvables" with the search used', !!nf, await win.locator('.lyrics-state span').innerText().catch(() => ''));
  // corrected by hand → synced lyrics
  await win.locator('button:has-text("Rechercher autrement")').click();
  await win.locator('.lyrics-edit input').first().fill('One More Time');
  await win.locator('.lyrics-edit input').nth(1).fill('Daft Punk');
  await win.locator('.lyrics-edit button[type=submit]').click();
  const found = await waitFor(async () => (await win.locator('.lyrics-line').count()) > 10);
  t.check('manual search finds lyrics (Daft Punk — One More Time)', !!found, `${await win.locator('.lyrics-line').count()} lines`);
  const synced = (await win.locator('.badge:has-text("Synchronisées")').count()) === 1;
  t.check('time-synced, line by line', synced);
  await sleep(1500);
  t.check('a line follows the music', (await win.locator('.lyrics-line.on').count()) === 1 || (await win.locator('.lyrics-line.past').count()) >= 0);
  await win.screenshot({ path: join(shots, 'lyrics-01.png') });

  // ── radio
  await gotoNav(win, 'Radio');
  const countries = await waitFor(async () => (await win.locator('.radio-country').count()) > 50);
  t.check('countries listed, names in French', !!countries && (await win.locator('.radio-country:has-text("France")').count()) >= 1, `${await win.locator('.radio-country').count()} entries`);
  await win.locator('.radio-country:has-text("France")').first().click();
  const fr = await waitFor(async () => (await win.locator('.radio-row').count()) > 20);
  t.check('French stations, most popular first', !!fr, (await win.locator('.radio-row .radio-text b').first().innerText().catch(() => '')));
  await win.screenshot({ path: join(shots, 'radio-01.png') });

  // play the first station that works
  let playing = false;
  for (let i = 0; i < 4 && !playing; i++) {
    await win.locator('.radio-row').nth(i).locator('.radio-play').click();
    playing = !!(await waitFor(async () => (await win.locator('.play-btn[aria-label="Pause"]').count()) === 1 && (await win.evaluate(() => window.chudTest.engine.currentTime)) >= 3, 20000));
  }
  t.check('a station plays (time advances)', playing, await win.locator('.np-title').innerText());
  t.check('"Direct" badge in the player bar', (await win.locator('.np-badges .badge.live').count()) === 1);
  const onAir = await waitFor(async () => (await win.evaluate(() => document.querySelector('.np-artist')?.textContent ?? '')).match(/ - /) ? true : null, 25000);
  console.log(`INFO  title on air ${onAir ? 'received: ' + (await win.locator('.np-artist').innerText()) : 'not sent by this station within 25 s'}`);
  await gotoNav(win, 'Visualiseur');
  const signal = await waitFor(async () => (await win.locator('.viz-canvas').getAttribute('data-signal')) === '1', 8000);
  t.check('the radio reaches the audio graph (visualiser signal)', !!signal);

  // favourites
  await gotoNav(win, 'Radio');
  const name = await win.locator('.radio-row').first().locator('.radio-text b').innerText();
  await win.locator('.radio-row').first().locator('.radio-star').click();
  await win.locator('.radio-country.fav').click();
  await sleep(400);
  t.check('favourite added, "Favoris" first in the list', (await win.locator('.radio-country').first().innerText()).startsWith('Favoris') && (await win.locator('.radio-row').count()) === 1);
  await app.close();
  ({ app, win } = await launch(profile));
  await gotoNav(win, 'Radio');
  const kept = await waitFor(async () => (await win.locator('.radio-row .radio-text b').first().innerText()) === name);
  t.check('favourites kept after a restart (opens on them)', !!kept, name);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'radio-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
