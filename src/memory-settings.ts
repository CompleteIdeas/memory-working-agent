/**
 * What the helper remembers (v2 build, slice S5): its learned facts, the standing preferences it always follows, the
 * routines it proposed, and the Markdown export. ONE implementation that both the classic Memory page (serve.ts
 * /api/memories, /api/memory/export|forget|correct, /api/policies/forget, /api/routines/*) and the v1 routes
 * (src/api/routes/memory.ts) call, so the two can never drift apart. Only MwaMemory's existing methods are used.
 *
 * What changed from the code that sat in serve.ts (both paths get it):
 *   - Forget and Correct act only on a learned fact the Memory list can show (this helper's own, not superseded, not
 *     a job, routine, preference, skill or the helper's bookkeeping): before, any engram id was hard-deleted, so a
 *     forged request could remove a scheduled job or a promoted routine's skill by its id;
 *   - a proposed routine is no longer listed among the facts (it has its own list, where only Promote and Retire
 *     apply): Forget or Correct on it there deleted the routine, or minted a trusted fact from its steps;
 *   - a correction is checked first (some text, at most 2,000 characters, a name on one line).
 */
import { MwaMemory } from './awm.js';
import { dbFile } from './paths.js';

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

async function withMemory<T>(agent: string, fn: (m: MwaMemory) => Promise<T>, fallback: T): Promise<T> {
  let m: MwaMemory | null = null;
  try { m = new MwaMemory(agent, dbFile()); return await fn(m); } catch { return fallback; } finally { try { m?.close(); } catch { /* */ } }
}

/** Learned facts, newest first. `q`: only those whose name or text holds every word of it (any case). */
export async function listFacts(o: { q?: string; limit?: number } = {}): Promise<{ facts: Fact[]; total: number }> {
  const all = await withMemory(memoryAgent(), facts, [] as Fact[]);
  const words = String(o.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const hits = words.length ? all.filter((f) => { const t = `${f.concept} ${f.content}`.toLowerCase(); return words.every((w) => t.includes(w)); }) : all;
  const limit = Math.max(1, Math.min(ALL, o.limit ?? 40));
  return { facts: hits.slice(0, limit), total: hits.length };
}

/** recentMemories leaves out the bookkeeping, but not a proposed routine (`routine: …`): that has its own list. */
const ROUTINE = /^routine:/i;
async function facts(m: MwaMemory): Promise<Fact[]> {
  return (await m.recentMemories(ALL)).filter((f) => !ROUTINE.test(f.concept));
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

/** Replace a learned fact with the person's own words: the old one is removed and the new one is trusted. */
export async function correctFact(id: string, content: unknown, concept?: unknown): Promise<Outcome<{ fact: Fact | null; id: string }>> {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) return { ok: false, code: 'bad_text', message: 'Type what it should say.' };
  if (text.length > MAX_CORRECTION) return { ok: false, code: 'bad_text', message: `That’s too long. Keep it under ${MAX_CORRECTION.toLocaleString('en-US')} characters.` };
  if (concept !== undefined && (typeof concept !== 'string' || /[\r\n\0]/.test(concept))) return { ok: false, code: 'bad_name', message: 'The name is one line of text.' };
  return withMemory(memoryAgent(), async (m): Promise<Outcome<{ fact: Fact | null; id: string }>> => {
    const f = await findFact(m, String(id ?? ''));
    if (!f) return { ok: false, code: 'not_found', message: 'That memory isn’t there any more, or it isn’t one you can correct here.' };
    if (text === f.content.trim() && (concept === undefined || concept === f.concept)) return { ok: true, message: 'Nothing changed.', fact: f, id: f.id };
    const name = (typeof concept === 'string' && concept.trim() ? concept.trim() : f.concept).slice(0, 80);
    const newId = await m.correctFact(f.id, name, text);
    if (!newId) return { ok: false, code: 'not_done', message: 'I couldn’t save that correction. Nothing changed. Try again.' };
    const fact = (await facts(m)).find((x) => x.id === newId) ?? null;
    return { ok: true, message: 'Corrected. I’ll use what you wrote from now on.', fact, id: newId };
  }, { ok: false, code: 'unavailable', message: 'I couldn’t open my memory just now. Try again.' });
}

/** Everything as portable Markdown ("it's yours"). */
export async function exportMemory(): Promise<string> {
  return withMemory(memoryAgent(), (m) => m.exportMarkdown(), '# What MWA knows about you\n');
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

/** Routines the helper proposed, in both stores, newest first. */
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
