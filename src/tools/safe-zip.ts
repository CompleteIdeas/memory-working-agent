/**
 * Opening a Word file without trusting what it says about itself (W5 security re-review, 2026-10-26).
 *
 * A .docx is a zip. Its central directory states each part's size, but nothing makes that true: a 1 MB file can say
 * "1,716 bytes" and inflate to a gigabyte. So the size fields are never trusted here. Every part is inflated by this
 * module with a hard ceiling on the OUTPUT (zlib's maxOutputLength: inflation stops at the ceiling, memory never goes
 * past it), the running total across all parts is capped at 20 MB, and a part whose real size differs from what the
 * directory says is refused. mammoth then reads a fresh zip rebuilt from those checked parts, stored without
 * compression — so it never inflates anything itself.
 *
 * Every place that turns a .docx into text goes through docxText(): read_document and document sizes
 * (src/tools/builtins.ts), uploads' page counts, mail attachments (Gmail, Google, Outlook) and onboarding scans.
 */
import { inflateRawSync, crc32 } from 'node:zlib';

export const MAX_UNZIPPED_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 5_000;

/** A Word file that can't be opened safely; the message is plain words for the person. */
export class UnsafeDocument extends Error {
  constructor(message = `This Word file is too big to read here once unzipped (over ${MAX_UNZIPPED_BYTES / 1048576} MB of text), or it is damaged. Ask for a PDF or a smaller file.`) {
    super(message); this.name = 'UnsafeDocument';
  }
}

export interface ZipPart { name: string; data: Buffer }

/** Every part of a zip, inflated with a hard output ceiling. Throws UnsafeDocument when it can't be done safely. */
export function inflateZipBounded(buf: Buffer, maxTotal = MAX_UNZIPPED_BYTES): ZipPart[] {
  const bad = () => new UnsafeDocument();
  if (buf.length < 22) throw bad();
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 65_557); i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad();
  const entries = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || entries > MAX_ENTRIES || cdOff === 0xffffffff || cdOff + cdSize > buf.length) throw bad(); // Zip64 or broken
  const parts: ZipPart[] = [];
  let total = 0, at = cdOff;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw bad();
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20), usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nlen).toString('utf8');
    at += 46 + nlen + xlen + clen;
    if (flags & 0x1) throw bad(); // encrypted
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw bad();
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw bad();
    const raw = buf.subarray(start, start + csize);
    const room = maxTotal - total;
    let data: Buffer;
    if (method === 0) {
      if (csize > room) throw bad();
      data = Buffer.from(raw);
    } else if (method === 8) {
      // the ceiling is on what inflation PRODUCES: one byte more than the room left, so going over is detected
      try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, room + 1) }); } catch { throw bad(); }
      if (data.length > room) throw bad();
    } else throw bad();
    if (data.length !== usize) throw bad(); // the directory lied about this part
    total += data.length;
    if (!name.endsWith('/')) parts.push({ name, data });
  }
  return parts;
}

/** A plain zip of these parts, stored (no compression), with true sizes and CRCs. */
export function storedZip(parts: ZipPart[]): Buffer {
  const out: Buffer[] = [], cd: Buffer[] = [];
  let off = 0;
  for (const p of parts) {
    const nm = Buffer.from(p.name, 'utf8');
    const crc = crc32(p.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(p.data.length, 18); lh.writeUInt32LE(p.data.length, 22); lh.writeUInt16LE(nm.length, 26);
    out.push(lh, nm, p.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(p.data.length, 20); c.writeUInt32LE(p.data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    cd.push(c, nm);
    off += 30 + nm.length + p.data.length;
  }
  const cdBuf = Buffer.concat(cd);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(parts.length, 8); e.writeUInt16LE(parts.length, 10); e.writeUInt32LE(cdBuf.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...out, cdBuf, e]);
}

/** The text of a .docx, read safely (see the header). Throws UnsafeDocument for a file that can't be. */
export async function docxText(buf: Buffer): Promise<string> {
  const safe = storedZip(inflateZipBounded(buf));
  const m: any = await import('mammoth');
  const fn = m.extractRawText ?? m.default?.extractRawText;
  const { value } = await fn({ buffer: safe });
  return String(value ?? '');
}
