import type { Track } from '@shared/types';
import { tr } from '@shared/i18n';

// Internal drag & drop of tracks (rows → playlist, sidebar, queue). The payload stays in
// memory: dataTransfer only carries a marker type, so OS file drops are never confused with it.

export const DRAG_TYPE = 'application/x-chud-tracks';

export interface DragPayload {
  tracks: Track[];
  /** Set when dragging entries out of a saved playlist (enables reordering). */
  fromPlaylist?: { id: number; entryIds: number[] };
  /** Set when dragging items of the up-next queue. */
  fromQueue?: number[];
  /** Set when dragging entries of what remains of the list playing (positions in its order). */
  fromContext?: number[];
}

let current: DragPayload | null = null;

export function startDrag(e: React.DragEvent, payload: DragPayload): void {
  current = payload;
  e.dataTransfer.setData(DRAG_TYPE, String(payload.tracks.length));
  e.dataTransfer.effectAllowed = 'copyMove';
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = payload.tracks.length === 1 ? payload.tracks[0]!.title : tr('n.tracks', { n: payload.tracks.length });
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 16, 16);
  setTimeout(() => ghost.remove(), 0);
}

export const isTrackDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
export const dragPayload = () => current;
export function endDrag(): void {
  current = null;
}
