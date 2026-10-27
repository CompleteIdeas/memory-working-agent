/**
 * The approval sheet's words (v2 build, slice S4), as plain functions so they are tested without React
 * (tests/web-v2-s4.test.ts).
 */
import type { ApprovalView } from '../../api/client';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Waits until 9:40 AM (30 min left)" / "until tomorrow 9:10 AM" / "Expires in under a minute". */
export function waitsLine(a: Pick<ApprovalView, 'expiresAt'>, now: number): string {
  const left = a.expiresAt - now;
  if (left <= 0) return 'It has expired.';
  if (left < 60_000) return 'It expires in under a minute.';
  const mins = Math.round(left / 60_000);
  const sameDay = new Date(a.expiresAt).toDateString() === new Date(now).toDateString();
  const when = sameDay ? clock(a.expiresAt) : `${new Date(a.expiresAt).toLocaleDateString('en-US', { weekday: 'short' })} ${clock(a.expiresAt)}`;
  const span = mins < 60 ? `${mins} min left` : mins < 48 * 60 ? `${Math.round(mins / 60)} h left` : `${Math.round(mins / 1440)} days left`;
  return `It waits for you until ${when} (${span}).`;
}

/** What has happened to one that is no longer waiting. */
export function stateLine(a: Pick<ApprovalView, 'state' | 'decidedAt' | 'expiresAt' | 'ranIn'>): string {
  switch (a.state) {
    case 'done': return 'Approved. It ran.';
    case 'failed': return 'Approved, but it failed.';
    case 'approved': return `Approved. It runs in ${a.ranIn ?? 'the app that asked for it'}, within a minute or so.`;
    case 'executing': return 'Approved. It is running now.';
    case 'declined': return 'You said no. Nothing was changed.';
    case 'expired': return `It expired${a.expiresAt ? ` at ${clock(a.expiresAt)}` : ''}, so nothing was done.`;
    default: return '';
  }
}

/** The reviewer's opinion in a sentence ("would have let it run", "would ask you"). */
export function reviewerLine(r: ApprovalView['reviewer']): string | null {
  if (!r) return null;
  const reason = r.reason.replace(/[.\s]+$/, '');
  return r.decision === 'auto' ? `MWA’s reviewer would have let this run: ${reason}.` : `MWA’s reviewer would ask you too: ${reason}.`;
}

/** The "Are you sure?" sentence: the high risks, briefly. */
export function sureLine(a: Pick<ApprovalView, 'risks' | 'caution'>): string {
  const SHORT: Record<string, string> = {
    phishing: 'it came from an email that looks like phishing', outside: 'it was proposed after reading outside content', money: 'it may spend or move money',
    send: 'it sends something as you', delete: 'it deletes something', network: 'it reaches the internet', self: 'it targets your helper’s own controls',
    'outside-folders': 'it reaches outside its own folder', 'new-server': 'it adds a program that runs with every message',
  };
  const parts = a.risks.filter((r) => r.level === 'high').map((r) => SHORT[r.kind]).filter((x): x is string => !!x);
  if (!parts.length) return 'Approve it?';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Approve it even though ${list}?`;
}

/**
 * What waits, as the lists show it (review of S4, matching Today and push): `mine` — yours, not phishing-flagged;
 * `others` — asked for in someone else's conversation (a Telegram contact), shown quieter. A phishing-flagged one is in
 * neither: it is reached only from its Important item's detail, behind the warning.
 */
export function groupPending(pending: ApprovalView[]): { mine: ApprovalView[]; others: ApprovalView[] } {
  const ok = pending.filter((a) => a.caution !== 'phishing');
  return { mine: ok.filter((a) => a.forOwner), others: ok.filter((a) => !a.forOwner) };
}
/** Yours, waiting, that no job asked for (a chat's): the status pill counts them as waiting for you. */
export function looseCount(pending: ApprovalView[]): number {
  return pending.filter((a) => a.state === 'pending' && !a.job && a.forOwner && a.caution !== 'phishing').length;
}

/** The pending ones for the working sheet's Review of a job: that job's, else all. */
export function forJob(pending: ApprovalView[], jobId: string): ApprovalView[] {
  return pending.filter((a) => a.job?.id === jobId);
}
