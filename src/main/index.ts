import os from 'node:os';
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { join } from 'node:path';
import { AUDIO_EXTENSIONS } from '@shared/audio-formats';
import { DEFAULT_SETTINGS, RECENT_PLAYED, type ListenTick, type StatsPeriod, type LyricsQuery, type RadioStation, type AppInfo, type SavedPlayer, type SessionSnapshot, type Settings, type Track, type WantedTrack } from '@shared/types';
import type { MusicLink } from '@shared/links';
import { closeDatabase, getDb, kvGet, kvSet, openDatabase, tx, sql } from './db';
import * as library from './library';
import * as playlists from './playlists';
import { ensureTrackRow } from './tracks';
import { audioPathsFromArgv, expandPaths, LaunchQueue } from './launch-files';
import { probe, resolvePlayable } from './media';
import { cacheDir, userDataDir } from './paths';
import { handleProtocol, registerSchemePrivileges, setRadioTitleListener } from './protocol';
import * as youtube from './youtube';
import { initYouTubeSession, setYtQuality, ytBlocked, ytGuest } from './yt-player';
import { hiddenArtists, hideArtist, unhideArtist } from './yt-hidden';
import { adblockNeeded, adblockStatus, checkLists, initAdblock, setAdblockEnabled } from './adblock';
import { checkForUpdates, currentVersion, downloadUpdate, initUpdater, installUpdate, openReleases, setAutoCheck, updateStatus } from './updater';
import { checkFiles } from './tracks';
import { captureMainErrors, log, logsDir } from './log';
import { thumbarState, updateThumbar, type ThumbarState } from './thumbar';
import { mediaKeysStatus, registerMediaKeys, unregisterMediaKeys } from './mediakeys';
import { getLyrics } from './lyrics';
import * as radio from './radio';
import * as radioShift from './radio-shift';
import * as covers from './covers';
import { loudness, sampleRate } from './loudness';
import { reach } from './netpath';
import { loadPlayer, playerRest, playerTracks } from './player-snapshot';
import { getStats, getTrackStats, recordListening } from './stats';
import { session } from 'electron';
import { getLang, resolveLang, setLang, tr } from '@shared/i18n';

// A modest PC (few cores or little memory) starts with lighter effects; the user's own choice,
// once made in Settings, always wins. CHUD_LOW_END=1/0 forces it (tests).
const lowEnd = process.env.CHUD_LOW_END ? process.env.CHUD_LOW_END === '1' : os.cpus().length <= 4 || os.totalmem() < 6 * 1024 ** 3;
const currentSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...(lowEnd ? { effects: 'reduced' as const } : {}), ...(kvGet<Partial<Settings>>('settings') ?? {}) });

/** The interface language: the setting, else the system's (CHUD_LANG: tests and checks). */
function applyLanguage(): void {
  const pref = currentSettings().language;
  const system = process.env.CHUD_LANG ? [process.env.CHUD_LANG] : app.getPreferredSystemLanguages();
  setLang(resolveLang(pref, system));
}

app.setName('Chud Music');
// Automated tests run against an isolated profile so they never touch real user data.
if (process.env.CHUD_USER_DATA) app.setPath('userData', process.env.CHUD_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('app.chudmusic');
// Automated tests: never disturb the person using the computer. The window is fully
// transparent and click-through, without focus or taskbar entry, and every page (player, YouTube) is muted. The audio graph
// still runs, so the analyser, equaliser and visualiser can be checked.
const QUIET = !!process.env.CHUD_TEST_QUIET;
if (QUIET) app.on('web-contents-created', (_e, wc) => wc.setAudioMuted(true));
if (QUIET) {
  // a transparent window may count as occluded on Windows: keep it rendering like a visible one
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}
// HTML-in-canvas (drawElementImage) for the Canvas UI effects; without it they fall back to plain HTML.
app.commandLine.appendSwitch('enable-blink-features', 'CanvasDrawElement');

// One instance only: a second launch (e.g. double-clicking another file in Explorer)
// forwards its files to the running window instead of opening a new player.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  captureMainErrors();
  log('info', 'main', `Chud Music ${currentVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);
  const launch = new LaunchQueue();
  launch.push(audioPathsFromArgv(process.argv, process.cwd()));
  let win: BrowserWindow | null = null;

  registerSchemePrivileges();

  app.on('second-instance', (_e, argv, cwd) => {
    launch.push(audioPathsFromArgv(argv, cwd));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('window-all-closed', () => app.quit());
  // a radio recording in progress is written out before quitting; the cover search stops
  let flushed = false;
  app.on('before-quit', (e) => {
    if (flushed) return;
    e.preventDefault();
    flushed = true;
    covers.cancelFind();
    void radioShift.shutdown().finally(() => app.quit());
  });
  app.on('will-quit', () => {
    unregisterMediaKeys();
    playlists.shutdownPlaylists();
    library.shutdownLibrary();
    closeDatabase();
  });

  app.whenReady().then(() => {
    openDatabase();
    applyLanguage();
    // the interface asks for it synchronously, before any of its code runs
    ipcMain.on('i18n:lang', (e) => (e.returnValue = getLang()));
    handleProtocol();
    // never to a window being closed (sending to a destroyed page throws)
    const broadcast = (channel: string, payload?: unknown) => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    };
    library.initLibrary((channel, payload) => {
      broadcast(channel, payload);
      if (channel === 'library:changed') playlists.refreshSmart(library.getStatus().running ? 10_000 : undefined);
    });
    covers.initCovers(broadcast);
    playlists.initPlaylists((id) => broadcast('playlists:changed', id));
    registerIpc(launch, () => win);
    setRadioTitleListener((e) => broadcast('radio:title', e));
    // device labels for the audio output list (no microphone or camera is ever opened)
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'speaker-selection');
    win = createWindow();
    const settings = currentSettings();
    initAdblock(initYouTubeSession(win), settings.adblock, (s) => broadcast('adblock:status', s));
    initUpdater((s) => broadcast('updates:status', s), settings.autoUpdateCheck);
    win.on('closed', () => {
      launch.detach();
      win = null;
    });
  });
}

interface WindowState { width: number; height: number; x?: number; y?: number; maximized?: boolean }

function createWindow(): BrowserWindow {
  const saved = kvGet<WindowState>('window');
  const visible = saved?.x !== undefined && screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return saved.x! >= b.x - 50 && saved.y! >= b.y - 50 && saved.x! < b.x + b.width && saved.y! < b.y + b.height;
  });
  const win = new BrowserWindow({
    width: saved?.width ?? 1320,
    height: saved?.height ?? 840,
    ...(visible && !QUIET ? { x: saved!.x, y: saved!.y } : {}),
    ...(QUIET ? { skipTaskbar: true, focusable: true } : {}),
    // small enough for a portrait (9:16) screen with Windows scaling: the layout turns compact
    minWidth: 480,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: '#0b0a10',
    title: 'Chud Music',
    // Windows packaged: the exe's own icon. Dev and Linux: the PNG from the icon kit.
    ...(app.isPackaged && process.platform === 'win32'
      ? {}
      : { icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icons', process.platform === 'win32' ? 'icon.ico' : 'png/icon-256.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // keep the audio clock and queue advancing when minimised
      webviewTag: true, // only for the YouTube player page, enforced in yt-player.ts
    },
  });
  if (saved?.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!QUIET) return win.show();
    // invisible and click-through: rendered and testable, but the user never sees or hits it.
    // CHUD_TEST_SHOW keeps it visible (still muted, unfocused, click-through) for compositors
    // that stop drawing a transparent window, such as WSLg.
    if (!process.env.CHUD_TEST_SHOW) win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  });

  const persist = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? (kvGet<WindowState>('window') ?? win.getNormalBounds()) : win.getBounds();
    kvSet('window', { width: b.width, height: b.height, x: b.x, y: b.y, maximized });
  };
  win.on('resized', persist);
  win.on('moved', persist);
  win.on('maximize', () => { persist(); win.webContents.send('window:maximized', true); });
  win.on('unmaximize', () => { persist(); win.webContents.send('window:maximized', false); });

  // External links open in the user's browser, never inside the player.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Interface errors go to the log file (and the terminal in development).
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log('error', 'renderer', e.message);
    if (!app.isPackaged && (e.level === 'warning' || e.level === 'error')) console.log(`[renderer:${e.level}] ${e.message}`);
  });

  // If the interface process dies (GPU driver, out of memory…), reload it instead of leaving a
  // blank window. Playback state comes back from its saved snapshot. Gives up after 3 crashes
  // in a minute, so a crash loop cannot spin forever.
  const crashes: number[] = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    log('error', 'renderer', `interface process gone: ${details.reason} (exit code ${details.exitCode})`);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0]! > 60_000) crashes.shift();
    if (crashes.length > 3) {
      void dialog.showMessageBox(win, { type: 'error', title: 'Chud Music', message: tr('main.crashLoop'), detail: tr('main.crashDetail', { dir: logsDir() }) });
      return;
    }
    load(win, true);
  });
  app.on('child-process-gone', (_e, d) => d.reason !== 'clean-exit' && log('warn', 'main', `${d.type} process gone: ${d.reason}`));

  load(win, false);
  return win;
}

function load(win: BrowserWindow, recovered: boolean): void {
  const query = recovered ? { recovered: '1' } : undefined;
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL + (recovered ? '?recovered=1' : ''));
  else void win.loadFile(join(__dirname, '../renderer/index.html'), query ? { query } : undefined);
}

function registerIpc(launch: LaunchQueue, getWin: () => BrowserWindow | null): void {
  ipcMain.on('log:error', (_e, message: string) => log('error', 'renderer', String(message).slice(0, 4000)));
  let keysTaken = false;
  ipcMain.on('player:state', (_e, s: ThumbarState) => {
    const w = getWin();
    if (w) updateThumbar(w, s);
    // media keys: taken once Chud Music has played something (not before: other players keep
    // them while it is unused); never during automated tests unless they ask for it
    if (s.playing && !keysTaken && (!QUIET || process.env.CHUD_TEST_MEDIAKEYS)) {
      keysTaken = true;
      registerMediaKeys(getWin);
    }
  });
  ipcMain.handle('player:thumbar', () => thumbarState());
  ipcMain.handle('player:media-keys', () => mediaKeysStatus());
  ipcMain.on('stats:listen', (_e, t: ListenTick) => recordListening(t));
  ipcMain.handle('stats:get', (_e, p: StatsPeriod) => getStats(p));
  ipcMain.handle('stats:track', (_e, id: string, artist: string | null) => getTrackStats(String(id), typeof artist === 'string' ? artist : null));
  ipcMain.handle('radio:countries', () => radio.countries());
  ipcMain.handle('radio:stations', (_e, cc: string) => radio.stations(String(cc)));
  ipcMain.handle('radio:search', (_e, name: string) => radio.search(String(name)));
  ipcMain.handle('radio:favorites', () => radio.favorites());
  ipcMain.handle('radio:set-favorites', (_e, list: RadioStation[]) => radio.setFavorites(list));
  ipcMain.on('radio:played', (_e, id: string) => radio.countClick(String(id)));
  ipcMain.handle('radio:window', () => radioShift.radioWindow());
  ipcMain.handle('radio:stop', () => radioShift.stop());
  ipcMain.handle('radio:record', (_e, name: string, dir: string, from: number | null) => radioShift.startRecording(String(name), typeof dir === 'string' ? dir : '', typeof from === 'number' && Number.isFinite(from) ? from : null));
  ipcMain.handle('radio:record-stop', (_e, to: number | null) => radioShift.stopRecording(typeof to === 'number' && Number.isFinite(to) ? to : null));
  ipcMain.handle('radio:music-dir', () => app.getPath('music'));
  ipcMain.handle('lyrics:get', (_e, q: LyricsQuery, force?: boolean) => getLyrics(q, force));
  // the YouTube player plays in its own page: route it to the chosen device too
  ipcMain.handle('player:yt-sink', async (_e, sinkId: string) => {
    const frame = ytGuest()?.mainFrame.framesInSubtree.find((f) => /youtube(-nocookie)?\.com\/embed\//.test(f.url));
    if (!frame) return false;
    return frame.executeJavaScript(`(async () => { const v = document.querySelector('video'); if (!v || !v.setSinkId) return false; try { await v.setSinkId(${JSON.stringify(sinkId === 'default' ? '' : sinkId)}); return true; } catch { return false; } })()`).catch(() => false);
  });
  ipcMain.handle('player:yt-blocked', () => ytBlocked());
  ipcMain.handle('player:yt-quality', (_e, cap: unknown) => setYtQuality(cap === 'large' ? 'large' : null));
  ipcMain.on('log:open-folder', () => void shell.openPath(logsDir()));
  ipcMain.on('window:minimize', () => getWin()?.minimize());
  // Mini player: a small window (cover + controls). The normal bounds are kept to come back.
  let normal: Electron.Rectangle | null = null;
  let wasMaximized = false;
  ipcMain.handle('window:mini', (_e, on: boolean) => {
    const w = getWin();
    if (!w) return;
    if (on) {
      wasMaximized = w.isMaximized();
      if (wasMaximized) w.unmaximize();
      normal = w.getBounds();
      w.setMinimumSize(280, 400);
      const b = w.getBounds();
      w.setBounds({ x: b.x + b.width - 320, y: b.y, width: 320, height: 470 });
    } else {
      w.setAlwaysOnTop(false);
      w.setMinimumSize(480, 560);
      if (normal) w.setBounds(normal);
      if (wasMaximized) w.maximize();
    }
  });
  ipcMain.handle('window:on-top', (_e, on: boolean) => getWin()?.setAlwaysOnTop(on, 'floating'));
  ipcMain.on('window:toggle-maximize', () => {
    const w = getWin();
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.on('window:close', () => getWin()?.close());

  ipcMain.on('files:ready', (e) => {
    launch.attach((paths) => e.sender.send('files:open', paths));
  });
  ipcMain.handle('files:pick-folder', async () => {
    const w = getWin();
    const opts: Electron.OpenDialogOptions = { title: tr('main.pickFolder'), properties: ['openDirectory'] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('files:pick', async () => {
    const w = getWin();
    const opts: Electron.OpenDialogOptions = {
      title: tr('main.openAudio'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: tr('main.audioFiles'), extensions: [...AUDIO_EXTENSIONS] }, { name: tr('main.allFiles'), extensions: ['*'] }],
    };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('files:expand', (_e, paths: string[]) => expandPaths(paths));

  ipcMain.handle('media:probe', (_e, paths: string[]) => probe(paths));
  ipcMain.handle('media:resolve', (_e, path: string, codec: string | null, force: boolean) => resolvePlayable(path, codec, force));
  ipcMain.handle('media:reach', (_e, path: string) => reach(String(path)));
  ipcMain.handle('media:loudness', (_e, path: string) => loudness(String(path)));
  ipcMain.handle('media:sample-rate', (_e, path: string) => sampleRate(String(path)));
  ipcMain.handle('app:info', (): AppInfo => ({
    version: currentVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userData: userDataDir(),
    cache: cacheDir(),
  }));

  ipcMain.handle('settings:get', (): Settings => currentSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    kvSet('settings', { ...(kvGet<Partial<Settings>>('settings') ?? {}), ...patch });
    if (patch.adblock !== undefined) setAdblockEnabled(patch.adblock);
    if (patch.autoUpdateCheck !== undefined) setAutoCheck(patch.autoUpdateCheck);
    if (patch.language !== undefined) applyLanguage();
  });
  // a new language: the interface reloads (its texts are read once); playback is restored, paused
  ipcMain.on('window:reload', (e) => e.sender.reload());

  // YouTube Music catalogue (metadata only) and the player's ad blocker
  ipcMain.handle('yt:search', (_e, q: string, type: 'song' | 'album' | 'artist') => youtube.search(q, type));
  ipcMain.handle('yt:more', (_e, token: string) => youtube.more(token));
  ipcMain.handle('yt:suggest', (_e, q: string) => youtube.suggest(q));
  ipcMain.handle('yt:album', (_e, id: string) => youtube.album(id));
  ipcMain.handle('yt:artist', (_e, id: string) => youtube.artist(id));
  ipcMain.handle('yt:mix', (_e, videoId: string) => youtube.mix(videoId));
  ipcMain.handle('yt:link', (_e, link: MusicLink) => youtube.link(link));
  ipcMain.handle('yt:match', (_e, track: WantedTrack) => youtube.match(track));
  ipcMain.handle('yt:find-artist', (_e, name: string) => youtube.findArtist(name));
  ipcMain.handle('yt:music-video', (_e, track: WantedTrack) => youtube.musicVideo(track));
  ipcMain.handle('yt:hidden-artists', () => hiddenArtists());
  ipcMain.handle('yt:hide-artist', (_e, a: { id: string | null; name: string }) => hideArtist(a ?? { id: null, name: '' }));
  ipcMain.handle('yt:unhide-artist', (_e, a: { id: string | null; name: string }) => unhideArtist(a ?? { id: null, name: '' }));
  ipcMain.on('yt:open-external', (_e, videoId: string) => {
    if (/^[\w-]{6,20}$/.test(videoId)) void shell.openExternal(`https://music.youtube.com/watch?v=${videoId}`);
  });
  ipcMain.handle('adblock:status', () => adblockStatus());
  ipcMain.handle('adblock:check', () => checkLists());
  ipcMain.on('adblock:warm', () => adblockNeeded());
  ipcMain.handle('updates:status', () => updateStatus());
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', () => downloadUpdate());
  ipcMain.on('updates:install', () => installUpdate());
  ipcMain.on('updates:open-releases', () => openReleases());

  ipcMain.handle('session:load', () => kvGet<SessionSnapshot>('session'));
  ipcMain.handle('session:save', (_e, s: SessionSnapshot) => kvSet('session', s));

  // Library
  ipcMain.handle('library:folders', () => library.folders());
  ipcMain.handle('library:add-folder', async (_e, path?: string) => {
    let p = path;
    if (!p) {
      const w = getWin();
      const opts: Electron.OpenDialogOptions = { title: tr('main.addLibraryFolder'), properties: ['openDirectory'] };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return null;
      p = r.filePaths[0];
    }
    library.addFolder(p);
    return p;
  });
  ipcMain.handle('library:remove-folder', (_e, path: string) => library.removeFolder(path));
  ipcMain.handle('library:folder-scan', (_e, path: string, on: boolean) => library.setFolderScan(String(path), on === true));
  ipcMain.handle('library:rescan', () => library.scanNow());
  ipcMain.handle('covers:find', () => covers.findMissing());
  ipcMain.handle('covers:cancel', () => covers.cancelFind());
  ipcMain.handle('covers:remove', () => covers.removeFound());
  ipcMain.handle('covers:remove-for', (_e, ids: string[]) => covers.removeFoundFor(Array.isArray(ids) ? ids.filter((i) => typeof i === 'string') : []));
  ipcMain.handle('covers:status', () => covers.coverStatus());
  ipcMain.handle('library:remove-tracks', (_e, ids: string[]) => library.removeTracks(ids));
  ipcMain.handle('library:restore-tracks', (_e, ids: string[]) => library.restoreTracks(ids));
  ipcMain.handle('library:restore-all', () => library.restoreAll());
  ipcMain.handle('library:clear', () => library.clearLibrary());
  ipcMain.handle('library:excluded-count', () => library.excludedCount());
  ipcMain.handle('library:tracks', () => library.libraryTracks());
  ipcMain.handle('library:page', (_e, after: number) => library.tracksPage(Number(after) || 0));
  ipcMain.handle('library:changes', () => library.changes());
  ipcMain.handle('library:status', () => library.getStatus());
  ipcMain.handle('library:recently-played', (_e, limit: number) => checkFiles(library.recentlyPlayed(Math.min(RECENT_PLAYED, Number(limit) || RECENT_PLAYED))));
  ipcMain.handle('library:hide-recent', (_e, list: 'played' | 'added', ids: string[]) => library.hideRecent(list === 'added' ? 'added' : 'played', ids));
  ipcMain.handle('library:clear-recent', () => library.clearRecentlyPlayed());
  ipcMain.handle('library:hidden-added', () => library.hiddenAdded());

  // Playlists
  ipcMain.handle('playlists:list', () => playlists.list());
  ipcMain.handle('playlists:get', async (_e, id: number) => {
    const d = playlists.get(id);
    return d && { ...d, tracks: await checkFiles(d.tracks) };
  });
  ipcMain.handle('playlists:create', (_e, name: string, tracks?: Track[]) => playlists.create(name, tracks));
  ipcMain.handle('playlists:rename', (_e, id: number, name: string) => playlists.rename(id, name));
  ipcMain.handle('playlists:set-cover', async (_e, id: number, path?: string) => {
    // a path from the page itself only in the tests' isolated profile: otherwise the picture is
    // always one the person chose in the dialog (the page cannot have any file of the disk copied)
    let p = process.env.CHUD_USER_DATA ? path : undefined;
    if (!p) {
      const w = getWin();
      const opts: Electron.OpenDialogOptions = { title: tr('main.pickImage'), properties: ['openFile'], filters: [{ name: tr('main.images'), extensions: [...playlists.COVER_EXTENSIONS] }] };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return false;
      p = r.filePaths[0];
    }
    await playlists.setCover(id, p);
    return true;
  });
  ipcMain.handle('playlists:clear-cover', (_e, id: number) => playlists.clearCover(id));
  ipcMain.handle('playlists:create-smart', (_e, name: string, spec: unknown) => playlists.createSmart(String(name), spec));
  ipcMain.handle('playlists:set-smart', (_e, id: number, spec: unknown) => playlists.setSmart(id, spec));
  ipcMain.handle('playlists:preview-smart', (_e, spec: unknown) => playlists.previewSmart(spec));
  ipcMain.handle('playlists:remove', (_e, id: number) => playlists.remove(id));
  ipcMain.handle('playlists:remove-all', () => playlists.removeAll());
  ipcMain.handle('playlists:add-tracks', (_e, id: number, tracks: Track[], index?: number) => playlists.addTracks(id, tracks, index));
  ipcMain.handle('playlists:remove-entries', (_e, id: number, entryIds: number[]) => playlists.removeEntries(id, entryIds));
  ipcMain.handle('playlists:reorder', (_e, id: number, entryIds: number[]) => playlists.reorder(id, entryIds));
  ipcMain.handle('playlists:local-swaps', (_e, id: number) => playlists.localSwaps(id));
  ipcMain.handle('playlists:apply-swaps', (_e, id: number, swaps: { entryId: number; trackId: string }[]) => playlists.applySwaps(id, Array.isArray(swaps) ? swaps : []));
  ipcMain.handle('playlists:export-one', async (_e, id: number) => {
    const p = playlists.list().find((x) => x.id === id);
    if (!p) return null;
    const w = getWin();
    const opts: Electron.SaveDialogOptions = {
      title: tr('main.exportPlaylist'),
      defaultPath: `${p.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u8`,
      filters: [{ name: 'Playlist M3U8', extensions: ['m3u8'] }, { name: tr('main.jsonAll'), extensions: ['json'] }],
    };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    if (/\.json$/i.test(r.filePath)) playlists.exportJson([id], r.filePath);
    else playlists.exportM3u(id, r.filePath);
    return r.filePath;
  });
  ipcMain.handle('playlists:export-all', async () => {
    const w = getWin();
    const opts: Electron.SaveDialogOptions = {
      title: tr('main.exportAll'),
      defaultPath: `chud-music-playlists-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Chud Music (JSON)', extensions: ['json'] }],
    };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    playlists.exportJson(playlists.list().map((p) => p.id), r.filePath);
    return r.filePath;
  });
  ipcMain.handle('playlists:import', async () => {
    const w = getWin();
    const opts: Electron.OpenDialogOptions = {
      title: tr('main.importPlaylists'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8', 'json'] }],
    };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    let n = 0;
    for (const file of r.canceled ? [] : r.filePaths) n += await playlists.importFile(file);
    return n;
  });

  // History: counted once a track has really been listened to (decided by the UI)
  ipcMain.handle('history:record', (_e, track: Track, context: string) => {
    tx(() => {
      const now = Date.now();
      const id = ensureTrackRow(track, now);
      sql('INSERT INTO play_history (track_id, played_at, context) VALUES (?, ?, ?)').run(id, now, context);
      sql('UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?').run(now, id);
    });
    playlists.refreshSmart();
  });

  // The queue (possibly thousands of tracks) is saved when it changes; the position, every few
  // seconds, apart from it.
  ipcMain.handle('player:load', () => {
    const s = kvGet<SavedPlayer>('player');
    const p = kvGet<{ pos: number; time: number }>('player.position');
    return s && loadPlayer(p ? { ...s, pos: p.pos, time: p.time } : s);
  });
  ipcMain.handle('player:rest', () => playerRest());
  ipcMain.handle('player:tracks', (_e, ids: string[]) => playerTracks(ids));
  ipcMain.handle('player:save', (_e, s: SavedPlayer | null) => {
    kvSet('player', s);
    kvSet('player.position', s ? { pos: s.pos, time: s.time } : null);
  });
  ipcMain.handle('player:save-position', (_e, pos: number, time: number) => {
    if (Number.isFinite(pos) && Number.isFinite(time)) kvSet('player.position', { pos, time });
  });

  ipcMain.on('shell:show-in-folder', (_e, path: string) => shell.showItemInFolder(path));
  ipcMain.on('shell:default-apps', () => {
    if (process.platform === 'win32') void shell.openExternal('ms-settings:defaultapps?registeredAppUser=Chud%20Music');
  });
}

