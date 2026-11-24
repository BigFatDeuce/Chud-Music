import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import type { AdblockList, AdblockStatus } from '@shared/types';
import { adblockFlags, adblockMachine, type AdblockEvent, type AdblockPhase } from '@shared/machines';
import { cacheDir } from './paths';
import { ytGuest } from './yt-player';
import type { BuildRequest } from './adblock-worker';
import workerPath from './adblock-worker?modulePath';
import { tr } from '@shared/i18n';

/** Parses the lists in a worker thread; resolves to the serialized engine. */
function build(req: BuildRequest): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath, { workerData: req });
    w.once('message', (bin: Uint8Array) => resolve(bin));
    w.once('error', reject);
    w.once('exit', (code) => code !== 0 && reject(new Error(tr('ab.engineStopped', { code: String(code) }))));
  });
}

// Ad blocking for the YouTube session only: Ghostery's engine fed with uBlock Origin's own
// filter lists, taken from uBlock Origin's catalogue (assets.json) and its CDN, so a list
// uBlock Origin publishes (or a new yearly file it adds) reaches us without an app update.
// Lists are re-checked every hour with conditional requests (ETag / Last-Modified): nothing
// is downloaded when nothing changed; when something did, the engine is rebuilt and swapped
// into the session live. Scriptlet bodies come from Ghostery's resources file (its engine's
// format). The official uBlock Origin extension cannot run in Electron (analysis §P3).
// The status reported to the UI is what actually happened, never a promise.

const CATALOGUE = 'https://raw.githubusercontent.com/gorhill/uBlock/master/assets/assets.json';
const RESOURCES = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
const CHECK_EVERY = 3600 * 1000;
/** uBlock Origin's default lists (no malware/regional ones: the session only plays YouTube). */
const GROUPS = new Set(['default', 'ads', 'privacy']);
/** Used when the catalogue itself cannot be read. */
const FALLBACK: { id: string; title: string; urls: string[] }[] = [
  ['ublock-filters', 'uBlock filters – Ads', 'filters/filters.min.txt'],
  ['ublock-badware', 'uBlock filters – Badware risks', 'filters/badware.min.txt'],
  ['ublock-privacy', 'uBlock filters – Privacy', 'filters/privacy.min.txt'],
  ['ublock-unbreak', 'uBlock filters – Unbreak', 'filters/unbreak.min.txt'],
  ['ublock-quick-fixes', 'uBlock filters – Quick fixes', 'filters/quick-fixes.min.txt'],
  ['easylist', 'EasyList', 'thirdparties/easylist.txt'],
  ['easyprivacy', 'EasyPrivacy', 'thirdparties/easyprivacy.txt'],
].map(([id, title, path]) => ({ id: id!, title: title!, urls: [`https://ublockorigin.github.io/uAssetsCDN/${path}`, `https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/${path}`] }));

interface Cached {
  url: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
}
interface Manifest {
  /** Validators of every cached source (lists, catalogue, resources), by id. */
  sources: Record<string, Cached>;
  lists: AdblockList[];
  builtAt: number | null;
  checkedAt: number | null;
}

let ses: Electron.Session | null = null;
let blocker: ElectronBlocker | null = null;
let notify: (s: AdblockStatus) => void = () => {};
let timer: ReturnType<typeof setInterval> | null = null;
let checking: Promise<boolean> | null = null;
// Where the filter engine is: the states and the events each one takes are the table of
// shared/machines.ts. What the interface shows (active, checking, waiting) follows from it and
// from the "enabled" setting: adblockFlags.
let phase: AdblockPhase = adblockMachine.initial;
/** The only place the engine's state changes; false when the current state does not take the event. */
function go(event: AdblockEvent): boolean {
  const to = adblockMachine.next(phase, event);
  if (!to) return false;
  phase = to;
  return true;
}
const status: Omit<AdblockStatus, 'active' | 'checking' | 'waiting'> = { enabled: true, error: null, blocked: 0, adsSeen: 0, listsUpdatedAt: null, listsCheckedAt: null, lists: [], filters: 0 };

export const adblockStatus = (): AdblockStatus => ({ ...status, ...adblockFlags(phase, status.enabled && !!ses), enabled: status.enabled, lists: [...status.lists] });
const changed = () => notify(adblockStatus());

const dir = () => cacheDir('adblock');
const manifestFile = () => join(dir(), 'manifest.json');
const engineFile = () => join(dir(), 'engine.bin');
const sourceFile = (id: string) => join(dir(), 'lists', `${id.replace(/[^\w.-]/g, '_')}.txt`);

async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(manifestFile(), 'utf8')) as Manifest;
  } catch {
    return { sources: {}, lists: [], builtAt: null, checkedAt: null };
  }
}

/**
 * Downloads one source unless the cached copy is still current (HTTP 304). Tries each mirror
 * in turn. Returns whether the text changed, and the text (from the network or the cache).
 */
async function fetchSource(m: Manifest, id: string, urls: string[]): Promise<{ changed: boolean }> {
  const prev = m.sources[id];
  // the cached copy is only compared when a new one arrives (no 6 MB read on every check)
  const hasCache = !!prev && (await stat(sourceFile(id)).then((s) => s.size > 0, () => false));
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const headers: Record<string, string> = {};
      if (hasCache && prev?.url === url) {
        if (prev.etag) headers['If-None-Match'] = prev.etag;
        if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status === 304 && hasCache) return { changed: false };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length < 100) throw new Error('liste vide');
      const cached = hasCache ? await readFile(sourceFile(id), 'utf8').catch(() => null) : null;
      await mkdir(join(dir(), 'lists'), { recursive: true });
      await writeFile(sourceFile(id), text);
      m.sources[id] = { url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), fetchedAt: Date.now() };
      return { changed: text !== cached };
    } catch (e) {
      lastError = e;
    }
  }
  if (hasCache) return { changed: false }; // offline: keep what we had
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** uBlock Origin's catalogue → the lists it enables by default, with their CDN mirrors. */
async function catalogue(m: Manifest): Promise<{ id: string; title: string; urls: string[] }[]> {
  try {
    await fetchSource(m, 'catalogue', [CATALOGUE]);
    const assets = JSON.parse(await readFile(sourceFile('catalogue'), 'utf8')) as Record<string, { content?: string; group?: string; off?: boolean; title?: string; contentURL?: string | string[]; cdnURLs?: string[] }>;
    const lists = Object.entries(assets)
      .filter(([, a]) => a.content === 'filters' && !a.off && GROUPS.has(a.group ?? ''))
      .map(([id, a]) => ({ id, title: a.title ?? id, urls: [...(a.cdnURLs ?? []), ...[a.contentURL ?? []].flat()].filter((u) => u.startsWith('https://')) }))
      .filter((l) => l.urls.length);
    return lists.length ? lists : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

function attach(next: ElectronBlocker): void {
  next.on('request-blocked', () => {
    status.blocked++;
    changed();
  });
  const old = blocker;
  blocker = next;
  status.filters = next.getFilters().networkFilters.length + next.getFilters().cosmeticFilters.length;
  if (ses && old?.isBlockingEnabled(ses)) old.disableBlockingInSession(ses);
  if (ses && status.enabled) next.enableBlockingInSession(ses);
}

/**
 * Checks every list against its source; rebuilds and swaps the engine if any changed (or if
 * there is no engine yet). Resolves to true when the engine was rebuilt.
 */
export function checkLists(): Promise<boolean> {
  checking ??= (async () => {
    go('CHECK');
    changed();
    try {
      const m = await readManifest();
      const lists = await catalogue(m);
      const results = await Promise.allSettled(lists.map((l) => fetchSource(m, l.id, l.urls)));
      const resources = await fetchSource(m, 'resources', [RESOURCES]).catch(() => null);
      const ok = lists.map((l, i) => ({ l, r: results[i]! })).filter((x) => x.r.status === 'fulfilled') as { l: (typeof lists)[number]; r: PromiseFulfilledResult<{ changed: boolean }> }[];
      if (!ok.length) throw new Error('no list downloaded');
      const listSetChanged = ok.map((x) => x.l.id).join() !== m.lists.map((l) => l.id).join();
      const rebuild = !blocker || listSetChanged || !!resources?.changed || ok.some((x) => x.r.value.changed);
      if (rebuild) {
        const bin = await build({ lists: ok.map((x) => sourceFile(x.l.id)), resources: resources ? sourceFile('resources') : null });
        await writeFile(engineFile(), bin);
        const engine = ElectronBlocker.deserialize(bin);
        m.builtAt = Date.now();
        attach(engine);
      }
      m.lists = ok.map((x) => ({ id: x.l.id, title: x.l.title, updatedAt: m.sources[x.l.id]?.fetchedAt ?? null }));
      m.checkedAt = Date.now();
      await writeFile(manifestFile(), JSON.stringify(m, null, 1));
      Object.assign(status, { lists: m.lists, listsUpdatedAt: m.builtAt, listsCheckedAt: m.checkedAt, error: null });
      go('CHECK_OK');
      return rebuild;
    } catch (e) {
      // offline with an engine already running: keep blocking with the lists we have
      go('CHECK_FAILED');
      if (phase === 'failed') status.error = /fetch|network|ENOTFOUND|timeout|no list/i.test(String(e)) ? tr('ab.offline') : tr('ab.loadFailed', { error: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      checking = null;
      changed();
    }
  })();
  return checking;
}

/**
 * Starts from the engine saved last time (instant, works offline), then checks the lists.
 * With no saved engine (first use), nothing is downloaded or built until YouTube Music is
 * actually used (adblockNeeded): someone who never opens it never pays for the engine.
 */
async function start(): Promise<void> {
  const m = await readManifest();
  try {
    const engine = ElectronBlocker.deserialize(await readFile(engineFile()));
    attach(engine);
    go('LOADED');
    Object.assign(status, { lists: m.lists, listsUpdatedAt: m.builtAt, listsCheckedAt: m.checkedAt });
    changed();
    await checkLists();
  } catch {
    /* first use, or an engine from an older library version: built when YouTube Music is used */
    go('NO_ENGINE');
    changed();
  }
  timer ??= setInterval(() => void (blocker && checkLists()), CHECK_EVERY);
  timer.unref?.();
}

/** YouTube Music is about to be used: build the engine now if it was never built. */
export function adblockNeeded(): void {
  if (blocker || checking) return;
  void checkLists();
}

function apply(): void {
  if (!ses || !blocker) return;
  if (status.enabled && !blocker.isBlockingEnabled(ses)) blocker.enableBlockingInSession(ses);
  if (!status.enabled && blocker.isBlockingEnabled(ses)) blocker.disableBlockingInSession(ses);
  changed();
}

export function initAdblock(youtubeSession: Electron.Session, enabled: boolean, onStatus: (s: AdblockStatus) => void): void {
  ses = youtubeSession;
  notify = onStatus;
  status.enabled = enabled;
  void start();
  // Diagnostic: YouTube's own player marks itself "ad-showing" while an ad runs. Reading that
  // flag is the only honest way to tell whether ads still get through.
  let showing = false;
  setInterval(async () => {
    const wc = ytGuest();
    const frame = wc?.mainFrame.framesInSubtree.find((f) => /youtube(-nocookie)?\.com\/embed\//.test(f.url));
    if (!frame) return;
    const ad = await frame.executeJavaScript(`!!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting')`).catch(() => false);
    if (ad && !showing) {
      status.adsSeen++;
      changed();
    }
    showing = !!ad;
  }, 2000).unref();
}

export function setAdblockEnabled(enabled: boolean): void {
  if (status.enabled === enabled) return;
  status.enabled = enabled;
  apply();
  changed();
}
