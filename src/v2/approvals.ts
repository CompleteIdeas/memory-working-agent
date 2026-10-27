/**
 * Approvals in the v2 app (v2 build, slice S4): an action the helper staged for the person's OK, said plainly.
 *
 * The store is src/tools/approval.ts (the one place an action waits for a person, BL-03); deciding is
 * src/approval-decisions.ts, shared with the classic app's /api/approvals/confirm and /cancel. This module only READS:
 * it turns a stored action into what the approval screen shows —
 *
 *   title, rows      what will happen, to what, where (the classic card's plain words, F19, computed here so a phone
 *                    app gets them too)
 *   ifApprove/…      what each answer does
 *   exact            the action exactly as it will run (the command, the rule, the server line)
 *   content          for a file it will write: the text it will write (the first 4,000 characters)
 *   why              why it asks: the job that staged it (its title), and the reason the gate gave
 *   reviewer         what MWA's reviewer (BL-72, shadow or on) would have done, from its log, or the fixed rule that
 *                    always asks
 *   risks            money, sending as you, deleting, the network, MWA's own controls, a path outside the folders you
 *                    granted, outside content — and, strongest, a source flagged as phishing
 *   confirm          true when a risk is high: the app asks "Are you sure?" before it approves
 *
 * Every v1 caller acts for the owner. An action staged in someone else's conversation (a Telegram contact) is listed
 * too, as the classic app lists it — the owner decides for their helper — and says so (`forOwner: false`).
 */
import { approvalDetail, listPendingActions, recentApprovalOutcomes, type ApprovalDetail } from '../tools/approval.js';
import { reviewFor, fixedRule, commandOf, commandRule } from '../approval-review.js';
import { phishingSource, itemId } from './important.js';
import { appDb } from './db.js';
import { getJob, ownerOwns } from './jobs.js';

export type ApprovalState = 'pending' | 'approved' | 'executing' | 'done' | 'failed' | 'declined' | 'expired';
export type RiskKind = 'phishing' | 'outside' | 'money' | 'send' | 'delete' | 'network' | 'self' | 'outside-folders' | 'runs-as-you'
  | 'overwrite' | 'granted-folder' | 'standing' | 'new-server' | 'skips-runs' | 'someone-else';
export interface Risk { kind: RiskKind; level: 'high' | 'warn' | 'info'; text: string }
export interface ApprovalView {
  id: string; tool: string; kind: 'tool' | 'captured-policy'; state: ApprovalState;
  title: string; rows: { label: string; value: string }[]; ifApprove: string; ifDecline: string;
  exact: string | null; content: string | null;
  why: string | null; job: { id: string; title: string } | null;
  createdAt: number; expiresAt: number; expiresInSec: number; decidedAt: number | null;
  risks: Risk[]; confirm: boolean; caution: 'phishing' | null; trust: 'trusted' | 'untrusted';
  reviewer: { decision: 'auto' | 'ask'; by: string; reason: string } | null;
  forOwner: boolean; ranIn: string | null; result: string | null;
}

const shortName = (p: string) => { const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/'); return parts[parts.length - 1] || p; };
const folderName = (p: string) => { const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/'); return parts.length > 1 ? parts[parts.length - 2] : ''; };
const shortenPaths = (t: string) => t.replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s"'()]+[\\/])+([^\\/\s"'()]+)/g, '$1');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A shell command as a person would say it (the classic card's words, web/src/tasks.ts commandInWords). */
export function commandInWords(cmd: string): { title: string; where?: string; deletes: boolean } {
  const quoted = [...[...cmd.matchAll(/'([^']+)'/g)].map((m) => m[1]), ...[...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1])].filter((x) => /[\\/]|\.\w{1,5}$/.test(x) && !/^-/.test(x) && !/\s-\w/.test(x));
  const bare = [...cmd.matchAll(/(?:^|\s)((?:[A-Za-z]:)?[^\s'"]*[\\/][^\s'"]+|[^\s'"]+\.\w{1,5})(?=\s|$)/g)].map((m) => m[1]);
  const paths = quoted.length ? quoted : bare;
  const files = paths.map(shortName);
  const where = paths[0] ? (/\.\w{1,5}$/.test(paths[0]) ? folderName(paths[0]) : shortName(paths[0])) : undefined;
  const heads = [cmd.trim(), ...cmd.split(/-Command\s+["']|&&|;|\|/i).slice(1)].map((x) => x.trim().split(/\s+/)[0]?.replace(/^["'&]+/, '').toLowerCase() ?? '');
  const has = (re: RegExp) => heads.some((h) => re.test(h));
  const deletes = has(/^(remove-item|del|erase|rm|rmdir|rd|shred|unlink)$/i) || /\bgit\s+(clean|reset\s+--hard|push\s+.*--force)\b/i.test(cmd);
  let title: string;
  if (has(/^(copy-item|copy|cp|xcopy|robocopy)$/i) && files.length >= 2) title = `Copy ${files[0]} to ${files[1]}`;
  else if (has(/^(rename-item|ren|rename)$/i) && files.length >= 1) title = `Rename ${files[0]}${files[1] ? ` to ${files[1]}` : ''}`;
  else if (has(/^(move-item|move|mv)$/i) && files.length >= 2) title = `Move ${files[0]} to ${files[1]}`;
  else if (has(/^(remove-item|del|erase|rm|rmdir|rd)$/i)) title = `Delete ${files[0] ?? 'files'}`;
  else if (has(/^(get-childitem|dir|ls|tree)$/i)) title = `List the files in ${files[0] ?? 'a folder'}`;
  else if (has(/^(get-content|type|cat|more)$/i)) title = `Read ${files[0] ?? 'a file'}`;
  else if (has(/^(set-content|out-file|add-content)$/i)) title = `Write ${files[0] ?? 'a file'}`;
  else if (has(/^(new-item|mkdir|md)$/i)) title = `Create ${files[0] ?? 'a folder'}`;
  else if (has(/^git$/i)) title = `Run git ${cmd.trim().split(/\s+/).slice(1, 3).join(' ')}`;
  else if (has(/^(python|python3|py|node|powershell|pwsh)$/i)) title = `Run a small script${files.length ? ` on ${files.slice(0, 2).join(', ')}` : ''}`;
  else title = `Run a command${files.length ? ` on ${files.slice(0, 2).join(', ')}` : ''}`;
  return { title, where, deletes };
}

const MONEY = /(?:[$€£]\s?\d)|\b(?:buy|purchase|pay(?:ment)?|order|checkout|subscribe|invoice|donat(?:e|ion)|transfer|refund)\b/i;
const SENDS_TOOL = /(^|_)(send|post|publish|reply|forward|tweet|message|share)(_|$)/i;
const NETWORK = /⚠ It reaches the network\.|\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|scp|ssh|ftp|nc|ncat|telnet)\b|https?:\/\//i;

/** What the person sees for one stored action. */
export function plainApproval(a: Pick<ApprovalDetail, 'tool' | 'kind' | 'summary' | 'args'>): { title: string; rows: { label: string; value: string }[]; ifApprove: string; ifDecline: string; exact: string | null; content: string | null; command: string | null; deletes: boolean } {
  const s = a.summary;
  const quoted = [...s.matchAll(/"([^"]{3,})"/g)].map((m) => m[1]);
  const base = { content: null as string | null, command: null as string | null, deletes: false };
  if (a.kind === 'captured-policy' || a.tool === 'policy_save') {
    const rule = String(a.args.rule ?? '') || quoted.pop() || s;
    return { ...base, title: 'Save a standing preference', rows: [{ label: 'Preference', value: rule }, { label: 'Applies to', value: 'every future task, in every conversation' }],
      ifApprove: 'It is kept under your standing preferences, where you can remove it.', ifDecline: 'Nothing is saved; it applies to this conversation only.', exact: null };
  }
  if (a.tool === 'policy_forget') {
    return { ...base, title: 'Remove a standing preference', rows: [{ label: 'Preference', value: String(a.args.rule ?? '') || quoted.pop() || s }],
      ifApprove: 'It no longer applies to new tasks.', ifDecline: 'It stays as it is.', exact: null };
  }
  if (a.tool === 'write_file') {
    const m = /(Overwrite|Create) the file (.+?) \((\d+) bytes\)/.exec(s);
    const path = m?.[2] ?? String(a.args.path ?? '');
    const name = shortName(path) || 'a file';
    const content = typeof a.args.content === 'string' ? clip(a.args.content, 4000) : null;
    return { ...base, title: `${m?.[1] === 'Overwrite' ? 'Replace' : 'Create'} ${name}`, content,
      rows: [{ label: 'File', value: name }, { label: 'Where', value: `${folderName(path) || 'a folder'} (a folder you granted)` }, ...(m?.[3] ? [{ label: 'Size', value: `${Number(m[3]).toLocaleString('en-US')} bytes` }] : [])],
      ifApprove: `${name} is written there${m?.[1] === 'Overwrite' ? ', replacing what it holds now' : ''}.`, ifDecline: 'Nothing is written.', exact: s };
  }
  if (a.tool === 'run_command') {
    const cmd = String(a.args.command ?? '') || commandOf(s);
    const w = commandInWords(cmd);
    const reads = /^(List|Read) /.test(w.title);
    const changes = /^(Copy|Move|Rename|Delete|Write|Create) /.test(w.title);
    return { ...base, command: cmd, deletes: w.deletes, title: w.title,
      rows: [{ label: 'Where', value: w.where ?? 'its own working folder' },
        { label: 'What it is', value: reads ? 'A command that only looks; it asks because commands are not on the safe list.' : changes ? 'A command that changes files.' : 'A script or command: it can read or change files, so check the exact action.' }],
      ifApprove: 'It runs once, now, as you.', ifDecline: 'It does not run; nothing changes.', exact: s };
  }
  if (a.tool === 'add_mcp_server') {
    const name = String(a.args.name ?? '') || quoted[0] || 'a server';
    const line = [String(a.args.command ?? ''), ...(Array.isArray(a.args.args) ? (a.args.args as unknown[]).map(String) : [])].join(' ').trim();
    return { ...base, title: `Add the plug-in server ${name}`, rows: [{ label: 'Runs', value: line || 'a program on this computer' }, { label: 'When', value: 'with every message from now on' }],
      ifApprove: 'It is added, and its tools are there from your next message.', ifDecline: 'Nothing is added.', exact: s };
  }
  if (a.tool === 'knowledge_write') {
    return { ...base, title: `Save a note: ${String(a.args.slug ?? '') || 'a knowledge note'}`, rows: [{ label: 'Applies to', value: 'future tasks may load it' }],
      content: typeof a.args.content === 'string' ? clip(a.args.content, 4000) : null,
      ifApprove: 'The note is saved where future tasks can read it.', ifDecline: 'Nothing is saved.', exact: s };
  }
  if (/detector/.test(a.tool)) {
    return { ...base, title: 'Let a scheduled job skip runs when nothing changed', rows: [], ifApprove: 'The job skips a run whenever its check prints the same as last time.', ifDecline: 'The job keeps running every time.', exact: s };
  }
  const first = shortenPaths(s.split('\n')[0]).slice(0, 140);
  return { ...base, title: first || a.tool.replace(/_/g, ' '), rows: [], ifApprove: 'It is done as described.', ifDecline: SENDS_TOOL.test(a.tool) ? 'Nothing is sent.' : 'Nothing changes.', exact: s.length > first.length ? s : null };
}

/** The approval's Important item says phishing (the triage flagged what tainted it). */
function itemPhishing(id: string): boolean {
  try { return (appDb().prepare('SELECT caution FROM items WHERE id = ?').get(itemId(`approval:${id}`)) as { caution: string | null } | undefined)?.caution === 'phishing'; }
  catch { return false; }
}

/** The job whose run staged it, when there is one (the owner's only). */
function jobOf(a: ApprovalDetail): { id: string; title: string } | null {
  try {
    const d = appDb();
    const r = (a.runId ? d.prepare('SELECT job_id FROM tries WHERE run_id = ? LIMIT 1').get(a.runId) : undefined) as { job_id: string } | undefined
      ?? d.prepare(`SELECT job_id FROM tries WHERE staged LIKE ? LIMIT 1`).get(`%${JSON.stringify(a.id)}%`) as { job_id: string } | undefined;
    const j = r ? getJob(r.job_id) : undefined;
    return j && ownerOwns(j.person) ? { id: j.id, title: j.title } : null;
  } catch { return null; }
}

/** The risks of an action, strongest first. */
export function risksOf(a: ApprovalDetail, plain: ReturnType<typeof plainApproval>, phishing: boolean): Risk[] {
  const out: Risk[] = [];
  const s = a.summary;
  if (phishing) out.push({ kind: 'phishing', level: 'high', text: 'This came from an email that looks like phishing. Someone may be trying to trick your helper into doing this. Don’t approve it unless you asked for exactly this yourself.' });
  if (a.tainted && !a.readLocal) out.push({ kind: 'outside', level: 'high', text: 'Your helper proposed this after reading outside content (a web page or an email). Someone else’s words may be steering it — check it is what you want.' });
  if (/targets this machine|\/api\/approvals/i.test(s)) out.push({ kind: 'self', level: 'high', text: 'It targets this computer, possibly your helper’s own controls (including approvals). Don’t approve it unless you wrote it.' });
  if (MONEY.test(s) || MONEY.test(JSON.stringify(a.args ?? {}))) out.push({ kind: 'money', level: 'high', text: 'It may spend or move money.' });
  if (SENDS_TOOL.test(a.tool)) out.push({ kind: 'send', level: 'high', text: 'It sends something as you.' });
  if (plain.deletes) out.push({ kind: 'delete', level: 'high', text: 'It deletes something. That may not be undoable.' });
  if (plain.command && NETWORK.test(plain.command)) out.push({ kind: 'network', level: 'high', text: 'It reaches the internet: it can send what it finds somewhere else.' });
  if (plain.command) {
    const why = commandRule(plain.command, a.sandboxDir);
    if (why === 'it names a path outside its own folder' || why === 'it reaches the home folder') out.push({ kind: 'outside-folders', level: 'high', text: 'It names a place outside its own folder — possibly outside the folders you granted.' });
    out.push({ kind: 'runs-as-you', level: 'warn', text: 'It runs as you, with your files and network. If it runs tests or a build, it runs the code in that folder, including any your helper wrote.' });
  }
  if (a.tool === 'add_mcp_server') out.push({ kind: 'new-server', level: 'high', text: 'It adds a program that runs on this computer with every message: third-party code.' });
  if (a.tool === 'write_file') {
    if (/^Overwrite /.test(s)) out.push({ kind: 'overwrite', level: 'warn', text: 'The file’s current contents are replaced.' });
    out.push({ kind: 'granted-folder', level: 'info', text: 'It writes in a folder you granted, outside the job’s own folder.' });
  }
  if (a.kind === 'captured-policy' || a.tool === 'policy_save' || a.tool === 'knowledge_write') out.push({ kind: 'standing', level: 'warn', text: 'It applies to every future task until you remove it.' });
  if (/detector/.test(a.tool)) out.push({ kind: 'skips-runs', level: 'warn', text: 'If the check does not really follow the job, the job stops running without you seeing it.' });
  if (!ownerOwns(a.personId)) out.push({ kind: 'someone-else', level: 'warn', text: 'It was asked for in someone else’s conversation with your helper.' });
  const rank = { high: 0, warn: 1, info: 2 } as const;
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}

const STATE: Record<string, ApprovalState> = { pending: 'pending', approved: 'approved', executing: 'executing', done: 'done', failed: 'failed', cancelled: 'declined', expired: 'expired' };

/** One action as the app shows it, or null when there is no such action (or it was run by the reviewer itself). */
export function approvalView(id: string, now = Date.now()): ApprovalView | null {
  const a = approvalDetail(id);
  if (!a) return null;
  const plain = plainApproval(a);
  const phishing = itemPhishing(a.id) || phishingSource(a.taintSources);
  const risks = risksOf(a, plain, phishing);
  // approved, but the tool's own guard refused when it ran: nothing happened, so not "done" (review of S4)
  const refusedRun = a.status === 'done' && !!a.result && /^\s*\((refused|blocked)\b/.test(a.result);
  const state: ApprovalState = refusedRun ? 'failed' : STATE[a.status] ?? 'expired';
  const logged = reviewFor(a.id);
  const rule = logged ? null : fixedRule({ tool: a.tool, summary: a.summary, kind: a.kind, command: plain.command ?? undefined, tainted: a.tainted, sandboxDir: a.sandboxDir });
  const because = /\(Needs approval because ([^)]+)\.\)/.exec(a.summary)?.[1];
  const job = jobOf(a);
  return {
    id: a.id, tool: a.tool, kind: a.kind ?? 'tool', state,
    title: plain.title, rows: plain.rows, ifApprove: plain.ifApprove, ifDecline: plain.ifDecline, exact: plain.exact, content: plain.content,
    why: because ? `It asks because ${because}.` : a.tool === 'write_file' ? 'It asks because the file is outside the job’s own folder.' : rule ? `It asks because ${rule.reason}.` : null,
    job, createdAt: a.createdAt, expiresAt: a.expiresAt, expiresInSec: Math.max(0, Math.round((a.expiresAt - now) / 1000)),
    decidedAt: state === 'pending' ? null : a.updatedAt,
    risks, confirm: risks.some((r) => r.level === 'high'), caution: phishing ? 'phishing' : null, trust: a.tainted ? 'untrusted' : 'trusted',
    reviewer: logged ? { decision: logged.decision, by: logged.by, reason: logged.reason } : rule ? { decision: 'ask', by: rule.rule, reason: rule.reason } : null,
    forOwner: ownerOwns(a.personId), ranIn: a.owner && state === 'approved' ? a.ownerLabel : null,
    result: state === 'pending' ? null : a.result ? clip(shortenPaths(a.result), 600) : null,
  };
}

/** What a caller without the `approve` scope sees (review of S4): what the classic card showed — the summary, and at
 *  most 300 characters of the file's text, the exact action and what it printed. */
export function forViewer(v: ApprovalView, canApprove: boolean): ApprovalView {
  if (canApprove) return v;
  const cut = (s: string | null) => (s && s.length > 300 ? `${s.slice(0, 299)}…` : s);
  return { ...v, exact: cut(v.exact), content: cut(v.content), result: cut(v.result) };
}

/** The actions waiting (the one waiting longest first) and those decided in the last day (newest first, at most 20). */
export function approvalsList(now = Date.now()): { pending: ApprovalView[]; recent: ApprovalView[] } {
  const pending = listPendingActions().sort((x, y) => x.createdAt - y.createdAt).map((p) => approvalView(p.id, now)).filter((v): v is ApprovalView => !!v);
  const recent = recentApprovalOutcomes().slice(0, 20).map((r) => approvalView(r.id, now)).filter((v): v is ApprovalView => !!v && v.state !== 'pending');
  return { pending, recent };
}
