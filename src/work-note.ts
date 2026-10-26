/**
 * Which open goals a chat message is about (interface slice replay 2026-10-26, gap 5). The work note told every chat
 * about every open goal with "if it stopped partway, offer to continue it", and twice a run answered an unrelated
 * request by writing the board briefing instead. A goal is mentioned when the message asks about work in general,
 * shares content words with the goal's title, or the goal's last note came from this very conversation.
 */

const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'about', 'with', 'this', 'that', 'from', 'into', 'then', 'them', 'they', 'what', 'when', 'where', 'which', 'will', 'would', 'could', 'should', 'please', 'write', 'make', 'give', 'tell', 'find', 'look', 'some', 'have', 'been', 'were', 'also', 'just', 'like', 'want', 'need']);
const words = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

/** "Where are we on…", "is the briefing done", "continue it", "how's that coming": the person asks about work in hand. */
export const ASKS_ABOUT_WORK = /\b(where (?:are|is|do) (?:we|you|things)|how(?:'s| is| are) (?:it|that|the \w+|things) (?:going|coming)|status|progress|done yet|finished yet|still working|still on|continue|carry on|pick (?:it|that|this) (?:back )?up|resume|what (?:have|did) you (?:done|do) (?:so far|on)|any (?:news|update))\b/i;

/** The goals this message is about, in the order given. */
export function goalsMentioned<G extends { title: string; fromHere?: boolean }>(message: string, goals: G[]): G[] {
  const asks = ASKS_ABOUT_WORK.test(message);
  const mw = words(message);
  return goals.filter((g) => {
    if (asks) return true;
    if (g.fromHere) return true;
    const tw = words(g.title);
    let shared = 0; for (const w of tw) if (mw.has(w)) shared++;
    return shared >= 2 || (tw.size > 0 && tw.size <= 2 && shared >= 1);
  });
}

/** The note's framing: information in hand, never a request. */
export const WORK_NOTE_HEAD = '(Work already in hand for the person, as information — they see it in the Work tab. Answer their new message on its own terms. Only when their message is about one of these do you say where it stands or continue it; never continue or redo this work for an unrelated request, and never ask them for files a job already has:';
