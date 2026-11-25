// The Range header of chud-media:// requests (audio files, covers). Pure, without imports:
// tests/unit/http-range.mjs loads it as it is.
//
// RFC 9110 §14: a single byte range is served (206); a range nothing of the file is in is refused
// (416, Content-Range: bytes */size); anything else (several ranges, a reversed or broken range,
// another unit) is ignored and the whole file is sent (200), which the RFC allows. Chromium's media
// stack only ever asks for one range; other clients get an answer that is always correct.

export type RangeAnswer = { kind: 'full' } | { kind: 'unsatisfiable' } | { kind: 'partial'; start: number; end: number };

const FULL: RangeAnswer = { kind: 'full' };
const NONE: RangeAnswer = { kind: 'unsatisfiable' };

/** What to answer to this Range header for a file of `size` bytes. */
export function parseRange(header: string | null | undefined, size: number): RangeAnswer {
  if (!header) return FULL;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return FULL; // several ranges, another unit, broken syntax: ignored
  const [, first, last] = m;
  if (!first && !last) return FULL;
  // digits only, so a number that is not a safe integer is merely too large
  const num = (s: string) => {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : Number.POSITIVE_INFINITY;
  };
  if (!first) {
    // the last N bytes
    const n = num(last!);
    if (n === 0 || size <= 0) return NONE;
    return { kind: 'partial', start: Math.max(0, size - Math.min(n, size)), end: size - 1 };
  }
  const start = num(first);
  const end = last ? num(last) : Number.POSITIVE_INFINITY;
  if (end < start) return FULL; // a reversed range is invalid: ignored
  if (start >= size) return NONE;
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}
