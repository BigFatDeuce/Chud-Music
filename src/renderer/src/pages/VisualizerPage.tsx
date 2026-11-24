import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AudioWaveform, ChevronLeft, ChevronRight, Dices, ListMusic, Maximize, Minimize, Search, Timer, X } from 'lucide-react';
import type { Visualizer } from 'butterchurn';
import { engine } from '@/audio/engine';
import { usePlayer } from '@/store/player';
import { useSettings } from '@/store/settings';
import { locale, tr } from '@shared/i18n';

// MilkDrop presets (butterchurn, WebGL 2) fed by the real audio graph, after the EQ and before
// the volume. Independent from the skin. Renders only while this page is shown and the window
// is visible. YouTube tracks cannot feed it: their sound stays inside YouTube's own player.

type Presets = Record<string, object>;

let presetsCache: Promise<Presets> | null = null;
/** base + extra packs (≈ 290 presets, 2 MB): loaded on first visit only. */
function loadPresets(): Promise<Presets> {
  presetsCache ??= Promise.all([import('butterchurn-presets/dist/base.min.js'), import('butterchurn-presets/dist/extra.min.js')]).then((mods) => {
    const all: Presets = {};
    for (const m of mods) {
      const pack = m.default?.default ?? m.default ?? m;
      Object.assign(all, typeof pack.getPresets === 'function' ? pack.getPresets() : pack);
    }
    return all;
  });
  return presetsCache;
}

function supported(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2') && typeof AudioContext !== 'undefined';
  } catch {
    return false;
  }
}

const BLEND_SEC = 2.7;
const IDLE_MS = 2500;
const collator = new Intl.Collator(locale(), { sensitivity: 'base', numeric: true });

/** "Geiss - Desert Rose 2" → { author: "Geiss", title: "Desert Rose 2" } */
function splitName(name: string): { author: string | null; title: string } {
  const clean = name.replace(/^[_$\s]+/, '');
  const i = clean.indexOf(' - ');
  return i > 0 ? { author: clean.slice(0, i), title: clean.slice(i + 3) } : { author: null, title: clean };
}

export function VisualizerPage() {
  const [ok] = useState(supported);
  if (!ok) {
    return (
      <div className="page">
        <h1 className="page-title">{tr('section.visualizer')}</h1>
        <div className="empty">
          <div className="empty-art"><AudioWaveform size={64} strokeWidth={1.4} /></div>
          <h3>WebGL 2 indisponible</h3>
          <p>{tr('viz.noWebgl')}</p>
        </div>
      </div>
    );
  }
  return <VisualizerStage />;
}

function VisualizerStage() {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viz = useRef<Visualizer | null>(null);
  const [presets, setPresets] = useState<Presets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [full, setFull] = useState(false);
  const [fps, setFps] = useState(0);
  // whether the node feeding the visualiser carries sound (shown to tests as data-signal)
  const [signal, setSignal] = useState(false);
  const settings = useSettings((s) => s.viz);
  const setSettings = useSettings((s) => s.set);
  const current = usePlayer((s) => s.current);
  const status = usePlayer((s) => s.status);
  const isYouTube = current?.source === 'youtube';

  const names = useMemo(() => (presets ? Object.keys(presets).sort(collator.compare) : []), [presets]);
  const [presetName, setPresetName] = useState<string | null>(null);
  const history = useRef<string[]>([]);
  const broken = useRef(new Set<string>());

  const setViz = useCallback((patch: Partial<typeof settings>) => setSettings({ viz: { ...useSettings.getState().viz, ...patch } }), [setSettings]);

  // ── create the visualiser once the presets are in
  useEffect(() => {
    let alive = true;
    loadPresets()
      .then((p) => alive && setPresets(p))
      .catch((e) => alive && setError(`Presets introuvables (${String(e).slice(0, 80)})`));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!presets || !canvas.current || !stage.current) return;
    let raf = 0;
    let disposed = false;
    const { context, node } = engine.local.tap();
    const el = canvas.current;
    // kept locally: React clears the ref on unmount before this effect's cleanup runs, and a
    // ResizeObserver callback queued in between would otherwise read a null ref
    const box = stage.current;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    // butterchurn draws its frame unscaled onto our canvas: give it device pixels directly
    const size = () => ({ w: Math.max(2, Math.round(box.clientWidth * ratio)), h: Math.max(2, Math.round(box.clientHeight * ratio)) });
    let { w, h } = size();
    el.width = w;
    el.height = h;
    let v: Visualizer;
    void import('butterchurn').then(({ default: butterchurn }) => {
      if (disposed) return;
      // WASM only: preset equations are never compiled with eval
      v = butterchurn.createVisualizer(context, el, { width: w, height: h, pixelRatio: 1, textureRatio: 1, onlyUseWASM: true });
      v.connectAudio(node);
      viz.current = v;
      let frames = 0;
      let last = performance.now();
      const bins = new Uint8Array((node as AnalyserNode).frequencyBinCount);
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        if (document.hidden) return;
        v.render();
        frames++;
        if (now - last >= 1000) {
          setFps(Math.round((frames * 1000) / (now - last)));
          (node as AnalyserNode).getByteFrequencyData(bins);
          setSignal(bins.some((x) => x > 0));
          frames = 0;
          last = now;
        }
      };
      raf = requestAnimationFrame(loop);
      const start = useSettings.getState().viz.preset;
      void show(start && presets[start] ? start : pick(1), 0);
    });
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      ({ w, h } = size());
      el.width = w;
      el.height = h;
      viz.current?.setRendererSize(w, h, { pixelRatio: 1, textureRatio: 1 });
    });
    ro.observe(box);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (viz.current) {
        viz.current.disconnectAudio(node);
        viz.current.loseGLContext(); // free the GPU memory now, not at the next GC
        viz.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets]);

  /** Next/previous name, alphabetical or random, skipping presets that failed to compile. */
  const pick = (dir: 1 | -1): string => {
    const list = names.length ? names : Object.keys(presets ?? {}).sort(collator.compare);
    const usable = list.filter((n) => !broken.current.has(n));
    if (!usable.length) return list[0]!;
    const cur = presetName ?? useSettings.getState().viz.preset;
    if (useSettings.getState().viz.random && dir === 1) {
      let n = cur;
      while (usable.length > 1 && n === cur) n = usable[Math.floor(Math.random() * usable.length)]!;
      return n!;
    }
    const i = cur ? usable.indexOf(cur) : -1;
    return usable[(i + dir + usable.length) % usable.length]!;
  };

  const show = useCallback(
    async (name: string, blend = BLEND_SEC, remember = true) => {
      const v = viz.current;
      if (!v || !presets?.[name]) return;
      try {
        await v.loadPreset(presets[name]!, blend);
        setPresetName(name);
        if (remember) history.current = [...history.current.slice(-49), name];
        setViz({ preset: name });
      } catch {
        broken.current.add(name); // some community presets do not compile: skip them
        void show(pick(1), blend, remember);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presets, setViz, names, presetName],
  );

  const next = () => void show(pick(1));
  const prev = () => {
    // back through what was actually shown (random order), else alphabetical
    if (history.current.length > 1) {
      history.current.pop();
      void show(history.current[history.current.length - 1]!, BLEND_SEC, false);
    } else void show(pick(-1));
  };

  // ── automatic cycling
  useEffect(() => {
    if (!settings.autoCycle || !presets) return;
    const id = setInterval(() => !document.hidden && void show(pick(1)), settings.cycleSec * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.autoCycle, settings.cycleSec, presets, presetName]);

  // ── track title, MilkDrop style, when the song changes
  const titleKey = current ? `${current.id}` : null;
  useEffect(() => {
    if (!current || !viz.current || status === 'idle') return;
    viz.current.launchSongTitleAnim([current.artist, current.title].filter(Boolean).join(' — '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleKey, !!viz.current]);

  // ── controls fade out when the mouse rests
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), IDLE_MS);
    };
    wake();
    const el = stage.current!;
    el.addEventListener('pointermove', wake);
    el.addEventListener('pointerdown', wake);
    return () => {
      clearTimeout(t);
      el.removeEventListener('pointermove', wake);
      el.removeEventListener('pointerdown', wake);
    };
  }, []);

  // ── fullscreen (the stage only: tabs and player bar step aside)
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen();
  };
  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === stage.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // ── keyboard: N / P presets, R random, F fullscreen (arrows and space stay the player's)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'n') next();
      else if (k === 'p') prev();
      else if (k === 'r') setViz({ random: !useSettings.getState().viz.random });
      else if (k === 'f') toggleFull();
      else if (k === 'escape' && drawer) setDrawer(false);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const name = presetName ? splitName(presetName) : null;
  const notice = isYouTube
    ? tr('viz.youtube')
    : status === 'idle' || !current
      ? tr('viz.waiting')
      : null;

  return (
    <div ref={stage} className={`viz-stage${idle && !drawer ? ' idle' : ''}${full ? ' full' : ''}`} onDoubleClick={(e) => e.target === canvas.current && toggleFull()}>
      <canvas ref={canvas} className="viz-canvas" data-fps={fps} data-signal={signal ? 1 : 0} data-preset={presetName ?? ''} />

      {(!presets || error) && <div className="viz-loading">{error ?? tr('viz.loading')}</div>}

      <div className="viz-hud viz-top">
        {name && (
          <div className="viz-preset" title={presetName ?? ''}>
            <b>{name.title}</b>
            {name.author && <span>{name.author}</span>}
          </div>
        )}
        {notice && <div className="viz-notice">{notice}</div>}
      </div>

      <div className="viz-hud viz-bar" role="toolbar" aria-label={tr('section.visualizer')}>
        <button className="icon-btn" aria-label={tr('viz.prev')} title={tr('viz.prevHint')} onClick={prev}>
          <ChevronLeft size={20} />
        </button>
        <button className="icon-btn" aria-label={tr('viz.next')} title={tr('viz.nextHint')} onClick={next}>
          <ChevronRight size={20} />
        </button>
        <span className="viz-sep" />
        <button className={`icon-btn${settings.random ? ' on' : ''}`} aria-pressed={settings.random} aria-label={tr('viz.random')} title={tr('viz.randomHint')} onClick={() => setViz({ random: !settings.random })}>
          <Dices size={18} />
        </button>
        <div className="segmented viz-cycle" role="group" aria-label={tr('viz.autoLabel')}>
          <button className={settings.autoCycle ? 'on' : ''} aria-pressed={settings.autoCycle} title={tr('viz.autoHint')} onClick={() => setViz({ autoCycle: !settings.autoCycle })}>
            <Timer size={14} /> {settings.autoCycle ? tr('viz.auto') : tr('viz.fixed')}
          </button>
          {settings.autoCycle &&
            [15, 30, 60].map((s) => (
              <button key={s} className={settings.cycleSec === s ? 'on' : ''} onClick={() => setViz({ cycleSec: s })}>
                {s} s
              </button>
            ))}
        </div>
        <span className="viz-sep" />
        <button className={`icon-btn${drawer ? ' on' : ''}`} aria-label={tr('viz.list')} title={tr('viz.list')} onClick={() => setDrawer(!drawer)}>
          <ListMusic size={18} />
        </button>
        <button className="icon-btn" aria-label={full ? tr('viz.exitFull') : tr('viz.full')} title={full ? tr('viz.exitFullHint') : tr('viz.fullHint')} onClick={toggleFull}>
          {full ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>

      <AnimatePresence>
        {drawer && <PresetDrawer names={names} current={presetName} broken={broken.current} onPick={(n) => void show(n)} onClose={() => setDrawer(false)} />}
      </AnimatePresence>
    </div>
  );
}

function PresetDrawer({ names, current, broken, onPick, onClose }: { names: string[]; current: string | null; broken: Set<string>; onPick: (n: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const shown = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    return names.filter((n) => words.every((w) => fold(n).includes(w)));
  }, [names, q]);

  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <motion.aside
      className="viz-drawer panel"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16, transition: { duration: 0.15 } }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      <header>
        <b>{tr('viz.presets')}</b>
        <span>{names.length}</span>
        <button className="icon-btn" aria-label={tr('viz.closeList')} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <label className="search">
        <Search size={15} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('viz.search')} aria-label={tr('viz.searchLabel')} />
      </label>
      <div className="viz-list" ref={listRef}>
        {shown.map((n) => {
          const s = splitName(n);
          return (
            <button key={n} className={`viz-item${n === current ? ' on' : ''}`} disabled={broken.has(n)} title={broken.has(n) ? tr('viz.broken') : n} onClick={() => onPick(n)}>
              <b>{s.title}</b>
              {s.author && <span>{s.author}</span>}
            </button>
          );
        })}
        {!shown.length && <p className="viz-empty">{tr('viz.noMatch')}</p>}
      </div>
    </motion.aside>
  );
}
