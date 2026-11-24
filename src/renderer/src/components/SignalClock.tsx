import { useEffect, useRef, useState } from 'react';
import { useSettings } from '@/store/settings';
import { locale } from '@shared/i18n';

// The Home clock in the Signal skin: a broadcast monitor's timecode. Seconds tick, the colon
// blinks, a changing digit scrambles through noise before it settles, the readout is split
// red/cyan and tears for a few frames every few seconds, a roll bar drifts down the screen and
// the date types itself in. Effects "Complets" only; "Réduits"/"Aucun" and the system's
// reduced-motion setting leave a still, readable clock. Transforms, opacity and clip-path only.

const NOISE = '0123456789#%&@$?!/<>';

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Text that, when it changes, runs through random characters for ~300 ms (changed places only). */
function useScramble(value: string, live: boolean, frames = 7): string {
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (!live || from === value || from.length !== value.length) return setShown(value);
    const changed = [...value].map((c, i) => c !== from[i] && /\d/.test(c));
    let frame = 0;
    const id = setInterval(() => {
      frame++;
      if (frame >= frames) {
        clearInterval(id);
        return setShown(value);
      }
      // places settle left to right
      const settled = Math.floor((frame / frames) * value.length);
      setShown([...value].map((c, i) => (changed[i] && i >= settled ? NOISE[Math.floor(Math.random() * NOISE.length)]! : c)).join(''));
    }, 42);
    return () => clearInterval(id);
  }, [value, live, frames]);
  return shown;
}

/** The date typed in, one character every 28 ms, when it first shows and when the day changes. */
function useTyped(value: string, live: boolean): string {
  const [n, setN] = useState(live ? 0 : value.length);
  useEffect(() => {
    if (!live) return setN(value.length);
    setN(0);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setN(i);
      if (i >= value.length) clearInterval(id);
    }, 28);
    return () => clearInterval(id);
  }, [value, live]);
  return value.slice(0, n);
}

export function SignalClock() {
  const effects = useSettings((s) => s.effects);
  const live = effects === 'full' && !reducedMotion();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // on the second boundary, so the seconds never skip or stutter
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      id = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    id = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    return () => clearTimeout(id);
  }, []);

  const hm = now.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const sec = String(now.getSeconds()).padStart(2, '0');
  const date = now.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  const shownHm = useScramble(hm, live);
  const shownSec = useScramble(sec, live, 3); // every second: a short flicker only
  const typed = useTyped(date, live);
  const full = `${hm}:${sec}`;

  return (
    <div className={`hero-lcd lcd-screen signal-clock${live ? ' live' : ''}`} role="timer" aria-label={`${hm} — ${date}`}>
      <div className="sc-top" aria-hidden="true">
        <span className="sc-rec"><i /> REC</span>
        <span className="sc-ch">CH·01</span>
      </div>
      <div className="lcd clock sc-time" data-text={full} aria-hidden="true">
        <span className="sc-hm">{shownHm}</span>
        <span className="sc-sec"><span className="sc-colon">:</span>{shownSec}</span>
      </div>
      <div className="lcd date sc-date" aria-hidden="true">
        {/* the full date keeps the box its final width while it types in */}
        <span className="sc-date-full">{date}</span>
        <span className="sc-date-typed">
          {typed}
          {live && typed.length < date.length && <span className="sc-caret">▌</span>}
        </span>
      </div>
      <span className="sc-roll" aria-hidden="true" />
    </div>
  );
}
