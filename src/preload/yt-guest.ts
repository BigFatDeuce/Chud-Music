import { contextBridge, ipcRenderer } from 'electron';

// Preload of the YouTube player page (inside the <webview>): a two-way pipe to the host
// renderer, nothing else. The page never gets Node or the app API.
contextBridge.exposeInMainWorld('chudHost', {
  send: (msg: unknown) => ipcRenderer.sendToHost('yt', msg),
  onCommand: (cb: (cmd: unknown) => void) => {
    ipcRenderer.on('yt-cmd', (_e, cmd: unknown) => cb(cmd));
  },
});
