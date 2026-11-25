// Update check against GitHub releases. Run on the packaged app for the in-app part:
//   CHUD_EXE="dist/win-unpacked/Chud Music.exe" node tests/e2e/updates.mjs
// 1. the real repository (needs Internet): nothing newer published → "à jour";
// 2. a local fake release (latest.yml + installer + our signature): found, downloaded, SHA-512 and
//    signature checked, ready; the same installer without a signature, or with one made by
//    another key, is refused (the releases page is offered instead);
// 3. a release without latest.yml: found through the GitHub API, the button opens the page.
// Nothing is ever installed by this test.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, root, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('updates');
const packaged = !!process.env.CHUD_EXE;
let app, win, server;
const status = () => win.evaluate(() => window.chud.updates.status());
const waitState = async (states, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await status();
    if (states.includes(s.state)) return s;
    await sleep(250);
  }
  return status();
};
const profiles = [];
const fresh = () => {
  const p = tempDir('chud-upd-');
  profiles.push(p);
  return p;
};

try {
  // ── 1. real repository
  ({ app, win } = await launch(fresh()));
  await win.evaluate(() => window.chud.updates.check());
  const real = await waitState(['none', 'available', 'error']);
  t.check('real GitHub repository checked', real.state === 'none' || real.state === 'available', `${real.state}${real.version ? ' ' + real.version : ''}${real.error ? ' ' + real.error : ''}`);
  await gotoNav(win, 'Paramètres');
  await win.locator('.settings-group:has(h3:text-is("Mises à jour"))').scrollIntoViewIfNeeded();
  t.check('settings show the result', /est à jour|est disponible/.test(await win.locator('.settings-group:has(h3:text-is("Mises à jour")) .setting-row b').first().innerText()));
  await win.locator('.settings-group:has(h3:text-is("Mises à jour"))').screenshot({ path: join(shots, 'updates-01-real.png') });
  await app.close();

  // ── local fake releases
  // a stand-in installer (never run: nothing is installed by this test)
  const installer = join(tempDir('chud-upd-feed-'), 'Chud-Music-Setup-9.9.0.exe');
  profiles.push(join(installer, '..'));
  writeFileSync(installer, Buffer.from(Array.from({ length: 4_000_000 }, (_, i) => (i * 7919) & 255)));
  const body = readFileSync(installer);
  const sha512 = createHash('sha512').update(body).digest('base64');
  const size = body.length;
  // a test key stands for the release key: the isolated test profile may use it (CHUD_UPDATE_PUBKEY)
  const key = generateKeyPairSync('ed25519');
  const intruder = generateKeyPairSync('ed25519');
  process.env.CHUD_UPDATE_PUBKEY = key.publicKey.export({ type: 'spki', format: 'pem' });
  const signed = (k) => sign(null, Buffer.from(`chud-music-update:v1
9.9.0
${sha512}
`), k.privateKey).toString('base64');
  let sigMode = 'good';
  const yml = `version: 9.9.0\nfiles:\n  - url: Chud-Music-Setup-9.9.0.exe\n    sha512: ${sha512}\n    size: ${size}\npath: Chud-Music-Setup-9.9.0.exe\nsha512: ${sha512}\nreleaseDate: '2026-11-04T00:00:00.000Z'\nreleaseNotes: Version de test\n`;
  const api = JSON.stringify({ tag_name: 'v9.9.1', name: 'Chud Music 9.9.1', body: 'Notes', html_url: 'https://github.com/BigFatDeuce/Chud-Music/releases/tag/v9.9.1' });
  const served = [];
  server = createServer((req, res) => {
    req.url = req.url.split('?')[0]; // electron-updater adds ?noCache=…
    served.push(req.url);
    if (req.url === '/feed/latest.yml') return res.end(yml);
    if (req.url === '/feed/Chud-Music-Setup-9.9.0.exe') {
      res.setHeader('content-length', size);
      return res.end(body);
    }
    if (req.url === '/feed/Chud-Music-Setup-9.9.0.exe.sig' && sigMode !== 'none') return res.end(`${signed(sigMode === 'good' ? key : intruder)}
`);
    if (req.url === '/api/latest') return res.end(api);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  if (packaged) {
    // ── 2. in-app: found, downloaded, ready to install
    process.env.CHUD_UPDATE_FEED = `${base}/feed/`;
    ({ app, win } = await launch(fresh()));
    await win.evaluate(() => window.chud.updates.check());
    const av = await waitState(['available', 'none', 'error']);
    t.check('newer version found in the release feed', av.state === 'available' && av.version === '9.9.0' && av.inApp, JSON.stringify({ state: av.state, v: av.version, inApp: av.inApp, err: av.error }));
    t.check('toast offers "Mettre à jour"', (await win.locator('.toast:has-text("9.9.0") button:has-text("Mettre à jour")').count()) === 1);
    await win.locator('.toast button:has-text("Mettre à jour")').click();
    const dl = await waitState(['downloaded', 'error', 'available'], 120000);
    t.check('downloaded in the app, SHA-512 and signature verified', dl.state === 'downloaded' && served.includes('/feed/Chud-Music-Setup-9.9.0.exe.sig'), `${dl.state} ${dl.error ?? ''}`);
    t.check('then offers to restart and install', (await win.locator('.toast:has-text("prête") button:has-text("Redémarrer")').count()) === 1);
    await gotoNav(win, 'Paramètres');
    await win.locator('.settings-group:has(h3:text-is("Mises à jour"))').scrollIntoViewIfNeeded();
    await win.locator('.settings-group:has(h3:text-is("Mises à jour"))').screenshot({ path: join(shots, 'updates-02-ready.png') });
    t.check('settings: "Redémarrer et installer"', (await win.locator('button:has-text("Redémarrer et installer")').count()) === 1);
    await app.close();

    // ── 2b. the same installer without our signature, then signed by another key: refused
    for (const mode of ['none', 'wrong']) {
      sigMode = mode;
      ({ app, win } = await launch(fresh()));
      await win.evaluate(() => window.chud.updates.check());
      await waitState(['available', 'none', 'error']);
      await win.evaluate(() => window.chud.updates.download());
      const end = await status(); // the call returns once downloaded and checked
      t.check(`${mode === 'none' ? 'no signature' : 'signed by another key'}: not offered for install`, end.state === 'available' && !end.inApp && /signature/.test(end.error ?? ''), `${end.state} inApp=${end.inApp} ${end.error ?? ''}`);
      t.check(`${mode === 'none' ? 'no signature' : 'signed by another key'}: no "Redémarrer"`, (await win.locator('button:has-text("Redémarrer")').count()) === 0);
      if (mode === 'wrong') {
        await gotoNav(win, 'Paramètres');
        await win.locator('.settings-group:has(h3:text-is("Mises à jour"))').scrollIntoViewIfNeeded();
        await win.locator('.settings-group:has(h3:text-is("Mises à jour"))').screenshot({ path: join(shots, 'updates-03-refused.png') });
      }
      await app.close();
    }
    sigMode = 'good';
  } else {
    console.log('INFO  in-app download only runs on the packaged app (set CHUD_EXE)');
  }

  // ── 3. release without latest.yml: GitHub API + releases page
  process.env.CHUD_UPDATE_FEED = `${base}/empty/`;
  process.env.CHUD_RELEASES_API = `${base}/api/latest`;
  ({ app, win } = await launch(fresh()));
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (u) => void globalThis.__opened.push(u);
  });
  await win.evaluate(() => window.chud.updates.check());
  const fb = await waitState(['available', 'none', 'error']);
  t.check('found through the GitHub API when there is no latest.yml', fb.state === 'available' && fb.version === '9.9.1' && !fb.inApp, `${fb.state} ${fb.version}`);
  await gotoNav(win, 'Paramètres');
  await win.locator('button:has-text("Télécharger sur GitHub")').click();
  await sleep(300);
  const opened = await app.evaluate(() => globalThis.__opened);
  t.check('the button opens the release page on GitHub', opened[0] === 'https://github.com/BigFatDeuce/Chud-Music/releases/tag/v9.9.1', opened.join(' '));
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  server?.close();
  cleanup(...profiles);
  // electron-updater keeps the stand-in installer in the user's own updater cache (shared with an
  // installed Chud Music): take it back out
  const pending = join(process.env.LOCALAPPDATA ?? '', 'chud-music-updater', 'pending');
  try {
    for (const f of readdirSync(pending)) if (/9.9.0/.test(f) || f === 'update-info.json') rmSync(join(pending, f), { force: true });
  } catch {}
  process.exit(t.finish() ? 1 : 0);
}
