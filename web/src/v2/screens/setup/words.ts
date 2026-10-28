/**
 * The words of getting going (v2 build, slice S6), as plain functions tested without React (tests/web-v2-s6.test.ts):
 * what is missing without an AI brain, a setup card's lines, the inbox scan's state, where memory is kept.
 */
import type { BrainState, InboxScan, SetupCard, StorageView } from '../../api/client';

/** The bar every screen shows while the helper has no working brain (null when it has one). */
export function brainBar(b: BrainState | null, admin: boolean): { text: string; action: string | null } | null {
  if (!b || b.ready) return null;
  const head = b.model ? 'Your helper’s AI brain isn’t working' : 'Your helper has no AI brain yet';
  const why = b.model && b.provider ? ` (${b.provider} has no key saved)` : '';
  return admin
    ? { text: `${head}${why}, so it can’t answer, sort your mail or do jobs.`, action: b.model ? 'Fix it' : 'Set it up' }
    : { text: `${head}${why}, so it can’t answer, sort your mail or do jobs. Set it up on your computer, in Settings › Your assistant.`, action: null };
}

/** "Waiting for you · expires in 12 minutes" and the like. */
export function cardStateLine(c: SetupCard): string {
  if (c.state === 'waiting') {
    const m = Math.max(1, Math.round(c.expiresInSec / 60));
    return `Waiting for you · closes in ${m} minute${m === 1 ? '' : 's'}`;
  }
  return ({ done: 'Done', failed: 'Didn’t work', cancelled: 'Closed', expired: 'Expired' } as Record<string, string>)[c.state] ?? c.state;
}
/** Why the card is there, in one line. */
export function cardAsk(c: SetupCard): string {
  if (c.vault) return `Your helper asked for a login to keep in your vault${c.vault.site ? `, used only on ${c.vault.site}` : ''}. Only fill it in if you asked for this.`;
  return `Your helper asked to connect ${c.name}. Only fill it in if you asked for this.`;
}
/** The working sheet / Today line for the waiting cards. */
export function cardsWaitingLine(n: number): string { return n === 1 ? 'Your helper needs a password or key' : `Your helper needs ${n} passwords or keys`; }

const STATE: Record<InboxScan['state'], string> = {
  idle: 'Not run yet', running: 'Reading your email…', stopping: 'Stopping after this round…', done: 'Done', stopped: 'Stopped', failed: 'Didn’t finish',
};
export function inboxStateLine(s: InboxScan): string { return s.message || STATE[s.state]; }
export const inboxRunning = (s: InboxScan | null | undefined) => !!s && (s.state === 'running' || s.state === 'stopping');

export function kindLabel(k: StorageView['running'], hosted: boolean, host: string): string {
  if (k === 'postgres') return 'A database server (Postgres)';
  if (k === 'pglite') return 'This computer (PGlite)';
  return hosted ? `A file on your ${host} deploy` : 'This computer';
}
/** "This computer · private" now, and what changes at the restart. */
export function storageLines(v: StorageView): { now: string; next: string | null } {
  const now = `${kindLabel(v.running, v.hosted, v.host)}${v.running === 'postgres' && v.server ? ` · ${v.server}` : v.running === 'sqlite' ? ' · private to it' : ''}`;
  if (!v.restartNeeded) return { now, next: null };
  return { now, next: `After your helper restarts: ${kindLabel(v.next, v.hosted, v.host)}${v.next === 'postgres' && v.nextServer ? ` (${v.nextServer})` : ''}.` };
}
/** A Postgres address checked here before it goes to the server (the server checks again). */
export function urlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return 'Paste the database’s address.';
  if (!/^postgres(ql)?:\/\/\S+$/i.test(u)) return 'It starts with postgres:// — like postgres://user:password@host:5432/database.';
  return null;
}
