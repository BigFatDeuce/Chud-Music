// Dev probe: prints the shape of the youtubei.js YouTube Music objects the catalogue maps.
// node scripts/probe-ytm.mjs "query"
import { Innertube } from 'youtubei.js';

const shelf = (r) => r.contents?.find((c) => c.type === 'MusicShelf');
const q = process.argv[2] ?? 'Daft Punk One More Time';
const yt = await Innertube.create({ retrieve_player: false, lang: 'fr', location: 'FR' });
const brief = (o, depth = 0) => {
  if (o == null || typeof o !== 'object') return o;
  if (depth > 2) return Array.isArray(o) ? `[${o.length}]` : '{…}';
  if (Array.isArray(o)) return o.slice(0, 2).map((x) => brief(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!['endpoint', 'overlay', 'menu', 'badges', 'flex_columns', 'fixed_columns'].includes(k)) out[k] = brief(v, depth + 1);
  return out;
};
const songs = await yt.music.search(q, { type: 'song' });
console.log('SONG', JSON.stringify(brief(shelf(songs)?.contents?.[0]), null, 1).slice(0, 2500));
console.log('has continuation', typeof songs.getContinuation, songs.has_continuation);
const albums = await yt.music.search(q, { type: 'album' });
const a0 = shelf(albums)?.contents?.[0];
console.log('ALBUM', JSON.stringify(brief(a0), null, 1).slice(0, 1500));
const artists = await yt.music.search(q.split(' ').slice(0, 2).join(' '), { type: 'artist' });
const ar0 = shelf(artists)?.contents?.[0];
console.log('ARTIST', JSON.stringify(brief(ar0), null, 1).slice(0, 1200));
if (a0) {
  const al = await yt.music.getAlbum(a0.id);
  console.log('GETALBUM header', JSON.stringify(brief(al.header), null, 1).slice(0, 1500));
  console.log('GETALBUM track', JSON.stringify(brief(al.contents?.[0]), null, 1).slice(0, 1500));
}
if (ar0) {
  const ar = await yt.music.getArtist(ar0.id);
  console.log('GETARTIST header', JSON.stringify(brief(ar.header), null, 1).slice(0, 800));
  console.log('GETARTIST sections', ar.sections?.map((s) => `${s.type}:${s.title?.text ?? s.header?.title?.text}:${s.contents?.length}`));
}
const up = await yt.music.getUpNext(shelf(songs).contents[0].id, true);
console.log('UPNEXT', up.playlist_id, up.contents?.length, JSON.stringify(brief(up.contents?.[0]), null, 1).slice(0, 1500));
const sug = await yt.music.getSearchSuggestions('daft p');
console.log('SUGGEST', JSON.stringify(brief(sug), null, 1).slice(0, 800));
