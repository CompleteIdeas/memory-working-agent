/* Generate MWA PWA icons (no image deps): signal-orange tile with the graphite
 * "memory meter" bars. Writes web/public/icon-192.png + icon-512.png. */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ORANGE = [0xec, 0x4a, 0x18, 0xff];
const GRAPHITE = [0x1e, 0x21, 0x27, 0xff];

function draw(x, y, s) {
  const baseline = s * 0.72, barW = s * 0.08, gap = s * 0.045, count = 5;
  const totalW = count * barW + (count - 1) * gap;
  const x0 = (s - totalW) / 2;
  for (let i = 0; i < count; i++) {
    const bx = x0 + i * (barW + gap);
    const h = s * (0.18 + i * 0.10);
    if (x >= bx && x < bx + barW && y >= baseline - h && y < baseline) return GRAPHITE;
  }
  return ORANGE;
}

function png(size) {
  const ch = 4, stride = size * ch + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      const o = y * stride + 1 + x * ch;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.resolve(__dirname, '..', 'public');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png(size));
  console.log(`wrote public/icon-${size}.png`);
}
