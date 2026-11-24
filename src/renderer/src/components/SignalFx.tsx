import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSettings } from '@/store/settings';
import { useCanvasFx } from './Fx';
import { supportsHtmlInCanvas } from './canvasui/Glitch';
import { AsciiSweep } from './canvasui/AsciiSweep';
import { RetroDither } from './canvasui/RetroDither';
import logo from '@/assets/logo.svg';

// Skin "Signal": dark, with old-school signal glitches — few and targeted, each one at a
// precise spot, only with Effets = Complets, and falling back to plain HTML everywhere:
//   • player bar title: the new track sweeps in through a band of ASCII (AsciiSweep)
//   • home "Now playing" box: a dither lens follows the cursor over it (RetroDither)
//   • page titles: a two-frame signal loss every ~14 s (CSS only, skins.css)
//   • living cover, nothing loaded: the logo floating as ASCII (AsciiObject, three.js, lazy)
//   • living cover, track change: tape glitch burst (shared with the other skins)

const AsciiObject = lazy(() => import('./canvasui/AsciiObject').then((m) => ({ default: m.AsciiObject })));
const noop = () => () => {};

export function useSignalFx(): boolean {
  const skin = useSettings((s) => s.skin);
  const fx = useCanvasFx();
  const native = useSyncExternalStore(noop, supportsHtmlInCanvas, () => false);
  return skin === 'signal' && fx && native;
}

const PHOSPHOR = '#e8e6e3';

/**
 * Content drawn into a canvas takes no room in the layout: an invisible copy of the same content
 * measures it, and the effect gets exactly that size (any title length, any skin font).
 */
function Sized({ children, measure, className }: { children: ReactNode; measure: ReactNode; className?: string }) {
  return (
    <div className={`fx-sized${className ? ` ${className}` : ''}`} style={{ position: 'relative', minWidth: 0 }}>
      {/* in the flow, invisible: gives the box the width and height plain text would have */}
      <div aria-hidden inert style={{ visibility: 'hidden', pointerEvents: 'none' }}>
        {measure}
      </div>
      <div style={{ position: 'absolute', inset: 0 }}>{children}</div>
    </div>
  );
}

/** Track title and artist: the next track replaces the previous one with an ASCII sweep. */
export function NowPlayingSweep({ trackKey, children }: { trackKey: string; children: ReactNode }) {
  // two slots, flipped on each track change: the sweep goes from the old one to the new one
  const [slots, setSlots] = useState<[ReactNode, ReactNode]>([children, null]);
  const [index, setIndex] = useState(0);
  const last = useRef(trackKey);
  useEffect(() => {
    if (last.current === trackKey) {
      setSlots((s) => (index === 0 ? [children, s[1]] : [s[0], children])); // same track: refresh text
      return;
    }
    last.current = trackKey;
    const next = 1 - index;
    setSlots((s) => (next === 0 ? [children, s[1]] : [s[0], children]));
    setIndex(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey, children]);
  return (
    <Sized className="np-sweep" measure={children}>
    <AsciiSweep style={{ position: 'absolute', inset: 0 }} index={index} alternate={slots[1]} duration={0.9} band={0.22} angle={0} charset="binary" color={PHOSPHOR} glow={0.35} aberration={0.4} tint={0.6} background="transparent">
      {slots[0]}
    </AsciiSweep>
    </Sized>
  );
}

/**
 * The home "Now playing" box: a retro dither lens follows the cursor over the whole box (cover,
 * title, buttons — still clickable), leaving a fading phosphor trail; a click sends a degauss ripple.
 */
export function HeroDither({ children }: { children: ReactNode }) {
  return (
    <Sized className="hero-dither" measure={children}>
      <RetroDither style={{ position: 'absolute', inset: 0 }} radius={0.62} softness={0.3} pixelSize={3} levels={3} contrast={0.85} pattern="bayer" baseStrength={0} strength={1} scanlines={0} colorize={0.3} darkColor={[0.02, 0.02, 0.025]} lightColor={[0.91, 0.9, 0.89]} trail={0.55} degauss={0.7} followSpeed={4}>
        {children}
      </RetroDither>
    </Sized>
  );
}

/** "No signal": the logo turning slowly as ASCII, in the living cover when nothing is loaded. */
export function SignalIdle({ fallback }: { fallback: ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      <AsciiObject src={logo} ascii cellSize={7} colored={false} color={PHOSPHOR} background="#0f0f12" floatIntensity={0.6} rotationIntensity={0.4} autoRotate autoRotateSpeed={0.4} orbit={false} zoom={false} style={{ position: 'absolute', inset: 0 }} />
    </Suspense>
  );
}
