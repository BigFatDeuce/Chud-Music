import { useDeferredValue, useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { Clock3, Disc3, FolderCog, FolderPlus, Library, ListMusic, LoaderCircle, MoreHorizontal, Play, Search, Shuffle, CalendarPlus, Undo2, UserRound, X, RefreshCw, ImagePlus, ImageOff, CircleStop } from 'lucide-react';
import { SMALL_ALBUM, type Track } from '@shared/types';
import { fmtTotal } from '@/lib/format';
import { trackMenu } from '@/lib/track-actions';
import { startDrag, endDrag } from '@/lib/drag';
import { inRecentAdded, useLibrary } from '@/store/library';
import { usePlayer } from '@/store/player';
import { useSettings } from '@/store/settings';
import { CoverArt } from '@/components/CoverArt';
import { PageScroll } from '@/components/PageScroll';
import { TrackList, type RemoveAction, type Sort } from '@/components/TrackList';
import { showMenu, type MenuItem } from '@/components/ContextMenu';
import { VirtualGrid } from '@/components/VirtualGrid';
import { confirm } from '@/components/Dialog';
import { useTabs } from '@/store/tabs';
import { ClearRecent } from './HomePage';
import { toast } from '@/store/toasts';
import { albumKey, albumOrder } from '@/lib/album';
import { artistKey, useLibView, type LibView } from '@/store/libview';
import { locale, tr } from '@shared/i18n';

type View = LibView;

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const searchText = (t: Track): string => fold(`${t.title} ${t.artist ?? ''} ${t.album ?? ''} ${t.albumArtist ?? ''} ${t.genre ?? ''}`);
const collator = new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });
const cmp = (a: string | null | undefined, b: string | null | undefined) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : collator.compare(a, b));
// albums are told apart by their folder too (lib/album.ts): same-name albums never interleave
const byAlbumOrder = albumOrder(cmp);
const RECENT_DAYS = 30;

// Removing only changes the index: the files stay where they are, untouched.
const removeFromLibrary: RemoveAction = {
  label: (n) => tr('lib.remove', { n }),
  run: (tracks) => void useLibrary.getState().removeTracks(tracks),
};

const hideFromPlayed: RemoveAction = {
  label: () => tr('lib.removeFromNamed', { name: tr('lib.recentPlayed') }),
  run: (tracks) => void useLibrary.getState().hideRecent('played', tracks),
};
const hideFromAdded: RemoveAction = {
  label: () => tr('lib.removeFromNamed', { name: tr('lib.recentAdded') }),
  run: (tracks) => void useLibrary.getState().hideRecent('added', tracks),
};

async function clearLibrary(): Promise<void> {
  const { tracks, folders } = useLibrary.getState();
  const ok = await confirm({
    title: tr('lib.clearQ'),
    body: `${tr('lib.clearTracks', { n: tracks.length })} ${tr('lib.clearFolders', { n: folders.length })} ${tr('lib.clearSafe')}`,
    confirm: tr('lib.clear'),
    danger: true,
  });
  if (ok) await useLibrary.getState().clear();
}

async function removeFoundCovers(): Promise<void> {
  const n = useLibrary.getState().covers.saved;
  const ok = await confirm({ title: tr('cov.removeQ'), body: tr('cov.removeBody', { n }), confirm: tr('cov.removeConfirm'), danger: true });
  if (!ok) return;
  const gone = await window.chud.library.removeFoundCovers();
  toast({ title: tr('cov.removed', { n: gone }) });
}

function libraryMenu(): MenuItem[] {
  const { excluded, addFolder, folders, status, covers, findCovers } = useLibrary.getState();
  return [
    { label: status.running ? tr('lib.scanning', { n: status.found }) : tr('lib.scanNow'), icon: <RefreshCw size={15} />, disabled: status.running || !folders.length, onSelect: () => void window.chud.library.rescan() },
    { label: tr('lib.addFolderEllipsis'), icon: <FolderPlus size={15} />, onSelect: () => void addFolder() },
    { label: tr('lib.manageFolders'), icon: <FolderCog size={15} />, onSelect: () => useTabs.getState().openSection('settings') },
    ...(excluded
      ? [{ label: tr('lib.restore', { n: excluded }), icon: <Undo2 size={15} />, onSelect: () => void window.chud.library.restoreAll() } as MenuItem]
      : []),
    { separator: true },
    covers.running
      ? { label: tr('cov.stop', { done: covers.done, total: covers.total }), icon: <CircleStop size={15} />, onSelect: () => void window.chud.library.cancelCovers() }
      : { label: tr('cov.find'), icon: <ImagePlus size={15} />, onSelect: () => void findCovers() },
    { label: tr('cov.remove', { n: covers.saved }), icon: <ImageOff size={15} />, disabled: !covers.saved || covers.running, onSelect: () => void removeFoundCovers() },
    { separator: true },
    { label: tr('lib.clearEllipsis'), icon: <X size={15} />, danger: true, onSelect: () => void clearLibrary() },
  ];
}

/** Scan and cover search progress: redrawn alone at each progress step, not the page. */
function StatusPills() {
  const scanning = useLibrary((s) => (s.status.running ? s.status.found : -1));
  const covers = useLibrary((s) => (s.covers.running ? `${s.covers.done}/${s.covers.total}` : ''));
  return (
    <>
      {scanning >= 0 && (
        <span className="scan-pill">
          <LoaderCircle size={13} className="spin" /> {tr('lib.scanning', { n: scanning })}
        </span>
      )}
      {covers && (
        <span className="scan-pill">
          <LoaderCircle size={13} className="spin" /> {tr('cov.progress', { done: covers.split('/')[0]!, total: covers.split('/')[1]! })}
        </span>
      )}
    </>
  );
}

export function sortTracks(list: Track[], sort: Sort | null): Track[] {
  const out = [...list];
  if (!sort) return out.sort((a, b) => cmp(a.artist, b.artist) || byAlbumOrder(a, b));
  const d = sort.dir;
  const f: Record<Sort['key'], (a: Track, b: Track) => number> = {
    title: (a, b) => cmp(a.title, b.title),
    artist: (a, b) => cmp(a.artist, b.artist) || byAlbumOrder(a, b),
    album: (a, b) => byAlbumOrder(a, b),
    added: (a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0),
    plays: (a, b) => (a.playCount ?? 0) - (b.playCount ?? 0),
    duration: (a, b) => (a.durationSec ?? 0) - (b.durationSec ?? 0),
  };
  return out.sort((a, b) => f[sort.key](a, b) * d);
}

/** searchText, once per track (a track that changes is another object). */
const searchable = new WeakMap<Track, string>();
function searchOf(t: Track): string {
  let s = searchable.get(t);
  if (s === undefined) searchable.set(t, (s = searchText(t)));
  return s;
}
function warmSearch(tracks: Track[]): () => void {
  let i = 0;
  let id = 0;
  const step = (idle: IdleDeadline) => {
    while (i < tracks.length && idle.timeRemaining() > 2) searchOf(tracks[i++]!);
    if (i < tracks.length) id = requestIdleCallback(step);
  };
  id = requestIdleCallback(step);
  return () => cancelIdleCallback(id);
}

export function LibraryPage() {
  // each piece on its own: scan progress (4 times a second) must not redraw the whole page
  const tracks = useLibrary((s) => s.tracks);
  const hasFolders = useLibrary((s) => s.folders.length > 0);
  const recentlyPlayed = useLibrary((s) => s.recentlyPlayed);
  const hiddenAdded = useLibrary((s) => s.hiddenAdded);
  const loaded = useLibrary((s) => s.loaded);
  const { addFolder } = useLibrary.getState();
  const { view, query, sort, quick, drill } = useLibView();
  const set = useLibView.setState;
  const deferredQuery = useDeferredValue(query);

  // what a search looks into is worked out ahead, in spare moments
  useEffect(() => warmSearch(tracks), [tracks]);

  const filtered = useMemo(() => {
    let list: Track[];
    if (quick === 'recent-played') {
      const byId = new Map(tracks.map((t) => [t.id, t]));
      list = recentlyPlayed.map((r) => byId.get(r.id)).filter((t): t is Track => !!t);
    } else {
      const since = Date.now() - RECENT_DAYS * 86400_000;
      list = quick === 'recent-added' ? tracks.filter((t) => (t.addedAt ?? 0) >= since && inRecentAdded(t, hiddenAdded)) : tracks;
    }
    const words = fold(deferredQuery).split(/\s+/).filter(Boolean);
    if (words.length) {
      list = list.filter((t) => {
        const text = searchOf(t);
        return words.every((w) => text.includes(w));
      });
    }
    if (drill?.kind === 'album') list = list.filter((t) => albumKey(t) === drill.key);
    if (drill?.kind === 'artist') list = list.filter((t) => artistKey(t) === drill.key);
    return list;
  }, [tracks, deferredQuery, quick, drill, recentlyPlayed, hiddenAdded]);

  const shown = useMemo(() => {
    if (quick === 'recent-played' && !sort) return filtered;
    if (quick === 'recent-added' && !sort) return sortTracks(filtered, { key: 'added', dir: -1 });
    if (drill?.kind === 'album' && !sort) return [...filtered].sort(byAlbumOrder);
    return sortTracks(filtered, sort);
  }, [filtered, sort, quick, drill]);

  const albums = useMemo(() => {
    if (view !== 'albums') return [];
    const m = new Map<string, { key: string; title: string; artist: string | null; year: number | null; cover: string | null; tracks: Track[] }>();
    for (const t of filtered) {
      if (!t.album) continue;
      const k = albumKey(t);
      const a = m.get(k) ?? { key: k, title: t.album, artist: t.albumArtist ?? t.artist, year: t.year ?? null, cover: null, tracks: [] };
      a.tracks.push(t);
      a.cover ??= t.coverUrl;
      m.set(k, a);
    }
    return [...m.values()].sort((a, b) => cmp(a.artist, b.artist) || cmp(a.title, b.title));
  }, [filtered, view]);
  // singles and stray tracks of an album clutter the grid: hidden by default (Settings › Library)
  const hideSmall = useSettings((s) => s.hideSmallAlbums);
  const shownAlbums = useMemo(() => (hideSmall ? albums.filter((a) => a.tracks.length >= SMALL_ALBUM) : albums), [albums, hideSmall]);
  const hiddenAlbums = albums.length - shownAlbums.length;

  const artists = useMemo(() => {
    if (view !== 'artists') return [];
    const m = new Map<string, { key: string; name: string; count: number; cover: string | null; albums: Set<string> }>();
    for (const t of filtered) {
      const k = artistKey(t);
      const a = m.get(k) ?? { key: k, name: t.artist ?? tr('common.unknownArtist'), count: 0, cover: null, albums: new Set() };
      a.count++;
      a.cover ??= t.coverUrl;
      if (t.album) a.albums.add(t.album);
      m.set(k, a);
    }
    return [...m.values()].sort((a, b) => cmp(a.name, b.name));
  }, [filtered, view]);

  const label = drill ? drill.label : tr('section.library');
  const playList = (list: Track[], shuffle = false) => {
    if (!list.length) return;
    if (shuffle !== useSettings.getState().shuffle) useSettings.getState().set({ shuffle });
    usePlayer.getState().playFrom('section:library', label, list, shuffle ? Math.floor(Math.random() * list.length) : 0);
  };
  const total = shown.reduce((s, t) => s + (t.durationSec ?? 0), 0);

  if (!loaded) {
    return (
      <PageScroll>
        <h1 className="page-title">{tr('section.library')}</h1>
        <p className="page-sub"><LoaderCircle size={13} className="spin" /> {tr('lib.loading')}</p>
      </PageScroll>
    );
  }

  if (!hasFolders && !tracks.length) {
    return (
      <PageScroll>
        <h1 className="page-title">{tr('section.library')}</h1>
        <p className="page-sub">{tr('lib.sub')}</p>
        <motion.div className="empty" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
          <motion.div className="empty-art">
            <Disc3 size={64} strokeWidth={1.4} />
          </motion.div>
          <h3>{tr('lib.emptyTitle')}</h3>
          <p>{tr('lib.emptyText')}</p>
          <button className="btn primary" onClick={() => void addFolder()}>
            <FolderPlus size={16} /> {tr('lib.addFolder')}
          </button>
        </motion.div>
      </PageScroll>
    );
  }

  return (
    <PageScroll>
      <header className="lib-head">
        <div>
          <h1 className="page-title">{drill ? drill.label : tr('section.library')}</h1>
          <p className="page-sub">
            {tr('n.tracks', { n: shown.length })}
            {total > 0 && ` · ${fmtTotal(total)}`}
            <StatusPills />
          </p>
        </div>
        <div className="lib-actions">
          <button className="play-fab small" aria-label={tr('lib.playAll')} disabled={!shown.length} onClick={() => playList(view === 'albums' ? shownAlbums.flatMap((a) => [...a.tracks].sort(byAlbumOrder)) : shown)}>
            <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />
          </button>
          <button className="icon-btn" aria-label={tr('player.shuffle')} title={tr('lib.shuffleAll')} disabled={!shown.length} onClick={() => playList(shown, true)}>
            <Shuffle size={18} />
          </button>
          <button className="icon-btn" aria-label={tr('common.moreActions')} title={tr('common.moreActions')} onClick={(e) => showMenu(e, libraryMenu())}>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </header>

      <div className="lib-toolbar">
        <div className="segmented" role="tablist" aria-label={tr('yt.view')}>
          {([
            ['tracks', tr('yt.songs'), ListMusic],
            ['albums', tr('stats.albums'), Disc3],
            ['artists', tr('stats.artists'), UserRound],
          ] as const).map(([v, l, Icon]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => set({ view: v, drill: null })}>
              <Icon size={14} /> {l}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={16} />
          <input value={query} onChange={(e) => set({ query: e.target.value })} placeholder={tr('common.search')} aria-label={tr('lib.searchLabel')} />
          {query && (
            <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={tr('common.clear')} onClick={() => set({ query: '' })}>
              <X size={14} />
            </button>
          )}
        </label>
        <div className="chips">
          {([
            ['all', tr('lib.all'), Library],
            ['recent-added', tr('lib.recentAdded'), CalendarPlus],
            ['recent-played', tr('lib.recentPlayed'), Clock3],
          ] as const).map(([q, l, Icon]) => (
            <button key={q} className={`chip${quick === q ? ' on' : ''}`} onClick={() => set({ quick: q })}>
              <Icon size={13} /> {l}
            </button>
          ))}
          {quick === 'recent-played' && recentlyPlayed.length > 0 && <ClearRecent />}
        </div>
      </div>

      {drill && (
        <button className="chip on drill" onClick={() => set({ drill: null, view: drill.kind === 'album' ? 'albums' : 'artists' })}>
          {drill.kind === 'album' ? <Disc3 size={13} /> : <UserRound size={13} />} {drill.label} <X size={13} />
        </button>
      )}

      {view === 'tracks' || drill ? (
        shown.length ? (
          <TrackList
            tabId="section:library"
            label={label}
            tracks={shown}
            columns={drill?.kind === 'album' ? ['num', 'title', 'artist', 'format', 'duration'] : ['num', 'title', 'artist', 'album', 'added', 'format', 'duration']}
            sort={sort}
            onSort={(s) => set({ sort: s })}
            // the "recent" views take the track out of themselves, not out of the library
            remove={quick === 'recent-played' ? hideFromPlayed : quick === 'recent-added' ? hideFromAdded : removeFromLibrary}
          />
        ) : (
          <div className="empty"><p>{tr('lib.noMatch')}</p></div>
        )
      ) : view === 'albums' ? (
        <>
          {/* only the rows in sight are drawn: a big library has thousands of albums */}
          <VirtualGrid
            className="lib-albums"
            items={shownAlbums}
            minWidth={170}
            gap={18}
            rowGap={22}
            estimate={(w) => w + 52}
            itemKey={(a) => a.key}
            render={(a) => {
              const ordered = () => [...a.tracks].sort(byAlbumOrder);
              return (
                <div
                  className="album-card"
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => startDrag(e, { tracks: ordered() })}
                  onDragEnd={endDrag}
                  onClick={() => set({ drill: { kind: 'album', key: a.key, label: a.title }, sort: null })}
                  onKeyDown={(e) => e.key === 'Enter' && set({ drill: { kind: 'album', key: a.key, label: a.title }, sort: null })}
                  onContextMenu={(e) =>
                    showMenu(e, trackMenu(ordered(), {
                      play: () => usePlayer.getState().playFrom('section:library', a.title, ordered(), 0),
                      remove: { label: tr('lib.removeAlbum'), run: () => removeFromLibrary.run(ordered()) },
                    }))
                  }
                >
                  <div className="album-art">
                    <CoverArt url={a.cover} size={40} thumb={256} />
                    <button
                      className="album-play"
                      aria-label={tr('common.playNamed', { name: a.title })}
                      onClick={(e) => {
                        e.stopPropagation();
                        usePlayer.getState().playFrom('section:library', a.title, ordered(), 0);
                      }}
                    >
                      <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />
                    </button>
                  </div>
                  <b title={a.title}>{a.title}</b>
                  <span>{[a.artist, a.year].filter(Boolean).join(' · ') || '—'}</span>
                </div>
              );
            }}
          />
          {!albums.length && <div className="empty"><p>{tr('lib.noAlbums')}</p></div>}
          {hiddenAlbums > 0 && (
            <p className="albums-hidden">
              {tr('lib.smallHidden', { n: hiddenAlbums, min: SMALL_ALBUM })}{' '}
              <button className="btn ghost small" onClick={() => useSettings.getState().set({ hideSmallAlbums: false })}>{tr('lib.showSmall')}</button>
            </p>
          )}
        </>
      ) : (
        <VirtualGrid
          className="lib-artists"
          items={artists}
          minWidth={280}
          gap={6}
          estimate={() => 60}
          itemKey={(a) => a.key}
          render={(a) => (
            <button
              className="artist-row"
              onClick={() => set({ drill: { kind: 'artist', key: a.key, label: a.name } })}
              onContextMenu={(e) => {
                const list = filtered.filter((t) => artistKey(t) === a.key).sort(byAlbumOrder);
                showMenu(e, trackMenu(list, {
                  play: () => usePlayer.getState().playFrom('section:library', a.name, list, 0),
                  remove: { label: tr('lib.removeArtist'), run: () => removeFromLibrary.run(list) },
                }));
              }}
            >
              <span className="artist-avatar"><CoverArt url={a.cover} size={18} thumb={96} /></span>
              <b>{a.name}</b>
              <span>{tr('n.albums', { n: a.albums.size })} · {tr('n.tracks', { n: a.count })}</span>
            </button>
          )}
        />
      )}
    </PageScroll>
  );
}
