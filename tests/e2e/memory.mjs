// Memory profile of the real app per effects level (idle and playing). npm run build first.
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = join(root, 'tests/fixtures/music/Fractale.flac');

async function measure(label, effects, play) {
  const profile = mkdtempSync(join(tmpdir(), 'chud-mem-'));
  const app = await electron.launch({ args: [join(root, 'out/main/index.js'), ...(play ? [file] : [])], env: { ...process.env, CHUD_USER_DATA: profile } });
  const win = await app.firstWindow();
  await win.waitForSelector('.playerbar');
  await win.evaluate((e) => window.chud.settings.set({ effects: e }).then(() => (document.documentElement.dataset.effects = e)), effects);
  await sleep(4000);
  await app.evaluate(({ app }) => app.getAppMetrics()); // first CPU sample is always 0
  await sleep(4000);
  const m = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ type: x.type, mb: Math.round(x.memory.workingSetSize / 1024), cpu: +x.cpu.percentCPUUsage.toFixed(1) })));
  await app.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  const total = m.reduce((s, x) => s + x.mb, 0);
  const cpu = m.reduce((s, x) => s + x.cpu, 0);
  console.log(`${label.padEnd(26)} total ${String(total).padStart(4)} MB  cpu ${cpu.toFixed(1)}%  ${m.map((x) => `${x.type}:${x.mb}`).join(' ')}`);
}

for (const effects of process.argv[2] ? [process.argv[2]] : ['full', 'reduced', 'off']) {
  await measure(`idle, effects=${effects}`, effects, false);
  await measure(`playing, effects=${effects}`, effects, true);
}
