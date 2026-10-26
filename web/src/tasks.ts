// The task model (usability review 2026-10-24, D1): every request the person makes becomes a task with ONE status,
// derived here from the run events and the conversation's turn kinds, and read by every view that shows it (the
// conversation, the Tasks rail and list, Needs you, the return digest), so they cannot disagree.
import type { ConversationTurn, PendingApproval, ApprovalOutcome, ScheduleRow, Stage, WorkGoal, SpineStep, ChatResult } from './api';

export type TaskStatus = 'needs-you' | 'working' | 'scheduled' | 'done' | 'stopped' | 'failed';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  'needs-you': 'waiting for you', working: 'working', scheduled: 'scheduled', done: 'done', stopped: 'stopped', failed: 'failed',
};

/** A card: an approval waiting or ended, shown inside the task that raised it. */
export interface Card {
  id: string; tool: string; summary: string; kind: 'tool' | 'captured-policy';
  state: 'pending' | 'approved' | 'done' | 'failed' | 'declined' | 'expired';
  expiresAt?: number; createdAt?: number; at?: number; result?: string; session?: string; tainted?: boolean; readLocal?: boolean;
  /** other cards for the same action, folded into this one (F03) */
  dupes: string[];
}

/** What is happening live in this page for a run (from the stream, or re-attached after a reload). */
export interface LiveState {
  runId?: string; startedAt: number; stage?: Stage; steps: SpineStep[]; stopping?: boolean;
  /** notes the person added while it ran (steer) */
  notes: string[];
}

export interface Task {
  key: string; session: string;
  /** a short title from the person's own words */
  title: string;
  /** what they typed */
  words: string;
  /** when it was asked (approximate for a finished turn: the previous turn's end) and when it ended */
  startedAt: number; endedAt?: number;
  reply?: string; reason?: string; runId?: string; turnId?: number; elapsedMs?: number; costUsd?: number;
  steps: SpineStep[];
  live?: LiveState;
  /** offered to the background and not answered yet / handed over; `goal` is the goal's short id when the server
   *  recorded the answer */
  offer?: { answered?: 'background' | 'now' | 'failed'; note?: string; goal?: string };
  /** results a background job or a schedule posted for this task */
  results: ConversationTurn[];
  cards: Card[];
  jobs: ScheduleRow[];
  goal?: WorkGoal;
  /** this task revises another (F08): the key of the one it revises, and the change asked for */
  revises?: { title: string; change: string };
  revisions: Task[];
  error?: string;
  /** what the person added while it ran */
  added?: string[];
  /** a local turn not yet kept on the server */
  local?: boolean;
  status: TaskStatus;
}

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A short title from the person's words: the first sentence, without "please" and pasted paths. */
export function titleOf(words: string): string {
  let t = words.replace(/^⏰\s*/, '').replace(/\s+/g, ' ').trim();
  const rev = parseRevision(t); if (rev) t = rev.change;
  t = t.replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s]+[\\/])+([^\\/\s]+)/g, '$1'); // C:\…\file.txt → file.txt
  t = t.replace(/^(please|could you|can you|hey mwa|mwa)[,\s]+/i, '');
  const first = /^(.{12,}?[.?!])(\s|$)/.exec(t)?.[1] ?? t;
  const out = first.length > 72 ? first.slice(0, 70).replace(/\s+\S*$/, '') + '…' : first;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const REVISE = /^Revise your answer to "([^"]{1,200})":\s*([\s\S]*?)(?:\n\n\(The answer to revise:[\s\S]*)?$/;
/** The message a Revise box sends: a normal chat message that names the task and quotes what it changes (the
 *  backend's `revise: <turnId>` targeting is not built, so the quote carries the target). */
export function revisionMessage(task: Task, change: string): string {
  const quoted = (task.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 700);
  return `Revise your answer to "${task.title.replace(/"/g, "'")}": ${change.trim()}\n\n(The answer to revise: "${quoted}${(task.reply ?? '').length > 700 ? '…' : ''}" Change only that answer; keep everything else in it.)`;
}
export function parseRevision(message: string): { title: string; change: string } | null {
  const m = REVISE.exec(message.trim());
  return m ? { title: m[1], change: m[2].trim() } : null;
}

/** Replies point at Telegram even where it is not connected (F20; the wording comes from the server, agent.ts). */
export function withoutTelegram(text: string, telegram: boolean): string {
  if (telegram) return text;
  return text
    .replace(/\s*\(?(?:,\s*)?or (?:with |tap )?the (?:Approve )?button in Telegram\)?/gi, '')
    .replace(/\s*(?:,\s*)?or (?:with |using )?(?:the )?Telegram(?:'s)? (?:Approve )?button/gi, '')
    .replace(/\s*(?:here )?or in Telegram/gi, '')
    .replace(/the approvals panel in the app/gi, 'the card in this task')
    .replace(/,\s*\./g, '.');
}

/** A reply as shown: no Telegram where it is not connected, and full drive paths (C:\…) shortened to the file or
 *  folder name, except inside a markdown link target (F19: an owner cannot read a 120-character path). */
export function plainReply(text: string, telegram: boolean): string {
  return withoutTelegram(text, telegram).replace(/(?<!\]\()(?<![\w/])[A-Za-z]:\\[^\s"'`)\]]*/g, (m) => shortName(m.replace(/[.,;:]+$/, '')) + (/[.,;:]$/.test(m) ? m.slice(-1) : ''));
}

/** A path made short: the file name, and the folder it sits in. */
/** Names of the granted folders, set from /api/sources, so a card can say "a folder you granted". */
let granted: string[] = [];
export function setGrantedNames(paths: string[]): void { granted = paths.map((p) => shortName(p).toLowerCase()); }
function grantedName(name: string): boolean { return granted.includes(name.toLowerCase()); }

export function shortName(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}
export function folderName(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}
/** Full Windows/Unix paths in a text replaced by their file name (the full text stays on demand). */
export function shortenPaths(text: string): string {
  return text.replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s"'()]+[\\/])+([^\\/\s"'()]+)/g, '$1');
}

/** A card in plain words (F19): what will happen, to what, where; the exact command only on demand. */
export interface PlainCard { title: string; rows: [string, string][]; ifApprove: string; ifDecline: string; exact?: string }
export function plainCard(c: Pick<Card, 'tool' | 'summary' | 'kind'>): PlainCard {
  const s = c.summary;
  const quoted = [...s.matchAll(/"([^"]{3,})"/g)].map((m) => m[1]);
  if (c.kind === 'captured-policy' || c.tool === 'policy_save') {
    const rule = quoted.pop() ?? s;
    return { title: 'Save a standing preference', rows: [['Preference', rule], ['Applies to', 'every future task, in every conversation']],
      ifApprove: 'Kept under Memory › Standing preferences, where you can remove it.', ifDecline: 'Nothing is saved; it applies to this conversation only.' };
  }
  if (c.tool === 'policy_forget') {
    return { title: 'Remove a standing preference', rows: [['Preference', quoted.pop() ?? s]], ifApprove: 'It no longer applies to new tasks.', ifDecline: 'It stays as it is.' };
  }
  if (c.tool === 'write_file') {
    const m = /(Overwrite|Create) the file (.+?) \((\d+) bytes\)/.exec(s);
    const path = m?.[2] ?? '';
    return { title: `${m?.[1] === 'Overwrite' ? 'Replace' : 'Create'} ${shortName(path) || 'a file'}`,
      rows: [['File', shortName(path)], ['Where', `${folderName(path) || 'a folder'} (a folder you granted)`], ...(m?.[1] === 'Overwrite' ? [['Note', 'The current contents are replaced.'] as [string, string]] : [])],
      ifApprove: `${shortName(path)} is written there.`, ifDecline: 'Nothing is written.', exact: s };
  }
  if (c.tool === 'run_command') {
    const cmd = (s.split('\n').find((l) => l.startsWith('  ')) ?? '').trim();
    const w = commandInWords(cmd);
    const reads = /^(List|Read) /.test(w.title);
    const changes = /^(Copy|Move|Rename|Delete|Write|Create) /.test(w.title);
    return { title: w.title, rows: [['Where', w.where ? `${w.where}${grantedName(w.where) ? ' (a folder you granted)' : ''}` : 'this conversation\'s working folder'], ['What it is', reads ? 'A command that only looks; it asks because commands are not on the safe list.' : changes ? 'A command that changes files.' : 'A script or command: it can read or change files, so check the exact action.']],
      ifApprove: 'It runs once, now, as you.', ifDecline: 'It does not run; nothing changes.', exact: s };
  }
  if (/email|outlook|draft/i.test(c.tool)) {
    return { title: shortenPaths(s.split('\n')[0]).slice(0, 120), rows: [], ifApprove: 'It is done as described.', ifDecline: 'Nothing is sent or changed.', exact: s };
  }
  const first = shortenPaths(s.split('\n')[0]).slice(0, 140);
  return { title: first || c.tool.replace(/_/g, ' '), rows: [], ifApprove: 'It is done as described.', ifDecline: 'Nothing changes.', exact: s.length > first.length ? s : undefined };
}

/** A shell command as a person would say it, and the folder it touches. */
export function commandInWords(cmd: string): { title: string; where?: string } {
  const quoted = [...[...cmd.matchAll(/'([^']+)'/g)].map((m) => m[1]), ...[...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1])].filter((x) => /[\\/]|\.\w{1,5}$/.test(x) && !/^-/.test(x) && !/\s-\w/.test(x));
  const bare = [...cmd.matchAll(/(?:^|\s)((?:[A-Za-z]:)?[^\s'"]*[\\/][^\s'"]+|[^\s'"]+\.\w{1,5})(?=\s|$)/g)].map((m) => m[1]);
  const paths = quoted.length ? quoted : bare;
  const files = paths.map(shortName);
  const where = paths[0] ? (/\.\w{1,5}$/.test(paths[0]) ? folderName(paths[0]) : shortName(paths[0])) : undefined;
  // the verb is the first word of the command, or the first word after -Command ", &&, ; or |
  const heads = [cmd.trim(), ...cmd.split(/-Command\s+["']|&&|;|\|/i).slice(1)].map((x) => x.trim().split(/\s+/)[0]?.replace(/^["'&]+/, '').toLowerCase() ?? '');
  const has = (re: RegExp) => heads.some((h) => re.test(h));
  let title: string;
  if (has(/^(copy-item|copy|cp|xcopy|robocopy)$/i) && files.length >= 2) title = `Copy ${files[0]} to ${files[1]}`;
  else if (has(/^(rename-item|ren|rename)$/i) && files.length >= 1) title = `Rename ${files[0]}${files[1] ? ` to ${files[1]}` : (/-NewName\s+'?([^'\s]+)/i.exec(cmd)?.[1] ? ` to ${/-NewName\s+'?([^'\s]+)/i.exec(cmd)![1]}` : '')}`;
  else if (has(/^(move-item|move|mv)$/i) && files.length >= 2) title = `Move ${files[0]} to ${files[1]}`;
  else if (has(/^(remove-item|del|erase|rm|rmdir|rd)$/i)) title = `Delete ${files[0] ?? 'files'}`;
  else if (has(/^(get-childitem|dir|ls|tree)$/i)) title = `List the files in ${files[0] ?? 'a folder'}`;
  else if (has(/^(get-content|type|cat|more)$/i)) title = `Read ${files[0] ?? 'a file'}`;
  else if (has(/^(set-content|out-file|add-content)$/i)) title = `Write ${files[0] ?? 'a file'}`;
  else if (has(/^(new-item|mkdir|md)$/i)) title = `Create ${files[0] ?? 'a folder'}`;
  else if (has(/^git$/i)) title = `Run git ${cmd.trim().split(/\s+/).slice(1, 3).join(' ')}`;
  else if (has(/^(python|python3|py|node|powershell|pwsh)$/i)) title = `Run a small script${files.length ? ` on ${files.slice(0, 2).join(', ')}` : ''}`;
  else title = `Run a command${files.length ? ` on ${files.slice(0, 2).join(', ')}` : ''}`;
  return { title, where };
}

/** The file an action creates or changes, when it is one (write_file, or a shell copy/move/rename). */
export function effectTarget(c: Pick<Card, 'tool' | 'summary'>): string | null {
  if (c.tool === 'write_file') { const m = /(?:Overwrite|Create) the file (.+?) \(\d+ bytes\)/.exec(c.summary); return m ? shortName(m[1]) : null; }
  if (c.tool === 'run_command') {
    const cmd = (c.summary.split('\n').find((l) => l.startsWith('  ')) ?? '').trim();
    const w = commandInWords(cmd).title;
    const m = /^(?:Copy|Move|Rename) \S+ to (\S+)$/.exec(w);
    return m ? m[1] : null;
  }
  return null;
}

/** A key for "the same action": a rule's words, or the tool with its summary (F03: one preference, four cards). */
export function sameActionKey(c: Pick<Card, 'tool' | 'summary' | 'kind'>): string {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (c.kind === 'captured-policy' || c.tool === 'policy_save') { const q = [...c.summary.matchAll(/"([^"]{3,})"/g)].pop(); return 'rule:' + norm(q ? q[1] : c.summary); }
  // the same file made two ways (write_file and a shell copy, review F02): one decision
  const target = effectTarget(c);
  if (target) return 'file:' + target.toLowerCase();
  return c.tool + ':' + norm(c.summary);
}

// ── building tasks ────────────────────────────────────────────────────────────────────────────────────────────

const FAILED = /^(error|failed|max|wall|budget|stuck|tokens|could-not|limit)/i;

export function statusOf(t: Omit<Task, 'status'>): TaskStatus {
  if (t.live && !t.endedAt) return 'working';
  if (t.cards.some((c) => c.state === 'pending')) return 'needs-you';
  if (t.offer && !t.offer.answered) return 'needs-you';
  if (t.offer?.answered === 'background') {
    if (t.goal?.status === 'blocked' && !t.results.length) return 'stopped';
    if (!t.results.length) return t.goal?.status === 'done' ? 'done' : 'working';
    // the newest result says how it ended
    const last = t.results[t.results.length - 1];
    return !last.reason || last.reason === 'done' ? 'done' : 'failed';
  }
  if (t.jobs.length) return 'scheduled';
  if (t.error) return 'failed';
  if (t.results.length) { const last = t.results[t.results.length - 1]; return !last.reason || last.reason === 'done' ? 'done' : 'failed'; }
  if (t.reason === 'stopped') return 'stopped';
  if (t.reason && FAILED.test(t.reason)) return 'failed';
  return 'done';
}

export interface Inputs {
  session: string;
  turns: ConversationTurn[];
  /** run ids of running turns the server no longer has */
  lost?: Set<string>;
  /** steps the page saw, by live run id */
  stepsByRun?: Record<string, SpineStep[]>;
  /** notes the person added to a run while it went (steer), by live run id */
  notesByRun?: Record<string, string[]>;
  pending: PendingApproval[];
  recent: ApprovalOutcome[];
  schedule: ScheduleRow[];
  goals: WorkGoal[];
  /** live state per run id or for the session's newest local task */
  live?: LiveState | null;
  /** local tasks not yet on the server (being sent, or just finished) */
  local?: LocalTask[];
  /** offers answered in this page */
  offers?: Record<string, { answered: 'background' | 'now' | 'failed'; note?: string }>;
}

/** A task the page has sent and not yet seen kept on the server. */
export interface LocalTask { id: number; session: string; words: string; startedAt: number; live?: LiveState; result?: ChatResult; error?: string; steps: SpineStep[] }

/** Cards of a session, de-duplicated, newest state first. */
export function cardsFor(session: string, pending: PendingApproval[], recent: ApprovalOutcome[]): Card[] {
  const out: Card[] = [];
  const byKey = new Map<string, Card>();
  const add = (c: Card) => {
    const k = sameActionKey(c);
    const have = byKey.get(k);
    // one card per action: a waiting card wins over an ended one; among ended ones, the newest
    if (have) {
      if (have.state !== 'pending' && c.state === 'pending') { c.dupes = [...have.dupes, have.id]; out[out.indexOf(have)] = c; byKey.set(k, c); }
      else have.dupes.push(c.id);
      return;
    }
    byKey.set(k, c); out.push(c);
  };
  for (const p of pending.filter((x) => (x.session ?? '') === session)) add({ id: p.id, tool: p.tool, summary: p.summary, kind: p.kind, state: 'pending', expiresAt: p.expiresAt ?? Date.now() + p.expiresInSec * 1000, createdAt: p.createdAt, session: p.session, tainted: p.tainted, readLocal: p.readLocal, dupes: [] });
  for (const r of recent.filter((x) => (x.session ?? '') === session)) {
    const state = r.status === 'cancelled' ? 'declined' : r.status;
    add({ id: r.id, tool: r.tool, summary: r.summary ?? r.tool, kind: r.kind ?? 'tool', state, at: r.at, createdAt: r.createdAt, result: r.result, session: r.session, dupes: [] });
  }
  return out;
}

/** The tasks of one conversation, oldest first, with cards, jobs and results placed in the task that raised them. */
export function buildTasks(inp: Inputs): Task[] {
  const { session } = inp;
  type Draft = Omit<Task, 'status'>;
  const drafts: Draft[] = [];
  const orphanResults: ConversationTurn[] = [];
  let prevEnd = 0;
  for (const t of [...inp.turns].sort((a, b) => a.ts - b.ts)) {
    if (t.kind === 'result') {
      // a background or scheduled result: it belongs to the task that handed the work over or set up the job
      const same = (d: { words: string }) => { const a = d.words.replace(/^⏰\s*/, '').trim().toLowerCase(), b = t.message.replace(/^⏰\s*/, '').trim().toLowerCase(); return a === b || (b.length > 24 && a.startsWith(b.slice(0, 60))) || (a.length > 24 && b.startsWith(a.slice(0, 60))); };
      const owner = [...drafts].reverse().find(same) ?? [...drafts].reverse().find((d) => d.offer?.answered === 'background' || d.offer && !d.offer.answered) ?? [...drafts].reverse().find((d) => /remind|every|each|watch|check|daily|weekday/i.test(d.words));
      if (owner) owner.results.push(t); else orphanResults.push(t);
      prevEnd = t.ts; continue;
    }
    const lostRun = t.kind === 'running' && !!t.runId && !!inp.lost?.has(t.runId);
    const running = t.kind === 'running' && !lostRun;
    const rev = parseRevision(t.message);
    const d: Draft = {
      key: `${session}:${t.runId ?? t.ts}`, session, title: titleOf(t.message), words: t.message,
      startedAt: running ? t.ts : Math.max(prevEnd + 1, t.ts - 1), endedAt: running ? undefined : t.ts,
      reply: running ? undefined : t.reply, reason: running ? undefined : t.reason, runId: t.runId, turnId: running ? undefined : t.ts,
      steps: (t.runId && inp.stepsByRun?.[t.runId]) || [], results: [], cards: [], jobs: [], revisions: [], ...(rev ? { revises: rev } : {}),
      // the server's record of the answer (every device sees it) beats this page's memory of it, which beats nothing
      ...(t.kind === 'offer' ? { offer: t.offer ? { ...(inp.offers?.[`${session}:${t.ts}`] ?? {}), answered: t.offer.answered, goal: t.offer.goal } : inp.offers?.[`${session}:${t.ts}`] ?? {} } : {}),
      ...(running ? { live: { runId: t.runId, startedAt: t.ts, steps: [], notes: [] } } : {}),
      ...(lostRun ? { error: 'This run ended without an answer (the server may have restarted). Ask again to redo it.' } : {}),
    };
    drafts.push(d);
    if (!running) prevEnd = t.ts;
  }
  // the page's own tasks: a turn being sent or just answered, until the server keeps it
  for (const l of inp.local ?? []) {
    if (l.session !== session) continue;
    const kept = drafts.find((d) => (l.result?.runId && d.runId === l.result.runId) || (l.live?.runId && d.runId === l.live.runId));
    if (kept) { if (kept.live && l.live) kept.live = { ...l.live }; if (!kept.endedAt && l.result) { kept.endedAt = l.result.turnId ?? Date.now(); kept.reply = l.result.summary; kept.reason = l.result.reason; } kept.steps = l.steps.length ? l.steps : kept.steps; if (kept.endedAt) kept.live = undefined; continue; }
    const rev = parseRevision(l.words);
    drafts.push({ key: `${session}:local-${l.id}`, session, title: titleOf(l.words), words: l.words, startedAt: l.startedAt, endedAt: l.result || l.error ? (l.result?.turnId ?? Date.now()) : undefined,
      reply: l.result?.summary, reason: l.result?.reason, runId: l.result?.runId ?? l.live?.runId, turnId: l.result?.turnId, elapsedMs: l.result?.elapsedMs, costUsd: l.result?.costUsd,
      steps: l.steps, live: l.result || l.error ? undefined : l.live ?? { startedAt: l.startedAt, steps: [], notes: [] }, results: [], cards: [], jobs: [], revisions: [], error: l.error, local: true,
      ...(rev ? { revises: rev } : {}), ...(l.result?.offer ? { offer: inp.offers?.[`${session}:local-${l.id}`] ?? {} } : {}) });
  }
  drafts.sort((a, b) => a.startedAt - b.startedAt);
  for (const d of drafts) { const n = (d.runId && inp.notesByRun?.[d.runId]) || d.live?.notes; if (n?.length) d.added = n; }
  // a live run the page is following, on the newest unfinished task
  if (inp.live) { const open = [...drafts].reverse().find((d) => !d.endedAt); if (open) open.live = { ...inp.live, notes: [...new Set([...(open.live?.notes ?? []), ...inp.live.notes])] }; }

  // cards: placed by time — each goes to the first task of the conversation that ended after it was staged
  for (const c of cardsFor(session, inp.pending, inp.recent)) {
    const at = c.createdAt ?? c.at ?? Date.now();
    // turns are kept in order and a finished turn's start is the previous one's end, so this partitions exactly
    const owner = drafts.find((d) => !d.endedAt || at <= d.endedAt + 1000) ?? drafts[drafts.length - 1];
    owner?.cards.push(c);
  }
  // jobs: to the task whose words asked for it, else the newest task of the conversation
  for (const j of inp.schedule) {
    if (j.session !== session) continue;
    const words = (j.request || j.instruction).toLowerCase().slice(0, 60);
    const owner = drafts.find((d) => d.words.toLowerCase().includes(words) || words.includes(d.words.toLowerCase().slice(0, 40))) ?? [...drafts].reverse().find((d) => /remind|every|each|daily|weekday|watch|check|schedule|at \d/i.test(d.words)) ?? drafts[drafts.length - 1];
    owner?.jobs.push(j);
  }
  // a background goal: "Work on it" makes a goal titled with the person's words, just after the offer. Matched by
  // those words and time, so an offer answered on another device (or before a reload) still shows as handed over.
  const used = new Set<string>();
  const words = (x: string) => x.toLowerCase().replace(/…$/, '').replace(/\s+/g, ' ').trim();
  for (const d of drafts) if (d.offer) {
    const w = words(d.words);
    // the goal the server named when the offer was answered (and no other, if that one is not here); else the one
    // that matches by words and time
    const g = d.offer.goal ? inp.goals.find((x) => !used.has(x.id) && x.id.startsWith(d.offer!.goal!)) : inp.goals.find((x) => !used.has(x.id) && (x.record?.conv ? x.record.conv === session : true)
      && w.startsWith(words(x.title).slice(0, 60)) && (!x.createdAt || (x.createdAt >= d.startedAt - 2000 && x.createdAt <= d.startedAt + 6 * 3_600_000)));
    if (g && (d.offer.answered === 'background' || !d.offer.answered)) { used.add(g.id); d.goal = g; if (!d.offer.answered) d.offer = { answered: 'background' }; }
    if (d.offer && !d.offer.answered && d.results.length) d.offer = { answered: 'background' };
  }
  // revisions sit under the task they revise
  const top: Draft[] = [];
  for (const d of drafts) {
    if (d.revises) {
      const target = [...top].reverse().find((x) => x.title === d.revises!.title || x.title.startsWith(d.revises!.title.replace(/…$/, '')));
      if (target) { target.revisions.push({ ...d, status: statusOf(d) }); continue; }
    }
    top.push(d);
  }
  const tasks = top.map((d) => ({ ...d, status: statusOf(d) }));
  // a revision still running makes its task working; one waiting for you makes it need you
  for (const t of tasks) for (const r of t.revisions) if (r.status === 'working' || r.status === 'needs-you') t.status = r.status;
  if (orphanResults.length) {
    tasks.push(...orphanResults.map((r) => {
      const d: Draft = { key: `${session}:result-${r.ts}`, session, title: titleOf(r.message), words: r.message, startedAt: r.ts, endedAt: r.ts, reply: r.reply, reason: r.reason, steps: [], results: [], cards: [], jobs: [], revisions: [] };
      return { ...d, status: statusOf(d) };
    }));
    tasks.sort((a, b) => a.startedAt - b.startedAt);
  }
  return tasks;
}

/** One line for where a task stands, the same everywhere it is shown. */
export function stateLine(t: Task): string {
  if (t.status === 'working') {
    if (t.live?.stopping) return 'stopping after this step';
    const s = t.live?.stage;
    if (s) return `${`Step ${s.n}`}: ${s.label}${s.detail ? ` · ${s.detail}` : ''}`;
    if (t.offer?.answered === 'background') return 'working in the background';
    return 'starting';
  }
  if (t.status === 'needs-you') {
    const n = t.cards.filter((c) => c.state === 'pending').length;
    return n ? `${n} decision${n > 1 ? 's' : ''} waiting` : 'choose how to run it';
  }
  if (t.status === 'scheduled') { const j = t.jobs[0]; return j ? `${j.paused ? 'paused · ' : ''}${j.when}` : 'scheduled'; }
  if (t.status === 'stopped') return 'stopped by you';
  if (t.status === 'failed') { const why = t.results.length ? t.results[t.results.length - 1].reason : t.reason; return t.error ? 'could not finish' : `could not finish${why && why !== 'offer' ? ` (${REASONS[why] ?? why})` : ''}`; }
  return t.results.length ? 'result ready' : 'answered';
}

const REASONS: Record<string, string> = { budget: 'ran out of its budget', stuck: 'got stuck', 'max steps': 'too many steps', wall: 'took too long', error: 'an error' };

export function clock(ms: number): string {
  const t = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (Math.abs(ms - Date.now()) < 12 * 3_600_000) return t;
  return `${new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${t}`;
}
export function whenShort(ms: number): string {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(ms);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${clock(ms)}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
export function secs(ms: number): string { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; }
export function minsLeft(at: number): string { const m = Math.round((at - Date.now()) / 60000); return m <= 0 ? 'now' : m < 60 ? `in ${m} min` : m < 36 * 60 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} days`; }
