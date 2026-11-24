// Writes build/THIRD-PARTY-NOTICES.txt: every third-party package shipped with Chud Music, with
// its version, licence and licence text. Shipped = the runtime dependencies (node_modules inside
// the package) and what Vite bundles into the interface, each with their own dependencies.
// Run before packaging (npm run dist:* does it).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;

// bundled into the interface by Vite (devDependencies only because nothing loads them at runtime)
const BUNDLED = ['react', 'react-dom', 'motion', 'lucide-react', 'zustand', '@tanstack/react-virtual', '@fontsource-variable/inter', '@fontsource-variable/space-grotesk', '@fontsource/vt323'];
const TYPES_ONLY = (n) => n.startsWith('@types/');

/** node's lookup: nested node_modules first, then each parent up to the top. */
function locate(from, name) {
  let dir = from;
  for (;;) {
    const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (lock[key]) return key;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i < 0 ? '' : dir.slice(0, i);
  }
}

// packages published without a licence file: the standard text of the licence they declare
const MIT = (who) => `MIT License

Copyright (c) ${who ?? 'the authors'}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const BSD3_PROTOBUF = `BSD 3-Clause License (Protocol Buffers)

Copyright 2008 Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice, this list of
conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice, this list of
conditions and the following disclaimer in the documentation and/or other materials provided with
the distribution.
    * Neither the name of Google Inc. nor the names of its contributors may be used to endorse or
promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;
const APACHE_REF = 'Apache License 2.0 : texte complet à la fin de ce fichier.';
function standardText(license, author) {
  const out = [];
  if (/MIT/.test(license)) out.push(MIT(author));
  if (/Apache-2.0/.test(license)) out.push(author ? `Copyright (c) ${author}
${APACHE_REF}` : APACHE_REF);
  if (/BSD-3-Clause/.test(license)) out.push(BSD3_PROTOBUF);
  return out;
}

const seen = new Map();
function walk(from, name) {
  if (TYPES_ONLY(name)) return;
  const key = locate(from, name);
  if (!key || seen.has(key)) return;
  seen.set(key, lock[key]);
  for (const dep of Object.keys({ ...lock[key].dependencies, ...lock[key].optionalDependencies })) walk(key, dep);
}
for (const n of [...Object.keys(pkg.dependencies), ...BUNDLED]) walk('', n);

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const entries = [...seen.entries()]
  .filter(([key]) => existsSync(join(root, key)))
  .map(([key, meta]) => {
    const dir = join(root, key);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
    const author = typeof manifest.author === 'string' ? manifest.author.replace(/s*<.*>/, '') : manifest.author?.name;
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? meta.license ?? 'voir le texte';
    return { name: manifest.name, version: manifest.version, license, repo: manifest.homepage ?? (typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url) ?? '', texts: files.length ? files.map((f) => readFileSync(join(dir, f), 'utf8').trim()) : standardText(license, author) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

// one copy of each package name/version (the same package can be installed at several paths)
const unique = [...new Map(entries.map((e) => [`${e.name}@${e.version}`, e])).values()];
const canvasui = readFileSync(join(root, 'src/renderer/src/components/canvasui/LICENSE-canvasui.md'), 'utf8').trim();
const line = '='.repeat(78);
const out = [
  'Chud Music — composants tiers / third-party components',
  '',
  'Chud Music itself: © 2026 BigFatDeuce, free software under the GNU GPL v3 or later (LICENSE.txt).',
  'Source code: https://github.com/BigFatDeuce/Chud-Music',
  '',
  'Chud Music contient les logiciels suivants, chacun sous sa propre licence.',
  'FFmpeg est livré à part, avec sa licence et ses sources (dossier ffmpeg/).',
  'Electron et Chromium : LICENSE.electron.txt et LICENSES.chromium.html, à côté de l’application.',
  '',
  ...unique.map((e) => `- ${e.name} ${e.version} — ${e.license}`),
  '- Canvas UI (composants VHS, Glitch, Ripple, RetroDither, AsciiSweep, AsciiObject) — MIT + Commons Clause',
  '',
  ...unique.flatMap((e) => [line, `${e.name} ${e.version} — ${e.license}${e.repo ? `\n${e.repo}` : ''}`, line, '', ...(e.texts.length ? e.texts : [`(aucun fichier de licence dans le paquet ; licence déclarée : ${e.license})`]), '']),
  line,
  'Canvas UI — MIT + Commons Clause',
  line,
  '',
  canvasui,
  '',
  line,
  'Apache License 2.0 (texte complet)',
  line,
  '',
  readFileSync(join(root, 'node_modules/typescript/LICENSE'), 'utf8').trim().replace(/^[\s\S]*?(Apache License)/, '$1'),
  '',
].join('\n');
writeFileSync(join(root, 'build/THIRD-PARTY-NOTICES.txt'), out.replace(/\r?\n/g, '\r\n'));
const missing = unique.filter((e) => !e.texts.length).map((e) => `${e.name}@${e.version} (${e.license})`);
console.log(`build/THIRD-PARTY-NOTICES.txt: ${unique.length} packages + Canvas UI${missing.length ? `\nno licence file: ${missing.join(', ')}` : ''}`);
