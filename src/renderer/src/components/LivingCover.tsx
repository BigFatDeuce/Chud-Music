import { useCallback, useEffect } from 'react';
import { ytQualityCap } from '@shared/yt-place';
import { AnimatePresence, motion } from 'motion/react';
import { isYtLive, usePlayer } from '@/store/player';
import { engine } from '@/audio/engine';
import { useYtHost } from '@/audio/youtube';
import { CoverArt } from './CoverArt';
import { GlitchOnChange, useCanvasFx } from './Fx';
import { VHS } from './canvasui/VHS';
import { SignalIdle, useSignalFx } from './SignalFx';
import { useBesideDrawerBox, useYtDock, useYtPlace } from '@/store/ytdock';
import { useSettings } from '@/store/settings';
import { showMenu } from './ContextMenu';
import { nowPlayingMenu } from '@/lib/track-actions';
import { tr } from '@shared/i18n';

// The persistent "now playing" window in the sidebar. It stays ≥ 200×200 px on purpose: it
// hosts the official YouTube player, which YouTube requires to be visible and unobscured.
// While a YouTube track plays, nothing (badge, effect) is drawn over the player.

const ease = [0.22, 1, 0.36, 1] as const;

function YouTubePlayer({ visible }: { visible: boolean }) {
  const ref = useCallback((el: HTMLElement | null) => engine.youtube.attach(el as Parameters<typeof engine.youtube.attach>[0]), []);
  const locked = useSettings((s) => s.ytClickLock);
  return <webview ref={ref} src="chud-yt://player/" partition="persist:youtube" className={`yt-player${visible ? ' visible' : ''}${locked ? ' locked' : ''}`} aria-hidden={!visible} title={tr('cover.ytPlayer')} />;
}

export function LivingCover() {
  const current = usePlayer((s) => s.current);
  const status = usePlayer((s) => s.status);
  const ytMounted = useYtHost((s) => s.mounted);
  const fx = useCanvasFx();
  const signal = useSignalFx();
  const slot = useYtDock((s) => s.slot);
  const clip = useYtDock((s) => s.clip);
  const ytLive = usePlayer(isYtLive);
  // where the player shows (shared/yt-place.ts), and the box it is laid over when not at home
  const place = useYtPlace();
  const beside = useBesideDrawerBox();
  const box =
    place === 'beside' && beside ? { left: beside.left, top: beside.top, width: beside.size, height: beside.size }
    : place === 'clip' && clip ? { left: clip.left, top: clip.top, width: clip.width, height: clip.height }
    : place === 'bar' && slot ? { left: slot.left, top: slot.top, width: slot.size, height: slot.size }
    : undefined;
  const playingCover = current && !ytLive;
  // small everywhere but on the stage of the clip tab: 480p is asked for there at most
  useEffect(() => engine.youtube.setQualityCap(ytQualityCap(place)), [place]);

  const idle = (
    <div className="living-cover-idle">
      <span className="lcd">— PRÊT —</span>
      <span className="lcd" style={{ fontSize: 15, opacity: 0.6 }}>{tr('cover.insertTape')}</span>
    </div>
  );

  const cover = (
    <AnimatePresence initial={false}>
      {current && (
        <motion.div
          key={current.id}
          className="living-cover-art"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease }}
        >
          <CoverArt url={current.coverUrl} size={56} cors={current.source === 'local'} />
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div
      className={`living-cover panel${ytLive ? ' yt-live' : ''}${box ? ' docked' : ''}${box && place === 'clip' ? ' in-clip' : ''}${box && place === 'beside' ? ' beside-drawer' : ''}`}
      // docked: the same element (the YouTube player must not be recreated) laid over the player-bar
      // slot, over the stage of the video clip tab, or beside the open drawer
      style={box}
      data-playing={playingCover && status === 'playing' ? '' : undefined}
      onContextMenu={(e) => playingCover && showMenu(e, nowPlayingMenu(current))}
    >
      <div className="living-cover-frame">
        {current ? (
          fx && current.source === 'local' ? <GlitchOnChange trigger={current.id}>{cover}</GlitchOnChange> : cover
        ) : signal ? (
          // skin Signal: the logo turning slowly as ASCII
          <SignalIdle fallback={idle} />
        ) : fx ? (
          // "no signal" tape screen while nothing is loaded
          <VHS style={{ position: 'absolute', inset: 0 }} speed={0.6} wave={1.2} jitter={0.35} crease={0.4} switching={0.6} switchingHeight={0.05} grain={0.12} scanlines={0.35} vignette={0.35}>
            {idle}
          </VHS>
        ) : (
          idle
        )}
        {ytMounted && <YouTubePlayer visible={ytLive} />}
        {current && !ytLive && (
          <div className="living-cover-label">
            <span className={`badge ${status === 'playing' ? 'accent' : ''}`}>
              {status === 'loading' ? tr('cover.loading') : status === 'playing' ? tr('cover.playing') : tr('cover.paused')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
