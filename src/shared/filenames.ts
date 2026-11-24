// Shared by the main process (metadata) and the interface (placeholder rows shown while a file
// is still being read): the same guess and the same id on both sides.

const stemOf = (path: string) => {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

/** "Artist - Title.mp3" → { artist, title } when tags are missing. */
export function guessFromFilename(path: string): { title: string; artist: string | null } {
  const stem = stemOf(path);
  const m = /^(?:\d{1,3}[\s.\-_]+)?(.+?)\s+[-–]\s+(.+)$/.exec(stem);
  // "01 - Title": a leading number is the track number, not an artist
  if (m && !/^\d{1,3}$/.test(m[1]!.trim())) return { artist: m[1]!.trim(), title: m[2]!.trim() };
  return { title: stem.replace(/^\d{1,3}[\s.\-_]+/, ''), artist: null };
}

/** Track id of an absolute path; case-insensitive on Windows, like its file system. */
export function localIdOf(absolutePath: string, platform: string): string {
  return `local:${platform === 'win32' ? absolutePath.toLowerCase() : absolutePath}`;
}
