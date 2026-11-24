import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, Download, Info, ListPlus, X } from 'lucide-react';
import { useToasts } from '@/store/toasts';
import { usePlaylists } from '@/store/playlists';
import { useTabs } from '@/store/tabs';
import { addPathsToPlaylist, openPaths } from '@/lib/open-files';
import { tr } from '@shared/i18n';

/**
 * Files dragged in from Explorer. Dropped on a playlist (its tab, its sidebar entry, or the
 * page of an open playlist) they are added to it; anywhere else they go to "Fichiers ouverts".
 * The overlay covers the page only, so tabs and sidebar stay visible as targets.
 */
export const useFileDrop = create<{ over: boolean; playlistId: number | null }>(() => ({ over: false, playlistId: null }));

function dropTarget(e: DragEvent): number | null {
  const el = (e.target as Element | null)?.closest?.('[data-drop-playlist]');
  if (el) return Number(el.getAttribute('data-drop-playlist'));
  const { tabs, activeId } = useTabs.getState();
  const active = tabs.find((t) => t.id === activeId);
  // over the page of an open playlist (not over the tab strip or the sidebar)
  if (active?.kind === 'playlist' && (e.target as Element | null)?.closest?.('.page-host')) return active.playlistId;
  return null;
}

export function DropZone() {
  const { over, playlistId } = useFileDrop();
  const name = usePlaylists((s) => s.list.find((p) => p.id === playlistId)?.name);
  const host = document.querySelector('.page-host');

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      useFileDrop.setState({ over: true });
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) useFileDrop.setState({ over: false, playlistId: null });
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      const t = dropTarget(e);
      if (t !== useFileDrop.getState().playlistId) useFileDrop.setState({ playlistId: t });
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      const target = dropTarget(e);
      useFileDrop.setState({ over: false, playlistId: null });
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.chud.files.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      if (target != null) void addPathsToPlaylist(target, paths);
      else void openPaths(paths, 'drop');
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (!host) return null;
  const toPlaylist = playlistId != null;
  return createPortal(
    <AnimatePresence>
      {over && (
        <motion.div className={`drop-overlay${toPlaylist ? ' to-playlist' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="drop-card">
            {toPlaylist ? <ListPlus size={48} /> : <Download size={48} />}
            <h2>{toPlaylist ? (name ? tr('drop.toNamed', { name }) : tr('drop.toPlaylist')) : tr('drop.listen')}</h2>
            <span style={{ color: 'var(--text-1)' }}>
              {toPlaylist ? tr('drop.toPlaylistNote') : tr('drop.listenNote')}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    host,
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`toast panel ${t.kind ?? 'info'}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="toast-icon">{t.kind === 'error' ? <CircleAlert size={18} /> : <Info size={18} />}</span>
            <div className="toast-text">
              <b>{t.title}</b>
              {t.body && <span>{t.body}</span>}
            </div>
            {t.action && (
              <button
                className="btn primary"
                style={{ height: 28, padding: '0 10px' }}
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon-btn" style={{ width: 26, height: 26 }} aria-label={tr('common.close')} onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
