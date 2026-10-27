/**
 * The Ask flow's words and rules (v2 build, slice W4), kept apart from the components so they are unit-tested in node
 * (tests/web-v2-ask.test.ts). Everything a person reads about an ask is worked out here: where it goes ("To: Family &
 * school · suggested"), a plan's two choices in local time, what a refusal means in plain words, the spending limit.
 */
import type { AskStart, AskChosen, Schemas, Turn } from '../../api/client';

export type AskPlan = Schemas['AskPlan'];
export type AskPlanOption = Schemas['AskPlanOption'];
export type AskRoute = Schemas['AskRoute'];
export type AboutKind = Schemas['AskAbout']['kind'];
export type Suggestion = Schemas['Suggestion'];

/** The most a person may set as a limit (the API's capUsd maximum). */
export const CAP_MAX = 20;
export const CAP_MIN = 0.01;

/** "10:10 AM", in this device's time zone. */
export function localClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
/** "10:10 AM" today, "tomorrow 8:00 AM", or "Thu 8:00 AM" further out — when a background job should be ready. */
export function readyText(ms: number, now: number): string {
  const d = new Date(ms), n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(n)) / 86_400_000);
  if (diff <= 0) return localClock(ms);
  if (diff === 1) return `tomorrow ${localClock(ms)}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${localClock(ms)}`;
}

/** A plan option's button: the server's own words, with its "ready around …" said in this device's time. */
export function optionLabel(o: AskPlanOption, now: number): string {
  if (!o.readyAt) return o.label;
  const base = o.label.replace(/\s*·\s*ready around .*$/i, '');
  return `${base} · ready around ${readyText(o.readyAt, now)}`;
}

/** The plan's size: "149 pages", "12 sources", "149 pages · 12 sources"; null when the server gave none. */
export function sizeText(plan: AskPlan): string | null {
  const parts: string[] = [];
  if (plan.size?.pages) parts.push(`${plan.size.pages} ${plan.size.pages === 1 ? 'page' : 'pages'}`);
  if (plan.size?.sources) parts.push(`${plan.size.sources} ${plan.size.sources === 1 ? 'source' : 'sources'}`);
  return parts.length ? parts.join(' · ') : null;
}

/** "$0.30" for the limit box. */
export function capText(usd: number): string { return usd.toFixed(2); }

/** The limit the person typed, checked: a dollar amount from 1¢ to $20. */
export function parseCap(raw: string): { ok: true; usd: number } | { ok: false; message: string } {
  const t = raw.trim().replace(/^\$/, '');
  if (!t) return { ok: false, message: 'Enter an amount, like 0.50.' };
  // plain dollars and cents only: not "1e1", "0x10", "1,5" or "Infinity" (Number() would take some of those)
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return { ok: false, message: 'Enter an amount, like 0.50.' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, message: 'Enter an amount, like 0.50.' };
  if (n < CAP_MIN) return { ok: false, message: 'The least is 1¢.' };
  if (n > CAP_MAX) return { ok: false, message: `The most is $${CAP_MAX}.` };
  const usd = Math.round(n * 100) / 100;
  if (usd < CAP_MIN) return { ok: false, message: 'The least is 1¢.' };
  return { ok: true, usd };
}

/** Where an ask goes, as the sheet says it under the text: "Family & school · suggested". */
export function routeLine(r: { name: string; confidence: string } | null): string | null {
  if (!r) return null;
  const how = routeHow(r.confidence);
  return how ? `${r.name} · ${how}` : r.name;
}
/** How sure the routing is, in the sheet's words ("suggested", "not sure", "this project"); '' for the person's own choice. */
export function routeHow(confidence: string): string {
  return ({ suggested: 'suggested', 'not sure': 'not sure', 'this project': 'this project', about: 'where this belongs' } as Record<string, string>)[confidence] ?? '';
}

/** A refusal of an ask or a plan's choice, in plain words for the person, with what they can do about it. */
export interface Refusal { text: string; again: boolean; restore?: boolean }
export function refusalFor(code: string | undefined, serverMessage: string): Refusal {
  switch (code) {
    case 'expired': return { text: 'This plan is old — ask again.', again: true };
    case 'files_gone': return { text: 'A file this plan reads isn’t there any more. Add it again and ask again.', again: true };
    case 'archived': {
      const said = serverMessage.replace(/\s*Restore it first\.?\s*$/i, '').trim();
      return { text: `${said || 'That project is archived.'} Restore it, or ask again somewhere else.`, again: true, restore: true };
    }
    case 'already_chosen': return { text: 'A choice was already made for this. Here’s what’s happening.', again: false };
    case 'busy': return { text: serverMessage || 'I’m still writing an answer there. Add this to it, or wait a moment.', again: false };
    case 'in_progress': return { text: 'That choice is still being made. Try again in a moment.', again: false };
    case 'not_found': return { text: serverMessage || 'That isn’t there any more. Ask again.', again: true };
    default: return { text: serverMessage || 'That didn’t work. Try again.', again: true };
  }
}

/** What an answer that arrives says about where its knowledge came from: "using what I know from Eventing". */
export function provenanceLine(t: Pick<Turn, 'provenance' | 'projectId'>): string | null {
  const from = t.provenance.filter((p) => p.projectId !== t.projectId);
  if (!from.length) return null;
  const names = from.map((p) => (p.projectId === null ? 'an earlier conversation' : p.name));
  const uniq = [...new Set(names)];
  const list = uniq.length <= 2 ? uniq.join(' and ') : `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`;
  return `using what I know from ${list}`;
}

/** A turn's "about" chip without the server's label (turns carry only kind and id). */
export const ABOUT_NOUN: Record<string, string> = {
  item: 'an item on your list', mail: 'an email', event: 'a calendar event', draft: 'a calendar draft', job: 'a job', conflict: 'a double-booking',
};

/** A run's progress line from the stream's `live` event ("Reading · step 3 of 40"). */
export function stageLine(stage: unknown, type?: string): string {
  const s = (stage ?? {}) as { n?: number; of?: number; total?: number; tool?: string; task?: string };
  if (type === 'stopping') return 'Stopping after this step…';
  if (type === 'plan_step' && s.n && s.total) return `Part ${s.n} of ${s.total}${s.task ? `: ${s.task}` : ''}`;
  const verb = toolWord(s.tool);
  return s.n ? `${verb} · step ${s.n}${s.of ? ` of ${s.of}` : ''}` : `${verb}…`;
}
function toolWord(tool?: string): string {
  if (!tool) return 'Working on it';
  if (/read_document|read_file|read/.test(tool)) return 'Reading';
  if (/search|fetch|browse|web/.test(tool)) return 'Looking it up';
  if (/calendar/.test(tool)) return 'Checking your calendar';
  if (/mail|gmail|outlook/.test(tool)) return 'Checking your mail';
  if (/write|save|note/.test(tool)) return 'Writing it down';
  if (/recall|memory|remember/.test(tool)) return 'Remembering';
  return 'Working on it';
}

/** What a chosen plan or an ask handed to the background says while it works: "I'll let you know · ready around 10:10 AM". */
export function jobNote(r: Pick<AskStart | AskChosen, 'readyAt'>, now: number): string {
  return r.readyAt ? `I’ll let you know · ready around ${readyText(r.readyAt, now)}` : 'I’ll let you know when it’s done.';
}

/** The person's own choice of project wins over any suggestion; otherwise the suggestion (or nothing yet). */
export function routeFor(chosen: { projectId: string; name: string; confidence: string } | null, suggested: { projectId: string; name: string; confidence: string } | null) {
  return chosen ?? suggested;
}

/** "Do it now" or "In the background", for "You chose: …". */
export function choiceText(c: { mode?: 'now' | 'background'; narrowLabel?: string }): string {
  if (c.narrowLabel) return c.narrowLabel;
  return c.mode === 'now' ? 'Do it now' : 'In the background';
}

/** W4 review: a plan option's own limit, as the person sets it ("stops at $0.50"); null while the box is not a valid
 *  amount. Each option has its own (the server's capDefault for it). */
export function capFor(raw: string): number | null { const c = parseCap(raw); return c.ok ? c.usd : null; }
/** The warning under a limit below what the option is expected to cost. */
export function capWarning(cap: number | null, estimateUsd: number): string | null {
  return cap !== null && cap < estimateUsd ? 'That limit is below the estimate — it will stop partway.' : null;
}
/** What a Stop or "Add to it" refused says in place. */
export function runActionRefusal(code: string | undefined, message: string, what: 'stop' | 'steer'): string {
  if (code === 'not_running' || code === 'nothing_running') return what === 'stop' ? 'It had already finished.' : 'It had already finished, so I couldn’t add that. Send it as a new message.';
  return message || 'That didn’t work. Try again.';
}

/**
 * W4 review: the body of a plan's choice. The limit always goes with it, explicitly: the one set for that option ("Do it
 * now" has its own, "In the background" its own; a narrower ask runs now, so it takes the now limit). Null when that
 * option's box does not hold a valid amount (the card then opens Details to say why).
 */
export function choiceBody(choice: { mode: 'now' | 'background' } | { narrowIndex: number }, caps: { now: string; background: string }):
  { mode?: 'now' | 'background'; narrowIndex?: number; capUsd: number } | null {
  const which = 'mode' in choice ? choice.mode : 'now';
  const cap = capFor(caps[which]);
  return cap === null ? null : { ...choice, capUsd: cap };
}
