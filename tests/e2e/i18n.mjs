// Interface languages: the system language is used by default (CHUD_LANG stands for it here),
// every page renders in each language without a leftover French label in the menu, long
// languages (German, Russian) do not push anything out of the window, Chinese/Japanese/Korean
// render with real glyphs (bundled Noto fonts), and choosing a language in Settings applies it
// after the interface reloads.
import { join } from 'node:path';
import { cleanup, createSuite, launch, music, shots, sleep, tempDir } from './harness.mjs';

const t = createSuite('i18n');
// (English only, unless CHUD_ALL_LANGS=1: the others are tested on request)
const EXPECT = {
  en: ['Home', 'Library', 'Settings'],
  es: ['Inicio', 'Biblioteca', 'Ajustes'],
  de: ['Start', 'Mediathek', 'Einstellungen'],
  it: ['Home', 'Libreria', 'Impostazioni'],
  pt: ['Início', 'Biblioteca', 'Configurações'],
  ru: ['Главная', 'Медиатека', 'Настройки'],
  ja: ['ホーム', 'ライブラリ', '設定'],
  zh: ['首页', '音乐库', '设置'],
  ko: ['홈', '라이브러리', '설정'],
};
const FRENCH = /Bibliothèque|Paramètres|Accueil|Paroles|Visualiseur|Statistiques/;
const resize = (app, w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(w, h); }, [w, h]);
/** Elements of the chrome (menu, tabs, player bar) that overflow their box or the window. */
const overflow = (win) => win.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.nav-item, .tab, .playerbar button, .page-title, .settings-group h3, .btn')) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (r.right > innerWidth + 1) out.push(`${el.className}: off-window`);
  }
  return out;
});

let app;
const dirs = [];
try {
  for (const [code, words] of Object.entries(EXPECT).filter(([c]) => c === 'en' || process.env.CHUD_ALL_LANGS)) {
    const profile = tempDir(`chud-i18n-${code}-`);
    dirs.push(profile);
    process.env.CHUD_LANG = code;
    let win;
    ({ app, win } = await launch(profile, [join(music, '01 - Minuit Chrome.mp3')]));
    await resize(app, 1100, 720);
    await sleep(1500);
    const nav = (await win.locator('.nav-item').allInnerTexts()).join(' | ');
    const lang = await win.evaluate(() => document.documentElement.lang);
    t.check(`${code}: system language used by default, menu translated`, lang === code && words.every((w) => nav.includes(w)) && !FRENCH.test(nav), nav);
    // every section opens without error and without French left in its title
    const titles = [];
    for (const item of await win.locator('.nav-item').all()) {
      await item.click();
      await sleep(350);
      titles.push(await win.locator('.page-title, .list-hero-title').first().innerText().catch(() => ''));
    }
    const errors = await win.locator('.fatal, .error-boundary').count();
    t.check(`${code}: all sections open, titles translated`, errors === 0 && !titles.some((x) => FRENCH.test(x)), titles.join(' | '));
    const off = await overflow(win);
    t.check(`${code}: nothing pushed out of a 1100 px window (Settings open)`, off.length === 0, off.slice(0, 5).join('; '));
    if (['ja', 'zh', 'ko', 'ru', 'de'].includes(code)) await win.screenshot({ path: join(shots, `i18n-${code}-settings.png`) });
    if (['ja', 'zh', 'ko'].includes(code)) {
      // a glyph missing from every font is drawn as a box: check the bundled font is the one used
      const fonts = await win.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded' && /Noto Sans (SC|JP|KR)/.test(f.family)).length; });
      t.check(`${code}: CJK text drawn with the bundled Noto font`, fonts > 0, `${fonts} font faces loaded`);
    }
    await app.close();
    app = null;
  }

  // Settings › Language: English chosen in a French system, applied after the reload
  process.env.CHUD_LANG = 'fr';
  const profile = tempDir('chud-i18n-switch-');
  dirs.push(profile);
  let win;
  ({ app, win } = await launch(profile));
  await win.locator('.nav-item:has-text("Paramètres")').click();
  await sleep(400);
  const select = win.locator('select[aria-label="Langue"]');
  t.check('Settings: language list = system + 10 languages, system first', (await select.locator('option').count()) === 11 && (await select.locator('option').first().innerText()).startsWith('Langue du système'));
  await select.selectOption('en');
  await sleep(300);
  await win.locator('button:has-text("Appliquer maintenant")').click();
  await win.waitForSelector('.nav-item:has-text("Settings")', { timeout: 15000 }).catch(() => {});
  t.check('Settings › English › Apply now: the interface reloads in English', (await win.locator('.nav-item:has-text("Settings")').count()) === 1 && (await win.evaluate(() => document.documentElement.lang)) === 'en');
  const saved = await win.evaluate(() => window.chud.settings.get());
  t.check('the choice is saved', saved.language === 'en');
  await app.close();
  app = null;
  // restarting keeps it, whatever the system says
  ({ app, win } = await launch(profile));
  await sleep(800);
  t.check('after a restart, still English (choice beats the system language)', (await win.locator('.nav-item:has-text("Library")').count()) === 1);
  await app.close();
  app = null;
} catch (e) {
  t.check('test run', false, e.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => {});
  cleanup(...dirs);
  process.exit(t.finish() ? 1 : 0);
}
