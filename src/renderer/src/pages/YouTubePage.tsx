import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, CircleAlert, Disc3, Eye, EyeOff, LayoutGrid, Link2, List, ListMusic, ListPlus, LoaderCircle, Music2, Play, Radio, Save, Search, SearchX, UserRound, X } from 'lucide-react';
import type { Track, YtAlbumItem, YtArtistItem, YtSearchType } from '@shared/types';
import { useYouTube, startMix } from '@/store/youtube';
import { artistKey, hiddenMatcher } from '@shared/hidden-artists';
import { parseMusicLink } from '@shared/links';
import { createPlaylistWith } from '@/lib/track-actions';
import { useTabs } from '@/store/tabs';
import { usePlayer } from '@/store/player';
import { fmtTime, fmtTotal } from '@/lib/format';
import { addToPlaylistItems, trackMenu } from '@/lib/track-actions';
import { endDrag, startDrag } from '@/lib/drag';
import { CoverArt } from '@/components/CoverArt';
import { PageScroll } from '@/components/PageScroll';
import { TrackList } from '@/components/TrackList';
import { showMenu } from '@/components/ContextMenu';
import { ArtistName } from '@/components/YtMeta';
import { tr } from '@shared/i18n';

// YouTube Music in Chud Music's own interface: the public catalogue (no account) searched by
// title, artist or album; playback goes through YouTube's official player in the living cover.

const TAB = 'section:youtube';
const TYPES: [YtSearchType, string, typeof Music2][] = [
  ['song', tr('yt.songs'), Music2],
  ['album', tr('stats.albums'), Disc3],
  ['artist', tr('stats.artists'), UserRound],
];
const ease = [0.22, 1, 0.36, 1] as const;

function SearchBox() {
  const { query, setQuery, search, openLink } = useYouTube();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2 || parseMusicLink(q)) return setSuggestions([]);
    const id = setTimeout(() => {
      window.chud.youtube.suggest(q).then((s) => setSuggestions(s), () => setSuggestions([]));
    }, 220);
    return () => clearTimeout(id);
  }, [query, open]);

  const run = (q: string) => {
    setOpen(false);
    setHi(-1);
    // a YouTube / Spotify link opens what it points to instead of searching its text
    if (!openLink(q)) void search(q);
    inputRef.current?.blur();
  };

  return (
    <div className="yt-searchbox">
      <div className="search">
        <Search size={16} />
        <input
          ref={inputRef}
          value={query}
          placeholder={tr('yt.search')}
          aria-label={tr('yt.search')}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHi(-1);
          }}
          onFocus={() => setOpen(true)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (!parseMusicLink(pasted)) return;
            e.preventDefault();
            setQuery(pasted.trim());
            run(pasted);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run(hi >= 0 && suggestions[hi] ? suggestions[hi]! : query);
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, suggestions.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, -1)); }
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {query && (
          <button className="icon-btn" style={{ width: 26, height: 26 }} aria-label={tr('common.clear')} onClick={() => { setQuery(''); inputRef.current?.focus(); }}>
            <X size={14} />
          </button>
        )}
      </div>
      {open && suggestions.length > 0 && (
        <div className="yt-suggest panel" role="listbox">
          {suggestions.map((s, i) => (
            <button key={s} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => run(s)}>
              <Search size={14} /> {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toolbar() {
  const { type, layout, setLayout, search, query } = useYouTube();
  return (
    <div className="yt-toolbar">
      <div className="segmented" role="radiogroup" aria-label={tr('yt.type')}>
        {TYPES.map(([t, label, Icon]) => (
          <button key={t} role="radio" aria-checked={type === t} className={type === t ? 'on' : ''} onClick={() => void search(query, t)}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>
      <div className="segmented" role="radiogroup" aria-label={tr('yt.view')}>
        <button role="radio" aria-checked={layout === 'list'} aria-label={tr('yt.list')} title={tr('yt.list')} className={layout === 'list' ? 'on' : ''} onClick={() => setLayout('list')}>
          <List size={15} />
        </button>
        <button role="radio" aria-checked={layout === 'grid'} aria-label={tr('yt.grid')} title={tr('yt.grid')} className={layout === 'grid' ? 'on' : ''} onClick={() => setLayout('grid')}>
          <LayoutGrid size={15} />
        </button>
      </div>
    </div>
  );
}

const playList = (label: string, tracks: Track[], i: number) => usePlayer.getState().playFrom(TAB, label, tracks, i);

function SongGrid({ tracks, label }: { tracks: Track[]; label: string }) {
  return (
    <div className="album-grid">
      {tracks.map((t, i) => (
        <div
          key={`${t.id}-${i}`}
          className="album-card"
          role="button"
          tabIndex={0}
          draggable
          onDragStart={(e) => startDrag(e, { tracks: [t] })}
          onDragEnd={endDrag}
          onDoubleClick={() => playList(label, tracks, i)}
          onKeyDown={(e) => e.key === 'Enter' && playList(label, tracks, i)}
          onContextMenu={(e) => showMenu(e, trackMenu([t], { play: () => playList(label, tracks, i) }))}
        >
          <div className="album-art">
            <CoverArt url={t.coverUrl} size={36} />
            <button className="album-play" aria-label={tr('common.playNamed', { name: t.title })} onClick={(e) => { e.stopPropagation(); playList(label, tracks, i); }}>
              <Play size={16} fill="currentColor" style={{ marginLeft: 2 }} />
            </button>
          </div>
          <b title={t.title}>{t.title}</b>
          <span>
            {t.artist && <ArtistName track={t} />}
            {t.artist && t.durationSec ? ' · ' : ''}
            {t.durationSec ? fmtTime(t.durationSec) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function AlbumCards({ albums, layout }: { albums: YtAlbumItem[]; layout: 'list' | 'grid' }) {
  const openAlbum = useYouTube((s) => s.openAlbum);
  const sub = (a: YtAlbumItem) => [a.kind, a.artist, a.year].filter(Boolean).join(' · ');
  if (layout === 'list')
    return (
      <div className="yt-rows">
        {albums.map((a) => (
          <button key={a.id} className="yt-row" onClick={() => openAlbum(a.id)}>
            <span className="yt-row-art"><CoverArt url={a.coverUrl} size={18} /></span>
            <span className="yt-row-text"><b>{a.title}</b><span>{sub(a)}</span></span>
          </button>
        ))}
      </div>
    );
  return (
    <div className="album-grid">
      {albums.map((a) => (
        <div key={a.id} className="album-card" role="button" tabIndex={0} onClick={() => openAlbum(a.id)} onKeyDown={(e) => e.key === 'Enter' && openAlbum(a.id)}>
          <div className="album-art"><CoverArt url={a.coverUrl} size={36} /></div>
          <b title={a.title}>{a.title}</b>
          <span>{sub(a)}</span>
        </div>
      ))}
    </div>
  );
}

/** Right-click on an artist card: open it, or hide it from searches and mixes. */
const artistMenu = (a: YtArtistItem) => [
  { label: tr('menu.goArtist'), icon: <UserRound size={15} />, onSelect: () => useYouTube.getState().openArtist(a.id) },
  { label: tr('hide.artist', { name: a.name }), icon: <EyeOff size={15} />, onSelect: () => void useYouTube.getState().hideArtist({ id: a.id, name: a.name }) },
];

function ArtistCards({ artists, layout }: { artists: YtArtistItem[]; layout: 'list' | 'grid' }) {
  const openArtist = useYouTube((s) => s.openArtist);
  if (layout === 'list')
    return (
      <div className="yt-rows">
        {artists.map((a) => (
          <button key={a.id} className="yt-row artist" onClick={() => openArtist(a.id)} onContextMenu={(e) => showMenu(e, artistMenu(a))}>
            <span className="yt-row-art"><CoverArt url={a.coverUrl} size={18} /></span>
            <span className="yt-row-text"><b>{a.name}</b><span>{a.subtitle}</span></span>
          </button>
        ))}
      </div>
    );
  return (
    <div className="album-grid">
      {artists.map((a) => (
        <div key={a.id} className="album-card artist" role="button" tabIndex={0} onClick={() => openArtist(a.id)} onKeyDown={(e) => e.key === 'Enter' && openArtist(a.id)} onContextMenu={(e) => showMenu(e, artistMenu(a))}>
          <div className="album-art"><CoverArt url={a.coverUrl} size={36} /></div>
          <b title={a.name}>{a.name}</b>
          <span>{a.subtitle}</span>
        </div>
      ))}
    </div>
  );
}

function Status({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-art">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

function Results() {
  const { result, searched, loading, loadingMore, error, layout, loadMore, search } = useYouTube();
  if (loading) return <Status icon={<LoaderCircle size={44} className="spin" />} title={tr('yt.searching')} />;
  if (error)
    return (
      <Status icon={<CircleAlert size={48} strokeWidth={1.5} />} title={tr('yt.searchFailed')} action={<button className="btn" onClick={() => void search()}>{tr('common.retry')}</button>}>
        {error}
      </Status>
    );
  if (!result)
    return (
      <Status icon={<Search size={48} strokeWidth={1.5} />} title={tr('yt.idleTitle')}>
        {tr('yt.idleText')}
      </Status>
    );
  if (!result.items.length) return <Status icon={<Search size={48} strokeWidth={1.5} />} title={tr('yt.noResults', { q: searched })} />;
  const label = tr('yt.resultsLabel', { q: searched });
  return (
    <>
      {result.type === 'song' &&
        (layout === 'list' ? (
          <TrackList tabId={TAB} label={label} tracks={result.items} columns={['num', 'title', 'artist', 'album', 'duration']} />
        ) : (
          <SongGrid tracks={result.items} label={label} />
        ))}
      {result.type === 'album' && <AlbumCards albums={result.items} layout={layout} />}
      {result.type === 'artist' && <ArtistCards artists={result.items} layout={layout} />}
      {result.more && (
        <div className="yt-more">
          <button className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? <LoaderCircle size={16} className="spin" /> : null} {tr('yt.more')}
          </button>
        </div>
      )}
    </>
  );
}

function PlaylistButton({ tracks }: { tracks: Track[] }) {
  return (
    <button className="btn ghost" style={{ alignSelf: 'center' }} disabled={!tracks.length} onClick={(e) => showMenu(e, addToPlaylistItems(tracks))}>
      <ListPlus size={16} /> {tr('menu.addToPlaylist')}
    </button>
  );
}

function AlbumView({ id }: { id: string }) {
  const page = useYouTube((s) => s.albums[id]);
  const openArtist = useYouTube((s) => s.openArtist);
  if (!page) return <PageLoading />;
  const total = page.tracks.reduce((s, t) => s + (t.durationSec ?? 0), 0);
  return (
    <>
      <motion.header className="list-hero" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
        <div className="list-hero-art single"><CoverArt url={page.coverUrl} size={48} /></div>
        <div className="list-hero-meta">
          <span className="list-hero-kicker">{page.kind ?? tr('col.album')} · YouTube Music</span>
          <h1 className="list-hero-title" title={page.title}>{page.title}</h1>
          <div className="list-hero-stats">
            {page.artist && (page.artistId ? <button className="link" onClick={() => openArtist(page.artistId!)}>{page.artist}</button> : <span>{page.artist}</span>)}
            {page.year && <span>· {page.year}</span>}
            <span>· {tr('n.titles', { n: page.tracks.length })}</span>
            {total > 0 && <span>· {fmtTotal(total)}</span>}
          </div>
          <div className="list-hero-actions">
            <button className="play-fab" aria-label={tr('yt.playAlbum')} disabled={!page.tracks.length} onClick={() => playList(page.title, page.tracks, 0)}>
              <Play size={22} fill="currentColor" style={{ marginLeft: 3 }} />
            </button>
            <PlaylistButton tracks={page.tracks} />
            {page.tracks[0] && (
              <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={() => void startMix(page.tracks[0]!)}>
                <Radio size={16} /> {tr('menu.startMix')}
              </button>
            )}
          </div>
        </div>
      </motion.header>
      <TrackList tabId={TAB} label={page.title} tracks={page.tracks} columns={['num', 'title', 'artist', 'duration']} />
    </>
  );
}

function ArtistView({ id }: { id: string }) {
  const page = useYouTube((s) => s.artists[id]);
  const layout = useYouTube((s) => s.layout);
  const hidden = useYouTube((s) => s.hidden);
  useEffect(() => void (useYouTube.getState().hidden ?? useYouTube.getState().loadHidden()), []);
  if (!page) return <PageLoading />;
  // an artist page stays open when asked for (a link, "Go to artist"): it says it is hidden
  const isHiddenNow = !!hidden && hiddenMatcher(hidden)({ artistId: page.id, artist: page.name });
  const entry = hidden?.find((a) => a.id === page.id || artistKey(a.name) === artistKey(page.name));
  return (
    <>
      <motion.header className="list-hero" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
        <div className="list-hero-art single round"><CoverArt url={page.coverUrl} size={48} /></div>
        <div className="list-hero-meta">
          <span className="list-hero-kicker">{tr('col.artist')} · YouTube Music</span>
          <h1 className="list-hero-title" title={page.name}>{page.name}</h1>
          <div className="list-hero-actions">
            <button className="play-fab" aria-label={tr('yt.playPopular')} disabled={!page.songs.length} onClick={() => playList(page.name, page.songs, 0)}>
              <Play size={22} fill="currentColor" style={{ marginLeft: 3 }} />
            </button>
            {page.songs[0] && (
              <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={() => void startMix(page.songs[0]!)}>
                <Radio size={16} /> {tr('menu.startMix')}
              </button>
            )}
            {isHiddenNow ? (
              <button className="btn ghost" style={{ alignSelf: 'center' }} data-artist-hidden onClick={() => void useYouTube.getState().unhideArtist(entry ?? { id: page.id, name: page.name, at: 0 })}>
                <Eye size={16} /> {tr('hide.restore')}
              </button>
            ) : (
              <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={() => void useYouTube.getState().hideArtist({ id: page.id, name: page.name })}>
                <EyeOff size={16} /> {tr('hide.button')}
              </button>
            )}
          </div>
          {isHiddenNow && <p className="list-hero-note">{tr('hide.pageNote')}</p>}
        </div>
      </motion.header>
      {page.songs.length > 0 && (
        <>
          <h2 className="section-title">{tr('yt.popular')}</h2>
          <TrackList tabId={TAB} label={page.name} tracks={page.songs} columns={['num', 'title']} />
        </>
      )}
      {page.albums.length > 0 && (
        <>
          <h2 className="section-title">{tr('stats.albums')}</h2>
          <AlbumCards albums={page.albums} layout={layout} />
        </>
      )}
      {page.singles.length > 0 && (
        <>
          <h2 className="section-title">{tr('yt.singles')}</h2>
          <AlbumCards albums={page.singles} layout={layout} />
        </>
      )}
    </>
  );
}

/** A pasted link: what it holds, found on YouTube Music (Spotify tracks matched one by one). */
function LinkView({ id }: { id: string }) {
  const entry = useYouTube((s) => s.links[id]);
  const search = useYouTube((s) => s.search);
  if (!entry) return null;
  if (entry.error) return <Status icon={<CircleAlert size={48} strokeWidth={1.5} />} title={tr('link.failed')}>{entry.error}</Status>;
  const data = entry.data;
  if (!data) return <Status icon={<LoaderCircle size={44} className="spin" />} title={tr('link.reading')}>{entry.url}</Status>;
  const found = entry.matches.filter((t): t is Track => !!t);
  const missing = data.wanted ? data.wanted.filter((_, i) => entry.matches[i] === null) : [];
  const pending = entry.matches.filter((m) => m === undefined).length;
  const total = entry.matches.length;
  const done = total - pending;
  const source = data.source === 'spotify' ? 'Spotify' : 'YouTube';
  const kind = tr(data.kind === 'track' ? 'link.kindTrack' : data.kind === 'album' ? 'link.kindAlbum' : 'link.kindPlaylist', { source });
  const cover = found[0]?.coverUrl ?? null;
  const duration = found.reduce((s, t) => s + (t.durationSec ?? 0), 0);
  return (
    <>
      <motion.header className="list-hero" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }}>
        <div className="list-hero-art single"><CoverArt url={cover} size={48} /></div>
        <div className="list-hero-meta">
          <span className="list-hero-kicker">{kind}</span>
          <h1 className="list-hero-title" title={data.title}>{data.title}</h1>
          <div className="list-hero-stats">
            {data.subtitle && <span>{data.subtitle}</span>}
            <span>
              {data.subtitle ? '· ' : ''}
              {data.wanted ? tr('link.foundOf', { n: found.length, total }) : tr('n.titles', { n: found.length })}
            </span>
            {duration > 0 && <span>· {fmtTotal(duration)}</span>}
          </div>
          {pending > 0 && (
            <div className="link-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={tr('link.matching')}>
              <span style={{ width: `${(100 * done) / total}%` }} />
              <em>{tr('link.matchingN', { n: done, total })}</em>
            </div>
          )}
          <div className="list-hero-actions">
            <button className="play-fab" aria-label={tr('common.play')} disabled={!found.length} onClick={() => playList(data.title, found, 0)}>
              <Play size={22} fill="currentColor" style={{ marginLeft: 3 }} />
            </button>
            <button
              className="btn ghost"
              style={{ alignSelf: 'center' }}
              disabled={!found.length || pending > 0}
              onClick={() => void createPlaylistWith(found, data.title).then((pid) => pid && useTabs.getState().openPlaylist(pid))}
            >
              <Save size={16} /> {tr('link.saveAsPlaylist')}
            </button>
            <PlaylistButton tracks={found} />
          </div>
        </div>
      </motion.header>
      {data.truncated && <p className="yt-link-note">{tr(data.source === 'spotify' ? 'link.truncatedSpotify' : 'link.truncated', { n: total })}</p>}
      {found.length > 0 && <TrackList tabId={TAB} label={data.title} tracks={found} columns={['num', 'title', 'artist', 'album', 'duration']} />}
      {missing.length > 0 && (
        <>
          <h2 className="section-title">{tr('link.missing', { n: missing.length })}</h2>
          <p className="yt-link-note">{tr('link.missingText')}</p>
          <div className="yt-rows">
            {missing.map((w, i) => (
              <button key={`${w.title}-${i}`} className="yt-row" title={tr('link.searchIt')} onClick={() => void search([w.title, w.artists[0]].filter(Boolean).join(' '), 'song')}>
                <span className="yt-row-art"><SearchX size={18} /></span>
                <span className="yt-row-text"><b>{w.title}</b><span>{w.artists.join(', ')}</span></span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function PageLoading() {
  const error = useYouTube((s) => s.pageError);
  return error ? <Status icon={<CircleAlert size={48} strokeWidth={1.5} />} title={tr('yt.pageUnavailable')}>{error}</Status> : <Status icon={<LoaderCircle size={44} className="spin" />} title={tr('common.loading')} />;
}

export function YouTubePage() {
  useEffect(() => window.chud.adblock.warm(), []);
  const stack = useYouTube((s) => s.stack);
  const back = useYouTube((s) => s.back);
  const result = useYouTube((s) => s.result);
  const searched = useYouTube((s) => s.searched);
  const view = stack[stack.length - 1]!;

  return (
    <PageScroll>
      {view.kind === 'search' ? (
        <>
          <header className="yt-head">
            <h1 className="page-title">YouTube Music</h1>
            <p className="page-sub">
              {result ? tr(result.more ? 'yt.countMore' : 'yt.count', { n: result.items.length, q: searched }) : tr('yt.sub')}
            </p>
          </header>
          <div className="yt-bar">
            <SearchBox />
            <Toolbar />
          </div>
          <p className="yt-link-hint">
            <Link2 size={12} /> {tr('yt.linkHint')}
          </p>
          <Results />
        </>
      ) : (
        <>
          <button className="btn ghost yt-back" onClick={back}>
            <ArrowLeft size={16} /> {tr('common.back')}
          </button>
          {view.kind === 'album' ? <AlbumView id={view.id} /> : view.kind === 'artist' ? <ArtistView id={view.id} /> : <LinkView id={view.id} />}
        </>
      )}
      <p className="yt-note">
        <ListMusic size={14} /> {tr('yt.note')}
      </p>
    </PageScroll>
  );
}
