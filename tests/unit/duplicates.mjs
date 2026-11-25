// "Find duplicates…" (src/shared/duplicates.ts), without the app: the best copy of a song stays
// (lossless, then the highest bit rate, then YouTube), a video is only compared with videos.
//   node tests/unit/duplicates.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'chud-dupes-'));
const file = join(dir, 'duplicates.mjs');
writeFileSync(file, stripTypeScriptTypes(readFileSync(new URL('../../src/shared/duplicates.ts', import.meta.url), 'utf8')));
const { duplicateEntries, qualityRank, isVideoFile, isLossless } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
let count = 0;
const check = (label, ok, detail = '') => {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

let n = 0;
const local = (path, title, artist, durationSec, bitrateKbps, codec = null) => ({ id: `local:${path}`, source: 'local', path, title, artist, durationSec, bitrateKbps, codec, entryId: ++n });
const yt = (id, title, artist, durationSec) => ({ id: `yt:${id}`, source: 'youtube', title, artist, durationSec, entryId: ++n });
const gone = (list) => duplicateEntries(list).map((t) => t.id.replace(/^local:/, ''));

const mp3low = local('a/song-128.mp3', 'Song', 'Band', 200, 128, 'MPEG 1 Layer 3');
const mp3high = local('b/song-320.mp3', 'Song', 'Band', 201, 320, 'MPEG 1 Layer 3');
const flac = local('c/song.flac', 'Song', 'Band', 200, 900, 'FLAC');
const tube = yt('v1', 'song', 'BAND', 199);

check('a FLAC stays rather than the MP3 found before it', gone([mp3high, flac]).join() === 'b/song-320.mp3');
check('the MP3 with the higher bit rate stays, wherever it is', gone([mp3low, mp3high]).join() === 'a/song-128.mp3' && gone([mp3high, mp3low]).join() === 'a/song-128.mp3');
check('five copies: only the best one stays', gone([mp3low, tube, mp3high, flac, { ...mp3low, entryId: 99 }]).length === 4 && !gone([mp3low, tube, mp3high, flac]).includes('c/song.flac'));
check('a file stays rather than its YouTube Music twin', gone([tube, mp3low]).join() === 'yt:v1');
check('a lossless file with a low bit rate still beats a lossy one', qualityRank(local('x.flac', 'S', 'B', 100, 300, 'FLAC')) > qualityRank(mp3high));
check('lossless is known by codec or by extension', isLossless(local('x.m4a', 'S', 'B', 100, 800, 'ALAC')) && isLossless(local('x.wav', 'S', 'B', 100, 1411, null)) && !isLossless(mp3high) && !isLossless(local('x.m4a', 'S', 'B', 100, 256, 'MPEG-4/AAC')));
check('the same quality: the first one stays', gone([local('1.mp3', 'T', 'A', 100, 192), local('2.mp3', 'T', 'A', 100, 192)]).join() === '2.mp3');
check('unknown bit rates: the first one stays', gone([local('1.mp3', 'T', 'A', 100, null), local('2.mp3', 'T', 'A', 100, null)]).join() === '2.mp3');
check('the same track twice is a duplicate', duplicateEntries([mp3low, { ...mp3low, entryId: 77 }]).length === 1 && duplicateEntries([mp3low, { ...mp3low, entryId: 77 }])[0].entryId === 77);
check('a far longer version is another song', gone([mp3low, yt('v2', 'Song', 'Band', 999)]).length === 0);
check('another artist is another song', gone([mp3low, local('z.mp3', 'Song', 'Other', 200, 320)]).length === 0);
check('accents and case do not matter', gone([local('1.mp3', 'Été', 'Zoé', 100, 320), local('2.mp3', 'ete', 'ZOE', 101, 128)]).join() === '2.mp3');

const video = local('clips/song.mp4', 'Song', 'Band', 200, 2500, 'MPEG-4/AAC');
const videoBetter = local('clips/hd/song.mp4', 'Song', 'Band', 201, 6000, 'MPEG-4/AAC');
check('a video file is known by its extension', isVideoFile(video) && isVideoFile(local('x.webm', 'S', 'B', 1, 1)) && !isVideoFile(mp3low) && !isVideoFile(local('x.m4a', 'S', 'B', 1, 1)) && !isVideoFile(tube));
check('a video is not the duplicate of the music with the same title', gone([flac, video]).length === 0 && gone([video, mp3low, tube]).join() === 'yt:v1');
check('two videos alike: the better one stays', gone([video, videoBetter]).join() === 'clips/song.mp4' && gone([videoBetter, video]).join() === 'clips/song.mp4');
check('music and videos together: one of each stays', gone([mp3low, video, flac, videoBetter]).sort().join() === 'a/song-128.mp3,clips/song.mp4');
const mixed = [mp3low, local('other.mp3', 'Other', 'Band', 100, 128), mp3high, flac];
check('the entries to take out come in playlist order', duplicateEntries(mixed).map((t) => t.entryId).join() === [mp3low.entryId, mp3high.entryId].join());
check('nothing to take out of a playlist without copies', duplicateEntries([mp3low, local('o.mp3', 'Other', 'Band', 100, 128), video]).length === 0 && duplicateEntries([]).length === 0);

// Copies are grouped only when ALL their known durations lie within 3 s (no chain
// 180 → 183 → 186), an unknown duration never joins another track, and the playlist order does not
// change how many entries are taken out.
const d = (path, dur, rate = 192) => local(path, 'Same', 'Test', dur, rate, 'FLAC');
const gone3 = (...l) => gone(l);
check('an unknown duration does not bridge 180 s and 300 s', gone3(d('a.flac', 180), d('z.flac', null), d('c.flac', 300)).length === 0, gone3(d('a.flac', 180), d('z.flac', null), d('c.flac', 300)).join());
check('two different tracks without a duration are not taken for each other', gone3(d('x.flac', null), d('y.flac', null)).length === 0);
check('the same track twice, without a duration, is still a duplicate', duplicateEntries([d('x.flac', null), { ...d('x.flac', null), entryId: 501 }]).map((t) => t.entryId).join() === '501');
check('no chain: 180, 183 and 186 s are not one song', !gone3(d('a.flac', 180), d('b.flac', 183), d('e.flac', 186)).includes('e.flac'), gone3(d('a.flac', 180), d('b.flac', 183), d('e.flac', 186)).join());
const perms = (a) => (a.length < 2 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
const near = (a, b) => a.id === b.id || (a.durationSec != null && b.durationSec != null && Math.abs(a.durationSec - b.durationSec) <= 3);
// every entry taken out has a kept copy of the same song within 3 s; the number taken out
const sound = (list) => {
  const out = new Set(duplicateEntries(list));
  const kept = list.filter((t) => !out.has(t));
  return [...out].every((r) => kept.some((k) => near(r, k))) ? out.size : -1;
};
const counts = perms([d('p.flac', 180), d('q.flac', 183), d('r.flac', 186), d('s.flac', 240)]).map(sound);
check('whatever the playlist order: as many taken out, each one near a kept copy', counts.every((c) => c === counts[0] && c > 0), [...new Set(counts)].join());
check('every entry taken out is within 3 s of the copy that stays', (() => { const l = [d('a.flac', 180, 100), d('b.flac', 183, 900), d('c.flac', 186, 100)]; return sound(l) >= 1; })());

{
  const a = d('twice.flac', 200, 128);
  const l = [a, d('better.flac', 201, 900), { ...a, entryId: 777 }];
  const out = duplicateEntries(l);
  check('an entry is never listed twice (a repeated track that loses to a better copy)', out.length === new Set(out).size && out.length === 2, out.map((t) => t.entryId).join());
}

console.log(`\n[duplicates] ${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
