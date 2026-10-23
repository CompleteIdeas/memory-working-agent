/**
 * BL-74 — the shape of a fact MWA learns, after the rules AWM gives agents for writing memories (Robert, 2026-10-23:
 * "use the AWM claude setup as a guide on the structure of the memories required"). A memory is only as findable as
 * it was written: lead with the fact, name the category as well as the specifics, give it a specific topic, the people
 * and dates it is about, and — for a fact with a shelf life — the day it stops being true, so it is recalled as old
 * rather than as current.
 *
 * Measured first (memory test on a copy of the production store, 2026-10-23): every fact MWA had learned was tagged
 * topic=world, intent=finding, with no person, date or end date. "Which of my kids are in 4th grade?" could not reach
 * Caleb's and Daniel's records past MWA's own run logs, and the June camp to-dos had nothing to say they were June's.
 */

/** Asked of the model wherever MWA extracts facts to remember (email reading, the end of a run). */
export const FACT_SHAPE = 'Each fact: "concept" a short title that names the thing and its category ("Cindy Toppen, Eli\'s Algebra I teacher"); "content" leading with the fact itself, naming the category as well as the specifics (school, scout troop, real estate, newsletter) and the names, numbers and dates; "topic" a specific lowercase-hyphenated subject ("eli-school", "troop-58-summer-camp", "ai-newsletter"), never a generic one like "world" or "info"; "kind" one of person, fact, event, deadline, decision, preference; "people" the full names it is about; "date" the day an event or deadline happens (YYYY-MM-DD) when it has one; "valid_to" the last day the fact is true (YYYY-MM-DD) when it has a shelf life — an event, a deadline, a school year, a temporary status — and omitted for a lasting fact (who someone is, a standing preference).';

export interface LearnedFact { concept?: unknown; content?: unknown; topic?: unknown; kind?: unknown; people?: unknown; date?: unknown; valid_to?: unknown }

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['person', 'fact', 'event', 'deadline', 'decision', 'preference']);

/** A learned fact's tags and validity: specific topic, intent, people and date as AWM's prefix tags, the end date as validTo. */
export function factTags(f: LearnedFact): { tags: string[]; validTo?: string; decision: boolean } {
  const topic = String(f.topic ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const kind = KINDS.has(String(f.kind)) ? String(f.kind) : 'fact';
  const decision = kind === 'decision' || kind === 'preference';
  const people = (Array.isArray(f.people) ? f.people : []).map((p) => String(p).replace(/[^\p{L}\p{N} .'-]+/gu, '').trim()).filter((p) => p.length > 1).slice(0, 5);
  const date = ISO.test(String(f.date ?? '')) ? String(f.date) : undefined;
  const validTo = ISO.test(String(f.valid_to ?? '')) ? String(f.valid_to) : undefined;
  return {
    tags: [
      'topic=world', ...(topic && topic !== 'world' ? [`topic=${topic}`] : []),
      `intent=${decision ? 'decision' : 'finding'}`, `fact=${kind}`,
      ...people.map((p) => `person=${p}`), ...(date ? [`date=${date}`] : []),
    ],
    ...(validTo ? { validTo } : {}),
    decision,
  };
}
