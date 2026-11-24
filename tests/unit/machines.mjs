// The state machines of src/shared/machines.ts, without the app (under a second): the tables are
// sound (no unknown or unreachable state), the scenarios that used to go wrong when the states
// were implicit are refused, and docs/ANALYSE-TECHNIQUE.md shows the very same tables.
//   node tests/unit/machines.mjs           checks
//   node tests/unit/machines.mjs --write   rewrites the tables of the document from the code
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'chud-machines-'));
const load = async (name) => {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, stripTypeScriptTypes(readFileSync(new URL(`../../src/shared/${name}.ts`, import.meta.url), 'utf8')));
  return import(pathToFileURL(file).href);
};
const { playerMachine, playerStatus, updateMachine, updateState, adblockMachine, adblockFlags, coversMachine, coversRunning } = await load('machines');
const { ytPlace, ytBarReserved, ytQualityCap, clipFull, spectrumFeed } = await load('yt-place');
rmSync(dir, { recursive: true, force: true });

let failed = 0;
let count = 0;
const check = (label, ok, detail = '') => {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Feeds the events in turn; an event the state does not take leaves it where it is. */
const walk = (m, events, from = m.initial) => events.reduce((s, e) => m.next(s, e) ?? s, from);
const eventsOf = (m) => [...new Set(Object.values(m.table).flatMap((row) => Object.keys(row)))];

// ── every table: sound
for (const m of [playerMachine, updateMachine, adblockMachine, coversMachine]) {
  const states = Object.keys(m.table);
  const targets = Object.values(m.table).flatMap((row) => Object.values(row));
  check(`${m.name}: starts in a state of its table`, states.includes(m.initial));
  check(`${m.name}: every transition leads to a state of its table`, targets.every((s) => states.includes(s)), targets.filter((s) => !states.includes(s)).join(', '));
  const seen = new Set([m.initial]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of [...seen]) for (const to of Object.values(m.table[s])) if (!seen.has(to)) grew = seen.add(to) && true;
  }
  check(`${m.name}: every state can be reached`, states.every((s) => seen.has(s)), states.filter((s) => !seen.has(s)).join(', '));
  check(`${m.name}: next() and can() agree with the table`, states.every((s) => eventsOf(m).every((e) => m.next(s, e) === (m.table[s][e] ?? null) && m.can(s, e) === (m.table[s][e] !== undefined))));
}

// ── playback
const P = playerMachine;
check('player: a track plays, pauses, goes on', walk(P, ['LOAD', 'HANDOVER', 'PLAYING', 'PAUSED', 'PLAYING']) === 'playing');
check('player: any state takes a new track', Object.keys(P.table).every((s) => P.next(s, 'LOAD') === 'resolving'));
check('player: any state can stop', Object.keys(P.table).every((s) => P.next(s, 'STOP') === 'idle'));
check('player: while a track is prepared, nothing the engine reports counts (it is about the previous one)', ['PLAYING', 'PAUSED', 'ENDED'].every((e) => !P.can('resolving', e)));
check('player: the end of the previous track does not move on from the one being prepared', walk(P, ['LOAD', 'HANDOVER', 'PLAYING', 'LOAD', 'ENDED']) === 'resolving');
check('player: once the engine has the track, its end counts (a resume point at the very end)', P.can('loading', 'ENDED') && P.can('playing', 'ENDED') && P.can('paused', 'ENDED'));
check('player: a failure is taken once per track', walk(P, ['LOAD', 'HANDOVER', 'FAIL']) === 'failed' && !P.can('failed', 'FAIL'));
check('player: a failed track neither plays nor ends afterwards', ['PLAYING', 'PAUSED', 'ENDED', 'HANDOVER'].every((e) => !P.can('failed', e)));
check('player: after a failure, the next track or the stop', P.next('failed', 'LOAD') === 'resolving' && P.next('failed', 'STOP') === 'idle');
check('player: nothing fails or ends when nothing is loaded', !P.can('idle', 'FAIL') && !P.can('idle', 'ENDED'));
check('player: only "playing" pauses', Object.keys(P.table).every((s) => P.can(s, 'PAUSED') === (s === 'playing')));
check('player: only a paused station is tuned in again', Object.keys(P.table).every((s) => P.can(s, 'RETUNE') === (s === 'paused')) && P.next('paused', 'RETUNE') === 'loading');
check('player: a station read from another moment stays as it is', P.next('playing', 'HANDOVER') === 'playing' && P.next('paused', 'HANDOVER') === 'paused');
check('player: play/pause gives up a track on its way, and only that', Object.keys(P.table).every((s) => P.can(s, 'CANCEL') === ['resolving', 'loading', 'failed'].includes(s)) && ['resolving', 'loading', 'failed'].every((s) => P.next(s, 'CANCEL') === 'idle'));
check('player: a track given up is loaded again when asked', walk(P, ['LOAD', 'CANCEL', 'LOAD', 'HANDOVER', 'PLAYING']) === 'playing');
check('player: the interface sees four states', Object.keys(P.table).map(playerStatus).join() === 'idle,loading,loading,playing,paused,loading');

// ── updates
const U = updateMachine;
check('updates: found, downloaded, ready', walk(U, ['CHECK', 'FOUND', 'DOWNLOAD', 'PROGRESS', 'PROGRESS', 'DOWNLOADED']) === 'downloaded');
check('updates: nothing newer', walk(U, ['CHECK', 'NOT_FOUND']) === 'none' && walk(U, ['CHECK', 'NOT_FOUND', 'CHECK', 'FOUND']) === 'available');
check('updates: GitHub out of reach, then back', walk(U, ['CHECK', 'CHECK_FAILED']) === 'error' && walk(U, ['CHECK', 'CHECK_FAILED', 'CHECK', 'FOUND']) === 'available');
check('updates: a known update survives a check that fails', walk(U, ['CHECK', 'FOUND', 'CHECK', 'CHECK_FAILED']) === 'available');
check('updates: a known update stays offered while GitHub is asked again', updateState(walk(U, ['CHECK', 'FOUND', 'CHECK'])) === 'available' && U.can('rechecking', 'DOWNLOAD'));
check('updates: a withdrawn release is no longer offered', walk(U, ['CHECK', 'FOUND', 'CHECK', 'NOT_FOUND']) === 'none');
check('updates: only a found update is downloaded', Object.keys(U.table).every((s) => U.can(s, 'DOWNLOAD') === (s === 'available' || s === 'rechecking')));
check('updates: one download at a time', !U.can('downloading', 'DOWNLOAD') && !U.can('downloaded', 'DOWNLOAD'));
check('updates: a check never interrupts a download', !U.can('downloading', 'CHECK') && !U.can('downloaded', 'CHECK') && walk(U, ['CHECK', 'FOUND', 'CHECK', 'DOWNLOAD', 'FOUND', 'NOT_FOUND', 'CHECK_FAILED']) === 'downloading');
check('updates: a failed download is offered again', walk(U, ['CHECK', 'FOUND', 'DOWNLOAD', 'DOWNLOAD_FAILED']) === 'available');
check('updates: downloaded is final until the restart', Object.keys(U.table.downloaded).length === 0);
check('updates: progress only while downloading', Object.keys(U.table).every((s) => U.can(s, 'PROGRESS') === (s === 'downloading')));

// ── ad blocker
const A = adblockMachine;
const flags = (events, enabled = true) => adblockFlags(walk(A, events), enabled);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('adblock: saved engine read, lists checked', walk(A, ['LOADED', 'CHECK', 'CHECK_OK']) === 'ready' && same(flags(['LOADED', 'CHECK']), { active: true, checking: true, waiting: false }));
check('adblock: first use waits for YouTube Music, then builds', same(flags(['NO_ENGINE']), { active: false, checking: false, waiting: true }) && same(flags(['NO_ENGINE', 'CHECK']), { active: false, checking: true, waiting: false }) && walk(A, ['NO_ENGINE', 'CHECK', 'CHECK_OK']) === 'ready');
check('adblock: offline at first use, tried again later', walk(A, ['NO_ENGINE', 'CHECK', 'CHECK_FAILED']) === 'failed' && walk(A, ['NO_ENGINE', 'CHECK', 'CHECK_FAILED', 'CHECK', 'CHECK_OK']) === 'ready');
check('adblock: a check that fails while an engine runs changes nothing', walk(A, ['LOADED', 'CHECK', 'CHECK_FAILED']) === 'ready' && flags(['LOADED', 'CHECK', 'CHECK_FAILED']).active);
check('adblock: a check asked for before the saved engine was read', walk(A, ['CHECK', 'LOADED', 'CHECK_OK']) === 'ready' && walk(A, ['CHECK', 'NO_ENGINE']) === 'building' && walk(A, ['CHECK', 'LOADED', 'CHECK_FAILED']) === 'ready');
check('adblock: one check at a time', !A.can('building', 'CHECK') && !A.can('refreshing', 'CHECK'));
check('adblock: never active when switched off, never waiting and checking at once', Object.keys(A.table).every((s) => !adblockFlags(s, false).active && !(adblockFlags(s, true).waiting && adblockFlags(s, true).checking)));

// ── where the YouTube player shows: the same answer as the conditions it replaces
// (LivingCover.tsx, useDrawerSpot and useYtDocked of store/ytdock.ts before §34), for every input
const KEYS = ['ytLive', 'compact', 'drawer', 'mini', 'roomInSidebar', 'playlistsPanel', 'clipOpen', 'slotKnown'];
const before = (i) => {
  const spotOpen = i.ytLive && i.compact && i.drawer && !i.mini;
  const beside = spotOpen && !i.roomInSidebar;
  const docked = i.ytLive && !i.mini && !i.clipOpen && (i.compact || i.playlistsPanel || !i.roomInSidebar);
  const inClip = i.ytLive && i.clipOpen && !spotOpen;
  return { place: beside ? 'beside' : spotOpen ? 'cover' : inClip ? 'clip' : docked && i.slotKnown ? 'bar' : 'cover', docked };
};
let differ = 0;
const places = new Set();
for (let n = 0; n < 1 << KEYS.length; n++) {
  const i = Object.fromEntries(KEYS.map((k, b) => [k, !!(n & (1 << b))]));
  const was = before(i);
  places.add(ytPlace(i));
  if (was.place !== ytPlace(i) || was.docked !== ytBarReserved(i)) differ++;
}
check('yt-place: same place and same reserved bar as before, for the 256 combinations', differ === 0, `${differ} différence(s)`);
check('yt-place: the four places are all reached', [...places].sort().join() === 'bar,beside,clip,cover');
check('yt-place: at home when no YouTube track is live', ytPlace({ ytLive: false, compact: true, drawer: true, mini: false, roomInSidebar: false, playlistsPanel: true, clipOpen: true, slotKnown: true }) === 'cover');
check('yt-place: the open drawer wins over the clip tab and the bar', ytPlace({ ytLive: true, compact: true, drawer: true, mini: false, roomInSidebar: false, playlistsPanel: false, clipOpen: true, slotKnown: true }) === 'beside');

check('yt-quality: 480p at most wherever the player is small, YouTube\'s choice on the clip stage', ['cover', 'beside', 'bar'].every((p) => ytQualityCap(p) === 'large') && ytQualityCap('clip') === null);

// ── missing covers
const C = coversMachine;
check('covers: a search runs, ends, and can be started again', walk(C, ['START', 'DONE', 'START']) === 'searching');
check('covers: one search at a time', !C.can('searching', 'START') && !C.can('stopping', 'START'));
check('covers: "stop" lets the album in progress end', walk(C, ['START', 'STOP']) === 'stopping' && coversRunning('stopping') && walk(C, ['START', 'STOP', 'DONE']) === 'idle');
check('covers: no connection is said once, and the next search starts from there', walk(C, ['START', 'FAIL']) === 'failed' && !coversRunning('failed') && walk(C, ['START', 'FAIL', 'START']) === 'searching');
check('covers: a failure while stopping is not one', walk(C, ['START', 'STOP', 'FAIL']) === 'idle');
check('covers: "stop" with nothing running changes nothing', !C.can('idle', 'STOP') && !C.can('failed', 'STOP'));
check('covers: running only while searching or stopping', Object.keys(C.table).map(coversRunning).join() === 'false,true,true,false');

// ── the clip tab full screen: one thing is full screen whatever plays
check('clip-full: only when the clip tab asked for it and is shown', clipFull({ fullscreen: true, byClip: true, clipShown: true }) && !clipFull({ fullscreen: true, byClip: false, clipShown: true }) && !clipFull({ fullscreen: false, byClip: true, clipShown: true }) && !clipFull({ fullscreen: true, byClip: true, clipShown: false }));

// ── the small spectrum
const feed = (o) => spectrumFeed({ playing: true, effectsOff: false, youtube: false, hasAnalyser: true, freshLevels: false, ...o });
check('spectrum: a file is read from the audio graph', feed({}) === 'analyser' && feed({ hasAnalyser: false }) === 'off');
check('spectrum: YouTube is measured when levels come, moves on its own when none do', feed({ youtube: true, freshLevels: true }) === 'measured' && feed({ youtube: true }) === 'simulated');
check('spectrum: never moves when paused or with effects off', feed({ playing: false, youtube: true, freshLevels: true }) === 'off' && feed({ effectsOff: true, youtube: true }) === 'off' && feed({ playing: false }) === 'off');

// ── the document shows the same tables
const cell = (s) => String(s).padEnd(11);
const render = (m) => {
  const events = eventsOf(m);
  const lines = [`| ${cell(m.name)} | ${events.map(cell).join(' | ')} |`, `| ${cell('-'.repeat(11))} | ${events.map(() => cell('-'.repeat(11))).join(' | ')} |`];
  for (const [state, row] of Object.entries(m.table)) lines.push(`| ${cell(state === m.initial ? `${state} ●` : state)} | ${events.map((e) => cell(row[e] ?? '·')).join(' | ')} |`);
  return lines.join('\n');
};
const docFile = fileURLToPath(new URL('../../docs/ANALYSE-TECHNIQUE.md', import.meta.url));
// the technical notes are not part of the public source: their check is skipped there
let doc = existsSync(docFile) ? readFileSync(docFile, 'utf8') : null;
for (const m of doc === null ? [] : [playerMachine, updateMachine, adblockMachine, coversMachine]) {
  const open = `<!-- machine:${m.name} -->`;
  const close = `<!-- /machine:${m.name} -->`;
  const block = `${open}\n${render(m)}\n${close}`;
  const a = doc.indexOf(open);
  let b = doc.indexOf(close);
  if (process.argv.includes('--write') && a >= 0 && b > a) {
    doc = doc.slice(0, a) + block + doc.slice(b + close.length);
    b = doc.indexOf(close);
  }
  const now = a >= 0 && b > a ? doc.slice(a, b + close.length).replace(/\r\n/g, '\n') : '';
  check(`${m.name}: docs/ANALYSE-TECHNIQUE.md shows the table of the code`, now === block, now ? (now === block ? '' : 'différent : node tests/unit/machines.mjs --write') : 'bloc absent du document');
}
if (doc !== null && process.argv.includes('--write')) writeFileSync(docFile, doc);

console.log(`\n[machines] ${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
