// Draws the taskbar thumbnail buttons (previous / play / pause / next) as white PNGs: Windows'
// thumbnail toolbar takes bitmaps, not SVG. Pure Node (4×4 supersampling + zlib), no dependency.
// Run: node scripts/make-thumbar-icons.cjs
const { deflateSync } = require('node:zlib');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

// shapes in a 24×24 box: rectangles [x, y, w, h] and triangles [[x,y],[x,y],[x,y]]
const ICONS = {
  prev: { rects: [[6, 6, 2.2, 12]], tris: [[[19, 6], [19, 18], [9.5, 12]]] },
  play: { rects: [], tris: [[[8, 5], [8, 19], [19, 12]]] },
  pause: { rects: [[6.5, 5, 4, 14], [13.5, 5, 4, 14]], tris: [] },
  next: { rects: [[15.8, 6, 2.2, 12]], tris: [[[5, 6], [5, 18], [14.5, 12]]] },
};
const SIZES = [16, 20, 24, 32]; // 100, 125, 150, 200 % display scaling

const inTri = (px, py, [a, b, c]) => {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p = [px, py];
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, icon) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = ((x + (sx + 0.5) / 4) * 24) / size, py = ((y + (sy + 0.5) / 4) * 24) / size;
          if (icon.rects.some(([rx, ry, rw, rh]) => px >= rx && px < rx + rw && py >= ry && py < ry + rh) || icon.tris.some((t) => inTri(px, py, t))) hit++;
        }
      row.set([255, 255, 255, Math.round((hit / 16) * 255)], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const out = join(__dirname, '..', 'build', 'thumbar');
mkdirSync(out, { recursive: true });
for (const [name, icon] of Object.entries(ICONS))
  for (const size of SIZES) writeFileSync(join(out, `${name}${size === 16 ? '' : `@${size / 16}x`}.png`), png(size, icon));
console.log('thumbar icons written to', out);
