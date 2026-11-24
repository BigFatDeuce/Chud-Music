import { EQ_BANDS, type EqSettings } from '@shared/types';
import { YouTubeEngine } from './youtube';
import { createBand } from './eq';
import joinerUrl from './joiner-worklet.js?url&no-inline';
import { tr } from '@shared/i18n';

// Local playback engine (prototype P1 validated this graph):
//   2 × (<audio> → ReplayGain) → joiner (gapless, crossfade) → preamp → 10 × peaking EQ → analyser
//   (spectrum / visualiser) → volume → speakers
// Settings never touch the files: everything happens in this graph, at playback time.
//
// One deck is heard (`cur`); the other one only serves to chain the next file, without a gap
// (joiner-worklet.js says how) or with a crossfade:
//   'near'     the current file ends in less than NEAR_S: the player answers with prepare(next)
//   'segue'    the next file is the one heard now: the player moves on to it without loading it
//   'ended'    as always, when nothing was prepared or it could not be chained
// A seek, a pause, a new file: whatever was under way is dropped, the current file goes on alone.

export type EngineEvent =
  /** The engine takes a new media: what it reported until now was about the previous one. */
  | { type: 'load' }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'ended' }
  | { type: 'waiting' }
  | { type: 'duration'; duration: number }
  /** The current file is about to end: the next one can be prepared (said again after a seek). */
  | { type: 'near' }
  /** The file prepared under this key is the current one from now on. */
  | { type: 'segue'; key: string; duration: number }
  /** The position jumped (seek, new file). */
  | { type: 'clock' }
  | { type: 'error'; code: number; message: string };

/** The file to chain after the current one. */
export interface Prepared {
  /** Identifies it in the 'segue' event. */
  key: string;
  url: string;
  /** ReplayGain factor. */
  gain: number;
  /** Seconds of crossfade; 0 = gapless. */
  crossfade: number;
  /** Sample rates of the current file and of this one (0 = not known). */
  rates: [number, number];
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** 'near' is sent this long before the end (the next file may have to be converted first). */
const NEAR_S = 20;
/** The next file is opened this long before it is needed. */
const OPEN_S = 8;
/** …and started, unheard, this long before the end. */
const LEAD_S = 0.6;
/** Chromium's rate conversion filter: the samples of the file it adds before and after, on average. */
const KERNEL = 31.5;

class Deck {
  readonly audio = new Audio();
  rg: GainNode | null = null;
  /** ReplayGain factor of the file in it. */
  gain = 1;
  constructor(readonly i: 0 | 1) {
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';
  }
  clear(): void {
    this.audio.pause();
    if (!this.audio.getAttribute('src')) return;
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}

interface Chain {
  next: Prepared;
  deck: Deck;
  /** waiting: too early; open: its file is opened; armed: it runs, unheard, and will be switched to. */
  step: 'waiting' | 'open' | 'armed';
}

export class LocalEngine {
  private readonly decks: [Deck, Deck] = [new Deck(0), new Deck(1)];
  private cur: Deck = this.decks[0];
  /** The current file is heard this much later than its element plays (s): see the joiner. */
  private delay = 0;
  private chain: Chain | null = null;
  /** Keys that could not be chained (their file does not open): the normal way is used. */
  private refused = new Set<string>();
  private nearSent = false;
  private rate = 1;
  /** A crossfade under way: the deck that goes out, and when it is over. */
  private fading: { out: Deck; timer: ReturnType<typeof setTimeout> } | null = null;
  private ctx: AudioContext | null = null;
  private joiner: AudioWorkletNode | null = null;
  private joinerReady: Promise<void> = Promise.resolve();
  private preamp: GainNode | null = null;
  private bands: BiquadFilterNode[] = [];
  private volumeNode: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  private listeners = new Set<(e: EngineEvent) => void>();
  private eq: EqSettings | null = null;
  private volume = 1;
  private muted = false;

  constructor() {
    for (const d of this.decks) this.listen(d);
  }

  private listen(d: Deck): void {
    const a = d.audio;
    const mine = () => d === this.cur;
    a.addEventListener('playing', () => {
      if (mine()) {
        this.emit({ type: 'playing' });
        // asked for before it really played (a start near the end), the next track was not prepared
        if (!this.chain) this.nearSent = false;
        this.watch();
      } else if (this.chain?.deck === d && this.chain.step === 'armed') this.onset(d);
    });
    a.addEventListener('pause', () => {
      // a file that ends is paused by the browser first: its end is reported, not a pause
      if (mine() && !a.ended) this.emit({ type: 'paused' });
    });
    a.addEventListener('ended', () => mine() && this.onEnded());
    a.addEventListener('waiting', () => {
      if (!mine()) return;
      this.dropChain(); // when it ends is not known any more; prepared again by the next tick
      this.emit({ type: 'waiting' });
    });
    a.addEventListener('durationchange', () => {
      if (!mine() || !Number.isFinite(a.duration)) return;
      this.dropChain();
      this.emit({ type: 'duration', duration: a.duration });
    });
    a.addEventListener('timeupdate', () => mine() && this.watch());
    for (const ev of ['seeked', 'emptied'] as const) a.addEventListener(ev, () => mine() && this.emit({ type: 'clock' }));
    a.addEventListener('error', () => {
      if (!a.getAttribute('src')) return; // src cleared on purpose
      if (mine()) this.emit({ type: 'error', code: a.error?.code ?? 0, message: a.error?.message ?? tr('err.playback') });
      else if (this.chain?.deck === d) this.refuse(this.chain);
    });
  }

  /** The element heard. */
  get audio(): HTMLAudioElement {
    return this.cur.audio;
  }

  /**
   * The audio graph for the visualiser: its context and the post-EQ, pre-volume node (the
   * picture does not shrink when the volume goes down). Builds the graph if needed.
   */
  tap(): { context: AudioContext; node: AudioNode } {
    this.ensureGraph();
    return { context: this.ctx!, node: this.analyser! };
  }

  /** Built lazily on first playback (or visualiser) so an idle app holds no audio device. */
  private ensureGraph(): void {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.preamp = ctx.createGain();
    this.bands = EQ_BANDS.map((_, i) => createBand(ctx, i));
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.volumeNode = ctx.createGain();

    for (const d of this.decks) {
      d.rg = ctx.createGain();
      ctx.createMediaElementSource(d.audio).connect(d.rg);
      d.rg.gain.value = d.gain;
    }
    // the joiner's code loads in a moment; if it cannot be, deck 0 simply plays alone
    this.decks[0].rg!.connect(this.preamp);
    this.joinerReady = ctx.audioWorklet.addModule(joinerUrl).then(
      () => {
        const j = new AudioWorkletNode(ctx, 'chud-joiner', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        this.decks[0].rg!.disconnect();
        for (const d of this.decks) d.rg!.connect(j, 0, d.i);
        j.connect(this.preamp!);
        j.port.onmessage = (e) => this.fromJoiner(e.data);
        this.joiner = j;
      },
      (e) => window.chud.logError(`gapless playback unavailable: ${e instanceof Error ? e.message : String(e)}`),
    );
    let node: AudioNode = this.preamp;
    for (const b of this.bands) node = node.connect(b);
    node.connect(this.analyser).connect(this.volumeNode).connect(ctx.destination);
    this.ctx = ctx;
    this.applyEq();
    this.applyVolume();
    if (this.sinkId !== 'default') void this.setOutput(this.sinkId);
  }

  on(cb: (e: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Counts loads and stops: a load overtaken while it waited does not go on. */
  private turn = 0;

  async load(url: string, startAt = 0, gain = 1): Promise<void> {
    const turn = ++this.turn;
    this.ensureGraph();
    await this.joinerReady;
    await this.ctx!.resume();
    if (turn !== this.turn) return;
    this.reset();
    this.refused.clear();
    this.emit({ type: 'load' });
    const d = this.cur;
    this.setDeckGain(d, gain, false);
    d.audio.src = url;
    this.applyRate(d);
    if (startAt > 0) {
      // a file that cannot be opened reports an error, not its length: never wait for ever
      await new Promise<void>((res) => {
        d.audio.addEventListener('loadedmetadata', () => res(), { once: true });
        d.audio.addEventListener('error', () => res(), { once: true });
      });
      if (turn !== this.turn) return;
      d.audio.currentTime = startAt;
    }
    await d.audio.play();
  }

  async play(): Promise<void> {
    this.ensureGraph();
    await this.ctx!.resume();
    await this.audio.play();
  }

  pause(): void {
    const at = this.currentTime;
    const delayed = this.delay > 0;
    const a = this.cur.audio;
    const ended = a.ended;
    a.pause();
    this.reset();
    if (!delayed) return;
    // what was left in the joiner's memory has not been heard: it plays again later
    a.currentTime = at;
    if (ended) this.emit({ type: 'paused' }); // (the element was at its end already: it says nothing)
  }

  stop(): void {
    this.turn++;
    this.reset();
    this.cur.audio.pause();
    this.cur.audio.removeAttribute('src');
    this.cur.audio.load();
  }

  seek(sec: number): void {
    if (!Number.isFinite(sec)) return;
    // its element may have ended already, what is heard being a moment behind
    const on = this.delay > 0 && this.cur.audio.ended;
    this.reset();
    this.cur.audio.currentTime = Math.max(0, sec);
    if (on) void this.cur.audio.play().catch(() => {});
  }

  get currentTime(): number {
    return Math.max(0, this.cur.audio.currentTime - this.delay * this.rate);
  }

  get bufferedEnd(): number {
    const b = this.audio.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  /** Playback speed, pitch kept (the browser's time-stretch); survives a change of file. */
  setRate(rate: number): void {
    if (rate !== this.rate) {
      if (this.delay > 0) this.seek(this.currentTime);
      else this.reset();
    }
    this.rate = rate;
    for (const d of this.decks) this.applyRate(d);
  }

  private applyRate(d: Deck): void {
    d.audio.defaultPlaybackRate = this.rate;
    d.audio.playbackRate = this.rate;
    d.audio.preservesPitch = true;
  }

  // ── Chaining the next file ───────────────────────────────────────────────────────────────

  /** When its element has ended, what is heard being a moment behind: when that is heard to its end. */
  private heardEnd = 0;

  /** Seconds before the current file has been heard to its end. */
  private left(): number {
    const a = this.cur.audio;
    if (a.ended) return this.heardEnd - this.ctx!.currentTime;
    return Number.isFinite(a.duration) && a.duration > 0 ? (a.duration - a.currentTime) / this.rate + this.delay : Infinity;
  }

  /** The file to chain after the current one (null: none; the current one ends on its own). */
  prepare(next: Prepared | null): void {
    const c = this.chain;
    if (c && next && c.next.key === next.key && c.next.url === next.url && c.next.crossfade === next.crossfade) {
      c.next = next;
      if (c.step !== 'waiting') this.setDeckGain(c.deck, next.gain, false);
      return;
    }
    const near = this.nearSent;
    this.dropChain();
    this.nearSent = near; // asked for and answered: not asked again by itself
    if (!next || !this.joiner || this.fading || this.refused.has(next.key)) return;
    this.chain = { next, deck: this.decks[1 - this.cur.i]!, step: 'waiting' };
    this.watch();
  }

  /** The next track is not the same any more: it is asked for again ('near') if the end is close. */
  replan(): void {
    this.dropChain();
    this.watch();
  }

  get prepared(): Prepared | null {
    return this.chain?.next ?? null;
  }

  private tick: ReturnType<typeof setTimeout> | undefined;

  /** Looks at where the current file is: asks for the next one, opens it, starts it, in time. */
  private watch(): void {
    clearTimeout(this.tick);
    const a = this.cur.audio;
    // (a file heard late: its element ends, and is "paused", before the sound does)
    if (this.fading || (a.ended ? this.endTimer === undefined : a.paused)) return;
    const c = this.chain;
    const left = this.left();
    if (!c) {
      if (left <= NEAR_S && !this.nearSent && this.joiner) {
        this.nearSent = true;
        this.emit({ type: 'near' });
      }
      return;
    }
    if (c.step === 'armed') {
      if (left < -2.5) this.refuse(c); // it goes on well after its announced length
      return;
    }
    const fade = this.fadeLength(c.next);
    const lead = fade || LEAD_S;
    if (c.step === 'waiting' && left <= lead + OPEN_S) {
      c.step = 'open';
      c.deck.audio.src = c.next.url;
      this.applyRate(c.deck);
      this.setDeckGain(c.deck, c.next.gain, false);
    }
    // not ready yet (slow share): looked at again in a moment; at worst the file ends without it
    if (c.step === 'open' && left <= lead && c.deck.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      if (fade) this.startFade(c, Math.min(fade, left));
      else this.arm(c);
      return;
    }
    // timeupdate comes 4 times a second only: the start is timed more finely
    this.tick = setTimeout(() => this.watch(), Math.max(15, Math.min(250, (left - lead) * 1000)));
  }

  private fadeLength(n: Prepared): number {
    const d = this.cur.audio.duration;
    return n.crossfade > 0 && Number.isFinite(d) ? Math.min(n.crossfade, d / 3) : 0;
  }

  private frame(inSeconds: number): number {
    return Math.round((this.ctx!.currentTime + inSeconds) * this.ctx!.sampleRate);
  }

  /** Samples a file of this rate is given before its start, and after its end (see KERNEL). */
  private edge(rate: number): number {
    const out = this.ctx!.sampleRate;
    return !rate || rate === out ? 0 : (KERNEL * out) / rate;
  }

  private tell(m: unknown): void {
    this.joiner?.port.postMessage(m);
  }

  private arm(c: Chain): void {
    c.step = 'armed';
    this.tell({ t: 'arm', from: this.cur.i, to: c.deck.i, end: this.frame(this.left()), edges: c.next.rates.map((r) => this.edge(r)) });
  }

  private onset(d: Deck): void {
    this.tell({ t: 'onset', frame: this.frame(-d.audio.currentTime / this.rate) });
  }

  private fromJoiner(m: { t: string; delay?: number }): void {
    const c = this.chain;
    if (m.t === 'armed') {
      if (c?.step === 'armed') c.deck.audio.play().catch(() => this.chain === c && this.refuse(c));
    } else if (m.t === 'joined') {
      if (c?.step === 'armed') this.handOver(c, m.delay ?? 0);
    } else if (m.t === 'failed') {
      if (c) this.refuse(c);
      if (this.cur.audio.ended) this.emit({ type: 'ended' });
    } else if (m.t === 'drained') this.drained();
  }

  /** The other deck is the current one from now on. */
  private handOver(c: Chain, delay: number): void {
    const old = this.cur;
    this.chain = null;
    this.cur = c.deck;
    this.delay = delay;
    clearTimeout(this.endTimer);
    this.endTimer = undefined;
    this.nearSent = false;
    if (!this.fading) old.clear();
    const d = c.deck.audio.duration;
    this.emit({ type: 'segue', key: c.next.key, duration: Number.isFinite(d) ? d : 0 });
    this.emit({ type: 'clock' });
    if (c.deck.audio.ended) this.onEnded(); // shorter than its head start
  }

  private startFade(c: Chain, seconds: number): void {
    const out = this.cur;
    const inn = c.deck;
    c.step = 'armed';
    inn.audio.play().then(
      () => {
        if (this.chain !== c) return;
        this.tell({ t: 'mix', i: inn.i, seconds });
        this.fading = { out, timer: setTimeout(() => this.endFade(), seconds * 1000 + 150) };
        this.handOver(c, 0);
      },
      () => this.chain === c && this.refuse(c),
    );
  }

  private endFade(): void {
    const f = this.fading;
    if (!f) return;
    this.fading = null;
    clearTimeout(f.timer);
    this.tell({ t: 'pass', i: this.cur.i });
    f.out.clear();
    this.watch();
  }

  private endTimer: ReturnType<typeof setTimeout> | undefined;

  private onEnded(): void {
    this.tell({ t: 'ended', i: this.cur.i });
    this.heardEnd = this.ctx!.currentTime + this.delay;
    if (this.chain?.step === 'armed' && !this.fading) return; // the joiner switches now, or says it could not
    this.endFade(); // a file shorter than the crossfade that brought it in
    if (this.delay > 0) {
      // heard to its end in a moment: the joiner says so (or goes on to the next one, meanwhile)
      clearTimeout(this.endTimer);
      this.heardEnd = this.ctx!.currentTime + this.delay;
      this.endTimer = setTimeout(() => this.drained(), this.delay * 1000 + 800);
      this.watch();
      return;
    }
    this.dropChain();
    this.emit({ type: 'ended' });
  }

  private drained(): void {
    if (this.endTimer === undefined) return;
    clearTimeout(this.endTimer);
    this.endTimer = undefined;
    if (!this.cur.audio.ended || this.chain?.step === 'armed') return;
    this.dropChain();
    this.emit({ type: 'ended' });
  }

  private refuse(c: Chain): void {
    this.refused.add(c.next.key);
    this.dropChain();
    this.nearSent = true; // not asked for again: the normal way takes it
  }

  /** The next file is not chained (any more): the current one plays on, alone. */
  private dropChain(): void {
    clearTimeout(this.tick);
    this.nearSent = false;
    const c = this.chain;
    if (!c) return;
    this.chain = null;
    if (c.step !== 'waiting') c.deck.clear();
    if (c.step === 'armed') this.tell({ t: 'disarm' });
  }

  /** Back to a single deck, heard live. */
  private reset(): void {
    this.dropChain();
    this.endFade();
    clearTimeout(this.endTimer);
    this.endTimer = undefined;
    this.delay = 0;
    this.tell({ t: 'pass', i: this.cur.i });
  }

  /** For the tests: what is chained, and how. */
  get chainState(): { step: string | null; delay: number; fading: boolean; deck: number; joiner: boolean } {
    return { step: this.chain?.step ?? null, delay: this.delay, fading: !!this.fading, deck: this.cur.i, joiner: !!this.joiner };
  }

  // ── Levels ───────────────────────────────────────────────────────────────────────────────

  private setDeckGain(d: Deck, gain: number, ramp: boolean): void {
    d.gain = gain;
    if (!d.rg || !this.ctx) return;
    d.rg.gain.cancelScheduledValues(0);
    if (ramp) d.rg.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.15);
    else d.rg.gain.value = gain;
  }

  /** ReplayGain factor of the current file (measured after it started, or the setting changed). */
  setTrackGain(gain: number): void {
    if (gain !== this.cur.gain) this.setDeckGain(this.cur, gain, true);
  }

  get trackGain(): number {
    return this.cur.gain;
  }

  setVolume(v: number, muted: boolean): void {
    this.volume = v;
    this.muted = muted;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.volumeNode || !this.ctx) return;
    // perceptual curve + short ramp: no zipper noise while dragging the slider
    const g = this.muted ? 0 : this.volume * this.volume;
    this.volumeNode.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
  }

  setEq(eq: EqSettings): void {
    this.eq = eq;
    this.applyEq();
  }

  private sinkId = 'default';
  /** Output device for local files, radio and the analyser graph (AudioContext.setSinkId). */
  async setOutput(sinkId: string): Promise<boolean> {
    this.sinkId = sinkId;
    if (!this.ctx) return true; // applied when the graph is built
    try {
      await (this.ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId === 'default' ? '' : sinkId);
      return true;
    } catch {
      return false;
    }
  }

  /** Current values on the filter nodes themselves (dB), for the panel and the tests. */
  appliedEq(): { preampDb: number; gains: number[] } | null {
    if (!this.preamp) return null;
    return { preampDb: 20 * Math.log10(Math.max(1e-6, this.preamp.gain.value)), gains: this.bands.map((b) => b.gain.value) };
  }

  private applyEq(): void {
    if (!this.ctx || !this.preamp || !this.eq) return;
    const t = this.ctx.currentTime;
    const on = this.eq.enabled;
    this.preamp.gain.setTargetAtTime(on ? dbToGain(this.eq.preampDb) : 1, t, 0.02);
    this.bands.forEach((b, i) => b.gain.setTargetAtTime(on ? (this.eq!.gains[i] ?? 0) : 0, t, 0.02));
  }
}

/**
 * What the player talks to: the local Web Audio engine or the YouTube player, one at a time.
 * Only the active one's events go through. EQ and the analyser exist for local files only:
 * YouTube's audio plays inside its own cross-origin player, out of Web Audio's reach.
 */
export class PlaybackEngine {
  kind: 'local' | 'youtube' = 'local';
  private listeners = new Set<(e: EngineEvent) => void>();

  constructor(
    readonly local: LocalEngine,
    readonly youtube: YouTubeEngine,
  ) {
    local.on((e) => this.kind === 'local' && this.emit(e));
    youtube.on((e) => this.kind === 'youtube' && this.emit(e));
  }

  on(cb: (e: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }

  private use(kind: 'local' | 'youtube'): void {
    if (this.kind === kind) return;
    if (this.kind === 'local') this.local.stop();
    else this.youtube.stop();
    this.kind = kind;
  }

  async loadLocal(url: string, startAt = 0, gain = 1): Promise<void> {
    this.use('local');
    await this.local.load(url, startAt, gain);
  }

  loadYouTube(videoId: string, startAt = 0): void {
    window.chud.adblock.warm();
    this.use('youtube');
    this.youtube.load(videoId, startAt);
  }

  private get active(): LocalEngine | YouTubeEngine {
    return this.kind === 'local' ? this.local : this.youtube;
  }

  async play(): Promise<void> {
    await this.active.play();
  }
  pause(): void {
    this.active.pause();
  }
  stop(): void {
    this.active.stop();
  }
  seek(sec: number): void {
    this.active.seek(sec);
  }
  get currentTime(): number {
    return this.active.currentTime;
  }
  get bufferedEnd(): number {
    return this.active.bufferedEnd;
  }
  get analyser(): AnalyserNode | null {
    return this.kind === 'local' ? this.local.analyser : null;
  }
  setRate(rate: number): void {
    this.local.setRate(rate);
    this.youtube.setRate(rate);
  }
  private vol = { v: 1, muted: false };
  private fadeFactor = 1;
  setVolume(v: number, muted: boolean): void {
    this.vol = { v, muted };
    this.local.setVolume(v * this.fadeFactor, muted);
    this.youtube.setVolume(v * this.fadeFactor, muted);
  }
  /** Over the person's own volume, without changing it (the sleep timer's fade): 1 = none. */
  setFade(factor: number): void {
    if (factor === this.fadeFactor) return;
    this.fadeFactor = factor;
    this.setVolume(this.vol.v, this.vol.muted);
  }
  setEq(eq: EqSettings): void {
    this.local.setEq(eq);
  }
}

export const engine = new PlaybackEngine(new LocalEngine(), new YouTubeEngine());
