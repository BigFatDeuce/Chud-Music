import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { CopyX, Download, FilePlus2, FolderPlus, HardDrive, ImageOff, ImagePlus, Link2, ListChecks, ListMusic, MoreHorizontal, Pause, Pencil, Play, Search, Shuffle, Sparkles, Trash2, X } from 'lucide-react';
import type { PlaylistSummary, Track } from '@shared/types';
import { fmtTotal } from '@/lib/format';
import { usePlaylists } from '@/store/playlists';
import { usePlayer } from '@/store/player';
import { useSettings } from '@/store/settings';
import { toast } from '@/store/toasts';
import { confirm, prompt } from '@/components/Dialog';
import { showMenu, type MenuItem } from '@/components/ContextMenu';
import { createPreset, editSmart, newSmart } from '@/components/SmartEditor';
import { PageScroll } from '@/components/PageScroll';
import { TrackList, type Sort } from '@/components/TrackList';
import { sortTracks } from '@/pages/LibraryPage';
import { CoverArt, thumbUrl } from '@/components/CoverArt';
import { dragPayload, endDrag, isTrackDrag } from '@/lib/drag';
import { addFilesToPlaylistFromDialog, addFolderToPlaylistFromDialog } from '@/lib/open-files';
import { addToPlaylistChooser } from '@/lib/add-menus';
import { createPlaylistWith } from '@/lib/track-actions';
import { locale, tr } from '@shared/i18n';
import { parseMusicLink } from '@shared/links';
import { duplicateEntries } from '@shared/duplicates';
import { importLinkIntoPlaylist } from '@/store/youtube';

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** The playlist's picture: the one chosen by hand, else a mosaic of its tracks' covers. */
export function Mosaic({ covers, cover, size = 168 }: { covers: string[]; cover?: string | null; size?: number }) {
  if (cover) {
    return (
      <div className="list-hero-art single chosen" style={{ width: size, height: size }}>
        <img src={thumbUrl(cover, 512)} alt="" draggable={false} decoding="async" />
      </div>
    );
  }
  return (
    <div className={`list-hero-art${covers.length < 4 ? ' single' : ''}`} style={{ width: size, height: size }}>
      {covers.length >= 4 ? covers.slice(0, 4).map((c) => <img key={c} src={thumbUrl(c, 256)} alt="" draggable={false} decoding="async" />) : covers[0] ? <CoverArt url={covers[0]} thumb={512} /> : <div className="ph"><ListMusic size={size / 3.5} /></div>}
    </div>
  );
}

export async function renamePlaylist(p: PlaylistSummary): Promise<void> {
  const name = await prompt({ title: tr('pl.renameTitle'), label: tr('common.name'), initial: p.name, confirm: tr('common.rename') });
  if (name && name !== p.name) await window.chud.playlists.rename(p.id, name);
}

export async function deletePlaylist(p: PlaylistSummary): Promise<void> {
  const ok = await confirm({
    title: tr('pl.deleteQ', { name: p.name }),
    body: tr('pl.deleteBody', { tracks: tr('n.tracks', { n: p.count }) }),
    confirm: tr('common.delete'),
    danger: true,
  });
  if (ok) await window.chud.playlists.remove(p.id);
}

/** The YouTube Music entries that are also in the library, swapped for the local files (asked first). */
export async function preferLocal(p: PlaylistSummary): Promise<void> {
  const swaps = await window.chud.playlists.localSwaps(p.id);
  if (!swaps.length) return void toast({ title: tr('pl.localNone') });
  const names = swaps.slice(0, 8).map((s) => `• ${s.to.title}${s.to.artist ? ` — ${s.to.artist}` : ''}`);
  if (swaps.length > 8) names.push('…');
  const ok = await confirm({ title: tr('pl.localQ', { n: swaps.length }), body: `${tr('pl.localBody')}\n\n${names.join('\n')}`, confirm: tr('pl.localConfirm') });
  if (!ok) return;
  const n = await window.chud.playlists.applySwaps(p.id, swaps.map((s) => ({ entryId: s.entryId, trackId: s.to.id })));
  toast({ title: tr('pl.localDone', { n }) });
}


/**
 * Finds the duplicates and asks before taking them out. Of the copies of a song the best one
 * stays (shared/duplicates.ts: a lossless file, else the file with the highest bit rate, else the
 * YouTube Music track); a video file is only compared with other videos.
 */
export async function removeDuplicates(p: PlaylistSummary): Promise<void> {
  const tracks = usePlaylists.getState().details[p.id]?.tracks ?? (await window.chud.playlists.get(p.id))?.tracks ?? [];
  const dupes = duplicateEntries(tracks);
  if (!dupes.length) return void toast({ title: tr('pl.dupesNone') });
  const names = dupes.slice(0, 8).map((t) => `• ${t.title}${t.artist ? ` — ${t.artist}` : ''}`);
  if (dupes.length > 8) names.push('…');
  const ok = await confirm({ title: tr('pl.dupesQ', { n: dupes.length }), body: `${tr('pl.dupesBody')}\n\n${names.join('\n')}`, confirm: tr('pl.dupesConfirm'), danger: true });
  if (!ok) return;
  await window.chud.playlists.removeEntries(p.id, dupes.map((t) => t.entryId!).filter((x) => x != null));
  toast({ title: tr('pl.dupesDone', { n: dupes.length }) });
}

const problemOf = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e));

export async function changeCover(p: PlaylistSummary): Promise<void> {
  try {
    if (await window.chud.playlists.setCover(p.id)) toast({ title: tr('pl.coverChanged'), body: p.name });
  } catch (e) {
    toast({ kind: 'error', title: tr('pl.coverFailed'), body: problemOf(e) });
  }
}

const coverItems = (p: PlaylistSummary): MenuItem[] => [
  { label: tr('pl.setCover'), icon: <ImagePlus size={15} />, onSelect: () => void changeCover(p) },
  ...(p.cover ? [{ label: tr('pl.clearCover'), icon: <ImageOff size={15} />, onSelect: () => void window.chud.playlists.clearCover(p.id) }] : []),
];

/** The tracks a smart playlist holds now, as an ordinary playlist (which no longer changes by itself). */
async function saveAsPlain(p: PlaylistSummary): Promise<void> {
  const d = await window.chud.playlists.get(p.id);
  if (d) await createPlaylistWith(d.tracks, `${p.name} — ${new Date().toLocaleDateString(locale())}`);
}

async function rediscoverCustom(): Promise<void> {
  const v = await prompt({ title: tr('smart.preset.rediscover'), label: tr('smart.rediscoverDays'), initial: '90', confirm: tr('common.create') });
  const days = Math.round(Number(v));
  if (v && days > 0) await createPreset('rediscover', days);
}

/** New smart playlist: the ready-made ones, or one's own rules. */
export function smartMenu(): MenuItem[] {
  return [
    { label: tr('smart.preset.never'), icon: <Sparkles size={15} />, onSelect: () => void createPreset('never') },
    {
      label: tr('smart.preset.rediscover'),
      icon: <Sparkles size={15} />,
      submenu: [
        { label: tr('smart.span.halfYear'), onSelect: () => void createPreset('rediscover', 182) },
        { label: tr('smart.span.year'), onSelect: () => void createPreset('rediscover', 365) },
        { label: tr('smart.span.custom'), onSelect: () => void rediscoverCustom() },
      ],
    },
    { label: tr('smart.preset.recent'), icon: <Sparkles size={15} />, onSelect: () => void createPreset('recent') },
    { label: tr('smart.preset.most'), icon: <Sparkles size={15} />, onSelect: () => void createPreset('most') },
    { separator: true },
    { label: tr('smart.custom'), icon: <ListChecks size={15} />, onSelect: () => newSmart('custom') },
  ];
}

export function playlistMenu(p: PlaylistSummary): MenuItem[] {
  const renameExportDelete: MenuItem[] = [
    { separator: true },
    ...coverItems(p),
    { label: tr('common.renameEllipsis'), icon: <Pencil size={15} />, onSelect: () => void renamePlaylist(p) },
    {
      label: tr('pl.export'),
      icon: <Download size={15} />,
      onSelect: () => void window.chud.playlists.exportOne(p.id).then((f) => f && toast({ title: tr('pl.exported'), body: f })),
    },
    { separator: true },
    { label: tr('common.deleteEllipsis'), icon: <Trash2 size={15} />, danger: true, onSelect: () => void deletePlaylist(p) },
  ];
  if (p.smart) {
    return [
      { label: tr('smart.edit'), icon: <ListChecks size={15} />, onSelect: () => editSmart(p) },
      { label: tr('smart.saveAsPlain'), icon: <ListMusic size={15} />, onSelect: () => void saveAsPlain(p) },
      ...renameExportDelete,
    ];
  }
  return [
    { label: tr('pl.addFiles'), icon: <FilePlus2 size={15} />, onSelect: () => void addFilesToPlaylistFromDialog(p.id) },
    { label: tr('lib.addFolderEllipsis'), icon: <FolderPlus size={15} />, onSelect: () => void addFolderToPlaylistFromDialog(p.id) },
    { separator: true },
    { label: tr('pl.preferLocal'), icon: <HardDrive size={15} />, onSelect: () => void preferLocal(p) },
    { label: tr('pl.dupes'), icon: <CopyX size={15} />, onSelect: () => void removeDuplicates(p) },
    ...renameExportDelete,
  ];
}

export function PlaylistPage({ playlistId, tabId }: { playlistId: number; tabId: string }) {
  const detail = usePlaylists((s) => s.details[playlistId]);
  const summary = usePlaylists((s) => s.list.find((p) => p.id === playlistId));
  const loadDetail = usePlaylists((s) => s.loadDetail);
  const isCtx = usePlayer((s) => s.ctx?.tabId === tabId);
  const status = usePlayer((s) => s.status);
  const shuffle = useSettings((s) => s.shuffle);

  useEffect(() => {
    void loadDetail(playlistId);
  }, [playlistId, loadDetail]);

  // search inside the playlist, as in the library: title, artist, album, genre; accents and case ignored
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const all = detail?.tracks;
  const index = useMemo(() => (all ?? []).map((t) => fold(`${t.title} ${t.artist ?? ''} ${t.album ?? ''} ${t.albumArtist ?? ''} ${t.genre ?? ''}`)), [all]);
  const shown = useMemo(() => {
    const words = fold(deferredQuery).split(/\s+/).filter(Boolean);
    return !all || !words.length ? (all ?? []) : all.filter((_, i) => words.every((w) => index[i]!.includes(w)));
  }, [all, index, deferredQuery]);
  const searching = shown !== all;
  // sorted by a column, as in the library (one more click on the column = the playlist's own order)
  const [sort, setSort] = useState<Sort | null>(null);
  const sorted = useMemo(() => (sort ? sortTracks(shown, sort) : shown), [shown, sort]);

  if (!detail || !summary) {
    return (
      <PageScroll>
        <p className="page-sub">{summary === undefined && detail === undefined ? tr('common.loading') : tr('pl.gone')}</p>
      </PageScroll>
    );
  }

  const unavailable = detail.tracks.filter((t) => !t.available).length;
  const playingHere = isCtx && status === 'playing';
  const p = usePlayer.getState();

  return (
    <PageScroll>
      <motion.header className="list-hero" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="list-hero-cover" onContextMenu={(e) => showMenu(e, playlistMenu(summary))}>
          <Mosaic covers={summary.covers} cover={summary.cover} />
        </div>
        <div className="list-hero-meta">
          <span className="list-hero-kicker">{summary.smart ? tr('smart.title') : tr('common.playlist')}</span>
          <h1 className="list-hero-title editable" title={tr('common.rename')} onDoubleClick={() => void renamePlaylist(summary)}>
            {summary.name}
          </h1>
          <div className="list-hero-stats">
            <span>{tr('n.tracks', { n: summary.count })}</span>
            {summary.durationSec > 0 && <span>· {fmtTotal(summary.durationSec)}</span>}
            {unavailable > 0 && <span className="badge warn">{tr('n.unavailable', { n: unavailable })}</span>}
          </div>
          <div className="list-hero-actions">
            <button
              className="play-fab"
              aria-label={playingHere ? tr('player.pause') : tr('common.play')}
              disabled={!detail.tracks.length}
              onClick={() => (isCtx && status === 'loading' ? undefined : isCtx && status !== 'idle' ? p.toggle() : p.resumeTab(tabId, summary.name, detail.tracks))}
            >
              {playingHere ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" style={{ marginLeft: 3 }} />}
            </button>
            <button className={`icon-btn${shuffle ? ' on' : ''}`} style={{ alignSelf: 'center' }} aria-label={tr('player.shuffle')} aria-pressed={shuffle} onClick={p.toggleShuffle}>
              <Shuffle size={19} />
            </button>
            {summary.smart && (
              <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={() => editSmart(summary)}>
                <ListChecks size={15} /> {tr('smart.editShort')}
              </button>
            )}
            <button className="icon-btn" style={{ alignSelf: 'center' }} aria-label={tr('common.moreActions')} onClick={(e) => showMenu(e, playlistMenu(summary))}>
              <MoreHorizontal size={20} />
            </button>
          </div>
        </div>
      </motion.header>

      {detail.tracks.length > 0 && (
        <div className="lib-toolbar pl-toolbar">
          <label className="search">
            <Search size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('common.search')} aria-label={tr('pl.searchLabel')} />
            {query && (
              <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={tr('common.clear')} onClick={() => setQuery('')}>
                <X size={14} />
              </button>
            )}
          </label>
          {searching && <span className="pl-found">{tr('n.tracks', { n: shown.length })}</span>}
        </div>
      )}
      {detail.tracks.length ? (
        searching && !shown.length ? (
          <div className="empty"><p>{tr('pl.noMatch')}</p></div>
        ) : (
        <TrackList tabId={tabId} label={summary.name} tracks={sorted} columns={['num', 'title', 'artist', 'album', 'format', 'duration']}
          sort={sort}
          onSort={setSort}
          // while searching or sorted, the rows are not in the playlist's order: no reordering by drag
          playlistId={searching || sort || summary.smart ? undefined : playlistId}
          remove={
            summary.smart
              ? {
                  // a smart playlist holds no entries: the track is left out of its results
                  label: (n) => tr('smart.exclude', { n }),
                  run: (picked) => void window.chud.playlists.setSmart(playlistId, { ...summary.smart!, excludeIds: [...new Set([...summary.smart!.excludeIds, ...picked.map((t) => t.id)])] }),
                }
              : {
                  label: (n) => tr('pl.remove', { n }),
                  run: (picked) => void window.chud.playlists.removeEntries(playlistId, picked.map((t) => t.entryId!).filter((x) => x != null)),
                }
          }
        />
        )
      ) : summary.smart ? (
        <div className="empty">
          <div className="empty-art"><Sparkles size={56} strokeWidth={1.4} /></div>
          <h3>{tr('smart.empty')}</h3>
          <p>{tr('smart.emptyText')}</p>
          <button className="btn ghost" onClick={() => editSmart(summary)}><ListChecks size={16} /> {tr('smart.edit')}</button>
        </div>
      ) : (
        <PlaylistDropEmpty playlistId={playlistId} />
      )}
    </PageScroll>
  );
}

function PlaylistDropEmpty({ playlistId }: { playlistId: number }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  /** A YouTube / Spotify link: its tracks, found on YouTube Music, fill the playlist. */
  const importLink = async (text: string) => {
    if (busy) return;
    setBusy(tr('link.reading'));
    try {
      const r = await importLinkIntoPlaylist(playlistId, text, (done, total) => setBusy(tr('link.matchingN', { n: done, total })));
      if (r.added) toast({ title: tr('pl.linkAdded', { n: r.added }), body: r.missed ? tr('pl.linkMissed', { n: r.missed }) : r.title });
      else toast({ kind: 'error', title: tr('link.emptyPlaylist') });
    } catch (e) {
      toast({ kind: 'error', title: tr('link.failed'), body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      setLink('');
    }
  };
  return (
    <div
      className="empty drop-hint"
      onDragOver={(e) => {
        if (isTrackDrag(e)) e.preventDefault();
      }}
      onDrop={() => {
        const pl = dragPayload();
        endDrag();
        if (pl) void usePlaylists.getState().addTracks(playlistId, pl.tracks);
      }}
    >
      <div className="empty-art"><ListMusic size={56} strokeWidth={1.4} /></div>
      <h3>{tr('pl.empty')}</h3>
      <p>{tr('pl.emptyText')}</p>
      <button className="btn ghost" onClick={(e) => addToPlaylistChooser(e, playlistId)}>
        <FilePlus2 size={16} /> {tr('pl.addFilesOrFolder')}
      </button>
      <form
        className="pl-link"
        onSubmit={(e) => {
          e.preventDefault();
          if (parseMusicLink(link)) void importLink(link);
          else toast({ kind: 'error', title: tr('pl.linkUnsupported') });
        }}
      >
        <Link2 size={15} />
        <input
          value={busy ?? link}
          disabled={!!busy}
          onChange={(e) => setLink(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (!parseMusicLink(text)) return;
            e.preventDefault();
            setLink(text);
            void importLink(text);
          }}
          placeholder={tr('pl.pasteLink')}
          aria-label={tr('pl.pasteLink')}
          spellCheck={false}
        />
      </form>
    </div>
  );
}
