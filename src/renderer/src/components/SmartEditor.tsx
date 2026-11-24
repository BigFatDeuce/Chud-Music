import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { Plus, X } from 'lucide-react';
import type { PlaylistSummary } from '@shared/types';
import { defaultRule, needsValue, opsOf, presetSpec, SMART_FIELDS, SMART_ORDERS, type SmartField, type SmartOp, type SmartOrder, type SmartPreset, type SmartRule, type SmartSpec } from '@shared/smart';
import { useLibrary } from '@/store/library';
import { usePlaylists } from '@/store/playlists';
import { useTabs } from '@/store/tabs';
import { toast } from '@/store/toasts';
import { fmtTotal } from '@/lib/format';
import { tr, type Key } from '@shared/i18n';

// Smart playlists: created from a ready-made one or from scratch, and changed later. The preview
// is the real query, run on each change.

interface EditorState {
  open: { id: number | null; name: string; spec: SmartSpec } | null;
}
const useEditor = create<EditorState>(() => ({ open: null }));

export function newSmart(preset: SmartPreset, days?: number): void {
  const name = preset === 'custom' ? tr('smart.new') : tr(`smart.preset.${preset}` as Key);
  useEditor.setState({ open: { id: null, name, spec: presetSpec(preset, days) } });
}
export function editSmart(p: PlaylistSummary): void {
  if (p.smart) useEditor.setState({ open: { id: p.id, name: p.name, spec: p.smart } });
}
/** One of the ready-made ones, created at once (its rules can be changed afterwards). */
export async function createPreset(preset: SmartPreset, days?: number): Promise<void> {
  const id = await window.chud.playlists.createSmart(tr(`smart.preset.${preset}` as Key), presetSpec(preset, days));
  await usePlaylists.getState().loadList();
  useTabs.getState().openPlaylist(id);
}

const FIELD: Record<SmartField, Key> = { genre: 'smart.f.genre', artist: 'smart.f.artist', album: 'smart.f.album', title: 'smart.f.title', folder: 'smart.f.folder', year: 'smart.f.year', plays: 'smart.f.plays', added: 'smart.f.added', played: 'smart.f.played', duration: 'smart.f.duration' };
const ORDER: Record<SmartOrder, Key> = { added: 'smart.f.added', plays: 'smart.f.plays', played: 'smart.f.played', title: 'smart.f.title', artist: 'smart.f.artist', album: 'smart.f.album', year: 'smart.f.year', duration: 'smart.f.duration', random: 'smart.o.random' };
const opLabel = (f: SmartField, op: SmartOp): string => tr(`smart.op.${(f === 'added' || f === 'played') && op === 'before' ? 'before' : op}` as Key);
const unit = (f: SmartField): string => (f === 'added' || f === 'played' ? tr('smart.days') : f === 'duration' ? tr('smart.minutes') : '');
/** Days offered beside the number, for the dates. */
const SPANS: [number, Key][] = [
  [30, 'smart.span.month'],
  [182, 'smart.span.halfYear'],
  [365, 'smart.span.year'],
];

function RuleRow({ rule, genres, onChange, onRemove }: { rule: SmartRule; genres: string[]; onChange: (r: SmartRule) => void; onRemove: () => void }) {
  const text = opsOf(rule.field).includes('contains');
  const date = rule.field === 'added' || rule.field === 'played';
  return (
    <div className="smart-rule">
      <select className="select" aria-label={tr('smart.field')} value={rule.field} onChange={(e) => onChange(defaultRule(e.target.value as SmartField))}>
        {SMART_FIELDS.map((f) => <option key={f} value={f}>{tr(FIELD[f])}</option>)}
      </select>
      <select
        className="select"
        aria-label={tr('smart.condition')}
        value={rule.op}
        onChange={(e) => {
          const op = e.target.value as SmartOp;
          onChange({ ...rule, op, value: needsValue(op) ? (rule.value ?? (text ? '' : date ? 182 : 0)) : null });
        }}
      >
        {opsOf(rule.field).map((op) => <option key={op} value={op}>{opLabel(rule.field, op)}</option>)}
      </select>
      {needsValue(rule.op) ? (
        <span className="smart-value">
          <input
            className="input"
            aria-label={tr('smart.value')}
            type={text ? 'text' : 'number'}
            min={0}
            step={rule.field === 'duration' ? 0.5 : 1}
            list={rule.field === 'genre' ? 'smart-genres' : undefined}
            value={rule.value ?? ''}
            onChange={(e) => onChange({ ...rule, value: text ? e.target.value : e.target.value === '' ? null : Number(e.target.value) })}
          />
          {unit(rule.field) && <span>{unit(rule.field)}</span>}
          {date && SPANS.map(([n, k]) => (
            <button key={n} type="button" className={`chip${rule.value === n ? ' on' : ''}`} onClick={() => onChange({ ...rule, value: n })}>{tr(k)}</button>
          ))}
        </span>
      ) : <span className="smart-value" />}
      <button type="button" className="icon-btn" aria-label={tr('smart.removeRule')} title={tr('smart.removeRule')} onClick={onRemove}><X size={15} /></button>
      {rule.field === 'genre' && <datalist id="smart-genres">{genres.map((g) => <option key={g} value={g} />)}</datalist>}
    </div>
  );
}

export function SmartEditorHost() {
  const open = useEditor((s) => s.open);
  return <AnimatePresence>{open && <Editor key={open.id ?? 'new'} {...open} />}</AnimatePresence>;
}

function Editor({ id, name: name0, spec: spec0 }: { id: number | null; name: string; spec: SmartSpec }) {
  const [name, setName] = useState(name0);
  const [spec, setSpec] = useState(spec0);
  const [preview, setPreview] = useState<{ count: number; durationSec: number; sample: { title: string; artist: string | null }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const tracks = useLibrary((s) => s.tracks);
  const genres = useMemo(() => [...new Set(tracks.map((t) => t.genre).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)).slice(0, 500), [tracks]);
  useEffect(() => first.current?.select(), []);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => void window.chud.playlists.previewSmart(spec).then((p) => live && setPreview(p), () => {}), 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [spec]);

  const close = () => useEditor.setState({ open: null });
  const patch = (p: Partial<SmartSpec>) => setSpec({ ...spec, ...p });
  const rules = (key: 'rules' | 'exclude') => (
    <>
      {spec[key].map((r, i) => (
        <RuleRow key={i} rule={r} genres={genres} onChange={(n) => patch({ [key]: spec[key].map((x, k) => (k === i ? n : x)) })} onRemove={() => patch({ [key]: spec[key].filter((_, k) => k !== i) })} />
      ))}
      <button type="button" className="btn ghost small" data-smart-add={key} onClick={() => patch({ [key]: [...spec[key], defaultRule('genre')] })}>
        <Plus size={14} /> {tr(key === 'rules' ? 'smart.addRule' : 'smart.addExclusion')}
      </button>
    </>
  );
  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      if (id === null) {
        const made = await window.chud.playlists.createSmart(name, spec);
        await usePlaylists.getState().loadList();
        close();
        useTabs.getState().openPlaylist(made);
      } else {
        if (name.trim() !== name0) await window.chud.playlists.rename(id, name);
        await window.chud.playlists.setSmart(id, spec);
        close();
      }
    } catch (e) {
      setBusy(false);
      toast({ kind: 'error', title: tr('smart.saveFailed'), body: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e) });
    }
  };

  return (
    <motion.div className="dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form
        className="dialog panel smart-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr('smart.title')}
        initial={{ scale: 0.98, y: 6 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.98, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          e.stopPropagation(); // the app's shortcuts stay out of the fields
          if (e.key === 'Escape') close();
        }}
      >
        <h3>{tr('smart.title')}</h3>
        <label className="field">
          <span>{tr('common.name')}</span>
          <input ref={first} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <div className="smart-scroll">
          <div className="smart-head">
            <b>{tr('smart.rules')}</b>
            <div className="segmented" role="radiogroup" aria-label={tr('smart.match')}>
              <button type="button" role="radio" aria-checked={spec.match === 'all'} className={spec.match === 'all' ? 'on' : ''} onClick={() => patch({ match: 'all' })}>{tr('smart.all')}</button>
              <button type="button" role="radio" aria-checked={spec.match === 'any'} className={spec.match === 'any' ? 'on' : ''} onClick={() => patch({ match: 'any' })}>{tr('smart.any')}</button>
            </div>
          </div>
          {rules('rules')}
          <div className="smart-head"><b>{tr('smart.exclusions')}</b></div>
          {rules('exclude')}
          {spec.excludeIds.length > 0 && (
            <div className="smart-note">
              {tr('smart.excludedByHand', { n: spec.excludeIds.length })}{' '}
              <button type="button" className="btn ghost small" onClick={() => patch({ excludeIds: [] })}>{tr('smart.bringBack')}</button>
            </div>
          )}
          <div className="smart-head"><b>{tr('smart.order')}</b></div>
          <div className="smart-rule">
            <select className="select" aria-label={tr('smart.order')} value={spec.order} onChange={(e) => patch({ order: e.target.value as SmartOrder })}>
              {SMART_ORDERS.map((o) => <option key={o} value={o}>{tr(ORDER[o])}</option>)}
            </select>
            <select className="select" aria-label={tr('smart.direction')} disabled={spec.order === 'random'} value={spec.desc ? 'desc' : 'asc'} onChange={(e) => patch({ desc: e.target.value === 'desc' })}>
              <option value="asc">{tr('smart.asc')}</option>
              <option value="desc">{tr('smart.desc')}</option>
            </select>
            <label className="smart-value">
              <span>{tr('smart.limit')}</span>
              <input className="input" type="number" min={1} aria-label={tr('smart.limit')} placeholder={tr('smart.noLimit')} value={spec.limit ?? ''} onChange={(e) => patch({ limit: Number(e.target.value) >= 1 ? Math.floor(Number(e.target.value)) : null })} />
            </label>
          </div>
        </div>
        <p className="smart-preview" data-smart-count={preview?.count ?? ''}>
          {preview ? (
            <>
              <b>{tr('n.tracks', { n: preview.count })}{preview.durationSec > 0 && ` · ${fmtTotal(preview.durationSec)}`}</b>
              {preview.sample.length > 0 && <span>{preview.sample.map((t) => t.title + (t.artist ? ` — ${t.artist}` : '')).join(' · ')}</span>}
            </>
          ) : tr('common.loading')}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={close}>{tr('common.cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{id === null ? tr('common.create') : tr('smart.save')}</button>
        </div>
      </motion.form>
    </motion.div>
  );
}
