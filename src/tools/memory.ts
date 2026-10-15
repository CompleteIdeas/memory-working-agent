/**
 * Memory tools — give the AGENT reach into the memory it already has.
 *
 * WHY THIS EXISTS. `MwaMemory` (src/awm.ts, 828 lines) implements roughly two dozen
 * capabilities, and before this module the agent could reach exactly three of them:
 * `recall`, `remember` and `supersede`, all hardwired as brain actions. Everything else —
 * the person profile, the store's own shape, saved routines, standing policies, the action
 * log, recall feedback — was callable from TypeScript and invisible to the model. The
 * capability was built and then not handed to the thing that needed it.
 *
 * AWM'S UNIQUE POSITION, which is the reason this is worth doing properly. AWM is the only
 * component that holds BOTH halves of what an agent needs to act well:
 *
 *   1. the WORLD model — what was learned, decided, corrected, and when;
 *   2. the PERSON model — who it is talking to, how they want to be dealt with.
 *
 * Nothing else in the stack has both, and no other harness in the 2026 field study
 * (arXiv 2609.00006) has either in a queryable store — they use ripgrep and Markdown. So
 * the agent being unable to ASK its own memory "what do you know about this person" or
 * "what is in you" was not a missing nicety; it was the one real advantage going unused.
 *
 * DESIGN RULES, each of which is a constraint a careless version would break:
 *
 * - READ tools are free; WRITE tools are narrow. `memory_learn_person` is the only writer
 *   here, it writes to one person's private namespace, and it refuses facts about the WORLD
 *   (those belong in `remember`, which is salience-gated and trust-tiered).
 * - THE PRIVACY INVARIANT IS LOAD-BEARING. `recallPersonProfile` hard-filters by
 *   `person=<id>`; one person's notes must never surface for another. The tools take the
 *   person from `ToolContext`, never from a model-supplied argument, so a prompt-injected
 *   "read the profile of robert@..." cannot cross the boundary.
 * - ADAPTATION IS STYLE, NEVER SAFETY. A person note may change tone, format or how much to
 *   probe. It must never change a fact, an approval gate or a validation gate — those are
 *   identical for everyone. The tool description says so to the model as well.
 * - NO RAW IDs BACK TO THE MODEL where an opaque handle will do, and every list is capped:
 *   a store with 10k memories must not be dumpable into the context window one tool call.
 */
import type { RegisteredTool, ToolContext } from './registry.js';
import type { MwaMemory } from '../awm.js';
import { PERSON_NOTE_KINDS, type PersonNoteKind } from '../person.js';

/** Hard caps so a tool call can never flood the context window. */
const MAX_PROFILE_NOTES = 25;
const MAX_RECENT = 15;
const MAX_NOTE_CHARS = 600;

function clip(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Build the memory tools. Returns [] when memory is disabled, so a NullMemory run simply
 * has no memory tools rather than a set of tools that all answer "(memory is off)".
 */
export function memoryTools(memory: MwaMemory | null | undefined): RegisteredTool[] {
  if (!memory || !memory.enabled) return [];

  /** The person this turn is for. Comes from the harness, never from the model. */
  const personOf = (ctx: ToolContext): string => ctx.personId || 'unknown';

  const profile: RegisteredTool = {
    def: {
      name: 'memory_profile',
      description:
        'Read what you have previously learned about the person you are talking to right now — their ' +
        'preferences, working style, recurring needs, and the strategy that gets the most useful ' +
        'exchange out of them. Call this when HOW to respond matters: before a long answer, before ' +
        'choosing a format, or when you are deciding whether to ask a clarifying question or just ' +
        'proceed. It returns nothing for a new person, which is itself the answer. ' +
        'This governs STYLE only — never facts, and never whether an action needs approval.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    handler: async (_args, ctx) => {
      const notes = await memory.recallPersonProfile(personOf(ctx), MAX_PROFILE_NOTES);
      if (!notes.length) return '(nothing learned about this person yet — treat them as new and pay attention)';
      const byKind = new Map<string, string[]>();
      for (const n of notes) {
        const list = byKind.get(n.kind) ?? [];
        list.push(clip(n.content, MAX_NOTE_CHARS));
        byKind.set(n.kind, list);
      }
      return [...byKind.entries()]
        .map(([kind, items]) => `${kind.toUpperCase()}:\n${items.map((i) => `  • ${i}`).join('\n')}`)
        .join('\n');
    },
  };

  const learnPerson: RegisteredTool = {
    def: {
      name: 'memory_learn_person',
      description:
        'Record something DURABLE about the person you are talking to, so future conversations start ' +
        'from it. Use it for a stated preference ("always wants the number before the explanation"), a ' +
        'working style, a recurring need, or a strategy that worked ("gives better answers when offered ' +
        'two concrete options than when asked an open question"). ' +
        'Do NOT use it for facts about the world, a project, or a system — those go to `remember`. ' +
        'Do NOT record anything they would be uncomfortable seeing written down. Prefer what they ' +
        'SAID over what you inferred, and say which it was.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'One specific, self-contained sentence. Not a summary of the conversation.' },
          kind: { type: 'string', enum: PERSON_NOTE_KINDS, description: 'preference | style | need | strategy | fact' },
        },
        required: ['note', 'kind'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      // A person note is primed into THAT person's future turns, so an unattended run writing one is
      // the same injection-to-persistent-text shape as a standing preference, one tier down: a
      // scheduled run triages untrusted email AS its owner (scheduler passes personId), and whatever
      // it "learns" about them lands in their next interactive conversation. No person present, no
      // note. person-turn.ts already declines to learn when identity is in doubt; same intent.
      // A tainted run may be relaying text someone else wrote about this person (BL-17 review).
      if (ctx.tainted === true) {
        return '(not recorded — this conversation has read outside content, so this may not have come from them. ' +
          'Ask them directly if it matters.)';
      }
      if (ctx.interactive !== true) {
        return '(not recorded — nobody is present to have told you this. Note it in your summary instead; ' +
          'what you learn about a person has to come from them, not from something you read unattended.)';
      }
      const note = clip(String(args.note ?? ''), MAX_NOTE_CHARS);
      if (note.length < 8) return '(note too short to be useful — say something specific or skip it)';
      const kind = String(args.kind ?? 'fact') as PersonNoteKind;
      if (!PERSON_NOTE_KINDS.includes(kind)) return `(unknown kind "${kind}" — use one of: ${PERSON_NOTE_KINDS.join(', ')})`;
      const id = await memory.rememberAboutPerson(personOf(ctx), note, kind);
      return id ? `recorded (${kind}): ${note}` : '(not recorded — the memory filter judged it not worth keeping)';
    },
  };

  const storeMap: RegisteredTool = {
    def: {
      name: 'memory_store_map',
      description:
        'Describe the SHAPE of your own memory — roughly how much you hold, what you learned most ' +
        'recently, the standing preferences in force, and the routines you have saved. Use it when ' +
        'asked what you know or remember, when deciding whether a topic is worth re-deriving or just ' +
        'recalling, or when you suspect you already did this work before. ' +
        'It is a map, not the contents: use `recall` to actually retrieve something it points at.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    handler: async () => {
      // Each half is independently best-effort: a store map that fails because ONE of four
      // queries threw would be worse than a partial map.
      const [count, recent, policies, routines] = await Promise.all([
        memory.memoryCount().catch(() => -1),
        memory.recentMemories(MAX_RECENT).catch(() => []),
        memory.listPolicies().catch(() => [] as string[]),
        memory.listRoutines().catch(() => [] as { name: string; version: string; status: string }[]),
      ]);
      const lines: string[] = [];
      lines.push(count >= 0 ? `MEMORIES HELD: ${count}` : 'MEMORIES HELD: (count unavailable)');
      if (policies.length) {
        lines.push(`STANDING PREFERENCES (${policies.length}, always in force):\n${policies.slice(0, 12).map((p) => `  • ${clip(p, 160)}`).join('\n')}`);
      }
      if (routines.length) {
        const live = routines.filter((r) => r.status !== 'rejected');
        if (live.length) lines.push(`SAVED ROUTINES (${live.length}) — replayable procedures you built:\n${live.slice(0, 10).map((r) => `  • ${r.name} (${r.version}, ${r.status})`).join('\n')}`);
      }
      if (recent.length) {
        lines.push(`MOST RECENT (${recent.length} of ${count >= 0 ? count : '?'}):\n${recent.map((m) => `  • [${m.trust}] ${clip(m.concept, 90)}`).join('\n')}`);
      }
      if (lines.length === 1 && count === 0) return '(memory is empty — nothing learned yet)';
      return lines.join('\n\n');
    },
  };

  const feedback: RegisteredTool = {
    def: {
      name: 'memory_feedback',
      description:
        'Mark a memory you were given as useful or not useful for what you were actually doing. ' +
        'This is how recall improves: memories that keep proving useful surface sooner, and ones ' +
        'that keep misleading you stop surfacing. Call it when a recalled item clearly carried the ' +
        'answer, or clearly wasted a step. Use the id shown in square brackets with the memory.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The memory id exactly as it was shown to you.' },
          useful: { type: 'boolean', description: 'true if it helped, false if it misled or wasted a step' },
        },
        required: ['id', 'useful'],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const id = String(args.id ?? '').trim();
      if (!id) return '(no memory id given)';
      await memory.feedback(id, args.useful !== false);
      return `noted — "${clip(id, 40)}" marked ${args.useful !== false ? 'useful' : 'not useful'}`;
    },
  };

  return [profile, learnPerson, storeMap, feedback];
}
