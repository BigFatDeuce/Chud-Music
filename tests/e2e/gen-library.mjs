// Builds a library of tagged MP3 files without any tool (no ffmpeg): the audio frames of a
// fixture, behind an ID3v2.3 tag written here (title, artist, album, track, optional cover).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { music } from './harness.mjs';

let audio = readFileSync(join(music, '01 - Minuit Chrome.mp3'));
if (audio.subarray(0, 3).toString() === 'ID3') {
  const size = ((audio[6] & 0x7f) << 21) | ((audio[7] & 0x7f) << 14) | ((audio[8] & 0x7f) << 7) | (audio[9] & 0x7f);
  audio = audio.subarray(10 + size);
}
// a few seconds are enough (files stay small: thousands of them)
audio = audio.subarray(0, 48 * 1024);

const be32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** A solid-colour PNG (the colour makes every album's cover a different file). */
export function png(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => Buffer.concat([be32(data.length), Buffer.from(type), data, be32(crc32(Buffer.concat([Buffer.from(type), data])))]);
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function frame(id, data) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
}
// UTF-16 with BOM: any name (accents) is written as is
const text = (s) => Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

/** An MP3 with these tags (cover: PNG bytes, or none). */
export function mp3({ title, artist, album, track, cover }) {
  const frames = [frame('TIT2', text(title)), frame('TPE1', text(artist))];
  if (album) frames.push(frame('TALB', text(album)));
  if (track) frames.push(frame('TRCK', text(String(track))));
  if (cover) frames.push(frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3, 0]), cover])));
  const body = Buffer.concat(frames);
  const n = body.length;
  const size = Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), size, body, audio]);
}

/**
 * `artists` × `albums` × `tracks` files under `dir`/<artist>/<album>/, each album with its own
 * cover (`coverPx` wide; 0 = no covers). Returns the number of files.
 */
export function generateLibrary(dir, { artists, albums, tracks, coverPx = 500 }) {
  let n = 0;
  for (let a = 0; a < artists; a++) {
    for (let b = 0; b < albums; b++) {
      const albumDir = join(dir, `Artiste ${a}`, `Disque ${b} de ${a}`);
      mkdirSync(albumDir, { recursive: true });
      const k = a * albums + b;
      const cover = coverPx ? png(coverPx, coverPx, [(k * 37) % 256, (k * 91) % 256, Math.floor(k / 256) * 40 + 15]) : null;
      for (let t = 0; t < tracks; t++) {
        writeFileSync(join(albumDir, `${String(t + 1).padStart(2, '0')} - Piste ${t + 1}.mp3`), mp3({ title: `Piste ${t + 1} (${a}.${b})`, artist: `Artiste ${a}`, album: `Disque ${b} de ${a}`, track: t + 1, cover }));
        n++;
      }
    }
  }
  return n;
}
