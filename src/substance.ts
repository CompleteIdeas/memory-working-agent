/**
 * Substance gate — a reusable, conservative check run before an agent is allowed
 * to call `done`. It catches the two failure modes that a cheap model slips into
 * most: claiming an action happened when no tool ran (fabrication), and punting
 * back to the human ("would you like me to…") instead of doing a doable task.
 *
 * Generalizes USEA Gallop Support's `validateResult` (chatbot-pattern + write-
 * without-evidence) into a domain-agnostic primitive the harness owns. Built to
 * be EMBEDDABLE: pure function, no I/O, no model call — the agent loop calls it
 * and re-prompts once on a concrete failure, defaulting to PASS so a shaky check
 * never blocks a good answer.
 */

export interface SubstanceInput {
  /** the task the agent was given */
  instruction: string;
  /** the agent's final summary (what it's about to return on `done`) */
  summary: string;
  /** action/tool names the agent invoked this run (e.g. read, web_search, run_command, freshdesk) */
  toolsUsed: string[];
}

export interface SubstanceVerdict {
  ok: boolean;
  /** when ok=false, a one-line corrective nudge for the agent */
  fix?: string;
}

// Actions that are NOT "acting on the task": internal memory ops, scheduling,
// and asking the user. Everything else (read, web_search, dispatch, run_command,
// http_request, domain tools…) counts as having actually done something.
const NON_ACTION = new Set(['recall', 'remember', 'schedule', 'ask_user', 'done', '']);

// The agent ending its turn by asking the human to supply something / approve.
const ASK_BACK =
  /(would you like|do you want me to|shall i|should i\b|let me know if|let me know how|could you (please )?(provide|share|confirm|clarify|specify|tell me)|can you (provide|clarify|confirm|specify)|please (provide|clarify|confirm|specify)|what would you like|which (one|option) would you|if you'd like,? i)/i;

// The agent claiming a world-changing action actually occurred.
const ACTION_CLAIM =
  /\b(wrote|saved|updated|created|sent|emailed|e-mailed|inserted|deleted|removed|posted|committed|pushed|published|scheduled|added|submitted|applied|merged)\b/i;

function acted(toolsUsed: string[]): boolean {
  return toolsUsed.some((t) => !NON_ACTION.has(t.toLowerCase().trim()));
}

/** A task the agent is expected to *do*, not a bare question to relay to the user. */
function isDoableTask(instruction: string): boolean {
  const t = instruction.trim();
  return t.length >= 16; // has enough substance to be a real instruction
}

export function validateSubstance(input: SubstanceInput): SubstanceVerdict {
  const summary = (input.summary ?? '').trim();
  const did = acted(input.toolsUsed ?? []);

  // 1) FABRICATED ACTION — claims a write/send/update happened, but no tool ran.
  //    High-signal: a world action cannot have occurred with zero tools.
  if (!did && ACTION_CLAIM.test(summary)) {
    return {
      ok: false,
      fix:
        'Your answer says you performed an action (wrote/sent/updated/created something) but you did not actually use any tool to do it. ' +
        'Do not claim an action you did not take — either perform it now with the right tool, or state plainly that it has NOT been done yet.',
    };
  }

  // 2) PUNTED INSTEAD OF ACTING — ends by asking the human for input on a doable
  //    task, without having acted. The instruction already gives you what's needed.
  if (!did && ASK_BACK.test(summary) && isDoableTask(input.instruction)) {
    return {
      ok: false,
      fix:
        'You ended by asking for input instead of doing the task. The instruction already gives you what you need — ' +
        'investigate with your tools (read / search / query) and produce the answer. Only ask the user if a genuinely blocking fact is missing.',
    };
  }

  return { ok: true };
}
