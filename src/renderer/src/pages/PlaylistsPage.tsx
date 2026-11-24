import { motion } from 'motion/react';
import { Download, Plus, Sparkles, Upload } from 'lucide-react';
import { fmtTotal } from '@/lib/format';
import { createPlaylistWith } from '@/lib/track-actions';
import { usePlaylists } from '@/store/playlists';
import { useTabs } from '@/store/tabs';
import { toast } from '@/store/toasts';
import { showMenu } from '@/components/ContextMenu';
import { PageScroll } from '@/components/PageScroll';
import { Mosaic, playlistMenu, smartMenu } from './PlaylistPage';
import { tr } from '@shared/i18n';

export function PlaylistsPage() {
  const list = usePlaylists((s) => s.list);
  const openPlaylist = useTabs((s) => s.openPlaylist);

  const create = async () => {
    const id = await createPlaylistWith();
    if (id) openPlaylist(id);
  };
  const importFiles = async () => {
    try {
      const n = await window.chud.playlists.importFiles();
      if (n) toast({ title: tr('pl.imported', { n }) });
    } catch (e) {
      toast({ kind: 'error', title: tr('set.importFailed'), body: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e) });
    }
  };

  return (
    <PageScroll>
      <header className="lib-head">
        <div>
          <h1 className="page-title">{tr('section.playlists')}</h1>
          <p className="page-sub">{tr('pls.sub')}</p>
        </div>
        <div className="lib-actions">
          <button className="btn ghost" onClick={importFiles}>
            <Upload size={15} /> {tr('pls.import')}
          </button>
          <button className="btn ghost" disabled={!list.length} onClick={() => void window.chud.playlists.exportAll().then((f) => f && toast({ title: tr('pls.exported'), body: f }))}>
            <Download size={15} /> {tr('pls.exportAll')}
          </button>
        </div>
      </header>

      <motion.div className="playlist-grid" variants={{ show: { transition: { staggerChildren: 0.03 } } }} initial="hidden" animate="show">
        <motion.button variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} className="playlist-card new" onClick={create}>
          <div className="playlist-new-art"><Plus size={42} /></div>
          <b>{tr('pl.new')}</b>
          <span>{tr('pls.newText')}</span>
        </motion.button>
        <motion.button variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} className="playlist-card new smart" data-new-smart onClick={(e) => showMenu(e, smartMenu())}>
          <div className="playlist-new-art"><Sparkles size={38} /></div>
          <b>{tr('smart.new')}</b>
          <span>{tr('smart.newText')}</span>
        </motion.button>
        {list.map((p) => (
          <motion.button
            key={p.id}
            variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
            className="playlist-card"
            onClick={() => openPlaylist(p.id)}
            onContextMenu={(e) => showMenu(e, playlistMenu(p))}
          >
            <Mosaic covers={p.covers} cover={p.cover} size={180} />
            <b title={p.name}>{p.smart && <Sparkles size={13} className="smart-mark" aria-label={tr('smart.title')} />}{p.name}</b>
            <span>
              {tr('n.tracks', { n: p.count })}
              {p.durationSec > 0 && ` · ${fmtTotal(p.durationSec)}`}
            </span>
          </motion.button>
        ))}
      </motion.div>
    </PageScroll>
  );
}
