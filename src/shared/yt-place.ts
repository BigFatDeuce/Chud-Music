// Where the official YouTube player shows, decided in one place (no import: tested without the
// app by tests/unit/machines.mjs). The player is one element that is never recreated nor covered
// (a remount would restart the video); only its box moves:
//
//   cover   its own place, the sidebar's living cover (also when no YouTube track is live: the
//           player is then hidden behind the cover)
//   beside  narrow window, menu drawer open, no room under the menu: beside the narrowed drawer
//   clip    over the stage of the video clip tab, big
//   bar     in the player bar, in place of the small cover (narrow window, sidebar box showing
//           the playlists, or not enough height in the sidebar)
//
// Priority, first match wins: the open drawer, the clip tab, the bar, the cover.

export type YtPlace = 'cover' | 'beside' | 'clip' | 'bar';

export interface YtPlaceInput {
  /** A YouTube track is the current one and playback is not at rest. */
  ytLive: boolean;
  /** Narrow window: the sidebar is a drawer. */
  compact: boolean;
  /** That drawer is open. */
  drawer: boolean;
  mini: boolean;
  /** Enough height in the sidebar for a ≥ 200 px player (measured by the sidebar). */
  roomInSidebar: boolean;
  /** The sidebar box shows the playlists instead of the cover. */
  playlistsPanel: boolean;
  /** The stage of the video clip tab is on screen. */
  clipOpen: boolean;
  /** The player bar has reported the box of its slot. */
  slotKnown: boolean;
}

/** The player bar makes room for the player (it grows, the small cover leaves). */
export function ytBarReserved(i: YtPlaceInput): boolean {
  return i.ytLive && !i.mini && !i.clipOpen && (i.compact || i.playlistsPanel || !i.roomInSidebar);
}

export function ytPlace(i: YtPlaceInput): YtPlace {
  if (!i.ytLive) return 'cover';
  // the open drawer wins: the player must not be under it
  if (i.compact && i.drawer && !i.mini) return i.roomInSidebar ? 'cover' : 'beside';
  if (i.clipOpen) return 'clip';
  if (ytBarReserved(i) && i.slotKnown) return 'bar';
  return 'cover';
}

/** A quality name of the YouTube player ('large' is 480p). */
export type YtQuality = 'large';

/**
 * The best picture quality worth asking for in a place: the player is small everywhere but on
 * the stage of the clip tab (200–320 px), so 480p is plenty there and saves bandwidth; on the
 * stage (and full screen) YouTube chooses by itself (null).
 */
export function ytQualityCap(place: YtPlace): YtQuality | null {
  return place === 'clip' ? null : 'large';
}

// ── The video clip tab, full screen ─────────────────────────────────────────────────────────
//
// One thing is full screen, whatever plays: the app's root. The stage of the clip tab then fills
// the window, and the YouTube player (which is laid OVER the stage, never inside it) follows the
// stage as it does in the tab. So a YouTube video followed by a local file, or the reverse, stays
// full screen with the right picture — before, the stage or the player was made full screen
// depending on what played when the button was pressed, and the other one was left behind (a
// black screen, or a full screen that showed nothing and still wanted Esc).

export interface ClipFullInput {
  /** The document is full screen (any element). */
  fullscreen: boolean;
  /** …and it is the clip tab that asked for it (not the visualizer). */
  byClip: boolean;
  /** The clip tab is shown. */
  clipShown: boolean;
}

/** The stage fills the window. */
export function clipFull(i: ClipFullInput): boolean {
  return i.fullscreen && i.byClip && i.clipShown;
}

// ── The small spectrum of the player bar ────────────────────────────────────────────────────
//
//   off        nothing plays, effects are off, or no sound graph yet: drawn once, empty
//   analyser   a local file or a radio: the real audio graph
//   measured   YouTube: the levels measured inside the official player's page
//   simulated  YouTube, and no level came recently (the measure is refused or not started): the
//              bars move on their own, so the spectrum never looks broken while music plays

export type SpectrumFeed = 'off' | 'analyser' | 'measured' | 'simulated';

export interface SpectrumInput {
  playing: boolean;
  effectsOff: boolean;
  youtube: boolean;
  /** The local audio graph exists. */
  hasAnalyser: boolean;
  /** Levels from the YouTube player's page arrived in the last moments. */
  freshLevels: boolean;
}

export function spectrumFeed(i: SpectrumInput): SpectrumFeed {
  if (!i.playing || i.effectsOff) return 'off';
  if (i.youtube) return i.freshLevels ? 'measured' : 'simulated';
  return i.hasAnalyser ? 'analyser' : 'off';
}
