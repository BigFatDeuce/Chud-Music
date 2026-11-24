// Startup time: from process launch to an interactive window (player bar rendered), cold
// (fresh profile) and warm (same profile again). Run on the packaged app with CHUD_EXE.
import { cleanup, createSuite, launch, tempDir } from './harness.mjs';

const t = createSuite('startup');
const profile = tempDir('chud-startup-');
const times = [];
try {
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const { app } = await launch(profile);
    times.push(Date.now() - t0);
    await app.close();
  }
  console.log(`INFO  ready in ${times.join(' / ')} ms (first = fresh profile)`);
  const warm = times.slice(1).sort((a, b) => a - b)[1];
  t.check('interactive window in under 3 s (warm, median)', warm < 3000, `${warm} ms`);
  t.check('first launch (fresh profile) in under 5 s', times[0] < 5000, `${times[0]} ms`);
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  cleanup(profile);
  process.exit(t.finish() ? 1 : 0);
}
