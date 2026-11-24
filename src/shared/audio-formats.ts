// Which files Chud Music accepts, and which codecs Chromium decodes without help.
// Verified by prototype P1 (Electron 45 / Chromium 156): see docs/ANALYSE-TECHNIQUE.md.

export const AUDIO_EXTENSIONS = [
  'mp3', 'flac', 'wav', 'aac', 'm4a', 'mp4', 'ogg', 'oga', 'opus', 'webm',
  'wma', 'aiff', 'aif', 'aifc', 'alac', 'wv', 'ape', 'ac3', 'mka', 'caf', 'dsf', 'tta',
] as const;

/** Codec names (as music-metadata reports them) that Chromium plays natively. */
const NATIVE_CODEC_PATTERNS = [/^MPEG 1 Layer 3/i, /^MPEG 2 Layer 3/i, /^FLAC/i, /^PCM/i, /^AAC/i, /MPEG-4\/AAC/i, /^Vorbis/i, /^Opus/i, /^non-PCM \(65534\)/i];

/** Containers that need FFmpeg whatever the codec. */
const FFMPEG_EXTENSIONS = new Set(['wma', 'aiff', 'aif', 'aifc', 'wv', 'ape', 'ac3', 'mka', 'caf', 'dsf', 'tta', 'alac']);

export function isAudioPath(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

export function needsTranscode(path: string, codec: string | null | undefined): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (FFMPEG_EXTENSIONS.has(ext)) return true;
  if (!codec) return false; // unknown: let Chromium try, the engine falls back on error
  return !NATIVE_CODEC_PATTERNS.some((re) => re.test(codec));
}
