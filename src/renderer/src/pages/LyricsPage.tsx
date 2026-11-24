import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, MicVocal, RefreshCw, Search } from 'lucide-react';
import type { LyricsResult } from '@shared/types';
import { engine } from '@/audio/engine';
import { usePlayer } from '@/store/player';
import { PageScroll } from '@/components/PageScroll';
import { lineAt, lyricsQuery, parseLrc } from '@/lib/lyrics';
import { tr } from '@shared/i18n';

// Lyrics of what is playing (files, YouTube, radio titles), from LRCLIB. Time-synced lyrics
// follow the music line by line (click a line to jump there); otherwise the plain text is
// shown; when nothing is found the page says so and the search can be corrected by hand.

export function LyricsPage() {
  const current = usePlayer((s) => s.current);
  const status = usePlayer((s) => s.status);
  const [result, setResult] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState<{ title: string; artist: string } | null>(null);
  const reqId = useRef(0);

  const { query, key, onAir } = lyricsQuery(current);

  const load = (q: NonNullable<typeof query>, force = false) => {
    const id = ++reqId.current;
    setLoading(true);
    void window.chud.lyrics.get(q, force).then((r) => {
      if (id !== reqId.current) return; // the track changed meanwhile
      setResult(r);
      setLoading(false);
    });
  };

  useEffect(() => {
    setResult(null);
    setEdit(null);
    if (query) load(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const lines = useMemo(() => (result?.synced ? parseLrc(result.synced) : []), [result]);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // follow the music: the line being sung is lit and kept in the middle
  useEffect(() => {
    if (!lines.length) return;
    let raf = 0;
    let last = -2;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const t = engine.currentTime + 0.15;
      const i = lineAt(lines, t);
      if (i !== last) {
        last = i;
        setActive(i);
        const el = listRef.current?.querySelector<HTMLElement>(`[data-line="${i}"]`);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lines]);

  if (!current) {
    return (
      <PageScroll>
        <h1 className="page-title">{tr('section.lyrics')}</h1>
        <div className="empty">
          <div className="empty-art"><MicVocal size={56} strokeWidth={1.4} /></div>
          <h3>{tr('common.nothingPlaying')}</h3>
          <p>{tr('lyrics.idle')}</p>
        </div>
      </PageScroll>
    );
  }

  if (onAir === null) {
    return (
      <PageScroll>
        <h1 className="page-title">{tr('section.lyrics')}</h1>
        <div className="empty">
          <div className="empty-art"><MicVocal size={56} strokeWidth={1.4} /></div>
          <h3>{current.title}</h3>
          <p>{tr('lyrics.radioNoTitle')}</p>
        </div>
      </PageScroll>
    );
  }

  const matched = result?.matched;
  return (
    <PageScroll className="lyrics-page">
      <header className="lyrics-head">
        <div>
          <span className="list-hero-kicker">{tr('section.lyrics')}</span>
          <h1 className="page-title">{current.title}</h1>
          <p className="page-sub">
            {current.artist ?? tr('common.unknownArtist')}
            {result?.status === 'synced' && <span className="badge accent">{tr('lyrics.badgeSynced')}</span>}
            {result?.status === 'plain' && <span className="badge">{tr('lyrics.badgePlain')}</span>}
          </p>
        </div>
        <div className="lyrics-actions">
          <button className="btn ghost small" title={tr('lyrics.fixHint')} onClick={() => setEdit({ title: result?.query.title ?? current.title, artist: result?.query.artist ?? current.artist ?? '' })}>
            <Search size={14} /> {tr('lyrics.searchOther')}
          </button>
          <button className="btn ghost small" disabled={loading} onClick={() => query && load(query, true)}>
            <RefreshCw size={14} /> {tr('common.retry')}
          </button>
        </div>
      </header>

      {edit && (
        <form
          className="lyrics-edit panel"
          onSubmit={(e) => {
            e.preventDefault();
            load({ title: edit.title, artist: edit.artist || null, album: null, durationSec: null }, true); // another song maybe: its length is unknown
            setEdit(null);
          }}
        >
          <label>{tr('col.title')}<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} autoFocus /></label>
          <label>{tr('col.artist')}<input value={edit.artist} onChange={(e) => setEdit({ ...edit, artist: e.target.value })} /></label>
          <button className="btn primary" type="submit">{tr('common.find')}</button>
          <button className="btn ghost" type="button" onClick={() => setEdit(null)}>{tr('common.cancel')}</button>
        </form>
      )}

      {loading && !result ? (
        <p className="lyrics-state"><LoaderCircle size={16} className="spin" /> {tr('lyrics.searching')}</p>
      ) : !result ? null : result.status === 'synced' ? (
        <div className={`lyrics-lines${status === 'playing' ? '' : ' paused'}`} ref={listRef}>
          {lines.map((l, i) => (
            <button key={i} data-line={i} className={`lyrics-line${i === active ? ' on' : i < active ? ' past' : ''}`} onClick={() => usePlayer.getState().seek(l.t)} title={tr('lyrics.seekHere')}>
              {l.text || '♪'}
            </button>
          ))}
        </div>
      ) : result.status === 'plain' ? (
        <div className="lyrics-plain">{result.plain}</div>
      ) : result.status === 'instrumental' ? (
        <p className="lyrics-state">{tr('lyrics.instrumentalNone')}</p>
      ) : result.status === 'error' ? (
        <p className="lyrics-state warn">{tr('lyrics.unavailable', { error: result.error })}</p>
      ) : (
        <div className="lyrics-state">
          <b>{tr('lyrics.notFound')}</b>
          <span>
            {result.query.artist ? tr('lyrics.notFoundBy', { title: result.query.title, artist: result.query.artist }) : tr('lyrics.notFoundText', { title: result.query.title })}
          </span>
        </div>
      )}

      {matched && (result?.status === 'synced' || result?.status === 'plain') && (
        <p className="lyrics-credit">
          Paroles : {matched.artist} — {matched.title}
          {matched.album ? ` (${matched.album})` : ''}, base communautaire LRCLIB.
        </p>
      )}
    </PageScroll>
  );
}
