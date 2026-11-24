import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, LoaderCircle, MicVocal } from 'lucide-react';
import type { LyricsResult, Track, TrackStats } from '@shared/types';
import { engine } from '@/audio/engine';
import { usePlayer } from '@/store/player';
import { useTabs } from '@/store/tabs';
import { useYouTube } from '@/store/youtube';
import { fmtTotal } from '@/lib/format';
import { lineAt, lyricsQuery, parseLrc, type LyricLine } from '@/lib/lyrics';
import { useYtLinks } from './YtMeta';
import { artistName, mainArtist } from '@/lib/artist';
import { tr } from '@shared/i18n';

// The strip above the controls when the YouTube player is docked in the player bar: the lyrics
// following the song (synced: the line being sung between the previous and the next one; plain:
// the text scrolling with the song), otherwise the track card — what is known about it, the
// listening history, and where to learn more about the artist.

const EASE = [0.22, 1, 0.36, 1] as const;

export function DockStage() {
  const current = usePlayer((s) => s.current);
  const { query, key } = lyricsQuery(current);
  // results belong to the track that asked for them: never the previous track's lyrics for a frame
  const [got, setGot] = useState<{ key: string; lyrics?: LyricsResult; stats?: TrackStats }>({ key: '' });
  const lyrics = got.key === key ? (got.lyrics ?? null) : null;
  const stats = got.key === key ? (got.stats ?? null) : null;

  useEffect(() => {
    if (!current) return;
    let live = true;
    if (query) void window.chud.lyrics.get(query).then((r) => live && setGot((g) => ({ ...(g.key === key ? g : { key }), lyrics: r })));
    void window.chud.stats.track(current.id, mainArtist(current)).then((s) => live && setGot((g) => ({ ...(g.key === key ? g : { key }), stats: s })));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!current) return null;
  const view = lyrics?.status === 'synced' ? 'synced' : lyrics?.status === 'plain' ? 'plain' : 'card';
  return (
    <div className="np-stage" data-view={view}>
      {/* a new track or a new view fades in; no exit animation (it could keep the old content) */}
      <motion.div key={`${current.id}|${view}`} className="np-stage-inner" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE }}>
          {view === 'card' ? (
            <TrackCard track={current} lyrics={lyrics} searching={!!query && !lyrics} stats={stats} />
          ) : (
            <>
              <div className="np-stage-main">{view === 'synced' ? <SyncedLyrics lrc={lyrics!.synced!} /> : <PlainLyrics text={lyrics!.plain!} track={current} />}</div>
              <aside className="np-stage-aside">
                <TrackInfo track={current} stats={stats} small />
                <TrackLinks track={current} />
              </aside>
            </>
          )}
      </motion.div>
    </div>
  );
}

const openLyrics = () => useTabs.getState().openSection('lyrics');

function Kicker({ children }: { children: ReactNode }) {
  return (
    <button className="np-stage-kicker" onClick={openLyrics} title={tr('dock.openLyrics')}>
      <MicVocal size={12} /> {children}
    </button>
  );
}

/** The line being sung, lit, between the previous and the next one; click a line to go there. */
function SyncedLyrics({ lrc }: { lrc: string }) {
  const lines = useMemo(() => parseLrc(lrc), [lrc]);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const tick = () => setActive(lineAt(lines, engine.currentTime + 0.15));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [lines]);
  const line = (i: number, cls: string) => {
    const l: LyricLine | undefined = lines[i];
    // before the first line, the one being "sung" is the intro (♪)
    if (i >= lines.length || (i < 0 && cls !== 'on')) return <div className={`np-lyric ${cls} empty`} aria-hidden />;
    return (
      <button className={`np-lyric ${cls}`} title={tr('lyrics.seekHere')} onClick={() => l && usePlayer.getState().seek(l.t)} disabled={!l}>
        {l?.text || '♪'}
      </button>
    );
  };
  return (
    <>
      <Kicker>{tr('lyrics.synced')}</Kicker>
      <div className="np-lyrics">
        {/* each new line slides in; no exit animation either */}
        <motion.div key={active} className="np-lyrics-set" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: EASE }}>
            {line(active - 1, 'prev')}
            {line(active, 'on')}
            {line(active + 1, 'next')}
          </motion.div>
      </div>
    </>
  );
}

/** Lyrics without timing: the text scrolls in proportion to the song (approximate). */
function PlainLyrics({ text, track }: { text: string; track: Track }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tick = () => {
      const dur = usePlayer.getState().duration || track.durationSec || 0;
      const b = box.current;
      const i = inner.current;
      if (!b || !i || !dur) return;
      // a little lead: the visible block is roughly what is being sung
      const p = Math.min(1, Math.max(0, (engine.currentTime - 8) / Math.max(1, dur - 16)));
      i.style.transform = `translateY(${-Math.round(p * Math.max(0, i.scrollHeight - b.clientHeight))}px)`;
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [text, track]);
  return (
    <>
      <Kicker>{tr('dock.plainKicker')}</Kicker>
      <div className="np-plain" ref={box}>
        <div className="np-plain-text" ref={inner}>{text}</div>
      </div>
    </>
  );
}

function links(t: Track): { label: string; href: string; title: string }[] {
  const who = mainArtist(t);
  const q = encodeURIComponent(who ?? t.title);
  const plus = (who ?? t.title).trim().replace(/\s+/g, '+');
  const yt = t.ytArtistId?.startsWith('UC') ? `https://music.youtube.com/channel/${t.ytArtistId}` : `https://music.youtube.com/search?q=${q}`;
  return [
    { label: 'YouTube Music', href: yt, title: tr('links.ytm') },
    { label: tr('links.wikipediaLabel'), href: `https://${tr('links.wikipediaHost')}/w/index.php?search=${q}&go=Go`, title: tr('links.wikipedia') },
    { label: 'Grokipedia', href: `https://grokipedia.com/search?q=${q}`, title: tr('links.grokipedia') },
    { label: 'Last.fm', href: `https://www.last.fm/fr/music/${encodeURIComponent(plus).replace(/%2B/g, '+')}`, title: tr('links.lastfm') },
    { label: 'Discogs', href: `https://www.discogs.com/fr/search/?q=${q}&type=artist`, title: tr('links.discogs') },
  ];
}

function historyOf(track: Track, stats: TrackStats | null): string[] {
  const out: string[] = [];
  if (!stats) return out;
  out.push(stats.plays === 0 ? tr('dock.firstListen') : tr('dock.played', { n: stats.plays }));
  if (stats.seconds >= 60) out.push(tr('dock.onTrack', { time: fmtTotal(stats.seconds) }));
  const main = mainArtist(track);
  if (main && stats.artistSeconds >= 60 && stats.artistSeconds > stats.seconds + 30) out.push(tr('dock.artistTotal', { time: fmtTotal(stats.artistSeconds), artist: main }));
  return out;
}

/** Artist and album (to their YouTube Music pages in the app), year, listening history. */
function TrackInfo({ track, stats, small }: { track: Track; stats: TrackStats | null; small?: boolean }) {
  const yt = useYouTube.getState();
  const links = useYtLinks();
  const who = artistName(track);
  const history = historyOf(track, stats);
  return (
    <div className={`np-info${small ? ' small' : ''}`}>
      <div className="np-card-main">
        {who && track.ytArtistId && links ? (
          <button className="np-card-artist link-quiet" onClick={() => yt.openArtist(track.ytArtistId!)} title={tr('common.openArtist')}>{who}</button>
        ) : (
          <span className="np-card-artist">{who ?? track.title}</span>
        )}
        {track.album && <span className="np-card-sep">·</span>}
        {track.album &&
          (track.ytAlbumId && links ? (
            <button className="np-card-album link-quiet" onClick={() => yt.openAlbum(track.ytAlbumId!)} title={tr('common.openAlbum')}>{track.album}</button>
          ) : (
            <span className="np-card-album">{track.album}</span>
          ))}
        {track.year ? <span className="np-card-year">{track.year}</span> : null}
      </div>
      {history.length > 0 && <div className="np-card-history">{history.join(' · ')}</div>}
    </div>
  );
}

/** Where to learn more about the artist (opens the browser). */
function TrackLinks({ track }: { track: Track }) {
  return (
    <nav className="np-card-links" aria-label={tr('links.about', { name: mainArtist(track) ?? track.title })}>
      <span>{tr('links.learnMore')}</span>
      {links(track).map((l) => (
        <a key={l.label} href={l.href} target="_blank" rel="noreferrer" title={l.title}>
          {l.label}
          <ArrowUpRight size={11} />
        </a>
      ))}
    </nav>
  );
}

/** No lyrics: the reason, then what is known about the track and links about the artist. */
function TrackCard({ track, lyrics, searching, stats }: { track: Track; lyrics: LyricsResult | null; searching: boolean; stats: TrackStats | null }) {
  const reason =
    lyrics?.status === 'instrumental' ? tr('lyrics.instrumental') : lyrics?.status === 'error' ? tr('dock.lrclibDown') : tr('dock.noLyrics');
  return (
    <div className="np-card">
      {searching ? (
        <span className="np-stage-kicker static">
          <LoaderCircle size={12} className="spin" /> {tr('lyrics.searching')}
        </span>
      ) : (
        <Kicker>{reason}</Kicker>
      )}
      <TrackInfo track={track} stats={stats} />
      <TrackLinks track={track} />
    </div>
  );
}
