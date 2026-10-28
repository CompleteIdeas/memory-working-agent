/**
 * What the helper remembers (v2 build, slice S5): its learned facts, the standing preferences it always follows, the
 * routines it proposed, and the Markdown export. ONE implementation that both the classic Memory page (serve.ts
 * /api/memories, /api/memory/export|forget|correct, /api/policies/forget, /api/routines/*) and the v1 routes
 * (src/api/routes/memory.ts) call, so the two can never drift apart. Only MwaMemory's own methods are used.
 *
 * What changed from the code that sat in serve.ts (both paths get it):
 *   - Forget and Correct act only on a learned fact the Memory list can show (this helper's own, not superseded, not
 *     a job, routine, preference, skill or the helper's bookkeeping): before, any engram id was hard-deleted, so a
 *     forged request could remove a scheduled job or a promoted routine's skill by its id;
 *   - the helper's own kinds of memory are not listed among the facts: a proposed routine (it has its own list, where
 *     only Promote and Retire apply), goals, where-we-are notes, open items, learned-facts summaries and the rest;
 *   - a correction is checked first: some text, at most 2,000 characters, a name on one line that is not one of the
 *     helper's own kinds (`skill:`, `policy:`, `goal:` …);
 *   - (S5 review) facts are read in full: the list shows a 240-character preview marked `truncated`, while search,
 *     Correct and the edit box use the whole text, and a correction that is just the cut preview of a longer fact is
 *     refused (it used to replace the fact with its first 240 characters);
 *   - (S5 review) correcting a fact that came from outside (an email, a file, the web) makes it something the helper
 *     trusts, so it needs `confirmed`, and a "correction" that keeps the outside text is refused: the person writes the
 *     fact in their own words;
 *   - (S5 review) the export has pasted secrets masked as the activity log does; one store is open at a time (the
 *     pglite backend allows one connection).
 */
import { MwaMemory, isReservedConcept } from './awm.js';
import { dbFile } from './paths.js';
import { redactText } from './activity.js';

/** The web app's memory store and, for routines, the Telegram connector's too (they share the database; a routine
 *  proposed in Telegram must be promotable from the app, into the store its runs recall from). */
export const memoryAgent = (env: NodeJS.ProcessEnv = process.env): string => env.MWA_AGENT_ID ?? 'mwa-serve';
export const routineAgents = (env: NodeJS.ProcessEnv = process.env): string[] => [...new Set([memoryAgent(env), env.MWA_TELEGRAM_AGENT_ID ?? 'mwa-agent'])];

export type Fact = Awaited<ReturnType<MwaMemory['recentMemories']>>[number];
export type Routine = Awaited<ReturnType<MwaMemory['listRoutines']>>[number] & { agent: string };
export type Outcome<T = unknown> = ({ ok: true; message: string } & T) | { ok: false; code: string; message: string };

/** The whole store is read for every list anyway (getEngramsByAgent); this bounds what is kept in hand. */
const ALL = 5_000;
export const MAX_CORRECTION = 2_000;
/** What the list shows of a long fact (the classic page's 240 characters). */
export const PREVIEW = 240;

let open = 0, maxOpen = 0;
/** Tests: the most stores this module has had open at once since the last reset (S5 review: pglite allows one). */
export function _openStores(reset = false): number { const m = maxOpen; if (reset) maxOpen = open; return m; }
async function withMemory<T>(agent: string, fn: (m: MwaMemory) => Promise<T>, fallback: T): Promise<T> {
  let m: MwaMemory | null = null;
  open++; maxOpen = Math.max(maxOpen, open);
  try { m = new MwaMemory(agent, dbFile()); return await fn(m); } catch { return fallback; } finally { try { m?.close(); } catch { /* */ } open--; }
}

/** The helper's own kinds of memory (agent.ts, brain.ts, awm.ts): bookkeeping, not facts to forget or correct here.
 *  recentMemories leaves some out; the rest are left out here. A correction's name may not start with one either. */
const BOOKKEEPING = /^\s*(agent run|agent step|session|scheduled|skills?|question|lessons?|polic(?:y|ies)|action|routine|goal|where we are|open item|learned facts|event|id)\s*:/i;
export const reservedName = (name: string): boolean => BOOKKEEPING.test(name) || isReservedConcept(name) || /^\s*person [^:]+:/i.test(name);
async function facts(m: MwaMemory): Promise<Fact[]> {
  return (await m.recentMemories(ALL, true)).filter((f) => !BOOKKEEPING.test(f.concept));
}
const flat = (t: string) => t.toLowerCase().replace(/[\s….]+/g, ' ').trim();

function pick(all: Fact[], o: { q?: string; limit?: number }): { facts: Fact[]; total: number } {
  const words = String(o.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const hits = words.length ? all.filter((f) => { const t = `${f.concept} ${f.content}`.toLowerCase(); return words.every((w) => t.includes(w)); }) : all;
  const limit = Math.max(1, Math.min(ALL, o.limit ?? 40));
  return { facts: hits.slice(0, limit), total: hits.length };
}

/** Learned facts, newest first, in full. `q`: only those whose name or text holds every word of it (any case). */
export async function listFacts(o: { q?: string; limit?: number } = {}): Promise<{ facts: Fact[]; total: number }> {
  return pick(await withMemory(memoryAgent(), facts, [] as Fact[]), o);
}

/** Everything GET /memory shows, one store open at a time: the facts and preferences from one, then the routines. */
export async function memoryView(o: { q?: string; limit?: number } = {}): Promise<{ facts: Fact[]; total: number; preferences: string[]; routines: Routine[] }> {
  const got = await withMemory(memoryAgent(), async (m) => ({ found: pick(await facts(m), o), preferences: await m.listPolicies() }), { found: { facts: [] as Fact[], total: 0 }, preferences: [] as string[] });
  return { ...got.found, preferences: got.preferences, routines: await listRoutines() };
}

async function findFact(m: MwaMemory, id: string): Promise<Fact | undefined> {
  if (!id || id.length > 200) return undefined;
  return (await facts(m)).find((f) => f.id === id);
}

/** Forget one learned fact for good. */
export async function forgetFact(id: string): Promise<Outcome> {
  return withMemory(memoryAgent(), async (m): Promise<Outcome> => {
    const f = await findFact(m, String(id ?? ''));
    if (!f) return { ok: false, code: 'not_found', message: 'That memory isn’t there any more, or it isn’t one you can forget here.' };
    return (await m.forget(f.id)) ? { ok: true, message: 'Forgotten. I won’t use it again.' } : { ok: false, code: 'not_done', message: 'I couldn’t forget that. Try again.' };
  }, { ok: false, code: 'unavailable', message: 'I couldn’t open my memory just now. Try again.' });
}

/** Replace a learned fact with the person's own words: the old one is removed and the new one is trusted. A fact that
 *  came from outside needs `confirmed` (it becomes trusted) and new words, not the outside text kept. */
export async function correctFact(id: string, content: unknown, concept?: unknown, o: { confirmed?: boolean } = {}): Promise<Outcome<{ fact: Fact | null; id: string }>> {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) return { ok: false, code: 'bad_text', message: 'Type what it should say.' };
  if (text.length > MAX_CORRECTION) return { ok: false, code: 'bad_text', message: `That’s too long. Keep it under ${MAX_CORRECTION.toLocaleString('en-US')} characters.` };
  if (concept !== undefined && (typeof concept !== 'string' || /[\r\n\0]/.test(concept))) return { ok: false, code: 'bad_name', message: 'The name is one line of text.' };
  if (typeof concept === 'string' && reservedName(concept)) return { ok: false, code: 'bad_name', message: 'That name is one I use for my own notes (skills, preferences, jobs and so on). Pick another.' };
  return withMemory(memoryAgent(), async (m): Promise<Outcome<{ fact: Fact | null; id: string }>> => {
    const f = await findFact(m, String(id ?? ''));
    if (!f) return { ok: false, code: 'not_found', message: 'That memory isn’t there any more, or it isn’t one you can correct here.' };
    const old = f.content.trim();
    if (old.length > PREVIEW && flat(text) === flat(old.slice(0, PREVIEW))) {
      return { ok: false, code: 'truncated', message: 'That’s only the start of this memory. Open it again to correct the whole text, or the rest would be lost.' };
    }
    if (f.trust === 'untrusted') {
      if (old && flat(text).includes(flat(old))) return { ok: false, code: 'outside_copy', message: 'This came from outside, so write it in your own words: keeping the outside text would make it something I trust.' };
      if (o.confirmed !== true) return { ok: false, code: 'confirm_needed', message: 'This came from outside: email, files or the web. What you write here becomes something I trust. Send confirmed: true to go ahead.' };
    }
    if (text === old && (concept === undefined || concept === f.concept)) return { ok: true, message: 'Nothing changed.', fact: f, id: f.id };
    const name = (typeof concept === 'string' && concept.trim() ? concept.trim() : f.concept).slice(0, 80);
    const newId = await m.correctFact(f.id, name, text);
    if (!newId) return { ok: false, code: 'not_done', message: 'I couldn’t save that correction. Nothing changed. Try again.' };
    const fact = (await facts(m)).find((x) => x.id === newId) ?? null;
    return { ok: true, message: 'Corrected. I’ll use what you wrote from now on.', fact, id: newId };
  }, { ok: false, code: 'unavailable', message: 'I couldn’t open my memory just now. Try again.' });
}

/** Everything as portable Markdown ("it's yours"), with pasted keys and passwords masked as the activity log masks them. */
export async function exportMemory(): Promise<string> {
  return redactText(await withMemory(memoryAgent(), (m) => m.exportMarkdown(), '# What MWA knows about you\n'));
}

/** The standing preferences, newest first. */
export async function listPreferences(): Promise<string[]> {
  return withMemory(memoryAgent(), (m) => m.listPolicies(), [] as string[]);
}

/** Remove a standing preference (every copy of exactly that rule). */
export async function forgetPreference(rule: unknown): Promise<Outcome<{ removed: number }>> {
  const r = typeof rule === 'string' ? rule.slice(0, 600) : '';
  if (!r.trim()) return { ok: false, code: 'bad_rule', message: 'Say which standing preference to remove.' };
  const removed = await withMemory(memoryAgent(), (m) => m.removePolicy(r), 0);
  return removed > 0 ? { ok: true, message: 'Removed. It no longer applies to new tasks.', removed }
    : { ok: false, code: 'not_found', message: 'No standing preference with those words was found.' };
}

/** Routines the helper proposed, in both stores (one after the other), newest first. */
export async function listRoutines(): Promise<Routine[]> {
  const out: Routine[] = [];
  for (const agent of routineAgents()) out.push(...(await withMemory(agent, async (m) => (await m.listRoutines()).map((r) => ({ ...r, agent })), [] as Routine[])));
  return out;
}

/** Promote (its steps guide future similar tasks) or retire (they no longer do) one routine. */
export async function setRoutine(id: unknown, action: 'promote' | 'retire', agent?: unknown): Promise<Outcome<{ routine: Routine | null }>> {
  const store = agent === undefined || agent === null || agent === '' ? memoryAgent() : String(agent);
  if (!routineAgents().includes(store)) return { ok: false, code: 'unknown_store', message: 'That routine’s store isn’t one this helper uses.' };
  const rid = typeof id === 'string' ? id : '';
  const r = await withMemory(store, (m) => (action === 'promote' ? m.promoteRoutine(rid) : m.retireRoutine(rid)), { ok: false, error: 'I couldn’t open my memory just now. Try again.' });
  if (!r.ok) {
    const missing = /no such routine/i.test(r.error ?? '');
    return { ok: false, code: missing ? 'not_found' : 'not_done', message: missing ? 'That routine isn’t there any more.' : `Not ${action === 'promote' ? 'promoted' : 'retired'}: ${r.error ?? 'unknown error'}.` };
  }
  const routine = (await listRoutines()).find((x) => x.id === rid && x.agent === store) ?? null;
  const name = routine?.name ?? 'the routine';
  return { ok: true, message: action === 'promote' ? `Promoted “${name}”. Its steps guide similar tasks from now on.` : `Retired “${name}”. It no longer guides new tasks.`, routine };
}
