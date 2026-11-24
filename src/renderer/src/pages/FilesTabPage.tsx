import { motion } from 'motion/react';
import { FileAudio, ListPlus, LoaderCircle, Pause, Play, Shuffle } from 'lucide-react';
import type { Tab } from '@/store/tabs';
import { useTabs } from '@/store/tabs';
import { usePlayer } from '@/store/player';
import { useSettings } from '@/store/settings';
import { fmtTotal } from '@/lib/format';
import { createPlaylistWith } from '@/lib/track-actions';
import { CoverArt, thumbUrl } from '@/components/CoverArt';
import { PageScroll } from '@/components/PageScroll';
import { TrackList } from '@/components/TrackList';
import { tr } from '@shared/i18n';

export function FilesTabPage({ tab }: { tab: Extract<Tab, { kind: 'files' }> }) {
  const isCtx = usePlayer((s) => s.ctx?.tabId === tab.id);
  const status = usePlayer((s) => s.status);
  const { resumeTab, toggle, toggleShuffle } = usePlayer();
  const shuffle = useSettings((s) => s.shuffle);
  const openPlaylist = useTabs((s) => s.openPlaylist);
  const removeOpened = useTabs((s) => s.removeOpened);
  const moveOpened = useTabs((s) => s.moveOpened);
  const tracks = tab.tracks;

  const covers = [...new Set((tracks ?? []).map((t) => t.coverUrl).filter(Boolean))].slice(0, 4) as string[];
  const total = (tracks ?? []).reduce((s, t) => s + (t.durationSec ?? 0), 0);
  const missing = (tracks ?? []).filter((t) => !t.available).length;
  const loading = (tracks ?? []).filter((t) => t.pending).length;
  const playingHere = isCtx && status === 'playing';

  const saveAsPlaylist = async () => {
    if (!tracks) return;
    const id = await createPlaylistWith(tracks.filter((t) => t.available), tr('pl.new'));
    if (id) openPlaylist(id);
  };

  return (
    <PageScroll>
      <motion.header className="list-hero" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className={`list-hero-art${covers.length < 4 ? ' single' : ''}`}>
          {covers.length >= 4 ? covers.map((c) => <img key={c} src={thumbUrl(c, 256)} alt="" draggable={false} decoding="async" />) : covers[0] ? <CoverArt url={covers[0]} thumb={512} /> : <div className="ph"><FileAudio size={48} /></div>}
        </div>
        <div className="list-hero-meta">
          <span className="list-hero-kicker">{tr('files.kicker')}</span>
          <h1 className="list-hero-title">{tr('files.title')}</h1>
          <div className="list-hero-stats">
            {tracks ? (
              <>
                <span>{tr('n.tracks', { n: tracks.length })}</span>
                {total > 0 && <span>· {fmtTotal(total)}</span>}
                {missing > 0 && <span className="badge warn">{tr('n.unavailable', { n: missing })}</span>}
                {loading > 0 && (
                  <span className="badge accent loading-badge">
                    <LoaderCircle size={11} className="spin" /> {loading > 1 ? `${loading} fichiers en chargement` : '1 fichier en chargement'}
                  </span>
                )}
              </>
            ) : (
              <span>{tr('files.readingTags')}</span>
            )}
          </div>
          <div className="list-hero-actions">
            <button
              className="play-fab"
              aria-label={playingHere ? tr('player.pause') : tr('common.play')}
              disabled={!tracks?.length}
              onClick={() => (isCtx && status === 'loading' ? undefined : isCtx && status !== 'idle' ? toggle() : tracks && resumeTab(tab.id, tab.title, tracks))}
            >
              {playingHere ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" style={{ marginLeft: 3 }} />}
            </button>
            <button className={`icon-btn${shuffle ? ' on' : ''}`} style={{ alignSelf: 'center' }} aria-label={tr('player.shuffle')} aria-pressed={shuffle} onClick={toggleShuffle}>
              <Shuffle size={19} />
            </button>
            <button className="btn ghost" style={{ alignSelf: 'center' }} disabled={!tracks?.length} onClick={saveAsPlaylist}>
              <ListPlus size={16} /> {tr('pl.saveAs')}
            </button>
          </div>
        </div>
      </motion.header>

      {tracks && (
        <TrackList
          tabId={tab.id}
          label={tab.title}
          tracks={tracks}
          columns={['num', 'title', 'album', 'format', 'duration']}
          remove={{
            label: (n) => tr('files.remove', { n }),
            run: (picked) => removeOpened(picked.map((t) => t.path!).filter(Boolean)),
          }}
          move={moveOpened}
        />
      )}
      <p style={{ color: 'var(--text-2)', fontSize: 12.5, marginTop: 24 }}>
        Les fichiers que vous ouvrez depuis l’Explorateur s’ajoutent ici. Ce n’est pas une playlist : retirer un fichier ou fermer l’onglet ne supprime rien. Pour changer l’ordre : glisser un morceau, Alt+↑ / Alt+↓, ou clic droit › Monter / Descendre.
      </p>
    </PageScroll>
  );
}
