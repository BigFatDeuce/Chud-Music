import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useSettings } from '@/store/settings';
import { createGlitch, supportsHtmlInCanvas, type GlitchInstance } from './canvasui/Glitch';

// Canvas UI effects are decoration: they only run with Effets = Complets, never while the
// window is hidden, and every one falls back to its plain HTML children.

const onVisibility = (cb: () => void) => {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};
const noop = () => () => {};

export function useCanvasFx(): boolean {
  const effects = useSettings((s) => s.effects);
  const visible = useSyncExternalStore(onVisibility, () => !document.hidden);
  return effects === 'full' && visible;
}

const fill: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

/** A short tape glitch over its children each time `trigger` changes; silent otherwise. */
export function GlitchOnChange({ trigger, children }: { trigger: string; children: ReactNode }) {
  const sourceRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const glitch = useRef<GlitchInstance | null>(null);
  const native = useSyncExternalStore(noop, supportsHtmlInCanvas, () => false);

  useEffect(() => {
    const [source, content, output] = [sourceRef.current, contentRef.current, outputRef.current];
    if (!native || !source || !content || !output) return;
    // intensity 0 and a huge interval: the engine's own timed bursts stay invisible
    glitch.current = createGlitch({ source, content, output }, { intensity: 0, interval: 1e6, duration: 0.45, slices: 18, shift: 22, rgbShift: 5, blocks: 0.35, noise: 0.3 });
    return () => {
      glitch.current?.destroy();
      glitch.current = null;
    };
  }, [native]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const g = glitch.current;
    if (!g) return;
    g.setOptions({ intensity: 0.9 });
    g.burst();
    const id = setTimeout(() => g.setOptions({ intensity: 0 }), 600);
    return () => clearTimeout(id);
  }, [trigger]);

  if (!native) return <div style={fill}>{children}</div>;
  return (
    <div style={fill}>
      <canvas
        ref={sourceRef}
        // @ts-expect-error experimental html-in-canvas attribute
        layoutsubtree="true"
        style={fill}
      >
        <div ref={contentRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
          {children}
        </div>
      </canvas>
      <canvas ref={outputRef} aria-hidden style={{ ...fill, pointerEvents: 'none' }} />
    </div>
  );
}
