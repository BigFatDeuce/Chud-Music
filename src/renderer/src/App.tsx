import { useEffect } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { engine } from '@/audio/engine';
import { coverPalette } from '@/lib/palette';
import { openPaths } from '@/lib/open-files';
import { openChooserFromKeyboard } from '@/lib/add-menus';
import { usePlayer } from '@/store/player';
import { useSettings } from '@/store/settings';
import { useTabs, type Tab } from '@/store/tabs';
import { Titlebar } from '@/components/Titlebar';
import { Sidebar } from '@/components/Sidebar';
import { TabStrip } from '@/components/TabStrip';
import { PlayerBar } from '@/components/PlayerBar';
import { DropZone, Toasts } from '@/components/Overlays';
import { HomePage } from '@/pages/HomePage';
import { FilesTabPage } from '@/pages/FilesTabPage';
import { VisualizerPage } from '@/pages/VisualizerPage';
import { YouTubePage } from '@/pages/YouTubePage';
import { LyricsPage } from '@/pages/LyricsPage';
import { RadioPage } from '@/pages/RadioPage';
import { StatsPage } from '@/pages/StatsPage';
import { MixTabPage } from '@/pages/MixTabPage';
import { LibraryPage } from '@/pages/LibraryPage';
import { PlaylistsPage } from '@/pages/PlaylistsPage';
import { PlaylistPage } from '@/pages/PlaylistPage';
import { ContextMenuHost } from '@/components/ContextMenu';
import { PageBoundary } from '@/components/ErrorBoundary';
import { DialogHost } from '@/components/Dialog';
import { SmartEditorHost } from '@/components/SmartEditor';
import { QueuePanel } from '@/components/QueuePanel';
import { EqPanel } from '@/components/EqPanel';
import { TaskTray } from '@/components/TaskTray';
import { useLibrary } from '@/store/library';
import { usePlaylists } from '@/store/playlists';
import { SettingsPage } from '@/pages/SettingsPage';
import { ClipPage } from '@/pages/ClipPage';
import '@/store/updates';
import { useLayout } from '@/store/layout';

function Page({ tab }: { tab: Tab }) {
  if (tab.kind === 'files') return <FilesTabPage tab={tab} />;
  if (tab.kind === 'playlist') return <PlaylistPage playlistId={tab.playlistId} tabId={tab.id} />;
  if (tab.kind === 'mix') return <MixTabPage tab={tab} />;
  if (tab.kind === 'clip') return <ClipPage />;
  switch (tab.section) {
    case 'home': return <HomePage />;
    case 'library': return <LibraryPage />;
    case 'playlists': return <PlaylistsPage />;
    case 'youtube': return <YouTubePage />;
    case 'lyrics': return <LyricsPage />;
    case 'radio': return <RadioPage />;
    case 'stats': return <StatsPage />;
    case 'visualizer': return <VisualizerPage />;
    case 'settings': return <SettingsPage />;
  }
}

/** Files from Explorer arrive one launch at a time; group bursts into a single tab. */
function useLaunchFiles() {
  const restored = useTabs((s) => s.restored);
  useEffect(() => {
    if (!restored) return;
    let batch: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.chud.files.onOpen((paths) => {
      batch.push(...paths);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const b = [...new Set(batch)];
        batch = [];
        void openPaths(b, 'launch');
      }, 250);
    });
    window.chud.files.ready();
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [restored]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      const p = usePlayer.getState();
      const s = useSettings.getState();
      const t = useTabs.getState();
      if (e.ctrlKey && e.key.toLowerCase() === 'o') openChooserFromKeyboard();
      else if (e.ctrlKey && e.key.toLowerCase() === 'w') t.close(t.activeId);
      else if (e.ctrlKey && e.key === 'Tab') t.cycle(e.shiftKey ? -1 : 1);
      else if (e.ctrlKey && e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) t.shift(t.activeId, e.key === 'PageUp' ? -1 : 1);
      else if (e.ctrlKey || e.altKey || e.metaKey) return;
      else if (e.code === 'Space' && !target.closest('button, [role="slider"], [role="tab"]')) p.toggle();
      else if (e.key === 'ArrowRight' && !target.closest('[role="slider"], tbody')) p.seek(engine.currentTime + 5);
      else if (e.key === 'ArrowLeft' && !target.closest('[role="slider"], tbody')) p.seek(engine.currentTime - 5);
      else if (e.key === 'ArrowUp' && !target.closest('[role="slider"], tbody')) s.set({ volume: Math.min(1, s.volume + 0.05), muted: false });
      else if (e.key === 'ArrowDown' && !target.closest('[role="slider"], tbody')) s.set({ volume: Math.max(0, s.volume - 0.05) });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Tints the ambient aura with colours from the current cover. */
function useAura() {
  const cover = usePlayer((s) => s.current?.coverUrl);
  useEffect(() => {
    const root = document.documentElement;
    if (!cover) {
      root.style.removeProperty('--aura-a');
      root.style.removeProperty('--aura-b');
      return;
    }
    let alive = true;
    void coverPalette(cover).then((p) => {
      if (!alive || !p) return;
      root.style.setProperty('--aura-a', p[0]);
      root.style.setProperty('--aura-b', p[1]);
    });
    return () => {
      alive = false;
    };
  }, [cover]);
}

export function App() {
  const { tabs, activeId } = useTabs();
  const effects = useSettings((s) => s.effects);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const { compact, drawer, setDrawer, mini } = useLayout();
  useLaunchFiles();
  useShortcuts();
  useAura();

  return (
    <MotionConfig reducedMotion={effects === 'off' ? 'always' : 'user'}>
      <div className={`app${compact ? ' compact' : ''}${mini ? ' mini' : ''}`}>
        <div className="aura" />
        <Titlebar />
        <Sidebar />
        {compact && drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
        <main className="main">
          <TabStrip />
          <div className="page-host panel">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={active.id}
                style={{ position: 'absolute', inset: 0 }}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                <PageBoundary>
                  <Page tab={active} />
                </PageBoundary>
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
        <PlayerBar />
        <QueuePanel />
        <EqPanel />
        <DropZone />
        <TaskTray />
        <Toasts />
        <ContextMenuHost />
        <DialogHost />
        <SmartEditorHost />
        <div className="grain" />
      </div>
    </MotionConfig>
  );
}

export async function boot(): Promise<void> {
  await useSettings.getState().load();
  const s = useSettings.getState();
  engine.setVolume(s.volume, s.muted);
  engine.setEq(s.eq);
  if (s.outputDevice !== 'default') void engine.local.setOutput(s.outputDevice);
  // Only quick database reads hold the first paint. The library (which checks that its folders
  // are reachable, possibly on a slow network) loads in the background, once they are done.
  await Promise.all([useTabs.getState().restore(), usePlaylists.getState().loadList(), usePlayer.getState().restore()]);
  void useLibrary.getState().load();
}
