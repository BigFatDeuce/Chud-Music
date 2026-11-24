import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { FiltersEngine } from '@ghostery/adblocker';

// Builds the ad-blocking engine off the main thread: parsing ~6 MB of filter lists allocates a
// lot of short-lived memory. The main process only receives the compact serialized engine, and
// this thread's memory goes back to the system when it exits.

export interface BuildRequest {
  lists: string[];
  resources: string | null;
}

// The session only ever shows YouTube's embedded player: every network rule is kept, but
// cosmetic rules and scriptlets only when they target YouTube (they are most of the engine's
// memory otherwise). Generic cosmetic rules (no domain) are not loaded either.
const COSMETIC = /^([^#\s]*)#[@?$]{0,2}#/;

export function forYouTube(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const m = COSMETIC.exec(line);
      return !m || /youtube|ytimg/.test(m[1]!);
    })
    .join('\n');
}

async function run(): Promise<void> {
  const req = workerData as BuildRequest;
  const texts = await Promise.all(req.lists.map((f) => readFile(f, 'utf8')));
  const engine = FiltersEngine.parse(texts.map(forYouTube).join('\n'), { loadCosmeticFilters: true, loadNetworkFilters: true, loadGenericCosmeticsFilters: false });
  if (req.resources) {
    const res = await readFile(req.resources, 'utf8');
    engine.updateResources(res, String(res.length));
  }
  const out = engine.serialize();
  parentPort!.postMessage(out, [out.buffer as ArrayBuffer]);
}

if (parentPort) void run();
