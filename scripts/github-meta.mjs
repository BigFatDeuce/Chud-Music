// Keeps what GitHub shows in line with the project (always in English):
//  • the notes of every published release = docs/release-notes/<version>.md
//  • the repository description, website and topics.
// Usage: node scripts/github-meta.mjs
// Authentication: the GitHub sign-in already known to Git (Git Credential Manager).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'BigFatDeuce/Chud-Music';
const ABOUT = {
  description: 'Modern and retro desktop music player for Windows and Linux: your files, YouTube Music, world radio, synced lyrics, MilkDrop visualizer, five skins.',
  homepage: `https://github.com/${REPO}/releases/latest`,
};
const TOPICS = ['music-player', 'desktop-app', 'electron', 'windows', 'linux', 'appimage', 'youtube-music', 'internet-radio', 'lyrics', 'milkdrop', 'equalizer', 'flac'];

const cred = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
const token = /^password=(.*)$/m.exec(cred)?.[1];
if (!token) throw new Error('no GitHub credential');
const gh = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chud-music-meta', ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const notesDir = join(root, 'docs/release-notes');
const releases = await gh(`/repos/${REPO}/releases?per_page=100`);
for (const file of readdirSync(notesDir).filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f))) {
  const version = file.replace(/\.md$/, '');
  const rel = releases.find((r) => r.tag_name === `v${version}`);
  if (!rel) {
    console.log(`v${version}: not published, skipped`);
    continue;
  }
  const body = readFileSync(join(notesDir, file), 'utf8');
  const name = `Chud Music ${version}`;
  if (rel.body === body && rel.name === name) {
    console.log(`v${version}: up to date`);
    continue;
  }
  await gh(`/repos/${REPO}/releases/${rel.id}`, { method: 'PATCH', body: JSON.stringify({ name, body }) });
  console.log(`v${version}: notes updated`);
}
await gh(`/repos/${REPO}`, { method: 'PATCH', body: JSON.stringify(ABOUT) });
await gh(`/repos/${REPO}/topics`, { method: 'PUT', body: JSON.stringify({ names: TOPICS }) });
console.log('repository description, website and topics set');
