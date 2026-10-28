/**
 * The activity log (v2 build, slice S5): the helper's recent runs, each in the person's own words, with what it did,
 * how it ended and what it cost. ONE reader that both the classic Settings › Activity log (serve.ts GET /api/runs) and
 * the v1 route (GET /api/v1/activity) use.
 *
 * The run log (data/runs.jsonl, written by agent.ts) keeps the start of the instruction the run was given and the start
 * of its summary. Either may quote something the person pasted — a key, a password — so the v1 view is a short list of
 * fields (never the refusal log, the claims or the gates) and both texts go through redactText: saved-login values
 * become ‹vault:…›, and anything shaped like a key, a token, a password after its label or a URL's password is masked.
 * The tools a run used are listed by name only (the log never holds their arguments).
 */
import { readFileSync } from 'node:fs';
import { runLogPath } from './paths.js';
import { redactVault } from './vault/vault.js';
import { redactArgs } from './api/routes/plugins.js';
import { getProject } from './v2/projects.js';
import { jobBySchedule, getJob } from './v2/jobs.js';

/** One line of the run log, as agent.ts writes it (the fields used here). */
export interface RunLine {
  ts?: number; session?: string; instruction?: string; reason?: string; outcome?: string; job?: string;
  steps?: number; toolCalls?: number; actions?: string[]; learned?: number; costUsd?: number; durationMs?: number; summary?: string;
}

/** The last `max` runs, newest first (the classic page's list, unchanged). */
export function readRuns(max = 60, path = runLogPath()): RunLine[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').slice(-max)
      .map((l) => { try { return JSON.parse(l) as RunLine; } catch { return null; } })
      .filter((x): x is RunLine => !!x && typeof x === 'object').reverse();
  } catch { return []; }
}

const MASK = '•••';
/** A pasted secret, masked: saved-login values, key- and token-shaped words, "password: x", URL passwords. */
export function redactText(text: string): string {
  if (!text) return '';
  let t = redactVault(text);
  t = t.replace(/\b(password|passwd|passcode|pwd|pin|secret|api[ _-]?key|token|auth(?:orization)?)(\s*(?:is|=|:)\s*)("[^"]*"|'[^']*'|\S+)/gi, (_m, k: string, sep: string) => `${k}${sep}${MASK}`);
  t = t.replace(/(--?[a-z-]*(?:token|key|secret|password|passwd|pwd|auth)[a-z-]*)(\s+)(?!-)(\S+)/gi, (_m, k: string, sep: string) => `${k}${sep}${MASK}`);
  // the plug-in argument masker, word by word (key=value, tokens, URL credentials, bearer …)
  return t.split(/(\s+)/).map((w) => (/^\s*$/.test(w) ? w : redactArgs([w])[0])).join('');
}

/** What the person asked, out of the instruction a run was given (the classic Log's ownerWords, F11): the run log
 *  keeps the whole prompt, with the carried conversation, file notes and work notes the server adds. */
export function ownerWords(instruction: string): string {
  let t = String(instruction ?? '');
  const nr = /New request:\s*([\s\S]*)$/.exec(t); if (nr) t = nr[1];
  t = t.split(/\s*\((?:Files you write|Work you are doing|NOTE:|The answer to revise)/)[0];
  t = t.replace(/\n\nNOTE: It's unclear[\s\S]*$/, '');
  if (/^Call goal_note for goal/i.test(t)) return 'Background: noted where a piece of work stands';
  if (/^Recent conversation so far:/i.test(t)) return 'A follow-up in a conversation';
  // a path is shown by its last part
  t = t.replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s"'()]+[\\/])+([^\\/\s"'()]+)/g, '$1');
  return t.replace(/\s+/g, ' ').trim().slice(0, 220) || 'A run';
}

export type ActivityOutcome = 'done' | 'stopped' | 'offered' | 'could-not';
export interface ActivityRun {
  at: number | null; what: string; outcome: ActivityOutcome; outcomeText: string; where: string;
  kind: 'chat' | 'job' | 'other'; steps: number; toolCalls: number; tools: string[]; learned: number;
  costUsd: number; durationMs: number | null; summary: string | null;
}

const REASON_TEXT: Record<string, string> = { done: 'Done', stopped: 'Stopped by you', offer: 'Offered to carry on in the background' };
const TOOL = /^[a-z][a-z0-9_.-]{0,60}$/i;

/** Where a run (or a model call) happened, in words: the project's name, the job's title, or the channel. */
export function whereOf(r: { session?: string; job?: string }): { kind: ActivityRun['kind']; where: string } {
  const s = String(r.session ?? '');
  try {
    const job = r.job ? (getJob(r.job) ?? jobBySchedule(r.job)) : s.startsWith('job_') ? jobBySchedule(s.slice(4)) : undefined;
    if (job || s.startsWith('job_')) return { kind: 'job', where: job?.title ? `Job: ${redactText(job.title).slice(0, 80)}` : 'A job' };
    const pm = /^p-(.+)$/.exec(s);
    if (pm) { const p = getProject(pm[1]); return { kind: 'chat', where: p ? p.name : 'A conversation' }; }
  } catch { /* the app database isn't open: words without names */ }
  if (/^(tg|telegram)/i.test(s)) return { kind: 'chat', where: 'Telegram' };
  if (/^(mail|mailbox)/i.test(s)) return { kind: 'other', where: 'Your mailbox' };
  return s ? { kind: 'chat', where: 'A conversation' } : { kind: 'other', where: 'In the background' };
}

/** One run for the v2 app: only these fields, with the texts redacted. */
export function activityOf(r: RunLine): ActivityRun {
  const reason = String(r.reason ?? '');
  const outcome: ActivityOutcome = reason === 'done' ? 'done' : reason === 'stopped' ? 'stopped' : reason === 'offer' ? 'offered' : 'could-not';
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const summary = typeof r.summary === 'string' && r.summary.trim() ? redactText(r.summary.trim()).slice(0, 200) : null;
  return {
    at: typeof r.ts === 'number' ? r.ts : null,
    what: redactText(ownerWords(String(r.instruction ?? ''))),
    outcome, outcomeText: REASON_TEXT[reason] ?? 'Couldn’t finish',
    ...whereOf(r),
    steps: n(r.steps), toolCalls: n(r.toolCalls),
    tools: [...new Set((Array.isArray(r.actions) ? r.actions : []).filter((a): a is string => typeof a === 'string' && TOOL.test(a)))].slice(0, 20),
    learned: n(r.learned), costUsd: Math.round(n(r.costUsd) * 10_000) / 10_000,
    durationMs: typeof r.durationMs === 'number' && r.durationMs >= 0 ? r.durationMs : null,
    summary,
  };
}

/** The v1 view: the last `limit` runs (at most 200), newest first, and how much they cost together. */
export function activityView(limit = 60, path = runLogPath()) {
  const runs = readRuns(Math.max(1, Math.min(200, limit)), path).map(activityOf);
  return { runs, totalUsd: Math.round(runs.reduce((a, r) => a + r.costUsd, 0) * 10_000) / 10_000 };
}
