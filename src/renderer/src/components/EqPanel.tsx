import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { EQ_BANDS, type EqSettings } from '@shared/types';
import { engine } from '@/audio/engine';
import { EQ_PRESETS, EQ_RANGE_DB, eqCurve, fmtBand, presetLabel } from '@/audio/eq';
import { usePlayer } from '@/store/player';
import { useSettings } from '@/store/settings';
import { showMenu, type MenuItem } from './ContextMenu';
import { prompt } from './Dialog';
import { tr } from '@shared/i18n';

// Winamp-spirited 10-band equaliser. Non-destructive: it only sets the filters of the playback
// graph. While a slider moves, the filters follow live; the setting is saved on release.

export const useEqPanel = create<{ open: boolean; toggle(): void; close(): void }>((set, get) => ({
  open: false,
  toggle: () => set({ open: !get().open }),
  close: () => set({ open: false }),
}));

const round = (v: number) => Math.round(v * 2) / 2; // 0.5 dB steps

function VSlider({ value, label, onChange, onCommit }: { value: number; label: string; onChange: (v: number) => void; onCommit: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const pct = ((value + EQ_RANGE_DB) / (2 * EQ_RANGE_DB)) * 100;
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return round(Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, EQ_RANGE_DB - ((e.clientY - r.top) / r.height) * 2 * EQ_RANGE_DB)));
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 3 : 0.5;
    const next = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? value + step : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? value - step : e.key === 'Home' ? EQ_RANGE_DB : e.key === 'End' ? -EQ_RANGE_DB : e.key === '0' ? 0 : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onCommit(Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, next)));
  };
  return (
    <div
      ref={ref}
      className={`eq-vslider${drag ? ' dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={-EQ_RANGE_DB}
      aria-valuemax={EQ_RANGE_DB}
      aria-valuenow={value}
      aria-valuetext={`${value > 0 ? '+' : ''}${value} dB`}
      title={`${label} : ${value > 0 ? '+' : ''}${value} dB (double-clic : 0)`}
      style={{ ['--pct' as string]: `${pct}%` }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(true);
        onChange(at(e));
      }}
      onPointerMove={(e) => drag && onChange(at(e))}
      onPointerUp={(e) => {
        if (!drag) return;
        setDrag(false);
        onCommit(at(e));
      }}
      onDoubleClick={() => onCommit(0)}
      onWheel={(e) => onCommit(Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, value + (e.deltaY < 0 ? 0.5 : -0.5))))}
      onKeyDown={key}
    >
      <div className="eq-track">
        <div className="eq-zero" />
        <div className="eq-fill" />
        <div className="eq-thumb" />
      </div>
    </div>
  );
}

const W = 520;
const H = 92;
const FREQS = Float32Array.from({ length: 160 }, (_, i) => 20 * Math.pow(1000, i / 159)); // 20 Hz – 20 kHz

function Curve({ eq }: { eq: EqSettings }) {
  const path = useMemo(() => {
    const db = eqCurve(eq, FREQS);
    const y = (v: number) => H / 2 - (Math.max(-18, Math.min(18, v)) / 18) * (H / 2 - 4);
    return Array.from(db, (v, i) => `${i ? 'L' : 'M'}${((i / (FREQS.length - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`).join('');
  }, [eq]);
  return (
    <svg className="eq-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={tr('eq.curve')}>
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="eq-curve-zero" />
      <path d={`${path}L${W},${H}L0,${H}Z`} className="eq-curve-fill" />
      <path d={path} className="eq-curve-line" />
    </svg>
  );
}

export function EqPanel() {
  const { open, close } = useEqPanel();
  const saved = useSettings((s) => s.eq);
  const userPresets = useSettings((s) => s.eqUserPresets);
  const setSettings = useSettings((s) => s.set);
  const isYouTube = usePlayer((s) => s.current?.source === 'youtube');
  const [live, setLive] = useState<EqSettings | null>(null);
  const [applied, setApplied] = useState('');
  const eq = live ?? saved;

  // what the filter nodes really hold, exposed for the tests (data-applied)
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      const a = engine.local.appliedEq();
      setApplied(a ? [a.preampDb, ...a.gains].map((v) => v.toFixed(1)).join(',') : '');
    }, 250);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const preview = (next: EqSettings) => {
    setLive(next);
    engine.setEq(next);
  };
  const commit = (next: EqSettings) => {
    setLive(null);
    setSettings({ eq: next });
  };
  const band = (i: number, v: number) => ({ ...eq, enabled: true, preset: 'Personnalisé', gains: eq.gains.map((g, k) => (k === i ? v : g)) });
  const pre = (v: number) => ({ ...eq, enabled: true, preset: 'Personnalisé', preampDb: v });
  const applyPreset = (p: { name: string; preampDb: number; gains: number[] }) => commit({ enabled: true, preset: p.name, preampDb: p.preampDb, gains: [...p.gains] });

  const presetMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      ...EQ_PRESETS.map((p) => ({ label: presetLabel(p.name), onSelect: () => applyPreset(p) })),
      ...(userPresets.length ? [{ separator: true } as MenuItem, ...userPresets.map((p) => ({ label: p.name, onSelect: () => applyPreset(p) }))] : []),
      { separator: true },
      {
        label: tr('eq.saveSettings'),
        icon: <Save size={15} />,
        onSelect: async () => {
          const name = await prompt({ title: tr('eq.savePreset'), label: tr('common.name'), initial: eq.preset === 'Personnalisé' ? tr('eq.myPreset') : presetLabel(eq.preset), confirm: tr('common.save') });
          if (!name) return;
          const mine = { name, preampDb: eq.preampDb, gains: [...eq.gains] };
          setSettings({ eqUserPresets: [...userPresets.filter((p) => p.name !== name), mine], eq: { ...eq, preset: name } });
        },
      },
      ...(userPresets.some((p) => p.name === eq.preset)
        ? [{ label: tr('common.deleteNamed', { name: eq.preset }), icon: <Trash2 size={15} />, danger: true, onSelect: () => setSettings({ eqUserPresets: userPresets.filter((p) => p.name !== eq.preset), eq: { ...eq, preset: 'Personnalisé' } }) } as MenuItem]
        : []),
    ];
    showMenu(e, items);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="eq-panel panel"
          aria-label={tr('eq.title')}
          data-applied={applied}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10, transition: { duration: 0.15 } }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <header className="eq-head">
            <b>{tr('eq.title')}</b>
            <div className="segmented" role="radiogroup" aria-label={tr('eq.title')}>
              <button className={eq.enabled ? 'on' : ''} role="radio" aria-checked={eq.enabled} onClick={() => commit({ ...eq, enabled: true })}>{tr('common.on')}</button>
              <button className={!eq.enabled ? 'on' : ''} role="radio" aria-checked={!eq.enabled} onClick={() => commit({ ...eq, enabled: false })}>{tr('common.off')}</button>
            </div>
            <button className="btn eq-preset" aria-label={tr('eq.preset')} onClick={presetMenu}>
              {presetLabel(eq.preset)} <ChevronDown size={14} />
            </button>
            <button className="icon-btn" aria-label={tr('eq.reset')} title={tr('eq.reset')} onClick={() => applyPreset(EQ_PRESETS[0]!)}>
              <RotateCcw size={16} />
            </button>
            <button className="icon-btn" aria-label={tr('eq.close')} onClick={close}>
              <X size={16} />
            </button>
          </header>

          <div className="lcd-screen eq-screen">
            <Curve eq={eq} />
          </div>

          <div className={`eq-sliders${eq.enabled ? '' : ' off'}`}>
            <div className="eq-col preamp">
              <span className="eq-val lcd">{eq.preampDb > 0 ? '+' : ''}{eq.preampDb}</span>
              <VSlider label={tr('eq.preamp')} value={eq.preampDb} onChange={(v) => preview(pre(v))} onCommit={(v) => commit(pre(v))} />
              <span className="eq-label">{tr('eq.preamp')}</span>
            </div>
            <div className="eq-scale" aria-hidden>
              <span>+{EQ_RANGE_DB}</span>
              <span>0</span>
              <span>−{EQ_RANGE_DB}</span>
            </div>
            {EQ_BANDS.map((f, i) => (
              <div key={f} className="eq-col">
                <span className="eq-val lcd">{(eq.gains[i] ?? 0) > 0 ? '+' : ''}{eq.gains[i] ?? 0}</span>
                <VSlider label={`${fmtBand(f)} Hz`} value={eq.gains[i] ?? 0} onChange={(v) => preview(band(i, v))} onCommit={(v) => commit(band(i, v))} />
                <span className="eq-label">{fmtBand(f)}</span>
              </div>
            ))}
          </div>

          <p className="eq-note">
            {isYouTube
              ? tr('eq.ytNote')
              : tr('eq.liveNote')}
          </p>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
