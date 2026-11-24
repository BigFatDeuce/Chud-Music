// Ad blocker lists (needs Internet): taken from uBlock Origin's catalogue, re-checked with
// conditional requests, rebuilt and swapped live when a list changes upstream, and really
// blocking in the YouTube session (and only there).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, launch, sleep, tempDir } from './harness.mjs';

const t = createSuite('adblock');
const profile = tempDir('chud-adblock-');
const cache = join(profile, 'Cache', 'adblock');
let app, win;
const status = () => win.evaluate(() => window.chud.adblock.status());
const waitFor = async (fn, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
};
/** Fetches a URL from inside a session; "blocked" when the blocker cancelled it. */
const tryFetch = (partition, url) =>
  app.evaluate(async ({ session }, [p, u]) => {
    try {
      const r = await session.fromPartition(p).fetch(u, { cache: 'no-store' });
      return `HTTP ${r.status}`;
    } catch (e) {
      return /BLOCKED_BY_CLIENT/.test(String(e)) ? 'blocked' : `error ${String(e).slice(0, 80)}`;
    }
  }, [partition, url]);

try {
  ({ app, win } = await launch(profile));
  await sleep(1500);
  const idle = await status();
  t.check('nothing downloaded before YouTube Music is used', idle.waiting && !idle.active && !idle.lists.length);
  await win.evaluate(() => window.chud.adblock.warm());
  const first = await waitFor(async () => {
    const s = await status();
    return s.active && !s.checking && s.lists.length ? s : null;
  });
  t.check('engine built from uBlock Origin’s catalogue', !!first && first.lists.length >= 7 && first.filters > 100000, first && `${first.lists.length} lists, ${first.filters} filters`);
  const ids = first?.lists.map((l) => l.id) ?? [];
  t.check('main lists present (uBlock filters, quick fixes, EasyList, EasyPrivacy)', ['ublock-filters', 'ublock-quick-fixes', 'easylist', 'easyprivacy'].every((x) => ids.includes(x)), ids.join(', '));

  const ad = await tryFetch('persist:youtube', 'https://googleads.g.doubleclick.net/pagead/id');
  t.check('an ad request is blocked in the YouTube session', ad === 'blocked', ad);
  const other = await tryFetch('persist:youtube', 'https://www.youtube.com/iframe_api');
  t.check('the YouTube player script is not blocked', other.startsWith('HTTP 2'), other);
  const app0 = await tryFetch('', 'https://googleads.g.doubleclick.net/pagead/id');
  t.check('the rest of the app is not filtered', app0 !== 'blocked', app0);

  // nothing changed upstream: conditional requests, no rebuild
  const t0 = Date.now();
  const rebuilt = await win.evaluate(() => window.chud.adblock.check());
  const s1 = await status();
  t.check('re-check with nothing new: no rebuild', rebuilt === false && s1.listsUpdatedAt === first.listsUpdatedAt && s1.listsCheckedAt > first.listsCheckedAt, `${Date.now() - t0} ms`);

  // simulate uBlock Origin publishing a new version of a list: our cached copy is now stale
  const mf = join(cache, 'manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  m.sources['ublock-quick-fixes'].etag = '"stale"';
  m.sources['ublock-quick-fixes'].lastModified = 'Thu, 01 Jan 2015 00:00:00 GMT';
  writeFileSync(mf, JSON.stringify(m));
  writeFileSync(join(cache, 'lists', 'ublock-quick-fixes.txt'), '! old version\n'.repeat(20));
  const rebuilt2 = await win.evaluate(() => window.chud.adblock.check());
  const s2 = await status();
  t.check('a list changed upstream: downloaded and engine rebuilt', rebuilt2 === true && s2.listsUpdatedAt > first.listsUpdatedAt, new Date(s2.listsUpdatedAt).toISOString());
  const ad2 = await tryFetch('persist:youtube', 'https://googleads.g.doubleclick.net/pagead/id');
  t.check('new engine swapped in live, still blocking', s2.active && ad2 === 'blocked', ad2);
  t.check('fresh copy saved', readFileSync(join(cache, 'lists', 'ublock-quick-fixes.txt'), 'utf8').length > 1000);

  // switch off / on
  await win.evaluate(() => window.chud.settings.set({ adblock: false }));
  await sleep(300);
  const off = await tryFetch('persist:youtube', 'https://googleads.g.doubleclick.net/pagead/id');
  await win.evaluate(() => window.chud.settings.set({ adblock: true }));
  await sleep(300);
  const on = await tryFetch('persist:youtube', 'https://googleads.g.doubleclick.net/pagead/id');
  t.check('switching off really stops blocking, on resumes it', off !== 'blocked' && on === 'blocked', `${off} / ${on}`);
  await app.close();

  // restart: the saved engine is used at once, then re-checked
  ({ app, win } = await launch(profile));
  const s3 = await waitFor(async () => {
    const s = await status();
    return s.active ? s : null;
  }, 15000);
  t.check('after a restart the saved engine is active', !!s3 && s3.filters > 100000);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
