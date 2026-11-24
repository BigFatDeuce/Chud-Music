import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { motion } from 'motion/react';
import { AudioWaveform, CirclePlay, Eraser, FolderOpen, FolderPlus, ListPlus, Pause, Play, RefreshCw, Upload } from 'lucide-react';
import { RECENT_PLAYED, type HomeSection, type Track } from '@shared/types';
import { openChooser } from '@/lib/add-menus';
import { createPlaylistWith, trackMenu } from '@/lib/track-actions';
import { useTabs } from '@/store/tabs';
import { inRecentAdded, useLibrary } from '@/store/library';
import { usePlayer } from '@/store/player';
import { CoverArt } from '@/components/CoverArt';
import { PageScroll } from '@/components/PageScroll';
import { showMenu } from '@/components/ContextMenu';
import { endDrag, startDrag } from '@/lib/drag';
import { fmtTime } from '@/lib/format';
import { usePlaylists } from '@/store/playlists';
import { useCanvasFx } from '@/components/Fx';
import { Ripple } from '@/components/canvasui/Ripple';
import { HeroDither, useSignalFx } from '@/components/SignalFx';
import { SignalClock } from '@/components/SignalClock';
import { useSettings } from '@/store/settings';
import { locale, tr } from '@shared/i18n';

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const ease = [0.22, 1, 0.36, 1] as const;
const item = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.35, ease } } };

/** The track the player holds (playing, paused or restored from last session), ready to resume. */
function ResumeHero() {
  const { current, status, ctx, resumeAt, duration, toggle } = usePlayer();
  const fx = useCanvasFx();
  const signal = useSignalFx();
  if (!current) return null;
  const playing = status === 'playing';
  const art = (
    <div className="resume-art">
      <CoverArt url={current.coverUrl} size={44} cors />
    </div>
  );
  return (
    <div className="resume">
      {/* clicking the cover plays/pauses; with effects on, the press sends a ripple through it */}
      <div className="resume-art-host" role="button" tabIndex={-1} aria-hidden onClick={toggle}>
        {/* Signal: the whole box is dithered (HeroDither), not the cover alone */}
        {signal ? art : fx ? <Ripple className="resume-art-fx" amplitude={0.6} refraction={60} rings={2} shine={0.35} dispersion={0.3}>{art}</Ripple> : art}
      </div>
      <div className="resume-meta">
        <div className="list-hero-kicker">{playing ? tr('cover.playing') : tr('home.resume')}{ctx ? ` · ${ctx.label}` : ''}</div>
        <h1 title={current.title}>{current.title}</h1>
        <p>
          {[current.artist ?? tr('common.unknownArtist'), current.album].filter(Boolean).join(' — ')}
          {!playing && resumeAt > 0 ? ` · ${fmtTime(resumeAt)} / ${fmtTime(duration || current.durationSec)}` : ''}
        </p>
        <div className="home-hero-actions">
          <button className="btn primary" onClick={toggle}>
            {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            {playing ? tr('player.pause') : tr('home.resume')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Recently played" › Clear all. */
export function ClearRecent() {
  return (
    <button className="btn ghost small" data-clear-recent onClick={() => void useLibrary.getState().clearRecent()}>
      <Eraser size={13} /> {tr('rec.clearAll')}
    </button>
  );
}

/** A horizontal shelf of covers; each plays within the shelf's own list. */
function Shelf({ title, tracks, tabLabel, action, hide }: { title: string; tracks: Track[]; tabLabel: string; action?: ReactNode; hide?: 'played' | 'added' }) {
  if (!tracks.length) return null;
  const play = (i: number) => usePlayer.getState().playFrom('section:library', tabLabel, tracks, i);
  return (
    <>
      <h2 className="section-title">
        {title}
        {action}
      </h2>
      <div className="shelf">
        {tracks.map((t, i) => (
          <div
            key={`${t.id}-${i}`}
            className="shelf-item"
            role="button"
            tabIndex={0}
            draggable
            onDragStart={(e) => startDrag(e, { tracks: [t] })}
            onDragEnd={endDrag}
            onDoubleClick={() => play(i)}
            onKeyDown={(e) => e.key === 'Enter' && play(i)}
            onContextMenu={(e) =>
              showMenu(e, trackMenu([t], { play: () => play(i), ...(hide ? { remove: { label: tr('lib.removeFromNamed', { name: title }), run: () => void useLibrary.getState().hideRecent(hide, [t]) } } : {}) }))
            }
          >
            <div className="album-art">
              <CoverArt url={t.coverUrl} size={30} thumb={256} />
              <button className="album-play" aria-label={tr('common.playNamed', { name: t.title })} onClick={() => play(i)}>
                <Play size={16} fill="currentColor" style={{ marginLeft: 2 }} />
              </button>
            </div>
            <b title={t.title}>{t.title}</b>
            <span>{t.artist ?? tr('common.unknownArtist')}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The "Random" shelf: drawn at launch and kept while the app runs (switching tabs does not change
 * it), drawn again with its refresh button.
 */
const useRandomSeed = create<{ seed: number }>(() => ({ seed: Math.floor(Math.random() * 0x7fffffff) }));
const redraw = () => useRandomSeed.setState({ seed: Math.floor(Math.random() * 0x7fffffff) });
/** A stable pseudo-random rank for a track (FNV-1a of the seed and its id). */
function rank(seed: number, id: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The `n` tracks with the smallest key, in order (one pass, no sort of the whole library). */
function smallest(tracks: Track[], n: number, key: (t: Track) => number): Track[] {
  const out: { t: Track; k: number }[] = [];
  for (const t of tracks) {
    const k = key(t);
    if (out.length === n && k >= out[n - 1]!.k) continue;
    let i = out.length;
    while (i > 0 && out[i - 1]!.k > k) i--;
    out.splice(i, 0, { t, k });
    if (out.length > n) out.pop();
  }
  return out.map((x) => x.t);
}

export function HomePage() {
  const now = useNow();
  const signal = useSignalFx();
  const skin = useSettings((s) => s.skin);
  // sections turned off in Settings › Home
  const hidden = useSettings((s) => s.homeHidden);
  const show = (k: HomeSection) => !hidden.includes(k);
  const openSection = useTabs((s) => s.openSection);
  const openPlaylist = useTabs((s) => s.openPlaylist);
  const tracks = useLibrary((s) => s.tracks);
  const recentlyPlayed = useLibrary((s) => s.recentlyPlayed);
  const hasLibrary = useLibrary((s) => s.folders.length > 0);
  const { addFolder } = useLibrary.getState();
  const playlistCount = usePlaylists((s) => s.list.length);
  const hasCurrent = usePlayer((s) => s.current !== null);

  // the same tracks all session long, whatever is added or removed meanwhile
  const seed = useRandomSeed((s) => s.seed);
  const random = useMemo(() => smallest(tracks, 18, (t) => rank(seed, t.id)), [tracks, seed]);
  const hiddenAdded = useLibrary((s) => s.hiddenAdded);
  const recentlyAdded = useMemo(() => smallest(tracks, 18, (t) => (inRecentAdded(t, hiddenAdded) ? -(t.addedAt ?? 0) : Infinity)).filter((t) => inRecentAdded(t, hiddenAdded)), [tracks, hiddenAdded]);

  const cards = [
    { icon: FolderOpen, title: tr('home.openFiles'), text: tr('home.openFilesText'), run: (e: React.MouseEvent) => openChooser(e) },
    { icon: Upload, title: tr('home.dnd'), text: tr('home.dndText'), info: true },
    ...(hasLibrary ? [] : [{ icon: FolderPlus, title: tr('lib.addFolder'), text: tr('home.addFolderText'), run: () => void addFolder() }]),
    { icon: ListPlus, title: tr('home.createPl'), text: tr('home.createPlText'), run: () => void createPlaylistWith().then((id) => id && openPlaylist(id)) },
    { icon: CirclePlay, title: 'YouTube Music', text: tr('home.ytText'), run: () => openSection('youtube') },
    { icon: AudioWaveform, title: tr('home.viz'), text: tr('home.vizText'), run: () => openSection('visualizer') },
  ];

  return (
    <PageScroll>
      <motion.section className="home-hero panel" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease }}>
        {skin === 'signal' ? (
          <SignalClock />
        ) : (
          <div className="hero-lcd lcd-screen">
            <div className="lcd clock">{now.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</div>
            <div className="lcd date">{now.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}</div>
          </div>
        )}
        <div className="home-hero-main">
          {hasCurrent ? (
            signal ? (
              <HeroDither>
                <ResumeHero />
              </HeroDither>
            ) : (
              <ResumeHero />
            )
          ) : (
            <>
              <h1>{hasLibrary ? `${tr('n.tracks', { n: tracks.length })}, ${tr('n.playlists', { n: playlistCount })}` : tr('home.addMusic')}</h1>
              <p>
                {hasLibrary
                  ? tr('home.subLibrary')
                  : tr('home.subEmpty')}
              </p>
              <div className="home-hero-actions">
                {hasLibrary ? (
                  <button className="btn primary" onClick={() => openSection('library')}>{tr('home.openLibrary')}</button>
                ) : (
                  <button className="btn primary" onClick={() => void addFolder()}>
                    <FolderPlus size={16} /> {tr('lib.addFolder')}
                  </button>
                )}
                <button className="btn" onClick={(e) => openChooser(e)}>
                  <FolderOpen size={16} /> {tr('home.openFiles')}
                </button>
              </div>
            </>
          )}
        </div>
      </motion.section>

      {show('recentPlayed') && <Shelf title={tr('lib.recentPlayed')} tracks={recentlyPlayed.slice(0, RECENT_PLAYED)} tabLabel={tr('lib.recentPlayed')} hide="played" action={<ClearRecent />} />}
      {show('random') && <Shelf
        title={tr('home.random')}
        tracks={random}
        tabLabel={tr('home.random')}
        action={
          <button className="icon-btn shelf-refresh" aria-label={tr('home.randomRefresh')} title={tr('home.randomRefresh')} onClick={redraw}>
            <RefreshCw size={15} />
          </button>
        }
      />}
      {show('recentAdded') && <Shelf title={tr('lib.recentAdded')} tracks={recentlyAdded} tabLabel={tr('lib.recentAdded')} hide="added" />}

      {show('shortcuts') && <>
      <h2 className="section-title">{hasLibrary ? tr('home.shortcuts') : tr('home.start')}</h2>
      <motion.div className="cards" variants={{ show: { transition: { staggerChildren: 0.05 } } }} initial="hidden" animate="show">
        {cards.map((c) => (
          <motion.button key={c.title} variants={item} className="card panel" onClick={c.run} disabled={!c.run && !c.info} tabIndex={c.run ? 0 : -1}>
            <span className="card-icon">
              <c.icon size={18} strokeWidth={1.75} />
            </span>
            <h4>{c.title}</h4>
            <p>{c.text}</p>
          </motion.button>
        ))}
      </motion.div>
      </>}

      {show('keyboard') && <>
      <h2 className="section-title">{tr('home.keyboard')}</h2>
      <div className="panel" style={{ padding: '16px 20px', display: 'flex', gap: 28, flexWrap: 'wrap', color: 'var(--text-1)' }}>
        <span><kbd>{tr('key.space')}</kbd> {tr('home.kPlay')}</span>
        <span><kbd>Ctrl</kbd> + <kbd>O</kbd> {tr('home.kOpen')}</span>
        <span><kbd>←</kbd> <kbd>→</kbd> ±5 s</span>
        <span><kbd>↑</kbd> <kbd>↓</kbd> {tr('home.kVolume')}</span>
        <span><kbd>Ctrl</kbd> + <kbd>Tab</kbd> {tr('home.kNextTab')}</span>
        <span><kbd>Ctrl</kbd> + <kbd>W</kbd> {tr('home.kCloseTab')}</span>
        <span><kbd>{tr('key.del')}</kbd> {tr('home.kRemove')}</span>
      </div>
      </>}
    </PageScroll>
  );
}
