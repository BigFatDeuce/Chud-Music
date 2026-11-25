// The Range header of chud-media://file and cover requests (src/shared/http-range.ts), without the
// app. RFC 9110 §14: one byte range is served (206); a range that cannot be met
// is refused (416); anything else (several ranges, reversed or broken ones, another unit) is
// ignored and the whole file is sent (200), as the RFC allows.
//   node tests/unit/http-range.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'chud-range-'));
const file = join(dir, 'http-range.mjs');
writeFileSync(file, stripTypeScriptTypes(readFileSync(new URL('../../src/shared/http-range.ts', import.meta.url), 'utf8')));
const { parseRange } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
let count = 0;
const check = (label, ok, detail = '') => {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
const is = (header, size, want) => {
  const got = parseRange(header, size);
  check(`${JSON.stringify(header)} on ${size} bytes → ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
};
const full = { kind: 'full' };
const none = { kind: 'unsatisfiable' };
const part = (start, end) => ({ kind: 'partial', start, end });

// served
is(null, 10, full);
is('', 10, full);
is('bytes=2-4', 10, part(2, 4));
is('bytes=0-', 10, part(0, 9));
is('bytes=5-', 10, part(5, 9));
is('bytes=2-99', 10, part(2, 9));
is('bytes=-3', 10, part(7, 9));
is('bytes=-30', 10, part(0, 9));
is('bytes=9-9', 10, part(9, 9));
is('Bytes=2-4', 10, part(2, 4));
is('bytes= 2-4', 10, part(2, 4));
// refused: nothing of the file is in the range
is('bytes=10-', 10, none);
is('bytes=20-30', 10, none);
is('bytes=-0', 10, none);
is('bytes=0-', 0, none);
is('bytes=-5', 0, none);
is('bytes=99999999999999999999-', 10, none);
// ignored: the whole file
is('bytes=8-2', 10, full); // reversed: an exception from createReadStream before
is('bytes=2-3,5-6', 10, full); // several ranges: only the first one was sent before, as if it were all
is('bytes=-', 10, full);
is('bytes=a-b', 10, full);
is('items=2-4', 10, full);
is('bytes=2-4x', 10, full);
is('xbytes=2-4', 10, full);
is('bytes=1.5-4', 10, full);
is(null, 0, full);
// whatever the header, a partial answer is always inside the file
let inside = true;
for (const h of ['bytes=0-0', 'bytes=-1', 'bytes=3-', 'bytes=0-99999999999999999999', 'bytes=9007199254740993-']) {
  for (const size of [1, 2, 10, 1000]) {
    const r = parseRange(h, size);
    if (r.kind === 'partial' && !(Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) && r.start >= 0 && r.start <= r.end && r.end < size)) inside = false;
  }
}
check('a partial answer is always inside the file', inside);

console.log(`\n[http-range] ${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
