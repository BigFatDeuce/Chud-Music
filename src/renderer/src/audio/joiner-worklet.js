// Joins two local files with no gap and no overlap (audio/engine.ts drives it).
//
// Two <audio> elements cannot be chained to the sample from the page: starting the second one
// takes an unknown few tens of milliseconds. So the second is started a little before the end of
// the first, unheard: from its first sample on it is kept in a short memory. Where the first one
// ends — its last sample, seen here — this memory starts to sound, and goes on being fed. The
// file then plays with a constant delay (the time it was started early, under a second), which
// the engine takes off the position it shows, and which a pause, a seek or a new file removes.
//
// Plain JavaScript, on purpose: it runs in the audio thread, and tests/unit/joiner.mjs runs the
// very same file. Messages in (port):
//   {t:'pass', i}                  deck i is heard, live (anything under way is dropped)
//   {t:'mix', i, seconds}          crossfade, at equal power, from the deck heard to deck i
//   {t:'arm', from, to, end, edges}  `from` ends around frame `end`: once armed, the engine starts `to`.
//                                  edges: [of from, of to], samples the browser's rate conversion adds
//                                  around a file (a filter's ringing: half before its start, half after
//                                  its end): laid over each other, they make the sound whole again
//   {t:'onset', frame}             `to` should have been heard from this frame on
//   {t:'disarm'}                   no join after all: the deck heard goes on as it is
//   {t:'ended', i}                 the element of deck i, if it is the one heard, has played its last sample
// Messages out: {t:'armed'} (its start cannot be missed any more), {t:'joined', delay} (seconds), {t:'failed'} (the second deck never came),
// {t:'drained'} (the delayed deck has been heard to its end).

/** A digital silence this close to the expected end (s) is taken as the end itself. */
const WINDOW = 0.06;
/** After an element's end is announced, its last samples may still be on their way (s). */
const LATE = 0.06;
/** A join between two grids of samples: B is moved by a fraction of a sample, undone over this (s). */
const SLIDE = 0.03;
// What is heard goes out two blocks (5 ms) late: the end of a file is seen before it is heard.
const BLOCKS = 3;

/** This many zero samples in a row: the end, not a zero crossing. */
const ZEROS = 48;
const MEMORY = 4; // seconds

class Joiner extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.ceil(MEMORY * sampleRate);
    /** What is heard: deck `cur`, live or through its memory (`rings[cur]`). */
    this.cur = 0;
    /** A crossfade: sample reached, and length. */
    this.mix = null;
    this.rings = [null, null];
    this.join = null; // {to, end, onset, silent}
    this.ending = false; // the element of the deck heard has ended
    /** The block about to go out, the one after, the one being made. */
    this.l = new Float32Array(BLOCKS * 128);
    this.r = new Float32Array(BLOCKS * 128);
    this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
    if (m.t === 'pass') {
      this.cur = m.i;
      this.mix = null;
      this.join = null;
      this.ending = false;
      this.rings = [null, null];
    } else if (m.t === 'mix') {
      // the deck that comes in is live; the one that goes out may still be delayed
      this.cur = m.i;
      this.mix = { at: 0, length: Math.max(1, Math.round(m.seconds * sampleRate)) };
      this.join = null;
      this.ending = false;
      this.rings[m.i] = null;
    } else if (m.t === 'arm') {
      this.join = { to: m.to, end: m.end, onset: null, edges: m.edges ?? [0, 0] };
      this.rings[m.to] = this.newRing();
      this.port.postMessage({ t: 'armed' });
    } else if (m.t === 'onset') {
      if (this.join) this.join.onset = m.frame;
    } else if (m.t === 'disarm') {
      if (this.join) this.rings[this.join.to] = null;
      this.join = null;
    } else if (m.t === 'ended' && m.i === this.cur) {
      // (about the other deck: it ended, and the switch is done already)
      this.ending = true;
      const ring = this.rings[this.cur];
      if (ring) ring.late = { from: ring.write, until: currentFrame + LATE * sampleRate };
    }
  }

  newRing() {
    return { l: new Float32Array(this.size), r: new Float32Array(this.size), read: 0, write: 0, first: -1, shift: 0, slide: 0, late: null };
  }

  /** Keeps a block of a deck; before its first sound nothing is kept (its start is not known yet). */
  record(ring, l, r, frames) {
    let from = 0;
    if (ring.first < 0) {
      if (!l) return;
      while (from < frames && l[from] === 0 && r[from] === 0) from++;
      if (from === frames) return;
      ring.first = currentFrame + from;
    }
    for (let k = from; k < frames; k++) {
      ring.l[ring.write % this.size] = l ? l[k] : 0;
      ring.r[ring.write % this.size] = r ? r[k] : 0;
      ring.write++;
    }
  }

  quiet(ring, at) {
    return ring.l[at % this.size] === 0 && ring.r[at % this.size] === 0;
  }

  /** The next sample of a memory, in a and b; moved by a fraction of a sample after such a join. */
  take(ring) {
    if (ring.slide > 0) {
      this.between(ring, ring.read + (ring.shift * ring.slide) / (SLIDE * sampleRate));
      ring.slide--;
    } else if (ring.read >= 0 && ring.read < ring.write) {
      this.a = ring.l[ring.read % this.size];
      this.b = ring.r[ring.read % this.size];
    } else this.a = this.b = 0;
    ring.read++;
  }

  /** What a memory holds between its samples, in a and b (16 points of a windowed sinc). */
  between(ring, at) {
    const i = Math.floor(at);
    const x = at - i;
    this.a = this.b = 0;
    for (let k = -7; k <= 8; k++) {
      const p = i + k;
      if (p < 0 || p >= ring.write) continue;
      const d = k - x;
      const h = Math.abs(d) < 1e-9 ? 1 : (Math.sin(Math.PI * d) / (Math.PI * d)) * (0.42 + 0.5 * Math.cos((Math.PI * d) / 8.5) + 0.08 * Math.cos((2 * Math.PI * d) / 8.5));
      this.a += h * ring.l[p % this.size];
      this.b += h * ring.r[p % this.size];
    }
  }

  /** How rough the sound is around `seam` when the memory begins at `start`, moved by `shift`. */
  roughness(ring, start, seam, shift) {
    let d1 = 0;
    let d2 = 0;
    let d3 = 0;
    let d4 = 0;
    let sum = 0;
    for (let n = 0; n < 40; n++) {
      const k = seam - 20 + n;
      let x = (this.l[k] ?? 0) + (this.r[k] ?? 0);
      if (k >= start) {
        this.between(ring, k - start + shift);
        x += this.a + this.b;
      }
      const e2 = x - d1;
      const e3 = e2 - d2;
      const e4 = e3 - d3;
      const e5 = e4 - d4;
      d1 = x;
      d2 = e2;
      d3 = e3;
      d4 = e4;
      if (n >= 4) sum += e5 * e5;
    }
    return sum;
  }

  /** The start of the memory, with the digital silence the file itself begins with. */
  lead(ring) {
    const { onset } = this.join;
    if (onset === null || ring.first < 0) return 0;
    const silence = ring.first - onset;
    return silence > WINDOW * sampleRate ? Math.round(silence) : 0;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    if (this.l.length !== BLOCKS * frames) {
      this.l = new Float32Array(BLOCKS * frames);
      this.r = new Float32Array(BLOCKS * frames);
    }
    this.l.copyWithin(0, frames);
    this.r.copyWithin(0, frames);
    const last = (BLOCKS - 1) * frames;
    this.make(inputs, frames, this.l.subarray(last), this.r.subarray(last));
    out[0].set(this.l.subarray(0, frames));
    out[1]?.set(this.r.subarray(0, frames));
    return true;
  }

  /** The next block of what is heard, in L and R (a join may also complete the blocks before). */
  make(inputs, frames, L, R) {
    const chan = (i) => {
      const c = inputs[i];
      return c && c.length ? [c[0], c[1] ?? c[0]] : [null, null];
    };

    // what the deck heard gives for this block: from its memory, or live
    const curRing = this.rings[this.cur];
    const [cl, cr] = chan(this.cur);
    if (curRing) {
      const late = curRing.late;
      if (!late || currentFrame < late.until) this.record(curRing, cl, cr, frames);
      else if (late.from >= 0) {
        // what came after the end was announced: sound, or nothing
        while (curRing.write > Math.max(late.from, curRing.read) && this.quiet(curRing, curRing.write - 1)) curRing.write--;
        late.from = -1;
      }
    }
    for (let k = 0; k < frames; k++) {
      if (curRing) {
        if (curRing.read < 0) {
          L[k] = R[k] = 0;
          curRing.read++;
        } else if (curRing.read < curRing.write) {
          this.take(curRing);
          L[k] = this.a;
          R[k] = this.b;
        } else L[k] = R[k] = 0;
      } else {
        L[k] = cl ? cl[k] : 0;
        R[k] = cr ? cr[k] : 0;
      }
    }

    if (this.mix) {
      const other = 1 - this.cur;
      const ring = this.rings[other];
      const [ol, or] = chan(other);
      if (ring) this.record(ring, ol, or, frames);
      const { length } = this.mix;
      for (let k = 0; k < frames; k++) {
        const x = (Math.min(1, this.mix.at++ / length) * Math.PI) / 2;
        const up = Math.sin(x);
        const down = Math.cos(x);
        L[k] *= up;
        R[k] *= up;
        if (ring) {
          this.take(ring);
          L[k] += this.a * down;
          R[k] += this.b * down;
        } else if (ol) {
          L[k] += ol[k] * down;
          R[k] += or[k] * down;
        }
      }
      if (this.mix.at >= length) {
        this.mix = null;
        this.rings[other] = null;
      }
      return;
    }

    if (this.join) this.tryJoin(chan, frames, curRing);
    else if (this.ending && curRing && curRing.read >= curRing.write) {
      this.ending = false;
      this.port.postMessage({ t: 'drained' });
    }
  }

  tryJoin(chan, frames, curRing) {
    const j = this.join;
    const ring = this.rings[j.to];
    const [tl, tr] = chan(j.to);
    this.record(ring, tl, tr, frames);

    // where does the deck heard end, in the blocks not heard yet? (-1: not there)
    let at = -1;
    const dry = this.ending && (!curRing || curRing.read >= curRing.write);
    const near = currentFrame - (BLOCKS - 1) * frames >= j.end - WINDOW * sampleRate && currentFrame <= j.end + WINDOW * sampleRate;
    if (dry || near) {
      const tail = this.afterLastSound(BLOCKS * frames);
      if (BLOCKS * frames - tail >= ZEROS) at = tail;
    }
    if (at < 0) return;

    // the next one has not started yet: wait for it when the end is sure, up to 1.5 s
    if (ring.first < 0) {
      if (!this.ending) return; // its first sound, or the element's end, decides
      j.waited = (j.waited ?? 0) + frames;
      if (j.onset !== null) {
        // it runs, and begins with silence: heard live from here on
        this.finish(j.to, null);
      } else if (j.waited > 1.5 * sampleRate) {
        this.join = null;
        this.rings[j.to] = null;
        this.port.postMessage({ t: 'failed' });
      }
      return;
    }
    const lead = this.lead(ring);
    ring.read = -lead;
    // (what is kept of a file begins with its edge, unless the file begins with silence)
    const over = j.edges[0] + (lead ? 0 : j.edges[1]);
    const start = Math.max(0, Math.round(at - over));
    if (over && !lead) {
      // the two files are not on the same grid of samples: the fraction that makes one smooth sound
      let best = 0;
      let least = Infinity;
      const seam = Math.round(at - j.edges[0]);
      const look = (shift) => {
        const x = this.roughness(ring, start, seam, shift);
        if (x < least) [least, best] = [x, shift];
      };
      for (let s = -8; s <= 8; s++) look(s / 4);
      const around = best;
      for (let s = -4; s <= 4; s++) look(around + s / 16);
      ring.shift = best;
      ring.slide = Math.round(SLIDE * sampleRate);
    }
    for (let k = start; k < BLOCKS * frames; k++) {
      this.take(ring);
      this.l[k] += this.a;
      this.r[k] += this.b;
    }
    this.finish(j.to, ring);
  }

  /** Index just after the last non-zero sample of the blocks not heard yet (0 when they are all zeros). */
  afterLastSound(k) {
    while (k > 0 && this.l[k - 1] === 0 && this.r[k - 1] === 0) k--;
    return k;
  }

  finish(to, ring) {
    this.rings[1 - to] = null;
    this.rings[to] = ring;
    this.cur = to;
    this.join = null;
    this.ending = false;
    this.port.postMessage({ t: 'joined', delay: ring ? (ring.write - ring.read) / sampleRate : 0 });
  }
}

registerProcessor('chud-joiner', Joiner);
