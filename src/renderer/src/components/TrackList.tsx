import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, CircleAlert, GripVertical, LoaderCircle, Play } from 'lucide-react';
import type { Track } from '@shared/types';
import { fmtTime } from '@/lib/format';
import { dragPayload, endDrag, isTrackDrag, startDrag } from '@/lib/drag';
import { AlbumName, ArtistName } from './YtMeta';
import { trackMenu } from '@/lib/track-actions';
import { usePlayer } from '@/store/player';
import { usePlaylists } from '@/store/playlists';
import { showMenu } from './ContextMenu';
import { CoverArt } from './CoverArt';
import { usePageScroll } from './PageScroll';
import { locale, tr } from '@shared/i18n';

export type Column = 'num' | 'title' | 'artist' | 'album' | 'added' | 'plays' | 'format' | 'duration';
export type SortKey = 'title' | 'artist' | 'album' | 'added' | 'plays' | 'duration';
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

const COL: Record<Column, { label: string; width: string; sort?: SortKey; align?: 'right' }> = {
  num: { label: '#', width: '52px', align: 'right' },
  title: { label: tr('col.title'), width: 'minmax(220px, 3fr)', sort: 'title' },
  artist: { label: tr('col.artist'), width: 'minmax(120px, 1.5fr)', sort: 'artist' },
  album: { label: tr('col.album'), width: 'minmax(120px, 1.5fr)', sort: 'album' },
  added: { label: tr('col.added'), width: '104px', sort: 'added' },
  plays: { label: tr('col.plays'), width: '76px', sort: 'plays', align: 'right' },
  format: { label: tr('col.format'), width: '96px' },
  duration: { label: tr('col.duration'), width: '72px', sort: 'duration', align: 'right' },
};

export function codecLabel(t: Track): string | null {
  if (t.source === 'youtube') return 'YouTube';
  if (!t.codec) return t.path?.split('.').pop()?.toUpperCase() ?? null;
  if (/Layer 3/.test(t.codec)) return 'MP3';
  if (/AAC/.test(t.codec)) return 'AAC';
  if (/^PCM|65534/.test(t.codec)) return 'PCM';
  if (/Windows Media/i.test(t.codec)) return 'WMA';
  return t.codec.split(/[\s/]/)[0]!.toUpperCase();
}

const fmtDate = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

interface Props {
  tabId: string;
  label: string;
  tracks: Track[];
  columns: Column[];
  sort?: Sort | null;
  onSort?: (s: Sort | null) => void;
  /** A saved playlist: rows can be reordered by drag & drop, and files dropped in. */
  playlistId?: number;
  /** Removal from this list (Delete key and context menu). Never deletes files. */
  remove?: RemoveAction;
  /** A list the user can reorder without being a playlist ("Fichiers ouverts"): moves rows
   *  (indices) before row `to`, returns their new indices. Menu, Alt+↑/↓, drag & drop. */
  move?: (indices: number[], to: number) => number[];
}

export interface RemoveAction {
  label: (n: number) => string;
  run: (tracks: Track[]) => void;
}

const ROW_H = 52;

/** Columns dropped first when the list gets narrow (portrait screens): least useful first. */
const DROP: [Column, number][] = [
  ['added', 900],
  ['plays', 900],
  ['format', 760],
  ['album', 640],
  ['artist', 520], // the artist then shows under the title
];

export function TrackList({ tabId, label, tracks, columns: allColumns, sort, onSort, playlistId, remove, move }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useLayoutEffect(() => {
    const el = rootRef.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns = useMemo(() => allColumns.filter((c) => !DROP.some(([d, w]) => d === c && width < w)), [allColumns, width]);
  const scrollEl = usePageScroll();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const currentKey = usePlayer((s) => (s.ctx?.tabId === tabId && !s.fromQueue && s.current ? (s.current.entryId ?? s.current.id) : undefined));
  const status = usePlayer((s) => s.status);
  const playFrom = usePlayer((s) => s.playFrom);

  // rows being dragged inside this list (reorderable lists that are not playlists)
  const dragging = useRef<number[] | null>(null);
  // after a move, the moved rows stay selected at their new place
  const keepSel = useRef<number[] | null>(null);
  const reorderable = playlistId != null || !!move;

  // selection is index-based: reset it when the list itself changes
  useEffect(() => {
    const keep = keepSel.current;
    keepSel.current = null;
    setSelected(new Set(keep ?? []));
    setAnchor(keep?.[0] ?? null);
    if (keep?.length) setFocus(keep[0]!);
  }, [tracks]);

  useLayoutEffect(() => {
    if (!scrollEl || !bodyRef.current) return;
    const measure = () => {
      const m = bodyRef.current!.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
      setMargin((old) => (Math.abs(old - m) > 1 ? m : old));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scrollEl.firstElementChild ?? scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]);

  const virt = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 12,
    scrollMargin: margin,
  });

  // the list follows what plays: when the track changes (shuffle in a big playlist, next track…)
  // or when the list is opened, the playing row is brought to the middle if it is out of sight.
  // Only on those moments: scrolling by hand afterwards is never undone.
  const keyOf = (t: Track) => t.entryId ?? t.id;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  useEffect(() => {
    if (currentKey === undefined || !scrollEl) return;
    const i = tracksRef.current.findIndex((t) => keyOf(t) === currentKey);
    if (i < 0) return;
    const id = requestAnimationFrame(() => {
      const top = margin + i * ROW_H;
      const view = scrollEl.scrollTop;
      if (top >= view + 60 && top + ROW_H <= view + scrollEl.clientHeight - 20) return; // already in sight
      virt.scrollToIndex(i, { align: 'center' });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, scrollEl, margin > 0]);

  // "#" as wide as the biggest number: at 52 px, 142527 was cut to "42527" (the 1 hidden)
  const digits = String(tracks.length).length;
  const template = useMemo(() => columns.map((c) => (c === 'num' && digits > 4 ? `calc(${digits}ch + 20px)` : COL[c].width)).join(' '), [columns, digits]);
  const play = (i: number) => playFrom(tabId, label, tracks, i);
  const selection = (fallback: number) => (selected.has(fallback) ? [...selected].sort((a, b) => a - b) : [fallback]);

  const click = (e: MouseEvent, i: number) => {
    setFocus(i);
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      setSelected(new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)));
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(selected);
      if (s.has(i)) s.delete(i);
      else s.add(i);
      setSelected(s);
      setAnchor(i);
    } else {
      setSelected(new Set([i]));
      setAnchor(i);
    }
  };

  const removeSelected = () => {
    if (!remove) return;
    const idx = selected.size ? [...selected].sort((a, b) => a - b) : focus !== null ? [focus] : [];
    const picked = idx.map((i) => tracks[i]).filter((t): t is Track => !!t);
    if (!picked.length) return;
    remove.run(picked);
    // keep the keyboard where it was: next row takes the focus
    setFocus(Math.min(idx[0]!, tracks.length - picked.length - 1));
  };

  /** Moves these rows one step up or down (a scattered selection gathers around the first). */
  const step = (idx: number[], dir: -1 | 1) => {
    if (!move || !idx.length) return;
    const to = dir < 0 ? idx[0]! - 1 : idx[idx.length - 1]! + 2;
    if (to < 0 || to > tracks.length) return;
    keepSel.current = move(idx, to);
    virt.scrollToIndex(keepSel.current[0]!, { align: 'auto' });
  };
  const canStep = (idx: number[], dir: -1 | 1) => {
    if (!idx.length) return false;
    const contiguous = idx[idx.length - 1]! - idx[0]! === idx.length - 1;
    return dir < 0 ? idx[0]! > 0 || !contiguous : idx[idx.length - 1]! < tracks.length - 1 || !contiguous;
  };
  const current = () => (selected.size ? [...selected].sort((a, b) => a - b) : focus !== null ? [focus] : []);

  const key = (e: KeyboardEvent) => {
    const last = tracks.length - 1;
    if (move && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) step(current(), e.key === 'ArrowUp' ? -1 : 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const f = Math.max(0, Math.min(last, (focus ?? -1) + (e.key === 'ArrowDown' ? 1 : -1)));
      setFocus(f);
      if (e.shiftKey && anchor !== null) {
        const [a, b] = anchor < f ? [anchor, f] : [f, anchor];
        setSelected(new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)));
      } else {
        setSelected(new Set([f]));
        setAnchor(f);
      }
      virt.scrollToIndex(f, { align: 'auto' });
    } else if (e.key === 'Enter' && focus !== null) play(focus);
    else if (e.key === 'Delete') removeSelected();
    else if (e.key.toLowerCase() === 'a' && e.ctrlKey) setSelected(new Set(tracks.keys()));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // ── drop: reorder inside this playlist, or insert tracks from elsewhere ──
  const dropIndexFrom = (e: React.DragEvent) => {
    const top = bodyRef.current!.getBoundingClientRect().top;
    return Math.max(0, Math.min(tracks.length, Math.round((e.clientY - top) / ROW_H)));
  };
  const onDragOver = (e: React.DragEvent) => {
    if (move && dragging.current) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropAt(dropIndexFrom(e));
      return;
    }
    if (playlistId == null || !isTrackDrag(e)) return;
    e.preventDefault();
    const p = dragPayload();
    e.dataTransfer.dropEffect = p?.fromPlaylist?.id === playlistId ? 'move' : 'copy';
    setDropAt(dropIndexFrom(e));
  };
  const onDrop = (e: React.DragEvent) => {
    if (move && dragging.current) {
      e.preventDefault();
      const rows = dragging.current;
      dragging.current = null;
      setDropAt(null);
      endDrag();
      keepSel.current = move(rows, dropIndexFrom(e));
      return;
    }
    if (playlistId == null || !isTrackDrag(e)) return;
    e.preventDefault();
    const at = dropIndexFrom(e);
    setDropAt(null);
    const p = dragPayload();
    endDrag();
    if (!p) return;
    if (p.fromPlaylist?.id === playlistId) {
      const moving = new Set(p.fromPlaylist.entryIds);
      const all = tracks.map((t) => t.entryId!);
      const before = all.slice(0, at).filter((id) => !moving.has(id));
      const after = all.slice(at).filter((id) => !moving.has(id));
      const order = [...before, ...p.fromPlaylist.entryIds, ...after];
      if (order.join() !== all.join()) void window.chud.playlists.reorder(playlistId, order);
    } else {
      void usePlaylists.getState().addTracks(playlistId, p.tracks, at);
    }
  };

  const sortBy = (k?: SortKey) => {
    if (!k || !onSort) return;
    if (sort?.key !== k) onSort({ key: k, dir: k === 'added' || k === 'plays' ? -1 : 1 });
    else if (sort.dir === (k === 'added' || k === 'plays' ? -1 : 1)) onSort({ key: k, dir: (sort.dir * -1) as 1 | -1 });
    else onSort(null);
  };

  return (
    <div ref={rootRef} className="tl" role="grid" aria-rowcount={tracks.length} tabIndex={0} onKeyDown={key} style={{ ['--tl-cols' as string]: template }}>
      <div className="tl-head tl-row" role="row">
        {columns.map((c) => {
          const def = COL[c];
          const active = sort && def.sort === sort.key;
          return (
            <div key={c} role="columnheader" className={`tl-cell tl-${c}${def.sort && onSort ? ' sortable' : ''}${active ? ' sorted' : ''}`} onClick={() => sortBy(def.sort)}>
              {def.label}
              {active && (sort!.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
            </div>
          );
        })}
      </div>
      <div
        ref={bodyRef}
        className="tl-body"
        style={{ height: virt.getTotalSize() }}
        onDragOver={onDragOver}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(null)}
        onDrop={onDrop}
      >
        {dropAt !== null && <div className="tl-drop-line" style={{ transform: `translateY(${dropAt * ROW_H - 1}px)` }} />}
        {virt.getVirtualItems().map((v) => {
          const t = tracks[v.index]!;
          const i = v.index;
          const isCurrent = currentKey !== undefined && (t.entryId ?? t.id) === currentKey;
          // narrow window: the Format column is gone, so the reason a file cannot play goes under its title
          const problemInTitle = !t.available && !t.pending && !columns.includes('format');
          return (
            <div
              key={v.key}
              role="row"
              aria-selected={selected.has(i)}
              className={['tl-row', isCurrent && 'current', selected.has(i) && 'selected', focus === i && 'focused', !t.available && 'unavailable', t.pending && 'pending'].filter(Boolean).join(' ')}
              aria-busy={t.pending || undefined}
              style={{ transform: `translateY(${v.start - margin}px)` }}
              draggable
              onDragStart={(e) => {
                const idx = selection(i);
                if (!selected.has(i)) setSelected(new Set([i]));
                const picked = idx.map((k) => tracks[k]!);
                dragging.current = move ? idx : null;
                startDrag(e, {
                  tracks: picked,
                  ...(playlistId != null ? { fromPlaylist: { id: playlistId, entryIds: picked.map((x) => x.entryId!) } } : {}),
                });
              }}
              onDragEnd={() => {
                dragging.current = null;
                endDrag();
                setDropAt(null);
              }}
              onClick={(e) => click(e, i)}
              onDoubleClick={() => play(i)}
              onContextMenu={(e) => {
                const idx = selection(i);
                if (!selected.has(i)) {
                  setSelected(new Set([i]));
                  setAnchor(i);
                }
                const picked = idx.map((k) => tracks[k]!);
                showMenu(e, trackMenu(picked, {
                  play: () => (picked.length === 1 ? play(i) : playFrom(tabId, label, picked, 0)),
                  ...(playlistId != null ? { excludePlaylist: playlistId } : {}),
                  ...(remove ? { remove: { label: remove.label(picked.length), run: () => remove.run(picked) } } : {}),
                  ...(move ? { move: { up: canStep(idx, -1) ? () => step(idx, -1) : undefined, down: canStep(idx, 1) ? () => step(idx, 1) : undefined } } : {}),
                }));
              }}
            >
              {columns.map((c) => (
                <div key={c} className={`tl-cell tl-${c}`} role="gridcell">
                  {c === 'num' &&
                    (isCurrent ? (
                      <span className={`eq-bars${status !== 'playing' ? ' paused' : ''}`}><i /><i /><i /></span>
                    ) : (
                      <>
                        {reorderable && <GripVertical size={13} className="tl-grip" />}
                        <span className="tl-idx">{i + 1}</span>
                        <button className="tl-play icon-btn" aria-label={tr('common.playNamed', { name: t.title })} onClick={(e) => { e.stopPropagation(); play(i); }}>
                          <Play size={13} fill="currentColor" />
                        </button>
                      </>
                    ))}
                  {c === 'title' && (
                    <div className="t-main">
                      <div className="t-thumb">
                        {t.pending ? <LoaderCircle size={16} className="spin" aria-label={tr('common.loading')} /> : <CoverArt url={t.coverUrl} size={15} thumb={96} />}
                      </div>
                      <div className="t-text">
                        <span className="t-title">{t.title}</span>
                        {!columns.includes('artist') && !problemInTitle && (t.pending ? <span className="t-artist shimmer-text">{tr('common.loading')}</span> : <ArtistName track={t} className="t-artist" />)}
                        {problemInTitle && (
                          <span className="badge warn t-problem" title={t.problem}>
                            <CircleAlert size={11} /> {t.problem ?? tr('common.unavailable')}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {t.pending && c !== 'num' && c !== 'title' ? (
                    <span className="shimmer" />
                  ) : (
                    <>
                  {c === 'artist' && (t.artist ? <ArtistName track={t} /> : <span className="muted">{tr('common.unknownArtist')}</span>)}
                  {c === 'album' && <AlbumName track={t} fallback={<span className="muted">—</span>} />}
                  {c === 'added' && fmtDate(t.addedAt)}
                  {c === 'plays' && (t.playCount || '')}
                  {c === 'format' &&
                    (t.available ? (
                      codecLabel(t) && <span className={`badge${t.source === 'youtube' ? ' yt' : ''}`}>{codecLabel(t)}</span>
                    ) : (
                      <span className="badge warn" title={t.problem}>
                        <CircleAlert size={11} /> {t.problem ?? tr('common.unavailable')}
                      </span>
                    ))}
                  {c === 'duration' && fmtTime(t.durationSec)}
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
