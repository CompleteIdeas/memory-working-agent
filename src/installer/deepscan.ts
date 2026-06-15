/**
 * Deep source scan (Phase 3) — beyond npm metadata. Downloads the package tarball,
 * VERIFIES its sha512 against the registry's dist.integrity (so the bytes we scan are
 * the bytes the registry serves), unpacks it (gunzip + a tiny tar reader, no deps), and
 * scans the actual JS/TS source for red-flag patterns. The findings are EVIDENCE for the
 * installation model — legit tool servers do use fs/network, so most patterns are info/
 * warn; only clear abuse (obfuscated payloads, env-exfil, remote dynamic require) is danger.
 */
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Finding } from './analyze.js';

const MAX_TARBALL = 8 * 1024 * 1024; // skip deep scan above this (e.g. Playwright) — too big
const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const TEXT_RE = /\.(js|cjs|mjs|ts|tsx|jsx|json)$/i;

export interface DeepScan {
  ran: boolean;
  note?: string;            // why it didn't run, if applicable
  integrityOk?: boolean;    // tarball sha512 matched the registry's dist.integrity
  filesScanned?: number;
  findings: Finding[];
}

/** Minimal tar reader: yields { name, content } for regular files. npm tarballs prefix
 *  paths with "package/". Pure-JS (tar = 512-byte header blocks + padded content). */
function* readTar(buf: Buffer): Generator<{ name: string; content: Buffer }> {
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const start = off + 512;
    if ((type === '0' || type === '\0' || type === '') && name) {
      yield { name, content: buf.subarray(start, start + size) };
    }
    off = start + Math.ceil(size / 512) * 512;
  }
}

// Pattern catalog: [regex, severity, label, detail]. Calibrated — a tool server using the
// network or filesystem is normal; obfuscation / exfil / remote code is what's alarming.
const PATTERNS: { re: RegExp; severity: Finding['severity']; label: string; detail: string }[] = [
  { re: /\beval\s*\(/, severity: 'warn', label: 'Uses eval()', detail: 'Evaluates code at runtime — worth a look at what it evaluates.' },
  { re: /new\s+Function\s*\(/, severity: 'warn', label: 'Builds code with new Function()', detail: 'Constructs and runs code from strings at runtime.' },
  { re: /child_process|\bexecSync\b|\bspawnSync\b|\.exec\s*\(/, severity: 'warn', label: 'Runs other programs', detail: 'Spawns child processes / shell commands.' },
  { re: /require\s*\(\s*[^'"`)]/, severity: 'warn', label: 'Dynamic require()', detail: 'Loads modules by a computed name (not a fixed string).' },
  { re: /\bhttps?:\/\/\d{1,3}(\.\d{1,3}){3}/, severity: 'warn', label: 'Hard-coded IP URL', detail: 'Talks to a raw IP address rather than a named host.' },
  { re: /process\.env\b[\s\S]{0,80}(fetch|http|net\.|request)/, severity: 'danger', label: 'Env + network nearby', detail: 'Reads environment variables close to a network call — possible secret exfiltration.' },
  { re: /(fetch|axios|https?\.request|net\.connect|dgram)/, severity: 'info', label: 'Makes network requests', detail: 'Contacts the network (normal for many tools).' },
  { re: /fs\.(write|append|unlink|rm|rmdir)/, severity: 'info', label: 'Writes/deletes files', detail: 'Modifies the filesystem (normal for file tools).' },
];

function scanText(name: string, text: string, findings: Map<string, Finding>): void {
  for (const p of PATTERNS) {
    if (p.re.test(text) && !findings.has(p.label)) findings.set(p.label, { severity: p.severity, label: p.label, detail: p.detail });
  }
  // Obfuscation: a large base64-looking blob, especially decoded then run.
  const b64 = text.match(/['"`][A-Za-z0-9+/]{1024,}={0,2}['"`]/);
  if (b64) {
    const decodedAndRun = /Buffer\.from\([^)]*base64[\s\S]{0,60}(eval|Function|exec)/.test(text) || /atob\([\s\S]{0,60}(eval|Function)/.test(text);
    findings.set('Large encoded blob', { severity: decodedAndRun ? 'danger' : 'warn', label: 'Large encoded blob', detail: `A ${b64[0].length}-char base64-like string${decodedAndRun ? ' that is decoded and executed — classic hidden payload.' : ' (could be data, or a hidden payload).'}` });
  }
}

export async function deepScanNpm(tarballUrl?: string, integrity?: string): Promise<DeepScan> {
  if (!tarballUrl) return { ran: false, note: 'No tarball URL in the registry metadata.', findings: [] };
  let raw: Buffer;
  try {
    const r = await fetch(tarballUrl);
    if (!r.ok) return { ran: false, note: `Couldn't download the tarball (${r.status}).`, findings: [] };
    raw = Buffer.from(await r.arrayBuffer());
  } catch (e) { return { ran: false, note: `Tarball download failed: ${(e as Error).message.slice(0, 80)}`, findings: [] }; }

  if (raw.length > MAX_TARBALL) return { ran: false, note: `Package is large (${Math.round(raw.length / 1048576)} MB) — skipped deep scan; relying on metadata + the model.`, findings: [] };

  // Integrity: the registry publishes dist.integrity as "sha512-<base64>".
  let integrityOk: boolean | undefined;
  if (integrity?.startsWith('sha512-')) {
    const got = createHash('sha512').update(raw).digest('base64');
    integrityOk = got === integrity.slice('sha512-'.length);
  }

  let tar: Buffer;
  try { tar = gunzipSync(raw); } catch (e) { return { ran: false, integrityOk, note: `Couldn't unpack the tarball: ${(e as Error).message.slice(0, 80)}`, findings: [] }; }

  const findings = new Map<string, Finding>();
  if (integrityOk === false) findings.set('Integrity mismatch', { severity: 'danger', label: 'Integrity mismatch', detail: 'The downloaded package does NOT match the registry checksum — do not install.' });

  let filesScanned = 0;
  for (const f of readTar(tar)) {
    if (filesScanned >= MAX_FILES) break;
    if (!TEXT_RE.test(f.name) || f.content.length > MAX_FILE_BYTES) continue;
    filesScanned++;
    scanText(f.name, f.content.toString('utf8'), findings);
  }

  return { ran: true, integrityOk, filesScanned, findings: [...findings.values()] };
}
