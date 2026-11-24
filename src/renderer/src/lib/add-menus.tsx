import { FilePlus2, FolderPlus, ListMusic } from 'lucide-react';
import { showMenu, type MenuItem } from '@/components/ContextMenu';
import { useTabs } from '@/store/tabs';
import { addPathsToPlaylist, openPaths } from './open-files';
import { tr } from '@shared/i18n';

// Windows' dialog picks files or a folder, never both at once: every "add / open" button asks
// which, so a whole folder (sub-folders included) can be taken anywhere files can.

type At = { clientX: number; clientY: number; preventDefault(): void };

async function pickFiles(): Promise<string[]> {
  return window.chud.files.pick();
}
async function pickFolder(): Promise<string[]> {
  const dir = await window.chud.files.pickFolder();
  return dir ? [dir] : [];
}

function chooser(at: At, use: (paths: string[]) => Promise<void>, before: MenuItem[] = []): void {
  showMenu(at, [
    ...before,
    { label: tr('add.files'), icon: <FilePlus2 size={15} />, onSelect: () => void pickFiles().then((p) => (p.length ? use(p) : undefined)) },
    { label: tr('add.folder'), icon: <FolderPlus size={15} />, onSelect: () => void pickFolder().then((p) => (p.length ? use(p) : undefined)) },
  ]);
}

/** Open files or a whole folder into "Fichiers ouverts". */
export const openChooser = (at: At) => chooser(at, (p) => openPaths(p, 'dialog'));

/** The "+" of the tab strip (and Ctrl+O): the Playlists tab first, then files or a folder. */
export const tabAddChooser = (at: At) =>
  chooser(at, (p) => openPaths(p, 'dialog'), [
    { label: tr('section.playlists'), icon: <ListMusic size={15} />, onSelect: () => useTabs.getState().openSection('playlists') },
    { separator: true },
  ]);

/** Add files or a whole folder to a playlist. */
export const addToPlaylistChooser = (at: At, playlistId: number) => chooser(at, (p) => addPathsToPlaylist(playlistId, p));

/** Keyboard (Ctrl+O): the chooser opens under the "+" of the tab strip. */
export function openChooserFromKeyboard(): void {
  const r = document.querySelector('.tab-add')?.getBoundingClientRect();
  tabAddChooser({ clientX: r ? r.left : innerWidth / 2, clientY: r ? r.bottom + 4 : innerHeight / 3, preventDefault() {} });
}
