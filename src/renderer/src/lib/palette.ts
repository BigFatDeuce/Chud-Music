// Two dominant, reasonably saturated colours from a cover — fed to the ambient aura.

const cache = new Map<string, [string, string] | null>();

export async function coverPalette(url: string): Promise<[string, string] | null> {
  if (cache.has(url)) return cache.get(url)!;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  try {
    await img.decode();
  } catch {
    cache.set(url, null);
    return null;
  }
  const size = 32;
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, size, size);
  const data = g.getImageData(0, 0, size, size).data;

  const buckets = new Map<number, { r: number; g: number; b: number; n: number; score: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!, gg = data[i + 1]!, b = data[i + 2]!;
    const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = max / 255;
    if (lum < 0.12) continue;
    const key = ((r >> 5) << 6) | ((gg >> 5) << 3) | (b >> 5);
    const bk = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0, score: 0 };
    bk.r += r; bk.g += gg; bk.b += b; bk.n++;
    bk.score += 0.25 + sat * 1.5;
    buckets.set(key, bk);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.score - a.score);
  const pick = (bk?: { r: number; g: number; b: number; n: number }) =>
    bk ? `rgb(${Math.round(bk.r / bk.n)} ${Math.round(bk.g / bk.n)} ${Math.round(bk.b / bk.n)} / 0.55)` : null;
  const a = pick(ranked[0]);
  const b = pick(ranked.find((x, i) => i > 0 && Math.abs(x.r / x.n - ranked[0]!.r / ranked[0]!.n) + Math.abs(x.b / x.n - ranked[0]!.b / ranked[0]!.n) > 60) ?? ranked[1]);
  const result: [string, string] | null = a ? [a, b ?? a] : null;
  cache.set(url, result);
  return result;
}
