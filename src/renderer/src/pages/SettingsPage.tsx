import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, Download, ExternalLink, Eye, EyeOff, FolderOpen, FolderPlus, Languages, LoaderCircle, RefreshCw, Smartphone, Trash2, Upload } from 'lucide-react';
import { useUpdates } from '@/store/updates';
import { chooseOutput, listOutputs, type OutputDevice } from '@/lib/audio-output';
import logo from '@/assets/logo.svg';
import { useLibrary } from '@/store/library';
import { toast } from '@/store/toasts';
import { confirm } from '@/components/Dialog';
import { HOME_SECTIONS, MAX_CROSSFADE, SMALL_ALBUM, type HomeSection, type AdblockStatus, type AppInfo, type EffectsLevel, type SkinId } from '@shared/types';
import { getLang, LANGS, locale, tr, type Key, type LangPref } from '@shared/i18n';
import type { ReplayGainMode } from '@shared/replaygain';
import { useSettings } from '@/store/settings';
import { useYouTube } from '@/store/youtube';
import { usePlaylists } from '@/store/playlists';

const SKINS: { id: SkinId; name: string }[] = [
  { id: 'nocturne', name: 'Chud Nocturne' },
  { id: 'cassette', name: 'Cassette 98' },
  { id: 'aqua', name: 'Aqua Glow' },
  { id: 'signal', name: 'Signal' },
  { id: 'platine', name: 'Platine' },
];

/** Live miniature: rendered inside its own data-skin scope, so it uses that skin's tokens. */
function SkinPreview({ id }: { id: SkinId }) {
  return (
    <div data-skin={id} className="skin-preview" style={{ background: 'var(--bg-0)', padding: 10, display: 'grid', gridTemplateColumns: '54px 1fr', gap: 8 }}>
      <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: 6 }}>
        {[1, 0, 0, 0].map((on, i) => (
          <div key={i} style={{ height: 8, borderRadius: 3, background: on ? 'var(--accent)' : 'var(--bg-3)' }} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateRows: '1fr 30px', gap: 8 }}>
        <div className="panel" style={{ padding: 8, fontFamily: 'var(--font-display)', fontSize: 15, textTransform: 'var(--title-transform)' as never, color: 'var(--text-0)' }}>
          Aa
        </div>
        <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px' }}>
          <div style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--accent)', boxShadow: 'var(--glow)' }} />
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'linear-gradient(90deg, var(--accent-2), var(--accent))' }} />
          <span className="lcd" style={{ fontSize: 13 }}>3:14</span>
        </div>
      </div>
    </div>
  );
}

/** Interface language: the system's by default. Applied by reloading the interface. */
function LanguageSettings() {
  const { language, set } = useSettings();
  const active = getLang();
  const [pending, setPending] = useState<LangPref | null>(null);
  const systemName = LANGS.find((l) => l.code === active)?.name;
  const choose = (v: LangPref) => {
    set({ language: v });
    setPending(v);
  };
  return (
    <section className="settings-group panel">
      <h3>
        <Languages size={17} style={{ verticalAlign: '-3px', marginRight: 8 }} />
        {tr('set.language')}
      </h3>
      <div className="setting-row">
        <div>
          <b>{tr('set.languageLabel')}</b>
          <span>{tr('set.languageHint')}</span>
        </div>
        <select className="select" aria-label={tr('set.language')} value={language} onChange={(e) => choose(e.target.value as LangPref)}>
          <option value="system">{language === 'system' ? tr('set.languageSystemNow', { name: systemName ?? '' }) : tr('set.languageSystem')}</option>
          {LANGS.map((l) => (
            <option key={l.code} value={l.code} lang={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      {pending !== null && (
        <div className="setting-row">
          <span>{tr('set.languageApply')}</span>
          <button className="btn primary" onClick={() => window.chud.reload()}>
            <RefreshCw size={15} /> {tr('set.languageApplyNow')}
          </button>
        </div>
      )}
    </section>
  );
}

/** Settings › Home: each section below the clock can be turned off. */
function HomeSettings() {
  const hidden = useSettings((s) => s.homeHidden);
  const setSettings = useSettings((s) => s.set);
  const names: Record<HomeSection, string> = {
    recentPlayed: tr('lib.recentPlayed'),
    random: tr('home.random'),
    recentAdded: tr('lib.recentAdded'),
    shortcuts: tr('home.shortcuts'),
    keyboard: tr('home.keyboard'),
  };
  return (
    <section className="settings-group panel">
      <h3>{tr('section.home')}</h3>
      <p>{tr('set.homeText')}</p>
      {HOME_SECTIONS.map((k) => {
        const on = !hidden.includes(k);
        const put = (show: boolean) => setSettings({ homeHidden: show ? hidden.filter((x) => x !== k) : [...hidden, k] });
        return (
          <div key={k} className="setting-row">
            <div><b>{names[k]}</b></div>
            <div className="segmented" role="radiogroup" aria-label={names[k]} data-home={k}>
              <button className={on ? 'on' : ''} role="radio" aria-checked={on} onClick={() => put(true)}>{tr('set.shown')}</button>
              <button className={!on ? 'on' : ''} role="radio" aria-checked={!on} onClick={() => put(false)}>{tr('set.hidden')}</button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function LibrarySettings() {
  const folders = useLibrary((s) => s.folders);
  const status = useLibrary((s) => s.status);
  const { addFolder, removeFolder, rescan } = useLibrary.getState();
  // counts and reachability asked when the section is shown (not at every library change)
  useEffect(() => void useLibrary.getState().loadFolders(), []);
  const hideSmallAlbums = useSettings((s) => s.hideSmallAlbums);
  const setSettings = useSettings((s) => s.set);
  const remove = async (path: string) => {
    const ok = await confirm({ title: tr('set.removeFolderQ'), body: tr('set.removeFolderBody', { path }), confirm: tr('set.remove'), danger: true });
    if (ok) await removeFolder(path);
  };
  const setScan = async (path: string, on: boolean) => {
    await window.chud.library.setFolderScan(path, on);
    await useLibrary.getState().loadFolders();
  };
  return (
    <section className="settings-group panel">
      <h3>{tr('section.library')}</h3>
      <p>{tr('set.libraryText')}</p>
      {folders.map((f) => (
        <div key={f.path} className="setting-row">
          <div style={{ minWidth: 0 }}>
            <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</b>
            <span>
              {f.missing ? <span className="badge warn"><CircleAlert size={11} /> {tr('set.folderMissing')}</span> : tr('n.tracks', { n: f.trackCount })}
              {!f.scan && <> · <span className="badge">{tr('set.scanPaused')}</span></>}
              {f.missing && <> {tr('set.folderMissingHint')}</>}
            </span>
          </div>
          <div className="folder-actions">
            {/* scanning of this folder: off = nothing reads it (startup, changes, Rescan); its tracks stay */}
            <div className="segmented" role="radiogroup" aria-label={tr('set.folderScan', { path: f.path })} title={tr('set.folderScanText')} data-folder-scan={f.scan ? 'on' : 'off'}>
              <button className={f.scan ? 'on' : ''} role="radio" aria-checked={f.scan} onClick={() => void setScan(f.path, true)}>{tr('set.scanOn')}</button>
              <button className={!f.scan ? 'on' : ''} role="radio" aria-checked={!f.scan} onClick={() => void setScan(f.path, false)}>{tr('set.scanOff')}</button>
            </div>
            <button className="btn ghost" onClick={() => void remove(f.path)}><Trash2 size={15} /> {tr('set.remove')}</button>
          </div>
        </div>
      ))}
      {folders.some((f) => !f.scan) && <p className="setting-note">{tr('set.scanOffNote')}</p>}
      <div className="setting-row">
        <div>
          <b>{tr('set.hideSmall', { min: SMALL_ALBUM })}</b>
          <span>{tr('set.hideSmallText')}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('set.hideSmall', { min: SMALL_ALBUM })}>
          <button className={hideSmallAlbums ? 'on' : ''} role="radio" aria-checked={hideSmallAlbums} onClick={() => setSettings({ hideSmallAlbums: true })}>{tr('common.on')}</button>
          <button className={!hideSmallAlbums ? 'on' : ''} role="radio" aria-checked={!hideSmallAlbums} onClick={() => setSettings({ hideSmallAlbums: false })}>{tr('common.off')}</button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => void addFolder()}><FolderPlus size={16} /> {tr('lib.addFolder')}</button>
        <button className="btn" disabled={!folders.some((f) => f.scan) || status.running} onClick={() => void rescan()}>
          {status.running ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} {tr('set.rescan')}
        </button>
        <span style={{ color: 'var(--text-2)', fontSize: 12.5 }}>
          {status.running
            ? tr('set.scanProgress', { found: status.found, parsed: status.parsed })
            : status.lastScanAt
              ? tr('set.lastScan', { when: new Date(status.lastScanAt).toLocaleString(locale()) })
              : ''}
          {status.unread > 0 && <span data-scan-unread={status.unread}> {tr('set.scanPartial', { n: status.unread })}</span>}
        </span>
      </div>
    </section>
  );
}

/** Radio: where recordings go (the system's Music folder unless chosen). */
function RadioSettings() {
  const dir = useSettings((s) => s.radioRecordDir);
  const setSettings = useSettings((s) => s.set);
  const [musicDir, setMusicDir] = useState('');
  useEffect(() => {
    void window.chud.radio.musicDir().then(setMusicDir);
  }, []);
  const pick = async () => {
    const p = await window.chud.files.pickFolder();
    if (p) setSettings({ radioRecordDir: p });
  };
  return (
    <section className="settings-group panel">
      <h3>{tr('section.radio')}</h3>
      <div className="setting-row radio-rec-row">
        <div style={{ minWidth: 0 }}>
          <b>{tr('set.recDir')}</b>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dir || musicDir}>{dir || musicDir}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
          {dir && <button className="btn ghost" onClick={() => setSettings({ radioRecordDir: '' })}>{tr('set.recDirReset')}</button>}
          <button className="btn" onClick={() => void pick()}><FolderOpen size={15} /> {tr('set.recDirPick')}</button>
        </div>
      </div>
      <p style={{ marginTop: 10 }}>{tr('set.recText')}</p>
    </section>
  );
}

function PlaylistSettings() {
  const count = usePlaylists((s) => s.list.length);
  useEffect(() => void usePlaylists.getState().loadList(), []);
  /** Asked twice: what it does, then that it cannot be undone (exporting first is offered). */
  const removeAll = async () => {
    const n = usePlaylists.getState().list.length;
    if (!n) return;
    const first = await confirm({ title: tr('set.removeAllQ', { n }), body: tr('set.removeAllBody'), confirm: tr('common.continue'), danger: true });
    if (!first) return;
    const sure = await confirm({ title: tr('set.removeAllSure'), body: tr('set.removeAllSureBody', { n }), confirm: tr('set.removeAllConfirm', { n }), danger: true });
    if (!sure) return;
    const done = await window.chud.playlists.removeAll();
    await usePlaylists.getState().loadList();
    toast({ title: tr('set.removedAll', { n: done }) });
  };
  const imp = async () => {
    try {
      const n = await window.chud.playlists.importFiles();
      if (n) toast({ title: tr('pl.imported', { n }) });
    } catch (e) {
      toast({ kind: 'error', title: tr('set.importFailed'), body: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e) });
    }
  };
  return (
    <section className="settings-group panel">
      <h3>{tr('section.playlists')}</h3>
      <p>{tr('set.playlistsText')}</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void window.chud.playlists.exportAll().then((f) => f && toast({ title: tr('pls.exported'), body: f }))}><Download size={15} /> {tr('set.exportAll')}</button>
        <button className="btn" onClick={imp}><Upload size={15} /> {tr('set.import')}</button>
        <button className="btn ghost danger" disabled={!count} data-remove-all-playlists onClick={() => void removeAll()}><Trash2 size={15} /> {tr('set.removeAll')}</button>
      </div>
    </section>
  );
}

const fmtWhen = (ms: number) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? tr('when.at', { time: d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })
    : tr('when.on', { date: d.toLocaleDateString(locale(), { day: 'numeric', month: 'long' }) });
};

const ACCENTS: { color: string; key: Key }[] = [
  { color: '#c6ff2e', key: 'color.lime' },
  { color: '#ffb21f', key: 'color.amber' },
  { color: '#ff5a4f', key: 'color.coral' },
  { color: '#ff3fa4', key: 'color.magenta' },
  { color: '#9d7bff', key: 'color.violet' },
  { color: '#3fd8ff', key: 'color.cyan' },
  { color: '#1c5bcc', key: 'color.cobalt' },
  { color: '#2fbf71', key: 'color.emerald' },
];
const SCALES: [number, Key][] = [
  [0.9, 'scale.compact'],
  [1, 'scale.normal'],
  [1.1, 'scale.large'],
  [1.25, 'scale.xlarge'],
];

/** Accent colour and interface size, on top of any skin. */
function CustomSettings() {
  const { accent, uiScale, set } = useSettings();
  return (
    <section className="settings-group panel">
      <h3>{tr('set.custom')}</h3>
      <p>{tr('set.customText')}</p>
      <div className="setting-row">
        <div>
          <b>{tr('set.accent')}</b>
          <span>{tr('set.accentText')}</span>
        </div>
        <div className="accent-picker" role="radiogroup" aria-label={tr('set.accent')}>
          <button className={`accent-skin${!accent ? ' on' : ''}`} role="radio" aria-checked={!accent} onClick={() => set({ accent: null })}>
            {tr('set.skinColor')}
          </button>
          {ACCENTS.map((a) => (
            <button
              key={a.color}
              className={`accent-swatch${accent === a.color ? ' on' : ''}`}
              role="radio"
              aria-checked={accent === a.color}
              aria-label={tr(a.key)}
              title={tr(a.key)}
              style={{ background: a.color }}
              onClick={() => set({ accent: a.color })}
            />
          ))}
          <label className={`accent-swatch custom${accent && !ACCENTS.some((a) => a.color === accent) ? ' on' : ''}`} title={tr('set.otherColor')} style={accent && !ACCENTS.some((a) => a.color === accent) ? { background: accent } : undefined}>
            <input type="color" aria-label={tr('set.otherColor')} value={accent ?? '#c6ff2e'} onChange={(e) => set({ accent: e.target.value })} />
          </label>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <b>{tr('set.uiSize')}</b>
          <span>{tr('set.uiSizeText')}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('set.uiSize')}>
          {SCALES.map(([v, k]) => (
            <button key={v} className={uiScale === v ? 'on' : ''} role="radio" aria-checked={uiScale === v} onClick={() => set({ uiScale: v })}>
              {tr(k)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Output device and media keys. */
function AudioSettings() {
  const outputDevice = useSettings((s) => s.outputDevice);
  const outputLabel = useSettings((s) => s.outputLabel);
  // Listing devices wakes Chromium's capture service (~125 MB): only when the list is opened.
  const [devices, setDevices] = useState<OutputDevice[] | null>(null);
  const [keys, setKeys] = useState<{ active: boolean; registered: boolean; taken: string[] } | null>(null);
  const loadDevices = () => devices === null && void listOutputs().then(setDevices);
  useEffect(() => void window.chud.taskbar.mediaKeys().then(setKeys), []);
  const shown = devices ?? [{ id: outputDevice, label: outputDevice === 'default' ? tr('out.default') : (outputLabel ?? tr('set.chosenDevice')) }];
  const NAMES: Record<string, Key> = { MediaPlayPause: 'keys.playPause', MediaNextTrack: 'keys.next', MediaPreviousTrack: 'keys.prev', MediaStop: 'keys.stop' };
  return (
    <section className="settings-group panel">
      <h3>{tr('set.audio')}</h3>
      <div className="setting-row">
        <div>
          <b>{tr('set.output')}</b>
          <span>{tr('set.outputText')}</span>
        </div>
        <select
          className="select"
          aria-label={tr('set.output')}
          value={shown.some((d) => d.id === outputDevice) ? outputDevice : 'default'}
          onMouseDown={loadDevices}
          onFocus={loadDevices}
          onChange={(e) => void chooseOutput(e.target.value, e.target.selectedOptions[0]?.textContent ?? null)}
        >
          {shown.map((d) => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <div>
          <b>{tr('set.mediaKeys')}</b>
          <span>
            {!keys || !keys.active
              ? tr('set.mediaKeysIdle')
              : keys.registered
                ? tr('set.mediaKeysOk')
                : tr('set.mediaKeysTaken', { keys: keys.taken.map((k) => (NAMES[k] ? tr(NAMES[k]) : k)).join(', ') })}
          </span>
        </div>
        {keys?.active && <span className={`badge ${keys.registered ? 'accent' : 'warn'}`}>{keys.registered ? tr('set.mediaKeysActive') : tr('set.mediaKeysConflict')}</span>}
      </div>
    </section>
  );
}

/** How local tracks follow each other, and their volume. */
function PlaybackSettings() {
  const { gapless, crossfadeSec, replayGain, set } = useSettings();
  return (
    <section className="settings-group panel" data-settings="playback">
      <h3>{tr('set.playback')}</h3>
      <p>{tr('set.playbackText')}</p>
      <div className="setting-row">
        <div>
          <b>{tr('set.gapless')}</b>
          <span>{tr('set.gaplessText')}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('set.gapless')} data-setting="gapless">
          <button className={gapless ? 'on' : ''} role="radio" aria-checked={gapless} onClick={() => set({ gapless: true })}>{tr('common.on')}</button>
          <button className={!gapless ? 'on' : ''} role="radio" aria-checked={!gapless} onClick={() => set({ gapless: false })}>{tr('common.off')}</button>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <b>{tr('set.crossfade')}</b>
          <span>{tr('set.crossfadeText')}</span>
        </div>
        <label className="crossfade">
          <input type="range" min={0} max={MAX_CROSSFADE} step={1} value={crossfadeSec} aria-label={tr('set.crossfade')} aria-valuetext={crossfadeSec ? tr('set.seconds', { n: crossfadeSec }) : tr('common.off')} data-setting="crossfade" onChange={(e) => set({ crossfadeSec: Number(e.target.value) })} />
          <span className="lcd">{crossfadeSec ? tr('set.seconds', { n: crossfadeSec }) : tr('common.off')}</span>
        </label>
      </div>
      <div className="setting-row">
        <div>
          <b>{tr('set.replayGain')}</b>
          <span>{tr('set.replayGainText')}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('set.replayGain')} data-setting="replayGain">
          {([['off', 'common.off'], ['track', 'set.rgTrack'], ['album', 'set.rgAlbum']] as [ReplayGainMode, Key][]).map(([v, k]) => (
            <button key={v} className={replayGain === v ? 'on' : ''} role="radio" aria-checked={replayGain === v} onClick={() => set({ replayGain: v })}>{tr(k)}</button>
          ))}
        </div>
      </div>
    </section>
  );
}

function UpdateSettings() {
  const st = useUpdates((s) => s.status);
  const { autoUpdateCheck, set } = useSettings();
  if (!st) return null;
  const busy = st.state === 'checking' || st.state === 'downloading';
  const line =
    st.state === 'checking' ? tr('upd.checking')
    : st.state === 'none' ? (st.checkedAt ? tr('upd.upToDateWhen', { v: st.current, when: fmtWhen(st.checkedAt) }) : tr('upd.upToDate', { v: st.current }))
    : st.state === 'available' ? tr('upd.available', { v: st.version, current: st.current })
    : st.state === 'downloading' ? tr('upd.downloading', { v: st.version, pct: st.progress })
    : st.state === 'downloaded' ? tr('upd.ready', { v: st.version })
    : st.state === 'error' ? tr('upd.error', { error: st.error })
    : tr('upd.version', { v: st.current });

  return (
    <section className="settings-group panel">
      <h3>{tr('upd.title')}</h3>
      <p>{tr('upd.text')}</p>
      <div className="setting-row">
        <div>
          <b>
            {line} {st.state === 'available' && <span className="badge accent">{tr('upd.new')}</span>}
          </b>
          {st.state === 'downloading' && <div className="update-progress" style={{ ['--pct' as string]: `${st.progress}%` }} />}
          {st.error && st.state === 'available' && <span>{st.error}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {st.state === 'available' && (
            <button className="btn primary" onClick={() => void window.chud.updates.download()}>
              <Download size={15} /> {st.inApp ? tr('upd.update') : tr('upd.downloadGithub')}
            </button>
          )}
          {st.state === 'downloaded' && (
            <button className="btn primary" onClick={() => window.chud.updates.install()}>
              <RefreshCw size={15} /> {tr('upd.restartInstall')}
            </button>
          )}
          {st.state !== 'available' && st.state !== 'downloaded' && (
            <button className="btn" disabled={busy} onClick={() => void window.chud.updates.check()}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} {tr('upd.check')}
            </button>
          )}
          <button className="btn ghost" onClick={() => window.chud.updates.openReleases()}>
            <ExternalLink size={15} /> {tr('upd.releases')}
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <b>{tr('upd.auto')}</b>
          <span>{tr('upd.autoText')}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('upd.autoLabel')}>
          <button className={autoUpdateCheck ? 'on' : ''} role="radio" aria-checked={autoUpdateCheck} onClick={() => set({ autoUpdateCheck: true })}>{tr('common.onF')}</button>
          <button className={!autoUpdateCheck ? 'on' : ''} role="radio" aria-checked={!autoUpdateCheck} onClick={() => set({ autoUpdateCheck: false })}>{tr('common.offF')}</button>
        </div>
      </div>
    </section>
  );
}

/**
 * Artists hidden from YouTube Music searches and mixes. Folded by default: their names are only
 * shown once the person opens the list, and each one can be brought back.
 */
function HiddenArtists() {
  const hidden = useYouTube((s) => s.hidden);
  const [open, setOpen] = useState(false);
  useEffect(() => void useYouTube.getState().loadHidden(), []);
  const n = hidden?.length ?? 0;
  return (
    <>
      <div className="setting-row">
        <div>
          <b>{tr('hide.title')}</b>
          <span>{n ? tr('hide.count', { n }) : tr('hide.none')}</span>
        </div>
        <button className="btn ghost" disabled={!n} aria-expanded={open} data-hidden-artists-toggle onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {open ? tr('hide.close') : tr('hide.manage')}
        </button>
      </div>
      {open && n > 0 && (
        <div className="hidden-artists" data-hidden-artists>
          {hidden!.map((a) => (
            <div key={(a.id ?? '') + a.name} className="hidden-artist">
              <EyeOff size={14} aria-hidden />
              <span title={a.name}>{a.name}</span>
              <button className="btn ghost small" onClick={() => void useYouTube.getState().unhideArtist(a)}>
                <Eye size={13} /> {tr('hide.restore')}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function YouTubeSettings() {
  const { adblock, ytClickLock, ytLinks, set } = useSettings();
  const [st, setSt] = useState<AdblockStatus | null>(null);
  useEffect(() => {
    void window.chud.adblock.status().then(setSt);
    return window.chud.adblock.onStatus(setSt);
  }, []);

  const state = !st ? null : !st.enabled ? (
    <span className="badge">{tr('common.off')}</span>
  ) : st.waiting ? (
    <span className="badge">{tr('ab.waiting')}</span>
  ) : st.active ? (
    <span className="badge accent">{tr('ab.active')}</span>
  ) : st.error ? (
    <span className="badge warn"><CircleAlert size={11} /> {tr('ab.inactive', { error: st.error })}</span>
  ) : (
    <span className="badge"><LoaderCircle size={11} className="spin" /> {tr('ab.loading')}</span>
  );

  return (
    <section className="settings-group panel">
      <h3>YouTube Music</h3>
      <p>{tr('set.ytText')}</p>
      <div className="setting-row">
        <div>
          <b>{tr('set.ytLock')}</b>
          <span>{tr('set.ytLockText')}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('set.ytLock')}>
          <button className={ytClickLock ? 'on' : ''} role="radio" aria-checked={ytClickLock} onClick={() => set({ ytClickLock: true })}>{tr('common.on')}</button>
          <button className={!ytClickLock ? 'on' : ''} role="radio" aria-checked={!ytClickLock} onClick={() => set({ ytClickLock: false })}>{tr('common.off')}</button>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <b>{tr('set.ytLinks')}</b>
          <span>{tr('set.ytLinksText')}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('set.ytLinks')}>
          <button className={ytLinks ? 'on' : ''} role="radio" aria-checked={ytLinks} onClick={() => set({ ytLinks: true })}>{tr('common.on')}</button>
          <button className={!ytLinks ? 'on' : ''} role="radio" aria-checked={!ytLinks} onClick={() => set({ ytLinks: false })}>{tr('common.off')}</button>
        </div>
      </div>
      <HiddenArtists />
      {/* the ad blocker always last in this box, its statistics right under it */}
      <div className="setting-row adblock-row">
        <div>
          <b>{tr('ab.title')} {state}</b>
          <span>{tr('ab.text')}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label={tr('ab.title')}>
          <button className={adblock ? 'on' : ''} role="radio" aria-checked={adblock} onClick={() => set({ adblock: true })}>{tr('common.on')}</button>
          <button className={!adblock ? 'on' : ''} role="radio" aria-checked={!adblock} onClick={() => set({ adblock: false })}>{tr('common.off')}</button>
        </div>
      </div>
      {st?.enabled && st.active && (
        <dl className="kv" style={{ marginTop: 4 }}>
          <dt>{tr('ab.blocked')}</dt>
          <dd>{tr('ab.blockedValue', { n: st.blocked })}</dd>
          <dt>{tr('ab.adsSeen')}</dt>
          <dd>{st.adsSeen === 0 ? tr('ab.adsNone') : tr('ab.adsN', { n: st.adsSeen })}</dd>
          <dt>{tr('ab.lists')}</dt>
          <dd>
            {tr('ab.listsValue', { lists: tr('ab.nLists', { n: st.lists.length }), rules: tr('ab.nRules', { n: st.filters }) })}
            <span className="kv-sub">{st.lists.map((l) => l.title.replace(/^uBlock filters – /, 'uBlock : ')).join(' · ')}</span>
          </dd>
          <dt>{tr('upd.title')}</dt>
          <dd>
            {st.listsCheckedAt ? tr('ab.checkedHourlyWhen', { when: fmtWhen(st.listsCheckedAt) }) : tr('ab.checkedHourly')}
            {st.listsUpdatedAt && <> {tr('ab.lastChange', { when: fmtWhen(st.listsUpdatedAt) })}</>}
            <button className="btn ghost small" style={{ marginLeft: 8 }} disabled={st.checking} onClick={() => void window.chud.adblock.check()}>
              {st.checking ? <><LoaderCircle size={13} className="spin" /> {tr('ab.checking')}</> : tr('ab.checkNow')}
            </button>
          </dd>
        </dl>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { skin, effects, set } = useSettings();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => void window.chud.appInfo().then(setInfo), []);

  return (
    <div className="page">
      <h1 className="page-title">{tr('section.settings')}</h1>
      <p className="page-sub" style={{ marginBottom: 22 }}>{tr('set.autosave')}</p>

      <LanguageSettings />

      <LibrarySettings />

      <HomeSettings />

      <section className="settings-group panel">
        <h3>{tr('set.skin')}</h3>
        <p>{tr('set.skinText')}</p>
        <div className="skin-grid">
          {SKINS.map((s) => (
            <button key={s.id} className={`skin-card${skin === s.id ? ' active' : ''}`} onClick={() => set({ skin: s.id })} aria-pressed={skin === s.id}>
              <SkinPreview id={s.id} />
              <div className="skin-card-body">
                <b>{s.name}</b>
                <span>{tr(`skin.${s.id}`)}</span>
              </div>
              {skin === s.id && (
                <span className="skin-check">
                  <Check size={14} strokeWidth={3} />
                </span>
              )}
            </button>
          ))}
        </div>
      </section>

      <CustomSettings />

      <AudioSettings />

      <PlaybackSettings />

      <RadioSettings />

      <section className="settings-group panel">
        <h3>{tr('set.effects')}</h3>
        <p>{tr('set.effectsText')}</p>
        <div className="setting-row">
          <div>
            <b>{tr('set.effectsLevel')}</b>
            <span>{tr('set.effectsLevelText')}</span>
          </div>
          <div className="segmented" role="radiogroup">
            {(
              [
                ['full', 'fx.full'],
                ['reduced', 'fx.reduced'],
                ['off', 'fx.off'],
              ] as [EffectsLevel, Key][]
            ).map(([v, k]) => (
              <button key={v} className={effects === v ? 'on' : ''} role="radio" aria-checked={effects === v} onClick={() => set({ effects: v })}>
                {tr(k)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <PlaylistSettings />

      <YouTubeSettings />

      {window.chud.platform === 'win32' && (
        <section className="settings-group panel">
          <h3>{tr('set.defaultPlayer')}</h3>
          <p>{tr('set.defaultPlayerText')}</p>
          <button className="btn" onClick={() => window.chud.shell.openDefaultApps()}>{tr('set.openDefaultApps')}</button>
        </section>
      )}

      <UpdateSettings />

      <section className="settings-group panel">
        <h3>{tr('set.about')}</h3>
        <div className="about">
          <img src={logo} alt={tr('set.logoAlt')} width={128} height={128} draggable={false} />
          <div>
            <b>Chud Music{info ? ` ${info.version}` : ''}</b>
            <p>{tr('set.aboutText')}</p>
          </div>
        </div>
        {/* the Android app of the family (its own project and repository) */}
        <div className="about-more">
          <Smartphone size={22} aria-hidden />
          <div>
            <b>Chud Music More</b>
            <p>{tr('set.moreText')}</p>
          </div>
          <a className="btn ghost small" href="https://github.com/BigFatDeuce/Chud-Music-More" target="_blank" rel="noreferrer">
            {tr('set.moreOpen')}
          </a>
        </div>
        {info && (
          <dl className="kv">
            <dt>{tr('set.version')}</dt>
            <dd>Chud Music {info.version}</dd>
            <dt>{tr('set.engine')}</dt>
            <dd>Electron {info.electron} · Chromium {info.chrome}</dd>
            <dt>{tr('set.data')}</dt>
            <dd>{info.userData}</dd>
            <dt>{tr('set.cache')}</dt>
            <dd>{info.cache}</dd>
            <dt>{tr('common.log')}</dt>
            <dd>
              {tr('set.logText')}{' '}
              <button className="btn ghost small" onClick={() => window.chud.openLogs()}>{tr('set.openFolder')}</button>
            </dd>
          </dl>
        )}
      </section>
    </div>
  );
}
