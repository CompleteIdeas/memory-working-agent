/**
 * Domain pack — progressive-disclosure domain knowledge for the harness.
 *
 * A "domain pack" is a folder with an optional AGENT.md (persona + standing
 * rules) and a topics/ directory of focused .md files. Before a run, the harness
 * loads AGENT.md (always) and scores each topic against the instruction, then
 * injects only the most relevant few — so a big knowledge base never floods the
 * prompt. This is the mechanism that lets a domain (e.g. USEA Gallop Support's
 * project/AGENT.md + topics/) plug into MWA as a backend without serializing it
 * into memories.
 *
 * Generalizes USEA's context-primer (which hardcoded a keyword→file map): here
 * relevance is derived from each file itself (filename + headings + content), so
 * any domain pack works with zero per-pack configuration.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface DomainTopic {
  name: string;
  text: string;
  /** indexable terms (filename + headings + content), for relevance scoring */
  terms: Set<string>;
}

export interface DomainPack {
  dir: string;
  /** AGENT.md content (persona + rules); '' if absent */
  agentMd: string;
  topics: DomainTopic[];
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'have', 'has', 'are', 'was', 'were',
  'you', 'your', 'our', 'their', 'its', 'his', 'her', 'them', 'they', 'what', 'when', 'where', 'who',
  'why', 'how', 'which', 'will', 'would', 'should', 'could', 'can', 'may', 'all', 'any', 'some', 'not',
  'but', 'about', 'than', 'then', 'them', 'use', 'using', 'used', 'get', 'got', 'per', 'via',
]);

function termList(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
}

// Cache packs by dir, invalidated by a signature over the dir + topic mtimes.
const cache = new Map<string, { sig: string; pack: DomainPack }>();

function packSignature(dir: string): string {
  const parts: string[] = [];
  try { parts.push(`agent:${statSync(join(dir, 'AGENT.md')).mtimeMs}`); } catch { /* none */ }
  try {
    const td = join(dir, 'topics');
    for (const f of readdirSync(td).sort()) {
      if (f.endsWith('.md')) { try { parts.push(`${f}:${statSync(join(td, f)).mtimeMs}`); } catch { /* */ } }
    }
  } catch { /* none */ }
  return parts.join('|');
}

/** Load a domain pack from a directory. Returns null if the directory is unusable. */
export function loadDomainPack(dir: string): DomainPack | null {
  let sig: string;
  try { sig = packSignature(dir); } catch { return null; }
  const hit = cache.get(dir);
  if (hit && hit.sig === sig) return hit.pack;

  let agentMd = '';
  try { agentMd = readFileSync(join(dir, 'AGENT.md'), 'utf8'); } catch { /* optional */ }

  const topics: DomainTopic[] = [];
  try {
    const td = join(dir, 'topics');
    for (const f of readdirSync(td).sort()) {
      if (!f.endsWith('.md')) continue;
      let text = '';
      try { text = readFileSync(join(td, f), 'utf8'); } catch { continue; }
      if (text.trim().length < 10) continue;
      const name = f.replace(/\.md$/, '');
      const headings = (text.match(/^#{1,6}\s.*$/gm) ?? []).join(' ');
      // filename + headings weighted by appearing alongside content terms
      const terms = new Set<string>([
        ...termList(name.replace(/[-_]/g, ' ')),
        ...termList(headings),
        ...termList(text),
      ]);
      topics.push({ name, text, terms });
    }
  } catch { /* no topics dir */ }

  if (!agentMd && topics.length === 0) return null;
  const pack: DomainPack = { dir, agentMd, topics };
  cache.set(dir, { sig, pack });
  return pack;
}

/** Score topics against the instruction and return the top-N most relevant. */
export function selectTopics(pack: DomainPack, query: string, topN = 3): DomainTopic[] {
  const q = new Set(termList(query));
  if (q.size === 0) return [];
  const scored = pack.topics
    .map((t) => {
      let score = 0;
      for (const term of q) if (t.terms.has(term)) score += 1;
      return { t, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((s) => s.t);
}

/**
 * Build the domain-knowledge block to inject into the prompt: AGENT.md (always,
 * if present) + the top-N relevant topics, capped. '' if the pack is empty.
 */
export function buildDomainContext(
  pack: DomainPack,
  query: string,
  opts?: { topN?: number; maxChars?: number },
): string {
  const maxChars = opts?.maxChars ?? 6000;
  const parts: string[] = [];
  if (pack.agentMd.trim()) parts.push(pack.agentMd.trim());
  for (const t of selectTopics(pack, query, opts?.topN ?? 3)) {
    parts.push(`--- topic: ${t.name} ---\n${t.text.trim()}`);
  }
  if (parts.length === 0) return '';
  const body = parts.join('\n\n').slice(0, maxChars);
  return `# Domain knowledge (loaded for this task — verify specifics before acting)\n\n${body}`;
}
