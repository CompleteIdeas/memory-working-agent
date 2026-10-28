/**
 * Onboarding / warm-start — turn a new (cold) MWA instance useful on day one.
 *
 * The agent drives the flow (it is the brain); this module gives it the raw
 * material. `scanSources` reads local folders/files the user points at — docs,
 * PDFs, Word, CSV, text — and returns CANDIDATE memories (deterministic chunking,
 * no model). The agent then refines each into an atomic memory, asks follow-up
 * questions to be sure it's right, and writes the good ones (via `remember`).
 * Services (email/inbox) are covered by the existing ingest path; this covers
 * "point me at a folder / feed me these files".
 *
 * Path access is confined to the folders the user has granted (resolveAllowed) —
 * onboarding can't read arbitrary disk.
 */
import { readFileSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { docxText } from './tools/safe-zip.js';
import { extname, basename, join, sep } from 'node:path';
import { isProtectedPath } from './assistant-settings.js';
import { resolveAllowed } from './tools/access.js';
import { INTERVIEW_QUESTIONS } from './awm-api.js';

export { INTERVIEW_QUESTIONS };

export interface Candidate {
  concept: string;
  content: string;
  source: string;
}

// S6 review: no .json — config, token and cache files are JSON far more often than notes are
const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.pdf', '.docx', '.csv', '.html', '.htm']);
const MAX_FILES = 60;
const MAX_CANDIDATES = 150;
const CHUNK_TARGET = 900; // chars per non-markdown chunk

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Extract plain text from a file buffer by type (PDF/Word/HTML/text). */
async function extractText(buf: Buffer, lower: string): Promise<string> {
  if (lower.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    const { getDocumentProxy, extractText: ex } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await ex(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : String(text ?? '');
  }
  if (lower.endsWith('.docx')) return docxText(buf); // bounded inflate (W5 re-review)
  const text = buf.toString('utf8');
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return stripHtml(text);
  return text;
}

/** One candidate per heading section (markdown), else grouped paragraphs. */
function chunk(text: string, source: string): Candidate[] {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const out: Candidate[] = [];
  const hasHeadings = /^#{1,3}\s+\S/m.test(clean);
  if (hasHeadings) {
    const lines = clean.split('\n');
    let heading = '', buf: string[] = [];
    const flush = () => {
      const body = buf.join('\n').trim();
      if (body.length >= 40) out.push({ concept: (heading || basename(source)).slice(0, 120), content: body.slice(0, 1400), source });
      buf = [];
    };
    for (const l of lines) {
      const h = /^#{1,3}\s+(.*)$/.exec(l);
      if (h) { flush(); heading = h[1].trim(); } else buf.push(l);
    }
    flush();
  } else {
    // Group paragraphs into ~CHUNK_TARGET-char candidates; concept = the lead line.
    const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 24);
    let acc: string[] = [], len = 0;
    const flush = () => {
      const body = acc.join('\n\n').trim();
      if (body.length >= 40) {
        const lead = body.split(/[.\n]/)[0].trim().slice(0, 80) || basename(source);
        out.push({ concept: lead, content: body.slice(0, 1400), source });
      }
      acc = []; len = 0;
    };
    for (const p of paras) { acc.push(p); len += p.length; if (len >= CHUNK_TARGET) flush(); }
    flush();
  }
  return out;
}

/** S6 review: files never read for warm-up, whatever folder they sit in — sign-in tokens, keys, .env files, vaults. */
const SECRET_NAME = /token|secret|credential|password|vault|^\.env($|\.)|\.(key|pem|p12|pfx|kdbx)$/i;
/** S6 review: the walk is bounded — entries looked at, folder depth, file size — and yields between folders. */
export const WALK_LIMITS = { maxEntries: 5_000, maxDepth: 8, maxBytes: 5 * 1024 * 1024 };
const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const real = async (p: string) => { try { return await realpath(p); } catch { return null; } };
const within = (child: string, parent: string) => {
  const c = process.platform === 'win32' ? child.toLowerCase() : child, q = process.platform === 'win32' ? parent.toLowerCase() : parent;
  return c === q || c.startsWith(q.endsWith(sep) ? q : q + sep);
};

/**
 * The documents to read under the pointed-at paths. S6 review (a junction to the helper's data folder handed a Google
 * refresh token back as a note): links and junctions are never followed (lstat), every entry is resolved where it
 * really is and must stay inside the folder pointed at and outside the helper's own data and settings
 * (assistant-settings.ts isProtectedPath), and files named like tokens, keys, .env or a vault are skipped.
 */
async function collectFiles(sandboxDir: string, paths: string[], roots?: string[]): Promise<string[]> {
  const files: string[] = [];
  let seen = 0;
  const walk = async (abs: string, top: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES || ++seen > WALK_LIMITS.maxEntries) return;
    let st; try { st = await lstat(abs); } catch { return; }
    if (st.isSymbolicLink()) return; // a link or a junction: never followed
    const r = await real(abs);
    if (!r || !within(r, top) || isProtectedPath(r)) return;
    if (st.isDirectory()) {
      if (depth >= WALK_LIMITS.maxDepth || /[\\/](node_modules|\.git|dist|build)$/.test(abs)) return;
      let entries: string[] = [];
      try { entries = await readdir(abs); } catch { return; }
      await yieldNow();
      for (const e of entries) { if (files.length >= MAX_FILES || seen > WALK_LIMITS.maxEntries) break; await walk(join(abs, e), top, depth + 1); }
    } else if (st.isFile() && DOC_EXT.has(extname(abs).toLowerCase()) && !SECRET_NAME.test(basename(abs)) && st.size <= WALK_LIMITS.maxBytes) {
      files.push(abs);
    }
  };
  for (const p of paths) {
    // confine to granted folders, or (S6) to the folders the owner pointed at just now, after the folder rules
    const full = roots ? resolveAllowed(sandboxDir, p, roots) : resolveAllowed(sandboxDir, p);
    if (!full) continue;
    const top = await real(full);
    if (top) await walk(full, top, 0);
  }
  return files.slice(0, MAX_FILES);
}

export interface ScanResult {
  candidates: Candidate[];
  filesScanned: number;
  truncated: boolean;
}

/** Read the pointed-at folders/files and return candidate memories to refine. `roots` (S6): read only inside these
 *  folders (already checked against the folder rules) instead of the granted ones. */
export async function scanSources(sandboxDir: string, paths: string[], roots?: string[]): Promise<ScanResult> {
  const files = await collectFiles(sandboxDir, paths, roots);
  const candidates: Candidate[] = [];
  for (const f of files) {
    if (candidates.length >= MAX_CANDIDATES) break;
    try {
      const text = await extractText(readFileSync(f), f.toLowerCase());
      candidates.push(...chunk(text, basename(f)));
    } catch { /* unreadable file — skip */ }
  }
  return {
    candidates: candidates.slice(0, MAX_CANDIDATES),
    filesScanned: files.length,
    truncated: candidates.length > MAX_CANDIDATES,
  };
}

/**
 * The onboarding protocol the agent follows on a cold store. Injected into the
 * chat system prompt; the agent runs it conversationally.
 */
export const ONBOARD_PROTOCOL = [
  // BL-53 pilot: a first message of "FYI, my account number is BF-20417" got "What should I get good at?" and the
  // fact was never acknowledged. The person's own request or fact comes first; the interview is offered after.
  'WARM-START (cold store): if your memory is empty or the user asks to set you up / learn about their project, run this — but if their message asks for something or tells you a fact, do THAT first (save a stated fact with remember, in their words) and offer the setup interview in one line at the end instead of starting it:',
  '1. Briefly interview the user — start with "What should I get good at / what is the goal here?", then a few of the onboarding questions (call onboard_questions). Ask ONE at a time; keep it short.',
  '2. Offer to learn from their material: point you at a folder or files (call onboard_scan with the paths) and/or connect a service (email inbox) to ingest. onboard_scan returns CANDIDATE memories — it does not save anything.',
  '3. Refine each candidate into an atomic memory: lead with the fact, one idea, include concrete identifiers (names, paths, terms). Drop noise. Merge duplicates.',
  '4. VERIFY before writing: when a memory is ambiguous or you inferred something, ask the user a short follow-up (ask_user) to confirm it is right. Summarize the set you intend to save and get a yes.',
  '5. Save the confirmed memories with remember (durable, canonical). Prefer the user\'s own words for facts they stated.',
  'Keep it friendly and quick — a handful of solid memories beats dozens of shaky ones.',
].join('\n');
