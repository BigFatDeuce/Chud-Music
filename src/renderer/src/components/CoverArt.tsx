import { useState } from 'react';
import { Music2 } from 'lucide-react';

/** Small copy of a local cover, made once by the main process (other URLs are returned as is). */
export const thumbUrl = (url: string, px: number) => (url.startsWith('chud-media://cover/') ? `${url}?s=${px}` : url);

/**
 * Cover image with a graceful placeholder when there is no art or it fails to load.
 * `cors` requests it in CORS mode: needed when a canvas effect captures it (else the canvas is tainted).
 */
export function CoverArt({ url, size = 20, alt = '', cors = false, thumb }: { url: string | null | undefined; size?: number; alt?: string; cors?: boolean; thumb?: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (!url || broken === url) return <Music2 size={size} />;
  // `thumb`: a small copy made once by the main process for covers of local files (a grid of
  // full-size covers decodes hundreds of megabytes)
  const src = thumb ? thumbUrl(url, thumb) : url;
  return <img src={src} alt={alt} draggable={false} loading="lazy" decoding="async" crossOrigin={cors ? 'anonymous' : undefined} onError={() => setBroken(url)} />;
}
