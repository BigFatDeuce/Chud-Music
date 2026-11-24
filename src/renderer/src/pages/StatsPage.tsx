import { useEffect, useState } from 'react';
import { ChartColumn, LoaderCircle } from 'lucide-react';
import type { Stats, StatsPeriod, StatsRow } from '@shared/types';
import { PageScroll } from '@/components/PageScroll';
import { locale, tr } from '@shared/i18n';

// Listening statistics, all computed from the local database. Plays are counted since the
// library existed; listened time (hours, sources, time of day…) since this page existed.

const PERIODS: [StatsPeriod, string][] = [
  ['7d', tr('stats.7d')],
  ['30d', tr('stats.30d')],
  ['365d', tr('stats.1y')],
  ['all', tr('lib.all')],
];
// Monday first; short weekday names in the interface language (2024-01-01 was a Monday)
const DAYS = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: 'short' }));
const nf = new Intl.NumberFormat(locale());

export function fmtDuration(s: number): string {
  if (s < 60) return tr('fmt.s', { s: String(Math.round(s)) });
  const m = Math.round(s / 60);
  if (m < 60) return tr('fmt.min', { m: String(m) });
  const h = Math.floor(m / 60);
  return h < 100 ? tr('fmt.hmin', { h: String(h), m: String(m % 60).padStart(2, '0') }) : tr('fmt.h', { h: nf.format(h) });
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-tile panel">
      <span className="stat-label">{label}</span>
      <b className="stat-value">{value}</b>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

/** Ranked list: a table, with a thin bar for the magnitude (single series, no legend). */
function Ranking({ title, rows, unit }: { title: string; rows: StatsRow[]; unit: 'plays' | 'time' }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className="stat-block panel">
      <h3>{title}</h3>
      {rows.length ? (
        <table className="stat-rank">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="stat-pos">{i + 1}</td>
                <td className="stat-name">
                  <b title={r.title}>{r.title}</b>
                  {r.artist && <span>{r.artist}</span>}
                  <i className="stat-bar" style={{ width: `${(r.value / max) * 100}%` }} aria-hidden />
                </td>
                <td className="stat-num">{unit === 'plays' ? tr('n.plays', { n: r.value }) : fmtDuration(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="stat-empty">{tr('stats.notEnough')}</p>
      )}
    </section>
  );
}

/** Column chart, one series: seconds per bucket, hover for the exact value. */
function Columns({ title, values, labels, every = 1 }: { title: string; values: number[]; labels: string[]; every?: number }) {
  const max = Math.max(1, ...values);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <section className="stat-block panel">
      <h3>{title}</h3>
      <div className="stat-cols" role="img" aria-label={`${title} : ${values.map((v, i) => `${labels[i]} ${fmtDuration(v)}`).join(', ')}`}>
        {values.map((v, i) => (
          <div key={i} className="stat-col" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            {hover === i && <span className="stat-tip">{labels[i]} · {fmtDuration(v)}</span>}
            <i style={{ height: `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%` }} className={hover === i ? 'on' : ''} />
          </div>
        ))}
      </div>
      <div className="stat-axis">
        {labels.map((l, i) => (
          <span key={i}>{i % every === 0 ? l : ''}</span>
        ))}
      </div>
    </section>
  );
}

export function StatsPage() {
  const [period, setPeriod] = useState<StatsPeriod>('30d');
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    let alive = true;
    void window.chud.stats.get(period).then((s) => alive && setStats(s));
    return () => {
      alive = false;
    };
  }, [period]);

  const s = stats;
  const total = s ? s.bySource.local + s.bySource.youtube + s.bySource.radio : 0;
  const pct = (v: number) => (total ? `${Math.round((v / total) * 100)} %` : '—');
  return (
    <PageScroll className="stats-page">
      <header className="stats-head">
        <div>
          <h1 className="page-title">{tr('section.stats')}</h1>
          <p className="page-sub">
            {tr('stats.local')}
            {s?.measuredSince && ` ${tr('stats.since', { date: new Date(`${s.measuredSince}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }) })}`}
          </p>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('stats.period')}>
          {PERIODS.map(([p, l]) => (
            <button key={p} className={period === p ? 'on' : ''} role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}>
              {l}
            </button>
          ))}
        </div>
      </header>

      {!s ? (
        <p className="radio-note"><LoaderCircle size={14} className="spin" /> {tr('stats.computing')}</p>
      ) : !s.seconds && !s.plays ? (
        <div className="empty">
          <div className="empty-art"><ChartColumn size={56} strokeWidth={1.4} /></div>
          <h3>{tr('stats.emptyTitle')}</h3>
          <p>{tr('stats.emptyText')}</p>
        </div>
      ) : (
        <>
          <div className="stat-tiles">
            <Tile label={tr('stats.time')} value={fmtDuration(s.seconds)} sub={s.activeDays ? tr('stats.perDay', { time: fmtDuration(s.seconds / s.activeDays) }) : undefined} />
            <Tile label={tr('col.plays')} value={nf.format(s.plays)} sub={tr('stats.distinct', { n: s.distinctTracks })} />
            <Tile label={tr('stats.days')} value={nf.format(s.activeDays)} sub={tr('stats.streak', { current: s.streak.current, longest: s.streak.longest })} />
            <Tile label={tr('stats.discovered')} value={nf.format(s.discovered)} sub={tr('stats.discoveredText')} />
            {s.bestDay && <Tile label={tr('stats.bestDay')} value={fmtDuration(s.bestDay.seconds)} sub={new Date(`${s.bestDay.day}T12:00:00`).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })} />}
            <Tile label={tr('section.library')} value={tr('n.titles', { n: s.library.tracks })} sub={`${tr('stats.ofMusic', { time: fmtDuration(s.library.seconds) })} · ${tr('n.playlists', { n: s.library.playlists })}`} />
          </div>

          <div className="stat-tiles small">
            <Tile label={tr('stats.local.files')} value={pct(s.bySource.local)} sub={fmtDuration(s.bySource.local)} />
            <Tile label="YouTube Music" value={pct(s.bySource.youtube)} sub={fmtDuration(s.bySource.youtube)} />
            <Tile label={tr('section.radio')} value={pct(s.bySource.radio)} sub={fmtDuration(s.bySource.radio)} />
          </div>

          <div className="stat-grid">
            <Ranking title={tr('stats.topPlays')} rows={s.topTracksByPlays} unit="plays" />
            <Ranking title={tr('stats.topTime')} rows={s.topTracksByTime} unit="time" />
            <Ranking title={tr('stats.artists')} rows={s.topArtists} unit="time" />
            <Ranking title={tr('stats.albums')} rows={s.topAlbums} unit="time" />
            <Columns title={tr('stats.hours')} values={s.hours} labels={s.hours.map((_, h) => tr('fmt.hour', { h: String(h) }))} every={3} />
            <Columns title={tr('stats.weekdays')} values={s.weekdays} labels={DAYS} />
            {s.topStations.length > 0 && <Ranking title={tr('stats.stations')} rows={s.topStations} unit="time" />}
          </div>
        </>
      )}
    </PageScroll>
  );
}
