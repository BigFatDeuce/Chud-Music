import { motion } from 'motion/react';
import { ListPlus, Pause, Play, Radio, RefreshCw } from 'lucide-react';
import type { Tab } from '@/store/tabs';
import { useTabs } from '@/store/tabs';
import { usePlayer } from '@/store/player';
import { startMix } from '@/store/youtube';
import { fmtTotal } from '@/lib/format';
import { createPlaylistWith } from '@/lib/track-actions';
import { CoverArt } from '@/components/CoverArt';
import { PageScroll } from '@/components/PageScroll';
import { TrackList } from '@/components/TrackList';
import { tr } from '@shared/i18n';

/** YouTube Music's own radio for a seed track (its "Start radio" list), as a temporary tab. */
export function MixTabPage({ tab }: { tab: Extract<Tab, { kind: 'mix' }> }) {
  const isCtx = usePlayer((s) => s.ctx?.tabId === tab.id);
  const status = usePlayer((s) => s.status);
  const { resumeTab, toggle } = usePlayer();
  const openPlaylist = useTabs((s) => s.openPlaylist);
  const total = tab.tracks.reduce((s, t) => s + (t.durationSec ?? 0), 0);
  const playingHere = isCtx && status === 'playing';

  const save = async () => {
    const id = await createPlaylistWith(tab.tracks, tab.title);
    if (id) openPlaylist(id);
  };

  return (
    <PageScroll>
      <motion.header className="list-hero" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
        <div className="list-hero-art single">{tab.seed.coverUrl ? <CoverArt url={tab.seed.coverUrl} size={48} /> : <div className="ph"><Radio size={48} /></div>}</div>
        <div className="list-hero-meta">
          <span className="list-hero-kicker">{tr('mix.kicker', { title: tab.seed.title })}</span>
          <h1 className="list-hero-title" title={tab.title}>{tab.title}</h1>
          <div className="list-hero-stats">
            <span>{tr('n.titles', { n: tab.tracks.length })}</span>
            {total > 0 && <span>· {fmtTotal(total)}</span>}
          </div>
          <div className="list-hero-actions">
            <button className="play-fab" aria-label={playingHere ? tr('player.pause') : tr('common.play')} onClick={() => (isCtx && status === 'loading' ? undefined : isCtx && status !== 'idle' ? toggle() : resumeTab(tab.id, tab.title, tab.tracks))}>
              {playingHere ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" style={{ marginLeft: 3 }} />}
            </button>
            <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={save}>
              <ListPlus size={16} /> {tr('pl.saveAs')}
            </button>
            <button className="btn ghost" style={{ alignSelf: 'center' }} title={tr('mix.newHint')} onClick={() => void startMix(tab.seed)}>
              <RefreshCw size={16} /> {tr('mix.new')}
            </button>
          </div>
        </div>
      </motion.header>
      <TrackList tabId={tab.id} label={tab.title} tracks={tab.tracks} columns={['num', 'title', 'artist', 'album', 'duration']} />
      <p style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 24 }}>
        Cette liste est celle que YouTube Music propose pour « Démarrer le mix ». Cet onglet n’est pas une playlist : le fermer ne supprime rien.
      </p>
    </PageScroll>
  );
}
