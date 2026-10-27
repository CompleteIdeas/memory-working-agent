// v2 build, slice W5: the pairing QR code (web/src/v2/screens/settings/qr.ts). The expected matrices are the `qrcode`
// package's (1.5.4, byte mode, level M, the same mask), one per version 1–10 plus real pairing links, kept as hashes
// of their rows ('1' dark / '0' light, one line per row).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { encodeQr, qrSvgPath, QR_MAX_VERSION } from '../web/src/v2/screens/settings/qr';

const base = `https://mwa.example/pair#c=${'K7PQM4XZ'.repeat(30)}`;
const GOLDEN: { text: string; mask: number; version: number; sha: string }[] = [
  { text: base.slice(0, 10), mask: 0, version: 1, sha: 'f856cebb08a05f26bb4e556541c9858a' },
  { text: base.slice(0, 20), mask: 1, version: 2, sha: '692550cff0a613008685513446be91d2' },
  { text: base.slice(0, 35), mask: 2, version: 3, sha: '68f97dc40de3453cb633769637ac5adb' },
  { text: base.slice(0, 50), mask: 3, version: 4, sha: '74d756fce121994d3e82687ef1160068' },
  { text: base.slice(0, 70), mask: 4, version: 5, sha: '644308d9bd598d09d1c20a83c76054c1' },
  { text: base.slice(0, 90), mask: 5, version: 6, sha: '677d56754652339659de59c4ceeb707d' },
  { text: base.slice(0, 110), mask: 6, version: 7, sha: '8f32b279045e08719a93993607242880' },
  { text: base.slice(0, 140), mask: 7, version: 8, sha: '92af40fef5df243e3661c0d24dd0baf1' },
  { text: base.slice(0, 170), mask: 0, version: 9, sha: 'b78016b7ee49ba6e1795ff5686c02116' },
  { text: base.slice(0, 200), mask: 1, version: 10, sha: '54ba27cdee6c24ba9b5f491357e2e16d' },
  { text: 'https://mwa.tail1a2b.ts.net/pair#c=K7PQ-M4XZ', mask: 3, version: 4, sha: 'e9183f2540d3367347a3e27e75e5bd85' },
  { text: 'http://localhost:7898/pair#c=ABCD-EFGH', mask: 6, version: 3, sha: 'be5949a84868193ef573b7b2a358d273' },
  { text: 'Robert’s Pixel ✓', mask: 7, version: 2, sha: '66213f9549fcea8689fce03c1485a68f' },
];
const rows = (m: boolean[][]) => m.map((r) => r.map((b) => (b ? '1' : '0')).join('') + '\n').join('');
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

describe('the pairing QR code', () => {
  for (const g of GOLDEN) {
    it(`matches the reference: ${g.text.length} bytes, version ${g.version}, mask ${g.mask}`, () => {
      const q = encodeQr(g.text, { mask: g.mask });
      expect(q.version).toBe(g.version);
      expect(q.size).toBe(g.version * 4 + 17);
      expect(sha(rows(q.modules))).toBe(g.sha);
    });
  }
  it('picks a mask by itself, the same every time, and keeps the finder patterns', () => {
    const a = encodeQr('https://mwa.tail1a2b.ts.net/pair#c=K7PQ-M4XZ'), b = encodeQr('https://mwa.tail1a2b.ts.net/pair#c=K7PQ-M4XZ');
    expect(a.mask).toBeGreaterThanOrEqual(0); expect(a.mask).toBeLessThan(8);
    expect(rows(a.modules)).toBe(rows(b.modules));
    for (const [x, y] of [[0, 0], [a.size - 7, 0], [0, a.size - 7]]) {
      expect(a.dark(x, y)).toBe(true); expect(a.dark(x + 1, y + 1)).toBe(false); expect(a.dark(x + 3, y + 3)).toBe(true);
    }
  });
  it('refuses what does not fit in version 10', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow(/Too long/);
    expect(encodeQr('x'.repeat(213)).version).toBe(QR_MAX_VERSION);
  });
  it('draws an SVG path with a quiet zone', () => {
    const q = encodeQr('a', { mask: 0 });
    const svg = qrSvgPath(q);
    expect(svg.viewBox).toBe('0 0 29 29');
    expect(svg.d.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});
