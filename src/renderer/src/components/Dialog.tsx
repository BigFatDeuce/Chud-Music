import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { tr } from '@shared/i18n';

type DialogSpec =
  | { kind: 'prompt'; title: string; label?: string; initial?: string; confirm?: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; body?: string; confirm?: string; danger?: boolean; resolve: (v: boolean) => void };

const useDialog = create<{ spec: DialogSpec | null }>(() => ({ spec: null }));

export function prompt(o: { title: string; label?: string; initial?: string; confirm?: string }): Promise<string | null> {
  return new Promise((resolve) => useDialog.setState({ spec: { kind: 'prompt', ...o, resolve } }));
}

export function confirm(o: { title: string; body?: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => useDialog.setState({ spec: { kind: 'confirm', ...o, resolve } }));
}

export function DialogHost() {
  const spec = useDialog((s) => s.spec);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (spec?.kind === 'prompt') {
      setValue(spec.initial ?? '');
      setTimeout(() => input.current?.select(), 30);
    }
  }, [spec]);

  const close = (ok: boolean) => {
    if (!spec) return;
    if (spec.kind === 'prompt') spec.resolve(ok && value.trim() ? value.trim() : null);
    else spec.resolve(ok);
    useDialog.setState({ spec: null });
  };

  return (
    <AnimatePresence>
      {spec && (
        <motion.div className="dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
          <motion.form
            className="dialog panel"
            role="dialog"
            aria-modal="true"
            aria-label={spec.title}
            initial={{ scale: 0.98, y: 6 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onSubmit={(e) => {
              e.preventDefault();
              close(true);
            }}
            onKeyDown={(e) => e.key === 'Escape' && close(false)}
          >
            <h3>{spec.title}</h3>
            {spec.kind === 'prompt' ? (
              <label className="field">
                {spec.label && <span>{spec.label}</span>}
                <input ref={input} value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} autoFocus />
              </label>
            ) : (
              spec.body && <p style={{ whiteSpace: 'pre-line' }}>{spec.body}</p>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={() => close(false)}>
                {tr('common.cancel')}
              </button>
              <button type="submit" className={`btn ${spec.kind === 'confirm' && spec.danger ? 'danger' : 'primary'}`} disabled={spec.kind === 'prompt' && !value.trim()} autoFocus={spec.kind === 'confirm'}>
                {spec.confirm ?? tr('common.ok')}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
