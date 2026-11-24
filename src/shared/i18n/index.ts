// Interface languages. French is the reference catalogue (every key exists there); each other
// language has the same keys (`tr` rather than `t`: `t` is a track in much of the code)
// — TypeScript refuses a catalogue with a missing or unknown key.
// Plural forms follow Intl.PluralRules of the language (Russian: one/few/many; Japanese,
// Chinese, Korean: other only). Shared by the main process and the interface.
//
// Not offered: right-to-left languages (Arabic, Hebrew, Persian): the whole layout, the player
// bar and the drawn effects are built left-to-right.
import fr from './locales/fr';
import en from './locales/en';
import es from './locales/es';
import de from './locales/de';
import it from './locales/it';
import pt from './locales/pt';
import ru from './locales/ru';
import ja from './locales/ja';
import zh from './locales/zh';
import ko from './locales/ko';

export type Plural = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Msg = string | Plural;
export type Key = keyof typeof fr;
export type Catalog = Record<Key, Msg>;

/** The languages offered, in their own name. `locale`: what Intl formats dates and numbers with. */
export const LANGS = [
  { code: 'fr', name: 'Français', locale: 'fr-FR' },
  { code: 'en', name: 'English', locale: 'en-US' },
  { code: 'es', name: 'Español', locale: 'es-ES' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'it', name: 'Italiano', locale: 'it-IT' },
  { code: 'pt', name: 'Português (Brasil)', locale: 'pt-BR' },
  { code: 'ru', name: 'Русский', locale: 'ru-RU' },
  { code: 'ja', name: '日本語', locale: 'ja-JP' },
  { code: 'zh', name: '简体中文', locale: 'zh-CN' },
  { code: 'ko', name: '한국어', locale: 'ko-KR' },
] as const;
export type Lang = (typeof LANGS)[number]['code'];
export type LangPref = 'system' | Lang;

const CATALOGS: Record<Lang, Catalog> = { fr, en, es, de, it, pt, ru, ja, zh, ko };

let lang: Lang = 'fr';
let rules = new Intl.PluralRules('fr-FR');
let numbers = new Intl.NumberFormat('fr-FR');

export const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.code === v);

/**
 * The language to use: the one chosen, or the first system language offered here
 * (Traditional Chinese is not Simplified Chinese: it falls through to the next one), else English.
 */
export function resolveLang(pref: LangPref | undefined, system: readonly string[]): Lang {
  if (pref && pref !== 'system' && isLang(pref)) return pref;
  for (const tag of system) {
    const t = tag.toLowerCase();
    const base = t.split(/[-_]/)[0]!;
    if (base === 'zh') {
      if (/hant|-tw|-hk|-mo/.test(t)) continue;
      return 'zh';
    }
    if (isLang(base)) return base;
  }
  return 'en';
}

export function setLang(l: Lang): void {
  lang = l;
  const loc = locale();
  rules = new Intl.PluralRules(loc);
  numbers = new Intl.NumberFormat(loc);
}

export const getLang = (): Lang => lang;

/** BCP 47 tag of the current language, for Intl (dates, numbers, collation, country names). */
export function locale(): string {
  return LANGS.find((l) => l.code === lang)!.locale;
}

/**
 * The text of `key` in the current language. `{name}` placeholders take `vars.name` (numbers
 * formatted for the language). A plural entry picks its form from `vars.n`.
 */
export function tr(key: Key, vars?: Record<string, string | number | null | undefined>): string {
  const m: Msg = CATALOGS[lang][key] ?? fr[key];
  let s: string;
  if (typeof m === 'string') s = m;
  else {
    const n = Number(vars?.n ?? 0);
    s = (n === 0 && m.zero) || m[rules.select(n) as keyof Plural] || m.other;
  }
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (all, k: string) => {
    const v = vars[k];
    if (v == null) return all;
    return typeof v === 'number' ? numbers.format(v) : v;
  });
}

// In the interface, the language comes from the preload (resolved by the main process) before
// any other module runs: texts computed when a module loads are already in the right language.
const fromPreload = (globalThis as { chud?: { lang?: unknown } }).chud?.lang;
if (isLang(fromPreload)) setLang(fromPreload);
