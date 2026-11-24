import { create } from 'zustand';

// Window width classes. Below COMPACT the sidebar becomes a drawer and the player bar takes two
// rows (portrait 9:16 screens, narrow windows, large interface sizes).

export const COMPACT = 960;
const query = window.matchMedia(`(max-width: ${COMPACT}px)`);

interface LayoutState {
  compact: boolean;
  drawer: boolean;
  /** Mini player: cover and controls only, in a small window. */
  mini: boolean;
  onTop: boolean;
  setDrawer(open: boolean): void;
  setMini(on: boolean): void;
  setOnTop(on: boolean): void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  compact: query.matches,
  drawer: false,
  mini: false,
  onTop: false,
  setDrawer: (drawer) => set({ drawer }),
  setMini: (mini) => {
    // the mini layout is its own thing: not the compact (narrow window) one
    set({ mini, drawer: false, compact: mini ? false : query.matches, onTop: mini ? get().onTop : false });
    void window.chud.window.mini(mini);
    if (mini && get().onTop) void window.chud.window.onTop(true);
  },
  setOnTop: (onTop) => {
    set({ onTop });
    void window.chud.window.onTop(onTop);
  },
}));

query.addEventListener('change', (e) => !useLayout.getState().mini && useLayout.setState({ compact: e.matches, drawer: false }));
