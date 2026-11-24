// Packaging. Windows: NSIS installer (in-app updates), portable exe, zip. Linux (built and tested
// on Fedora): AppImage (in-app updates), .deb, .rpm, .tar.gz. The other formats tell about a new
// version and open the releases page (updater.ts).
const { existsSync } = require('node:fs');

// Extensions offered to Windows. Formats Chromium cannot decode go through the bundled FFmpeg.
const AUDIO = ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'wv', 'ape', 'ac3', 'mka'];

// FFmpeg (LGPL, audio only, no external library) per platform, built by scripts/build-ffmpeg.sh
const ffmpegWin = existsSync('build/vendor/ffmpeg/ffmpeg.exe');
const ffmpegLinux = existsSync('build/vendor/ffmpeg-linux/ffmpeg');
const platform = process.argv.includes('--linux') ? 'linux' : 'win';
if ((platform === 'win' && !ffmpegWin) || (platform === 'linux' && !ffmpegLinux)) {
  console.warn('\n⚠  FFmpeg absent pour cette plateforme : le paquet ne l’embarquera pas (scripts/build-ffmpeg.sh, sous Fedora/WSL).\n');
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.chudmusic',
  productName: 'Chud Music',
  copyright: '© 2026 BigFatDeuce. GPL-3.0-or-later',
  directories: { output: 'dist', buildResources: 'build' },
  files: ['out/**', 'package.json'],
  // Worker threads cannot be loaded from inside the asar archive.
  asarUnpack: ['out/main/chunks/scan-worker-*.js', 'out/main/chunks/adblock-worker-*.js'],
  // App icon: generated from build/logo.svg, the single vector source (npm run make:icons).
  // The PNG is also shipped for the Linux window icon (Windows takes the exe's own icon).

  // Updates: GitHub releases of the public repo (installers only). electron-builder writes
  // app-update.yml into the app and latest.yml next to the installer: upload both with it.
  publish: [{ provider: 'github', owner: 'BigFatDeuce', repo: 'Chud-Music', releaseType: 'release' }],
  fileAssociations: AUDIO.map((ext) => ({
    ext,
    name: `ChudMusic.${ext}`, // ProgID, also referenced by build/installer.nsh
    description: `Fichier audio ${ext.toUpperCase()}`,
    role: 'Viewer',
  })),
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    // the zip (the installer and the portable exe have their own names below)
    artifactName: 'Chud-Music-${version}-win-x64.${ext}',
    extraResources: [...(ffmpegWin ? [{ from: 'build/vendor/ffmpeg', to: 'ffmpeg' }] : []), { from: 'build/thumbar', to: 'thumbar' }, { from: 'build/THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' }, { from: 'LICENSE', to: 'LICENSE.txt' }],
    icon: 'build/icons/icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // never touch %APPDATA%\Chud Music (playlists, settings): not on update, not on uninstall
    deleteAppDataOnUninstall: false,
    include: 'build/installer.nsh',
    installerIcon: 'build/icons/icon.ico',
    uninstallerIcon: 'build/icons/icon.ico',
    installerHeaderIcon: 'build/icons/icon.ico',
    artifactName: 'Chud-Music-Setup-${version}.${ext}',
    shortcutName: 'Chud Music',
    // installer and uninstaller in French
    installerLanguages: ['fr_FR'],
    language: '1036',
    multiLanguageInstaller: false,
  },
  portable: {
    artifactName: 'Chud-Music-${version}-Portable.exe',
    // "Extracting…" is shown while the portable exe unpacks itself
    unpackDirName: 'chud-music-portable',
  },
  linux: {
    target: ['AppImage', 'deb', 'rpm', 'tar.gz'].map((target) => ({ target, arch: ['x64'] })),
    syncDesktopName: true,
    // the window icon (Windows takes the exe's own) and FFmpeg
    extraResources: [...(ffmpegLinux ? [{ from: 'build/vendor/ffmpeg-linux', to: 'ffmpeg' }] : []), { from: 'build/icons/png/icon-256.png', to: 'icon.png' }, { from: 'build/THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' }, { from: 'LICENSE', to: 'LICENSE.txt' }],
    artifactName: 'Chud-Music-${version}-x86_64.${ext}',
    executableName: 'chud-music',
    synopsis: 'Lecteur musical moderne et rétro',
    description: 'Lecteur musical : bibliothèque, playlists, YouTube Music, radio, paroles, visualiseur MilkDrop, égaliseur.',
    maintainer: 'GigaChud <67258247+BigFatDeuce@users.noreply.github.com>',
    category: 'AudioVideo',
    icon: 'build/icons/png/icon-512.png',
    // GNOME and KDE app grids, desktop entry
    desktop: { entry: { Keywords: 'music;player;audio;radio;playlist;youtube;' } },
    mimeTypes: ['audio/mpeg', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4', 'audio/ogg', 'audio/opus', 'audio/x-ms-wma', 'audio/aiff', 'audio/x-aiff', 'audio/x-wavpack', 'audio/x-ape', 'audio/x-matroska'],
  },
  // .deb / .rpm: x86_64 file names like the AppImage, installed in /opt/Chud Music with
  // /usr/bin/chud-music; the user's data (~/.config/Chud Music) is never touched on removal
  deb: { artifactName: 'Chud-Music-${version}-amd64.${ext}', packageName: 'chud-music' },
  rpm: { artifactName: 'Chud-Music-${version}-x86_64.${ext}', packageName: 'chud-music' },
};
