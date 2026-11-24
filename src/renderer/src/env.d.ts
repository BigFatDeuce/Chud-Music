/// <reference types="vite/client" />

declare module 'butterchurn' {
  export interface Visualizer {
    connectAudio(node: AudioNode): void;
    disconnectAudio(node: AudioNode): void;
    loadPreset(preset: object, blendTime?: number): Promise<void>;
    setRendererSize(width: number, height: number, opts?: { pixelRatio?: number; textureRatio?: number }): void;
    render(opts?: object): void;
    launchSongTitleAnim(text: string): void;
    loseGLContext(): void;
  }
  const butterchurn: {
    createVisualizer(ctx: AudioContext, canvas: HTMLCanvasElement, opts: { width: number; height: number; pixelRatio?: number; textureRatio?: number; onlyUseWASM?: boolean }): Visualizer;
  };
  export default butterchurn;
}
declare module 'butterchurn/dist/isSupported.min.js' {
  const isSupported: () => boolean;
  export default isSupported;
}
declare module 'butterchurn-presets/dist/base.min.js';
declare module 'butterchurn-presets/dist/extra.min.js';

// Electron's <webview> (used only for the YouTube player page, see main/yt-player.ts)
declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { src?: string; partition?: string };
    }
  }
}
