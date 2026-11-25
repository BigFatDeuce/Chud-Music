// Pictures of the cache are written all at once (src/main/atomic-write.ts): a write cut short
// leaves no truncated file under the final name. A real process is killed in the middle of a
// large write; the same kill is done on a plain writeFile to show what happened before.
//   node tests/unit/atomic-write.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'chud-atomic-'));
const mod = join(dir, 'atomic-write.mjs');
writeFileSync(mod, stripTypeScriptTypes(readFileSync(new URL('../../src/main/atomic-write.ts', import.meta.url), 'utf8')));
const { writeFileAtomic, writeFileAtomicSync } = await import(pathToFileURL(mod).href);

let failed = 0;
let count = 0;
const check = (label, ok, detail = '') => {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a child writes 600 MB (synchronously, in 1 MB pieces so the kill can land in the middle) and is
// killed as soon as some of it is on disk
async function killMidWrite(kind, out) {
  const script = join(dir, `writer-${kind}.mjs`);
  writeFileSync(
    script,
    `import { openSync, writeSync, closeSync, renameSync } from 'node:fs';
const piece = Buffer.alloc(1 << 20, 7);
const target = ${JSON.stringify(out)};
const file = ${kind === 'plain' ? 'target' : 'target + ".killtest.part"'};
const fd = openSync(file, 'w');
for (let i = 0; i < 600; i++) writeSync(fd, piece);
closeSync(fd);
${kind === 'plain' ? '' : 'renameSync(file, target);'}`,
  );
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  const watch = kind === 'plain' ? out : `${out}.killtest.part`;
  for (let i = 0; i < 400; i++) {
    if (existsSync(watch) && statSync(watch).size > 4 << 20) break;
    await sleep(10);
  }
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
}

try {
  // what a cut write did before: a truncated file under the final name
  const before = join(dir, 'cover-before.jpg');
  await killMidWrite('plain', before);
  check('before: a plain write cut short leaves a truncated picture under its name', existsSync(before) && statSync(before).size < 600 << 20, existsSync(before) ? `${statSync(before).size} bytes` : 'absent');

  // the same kill, written the new way (the child does what writeFileAtomic does)
  const after = join(dir, 'cover-after.jpg');
  await killMidWrite('atomic', after);
  check('now: a write cut short leaves nothing under the final name', !existsSync(after));

  // the module itself
  const p = join(dir, 'pic.jpg');
  await writeFileAtomic(p, Buffer.from('abc'));
  check('async: the content is there, no temporary file left', readFileSync(p, 'utf8') === 'abc' && !readdirSync(dir).some((f) => f.startsWith('pic.jpg.') && f.endsWith('.part')));
  writeFileAtomicSync(p, 'def');
  check('sync: replaces the file, no temporary file left', readFileSync(p, 'utf8') === 'def' && !readdirSync(dir).some((f) => f.startsWith('pic.jpg.') && f.endsWith('.part')));
  // several writers of the same cover at the same moment (two scans): one whole file
  const same = join(dir, 'same.jpg');
  const data = Buffer.alloc(3 << 20, 9);
  await Promise.all(Array.from({ length: 8 }, () => writeFileAtomic(same, data)));
  check('eight writers at once: one whole file, nothing left over', statSync(same).size === data.length && readFileSync(same).equals(data) && !readdirSync(dir).some((f) => f.startsWith('same.jpg.')));
  // a folder that cannot be written: the error is told, nothing is left behind
  let threw = false;
  try {
    await writeFileAtomic(join(dir, 'missing', 'x.jpg'), 'x');
  } catch {
    threw = true;
  }
  check('an impossible write is reported', threw);
  // a truncated picture already under the name (left by a version before 1.4.1) must not hide a
  // write that failed (here: data that cannot be written)
  const broken = join(dir, 'broken.jpg');
  writeFileSync(broken, 'tru');
  let asyncThrew = false;
  let syncThrew = false;
  try {
    await writeFileAtomic(broken, { not: 'data' });
  } catch {
    asyncThrew = true;
  }
  try {
    writeFileAtomicSync(broken, { not: 'data' });
  } catch {
    syncThrew = true;
  }
  check('a failed write is reported even with an incomplete file already there', asyncThrew && syncThrew, `async ${asyncThrew}, sync ${syncThrew}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n[atomic-write] ${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
