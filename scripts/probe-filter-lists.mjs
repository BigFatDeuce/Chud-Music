// Dev probe: builds the ad-blocking engine as the app does (uBlock Origin's catalogue, network
// rules + YouTube-only cosmetics/scriptlets) and shows what it does on YouTube.
import { FiltersEngine, Request } from '@ghostery/adblocker';

const ASSETS = 'https://raw.githubusercontent.com/gorhill/uBlock/master/assets/assets.json';
const RESOURCES = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
const COSMETIC = /^([^#\s]*)#[@?$]{0,2}#/; // same filter as src/main/adblock-worker.ts
const forYouTube = (t) => t.split('\n').filter((l) => { const m = COSMETIC.exec(l); return !m || /youtube|ytimg/.test(m[1]); }).join('\n');

const assets = await (await fetch(ASSETS)).json();
const wanted = Object.entries(assets).filter(([, v]) => !v.off && ['default', 'ads', 'privacy'].includes(v.group) && v.content === 'filters');
const texts = [];
for (const [id, v] of wanted) {
  const url = [...(v.cdnURLs ?? []), ...[v.contentURL].flat()].find((u) => u.startsWith('https://'));
  texts.push(await (await fetch(url)).text());
  console.log('list', id);
}
const engine = FiltersEngine.parse(texts.map(forYouTube).join('\n'), { loadCosmeticFilters: true, loadNetworkFilters: true, loadGenericCosmeticsFilters: false });
const res = await (await fetch(RESOURCES)).text();
engine.updateResources(res, String(res.length));
const yt = engine.getCosmeticsFilters({ url: 'https://www.youtube.com/embed/x', hostname: 'www.youtube.com', domain: 'youtube.com' });
console.log(`YouTube: ${yt.scripts.length} scriptlets, ${yt.styles.length} chars of hiding CSS`);
for (const url of ['https://www.youtube.com/api/stats/ads?ver=2', 'https://googleads.g.doubleclick.net/pagead/id', 'https://www.youtube.com/pagead/adview?ai=x']) {
  const m = engine.match(Request.fromRawDetails({ url, sourceUrl: 'https://www.youtube.com/embed/x', type: 'xhr' })).match;
  console.log(m ? 'BLOCK' : 'pass ', url);
}
console.log(`filters: ${engine.getFilters().networkFilters.length} network, ${engine.getFilters().cosmeticFilters.length} cosmetic`);
