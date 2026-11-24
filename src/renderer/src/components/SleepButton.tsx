import { useEffect, useState } from 'react';
import { Check, Moon, MoonStar } from 'lucide-react';
import { sleepLeft, useSleep } from '@/store/sleep';
import { usePlayer } from '@/store/player';
import { fmtTime } from '@/lib/format';
import { prompt } from './Dialog';
import { showMenu } from './ContextMenu';
import { tr } from '@shared/i18n';

const MINUTES = [5, 10, 15, 30, 45, 60, 90];
/** Longest time taken (24 h). */
const MAX_MINUTES = 1440;

/** The sleep timer: a click lists the choices; while set, the time left shows, and a right-click cancels. */
export function SleepButton() {
  const { sleep, set } = useSleep();
  const radio = usePlayer((s) => s.current?.source === 'radio');
  const [, tick] = useState(0);
  useEffect(() => {
    if (sleep?.kind !== 'time') return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [sleep]);

  const left = sleepLeft(sleep);
  const label = !sleep ? tr('sleep.title') : sleep.kind === 'time' ? tr('sleep.onTime', { t: fmtTime(Math.ceil(left! / 1000)) }) : sleep.kind === 'track' ? tr('sleep.onTrack') : tr('sleep.onAlbum');
  const inMinutes = (n: number) => set({ kind: 'time', at: Date.now() + n * 60_000 });
  const custom = async () => {
    const v = await prompt({ title: tr('sleep.title'), label: tr('sleep.customLabel'), initial: '20' });
    const n = Number(v?.replace(',', '.'));
    if (v && Number.isFinite(n) && n > 0) inMinutes(Math.min(MAX_MINUTES, n));
  };
  return (
    <button
      className={`icon-btn sleep-btn${sleep ? ' on' : ''}`}
      aria-label={label}
      aria-pressed={!!sleep}
      title={label}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showMenu({ clientX: r.left, clientY: r.top, preventDefault() {} }, [
          ...(sleep ? [{ label: tr('sleep.off'), onSelect: () => set(null) }, { separator: true }] : []),
          ...MINUTES.map((n) => ({ label: tr('sleep.minutes', { n }), onSelect: () => inMinutes(n) })),
          { label: tr('sleep.custom'), onSelect: () => void custom() },
          { separator: true },
          // a live station has no end
          { label: tr('sleep.track'), icon: sleep?.kind === 'track' ? <Check size={15} /> : undefined, disabled: radio, onSelect: () => set({ kind: 'track' }) },
          { label: tr('sleep.album'), icon: sleep?.kind === 'album' ? <Check size={15} /> : undefined, disabled: radio, onSelect: () => set({ kind: 'album' }) },
        ]);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        set(null);
      }}
    >
      {sleep ? <MoonStar size={18} /> : <Moon size={18} />}
      {left !== null && <span className="count-dot sleep-left">{left >= 60_000 ? Math.ceil(left / 60_000) : `${Math.ceil(left / 1000)}s`}</span>}
    </button>
  );
}
