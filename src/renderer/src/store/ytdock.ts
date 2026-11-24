import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { ytBarReserved, ytPlace, type YtPlace, type YtPlaceInput } from '@shared/yt-place';
import { isYtLive, usePlayer } from './player';
import { useSettings } from './settings';
import { useLayout } from './layout';

// Where the official YouTube player shows (≥ 200×200, never covered, never unmounted: a remount
// would restart the video). Normally in the sidebar's living cover. When it does not fit there —
// narrow window, the sidebar box showing the playlists, or not enough height (large interface
// size) — it docks into the player bar instead, in place of the small cover, and the bar grows
// to hold it. The webview stays where it is in the page; only its box is moved over the slot.
// Which place wins is decided by shared/yt-place.ts; this file gathers what it needs to know.

interface DockState {
  /** Enough height in the sidebar for the cover (measured by the sidebar). */
  roomInSidebar: boolean;
  /** Box of the slot in the player bar, when docked. */
  slot: { left: number; top: number; size: number } | null;
  /** Box of the stage of the video clip tab, while that tab is shown: the player goes there, big. */
  clip: { left: number; top: number; width: number; height: number } | null;
}

export const useYtDock = create<DockState>(() => ({ roomInSidebar: true, slot: null, clip: null }));

function usePlaceInput(): YtPlaceInput {
  const ytLive = usePlayer(isYtLive);
  const playlistsPanel = useSettings((s) => s.sidePanel === 'playlists');
  const { compact, drawer, mini } = useLayout();
  const roomInSidebar = useYtDock((s) => s.roomInSidebar);
  const clipOpen = useYtDock((s) => s.clip !== null);
  const slotKnown = useYtDock((s) => s.slot !== null);
  return { ytLive, compact, drawer, mini, roomInSidebar, playlistsPanel, clipOpen, slotKnown };
}

/** Where the player shows now. */
export function useYtPlace(): YtPlace {
  return ytPlace(usePlaceInput());
}

/** The player bar makes room for the player. */
export function useYtDocked(): boolean {
  return ytBarReserved(usePlaceInput());
}

/**
 * The player's box beside the open drawer (place 'beside': the drawer narrows to leave it
 * ≥ 200 px), measured again when the window or the drawer changes size; null in any other place.
 */
export function useBesideDrawerBox(): { left: number; top: number; size: number } | null {
  const beside = useYtPlace() === 'beside';
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!beside) return;
    const on = () => setTick((n) => n + 1);
    window.addEventListener('resize', on);
    // the drawer narrows after this render (class yt-beside): measure again once it has
    const id = requestAnimationFrame(on);
    return () => {
      window.removeEventListener('resize', on);
      cancelAnimationFrame(id);
    };
  }, [beside]);
  if (!beside) return null;
  const aside = document.querySelector<HTMLElement>('.sidebar.drawer');
  const left = (aside?.offsetWidth ?? 300) + 12;
  const top = 52;
  const size = Math.max(200, Math.min(320, window.innerWidth - left - 12, window.innerHeight - top - 20));
  return { left, top, size };
}
