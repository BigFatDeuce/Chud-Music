// Copies the public source of Chud Music into a working copy of the public GitHub repository,
// then checks the exact set of files before anything is committed. It never commits or pushes.
//   node scripts/public-source.mjs <public repo working copy>
// Only what is listed in PUBLIC is copied; files of the public repo that are not listed here
// (README.md, images/, LICENSE…) are left alone. A path that disappeared from the project is
// removed from the copy. Patterns that must never be published are read from a file outside the
// public set (docs/public-deny.txt, one regular expression per line), so they are not published.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = process.argv[2] && resolve(process.argv[2]);
if (!dest || !existsSync(join(dest, '.git'))) throw new Error('usage: node scripts/public-source.mjs <public repo working copy>');

/** What is public: the app, its build and test tooling, the English release notes. */
const PUBLIC = [
  'src', 'scripts', 'tests/e2e', 'tests/unit', 'tests/fixtures/make-fixtures.sh',
  'build/icons', 'build/thumbar', 'build/installer.nsh', 'build/logo.svg', 'docs/release-notes',
  'package.json', 'package-lock.json', 'electron-builder.config.cjs', 'electron.vite.config.ts',
  'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'LICENSE',
];
/** Never public, even inside a public folder (more names in docs/public-deny.txt). */
const NEVER = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx|log)|node_modules|prototypes)(\/|$)/i;

const files = (p) => (statSync(join(root, p)).isDirectory() ? readdirSync(join(root, p), { recursive: true }).map((f) => join(p, String(f)).replace(/\\/g, '/')).filter((f) => statSync(join(root, f)).isFile()) : [p]);
const wanted = PUBLIC.flatMap(files).filter((f) => !NEVER.test(f));

for (const p of PUBLIC) rmSync(join(dest, p), { recursive: true, force: true });
for (const f of wanted) cpSync(join(root, f), join(dest, f));

// the exact set that would be committed
const git = (...a) => execFileSync('git', ['-C', dest, ...a], { encoding: 'utf8' });
git('add', '-A');
const staged = git('ls-files').split('\n').filter(Boolean);
const denyFile = join(root, 'docs/public-deny.txt');
if (!existsSync(denyFile)) throw new Error('docs/public-deny.txt is missing: nothing can be checked');
const deny = readFileSync(denyFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new RegExp(l, 'i'));
const bad = [];
for (const f of staged) {
  if (NEVER.test(f)) bad.push(`${f}: never public`);
  const text = readFileSync(join(dest, f)).toString('latin1');
  for (const re of deny) if (re.test(f) || re.test(text)) bad.push(`${f}: matches a denied pattern`);
}
console.log(`${staged.length} files in the public copy, ${git('diff', '--cached', '--name-only').split('\n').filter(Boolean).length} changed`);
if (bad.length) {
  git('reset', '-q');
  console.error(`NOT ready, nothing staged:\n${bad.join('\n')}`);
  process.exit(1);
}
console.log(`checked against ${deny.length} denied patterns: ready to commit (by hand, see docs/PUBLIER-UNE-VERSION.md)`);
console.log(relative(root, dest) || dest);
