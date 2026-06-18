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
  /** indexable terms (filename + headings + content union), for relevance scoring */
  terms: Set<string>;
  /** terms from the filename — strongest relevance signal */
  nameTerms: Set<string>;
  /** terms from markdown headings — medium relevance signal */
  headingTerms: Set<string>;
  /** terms from the body — weakest relevance signal */
  bodyTerms: Set<string>;
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

// Tokenize, drop stopwords, and add a de-pluralized variant (members->member) so
// query/topic terms match across singular/plural without a full stemmer.
function termList(s: string): string[] {
  const base = (s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
  const out = new Set<string>();
  for (const w of base) {
    out.add(w);
    if (w.length > 3 && w.endsWith('s')) out.add(w.slice(0, -1));
  }
  return [...out];
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
      const nameTerms = new Set<string>(termList(name.replace(/[-_]/g, ' ')));
      const headingTerms = new Set<string>(termList(headings));
      const bodyTerms = new Set<string>(termList(text));
      const terms = new Set<string>([...nameTerms, ...headingTerms, ...bodyTerms]);
      topics.push({ name, text, terms, nameTerms, headingTerms, bodyTerms });
    }
  } catch { /* no topics dir */ }

  if (!agentMd && topics.length === 0) return null;
  const pack: DomainPack = { dir, agentMd, topics };
  cache.set(dir, { sig, pack });
  return pack;
}

/**
 * Score topics against the instruction and return the top-N most relevant.
 * Weighting: a filename match is the strongest signal (the file is literally
 * about this), a heading match is next, a body mention is weakest. This stops a
 * large catch-all file from outscoring a small, precisely-named skill file.
 */
export function selectTopics(pack: DomainPack, query: string, topN = 5): DomainTopic[] {
  const q = new Set(termList(query));
  if (q.size === 0) return [];
  const scored = pack.topics
    .map((t) => {
      let score = 0;
      for (const term of q) {
        if (t.nameTerms.has(term)) score += 5;
        else if (t.headingTerms.has(term)) score += 3;
        else if (t.terms.has(term)) score += 1;
      }
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
  opts?: {
    topN?: number;
    // AGENT.md is the persona + standing rules — it is always included in full up
    // to this (large) ceiling; truncating it mid-document breaks the agent.
    agentMaxChars?: number;
    // Total budget shared across the selected topic files...
    topicMaxChars?: number;
    // ...and a per-topic cap so one huge topic (e.g. a 24KB freshdesk.md) can't
    // eat the whole topic budget and starve the others.
    perTopicMaxChars?: number;
    /** @deprecated legacy single cap; ignored when the granular caps are used */
    maxChars?: number;
  },
): string {
  const agentMaxChars = opts?.agentMaxChars ?? 40_000;
  const topicMaxChars = opts?.topicMaxChars ?? 16_000;
  const perTopicMaxChars = opts?.perTopicMaxChars ?? 8_000;
  const parts: string[] = [];
  if (pack.agentMd.trim()) parts.push(pack.agentMd.trim().slice(0, agentMaxChars));
  let topicBudget = topicMaxChars;
  for (const t of selectTopics(pack, query, opts?.topN ?? 5)) {
    if (topicBudget <= 0) break;
    const body = t.text.trim().slice(0, Math.min(perTopicMaxChars, topicBudget));
    parts.push(`--- topic: ${t.name} ---\n${body}`);
    topicBudget -= body.length;
  }
  if (parts.length === 0) return '';
  return `# Domain knowledge (loaded for this task — verify specifics before acting)\n\n${parts.join('\n\n')}`;
}
