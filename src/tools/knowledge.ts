/**
 * Knowledge-store write tools — let the agent CONTRIBUTE reference knowledge
 * (reusable queries, schema facts, procedures) to the domain pack, human-gated.
 *
 * The split this enforces: reference knowledge (schemas, queries, code,
 * procedures) lives in the KNOWLEDGE STORE — markdown files loaded into context
 * by relevance each run — NOT in AWM (which is for experiential memory: what
 * happened, decisions, corrections). Storing query text in AWM produced vague,
 * unsourced "skill:" memories; curated knowledge files are the right home.
 *
 * Curated pack topics (project/topics/*.md) are read-only and version-controlled.
 * This writes only to a SEPARATE writable dir (MWA_KNOWLEDGE_DIR), so agent
 * contributions never silently mutate the curated pack, and provenance is clear.
 *
 * Writes are gated by requireApproval (the same dryrun→confirm flow that guards a
 * production DB), so the agent can PROPOSE knowledge but a human curates what
 * actually lands. Modeled on USEA's sleep-cycle that wrote data/knowledge/*.md,
 * generalized + approval-gated for MWA.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { RegisteredTool } from './registry.js';
import { requireApproval } from './approval.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const MAX_CONTENT = 20_000;

/** Resolve "<dir>/<slug>.md", refusing any slug that would escape the knowledge dir. */
function safePath(knowledgeDir: string, slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  const root = resolve(knowledgeDir);
  const full = resolve(root, `${slug}.md`);
  if (full !== join(root, `${slug}.md`)) return null; // paranoia: no traversal survived
  if (!full.startsWith(root + sep)) return null;
  return full;
}

function nowIso(): string {
  // runtime code (not a workflow script) — Date is available here
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the knowledge-store tools for a given writable dir. Returns [] if no dir
 * is configured (the feature is opt-in via MWA_KNOWLEDGE_DIR).
 */
export function knowledgeTools(knowledgeDir: string | undefined): RegisteredTool[] {
  if (!knowledgeDir) return [];
  const dir = resolve(knowledgeDir);

  const writeTool: RegisteredTool = {
    def: {
      name: 'knowledge_write',
      description:
        'Contribute REFERENCE knowledge to the knowledge store — a reusable SQL query, a schema fact, ' +
        'a procedure. Use this (NOT memory) for query/code/schema text that future runs should reuse. ' +
        'Only propose knowledge you have VERIFIED this session (e.g. a query you actually ran clean). ' +
        'Provide a short kebab-case slug, a title, and markdown content. Updating an existing slug replaces it.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'kebab-case id, e.g. "area-member-count" (a-z, 0-9, hyphens)' },
          title: { type: 'string', description: 'human title, e.g. "Counting members by Area"' },
          content: { type: 'string', description: 'the knowledge, in markdown (include the query + when to use it)' },
          category: { type: 'string', description: 'optional area tag, e.g. "db-query", "schema", "procedure"' },
        },
        required: ['slug', 'title', 'content'],
      },
    },
    handler: async (args) => {
      const slug = String(args.slug ?? '').trim().toLowerCase();
      const title = String(args.title ?? '').trim();
      const content = String(args.content ?? '');
      const category = String(args.category ?? '').trim();
      if (!SLUG_RE.test(slug)) return '(refused: slug must be kebab-case, 2-61 chars, a-z/0-9/hyphen)';
      if (!title) return '(refused: title required)';
      if (!content.trim()) return '(refused: content required)';
      if (content.length > MAX_CONTENT) return `(refused: content over ${MAX_CONTENT} chars)`;
      const full = safePath(dir, slug);
      if (!full) return '(refused: invalid slug path)';
      const existed = (() => { try { return statSync(full).isFile(); } catch { return false; } })();
      const frontmatter =
        `# ${title}\n\n` +
        `<!-- contributed: ${nowIso()} · source: agent` +
        (category ? ` · category: ${category}` : '') +
        ` · slug: ${slug} -->\n\n`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(full, frontmatter + content.trim() + '\n', 'utf8');
      return `${existed ? 'updated' : 'added'} knowledge entry "${slug}.md" (${content.length} chars) in the knowledge store. It will load into context on relevant future tasks.`;
    },
  };

  const listTool: RegisteredTool = {
    def: {
      name: 'knowledge_list',
      description: 'List entries the agent has contributed to the knowledge store (slug + title).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      let files: string[];
      try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return '(no contributed knowledge yet)'; }
      if (files.length === 0) return '(no contributed knowledge yet)';
      const lines = files.map((f) => {
        let title = f.replace(/\.md$/, '');
        try { const m = readFileSync(join(dir, f), 'utf8').match(/^#\s+(.+)$/m); if (m) title = m[1].trim(); } catch { /* */ }
        return `- ${f.replace(/\.md$/, '')} — ${title}`;
      });
      return lines.join('\n');
    },
  };

  // knowledge_write is approval-gated: the agent PROPOSES, a human confirms the
  // entry before it lands in the store (curation stays human-owned).
  const gatedWrite = requireApproval(writeTool, {
    preview: (a) =>
      `knowledge_write → ${String(a.slug)}.md\n` +
      `title: ${String(a.title)}\n` +
      (a.category ? `category: ${String(a.category)}\n` : '') +
      `--- content ---\n${String(a.content ?? '').slice(0, 1200)}${String(a.content ?? '').length > 1200 ? '\n…(truncated)' : ''}`,
  });

  return [gatedWrite, listTool];
}
