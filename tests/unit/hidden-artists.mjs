// Hidden YouTube Music artists (src/shared/hidden-artists.ts), without the app: what a hidden
// artist takes out of results, how the list is added to and brought back.
//   node tests/unit/hidden-artists.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'chud-hidden-'));
const file = join(dir, 'hidden-artists.mjs');
writeFileSync(file, stripTypeScriptTypes(readFileSync(new URL('../../src/shared/hidden-artists.ts', import.meta.url), 'utf8')));
const { artistKey, splitArtistLine, hiddenMatcher, withHidden, withoutHidden } = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
let count = 0;
const check = (label, ok, detail = '') => {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

check('names compare without case, accents or punctuation', artistKey('Beyoncé!') === artistKey('beyonce') && artistKey('AC/DC') === 'ac dc');
check('an artist line is split into its names', splitArtistLine('A, B & C feat. D').join('|') === 'A|B|C|D' && splitArtistLine('Solo').join('|') === 'Solo');

const list = [
  { id: 'UC_band', name: 'The Band', at: 1 },
  { id: null, name: 'Céline', at: 2 },
];
const hidden = hiddenMatcher(list);
check('hidden by channel id, whatever the name says', hidden({ artistId: 'UC_band', artist: 'Another name' }));
check('hidden by name when the result has no id', hidden({ artistId: null, artist: 'The Band' }));
check('a featured hidden artist hides the track too', hidden({ artistId: 'UC_other', artist: 'Someone, celine' }));
check('other artists stay', !hidden({ artistId: 'UC_other', artist: 'Someone Else' }) && !hidden({ artistId: null, artist: null }));
check('a name only containing a hidden one stays ("The Bandits")', !hidden({ artistId: null, artist: 'The Bandits' }));
check('a name with a separator in it (AC/DC) is hidden as a whole', hiddenMatcher([{ id: null, name: 'AC/DC', at: 1 }])({ artistId: null, artist: 'AC/DC' }));
check('no hidden artist: nothing is hidden', !hiddenMatcher([])({ artistId: 'UC_band', artist: 'The Band' }));

let l = withHidden([], { id: 'UC_a', name: 'A', at: 1 });
l = withHidden(l, { id: 'UC_b', name: 'B', at: 2 });
l = withHidden(l, { id: 'UC_a', name: 'A', at: 3 });
check('hiding twice keeps one entry, the newest first', l.length === 2 && l[0].id === 'UC_a' && l[0].at === 3);
l = withHidden(l, { id: null, name: 'b', at: 4 });
check('the same name without an id replaces the entry', l.length === 2 && l[0].name === 'b');
check('restoring by id or by name brings it back', withoutHidden(l, { id: 'UC_a', name: 'A' }).length === 1 && withoutHidden(l, { id: null, name: 'B' }).length === 1);
check('restoring an artist that is not hidden changes nothing', withoutHidden(l, { id: 'UC_z', name: 'Z' }).length === 2);

console.log(`\n${count - failed}/${count} passed`);
process.exit(failed ? 1 : 0);
