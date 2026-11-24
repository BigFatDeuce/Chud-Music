import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, Reorder } from 'motion/react';
import { showMenu } from './ContextMenu';
import { Clapperboard, AudioWaveform, CirclePlay, FileAudio, House, Library, ListMusic, Plus, Radio, Settings2, X, Check, ChevronDown, ChartColumn, MicVocal, RadioTower } from 'lucide-react';
import type { SectionId } from '@shared/types';
import { isPinned, SECTION_LABEL, useTabs, type Tab } from '@/store/tabs';
import { usePlaylists } from '@/store/playlists';
import { usePlayer } from '@/store/player';
import { tabAddChooser } from '@/lib/add-menus';
import { useFileDrop } from './Overlays';
import { tr } from '@shared/i18n';

const ICON: Record<SectionId, typeof House> = {
  home: House,
  library: Library,
  playlists: ListMusic,
  youtube: CirclePlay,
  lyrics: MicVocal,
  radio: RadioTower,
  visualizer: AudioWaveform,
  stats: ChartColumn,
  settings: Settings2,
};

function useLabel() {
  const lists = usePlaylists((s) => s.list);
  return (t: Tab) =>
    t.kind === 'section' ? SECTION_LABEL[t.section] : t.kind === 'files' || t.kind === 'mix' ? t.title : t.kind === 'clip' ? tr('clip.title') : (lists.find((p) => p.id === t.playlistId)?.name ?? tr('common.playlist'));
}

export function TabStrip() {
  const { tabs, activeId, activate, close, reorder } = useTabs();
  const movableIds = tabs.filter((t) => !isPinned(t)).map((t) => t.id);
  const dragged = useRef(false);
  const playingTab = usePlayer((s) => s.ctx?.tabId);
  const status = usePlayer((s) => s.status);
  const label = useLabel();
  const fileDropOn = useFileDrop((s) => s.playlistId);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  // Too many tabs: the strip scrolls (wheel too), shows faded edges, and the active tab is
  // always brought into view. "Tous les onglets" lists every tab, wherever it is.
  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };
  /** Scrolls just enough for the active tab to be fully visible (beyond the faded edges). */
  const reveal = (smooth: boolean) => {
    const el = scroller.current;
    const tab = el?.querySelector<HTMLElement>('.tab.active');
    if (!el || !tab) return;
    const pad = 40;
    // position in the scrolled content, from on-screen boxes (independent of offsetParent)
    const left = tab.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    const target = left < el.scrollLeft + pad ? left - pad : left + tab.offsetWidth > el.scrollLeft + el.clientWidth - pad ? left + tab.offsetWidth - el.clientWidth + pad : null;
    if (target !== null) el.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
    measure();
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => revealRef.current(false));
    ro.observe(el);
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', wheel);
    };
  }, []);
  useEffect(() => {
    // after the tab's enter animation has given it its width
    const id = setTimeout(() => revealRef.current(true), 60);
    const id2 = setTimeout(measure, 450);
    return () => {
      clearTimeout(id);
      clearTimeout(id2);
    };
  }, [activeId, tabs.length]);

  const allTabs = (e: React.MouseEvent) =>
    showMenu(
      e,
      tabs.map((t) => ({
        label: label(t),
        icon: t.id === activeId ? <Check size={15} /> : undefined,
        onSelect: () => activate(t.id),
      })),
    );

  /** One tab. Home and Library stay in place; the others can be dragged left or right. */
  const renderTab = (t: Tab) => {
    const Icon = t.kind === 'section' ? ICON[t.section] : t.kind === 'playlist' ? ListMusic : t.kind === 'mix' ? Radio : t.kind === 'clip' ? Clapperboard : FileAudio;
    const pinned = isPinned(t);
    const isPlaying = playingTab === t.id && (status === 'playing' || status === 'paused' || status === 'loading');
    const props = {
      className: `tab${t.id === activeId ? ' active' : ''}${pinned ? ' pinned' : ''}${t.kind === 'playlist' && fileDropOn === t.playlistId ? ' drop-target' : ''}`,
      'data-tab-id': t.id,
      'data-drop-playlist': t.kind === 'playlist' ? t.playlistId : undefined,
      role: 'tab',
      'aria-selected': t.id === activeId,
      tabIndex: 0,
      title: t.kind === 'files' ? tr('tabs.filesHint', { n: t.paths.length }) : pinned ? undefined : tr('tabs.dragHint'),
      // a click that ends a drag does not also switch tabs
      onClick: () => !dragged.current && activate(t.id),
      onAuxClick: (e: React.MouseEvent) => e.button === 1 && !pinned && close(t.id),
      onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && activate(t.id),
    };
    const body = (
      <>
        {isPlaying ? (
          <span className={`eq-bars${status !== 'playing' ? ' paused' : ''}`} aria-label={tr('common.nowPlaying')}>
            <i /><i /><i />
          </span>
        ) : (
          <Icon size={15} />
        )}
        <span className="tab-label">{label(t)}</span>
        {!pinned && (
          <button
            className="tab-close"
            aria-label={tr('common.closeNamed', { name: label(t) })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              close(t.id);
            }}
          >
            <X size={13} />
          </button>
        )}
      </>
    );
    if (pinned) return <div key={t.id} {...props}>{body}</div>;
    return (
      <Reorder.Item
        key={t.id}
        value={t.id}
        as="div"
        {...props}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        whileDrag={{ zIndex: 5, cursor: 'grabbing' }}
        dragElastic={0}
        dragMomentum={false}
        onDragStart={() => {
          dragged.current = true;
          activate(t.id);
        }}
        onDragEnd={() => setTimeout(() => (dragged.current = false), 0)}
      >
        {body}
      </Reorder.Item>
    );
  };

  return (
    <div className={`tabstrip${edges.left ? ' fade-left' : ''}${edges.right ? ' fade-right' : ''}`}>
      <div className="tabs-scroll" ref={scroller} role="tablist" onScroll={measure}>
      {tabs.filter(isPinned).map(renderTab)}
      <Reorder.Group as="div" axis="x" className="tabs-movable" values={movableIds} onReorder={reorder}>
        <AnimatePresence initial={false}>{tabs.filter((t) => !isPinned(t)).map(renderTab)}</AnimatePresence>
      </Reorder.Group>
      </div>
      {(edges.left || edges.right) && (
        <button className="icon-btn tab-all" aria-label={tr('tabs.all')} title={tr('tabs.allCount', { n: tabs.length })} onClick={allTabs}>
          <ChevronDown size={17} />
          <span className="tab-count">{tabs.length}</span>
        </button>
      )}
      <button className="icon-btn tab-add" aria-label={tr('tabs.addLabel')} title={tr('tabs.addHint')} onClick={(e) => tabAddChooser(e)}>
        <Plus size={17} />
      </button>
    </div>
  );
}
