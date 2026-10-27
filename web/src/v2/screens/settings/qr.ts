/**
 * A small QR code encoder for the pairing link (v2 build, slice W5): byte mode, error correction level M, versions
 * 1–10 (up to 213 bytes, far more than `https://<host>/pair#c=ABCD-EFGH` needs). No dependency: its matrices were
 * compared module for module with the `qrcode` package (1.5.4) for every version 1–10 and every mask, and
 * tests/web-v2-qr.test.ts keeps that package's matrices (as hashes) so a change here that breaks one is caught.
 *
 * Follows ISO/IEC 18004 the way Project Nayuki's reference encoder lays it out: function patterns, then the
 * interleaved data and Reed–Solomon codewords in the zig-zag, then the mask with the lowest penalty (or a given one).
 */

const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_BITS_M = 0; // L=1, M=0, Q=3, H=2
export const QR_MAX_VERSION = 10;

export interface QrMatrix { size: number; version: number; mask: number; dark: (x: number, y: number) => boolean; modules: boolean[][] }

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver: number) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data: number[], div: number[]): number[] {
  const r = new Array<number>(div.length).fill(0);
  for (const b of data) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** The QR code for `text` (UTF-8). `mask` forces a mask pattern (0–7); otherwise the one with the lowest penalty. */
export function encodeQr(text: string, opts: { mask?: number; minVersion?: number } = {}): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = Math.max(1, opts.minVersion ?? 1);
  for (; ; ver++) {
    if (ver > QR_MAX_VERSION) throw new Error('Too long for a QR code here.');
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  // the bit stream: byte mode, the count, the bytes, a terminator, padding
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // blocks, Reed–Solomon, interleaving
  const nBlocks = BLOCKS_M[ver], eccLen = ECC_PER_BLOCK_M[ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks), shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) if (i !== shortLen - eccLen || j >= nShort) all.push(blocks[j][i]);
  }

  // the function patterns
  const size = ver * 4 + 17;
  const mods: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setF = (x: number, y: number, d: boolean) => { mods[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = alignmentPositions(ver, size);
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const d = (FORMAT_BITS_M << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setF(8, i, bit(b, i));
    setF(8, 7, bit(b, 6)); setF(8, 8, bit(b, 7)); setF(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(b, i));
    setF(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), c = Math.floor(i / 3); setF(a, c, bit(b, i)); setF(c, a, bit(b, i)); }
  }

  // the codewords, in the zig-zag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x] && i < all.length * 8) { mods[y][x] = bit(all[i >>> 3], 7 - (i & 7)); i++; }
    }
  }

  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (fn[y][x]) continue;
      const inv = m === 0 ? (x + y) % 2 === 0 : m === 1 ? y % 2 === 0 : m === 2 ? x % 3 === 0 : m === 3 ? (x + y) % 3 === 0
        : m === 4 ? (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0 : m === 5 ? ((x * y) % 2) + ((x * y) % 3) === 0
          : m === 6 ? (((x * y) % 2) + ((x * y) % 3)) % 2 === 0 : (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      if (inv) mods[y][x] = !mods[y][x];
    }
  };
  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const p = penalty(mods, size);
      if (p < best) { best = p; mask = m; }
      applyMask(m); // undo (XOR)
    }
  }
  applyMask(mask); drawFormat(mask);
  return { size, version: ver, mask, modules: mods, dark: (x, y) => mods[y][x] };
}

/** The four penalty rules (runs, 2×2 blocks, finder-like patterns, dark balance), to pick the clearest mask. */
function penalty(m: boolean[][], size: number): number {
  let p = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) { lines.push(m[y]); lines.push(m.map((row) => row[y])); }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) p += 3 + (run - 5); run = 1; }
    }
    for (let i = 0; i + 7 <= size; i++) {
      if (line[i] && !line[i + 1] && line[i + 2] && line[i + 3] && line[i + 4] && !line[i + 5] && line[i + 6]) {
        const before = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
        const after = i + 11 <= size && [7, 8, 9, 10].every((k) => !line[i + k]);
        if (before || after) p += 40;
      }
    }
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return p;
}

/** The code as an SVG path (one square per dark module), with a 4-module quiet zone; dark on light always. */
export function qrSvgPath(q: QrMatrix, quiet = 4): { d: string; viewBox: string } {
  let d = '';
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const n = q.size + quiet * 2;
  return { d, viewBox: `0 0 ${n} ${n}` };
}
