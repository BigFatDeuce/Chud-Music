// Gapless joining (src/renderer/src/audio/joiner-worklet.js), without the app: the very file the
// audio thread runs, fed block by block. A ramp cut in two files must come out uncut: every sample
// once, in order, whatever the moment the second file happens to start.
//   node tests/unit/joiner.mjs

const RATE = 48000;
const B = 128;
let Joiner;
let posted;
globalThis.sampleRate = RATE;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class { port = { postMessage: (m) => posted.push({ ...m, frame: globalThis.currentFrame }) }; };
globalThis.registerProcessor = (_n, c) => (Joiner = c);
await import(new URL('../../src/renderer/src/audio/joiner-worklet.js', import.meta.url).href);

let failed = 0;
let count = 0;
const check = (label, ok, detail = '') => {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Plays file a on deck 0 from frame 0, file b on deck 1 from `bAt`. `tell(frame, send)` sends the
 * engine's messages. Returns the output (left channel).
 */
function run(a, b, bAt, total, tell) {
  posted = [];
  const j = new Joiner();
  const out = new Float32Array(total + 2 * B);
  const block = (file, start, f) => {
    const x = new Float32Array(B);
    for (let k = 0; k < B; k++) x[k] = file[f + k - start] ?? 0;
    return [x, x];
  };
  for (let f = 0; f < total + 2 * B; f += B) {
    globalThis.currentFrame = f;
    tell(f, (m) => j.port.onmessage({ data: m }));
    const L = new Float32Array(B);
    const R = new Float32Array(B);
    j.process([block(a, 0, f), block(b, bAt, f)], [[L, R]]);
    out.set(L, f);
  }
  return out.slice(2 * B); // (what is heard is two blocks late)
}
const tone = (n, from = 0) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(((i + from) * 2 * Math.PI * 441.3) / RATE) || 1e-6);
const worst = (out, want, n) => {
  let w = 0;
  for (let k = 0; k < n; k++) w = Math.max(w, Math.abs(out[k] - want[k]));
  return w;
};
/** Once per run, at the first block from frame `at` on. */
const once = (at, m) => {
  let done = false;
  return (f, send) => {
    if (!done && f >= at) {
      done = true;
      send(m);
    }
  };
};
const all = (...fns) => (f, send) => fns.forEach((fn) => fn(f, send));

const whole = tone(6 * RATE);
const cut = 2 * RATE + 37; // not on a block boundary
for (const early of [20011, 7003, 1501, 300]) {
  const bAt = cut - early;
  const a = whole.slice(0, cut);
  const b = whole.slice(cut);
  for (const off of [-2000, 0, 2000]) {
    const out = run(a, b, bAt, 5 * RATE, all(once(0, { t: 'pass', i: 0 }), once(cut - 24000, { t: 'arm', from: 0, to: 1, end: cut + off }), once(bAt, { t: 'onset', frame: bAt + 300 })));
    const w = worst(out, whole, 4.5 * RATE);
    const joined = posted.find((m) => m.t === 'joined');
    check(`second file started ${(early / 48).toFixed(0)} ms early, end expected ${off / 48 > 0 ? '+' : ''}${(off / 48).toFixed(0)} ms off: not a sample lost or repeated`, w < 1e-6 && !!joined, `worst ${w}`);
    if (off === 0) check('…the delay reported is the head start', Math.abs(joined.delay * RATE - early) < 2 * B, `${(joined.delay * RATE).toFixed(0)} / ${early}`);
  }
}

// a file that ends with a real silence keeps it
{
  const a = new Float32Array(2 * RATE);
  a.set(tone(RATE));
  const b = tone(RATE);
  const out = run(a, b, 2 * RATE - 9000, 4 * RATE, all(once(0, { t: 'pass', i: 0 }), once(RATE, { t: 'arm', from: 0, to: 1, end: 2 * RATE }), once(2 * RATE - 9000, { t: 'onset', frame: 2 * RATE - 9000 })));
  let first = RATE + 10;
  while (out[first] === 0) first++;
  check('a second of silence at the end of a track stays (within 60 ms)', Math.abs(first - 2 * RATE) <= 0.06 * RATE + B, `${first - 2 * RATE} frames off`);
}
// a file that begins with a real silence keeps it
{
  const b = new Float32Array(2 * RATE);
  b.set(tone(RATE), RATE / 2);
  const a = tone(2 * RATE);
  const bAt = 2 * RATE - 40000;
  const out = run(a, b, bAt, 5 * RATE, all(once(0, { t: 'pass', i: 0 }), once(RATE, { t: 'arm', from: 0, to: 1, end: 2 * RATE }), once(bAt, { t: 'onset', frame: bAt }), once(2 * RATE + 2 * B, { t: 'ended', i: 0 })));
  let first = 2 * RATE + 10;
  while (out[first] === 0) first++;
  check('half a second of silence at the start of a track stays', Math.abs(first - 2.5 * RATE) < 0.06 * RATE + 4 * B, `${first - 2.5 * RATE} frames off`);
}
// the end of the first element is reported after the switch: it is not the end of the second
{
  const a = whole.slice(0, cut);
  const b = whole.slice(cut);
  const bAt = cut - 15000;
  const out = run(a, b, bAt, 5 * RATE, all(once(0, { t: 'pass', i: 0 }), once(cut - 24000, { t: 'arm', from: 0, to: 1, end: cut }), once(bAt, { t: 'onset', frame: bAt }), once(cut + 4 * B, { t: 'ended', i: 0 })));
  check('the first element’s end, reported late, does not stop the second', worst(out, whole, 4.5 * RATE) < 1e-6 && !posted.some((m) => m.t === 'drained'));
}
// another rate: the browser's filter rings before and after each file; overlaid, it is whole again
{
  const EDGE = 35;
  const h = Float32Array.from({ length: 2 * EDGE + 1 }, (_, i) => {
    const d = i - EDGE;
    const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / (EDGE + 1)) + 0.08 * Math.cos((2 * Math.PI * d) / (EDGE + 1));
    return (d ? Math.sin(0.85 * Math.PI * d) / (Math.PI * d) : 0.85) * w;
  });
  const filter = (x) => {
    const y = new Float32Array(x.length + 2 * EDGE);
    for (let i = 0; i < x.length; i++) for (let k = 0; k < h.length; k++) y[i + k] += x[i] * h[k];
    return y;
  };
  const a = filter(whole.slice(0, cut));
  const b = filter(whole.slice(cut));
  const want = filter(whole);
  let bad = 0;
  for (const slack of [0, -1, 1]) for (let early = 9000; early < 9000 + B; early += 5) {
    const bAt = cut - early;
    const out = run(a, b, bAt, 4 * RATE, all(once(0, { t: 'pass', i: 0 }), once(cut - 24000, { t: 'arm', from: 0, to: 1, end: cut, edges: [EDGE + slack / 2, EDGE] }), once(bAt, { t: 'onset', frame: bAt })));
    // (the edges being known to half a sample, what follows may come one early or late)
    const after = (d) => worst(out.subarray(cut + 3000 + d), want.subarray(cut + 3000), RATE);
    const rough = (x, k) => Math.abs(x[k] - 2 * x[k - 1] + x[k - 2]);
    if (![0, -1, 1].some((d) => after(d) < 1e-4)) bad = 1;
    for (let k = cut - 100; k < cut + 2000; k++) bad = Math.max(bad, rough(out, k) - rough(want, k));
  }
  check('files of another rate: the seam is whole', bad < 0.01, String(bad));
}
// the second file never starts
{
  run(tone(RATE), new Float32Array(0), 0, 4 * RATE, all(once(0, { t: 'pass', i: 0 }), once(RATE / 2, { t: 'arm', from: 0, to: 1, end: RATE }), once(RATE + B, { t: 'ended', i: 0 })));
  check('the second file never comes: said so, after 1.5 s', posted.some((m) => m.t === 'failed' && Math.abs(m.frame - 2.5 * RATE) < 2000));
}
// a delayed file is heard to its end, then said to be
{
  const a = whole.slice(0, cut);
  const b = whole.slice(cut, cut + RATE);
  const bAt = cut - 15000;
  const out = run(a, b, bAt, 6 * RATE, all(once(0, { t: 'pass', i: 0 }), once(cut - 24000, { t: 'arm', from: 0, to: 1, end: cut }), once(bAt, { t: 'onset', frame: bAt }), once(bAt + RATE, { t: 'ended', i: 1 })));
  const drained = posted.find((m) => m.t === 'drained');
  check('a delayed file is heard to its last sample', worst(out, whole, cut + RATE) < 1e-6 && out.slice(cut + RATE + 10).every((x) => x === 0));
  check('…and its end is reported then, not when the element ended', !!drained && drained.frame >= cut + RATE - B && drained.frame < cut + RATE + 4 * B, drained && `${drained.frame - cut - RATE}`);
}
// crossfade: equal power, from one to the other
{
  const a = new Float32Array(3 * RATE).fill(0.5);
  const b = new Float32Array(3 * RATE).fill(0.5);
  const out = run(a, b, RATE, 4 * RATE, all(once(0, { t: 'pass', i: 0 }), once(RATE, { t: 'mix', i: 1, seconds: 1 })));
  check('crossfade: one, then both at equal power, then the other', out[RATE / 2] === 0.5 && Math.abs(out[1.5 * RATE] - Math.SQRT1_2) < 0.003 && out[2.5 * RATE] === 0.5);
}
// three files in a row: the second is heard late, and its last moments come from the memory
{
  const c2 = cut + RATE;
  const a = whole.slice(0, cut);
  const b = whole.slice(cut, c2);
  const c = whole.slice(c2);
  const bAt = cut - 15000;
  // deck 0 plays a, then c: what it plays depends on the time
  const cAt = c2 - 14000;
  const deck0 = new Float32Array(6 * RATE);
  deck0.set(a, 0);
  deck0.set(c.slice(0, 6 * RATE - cAt), cAt);
  const out = run(deck0, b, bAt, 5 * RATE, all(once(0, { t: 'pass', i: 0 }), once(cut - 24000, { t: 'arm', from: 0, to: 1, end: cut }), once(bAt, { t: 'onset', frame: bAt }), once(cut + 4 * B, { t: 'ended', i: 0 }),
    once(cAt - B, { t: 'arm', from: 1, to: 0, end: c2 + 700 }), once(cAt, { t: 'onset', frame: cAt }), once(bAt + RATE + 5 * B, { t: 'ended', i: 1 })));
  check('a third file after a delayed one: not a sample lost or repeated', worst(out, whole, 4.5 * RATE) < 1e-6, String(worst(out, whole, 4.5 * RATE)));
  check('…its delay does not add up', Math.abs(posted.filter((m) => m.t === 'joined').at(-1).delay * RATE - 14000) < 3 * B);
}
console.log(`\n[joiner] ${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
