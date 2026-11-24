import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

interface Props {
  value: number; // 0..1
  buffered?: number; // 0..1
  onChange?: (v: number) => void; // live, while dragging
  onCommit: (v: number) => void; // on release / keyboard
  label: string;
  step?: number;
  disabled?: boolean;
  valueText?: string;
}

export function Slider({ value, buffered = 0, onChange, onCommit, label, step = 0.05, disabled, valueText }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;

  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = at(e);
    setDrag(v);
    onChange?.(v);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const v = at(e);
    setDrag(v);
    onChange?.(v);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    onCommit(at(e));
    setDrag(null);
  };
  const key = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onCommit(Math.min(1, Math.max(0, value + d)));
  };

  return (
    <div
      ref={ref}
      className={`slider${drag !== null ? ' dragging' : ''}${disabled ? ' disabled' : ''}`}
      style={{ ['--pct' as string]: `${shown * 100}%`, ['--buf' as string]: `${buffered * 100}%` }}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      aria-valuetext={valueText}
      aria-disabled={disabled}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={key}
    >
      <div className="slider-track">
        <div className="slider-buffer" />
        <div className="slider-fill" />
      </div>
      <div className="slider-thumb" />
    </div>
  );
}
