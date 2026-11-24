import { net } from 'electron';
import type { RadioCountry, RadioStation } from '@shared/types';
import { kvGet, kvSet } from './db';
import { log } from './log';
import { tr } from '@shared/i18n';

// Internet radio (including FM stations streamed online) from Radio Browser
// (https://www.radio-browser.info): a free, open, community-run directory. Stations are listed
// by country, most voted first; broken and HLS-only streams are left out.
//
// Playback goes through our own protocol (chud-media://radio/…): the stream is fetched in the
// main process (radio-shift.ts: time shift and recording) and passed to the player, which gives the equaliser and visualiser access to the sound (radio
// servers rarely allow cross-origin reading) and lets us read the title being played (ICY
// metadata, stripped from the audio).

const SERVERS = ['de1', 'de2', 'fi1', 'nl1', 'at1'].map((s) => `https://${s}.api.radio-browser.info`);
const UA = 'ChudMusic/0.1 (+https://github.com/BigFatDeuce/Chud-Music)';
const DAY = 24 * 3600 * 1000;
const PLAYABLE = /^(MP3|AAC|AAC\+|OGG|OPUS|FLAC)$/i;

async function api<T>(path: string): Promise<T> {
  let last: unknown;
  for (const base of SERVERS) {
    try {
      const res = await fetch(`${base}${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(/fetch|timeout|ENOTFOUND/i.test(String(last)) ? tr('net.radio') : String(last));
}

interface RbStation {
  stationuuid: string;
  name: string;
  url_resolved: string;
  favicon: string;
  tags: string;
  country: string;
  countrycode: string;
  homepage: string;
  codec: string;
  bitrate: number;
  hls: number;
  votes: number;
  lastcheckok: number;
}

const toStation = (s: RbStation): RadioStation => ({
  id: s.stationuuid,
  name: s.name.trim(),
  url: s.url_resolved,
  favicon: s.favicon || null,
  tags: s.tags ? s.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4) : [],
  country: s.country,
  countryCode: s.countrycode,
  homepage: s.homepage || null,
  codec: s.codec,
  bitrate: s.bitrate || null,
  votes: s.votes,
});

export async function countries(): Promise<RadioCountry[]> {
  const cached = kvGet<{ at: number; list: RadioCountry[] }>('radio:countries');
  if (cached && Date.now() - cached.at < DAY) return cached.list;
  const raw = await api<{ name: string; iso_3166_1: string; stationcount: number }[]>('/json/countries?hidebroken=true');
  const list = raw.filter((c) => c.iso_3166_1 && c.stationcount >= 5).map((c) => ({ code: c.iso_3166_1.toUpperCase(), name: c.name, count: c.stationcount }));
  kvSet('radio:countries', { at: Date.now(), list });
  return list;
}

export async function stations(countryCode: string): Promise<RadioStation[]> {
  const key = `radio:stations:${countryCode}`;
  const cached = kvGet<{ at: number; list: RadioStation[] }>(key);
  if (cached && Date.now() - cached.at < DAY) return cached.list;
  const raw = await api<RbStation[]>(`/json/stations/bycountrycodeexact/${encodeURIComponent(countryCode)}?hidebroken=true&order=votes&reverse=true&limit=200`);
  const seen = new Set<string>();
  const list = raw
    .filter((s) => s.lastcheckok && !s.hls && PLAYABLE.test(s.codec) && s.url_resolved)
    .filter((s) => {
      const k = s.name.trim().toLowerCase();
      if (seen.has(k)) return false; // the same station under several stream URLs: keep the most voted
      seen.add(k);
      return true;
    })
    .slice(0, 120)
    .map(toStation);
  kvSet(key, { at: Date.now(), list });
  return list;
}

export async function search(name: string): Promise<RadioStation[]> {
  const raw = await api<RbStation[]>(`/json/stations/search?name=${encodeURIComponent(name)}&hidebroken=true&order=votes&reverse=true&limit=60`);
  return raw.filter((s) => s.lastcheckok && !s.hls && PLAYABLE.test(s.codec)).map(toStation);
}

/** Radio Browser counts plays to rank stations: the courtesy its terms ask of clients. */
export function countClick(id: string): void {
  void api(`/json/url/${encodeURIComponent(id)}`).catch(() => {});
}

export const favorites = (): RadioStation[] => kvGet<RadioStation[]>('radio:favorites') ?? [];
export function setFavorites(list: RadioStation[]): void {
  kvSet('radio:favorites', list);
}
