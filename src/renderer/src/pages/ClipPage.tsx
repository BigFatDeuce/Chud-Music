import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, Maximize, MicVocal, Rows2, Sparkles, Tv, Zap, Contrast, CassetteTape } from 'lucide-react';
import type { Track } from '@shared/types';
import { engine } from '@/audio/engine';
import { isYtLive, usePlayer } from '@/store/player';
import { useYtDock } from '@/store/ytdock';
import { useNowLyrics } from '@/store/nowLyrics';
import { useTabs } from '@/store/tabs';
import { lineAt, parseLrc } from '@/lib/lyrics';
import { mainArtist } from '@/lib/artist';
import { ArtistAlbum } from '@/components/YtMeta';
import { thumbUrl } from '@/components/CoverArt';
import placeholderVideo from '@/assets/clip-placeholder.mp4';
import { tr } from '@shared/i18n';
import { clipFull } from '@shared/yt-place';

// The video clip tab: what is playing, big, with its lyrics beside it (or under it, "Large").
//  • YouTube: the official player itself is laid over the stage (the same element as in the
//    living cover: never recreated), and a YouTube Music song is swapped for its official music
//    video when one is found; the next tracks get the same while the tab is shown;
//  • a local file: its cover, else the artist's picture from YouTube Music, else a looping tape
//    (VHS) placeholder video, cropped of its black bars, playing while the music plays.
// Fullscreen: the stage fills the screen, whatever plays (the YouTube player follows it); Esc
// leaves it, a double click on a local stage toggles it.

const WIDE_KEY = 'chud.clip.wide';
const readWide = () => {
  try {
    return localStorage.getItem(WIDE_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Picture effects, one at a time, remembered. Drawn over the local stage only (cover,
 * artist picture, tape): the YouTube player is never covered nor altered (YouTube's terms), so
 * the buttons are shown but disabled while a YouTube video plays.
 */
const FX = [
  { id: 'vhs', icon: CassetteTape, label: () => tr('clip.fxVhs') },
  { id: 'glitch', icon: Zap, label: () => tr('clip.fxGlitch') },
  { id: 'crt', icon: Tv, label: () => tr('clip.fxCrt') },
  { id: 'mono', icon: Contrast, label: () => tr('clip.fxMono') },
  { id: 'neon', icon: Sparkles, label: () => tr('clip.fxNeon') },
] as const;
type FxId = (typeof FX)[number]['id'];
const FX_KEY = 'chud.clip.fx';
const readFx = (): FxId[] => {
  try {
    const v = JSON.parse(localStorage.getItem(FX_KEY) ?? '[]');
    // one effect at a time
    return Array.isArray(v) ? v.filter((x): x is FxId => FX.some((f) => f.id === x)).slice(0, 1) : [];
  } catch {
    return [];
  }
};

function FxBar({ on, toggle, disabled }: { on: FxId[]; toggle: (id: FxId) => void; disabled: boolean }) {
  return (
    <div className="clip-fx" role="group" aria-label={tr('clip.fx')} title={disabled ? tr('clip.fxYt') : undefined}>
      {FX.map(({ id, icon: Icon, label }) => (
        <button key={id} className={`clip-fx-btn${on.includes(id) ? ' on' : ''}`} aria-pressed={on.includes(id)} disabled={disabled} onClick={() => toggle(id)} data-fx={id}>
          <Icon size={15} /> {label()}
        </button>
      ))}
      {disabled && <span className="clip-fx-note">{tr('clip.fxYt')}</span>}
    </div>
  );
}

/** Tracks already looked up for a music video: original id → the video version (or null). */
const videoOf = new Map<string, Track | null>();

/** While the tab is shown, a YouTube Music song plays as its official music video. */
function useMusicVideo(current: Track | null) {
  useEffect(() => {
    if (!current || current.source !== 'youtube' || videoOf.has(current.id)) return;
    const seed = current;
    videoOf.set(seed.id, null);
    void window.chud.youtube
      .musicVideo({ title: seed.title, artists: (seed.artist ?? '').split(/\s*,\s*/).filter(Boolean), durationSec: seed.durationSec ?? null })
      .then((found) => {
        if (!found || found.videoId === seed.videoId) return;
        // the same song (title, artist, album, cover), played from its video
        const swapped: Track = { ...seed, id: found.id, videoId: found.videoId, durationSec: found.durationSec ?? seed.durationSec };
        videoOf.set(seed.id, swapped);
        videoOf.set(swapped.id, null);
        const p = usePlayer.getState();
        if (p.current?.id === seed.id) p.swapCurrent(swapped);
      })
      .catch(() => {});
  }, [current]);
}

/** The stage's box, given to the YouTube player (laid over it), kept up to date while it moves. */
function YtStage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const report = () => {
      const r = el.getBoundingClientRect();
      const prev = useYtDock.getState().clip;
      // stage not on screen (mini player, page hidden): the player goes back to the living cover
      if (r.width < 1 || r.height < 1) {
        if (prev) useYtDock.setState({ clip: null });
        return;
      }
      if (!prev || prev.left !== r.left || prev.top !== r.top || prev.width !== r.width || prev.height !== r.height)
        useYtDock.setState({ clip: { left: r.left, top: r.top, width: r.width, height: r.height } });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    const id = setInterval(report, 250);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      clearInterval(id);
      useYtDock.setState({ clip: null });
    };
  }, []);
  return <div ref={ref} className="clip-yt-slot" aria-hidden />;
}

const artistPictures = new Map<string, Promise<string | null>>();
/** The artist's picture on YouTube Music (cached), for a file without cover. */
function artistPicture(name: string): Promise<string | null> {
  let p = artistPictures.get(name);
  if (!p) {
    p = window.chud.youtube
      .findArtist(name)
      .then((id) => (id ? window.chud.youtube.artist(id).then((a) => a.coverUrl) : null))
      .catch(() => null);
    artistPictures.set(name, p);
  }
  return p;
}

/** The tape placeholder: a looping video, black bars cropped, with a VHS look; plays with the music. */
function TapeVideo({ playing }: { playing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) void v.play().catch(() => {});
    else v.pause();
  }, [playing]);
  return (
    <div className="clip-vhs">
      <video ref={ref} src={placeholderVideo} muted loop playsInline preload="auto" />
      <span className="vhs-lines" />
      <span className="vhs-band" />
      <span className="vhs-osd">{playing ? 'PLAY ▶' : 'PAUSE ❚❚'}</span>
    </div>
  );
}

function LocalStage({ track, playing }: { track: Track; playing: boolean }) {
  const artist = mainArtist(track);
  const [picture, setPicture] = useState<{ for: string; url: string | null } | null>(null);
  useEffect(() => {
    if (track.coverUrl || !artist) return;
    let live = true;
    void artistPicture(artist).then((url) => live && setPicture({ for: artist, url }));
    return () => {
      live = false;
    };
  }, [track.coverUrl, artist]);
  const url = track.coverUrl ?? (picture && picture.for === artist ? picture.url : null);
  const looking = !track.coverUrl && !!artist && (!picture || picture.for !== artist);
  if (url)
    return (
      <div className={`clip-art${track.coverUrl ? '' : ' artist'}`} data-playing={playing || undefined}>
        {/* blurred: a small copy is enough */}
        <img className="clip-art-bg" src={thumbUrl(url, 256)} alt="" aria-hidden />
        <img className="clip-art-img" src={url} alt={track.coverUrl ? (track.album ?? track.title) : (artist ?? '')} />
      </div>
    );
  return looking ? <div className="clip-art" /> : <TapeVideo playing={playing} />;
}

function Lyrics({ wide }: { wide: boolean }) {
  const result = useNowLyrics((s) => s.result);
  const key = useNowLyrics((s) => s.key);
  const lines = useMemo(() => (result?.synced ? parseLrc(result.synced) : []), [result]);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!lines.length) return;
    let last = -2;
    const id = setInterval(() => {
      const i = lineAt(lines, engine.currentTime + 0.15);
      if (i === last) return;
      last = i;
      setActive(i);
      // beside the video, the lyrics follow by themselves; under it ("Large") the page is
      // scrolled by hand, so it is never moved under the reader's eyes
      if (!wide) {
        const b = box.current;
        const el = b?.querySelector<HTMLElement>(`[data-line="${i}"]`);
        if (b && el) b.scrollTo({ top: el.offsetTop - b.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
      }
    }, 200);
    return () => clearInterval(id);
  }, [lines, wide]);

  let body;
  if (!key) body = <p className="clip-lyrics-none">{tr('common.nothingPlaying')}</p>;
  else if (!result) body = <p className="clip-lyrics-none">{tr('clip.lyricsSearching')}</p>;
  else if (lines.length)
    body = lines.map((l, i) => (
      <button key={i} data-line={i} className={`clip-line${i === active ? ' on' : i < active ? ' past' : ''}`} onClick={() => usePlayer.getState().seek(l.t)} title={tr('lyrics.seekHere')}>
        {l.text || '♪'}
      </button>
    ));
  else if (result.plain) body = <div className="clip-plain">{result.plain}</div>;
  else
    body = (
      <div className="clip-lyrics-none">
        <p>{result.status === 'instrumental' ? tr('clip.instrumental') : tr('clip.noLyrics')}</p>
        <button className="btn ghost" onClick={() => useTabs.getState().openSection('lyrics')}>
          <MicVocal size={15} /> {tr('section.lyrics')}
        </button>
      </div>
    );
  return (
    <aside className="clip-lyrics" ref={box} aria-label={tr('section.lyrics')}>
      {body}
    </aside>
  );
}

export function ClipPage() {
  const current = usePlayer((s) => s.current);
  const status = usePlayer((s) => s.status);
  const [wide, setWide] = useState(readWide);
  const [fx, setFx] = useState<FxId[]>(readFx);
  const toggleFx = (id: FxId) => {
    // one effect at a time: choosing another replaces it, clicking the one on turns it off
    const next = fx.includes(id) ? [] : [id];
    setFx(next);
    try {
      localStorage.setItem(FX_KEY, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };
  const stage = useRef<HTMLDivElement>(null);
  useMusicVideo(current);
  const ytLive = usePlayer(isYtLive);

  const toggleWide = () => {
    setWide(!wide);
    try {
      localStorage.setItem(WIDE_KEY, wide ? '0' : '1');
    } catch {
      /* not remembered */
    }
  };
  // Full screen: the app's root goes full screen and the stage fills the window (clip.css,
  // [data-clip-full]); the YouTube player, laid over the stage, follows it. One thing is full
  // screen whatever plays, so going from a YouTube video to a file (or back) keeps the picture.
  const [fs, setFs] = useState({ fullscreen: !!document.fullscreenElement, byClip: false });
  const full = clipFull({ ...fs, clipShown: true });
  useEffect(() => {
    const on = () => setFs((s) => ({ fullscreen: !!document.fullscreenElement, byClip: s.byClip && !!document.fullscreenElement }));
    // Esc: the system leaves full screen by itself when the window has the keyboard; said here
    // too so it also works when the key comes to the page first
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.documentElement.hasAttribute('data-clip-full')) void document.exitFullscreen().catch(() => {});
    };
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      document.removeEventListener('keydown', key);
      // leaving the tab leaves full screen too
      if (document.documentElement.hasAttribute('data-clip-full') && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      document.documentElement.removeAttribute('data-clip-full');
    };
  }, []);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-clip-full', full);
  }, [full]);
  const fullscreen = () => {
    if (full) return void document.exitFullscreen().catch(() => {});
    setFs((s) => ({ ...s, byClip: true }));
    document.documentElement.requestFullscreen().catch(() => setFs((s) => ({ ...s, byClip: false })));
  };

  return (
    <div className={`page clip-page${wide ? ' wide' : ''}`}>
      <header className="clip-head">
        <div className="clip-head-text">
          <h1 className="clip-title" title={current?.title}>{current?.title ?? tr('common.nothingPlaying')}</h1>
          {current && (
            <div className="clip-artist">
              <ArtistAlbum track={current} />
            </div>
          )}
        </div>
        <div className="clip-actions">
          <button className={`btn ghost${wide ? ' on' : ''}`} aria-pressed={wide} onClick={toggleWide} title={wide ? tr('clip.besideHint') : tr('clip.wideHint')}>
            {wide ? <Columns2 size={16} /> : <Rows2 size={16} />} {wide ? tr('clip.beside') : tr('clip.wide')}
          </button>
          <button className="btn ghost" onClick={fullscreen} disabled={!current} title={tr('clip.fullscreenHint')}>
            <Maximize size={16} /> {tr('clip.fullscreen')}
          </button>
        </div>
      </header>
      <div className="clip-body">
        <div className="clip-main">
          <div
            className={`clip-stage${!ytLive ? fx.map((f) => ` fx-${f}`).join('') : ''}`}
            ref={stage}
            data-playing={status === 'playing' || undefined}
            // (a double click on the YouTube player belongs to YouTube: local stage only)
            onDoubleClick={() => current && !ytLive && fullscreen()}
          >
            {!current ? (
              <div className="clip-empty">{tr('clip.empty')}</div>
            ) : ytLive ? (
              <YtStage />
            ) : (
              <>
                <div className="clip-fx-layer">
                  <LocalStage track={current} playing={status === 'playing'} />
                </div>
                {fx.length > 0 && <span className="clip-fx-over" aria-hidden />}
              </>
            )}
          </div>
          <FxBar on={fx} toggle={toggleFx} disabled={ytLive || !current} />
        </div>
        <Lyrics wide={wide} />
      </div>
    </div>
  );
}
