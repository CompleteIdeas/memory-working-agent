/**
 * BL-71d — conversations you can go back to. The chat on screen lived only in the browser tab, and the
 * server's thread only in memory, so a reload, a deploy or another device started blank (Robert, 2026-10-22:
 * "you can't go back immediately and continue a conversation"). The run log keeps 200 characters of each
 * reply — not enough to show a conversation again — so each chat turn is kept here in full: one JSON line per
 * turn, beside the run log (MWA_CONVERSATIONS, else conversations.jsonl next to MWA_RUNLOG).
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ConversationTurn {
  ts: number; session: string; message: string; reply: string; reason?: string;
  /** a scheduled or background result posted into this conversation, not a turn the person typed */
  kind?: 'chat' | 'result' | 'offer';
}
export interface ConversationSummary { session: string; title: string; last: number; turns: number; lastMessage: string }

const MAX_TEXT = 20_000;

export function conversationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MWA_CONVERSATIONS ?? join(dirname(env.MWA_RUNLOG ?? resolve('./data/runs.jsonl')), 'conversations.jsonl');
}

/** Keep one turn. Best effort: a chat never fails because its log couldn't be written. */
export function appendTurn(t: ConversationTurn, path = conversationsPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ...t, session: t.session.slice(0, 80), message: t.message.slice(0, MAX_TEXT), reply: t.reply.slice(0, MAX_TEXT) }) + '\n');
  } catch { /* best effort */ }
}

function readAll(path: string): ConversationTurn[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as ConversationTurn; } catch { return null; } })
      .filter((t): t is ConversationTurn => !!t && typeof t.session === 'string' && typeof t.ts === 'number');
  } catch { return []; }
}

/** A conversation's turns, oldest first (the last `limit`). */
export function readConversation(session: string, limit = 60, path = conversationsPath()): ConversationTurn[] {
  return readAll(path).filter((t) => t.session === session).sort((a, b) => a.ts - b.ts).slice(-limit);
}

/** Conversations, most recently active first, titled by their first message. */
export function listConversations(limit = 30, path = conversationsPath()): ConversationSummary[] {
  const by = new Map<string, ConversationSummary>();
  for (const t of readAll(path).sort((a, b) => a.ts - b.ts)) {
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
