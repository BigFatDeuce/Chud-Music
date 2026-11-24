import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { ListPlus, ListX, Trash2, X } from 'lucide-react';
import type { Track } from '@shared/types';
import { usePlayer } from '@/store/player';
import { dragPayload, endDrag, isTrackDrag, startDrag } from '@/lib/drag';
import { createPlaylistWith, addToPlaylistItems } from '@/lib/track-actions';
import { fmtTime } from '@/lib/format';
import { showMenu } from './ContextMenu';
import { CoverArt } from './CoverArt';
import { locale, tr } from '@shared/i18n';

export const useQueuePanel = create<{ open: boolean; toggle(): void }>((set, get) => ({
  open: false,
  toggle: () => set({ open: !get().open }),
}));

function Row({ t, onPlay, onRemove, children, selected, ...rest }: { t: Track; onPlay?: () => void; onRemove?: () => void; selected?: boolean; children?: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`q-row${t.available ? '' : ' unavailable'}${selected ? ' selected' : ''}`} onDoubleClick={onPlay} aria-selected={selected} {...rest}>
      <span className="q-thumb"><CoverArt url={t.coverUrl} size={14} thumb={96} /></span>
      <span className="q-text">
        <b>{t.title}</b>
        <span>{t.artist ?? tr('common.unknownArtist')}</span>
      </span>
      {children}
      <span className="q-dur">{fmtTime(t.durationSec)}</span>
      {onRemove && (
        <button
          className="icon-btn q-remove"
          aria-label={tr('queue.removeOne', { title: t.title })}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Rows of the list shown at first, and added by "show more" (the list may hold 100 000 tracks). */
const PAGE = 50;

/**
 * "Up next" (consumed before the list continues) and what remains of the list, both editable:
 * Ctrl/Shift select, Del removes, dragging reorders. Editing the rest of the list never edits the
 * playlist it comes from.
 */
export function QueuePanel() {
  const { open, toggle } = useQueuePanel();
  const { current, upNext, ctx, fromQueue, removeQueued, moveQueued, clearQueue, clearAll, playQueued, jumpTo, enqueue, removeFromContext, moveInContext } = usePlayer();
  const [dropAt, setDropAt] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  // the list moved on or changed: positions are not the same tracks any more
  useEffect(() => {
    setPicked((p) => (p.size ? new Set([...p].filter((k) => k.startsWith('q'))) : p));
  }, [ctx?.tabId, ctx?.pos, ctx?.order]);
  useEffect(() => setShown(PAGE), [ctx?.tabId, open]);

  const left = ctx ? ctx.order.length - ctx.pos - 1 : 0;
  const rest = ctx ? ctx.order.slice(ctx.pos + 1, ctx.pos + 1 + shown).map((i, k) => ({ track: ctx.tracks[i]!, pos: ctx.pos + 1 + k })) : [];
  // keys: q<key> in the queue, c<position> in the list
  const rows: { id: string; track: Track }[] = [...upNext.map((q) => ({ id: `q${q.key}`, track: q.track })), ...rest.map((r) => ({ id: `c${r.pos}`, track: r.track }))];
  const sel = rows.filter((r) => picked.has(r.id));

  const pick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor) {
      const a = rows.findIndex((r) => r.id === anchor);
      const b = rows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) return setPicked(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id)));
    }
    setAnchor(id);
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(picked);
      if (!next.delete(id)) next.add(id);
      return setPicked(next);
    }
    setPicked(new Set([id]));
  };
  const keysOf = (ids: string[]) => ids.filter((i) => i[0] === 'q').map((i) => Number(i.slice(1)));
  const posOf = (ids: string[]) => ids.filter((i) => i[0] === 'c').map((i) => Number(i.slice(1)));
  const remove = (ids: string[]) => {
    const keys = keysOf(ids);
    const pos = posOf(ids);
    if (keys.length) removeQueued(keys);
    if (pos.length) removeFromContext(pos);
    setPicked(new Set());
  };
  /** The rows an action on this row is about: the selection when the row is part of it. */
  const group = (id: string) => (picked.has(id) ? sel.map((r) => r.id) : [id]);

  const drag = (e: React.DragEvent, id: string) => {
    const ids = group(id);
    startDrag(e, { tracks: rows.filter((r) => ids.includes(r.id)).map((r) => r.track), fromQueue: keysOf(ids), fromContext: posOf(ids) });
  };
  const onDrop = (e: React.DragEvent, at: number) => {
    if (!isTrackDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropAt(null);
    const p = dragPayload();
    endDrag();
    if (!p) return;
    if (p.fromQueue?.length && !p.fromContext?.length) return moveQueued(p.fromQueue, at);
    // from the list, from elsewhere, or both: the new items go where they were dropped
    const keys = new Set(p.fromQueue ?? []);
    const before = usePlayer.getState().upNext;
    const outside = p.fromContext?.length ? p.tracks.slice(keys.size) : p.tracks;
    if (p.fromContext?.length) removeFromContext(p.fromContext);
    enqueue(outside);
    const added = usePlayer.getState().upNext.filter((q) => !before.includes(q)).map((q) => q.key);
    moveQueued([...keys, ...added], at);
  };
  const onDropList = (e: React.DragEvent, at: number) => {
    const p = dragPayload();
    if (!isTrackDrag(e) || !p?.fromContext?.length) return;
    e.preventDefault();
    e.stopPropagation();
    setDropAt(null);
    endDrag();
    moveInContext(p.fromContext, at);
  };
  const over = (e: React.DragEvent, id: string, ok: boolean) => {
    if (!isTrackDrag(e) || !ok) return;
    e.preventDefault();
    e.stopPropagation();
    setDropAt(id);
  };

  const saveAs = () => {
    const name = tr('queue.saveName', { date: new Date().toLocaleDateString(locale(), { day: 'numeric', month: 'long' }) });
    void createPlaylistWith(usePlayer.getState().queueTracks(), name);
  };
  const menu = (e: React.MouseEvent, id: string, play: () => void) => {
    const ids = group(id);
    const tracks = rows.filter((r) => ids.includes(r.id)).map((r) => r.track);
    showMenu(e, [
      ...(ids.length === 1 ? [{ label: tr('common.play'), onSelect: play, hint: tr('menu.doubleClick') }] : []),
      { label: tr('menu.addToPlaylist'), icon: <ListPlus size={15} />, submenu: addToPlaylistItems(tracks) },
      { separator: true },
      { label: tr('queue.remove', { n: ids.length }), icon: <X size={15} />, danger: true, hint: tr('key.del'), onSelect: () => remove(ids) },
    ]);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="queue panel"
          aria-label={tr('queue.title')}
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          tabIndex={-1}
          onKeyDown={(e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
              e.preventDefault();
              e.stopPropagation();
              remove(sel.map((r) => r.id));
            } else if (e.key === 'a' && (e.ctrlKey || e.metaKey) && rows.length) {
              e.preventDefault();
              e.stopPropagation();
              setPicked(new Set(rows.map((r) => r.id)));
            } else if (e.key === 'Escape' && sel.length) setPicked(new Set());
          }}
          onDragOver={(e) => isTrackDrag(e) && e.preventDefault()}
          onDrop={(e) => onDrop(e, upNext.length)}
          onDragEnd={() => setDropAt(null)}
        >
          <header className="queue-head">
            <h3>{tr('queue.title')}</h3>
            <span className="queue-tools">
              <button className="icon-btn" data-queue-save aria-label={tr('queue.saveAs')} title={tr('queue.saveAs')} disabled={!current && !rows.length} onClick={saveAs}><ListPlus size={16} /></button>
              <button className="icon-btn" data-queue-clear aria-label={tr('queue.clearAll')} title={tr('queue.clearAll')} disabled={!upNext.length && !left} onClick={clearAll}><ListX size={16} /></button>
              <button className="icon-btn" aria-label={tr('queue.close')} onClick={toggle}><X size={16} /></button>
            </span>
          </header>
          {sel.length > 1 && (
            <div className="queue-selection">
              <span>{tr('queue.selected', { n: sel.length })}</span>
              <button className="btn ghost small" data-queue-remove-selected onClick={() => remove(sel.map((r) => r.id))}><Trash2 size={13} /> {tr('queue.remove', { n: sel.length })}</button>
            </div>
          )}
          <div className="queue-body">
            {current && (
              <>
                <h4>{tr('queue.now')}{fromQueue ? tr('queue.fromQueue') : ctx ? ` · ${ctx.label}` : ''}</h4>
                <Row t={current}><span className="eq-bars"><i /><i /><i /></span></Row>
              </>
            )}
            <h4 className="queue-section">
              {tr('queue.upNext')} <small>{tr('queue.temporary')}</small>
              {upNext.length > 0 && (
                <button className="btn ghost" style={{ height: 24, padding: '0 8px', marginLeft: 'auto' }} onClick={clearQueue}>
                  <ListX size={13} /> {tr('queue.clear')}
                </button>
              )}
            </h4>
            {upNext.length === 0 && <p className="queue-empty">{tr('queue.empty')}</p>}
            {upNext.map((q, k) => {
              const id = `q${q.key}`;
              return (
                <div key={id} className="q-slot">
                  {dropAt === id && <div className="q-drop-line" />}
                  <Row
                    t={q.track}
                    data-q={id}
                    selected={picked.has(id)}
                    onClick={(e) => pick(e, id)}
                    draggable
                    onDragStart={(e) => drag(e, id)}
                    onDragEnd={endDrag}
                    onDragOver={(e) => over(e, id, true)}
                    onDrop={(e) => onDrop(e, k)}
                    onPlay={() => playQueued(q.key)}
                    onRemove={() => remove([id])}
                    onContextMenu={(e) => menu(e, id, () => playQueued(q.key))}
                  />
                </div>
              );
            })}
            {rest.length > 0 && (
              <>
                <h4 className="queue-section">{tr('queue.nextIn', { name: ctx!.label })}</h4>
                {rest.map((r) => {
                  const id = `c${r.pos}`;
                  return (
                    <div key={`${r.pos}-${r.track.id}`} className="q-slot">
                      {dropAt === id && <div className="q-drop-line" />}
                      <Row
                        t={r.track}
                        data-q={id}
                        selected={picked.has(id)}
                        onClick={(e) => pick(e, id)}
                        draggable
                        onDragStart={(e) => drag(e, id)}
                        onDragEnd={endDrag}
                        onDragOver={(e) => over(e, id, !!dragPayload()?.fromContext?.length)}
                        onDrop={(e) => onDropList(e, r.pos)}
                        onPlay={() => jumpTo(r.pos)}
                        onRemove={() => remove([id])}
                        onContextMenu={(e) => menu(e, id, () => jumpTo(r.pos))}
                      />
                    </div>
                  );
                })}
                {left > rest.length && (
                  <button className="btn ghost queue-more" onClick={() => setShown(shown + 200)}>{tr('queue.more', { n: left - rest.length })}</button>
                )}
              </>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
