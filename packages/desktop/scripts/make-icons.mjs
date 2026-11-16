// Rasterises the printer glyph into app and tray PNGs, so no binary assets live in the repo.
import { writeFileSync, mkdirSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

function png(size, bg) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 24;
  const put = (x, y, [r, g, b, a]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0 * s); y < Math.round(y1 * s); y++) for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++) put(x, y, c);
  };
  const dark = [15, 23, 42, 255], white = [255, 255, 255, 255];
  const fg = bg ? white : dark;
  if (bg) {
    // Rounded square background.
    const r = size * 0.2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = Math.max(r - x, x - (size - 1 - r), 0), dy = Math.max(r - y, y - (size - 1 - r), 0);
      if (dx * dx + dy * dy <= r * r) put(x, y, dark);
    }
  }
  const pad = bg ? 3 : 1, k = (24 - 2 * pad) / 24, o = (v) => pad + v * k;
  rect(o(6), o(2), o(18), o(8), fg); // paper in
  rect(o(2), o(9), o(22), o(17), fg); // body
  rect(o(6), o(17), o(18), o(22), fg); // paper out
  rect(o(8), o(15), o(16), o(20), bg ? dark : [0, 0, 0, 0]); // slot
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../build/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon.png', out), png(256, true));
writeFileSync(new URL('tray.png', out), png(32, true));
console.log('icons written to build/');
