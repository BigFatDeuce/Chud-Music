// How tracks follow each other, the sleep timer (src/shared/chain.ts) and volume normalisation
// (src/shared/replaygain.ts), without the app.
//   node tests/unit/playback.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function load(file) {
  const js = stripTypeScriptTypes(readFileSync(new URL(`../../src/shared/${file}`, import.meta.url), 'utf8'));
  const out = join(mkdtempSync(join(tmpdir(), 'chud-unit-')), file.replace(/\.ts$/, '.mjs'));
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}
const { sameAlbum, nextOnAlbum, chainMode, sleepStopsAfter } = await load('chain.ts');
const { replayGainFactor, parseEbur128 } = await load('replaygain.ts');

let failed = 0;
let count = 0;
const check = (label, ok, detail = '') => {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
let n = 0;
const t = (o = {}) => ({ id: `t${++n}`, source: 'local', album: 'Live', artist: 'A', albumArtist: 'A', trackNo: 1, discNo: 1, path: 'D:\\M\\Live\\1.flac', ...o });

// ── albums
check('same album, same album artist', sameAlbum(t(), t({ trackNo: 2, artist: 'A feat. B' })));
check('same name, another album artist: not the same album', !sameAlbum(t({ album: 'Greatest Hits' }), t({ album: 'Greatest Hits', albumArtist: 'Z' })));
check('case and spaces do not matter', sameAlbum(t({ album: 'Live ' }), t({ album: 'LIVE' })));
check('no album: never the same', !sameAlbum(t({ album: null }), t({ album: null })) && !sameAlbum(t({ album: '' }), t({ album: ' ' })));
const loose = { albumArtist: null, artist: 'X' };
check('no album artist: the folder decides', sameAlbum(t(loose), t({ albumArtist: null, artist: 'Y', path: 'D:\\M\\Live\\2.flac' })) && !sameAlbum(t(loose), t({ albumArtist: null, artist: 'Y', path: 'D:\\M\\Other\\2.flac' })));
check('next number: the next track', nextOnAlbum(t(), t({ trackNo: 2 })) && !nextOnAlbum(t(), t({ trackNo: 3 })) && !nextOnAlbum(t({ trackNo: 2 }), t()));
check('first track of the next disc: the next track', nextOnAlbum(t({ trackNo: 12 }), t({ trackNo: 1, discNo: 2 })) && !nextOnAlbum(t({ trackNo: 12 }), t({ trackNo: 2, discNo: 2 })));
check('no numbers: not known to be next', !nextOnAlbum(t({ trackNo: null }), t({ trackNo: 2 })));

// ── how they are chained
const both = { gapless: true, crossfadeSec: 5 };
const one = t();
check('crossfade between two albums', chainMode(t(), t({ album: 'Other' }), both) === 5);
check('never between consecutive tracks of an album: gapless', chainMode(t(), t({ trackNo: 2 }), both) === 0);
check('the same album out of order is crossfaded', chainMode(t(), t({ trackNo: 5 }), both) === 5);
check('a track after itself (repeat one) is never crossfaded', chainMode(one, one, both) === 0);
check('crossfade off: gapless', chainMode(t(), t({ album: 'Other' }), { gapless: true, crossfadeSec: 0 }) === 0);
check('both off: a simple change', chainMode(t(), t({ trackNo: 2 }), { gapless: false, crossfadeSec: 0 }) === null);
check('gapless off, crossfade on: an album changes simply', chainMode(t(), t({ trackNo: 2 }), { gapless: false, crossfadeSec: 5 }) === null);
check('YouTube, radio: neither', chainMode(t({ source: 'youtube' }), t(), both) === null && chainMode(t(), t({ source: 'youtube' }), both) === null && chainMode(t(), t({ source: 'radio' }), both) === null);

// ── sleep timer
const album = { kind: 'album' };
check('no timer, or a time: the end of a track stops nothing', !sleepStopsAfter(null, t(), t()) && !sleepStopsAfter({ kind: 'time', at: 1 }, t(), t()));
check('end of the track: always', sleepStopsAfter({ kind: 'track' }, t(), t()) && sleepStopsAfter({ kind: 'track' }, t(), null));
check('end of the album: not inside it', !sleepStopsAfter(album, t(), t({ trackNo: 2 })));
check('at another album, or at the end of the list: yes', sleepStopsAfter(album, t(), t({ album: 'Other' })) && sleepStopsAfter(album, t(), null));
check('a single track repeated does not keep it awake', sleepStopsAfter(album, one, one));
check('a track without an album is its own album', sleepStopsAfter(album, t({ album: null }), t({ album: null })));

// ── volume normalisation
const l = (o) => ({ trackGain: null, trackPeak: null, albumGain: null, albumPeak: null, source: 'tags', ...o });
const near = (a, b) => Math.abs(a - b) < 1e-3;
check('off, or nothing known: untouched', replayGainFactor('off', l({ trackGain: -6 })) === 1 && replayGainFactor('track', null) === 1 && replayGainFactor('track', l({})) === 1);
check('-6 dB: half', near(replayGainFactor('track', l({ trackGain: -6.0206, trackPeak: 1 })), 0.5));
check('a gain that would clip is limited by the peak', near(replayGainFactor('track', l({ trackGain: 12, trackPeak: 0.8 })), 1.25));
check('a peak above full scale (lossy files) is brought back', near(replayGainFactor('track', l({ trackGain: 0, trackPeak: 1.25 })), 0.8));
check('without a known peak, never louder', replayGainFactor('track', l({ trackGain: 6 })) === 1 && replayGainFactor('track', l({ trackGain: -6 })) < 1);
check('by album: the gain of the album', near(replayGainFactor('album', l({ trackGain: -3, trackPeak: 1, albumGain: -6.0206, albumPeak: 1 })), 0.5));
check('a file without one uses its track gain', near(replayGainFactor('album', l({ trackGain: -6.0206, trackPeak: 1 })), 0.5));
check('absurd tags stay within reason', replayGainFactor('track', l({ trackGain: 90, trackPeak: 0.0001 })) < 6 && replayGainFactor('track', l({ trackGain: -90, trackPeak: 1 })) > 0.05 && replayGainFactor('track', l({ trackGain: NaN })) === 1);
const summary = (i, p) => `[Parsed_ebur128_0 @ 0] t: 1 I: -5.0 LUFS\n[Parsed_ebur128_0 @ 0] Summary:\n\n  Integrated loudness:\n    I:  ${i} LUFS\n    Threshold: -30.0 LUFS\n\n  Loudness range:\n    LRA: 1.0 LU\n\n  Sample peak:\n    Peak:  ${p} dBFS\n`;
const m = parseEbur128(summary('      -9.5', '      -1.0'));
check('the measure is read from the summary of FFmpeg', near(m.gain, -8.5) && near(m.peak, 0.8913));
check('silence is not amplified', parseEbur128(summary('     -70.0', '      -inf')) === null && parseEbur128('nothing') === null);

console.log(`\n[playback unit] ${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
