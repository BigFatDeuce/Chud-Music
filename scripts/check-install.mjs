// Checks a real installation of Chud Music on this Windows machine. Read-only: it only reads the
// registry and the file system, and changes nothing.  npm run check:install
//   --open   also opens a test file the way a double-click in Explorer does (Windows' default
//            program for .mp3), to see that it reaches Chud Music.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

if (process.platform !== 'win32') {
  console.log('Windows uniquement.');
  process.exit(0);
}
const EXTS = ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'wv', 'ape', 'ac3', 'mka'];
const reg = (key, value) => {
  try {
    const out = execFileSync('reg', ['query', key, ...(value === undefined ? [] : value === '' ? ['/ve'] : ['/v', value])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out;
  } catch {
    return null;
  }
};
const val = (key, value) => {
  const out = reg(key, value);
  const m = out && /REG_\w+\s+(.*)$/m.exec(out);
  return m ? m[1].trim() : null;
};
let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'OK   ' : 'ÉCHEC'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// 1. installed?
const uninstallRoot = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const keys = (reg(uninstallRoot) ?? '').split(/\r?\n/).filter((l) => l.startsWith('HKEY'));
const entry = keys.find((k) => val(k, 'DisplayName')?.startsWith('Chud Music'));
check('Chud Music est installé (pour cet utilisateur)', !!entry);
if (!entry) process.exit(1);
const version = val(entry, 'DisplayVersion');
// electron-builder does not always write InstallLocation: fall back to the uninstaller's folder
const fromPath = (v) => v && dirname(v.replace(/^"|".*$|,d+$/g, '').trim());
const dir = val(entry, 'InstallLocation') || fromPath(val(entry, 'UninstallString')) || fromPath(val(entry, 'DisplayIcon'));
const exe = dir && join(dir, 'Chud Music.exe');
const built = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
check('version installée', !!version, `${version}${version !== built ? ` (le projet est en ${built} : réinstallez pour tester la dernière version)` : ''}`);
check('exécutable présent', !!exe && existsSync(exe), exe ?? '');
check('FFmpeg embarqué', !!dir && existsSync(join(dir, 'resources', 'ffmpeg', 'ffmpeg.exe')));
check('mises à jour configurées (app-update.yml)', !!dir && existsSync(join(dir, 'resources', 'app-update.yml')));

// 2. file associations, "Default apps" registration, "Open with"
let assoc = 0;
const missing = [];
for (const ext of EXTS) {
  const progids = reg(`HKCU\\Software\\Classes\\.${ext}\\OpenWithProgids`) ?? '';
  const cmd = val(`HKCU\\Software\\Classes\\ChudMusic.${ext}\\shell\\open\\command`, '');
  if (progids.includes(`ChudMusic.${ext}`) && cmd?.toLowerCase().includes('chud music.exe')) assoc++;
  else missing.push(ext);
}
check(`associations de fichiers (${assoc}/${EXTS.length})`, assoc === EXTS.length, missing.length ? `manquent : ${missing.join(', ')}` : '');
const caps = val('HKCU\\Software\\RegisteredApplications', 'Chud Music');
check('déclaré dans « Applications par défaut »', !!caps, caps ?? '');
const capsCount = (reg('HKCU\\Software\\Clients\\Media\\Chud Music\\Capabilities\\FileAssociations') ?? '').split(/\r?\n/).filter((l) => /ChudMusic\./.test(l)).length;
check('formats proposés à Windows', capsCount === EXTS.length, `${capsCount}/${EXTS.length}`);
check('présent dans « Ouvrir avec »', !!val('HKCU\\Software\\Classes\\Applications\\Chud Music.exe\\shell\\open\\command', ''));

// 3. which program Windows actually uses (the user's choice: Windows never lets an installer set it)
const defaults = EXTS.map((ext) => [ext, val(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${ext}\\UserChoice`, 'ProgId')]);
const ours = defaults.filter(([, p]) => p?.startsWith('ChudMusic.')).map(([e]) => e);
console.log(`INFO   formats ouverts par Chud Music au double-clic : ${ours.length ? ours.join(', ') : 'aucun (choisissez Chud Music dans Paramètres Windows › Applications par défaut)'}`);
const others = defaults.filter(([, p]) => p && !p.startsWith('ChudMusic.'));
if (others.length) console.log(`INFO   autres programmes par défaut : ${others.map(([e, p]) => `.${e} → ${p}`).join(', ')}`);

// 4. user data outside the install folder
const data = join(process.env.APPDATA ?? '', 'Chud Music');
check('données utilisateur hors du dossier d’installation', !!dir && !resolve(data).toLowerCase().startsWith(resolve(dir).toLowerCase()), data);
check('base de données présente', existsSync(join(data, 'chud.db')));

// 5. optional: open a file like a double-click
if (process.argv.includes('--open')) {
  const file = resolve('tests/fixtures/music/01 - Minuit Chrome.mp3');
  console.log(`INFO   ouverture de « ${file} » comme un double-clic (programme par défaut de .mp3)…`);
  spawn('cmd', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore' }).unref();
  console.log('INFO   vérifiez que Chud Music s’ouvre (ou s’affiche) avec ce fichier dans « Fichiers ouverts ».');
}

console.log(fails ? `\n${fails} point(s) en échec.` : '\nInstallation correcte.');
process.exit(fails ? 1 : 0);
