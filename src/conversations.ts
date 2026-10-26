/**
 * BL-71d — conversations you can go back to. The chat on screen lived only in the browser tab, and the
 * server's thread only in memory, so a reload, a deploy or another device started blank (Robert, 2026-10-22:
 * "you can't go back immediately and continue a conversation"). The run log keeps 200 characters of each
 * reply — not enough to show a conversation again — so each chat turn is kept here in full: one JSON line per
 * turn, beside the run log (MWA_CONVERSATIONS, else conversations.jsonl next to MWA_RUNLOG).
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runLogPath } from './paths.js';

export interface ConversationTurn {
  ts: number; session: string; message: string; reply: string; reason?: string;
  /** the turn read outside content: it goes back into the model's context only fenced */
  tainted?: boolean;
  /** a scheduled or background result posted into this conversation, not a turn the person typed; `running` is a
   *  turn whose run has started and not finished (F09, 2026-10-24) — the page re-attaches to it after a reload */
  kind?: 'chat' | 'result' | 'offer' | 'running' | 'offer-answer';
  /** the live run this turn belongs to: the `running` turn and its finished turn share it */
  runId?: string;
  /** on an `offer` turn, how the person answered it (folded in from an `offer-answer` record); on an `offer-answer`
   *  record, the answer itself. Pending list 2026-10-26, item 3a: the app used to guess this from words and time. */
  offer?: { answered: 'background' | 'now'; goal?: string; at: number };
  /** on an `offer-answer` record: the `ts` of the offer turn it answers */
  answers?: number;
}
export interface ConversationSummary { session: string; title: string; last: number; turns: number; lastMessage: string }

const MAX_TEXT = 20_000;

export function conversationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MWA_CONVERSATIONS ?? join(dirname(runLogPath(env)), 'conversations.jsonl');
}

/** Keep one turn. Best effort: a chat never fails because its log couldn't be written. */
export function appendTurn(t: ConversationTurn, path = conversationsPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ...t, session: t.session.slice(0, 80), message: t.message.slice(0, MAX_TEXT), reply: t.reply.slice(0, MAX_TEXT) }) + '\n');
  } catch { /* best effort */ }
}

/** The log's last 8 MB at most: it is read on every list and reopen, and only grows. */
const MAX_READ = 8 * 1024 * 1024;
function readAll(path: string): ConversationTurn[] {
  if (!existsSync(path)) return [];
  try {
    const size = statSync(path).size;
    let text: string;
    if (size <= MAX_READ) text = readFileSync(path, 'utf8');
    else {
      const fd = openSync(path, 'r');
      try { const buf = Buffer.alloc(MAX_READ); readSync(fd, buf, 0, MAX_READ, size - MAX_READ); text = buf.toString('utf8'); text = text.slice(text.indexOf('\n') + 1); }
      finally { closeSync(fd); }
    }
    return text.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as ConversationTurn; } catch { return null; } })
      .filter((t): t is ConversationTurn => !!t && typeof t.session === 'string' && typeof t.ts === 'number');
  } catch { return []; }
}

/** The person answered the conversation's latest unanswered offer: "Work on it" (background, with the goal it made)
 *  or "do it here" (now). Appended as its own record, so the log stays append-only; readConversation folds it into
 *  the offer turn. Returns the offer's ts, or null when nothing was waiting. */
export function answerOffer(session: string, answered: 'background' | 'now', goal?: string, path = conversationsPath(), now = Date.now(), message?: string): number | null {
  const mine = readAll(path).filter((t) => t.session === session);
  const answered0 = new Set(mine.filter((t) => t.kind === 'offer-answer').map((t) => t.answers));
  const open = [...mine].reverse().filter((t) => t.kind === 'offer' && !answered0.has(t.ts));
  // two offers waiting: the one whose words were sent back, else the latest
  const offer = (message ? open.find((t) => t.message === message.slice(0, MAX_TEXT)) : undefined) ?? open[0];
  if (!offer) return null;
  appendTurn({ ts: now, session, message: offer.message, reply: '', kind: 'offer-answer', answers: offer.ts, offer: { answered, ...(goal ? { goal } : {}), at: now } }, path);
  return offer.ts;
}

/** A conversation's turns, oldest first (the last `limit`). */
export function readConversation(session: string, limit = 60, path = conversationsPath()): ConversationTurn[] {
  const all = readAll(path).filter((t) => t.session === session).sort((a, b) => a.ts - b.ts);
  // An offer's answer rides on the offer turn, not as a turn of its own.
  const answers = new Map(all.filter((t) => t.kind === 'offer-answer' && t.answers !== undefined).map((t) => [t.answers, t.offer] as const));
  const turns = all.filter((t) => t.kind !== 'offer-answer').map((t) => (t.kind === 'offer' && answers.has(t.ts) ? { ...t, offer: answers.get(t.ts) } : t));
  // A `running` turn stands only until its run's finished turn is written (F09).
  const finished = new Set(turns.filter((t) => t.kind !== 'running' && t.runId).map((t) => t.runId));
  return turns.filter((t) => t.kind !== 'running' || !finished.has(t.runId)).slice(-limit);
}

/** Conversations, most recently active first, titled by their first message. */
export function listConversations(limit = 30, path = conversationsPath()): ConversationSummary[] {
  const by = new Map<string, ConversationSummary>();
  for (const t of readAll(path).sort((a, b) => a.ts - b.ts)) {
    if (t.kind === 'offer-answer') continue; // not a turn: an answer riding on one
    const s = by.get(t.session);
    const typed = t.kind !== 'result';
    if (!s) by.set(t.session, { session: t.session, title: typed ? titleOf(t.message) : 'Results', last: t.ts, turns: 1, lastMessage: titleOf(t.message) });
    else {
      s.last = t.ts; s.turns++; s.lastMessage = titleOf(t.message);
      if (s.title === 'Results' && typed) s.title = titleOf(t.message);
    }
  }
  return [...by.values()].sort((a, b) => b.last - a.last).slice(0, limit);
}

function titleOf(message: string): string {
  const m = message.replace(/\s+/g, ' ').trim();
  return m.length > 80 ? `${m.slice(0, 77).replace(/\s+\S*$/, '')}…` : m;
}
