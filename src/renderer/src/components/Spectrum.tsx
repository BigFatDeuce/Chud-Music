import { useEffect, useRef } from 'react';
import { engine } from '@/audio/engine';
import { usePlayer } from '@/store/player';
import { useSettings } from '@/store/settings';
import { spectrumFeed, type SpectrumFeed } from '@shared/yt-place';

// Winamp-style mini spectrum analyser fed by the real audio graph. It only animates while
// music plays, the window is visible and effects are on — otherwise it draws once and sleeps.
// With reduced effects it draws 30 times a second instead of at the screen's rate.

const BARS = 22;

export function Spectrum() {
  const ref = useRef<HTMLCanvasElement>(null);
  const status = usePlayer((s) => s.status);
  const effects = useSettings((s) => s.effects);
  const skin = useSettings((s) => s.skin);

  useEffect(() => {
    const canvas = ref.current!;
    const g = canvas.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = (canvas.width = canvas.clientWidth * dpr);
    const h = (canvas.height = canvas.clientHeight * dpr);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--lcd-fg').trim() || '#c6ff2e';
    const dim = css.getPropertyValue('--lcd-dim').trim() || 'rgba(198,255,46,.2)';
    const peaks = new Float32Array(BARS);
    const bins = new Uint8Array(1024);
    const gap = 2 * dpr;
    const bw = (w - gap * (BARS - 1)) / BARS;
    const segH = 3 * dpr;

    const segs = Math.floor(h / segH);
    const lit = new Int32Array(BARS);
    // grouped by colour and by row (one alpha per row): a few dozen canvas state changes per
    // frame instead of one per segment
    const draw = (levels: Float32Array) => {
      g.clearRect(0, 0, w, h);
      for (let i = 0; i < BARS; i++) lit[i] = Math.round(levels[i]! * segs);
      g.fillStyle = dim;
      g.globalAlpha = 0.5;
      for (let s = 0; s < segs; s++) {
        const y = h - (s + 1) * segH + dpr;
        for (let i = 0; i < BARS; i++) if (s >= lit[i]!) g.fillRect(i * (bw + gap), y, bw, segH - dpr);
      }
      g.fillStyle = fg;
      for (let s = 0; s < segs; s++) {
        g.globalAlpha = 0.55 + (0.45 * s) / segs;
        const y = h - (s + 1) * segH + dpr;
        for (let i = 0; i < BARS; i++) if (s < lit[i]!) g.fillRect(i * (bw + gap), y, bw, segH - dpr);
      }
      g.globalAlpha = 1;
      for (let i = 0; i < BARS; i++) {
        if (peaks[i]! > 0.02) g.fillRect(i * (bw + gap), h - Math.round(peaks[i]! * segs) * segH, bw, dpr * 1.5);
      }
    };

    // YouTube: the levels measured inside the official player's page (see main/yt-player.ts),
    // or bars moving on their own when none arrive (shared/yt-place.ts, spectrumFeed)
    const youtube = engine.kind === 'youtube';
    const feed = () => spectrumFeed({ playing: status === 'playing', effectsOff: effects === 'off', youtube, hasAnalyser: !!engine.analyser, freshLevels: engine.youtube.levels !== null });
    canvas.dataset.feed = feed();
    if (feed() === 'off') {
      peaks.fill(0);
      draw(new Float32Array(BARS));
      return;
    }

    let raf = 0;
    const levels = new Float32Array(BARS);
    const minGap = effects === 'reduced' ? 1000 / 30 - 2 : 0;
    let lastDraw = 0;
    /** Skip this frame? (hidden window, or too soon at the reduced rate) */
    const skip = (now: number) => {
      if (document.hidden || now - lastDraw < minGap) return true;
      lastDraw = now;
      return false;
    };
    if (youtube) {
      // simulated bars: each band follows its own slow waves plus a beat shared by all, stronger
      // in the low bands — nothing is measured, it only shows that music is playing
      const phase = Float32Array.from({ length: BARS }, () => Math.random() * Math.PI * 2);
      const speed = Float32Array.from({ length: BARS }, () => 1.2 + Math.random() * 2.4);
      let beat = 0;
      let nextBeat = 0;
      const simulated = (i: number, t: number) => {
        const tilt = 1 - (i / BARS) * 0.55;
        const wave = 0.5 + 0.5 * Math.sin(t * speed[i]! + phase[i]!) * Math.sin(t * 0.7 * speed[i]! + phase[i]! * 1.7);
        return Math.min(1, (0.18 + 0.5 * wave + beat * (1 - i / BARS) * 0.6) * tilt) * 255;
      };
      let shown: SpectrumFeed = 'off';
      const loop = (now = performance.now()) => {
        raf = requestAnimationFrame(loop);
        if (skip(now)) return;
        const l = engine.youtube.levels;
        const f = feed();
        if (f !== shown) canvas.dataset.feed = shown = f;
        const t = now / 1000;
        if (!l) {
          // a beat every 0.4–0.75 s, fading quickly
          if (now >= nextBeat) {
            beat = 0.6 + Math.random() * 0.4;
            nextBeat = now + 400 + Math.random() * 350;
          }
          beat *= 0.9;
        }
        for (let i = 0; i < BARS; i++) {
          const v = Math.pow((l ? (l[i] ?? 0) : simulated(i, t)) / 255, 1.6);
          // the levels arrive ~30 times a second: ease towards them so the bars stay fluid
          levels[i] = v > levels[i]! ? v : levels[i]! + (v - levels[i]!) * 0.35;
          peaks[i] = levels[i]! > peaks[i]! ? levels[i]! : Math.max(0, peaks[i]! - 0.012);
        }
        draw(levels);
      };
      loop();
      return () => cancelAnimationFrame(raf);
    }
    const analyser = engine.analyser!;
    const nyquist = analyser.context.sampleRate / 2;
    const loop = (now = performance.now()) => {
      raf = requestAnimationFrame(loop);
      if (skip(now)) return;
      analyser.getByteFrequencyData(bins);
      for (let i = 0; i < BARS; i++) {
        // log-spaced bands from 40 Hz to 16 kHz
        const f0 = 40 * Math.pow(16000 / 40, i / BARS);
        const f1 = 40 * Math.pow(16000 / 40, (i + 1) / BARS);
        const a = Math.floor((f0 / nyquist) * analyser.frequencyBinCount);
        const b = Math.max(a + 1, Math.floor((f1 / nyquist) * analyser.frequencyBinCount));
        let m = 0;
        for (let k = a; k < b; k++) m = Math.max(m, bins[k]!);
        const v = Math.pow(m / 255, 1.6);
        levels[i] = v;
        peaks[i] = v > peaks[i]! ? v : Math.max(0, peaks[i]! - 0.012);
      }
      draw(levels);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [status, effects, skin]);

  return (
    <div className="spectrum lcd-screen" aria-hidden>
      <canvas ref={ref} />
    </div>
  );
}
