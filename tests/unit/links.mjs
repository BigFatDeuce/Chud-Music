// Which pasted texts are music links (src/shared/links.ts), without the app: the TypeScript
// types are stripped by Node itself and the module is imported from a temporary copy.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = readFileSync(new URL('../../src/shared/links.ts', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'chud-links-'));
const file = join(dir, 'links.mjs');
writeFileSync(file, stripTypeScriptTypes(src));
const { parseMusicLink } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

const cases = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ' }],
  ['https://youtu.be/dQw4w9WgXcQ?si=abc', { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ' }],
  ['youtube.com/watch?v=dQw4w9WgXcQ', { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ' }],
  ['https://music.youtube.com/watch?v=fa5IWHDbftI&feature=share', { provider: 'youtube', kind: 'video', id: 'fa5IWHDbftI' }],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ' }],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ', { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ' }],
  ['https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', { provider: 'youtube', kind: 'playlist', id: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', videoId: undefined }],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', { provider: 'youtube', kind: 'playlist', id: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', videoId: 'dQw4w9WgXcQ' }],
  ['https://music.youtube.com/playlist?list=OLAK5uy_mz6eafmqdRHSaR4IwG0ll6J6rgv0_ZpGw', { provider: 'youtube', kind: 'playlist', id: 'OLAK5uy_mz6eafmqdRHSaR4IwG0ll6J6rgv0_ZpGw', videoId: undefined }],
  ['https://music.youtube.com/browse/MPREb_7ltM34kr0mH', { provider: 'youtube', kind: 'album', id: 'MPREb_7ltM34kr0mH' }],
  ['https://music.youtube.com/channel/UCRr1xG_2WIDs18a6cIiCxeA', { provider: 'youtube', kind: 'artist', id: 'UCRr1xG_2WIDs18a6cIiCxeA' }],
  ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=123', { provider: 'spotify', kind: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' }],
  ['https://open.spotify.com/intl-fr/album/4aawyAB9vmqN3uQ7FjRGTy', { provider: 'spotify', kind: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy' }],
  ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', { provider: 'spotify', kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' }],
  ['spotify:artist:4tZwfgrHOc3mvqYlEYSvVi', { provider: 'spotify', kind: 'artist', id: '4tZwfgrHOc3mvqYlEYSvVi' }],
  ['  https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC  ', { provider: 'spotify', kind: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' }],
  // not links: searched as text
  ['daft punk', null],
  ['one more time', null],
  ['youtube.com', null],
  ['https://www.youtube.com/@DaftPunk', null],
  ['https://open.spotify.com/user/spotify', null],
  ['https://example.com/watch?v=dQw4w9WgXcQ', null],
  ['https://www.youtube.com/watch?v=short', null],
  ['ftp://youtube.com/watch?v=dQw4w9WgXcQ', null],
];

let failed = 0;
for (const [input, want] of cases) {
  const got = parseMusicLink(input);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input)}${ok ? '' : ` — got ${JSON.stringify(got)}`}`);
}
console.log(`\n[links-unit] ${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
