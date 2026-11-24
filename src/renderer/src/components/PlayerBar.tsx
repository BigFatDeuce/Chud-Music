import { useEffect, useState, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AudioWaveform, Check, Circle, Clapperboard, Gauge, Radio as RadioLive, ListOrdered, MicVocal, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX, SlidersVertical } from 'lucide-react';
import { engine } from '@/audio/engine';
import { presetLabel } from '@/audio/eq';
import { fmtTime } from '@/lib/format';
import { usePlayer } from '@/store/player';
import { LIVE_SLACK, playRadioFrom, radioPos, toggleRecording, useRadioShift } from '@/store/radio';
import { useSettings } from '@/store/settings';
import { CLIP_TAB, sectionId, useTabs } from '@/store/tabs';
import { CoverArt } from './CoverArt';
import { Slider } from './Slider';
import { Spectrum } from './Spectrum';
import { useQueuePanel } from './QueuePanel';
import { useEqPanel } from './EqPanel';
import { NowPlayingSweep, useSignalFx } from './SignalFx';
import { outputMenu } from '@/lib/audio-output';
import { useYtDock, useYtDocked } from '@/store/ytdock';
import { DockStage } from './DockStage';
import { showMenu } from './ContextMenu';
import { nowPlayingMenu } from '@/lib/track-actions';
import { SleepButton } from './SleepButton';
import { useLyricsKind } from '@/store/nowLyrics';
import { SPEEDS, fmtRate, useRate } from '@/store/rate';

/** Where the YouTube player sits when docked: its box is reported, the player is laid over it. */
function YtSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const report = () => {
      const r = el.getBoundingClientRect();
      const prev = useYtDock.getState().slot;
      if (!prev || prev.left !== r.left || prev.top !== r.top || prev.size !== r.width) useYtDock.setState({ slot: { left: r.left, top: r.top, size: r.width } });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    ro.observe(document.documentElement);
    window.addEventListener('resize', report);
    // the bar can move without resizing (layout switch, zoom): check its place a few times a second
    const id = setInterval(report, 400);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      clearInterval(id);
      useYtDock.setState({ slot: null });
    };
  }, []);
  return <div ref={ref} className="np-yt-slot" aria-hidden />;
}
import { codecLabel } from './TrackList';
import { ArtistAlbum } from './YtMeta';
import { tr } from '@shared/i18n';

/**
 * Polls the audio clock 4×/s while playing. Re-rendering every frame would cost CPU and
 * memory for nothing: at 4 Hz the seek bar still moves smoothly (sub-pixel steps).
 */
/**
 * The seek bar of a station: the last 30 minutes kept in memory, from the oldest moment to live.
 * Left: how far behind live; right: back to live.
 */
function RadioSeek({ pos }: { pos: number }) {
  const current = usePlayer((s) => s.current)!;
  const { base, win, shifted } = useRadioShift();
  const [preview, setPreview] = useState<number | null>(null);
  const span = win && win.url === current.streamUrl ? Math.max(0, win.end - win.start) : 0;
  const at = base + pos;
  const value = span ? Math.min(1, Math.max(0, (at - win!.start) / span)) : 1;
  const shown = preview ?? value;
  const behind = span ? Math.max(0, (1 - shown) * span) : 0;
  // while dragging: what the drop would give; otherwise how the reading was started (steady)
  const live = preview !== null ? behind < LIVE_SLACK : !shifted;
  return (
    <>
      <span className={`time lcd${live ? ' live' : ''}`} title={tr('radio.behindHint')}>{live ? tr('player.live') : `-${fmtTime(behind)}`}</span>
      <Slider
        label={tr('radio.timeShift')}
        value={shown}
        buffered={span ? 1 : 0}
        onChange={setPreview}
        onCommit={(v) => {
          setPreview(null);
          if (!win) return;
          const to = win.start + v * span;
          void playRadioFrom(current, win.end - to < LIVE_SLACK ? null : to).catch(() => {});
        }}
        step={span ? 5 / span : 0.05}
        disabled={span < LIVE_SLACK}
        valueText={live ? tr('player.live') : tr('radio.behind', { t: fmtTime(behind) })}
      />
      <button className={`time lcd right radio-live-btn${live ? ' on' : ''}`} disabled={live} onClick={() => void playRadioFrom(current, null).catch(() => {})} title={tr('radio.goLive')}>
        <RadioLive size={12} /> {tr('radio.liveShort')}
      </button>
    </>
  );
}

/** "Live", or "Delayed" while the station is heard behind live. */
function RadioBadge() {
  const current = usePlayer((s) => s.current);
  const delayed = useRadioShift((s) => s.shifted && !!s.win && s.win.url === current?.streamUrl);
  return (
    <span className={`badge ${delayed ? '' : 'accent '}live`} title={delayed ? tr('radio.behindHint') : tr('player.liveRadio')}>
      {delayed ? tr('radio.delayed') : tr('player.live')}
    </span>
  );
}

/** Records the station (to the right of the visualizer button, stations only). */
function RecordButton() {
  const current = usePlayer((s) => s.current);
  const rec = useRadioShift((s) => (s.win && s.win.url === current?.streamUrl ? s.win.recording : null));
  if (current?.source !== 'radio') return null;
  // the length heard so far (the file may already hold a little more, cut off when stopping)
  const heard = rec ? Math.max(0, rec.start !== undefined ? radioPos() - rec.start : rec.seconds) : 0;
  return (
    <button
      className={`icon-btn bar-tab-btn rec-btn${rec ? ' recording' : ''}`}
      aria-pressed={!!rec}
      aria-label={rec ? tr('radio.recStop', { t: fmtTime(heard) }) : tr('radio.record')}
      title={rec ? tr('radio.recStop', { t: fmtTime(heard) }) : tr('radio.record')}
      onClick={() => void toggleRecording(current)}
    >
      <Circle size={15} fill="currentColor" />
    </button>
  );
}

function usePlaybackClock(active: boolean) {
  const [t, setT] = useState({ pos: 0, buf: 0 });
  useEffect(() => {
    const tick = () => setT({ pos: engine.currentTime, buf: engine.bufferedEnd });
    tick();
    const id = active ? setInterval(tick, 250) : undefined;
    const off = engine.on((e) => e.type === 'clock' && tick());
    return () => {
      clearInterval(id);
      off();
    };
  }, [active]);
  return t;
}

/** Playback speed, above the timer: a click lists the speeds, a right-click goes back to 1×. */
function SpeedButton({ disabled }: { disabled: boolean }) {
  const rate = useRate((s) => s.rate);
  const set = useRate((s) => s.set);
  return (
    <button
      className={`speed-btn${rate !== 1 ? ' on' : ''}`}
      aria-label={tr('player.speed')}
      title={tr('player.speedHint')}
      disabled={disabled}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showMenu(
          { clientX: r.left, clientY: r.top, preventDefault() {} },
          SPEEDS.map((v) => ({ label: v === 1 ? `${fmtRate(v)} · ${tr('player.speedNormal')}` : fmtRate(v), icon: v === rate ? <Check size={15} /> : undefined, onSelect: () => set(v) })),
        );
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        set(1);
      }}
    >
      <Gauge size={12} />
      {fmtRate(rate)}
    </button>
  );
}

export function PlayerBar() {
  const { current, status, duration, ctx, transcoded, resumeAt, upNext, toggle, next, prev, seek, toggleShuffle, cycleRepeat } = usePlayer();
  const queue = useQueuePanel();
  const ytDocked = useYtDocked();
  // panels above the bar (queue, equaliser, toasts) follow its real height
  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = barRef.current!;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const signal = useSignalFx();
  const { open: eqOpen, toggle: toggleEq } = useEqPanel();
  const eqOn = useSettings((s) => s.eq.enabled);
  const eqPreset = useSettings((s) => s.eq.preset);
  const { volume, muted, shuffle, repeat, set } = useSettings();
  const activate = useTabs((s) => s.activate);
  const openSection = useTabs((s) => s.openSection);
  const openClip = useTabs((s) => s.openClip);
  const toggleTab = useTabs((s) => s.toggleTab);
  const activeId = useTabs((s) => s.activeId);
  const lyricsKind = useLyricsKind();
  const clock = usePlaybackClock(status === 'playing');
  const repeatLabel = repeat === 'one' ? tr('player.repeatOne') : repeat === 'all' ? tr('player.repeatAll') : tr('player.repeatOff');
  const [preview, setPreview] = useState<number | null>(null);
  const [showRemaining, setShowRemaining] = useState(true);

  const dur = duration || current?.durationSec || 0;
  const pos = preview !== null ? preview * dur : status === 'idle' && resumeAt ? resumeAt : clock.pos;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const hasCtx = !!ctx || !!current || upNext.length > 0;
  // while a track loads, the button gives it up (as the taskbar's button shows)
  const stops = status === 'playing' || status === 'loading';

  return (
    <footer ref={barRef} className={`playerbar panel${ytDocked ? ' yt-docked' : ''}`}>
      <div className="np">
        {ytDocked && <YtSlot />}
        <button
          className="np-cover"
          hidden={ytDocked}
          data-playing={(status === 'playing' && current?.source !== 'youtube') || undefined}
          onClick={() => ctx && activate(ctx.tabId)}
          onContextMenu={(e) => {
            if (!current || current.source === 'radio') return;
            showMenu(e, nowPlayingMenu(current));
          }} title={ctx ? tr('player.showList', { name: ctx.label }) : undefined} disabled={!ctx}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={current?.id ?? 'none'}
              style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <CoverArt url={current?.coverUrl} size={22} thumb={128} />
            </motion.div>
          </AnimatePresence>
        </button>
        <div className="np-text">
          {current ? (
            <>
              {signal ? (
                <NowPlayingSweep trackKey={current.id}>
                  <div className="np-title" title={current.title}>{current.title}</div>
                  <div className="np-artist" title={[current.artist, current.album].filter(Boolean).join(' — ') || undefined}><ArtistAlbum track={current} /></div>
                </NowPlayingSweep>
              ) : (
                <>
                  <div className="np-title" title={current.title}>{current.title}</div>
                  <div className="np-artist" title={[current.artist, current.album].filter(Boolean).join(' — ') || undefined}><ArtistAlbum track={current} /></div>
                </>
              )}
              <div className="np-badges">
                {current.source === 'youtube' ? (
                  <span className="badge" title={tr('player.ytBadge')}>YouTube</span>
                ) : current.source === 'radio' ? (
                  <RadioBadge />
                ) : (
                  <span className="badge">{tr('player.local')}</span>
                )}
                {current.source === 'local' && current.codec && <span className="badge">{codecLabel(current)}</span>}
                {transcoded && <span className="badge accent" title={tr('player.ffmpeg')}>FFmpeg</span>}
                {current.source === 'local' && lyricsKind && (
                  <button key={`${current.id}-${lyricsKind}`} className={`np-lyrics-btn ${lyricsKind}`} onClick={() => toggleTab(sectionId('lyrics'), () => openSection('lyrics'))} title={tr('player.openLyrics')}>
                    <MicVocal size={11} />
                    {lyricsKind === 'synced' ? tr('player.lyricsSynced') : tr('player.lyricsPlain')}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="np-title" style={{ color: 'var(--text-2)' }}>{tr('common.nothingPlaying')}</div>
              <div className="np-artist">{tr('player.empty')}</div>
            </>
          )}
        </div>
      </div>

      {ytDocked && <DockStage />}

      <div className="transport">
        <div className="transport-buttons">
          <button className={`icon-btn bar-tab-btn${activeId === CLIP_TAB ? ' on' : ''}`} aria-pressed={activeId === CLIP_TAB} aria-label={tr('menu.openClip')} title={tr('menu.openClip')} disabled={!current || current.source === 'radio'} onClick={() => toggleTab(CLIP_TAB, openClip)}>
            <Clapperboard size={17} />
          </button>
          <button className={`icon-btn${shuffle ? ' on' : ''}`} aria-label={tr('player.shuffle')} aria-pressed={shuffle} title={tr('player.shuffle')} onClick={toggleShuffle}>
            <Shuffle size={17} />
          </button>
          <button className="icon-btn" aria-label={tr('player.prev')} onClick={prev} disabled={!hasCtx}>
            <SkipBack size={19} fill="currentColor" />
          </button>
          <button className="play-btn" data-playing={status === 'playing' || undefined} aria-label={status === 'playing' ? tr('player.pause') : status === 'loading' ? tr('player.cancelLoading') : tr('player.play')} onClick={toggle} disabled={!hasCtx}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={stops ? 'pause' : 'play'}
                style={{ display: 'grid' }}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                transition={{ duration: 0.14 }}
              >
                {stops ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: 2 }} />}
              </motion.span>
            </AnimatePresence>
          </button>
          <button className="icon-btn" aria-label={tr('player.next')} onClick={next} disabled={!hasCtx}>
            <SkipForward size={19} fill="currentColor" />
          </button>
          <button
            className={`icon-btn${repeat !== 'off' ? ' on' : ''}`}
            aria-label={repeatLabel}
            title={repeatLabel}
            onClick={cycleRepeat}
          >
            {repeat === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}
          </button>
          <button className={`icon-btn bar-tab-btn${activeId === sectionId('visualizer') ? ' on' : ''}`} aria-pressed={activeId === sectionId('visualizer')} aria-label={tr('section.visualizer')} title={tr('section.visualizer')} onClick={() => toggleTab(sectionId('visualizer'), () => openSection('visualizer'))}>
            <AudioWaveform size={17} />
          </button>
          <RecordButton />
        </div>
        <div className="seek-row" data-playing={status === 'playing' || undefined}>
          <SpeedButton disabled={!current || current.source === 'radio'} />
          {current?.source === 'radio' && status !== 'idle' ? <RadioSeek pos={clock.pos} /> : (<>
          <span className="time lcd">{fmtTime(current ? pos : null)}</span>
          <Slider
            label={tr('player.position')}
            value={dur ? Math.min(1, pos / dur) : 0}
            buffered={dur ? Math.min(1, clock.buf / dur) : 0}
            onChange={setPreview}
            onCommit={(v) => {
              seek(v * dur);
              setPreview(null);
            }}
            step={dur ? 5 / dur : 0.05}
            disabled={!current || !dur}
            valueText={tr('player.posOf', { pos: fmtTime(pos), dur: fmtTime(dur) })}
          />
          <span className="time lcd right" title={tr('player.toggleRemaining')} onClick={() => setShowRemaining(!showRemaining)}>
            {current ? (showRemaining ? `-${fmtTime(Math.max(0, dur - pos))}` : fmtTime(dur)) : '–:––'}
          </span>
          </>)}
        </div>
      </div>

      <div className="player-right">
        <Spectrum />
        <SleepButton />
        <button className={`icon-btn${eqOpen || eqOn ? ' on' : ''}`} aria-label={tr('eq.title')} aria-pressed={eqOpen} title={eqOn ? tr('player.eqOn', { name: presetLabel(eqPreset) }) : tr('player.eqOff')} onClick={toggleEq}>
          <SlidersVertical size={18} />
        </button>
        <button className={`icon-btn${queue.open ? ' on' : ''}`} aria-label={tr('queue.title')} aria-pressed={queue.open} title={tr('queue.title')} onClick={queue.toggle}>
          <ListOrdered size={18} />
          {upNext.length > 0 && <span className="count-dot">{upNext.length}</span>}
        </button>
        <div className="volume">
          <button className="icon-btn" aria-label={muted ? tr('player.unmute') : tr('player.mute')} title={tr('player.muteHint')} onClick={() => set({ muted: !muted })} onContextMenu={(e) => void outputMenu(e)}>
            <VolIcon size={18} />
          </button>
          <Slider label={tr('player.volume')} value={muted ? 0 : volume} onChange={(v) => set({ volume: v, muted: false })} onCommit={(v) => set({ volume: v, muted: false })} valueText={`${Math.round(volume * 100)} %`} />
        </div>
      </div>
    </footer>
  );
}
