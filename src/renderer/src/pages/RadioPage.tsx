import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { LoaderCircle, Pause, Play, RadioTower, Search, Star, X } from 'lucide-react';
import type { RadioCountry, RadioStation, Track } from '@shared/types';
import { usePlayer } from '@/store/player';
import { toast } from '@/store/toasts';
import { PageScroll } from '@/components/PageScroll';
import { locale, tr } from '@shared/i18n';

// Internet radio (FM stations streamed online included), by country, most popular first, from
// the open Radio Browser directory. Favourites are the first entry of the list.

const FAV = 'favoris';
const regionName = (() => {
  try {
    const dn = new Intl.DisplayNames([locale()], { type: 'region' });
    return (code: string, fallback: string) => dn.of(code) ?? fallback;
  } catch {
    return (_: string, fallback: string) => fallback;
  }
})();
const collator = new Intl.Collator(locale(), { sensitivity: 'base' });
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** The user's own country first time (fr-FR → FR). */
const homeCountry = (navigator.language.split('-')[1] ?? 'FR').toUpperCase();

export const toTrack = (s: RadioStation): Track => ({
  id: `radio:${s.id}`,
  source: 'radio',
  title: s.name,
  artist: s.tags.length ? s.tags.join(', ') : s.country,
  album: s.country,
  durationSec: null,
  coverUrl: s.favicon?.startsWith('https://') ? s.favicon : null,
  codec: s.codec,
  bitrate: s.bitrate,
  available: true,
  streamUrl: s.url,
  onAir: null,
});

const useRadio = create<{ selected: string | null; favorites: RadioStation[] }>(() => ({ selected: null, favorites: [] }));
void window.chud.radio.favorites().then((favorites) => useRadio.setState({ favorites, selected: useRadio.getState().selected ?? (favorites.length ? FAV : homeCountry) }));

function toggleFavorite(s: RadioStation): void {
  const list = useRadio.getState().favorites;
  const next = list.some((f) => f.id === s.id) ? list.filter((f) => f.id !== s.id) : [...list, s];
  useRadio.setState({ favorites: next });
  void window.chud.radio.setFavorites(next);
}

export function RadioPage() {
  const { selected, favorites } = useRadio();
  const [countries, setCountries] = useState<RadioCountry[] | null>(null);
  const [stations, setStations] = useState<RadioStation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<RadioStation[] | null>(null);
  const current = usePlayer((s) => s.current);
  const status = usePlayer((s) => s.status);

  useEffect(() => {
    window.chud.radio.countries().then(setCountries, (e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(() => {
    setFilter('');
    setFound(null);
    if (!selected || selected === FAV) return setStations(null);
    setStations(null);
    window.chud.radio.stations(selected).then(setStations, (e) => setError(String(e?.message ?? e)));
  }, [selected]);

  const named = useMemo(
    () => (countries ?? []).map((c) => ({ ...c, label: regionName(c.code, c.name) })).sort((a, b) => (a.code === homeCountry ? -1 : b.code === homeCountry ? 1 : collator.compare(a.label, b.label))),
    [countries],
  );
  const list = found ?? (selected === FAV ? favorites : stations);
  const shown = useMemo(() => {
    const w = fold(filter);
    return (list ?? []).filter((s) => !w || fold(`${s.name} ${s.tags.join(' ')}`).includes(w));
  }, [list, filter]);
  const title = found ? `« ${query} »` : selected === FAV ? tr('radio.favorites') : selected ? regionName(selected, selected) : '';
  const playingId = current?.source === 'radio' ? current.id : null;

  const play = (i: number) => {
    const tracks = shown.map(toTrack);
    usePlayer.getState().playFrom('section:radio', `${tr('section.radio')} · ${title}`, tracks, i);
  };

  return (
    <div className="radio-page">
      <aside className="radio-countries panel">
        <label className="search">
          <Search size={15} />
          <input value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)} placeholder={tr('radio.country')} aria-label={tr('radio.countrySearch')} />
        </label>
        <div className="radio-country-list">
          <button className={`radio-country fav${selected === FAV && !found ? ' on' : ''}`} onClick={() => useRadio.setState({ selected: FAV })}>
            <Star size={15} fill="currentColor" /> {tr('radio.favorites')} <span>{favorites.length}</span>
          </button>
          {!countries && !error && <p className="radio-note"><LoaderCircle size={14} className="spin" /> {tr('common.loading')}</p>}
          {named
            .filter((c) => !countryFilter || fold(c.label).includes(fold(countryFilter)) || c.code.toLowerCase() === countryFilter.toLowerCase())
            .map((c) => (
              <button key={c.code} className={`radio-country${selected === c.code && !found ? ' on' : ''}`} onClick={() => useRadio.setState({ selected: c.code })} title={`${c.label} — ${tr('radio.nStations', { n: c.count })}`}>
                <span className="radio-flag">{c.code}</span>
                <span className="radio-country-name">{c.label}</span>
                <span>{c.count}</span>
              </button>
            ))}
        </div>
      </aside>

      <PageScroll className="radio-main">
        <header className="radio-head">
          <div>
            <span className="list-hero-kicker">{tr('section.radio')}</span>
            <h1 className="page-title">{title}</h1>
            <p className="page-sub">{tr('radio.sub')}</p>
          </div>
          <form
            className="search radio-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (!query.trim()) return setFound(null);
              window.chud.radio.search(query.trim()).then(setFound, (er) => toast({ kind: 'error', title: tr('yt.searchFailed'), body: String(er?.message ?? er) }));
            }}
          >
            <Search size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('radio.searchWorld')} aria-label={tr('radio.search')} />
            {found && (
              <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} aria-label={tr('common.clearSearch')} onClick={() => (setFound(null), setQuery(''))}>
                <X size={14} />
              </button>
            )}
          </form>
        </header>

        {error && <p className="radio-note warn">{error}</p>}
        {list && list.length > 8 && (
          <label className="search radio-filter">
            <Search size={15} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr('radio.filter')} aria-label={tr('radio.filterLabel')} />
          </label>
        )}
        {!list && !error ? (
          <p className="radio-note"><LoaderCircle size={14} className="spin" /> {tr('radio.loading')}</p>
        ) : selected === FAV && !found && !favorites.length ? (
          <div className="empty">
            <div className="empty-art"><Star size={52} strokeWidth={1.4} /></div>
            <h3>{tr('radio.noFav')}</h3>
            <p>{tr('radio.noFavText')}</p>
          </div>
        ) : (
          <div className="radio-list">
            {shown.map((s, i) => {
              const fav = favorites.some((f) => f.id === s.id);
              const on = playingId === `radio:${s.id}`;
              return (
                <div key={s.id} className={`radio-row${on ? ' on' : ''}`} onDoubleClick={() => play(i)}>
                  <button className="radio-play" aria-label={on && status === 'playing' ? tr('radio.pauseNamed', { name: s.name }) : tr('radio.listenNamed', { name: s.name })} onClick={() => (on && status === 'loading' ? undefined : on ? usePlayer.getState().toggle() : play(i))}>
                    {s.favicon?.startsWith('https://') ? <img src={s.favicon} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <RadioTower size={18} />}
                    <span className="radio-play-icon">{on && status === 'playing' ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</span>
                  </button>
                  <div className="radio-text">
                    <b>{s.name}</b>
                    <span>{on && current?.onAir ? `♪ ${current.onAir}` : [s.tags.join(', '), found ? s.country : null].filter(Boolean).join(' · ') || s.country}</span>
                  </div>
                  <span className="badge">{s.codec}{s.bitrate ? ` ${s.bitrate}` : ''}</span>
                  <button className={`icon-btn radio-star${fav ? ' on' : ''}`} aria-pressed={fav} aria-label={fav ? tr('radio.unfav', { name: s.name }) : tr('radio.fav', { name: s.name })} onClick={() => toggleFavorite(s)}>
                    <Star size={17} fill={fav ? 'currentColor' : 'none'} />
                  </button>
                </div>
              );
            })}
            {list && !shown.length && <p className="radio-note">{tr('radio.noMatch')}</p>}
          </div>
        )}
      </PageScroll>
    </div>
  );
}
