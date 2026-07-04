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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, basename, join } from 'node:path';
import { resolveAllowed } from './tools/access.js';
import { INTERVIEW_QUESTIONS } from 'agent-working-memory/dist/onboard/index.js';

export { INTERVIEW_QUESTIONS };

export interface Candidate {
  concept: string;
  content: string;
  source: string;
}

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.pdf', '.docx', '.csv', '.json', '.html', '.htm']);
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
  if (lower.endsWith('.docx')) {
    const m: any = await import('mammoth');
    const fn = m.extractRawText ?? m.default?.extractRawText;
    const { value } = await fn({ buffer: buf });
    return String(value ?? '');
  }
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

function collectFiles(sandboxDir: string, paths: string[]): string[] {
  const files: string[] = [];
  const walk = (abs: string) => {
    if (files.length >= MAX_FILES) return;
    let st; try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      if (/[\\/](node_modules|\.git|dist|build)$/.test(abs)) return;
      for (const e of readdirSync(abs)) walk(join(abs, e));
    } else if (DOC_EXT.has(extname(abs).toLowerCase())) {
      files.push(abs);
    }
  };
  for (const p of paths) {
    const full = resolveAllowed(sandboxDir, p); // confine to granted folders
    if (full) walk(full);
  }
  return files.slice(0, MAX_FILES);
}

export interface ScanResult {
  candidates: Candidate[];
  filesScanned: number;
  truncated: boolean;
}

/** Read the pointed-at folders/files and return candidate memories to refine. */
export async function scanSources(sandboxDir: string, paths: string[]): Promise<ScanResult> {
  const files = collectFiles(sandboxDir, paths);
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
  'WARM-START (cold store): if your memory is empty or the user asks to set you up / learn about their project, run this before other work:',
  '1. Briefly interview the user — start with "What should I get good at / what is the goal here?", then a few of the onboarding questions (call onboard_questions). Ask ONE at a time; keep it short.',
  '2. Offer to learn from their material: point you at a folder or files (call onboard_scan with the paths) and/or connect a service (email inbox) to ingest. onboard_scan returns CANDIDATE memories — it does not save anything.',
  '3. Refine each candidate into an atomic memory: lead with the fact, one idea, include concrete identifiers (names, paths, terms). Drop noise. Merge duplicates.',
  '4. VERIFY before writing: when a memory is ambiguous or you inferred something, ask the user a short follow-up (ask_user) to confirm it is right. Summarize the set you intend to save and get a yes.',
  '5. Save the confirmed memories with remember (durable, canonical). Prefer the user\'s own words for facts they stated.',
  'Keep it friendly and quick — a handful of solid memories beats dozens of shaky ones.',
].join('\n');
