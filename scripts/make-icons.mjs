// One logo, everywhere: build/logo.svg (vector, the only source) is rendered to every bitmap
// the system needs. Run after changing the logo: npm run make:icons
//   build/icons/png/icon-N.png   window and Linux icons
//   build/icons/icon.ico         Windows exe, installer, taskbar, file associations
//   src/renderer/src/assets/logo.svg   the same file, for the interface and the favicon
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'build', 'logo.svg'), 'utf8');
const out = join(root, 'build', 'icons');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'png'), { recursive: true });

const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();

const PNG_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024];
const pngs = new Map(PNG_SIZES.map((s) => [s, render(s)]));
for (const [s, buf] of pngs) writeFileSync(join(out, 'png', `icon-${s}.png`), buf);

// ICO with PNG-compressed entries (supported since Windows Vista)
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const entries = ICO_SIZES.map((s) => pngs.get(s));
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach((buf, i) => {
  const s = ICO_SIZES[i];
  const o = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, o);
  header.writeUInt8(s >= 256 ? 0 : s, o + 1);
  header.writeUInt8(0, o + 2);
  header.writeUInt8(0, o + 3);
  header.writeUInt16LE(1, o + 4);
  header.writeUInt16LE(32, o + 6);
  header.writeUInt32LE(buf.length, o + 8);
  header.writeUInt32LE(offset, o + 12);
  offset += buf.length;
});
writeFileSync(join(out, 'icon.ico'), Buffer.concat([header, ...entries]));

mkdirSync(join(root, 'src', 'renderer', 'src', 'assets'), { recursive: true });
copyFileSync(join(root, 'build', 'logo.svg'), join(root, 'src', 'renderer', 'src', 'assets', 'logo.svg'));
console.log(`icons written: ${PNG_SIZES.join(', ')} px, icon.ico (${ICO_SIZES.length} sizes)`);
