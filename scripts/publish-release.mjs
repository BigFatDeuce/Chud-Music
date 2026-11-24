// Publishes a GitHub release of Chud Music with the installers built in dist/ (both platforms),
// the update manifests and FFmpeg's source. Usage:
//   node scripts/publish-release.mjs <notes.md> [extra files…]
// Authentication: the GitHub sign-in already known to Git (Git Credential Manager asks the person
// to sign in, in GitHub's own window, if needed). The token is only sent to api.github.com.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const REPO = 'BigFatDeuce/Chud-Music';
const tag = `v${version}`;
const [notesFile, ...extra] = process.argv.slice(2);
if (!notesFile) throw new Error('usage: node scripts/publish-release.mjs <notes.md> [extra files…]');

const dist = (f) => join(root, 'dist', f);
const assets = [
  dist(`Chud-Music-Setup-${version}.exe`),
  dist(`Chud-Music-Setup-${version}.exe.blockmap`),
  dist('latest.yml'),
  dist(`Chud-Music-${version}-Portable.exe`),
  dist(`Chud-Music-${version}-win-x64.zip`),
  dist(`Chud-Music-${version}-x86_64.AppImage`),
  dist('latest-linux.yml'),
  dist(`Chud-Music-${version}-amd64.deb`),
  dist(`Chud-Music-${version}-x86_64.rpm`),
  dist(`Chud-Music-${version}-x86_64.tar.gz`),
  ...extra,
];
for (const a of assets) if (!existsSync(a)) throw new Error(`missing: ${a}`);
// the manifests must describe these exact files
for (const [yml, file] of [['latest.yml', `Chud-Music-Setup-${version}.exe`], ['latest-linux.yml', `Chud-Music-${version}-x86_64.AppImage`]]) {
  const y = readFileSync(dist(yml), 'utf8');
  if (!y.includes(`version: ${version}`) || !y.includes(file)) throw new Error(`${yml} does not describe ${file}`);
}

const cred = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
const token = /^password=(.*)$/m.exec(cred)?.[1];
if (!token) throw new Error('no GitHub credential');
const gh = async (url, init = {}) => {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chud-music-release', ...init.headers },
  });
  if (!res.ok && res.status !== 404) throw new Error(`${init.method ?? 'GET'} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 404 ? null : res.status === 204 ? {} : res.json();
};

if (await gh(`/repos/${REPO}/releases/tags/${tag}`)) throw new Error(`${tag} already exists`);
// a draft first: nobody (and no installed Chud Music) sees it until every file is there
const release = await gh(`/repos/${REPO}/releases`, {
  method: 'POST',
  body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name: `Chud Music ${version}`, body: readFileSync(notesFile, 'utf8'), draft: true }),
});
for (const a of assets) {
  const name = basename(a);
  process.stdout.write(`upload ${name} (${(statSync(a).size / 1e6).toFixed(1)} MB)… `);
  const up = await gh(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: readFileSync(a),
  });
  if (up.size !== statSync(a).size) throw new Error(`${name}: uploaded ${up.size} bytes`);
  console.log('ok');
}
const done = await gh(`/repos/${REPO}/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) });
console.log(`published: ${done.html_url}`);
