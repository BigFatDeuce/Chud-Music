import type { ReactNode } from 'react';
import type { Track } from '@shared/types';
import { useSettings } from '@/store/settings';
import { useYouTube } from '@/store/youtube';
import { inLibrary, openInLibrary } from '@/store/libview';
import { tr } from '@shared/i18n';

// Artist and album names as links:
//  • a YouTube Music track: to their YouTube Music pages in the app (Settings › YouTube Music ›
//    "Artistes et albums cliquables", on by default; off: plain text);
//  • a local file of the library: to the Library, filtered on that artist or album (always);
//  • radios, files outside the library: plain text.

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function YtLink({ onOpen, title, className, children }: { onOpen: () => void; title: string; className?: string; children: ReactNode }) {
  // a span, not a <button>: it stays inline text, so a long name ends with "…" in its cell
  return (
    <span
      role="link"
      tabIndex={0}
      className={`yt-meta-link${className ? ` ${className}` : ''}`}
      title={title}
      // inside a list row: open the page without selecting or playing the row
      onMouseDown={stop}
      onDoubleClick={stop}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.stopPropagation();
        onOpen();
      }}
    >
      {children}
    </span>
  );
}

export function useYtLinks(): boolean {
  return useSettings((s) => s.ytLinks);
}

export function ArtistName({ track, className, fallback }: { track: Track; className?: string; fallback?: ReactNode }) {
  const on = useYtLinks();
  const name = track.artist ?? fallback ?? tr('common.unknownArtist');
  if (track.source === 'local' && track.artist && inLibrary(track))
    return (
      <YtLink className={className} title={tr('common.openArtistLib')} onOpen={() => openInLibrary('artist', track)}>
        {name}
      </YtLink>
    );
  if (!on || track.source !== 'youtube' || !track.ytArtistId || !track.artist) return <span className={className}>{name}</span>;
  return (
    <YtLink className={className} title={tr('common.openArtist')} onOpen={() => useYouTube.getState().openArtist(track.ytArtistId!)}>
      {name}
    </YtLink>
  );
}

export function AlbumName({ track, className, fallback }: { track: Track; className?: string; fallback?: ReactNode }) {
  const on = useYtLinks();
  if (!track.album) return <>{fallback ?? null}</>;
  if (track.source === 'local' && inLibrary(track))
    return (
      <YtLink className={className} title={tr('common.openAlbumLib')} onOpen={() => openInLibrary('album', track)}>
        {track.album}
      </YtLink>
    );
  if (!on || track.source !== 'youtube' || !track.ytAlbumId) return <span className={className}>{track.album}</span>;
  return (
    <YtLink className={className} title={tr('common.openAlbum')} onOpen={() => useYouTube.getState().openAlbum(track.ytAlbumId!)}>
      {track.album}
    </YtLink>
  );
}

/** "Artist — Album" (the player bar). */
export function ArtistAlbum({ track }: { track: Track }) {
  if (!track.artist && !track.album) return <>{tr('common.unknownArtist')}</>;
  return (
    <>
      {track.artist && <ArtistName track={track} />}
      {track.artist && track.album && ' — '}
      {track.album && <AlbumName track={track} />}
    </>
  );
}
