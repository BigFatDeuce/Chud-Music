import { useEffect, useRef, useState } from 'react';
import { useYtDock, useYtPlace } from '@/store/ytdock';
import { motion } from 'motion/react';
import { AudioWaveform, ChartColumn, CirclePlay, Disc3, House, Library, ListMusic, MicVocal, Plus, RadioTower, Settings2, Sparkles } from 'lucide-react';
import type { SectionId } from '@shared/types';
import { SECTION_LABEL, useTabs } from '@/store/tabs';
import { usePlaylists } from '@/store/playlists';
import { useFileDrop } from './Overlays';
import { isYtLive, usePlayer } from '@/store/player';
import { useLibrary } from '@/store/library';
import { dragPayload, endDrag, isTrackDrag } from '@/lib/drag';
import { createPlaylistWith } from '@/lib/track-actions';
import { playlistMenu, smartMenu } from '@/pages/PlaylistPage';
import { showMenu } from './ContextMenu';
import { LivingCover } from './LivingCover';
import { useLayout } from '@/store/layout';
import { useSettings } from '@/store/settings';
import { tr } from '@shared/i18n';

const NAV: { id: SectionId; icon: typeof House }[] = [
  { id: 'home', icon: House },
  { id: 'library', icon: Library },
  { id: 'playlists', icon: ListMusic },
  { id: 'youtube', icon: CirclePlay },
  { id: 'lyrics', icon: MicVocal },
  { id: 'radio', icon: RadioTower },
  { id: 'visualizer', icon: AudioWaveform },
  { id: 'stats', icon: ChartColumn },
  { id: 'settings', icon: Settings2 },
];

export function Sidebar() {
  const activeId = useTabs((s) => s.activeId);
  const openSection = useTabs((s) => s.openSection);
  const openPlaylist = useTabs((s) => s.openPlaylist);
  const { compact, drawer, setDrawer } = useLayout();
  const list = usePlaylists((s) => s.list);
  const playingTab = usePlayer((s) => s.ctx?.tabId);
  const scanning = useLibrary((s) => s.status.running);
  const [dropOn, setDropOn] = useState<number | 'new' | null>(null);
  const fileDropOn = useFileDrop((s) => s.playlistId);
  const panel = useSettings((s) => s.sidePanel);
  const setSettings = useSettings((s) => s.set);
  const ytLive = usePlayer(isYtLive);
  const ytBeside = useYtPlace() === 'beside';
  const asideRef = useRef<HTMLElement>(null);
  // room for the living cover under the menu (≥ 200 px player + its margins)? otherwise the
  // YouTube player docks into the player bar
  useEffect(() => {
    const el = asideRef.current!;
    const measure = () => {
      const nav = el.querySelector<HTMLElement>('.nav');
      const head = el.querySelector<HTMLElement>('.deck-head');
      // measured as if the bar had its normal height: a docked player makes the bar taller, which
      // must not keep it docked once there is room again
      const docked = document.querySelector<HTMLElement>('.playerbar.yt-docked');
      const extra = docked ? Math.max(0, docked.offsetHeight - 92) : 0;
      const free = el.clientHeight + extra - (nav?.scrollHeight ?? 0) - (head?.offsetHeight ?? 0) - 30;
      // the cover shrinks to the room left under the menu (the menu itself never has to scroll)
      el.style.setProperty('--cover-room', `${Math.max(120, Math.floor(free))}px`);
      // the cover box is square (min of the deck's inner width and the free height); the player
      // inside loses its 10 px side margins (20 px wide, 10 px tall) and must stay ≥ 200 × 200
      const deck = el.querySelector<HTMLElement>('.deck');
      const cs = deck ? getComputedStyle(deck) : null;
      const inner = deck && cs ? deck.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : el.clientWidth;
      const room = Math.min(inner, free) - 20 >= 200;
      if (room !== useYtDock.getState().roomInSidebar) useYtDock.setState({ roomInSidebar: room });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const bar = document.querySelector('.playerbar');
    if (bar) ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  const dropProps = (target: number | 'new') => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isTrackDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropOn(target);
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: React.DragEvent) => {
      if (!isTrackDrag(e)) return;
      e.preventDefault();
      setDropOn(null);
      const p = dragPayload();
      endDrag();
      if (!p) return;
      if (target === 'new') void createPlaylistWith(p.tracks).then((id) => id && openPlaylist(id));
      else void usePlaylists.getState().addTracks(target, p.tracks);
    },
  });

  return (
    <aside ref={asideRef} className={`sidebar${compact ? ' drawer' : ''}${drawer ? ' open' : ''}${ytBeside ? ' yt-beside' : ''}`} aria-hidden={compact && !drawer ? true : undefined}>
      <nav className="nav panel" aria-label={tr('side.nav')}>
        {NAV.map(({ id, icon: Icon }) => {
          const active = activeId === `section:${id}`;
          return (
            <button key={id} className={`nav-item${active ? ' active' : ''}`} onClick={() => {
                openSection(id);
                setDrawer(false);
              }} aria-current={active ? 'page' : undefined}>
              {active && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} />}
              <Icon size={18} />
              {SECTION_LABEL[id]}
              {id === 'library' && scanning && <span className="badge accent">{tr('side.scanning')}</span>}
            </button>
          );
        })}
      </nav>

      {/* One box under the menu: the living cover or the playlists, with a switch. While a
          YouTube track plays its player stays visible below the list (YouTube requires it). */}
      <section className={`deck panel ${panel}${ytLive ? ' yt-live' : ''}`}>
        <div className="deck-head">
          <div className="segmented deck-switch" role="tablist" aria-label={tr('side.panel')}>
            <button role="tab" aria-selected={panel === 'cover'} className={panel === 'cover' ? 'on' : ''} onClick={() => setSettings({ sidePanel: 'cover' })} title={tr('side.coverHint')}>
              <Disc3 size={14} /> {tr('side.cover')}
            </button>
            <button
              role="tab"
              aria-selected={panel === 'playlists'}
              className={panel === 'playlists' ? 'on' : ''}
              onClick={() => setSettings({ sidePanel: 'playlists' })}
              // dragging tracks over it opens the playlists, to drop them on one
              onDragEnter={(e) => (isTrackDrag(e) || e.dataTransfer.types.includes('Files')) && setSettings({ sidePanel: 'playlists' })}
              title={tr('side.myPlaylists')}
            >
              <ListMusic size={14} /> {tr('section.playlists')} <span className="deck-count">{list.length}</span>
            </button>
          </div>
          <button
            className={`icon-btn${dropOn === 'new' ? ' drop-target' : ''}`}
            style={{ width: 26, height: 26 }}
            aria-label={tr('pl.new')}
            title={tr('side.newHint')}
            onClick={() => void createPlaylistWith().then((id) => id && openPlaylist(id))}
            onContextMenu={(e) => showMenu(e, smartMenu())}
            {...dropProps('new')}
          >
            <Plus size={15} />
          </button>
        </div>
        {panel === 'playlists' && (
        <div className="side-list">
          {list.length === 0 && <div className="side-empty">{tr('side.noPlaylists')}</div>}
          {list.map((p) => {
            const tabId = `playlist:${p.id}`;
            return (
              <button
                key={p.id}
                className={`side-item${activeId === tabId ? ' active' : ''}${dropOn === p.id || fileDropOn === p.id ? ' drop-target' : ''}`}
                data-drop-playlist={p.id}
                onClick={() => {
                  openPlaylist(p.id);
                  setDrawer(false);
                }}
                onContextMenu={(e) => showMenu(e, playlistMenu(p))}
                title={`${p.name} — ${tr('n.tracks', { n: p.count })}`}
                {...dropProps(p.id)}
              >
                {p.smart ? <Sparkles size={15} /> : <ListMusic size={15} />}
                <span className="side-item-label">{p.name}</span>
                {playingTab === tabId ? <span className="eq-bars"><i /><i /><i /></span> : <span className="side-item-count">{p.count}</span>}
              </button>
            );
          })}
        </div>
        )}
        <LivingCover />
      </section>
    </aside>
  );
}
