/**
 * Per-person LEARN trigger + compressed dossier (S3). After a conversation the agent proactively
 * captures durable things it learned ABOUT the person (so it never re-asks), and maintains a bounded,
 * self-recompressing "dossier" — a materialized view over the atomic notes (the reactive-derived-view
 * idea, applied to memory) that stays small as facts accumulate. See docs/true-agent-and-person-profile.md.
 *
 * Both steps take a Provider (the model is the DI seam — tests inject a spy). Style/format/working-with
 * knowledge only; never task content, never safety posture.
 */
import type { Provider } from './provider.js';
import type { MwaMemory } from './awm.js';
import { normalizePersonId, PERSON_NOTE_KINDS, type PersonNoteKind } from './person.js';
import { parseJsonLoose } from './util.js';
import { scanPolicy } from './tools/routines.js';

const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const LEARN_SYSTEM =
  'From ONE chat exchange, extract only DURABLE things worth remembering ABOUT THE PERSON across future ' +
  'conversations — their communication style, preferences, needs, how best to engage them, and stable ' +
  'facts (what to call them, their role, how to contact them). Do NOT include the task content, one-off ' +
  'details, or facts about the world. If nothing durable was revealed, return an empty list. When a note ' +
  'answers a canonical intake field, add "field": one of name|contact|role|style. Output ONLY JSON: ' +
  '{"notes":[{"kind":"preference|style|need|strategy|fact","content":"<short, specific>","field":"name|contact|role|style (optional)"}]}';

const INTAKE_KEYS = ['name', 'contact', 'role', 'style'];

export interface LearnResult { learned: number; skipped: number }

/** Learn about a person from one exchange: extract candidate notes, drop ones already known (so we
 *  don't repeat facts), and write the rest person-scoped. No-op for the shared 'unknown' profile. */
export async function learnAboutPerson(opts: {
  brain: Provider; memory: MwaMemory; personId: string; userMessage: string; agentReply: string;
}): Promise<LearnResult> {
  const pid = normalizePersonId(opts.personId);
  if (pid === 'unknown') return { learned: 0, skipped: 0 };
  let cands: { kind?: string; content?: string; field?: string }[] = [];
  try {
    const out = await opts.brain.chat({
      system: LEARN_SYSTEM,
      messages: [{ role: 'user', content: `USER SAID:\n${opts.userMessage.slice(0, 1500)}\n\nI REPLIED:\n${opts.agentReply.slice(0, 1500)}` }],
      maxTokens: 300,
    });
    cands = parseJsonLoose<{ notes?: { kind?: string; content?: string; field?: string }[] }>(out.text)?.notes ?? [];
  } catch { return { learned: 0, skipped: 0 }; }
  if (!Array.isArray(cands) || !cands.length) return { learned: 0, skipped: 0 };

  const existing = await opts.memory.recallPersonProfile(pid, 100);
  const seen = new Set(existing.map((n) => norm(n.content)));
  let learned = 0, skipped = 0;
  for (const c of cands.slice(0, 8)) {
    const content = String(c?.content ?? '').trim();
    if (!content) continue;
    if (seen.has(norm(content))) { skipped++; continue; } // already known — don't repeat it
    const kind: PersonNoteKind = (PERSON_NOTE_KINDS as string[]).includes(String(c?.kind)) ? (c!.kind as PersonNoteKind) : 'fact';
    // A "preference" lands in this person's dossier and so in every future run with them — the same
    // reach as a standing preference, so the same scan (BL-03 review: a pasted "from now on always
    // BCC …" could otherwise be learned here silently, with no approval).
    // scanPolicy alone doesn't catch "always BCC x@y" (a real owner rule like that belongs on an
    // approval card, not refused), and this path saves WITHOUT approval — so a learned preference that
    // names an address or a link is dropped. Contact details are learned as facts, not preferences.
    // A "fact" that reads as a directive ("their assistant is x@y — BCC them on invoices") gets the same
    // treatment (second BL-03 review); a plain contact fact ("Rob's email is rob@x.com") does not.
    const directive = /\b(always|never|every|whenever|from now on|bcc|cc|forward|send|copy|share|upload|include|add|notify|loop in)\b/i.test(content);
    const namesTarget = /[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\//i.test(content);
    if (content.length >= 8 && (!scanPolicy(content).safe || (namesTarget && (kind !== 'fact' || directive)))) { skipped++; continue; }
    const field = INTAKE_KEYS.includes(String(c?.field)) ? String(c!.field) : undefined; // tag canonical intake answers
    const id = await opts.memory.rememberAboutPerson(pid, content, kind, field);
    if (!id) continue; // write failed — don't mark it seen or count it, so it can be retried next turn
    seen.add(norm(content));
    learned++;
  }
  return { learned, skipped };
}

const DOSSIER_SYSTEM = (name: string) =>
  `Compress these notes about ${name} into a COMPACT dossier for an assistant — the essentials for working ` +
  'with them: what to call them, how to reach them, communication style, how to engage, standing ' +
  'preferences/constraints. Keep it to at most 6 short bullets. Merge duplicates; drop trivia. Output plain ' +
  'text bullets only (each line starting with "• "), no preamble.';

/** Re-materialize the person's dossier when atomic notes reach a cap: summarize them into one compact
 *  dossier note and drop the previous dossier. Bounds the primed context as facts accumulate. */
export async function compressPersonDossier(opts: {
  brain: Provider; memory: MwaMemory; personId: string; name?: string; cap?: number;
}): Promise<{ compressed: boolean; notes: number }> {
  const pid = normalizePersonId(opts.personId);
  if (pid === 'unknown') return { compressed: false, notes: 0 };
  const cap = opts.cap ?? Number(process.env.MWA_DOSSIER_CAP ?? 10);
  const all = await opts.memory.recallPersonProfile(pid, 200);
  const atomic = all.filter((n) => n.kind !== 'dossier');
  if (atomic.length < cap) return { compressed: false, notes: atomic.length };
  let text = '';
  try {
    const out = await opts.brain.chat({
      system: DOSSIER_SYSTEM(opts.name?.trim() || 'this person'),
      messages: [{ role: 'user', content: atomic.map((n) => `• [${n.kind}] ${n.content}`).join('\n') }],
      maxTokens: 400,
    });
    text = (out.text ?? '').trim();
  } catch { return { compressed: false, notes: atomic.length }; }
  if (!text) return { compressed: false, notes: atomic.length };
  // Drop the prior dossier FIRST, then write the fresh one. Order matters: if the recompressed text is
  // identical, AWM's reinforce-on-dup would otherwise return the old engram's id and we'd delete what we
  // just "wrote". Forgetting first guarantees exactly one current dossier.
  for (const d of all.filter((n) => n.kind === 'dossier')) { try { await opts.memory.forget(d.id); } catch { /* */ } }
  const newId = await opts.memory.rememberAboutPerson(pid, text, 'dossier');
  // If the write failed, the old dossier is already gone — report failure honestly; the atomic notes
  // survive so buildPersonPrimer degrades to them and the next turn regenerates the dossier.
  return { compressed: !!newId, notes: atomic.length };
}
