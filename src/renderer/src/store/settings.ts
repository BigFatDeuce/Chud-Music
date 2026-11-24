import { create } from 'zustand';
import { DEFAULT_SETTINGS, type Settings } from '@shared/types';

interface SettingsState extends Settings {
  loaded: boolean;
  load(): Promise<void>;
  set(patch: Partial<Settings>): void;
}

/** Readable text on a colour: black or white, whichever contrasts more. */
function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return l > 0.179 ? '#0b0d10' : '#ffffff';
}

function apply(s: Settings): void {
  const root = document.documentElement;
  root.dataset.skin = s.skin;
  root.dataset.effects = s.effects;
  // custom accent: overrides the skin's, on the root only (skin previews keep their own)
  if (s.accent && /^#[0-9a-f]{6}$/i.test(s.accent)) {
    root.style.setProperty('--accent', s.accent);
    root.style.setProperty('--accent-ink', inkFor(s.accent));
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${s.accent} 15%, transparent)`);
  } else {
    for (const p of ['--accent', '--accent-ink', '--accent-soft']) root.style.removeProperty(p);
  }
  window.chud.setZoom(s.uiScale || 1);
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    const s = await window.chud.settings.get();
    apply(s);
    set({ ...s, loaded: true });
  },
  set(patch) {
    set(patch);
    const { loaded: _l, load: _ld, set: _s, ...current } = get();
    apply(current);
    void window.chud.settings.set(patch);
  },
}));
