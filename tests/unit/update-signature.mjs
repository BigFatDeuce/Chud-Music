// Our signature of the in-app updates (src/main/update-signature.ts), without the app: the right
// signature is accepted, anything else (other key, other version, other file, truncated, empty,
// not base64) is refused; and scripts/sign-release.mjs signs exactly what the app checks.
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcFile = new URL('../../src/main/update-signature.ts', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'chud-sig-'));
const file = join(dir, 'update-signature.mjs');
writeFileSync(file, stripTypeScriptTypes(readFileSync(srcFile, 'utf8')));
const { verifyUpdate, signedMessage, sha512File, UPDATE_PUBLIC_KEY } = await import(pathToFileURL(file).href);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

try {
  const pair = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey };
  };
  const k = pair();
  const other = pair();
  const installer = join(dir, 'Chud-Music-Setup-9.9.0.exe');
  writeFileSync(installer, Buffer.alloc(3_000_000, 7));
  const sha = await sha512File(installer);
  check('SHA-512 in base64, as latest.yml writes it', sha === createHash('sha512').update(readFileSync(installer)).digest('base64'));
  const sig = sign(null, signedMessage('9.9.0', sha), k.priv).toString('base64');

  check('our signature is accepted', verifyUpdate('9.9.0', sha, sig, k.pub));
  check('the .sig file may end with a newline', verifyUpdate('9.9.0', sha, `${sig}\n`, k.pub));
  check('signed by another key: refused', !verifyUpdate('9.9.0', sha, sign(null, signedMessage('9.9.0', sha), other.priv).toString('base64'), k.pub));
  check('another version (an old installer offered as new): refused', !verifyUpdate('9.9.1', sha, sig, k.pub));
  writeFileSync(installer, Buffer.alloc(3_000_000, 8));
  check('another file with the same signature: refused', !verifyUpdate('9.9.0', await sha512File(installer), sig, k.pub));
  const flipped = Buffer.from(sig, 'base64');
  flipped[10] ^= 1;
  check('one bit changed in the signature: refused', !verifyUpdate('9.9.0', sha, flipped.toString('base64'), k.pub));
  for (const [name, bad] of [['empty', ''], ['truncated', sig.slice(0, 40)], ['not base64', '!'.repeat(88)], ['an HTML error page', '<html>Not Found</html>'], ['too long', sig + sig]]) {
    check(`signature ${name}: refused`, !verifyUpdate('9.9.0', sha, bad, k.pub));
  }
  check('empty version or hash: refused', !verifyUpdate('', sha, sig, k.pub) && !verifyUpdate('9.9.0', '', sig, k.pub));
  check('a broken public key refuses instead of throwing', !verifyUpdate('9.9.0', sha, sig, 'not a key'));
  check('the built-in key is a real Ed25519 key, not the test one', /-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]{60}\n-----END PUBLIC KEY-----/.test(UPDATE_PUBLIC_KEY) && !verifyUpdate('9.9.0', sha, sig));

  // scripts/sign-release.mjs on a fake dist/, with a test key: what it writes is what the app accepts
  const dist = join(dir, 'dist');
  mkdirSync(dist, { recursive: true });
  const setup = join(dist, 'Chud-Music-Setup-9.9.0.exe');
  const appimage = join(dist, 'Chud-Music-9.9.0-x86_64.AppImage');
  writeFileSync(setup, 'windows installer');
  writeFileSync(appimage, 'linux appimage');
  const yml = (f) => {
    const h = createHash('sha512').update(readFileSync(f)).digest('base64');
    return `version: 9.9.0\nfiles:\n  - url: ${f.split(/[\\/]/).pop()}\n    sha512: ${h}\npath: ${f.split(/[\\/]/).pop()}\nsha512: ${h}\n`;
  };
  writeFileSync(join(dist, 'latest.yml'), yml(setup));
  writeFileSync(join(dist, 'latest-linux.yml'), yml(appimage));
  const script = fileURLToPath(new URL('../../scripts/sign-release.mjs', import.meta.url));
  const keyFile = join(dir, 'test-key.pem');
  writeFileSync(keyFile, k.priv.export({ type: 'pkcs8', format: 'pem' }));
  let refused = '';
  try {
    execFileSync(process.execPath, [script], { env: { ...process.env, CHUD_SIGNING_KEY: keyFile, CHUD_SIGN_DIST: dist }, stdio: 'pipe' });
  } catch (e) {
    refused = String(e.stderr);
  }
  check('sign-release refuses a key that is not the one built into the app', /not the key built into the app/.test(refused), refused.split('\n')[0]);
  // the same check with the app's key replaced by the test key, in a copy of the script's tree
  const tree = join(dir, 'tree');
  for (const d of ['scripts', 'src/main']) mkdirSync(join(tree, d), { recursive: true });
  writeFileSync(join(tree, 'scripts', 'sign-release.mjs'), readFileSync(script));
  writeFileSync(join(tree, 'src', 'main', 'update-signature.ts'), readFileSync(srcFile, 'utf8').replace(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----\n/, k.pub));
  execFileSync(process.execPath, [join(tree, 'scripts', 'sign-release.mjs')], { env: { ...process.env, CHUD_SIGNING_KEY: keyFile, CHUD_SIGN_DIST: dist }, stdio: 'pipe' });
  for (const f of [setup, appimage]) {
    check(`sign-release output accepted by the app (${f.split(/[\\/]/).pop()})`, verifyUpdate('9.9.0', await sha512File(f), readFileSync(`${f}.sig`, 'utf8'), k.pub));
  }
  writeFileSync(setup, 'windows installer, changed after latest.yml');
  let stale = '';
  try {
    execFileSync(process.execPath, [join(tree, 'scripts', 'sign-release.mjs')], { env: { ...process.env, CHUD_SIGNING_KEY: keyFile, CHUD_SIGN_DIST: dist }, stdio: 'pipe' });
  } catch (e) {
    stale = String(e.stderr);
  }
  check('sign-release refuses a file that does not match latest.yml', /does not match its SHA-512/.test(stale), stale.split('\n')[0]);
} catch (e) {
  check('test run', false, e.stack);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n[update-signature] ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
