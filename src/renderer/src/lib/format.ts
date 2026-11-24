import { tr } from '@shared/i18n';
export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '–:––';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtTotal(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return tr('fmt.min', { m: String(m) });
  return tr('fmt.hmin', { h: String(Math.floor(m / 60)), m: String(m % 60).padStart(2, '0') });
}


export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
