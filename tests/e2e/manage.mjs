// Removing from the library (never from the disk), emptying it, adding Explorer files to a
// playlist, and the drop targets for files dragged in from Explorer.
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createSuite, gotoNav, launch, music, shots, sleep, tempDir, waitScanIdle, showPlaylists } from './harness.mjs';

const t = createSuite('manage');
const profile = tempDir('chud-manage-');
const lib = tempDir('chud-manage-lib-');
cpSync(music, join(lib, 'Albums'), { recursive: true });
const filesOnDisk = () => readdirSync(join(lib, 'Albums')).length;
const diskBefore = filesOnDisk();
let app, win;
const api = (fn, ...a) => win.evaluate(fn, ...a);
const rows = () => win.locator('.page .tl-body .tl-row');
const libCount = async () => (await api(() => window.chud.library.tracks())).length;

try {
  ({ app, win } = await launch(profile));
  await api((p) => window.chud.library.addFolder(p), join(lib, 'Albums'));
  await waitScanIdle(win);
  await gotoNav(win, 'Bibliothèque');
  const total = await libCount();
  t.check('library indexed', total === 6 && (await rows().count()) === 6, `${total}`);

  // ── Delete key: out of the library, file still on disk, undo brings it back
  await win.locator('.tl-row:has-text("Fractale")').locator('.t-title').click();
  await win.keyboard.press('Delete');
  await sleep(600);
  t.check('Delete removes the track from the library', (await rows().count()) === 5 && (await libCount()) === 5);
  t.check('the file stays on disk', existsSync(join(lib, 'Albums', 'Fractale.flac')) && filesOnDisk() === diskBefore);
  t.check('toast says the file stays and offers undo', (await win.locator('.toast:has-text("Le fichier reste sur le disque") button:has-text("Annuler")').count()) === 1);
  await win.screenshot({ path: join(shots, 'manage-01-removed.png') });
  await win.locator('.toast button:has-text("Annuler")').click();
  await sleep(1200);
  await waitScanIdle(win);
  t.check('undo brings it back', (await libCount()) === 6 && (await win.locator('.tl-row:has-text("Fractale")').count()) === 1);

  // ── context menu on a multi-selection
  await win.locator('.tl-row:has-text("Minuit Chrome")').locator('.t-title').click();
  await win.locator('.tl-row:has-text("Boulevard des Ondes")').locator('.t-title').click({ modifiers: ['Control'] });
  await win.locator('.tl-row:has-text("Boulevard des Ondes")').click({ button: 'right' });
  const item = win.locator('.menu-item:has-text("Retirer 2 morceaux de la bibliothèque")');
  t.check('context menu offers removal of the selection', (await item.count()) === 1);
  await sleep(300); // let the menu finish fading in
  await win.screenshot({ path: join(shots, 'manage-02-menu.png') });
  await item.click();
  await sleep(600);
  t.check('both removed', (await libCount()) === 4);

  // ── removed files stay out after a rescan and after a restart
  await api(() => window.chud.library.rescan());
  await waitScanIdle(win);
  t.check('a rescan does not bring them back', (await libCount()) === 4);
  await app.close();
  ({ app, win } = await launch(profile));
  await waitScanIdle(win);
  t.check('still removed after a restart', (await libCount()) === 4);

  // ── "…" menu: restore all, then empty the library
  await gotoNav(win, 'Bibliothèque');
  await win.locator('.lib-actions button[aria-label="Plus d’actions"]').click();
  t.check('library menu offers to restore the removed tracks', (await win.locator('.menu-item:has-text("Rétablir 2 morceaux retirés")').count()) === 1);
  await win.screenshot({ path: join(shots, 'manage-03-library-menu.png') });
  await win.locator('.menu-item:has-text("Rétablir")').click();
  await sleep(800);
  await waitScanIdle(win);
  t.check('restore all', (await libCount()) === 6);

  // a playlist holding a library track, to check emptying the library keeps it
  const plId = await api(async () => {
    const tracks = await window.chud.library.tracks();
    return window.chud.playlists.create('Gardée', tracks.slice(0, 2));
  });
  await win.locator('.lib-actions button[aria-label="Plus d’actions"]').click();
  await win.locator('.menu-item:has-text("Vider la bibliothèque")').click();
  await sleep(300);
  t.check('emptying asks for confirmation and says files stay', /Aucun fichier n’est supprimé du disque/.test(await win.locator('.dialog').innerText()));
  await win.screenshot({ path: join(shots, 'manage-04-clear-confirm.png') });
  await win.locator('.dialog button[type=submit]').click();
  await sleep(1000);
  t.check('library emptied, folders no longer followed', (await libCount()) === 0 && (await api(() => window.chud.library.folders())).length === 0);
  t.check('empty state shown', (await win.locator('.page .empty h3:has-text("Ajoutez vos dossiers")').count()) === 1);
  t.check('no file deleted from disk', filesOnDisk() === diskBefore);
  const kept = await api((id) => window.chud.playlists.get(id), plId);
  t.check('playlists keep their tracks', kept.tracks.length === 2 && kept.tracks.every((x) => x.available));

  // ── playlist "…" → "Ajouter des fichiers…" (the Windows dialog is stubbed)
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, [join(music, 'Media Classique.wma'), join(music, 'Verre Bleu (ALAC).m4a')]);
  await showPlaylists(win);
  await win.locator('.side-item:has-text("Gardée")').click();
  await sleep(500);
  await win.locator('.list-hero-actions button[aria-label="Plus d’actions"]').click();
  t.check('playlist menu offers "Ajouter des fichiers…"', (await win.locator('.menu-item:has-text("Ajouter des fichiers")').count()) === 1);
  await win.screenshot({ path: join(shots, 'manage-05-playlist-menu.png') });
  await win.locator('.menu-item:has-text("Ajouter des fichiers")').click();
  await sleep(1200);
  const after = await api((id) => window.chud.playlists.get(id), plId);
  t.check('files from Explorer added at the end of the playlist', after.tracks.length === 4 && after.tracks[2].title === 'Média Classique' && after.tracks[3].title === 'Verre Bleu', after.tracks.map((x) => x.title).join(', '));
  t.check('the library is not touched by it', (await libCount()) === 0);

  // ── files dragged from Explorer: the target follows the pointer
  const dragFiles = (selector, type) =>
    win.evaluate(([sel, ty]) => {
      const el = document.querySelector(sel);
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'son.mp3', { type: 'audio/mpeg' }));
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent(ty, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 5, clientY: r.y + 5 }));
    }, [selector, type]);
  await dragFiles('.page-host .page', 'dragenter');
  await dragFiles('.page-host .page', 'dragover');
  await sleep(300);
  t.check('over an open playlist: "Ajouter à « Gardée »"', (await win.locator('.drop-overlay h2').innerText()) === 'Ajouter à « Gardée »');
  await win.screenshot({ path: join(shots, 'manage-06-drop-playlist.png') });
  await win.locator('.tab:has-text("Accueil")').click({ force: true }).catch(() => {});
  await sleep(450);
  await dragFiles('.page-host .page', 'dragover');
  await sleep(200);
  t.check('elsewhere: goes to "Fichiers ouverts"', (await win.locator('.drop-overlay h2').innerText()) === 'Déposez pour écouter');
  await dragFiles(`.tab[data-drop-playlist="${plId}"]`, 'dragover');
  await sleep(200);
  t.check('over the playlist tab: highlighted, added to it', (await win.locator('.drop-overlay h2').innerText()) === 'Ajouter à « Gardée »' && (await win.locator(`.tab.drop-target[data-drop-playlist="${plId}"]`).count()) === 1);
  await dragFiles(`.side-item[data-drop-playlist="${plId}"]`, 'dragover');
  await sleep(200);
  t.check('over the sidebar entry too', (await win.locator(`.side-item.drop-target[data-drop-playlist="${plId}"]`).count()) === 1);
  await win.screenshot({ path: join(shots, 'manage-07-drop-tab.png') });
  await dragFiles('.page-host', 'drop');
  await sleep(300);
  t.check('overlay gone after the drop', (await win.locator('.drop-overlay').count()) === 0);

  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
  await win?.screenshot({ path: join(shots, 'manage-failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  cleanup(profile, lib);
  process.exit(t.finish() ? 1 : 0);
}
