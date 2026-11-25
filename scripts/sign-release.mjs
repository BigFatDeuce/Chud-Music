// Signs the two in-app installers of dist/ (Windows setup, Linux AppImage) with the release key,
// writing "<installer>.sig" beside each. Chud Music checks it before installing an update
// (src/main/update-signature.ts). Usage, after both builds and before publish-release.mjs:
//   node scripts/sign-release.mjs
// The private key is NOT in the project (never commit or publish it): by default
// %USERPROFILE%/.chud-music-release/update-signing-key.pem, or the path in CHUD_SIGNING_KEY.
// Losing it means the installed copies refuse every later in-app update (manual download only).
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.CHUD_SIGN_DIST ?? join(root, 'dist');
const keyFile = process.env.CHUD_SIGNING_KEY ?? join(homedir(), '.chud-music-release', 'update-signing-key.pem');
const privateKey = createPrivateKey(readFileSync(keyFile, 'utf8'));
// the key the app carries: a signature it cannot check is worse than none
const src = readFileSync(join(root, 'src', 'main', 'update-signature.ts'), 'utf8');
const pem = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(src)?.[0];
if (!pem) throw new Error('no public key in src/main/update-signature.ts');
const appKey = createPublicKey(pem);
if (!createPublicKey(privateKey).equals(appKey)) throw new Error(`${keyFile} is not the key built into the app`);

const message = (version, sha512) => Buffer.from(`chud-music-update:v1\n${version}\n${sha512}\n`, 'utf8');
for (const yml of ['latest.yml', 'latest-linux.yml']) {
  const text = readFileSync(join(dist, yml), 'utf8');
  const version = /^version: *(\S+)/m.exec(text)?.[1];
  const file = /^path: *(\S+)/m.exec(text)?.[1];
  const sha512 = /^sha512: *(\S+)/m.exec(text)?.[1];
  if (!version || !file || !sha512) throw new Error(`${yml}: version, path or sha512 missing`);
  const actual = createHash('sha512').update(readFileSync(join(dist, file))).digest('base64');
  if (actual !== sha512) throw new Error(`${yml}: ${file} does not match its SHA-512`);
  const sig = sign(null, message(version, sha512), privateKey).toString('base64');
  if (!verify(null, message(version, sha512), appKey, Buffer.from(sig, 'base64'))) throw new Error('signature check failed');
  writeFileSync(join(dist, `${file}.sig`), `${sig}\n`);
  console.log(`signed ${file} (${version})`);
}
