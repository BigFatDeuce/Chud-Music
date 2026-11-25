// Our own signature of each update (Ed25519). electron-updater checks the downloaded installer
// against the SHA-512 in latest.yml, but latest.yml sits next to the installer on GitHub: whoever
// can publish a release can change both. So each in-app installer also gets a signature made with
// a private key that never leaves the publisher's PC (scripts/sign-release.mjs), published beside
// it as "<installer>.sig", and checked here with the public key built into the app before the
// update is offered for install. No signature, or a wrong one: nothing is installed.
//
// Only node:crypto here, so tests/unit/update-signature.mjs loads this file without the app.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** The public half of the release key (the private one is not in the project). */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbdjL2/6psJr0VPe2fCunMYLgCpZ1XbbTHKLvnBG05VM=
-----END PUBLIC KEY-----
`;

/** What is signed: the version and the installer's SHA-512 (base64, as in latest.yml). */
export function signedMessage(version: string, sha512: string): Buffer {
  return Buffer.from(`chud-music-update:v1\n${version}\n${sha512}\n`, 'utf8');
}

/** True only when `signature` (base64, the content of the .sig file) is ours for this version and hash. */
export function verifyUpdate(version: string, sha512: string, signature: string, publicKey: string = UPDATE_PUBLIC_KEY): boolean {
  const sig = signature.trim();
  // an Ed25519 signature is 64 bytes: 88 base64 characters
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sig) || !version || !sha512) return false;
  try {
    return verify(null, signedMessage(version, sha512), createPublicKey(publicKey), Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

/** SHA-512 of a file, base64 (the form electron-updater and latest.yml use). */
export function sha512File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha512');
    createReadStream(path)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('base64')));
  });
}
