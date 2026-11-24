import { usePlayer } from '@/store/player';
import { usePlaylists } from '@/store/playlists';
import { OPENED_TAB, useTabs } from '@/store/tabs';
import { toast, useToasts } from '@/store/toasts';
import { probeWithProgress, runTask } from '@/store/tasks';
import { tr } from '@shared/i18n';

// Entry points for files arriving from Explorer, drag & drop or the Open dialog.
//  • Into a playlist (dropped on its tab, or "Ajouter des fichiers…"): added to it, nothing else.
//  • Otherwise: they pile up in the single "Fichiers ouverts" tab (never a playlist). If nothing
//    is playing the first new file starts; otherwise the current playback is left alone and
//    the user is offered to play.

export type OpenOrigin = 'launch' | 'drop' | 'dialog';

const NO_AUDIO = { kind: 'error' as const, title: tr('open.noAudio'), body: tr('open.formats') };

/** The offer to play the new files, while it is shown: files arriving meanwhile join it (several
 *  double-clicks on a slow computer do not pile up as many offers). */
let offer: { id: number; n: number; first: number } | null = null;

export async function openPaths(raw: string[], origin: OpenOrigin): Promise<void> {
  // a dropped folder can hold thousands of files: say so while it is walked
  const paths = await runTask(tr('open.searching'), () => window.chud.files.expand(raw));
  if (!paths.length) {
    toast(NO_AUDIO);
    return;
  }
  const { first } = await useTabs.getState().openFiles(paths);
  const tab = useTabs.getState().tabs.find((t) => t.id === OPENED_TAB);
  if (!tab || tab.kind !== 'files' || !tab.tracks) return;

  const player = usePlayer.getState();
  const busy = player.status === 'playing' || player.status === 'loading';
  if (!busy) {
    player.playFrom(tab.id, tab.title, tab.tracks, first);
  } else {
    const { toasts, dismiss } = useToasts.getState();
    const shown = offer && toasts.some((t) => t.id === offer!.id) ? offer : null;
    if (shown) dismiss(shown.id);
    const n = paths.length + (shown?.n ?? 0);
    const start = shown ? Math.min(shown.first, first) : first;
    const id = toast({
      title: origin === 'launch' ? tr('open.received', { n }) : tr('open.added'),
      body: tr('open.addedBody', { n }),
      action: {
        label: tr('common.play'),
        run: () => {
          const t = useTabs.getState().tabs.find((x) => x.id === OPENED_TAB);
          if (t?.kind === 'files' && t.tracks) usePlayer.getState().playFrom(t.id, t.title, t.tracks, Math.min(start, t.tracks.length - 1));
        },
      },
    });
    offer = { id, n, first: start };
  }
}

export async function openFilesFromDialog(): Promise<void> {
  const paths = await window.chud.files.pick();
  if (paths.length) await openPaths(paths, 'dialog');
}

/** Files or folders from Explorer added at the end of a saved playlist. */
export async function addPathsToPlaylist(playlistId: number, raw: string[]): Promise<void> {
  const name = usePlaylists.getState().list.find((p) => p.id === playlistId)?.name ?? tr('common.playlist');
  await runTask(tr('open.addingTo', { name }), async (update) => {
    update({ label: tr('open.searching') });
    const paths = await window.chud.files.expand(raw);
    if (!paths.length) {
      toast(NO_AUDIO);
      return;
    }
    const tracks = (await probeWithProgress(paths, update, tr('open.addingToReading', { name }))).filter((t) => t.available);
    update({ label: tr('open.addingTo', { name }), total: null });
    await usePlaylists.getState().addTracks(playlistId, tracks);
  });
}

/** A whole folder (and its sub-folders) added to a playlist, with progress. */
export async function addFolderToPlaylistFromDialog(playlistId: number): Promise<void> {
  const dir = await window.chud.files.pickFolder();
  if (dir) await addPathsToPlaylist(playlistId, [dir]);
}

export async function addFilesToPlaylistFromDialog(playlistId: number): Promise<void> {
  const paths = await window.chud.files.pick();
  if (paths.length) await addPathsToPlaylist(playlistId, paths);
}
