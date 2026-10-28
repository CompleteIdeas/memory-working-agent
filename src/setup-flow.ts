/**
 * Getting the helper going (v2 build, slice S6): whether it has a working AI brain, readying the local memory models,
 * warming memory up from a folder, "Get to know me" (learning from the inbox), the setup cards the agent opens when it
 * needs a password or a key mid-task, and where memory is kept (this computer or a Postgres server). ONE
 * implementation that both the classic routes (serve.ts /api/setup/warm, /api/onboard/scan|save, /api/ingest,
 * /api/setup/submit, /api/save which: 'backend') and the v1 routes (src/api/routes/setup.ts) call, so the two can never
 * drift apart.
 *
 * What changed from the code that sat in serve.ts (both paths get it):
 *   - a folder to read must pass Your assistant's folder rules (assistant-settings.ts folderProblem: an existing
 *     absolute folder, not a drive root, a network share, or anything holding the helper's .env, config or data). It
 *     is read once for the scan and is NOT granted to the assistant any more (the classic scan used to add every
 *     folder it was pointed at to the granted folders, silently);
 *   - what is saved from a folder's files is outside content: it is kept as a note from that file (trust=untrusted,
 *     origin file/<name>), never as something the owner said; only words the owner typed (the classic wizard's
 *     interview answers) are kept as theirs;
 *   - one inbox scan at a time, whichever app started it, and it can be stopped between rounds; what it learned is
 *     listed by name; every fact it writes stays untrusted (src/ingest.ts stamps provenance 'ingested');
 *   - a setup card's answer never comes back: the values typed are taken out of any message a check returns;
 *   - choosing where memory is kept writes the .env only: this process keeps the store it started with until the
 *     restart (the classic page told you "after the next restart" but switched this process's later stores at once).
 *     A Postgres address is checked by connecting, and never comes back: not in the view, not in a message.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.js';
import { status as wizardStatus, upsertEnv, removeEnv as wizardRemoveEnv, envKeyForProvider } from './wizard.js';
import { folderProblem, parseSpec, scrub } from './assistant-settings.js';
import { scanSources, type Candidate } from './onboard.js';
import { MwaMemory } from './awm.js';
import { dbFile } from './paths.js';
import { runIngest, ingestAvailable, type IngestResult } from './ingest.js';
import { loadEmbeddings, loadPostgresStore, awmCliPath } from './awm-api.js';
import { listSetupRequests, getSetupRequest, submitSetupRequest, cancelSetupRequest, type SetupRequest } from './connect/setup.js';
import { fromHostEnvironment } from './env.js';
import { isHosted, hostName } from './hosting.js';
import { whereOf } from './activity.js';
import { DEFAULT_STEP, aboutUsd, aboutTime } from './v2/estimate.js';

const execFileP = promisify(execFile);
export type Outcome<T = unknown> = ({ ok: true; message: string } & T) | { ok: false; code: string; message: string };
const fail = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });
const memoryAgent = () => process.env.MWA_AGENT_ID ?? 'mwa-serve';
const LINE = /^[^\r\n\0]*$/;

export interface IngestRunOpts { days: number; dbPath: string; signal: AbortSignal; onLog: (m: string) => void; onFact: (name: string) => void }
export interface SetupFlowDeps {
  /** learn from the inbox (src/ingest.ts runIngest) */
  ingest: (o: IngestRunOpts) => Promise<IngestResult>;
  ingestAvailable: () => boolean;
  /** download and load the local recall models once */
  warm: () => Promise<void>;
  /** connect to a Postgres server and provision AWM's schema there; throws when it can't */
  checkPostgres: (url: string) => Promise<void>;
  /** copy this computer's memory into the Postgres server */
  migrate: (url: string) => Promise<{ ok: boolean; message: string }>;
  /** the .env only: never this process (the store it runs on changes at the restart) */
  saveEnvFile: (kv: Record<string, string>) => void;
  removeEnvFile: (names: string[]) => void;
  /** what the .env says now (what the next start reads) */
  envFile: () => Record<string, string>;
  /** set by the deployment (a Railway variable, docker -e): a choice here can't win over it */
  fromHost: (name: string) => boolean;
  /** serve.ts: too many runs at once (the classic MAX_CONCURRENT), and the run count while a scan runs */
  busy: () => boolean;
  begin: () => void;
  end: () => void;
  now: () => number;
}

function envPath(): string { return process.env.MWA_ENV_PATH ?? resolve('.env'); }
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(envPath(), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch { /* no .env */ }
  return out;
}
/** wizard.ts writes the .env and this process; keep this process as it was */
function keepProcess(names: string[], fn: () => void): void {
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try { fn(); } finally {
    for (const [n, v] of Object.entries(before)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  }
}

/** Copy the current SQLite memory into a Postgres target before switching, with AWM's export/import CLI (embeddings
 *  included). ok:false on any error, and the caller then does NOT switch, so a failed copy never strands you. */
async function migrateMemoryToPostgres(sqliteDbPath: string, url: string): Promise<{ ok: boolean; message: string }> {
  let cli: string;
  try { cli = awmCliPath(); } catch { return { ok: false, message: 'the migration tool is not available in this build' }; }
  if (!existsSync(sqliteDbPath)) return { ok: true, message: 'no existing memory to copy' };
  const tmp = join(tmpdir(), `mwa-migrate-${randomBytes(6).toString('hex')}.json`);
  const exportEnv = { ...process.env };
  delete exportEnv.AWM_STORE_BACKEND; delete exportEnv.AWM_DB_PATH; delete exportEnv.AWM_DATABASE_URL;
  try {
    await execFileP(process.execPath, [cli, 'export', '--db', sqliteDbPath, '--agent', memoryAgent(), '--all-stages', '--output', tmp], { env: exportEnv, timeout: 120_000 });
    const { stdout } = await execFileP(process.execPath, [cli, 'import', tmp, '--remap-agent', memoryAgent(), '--dedupe'],
      { env: { ...process.env, AWM_STORE_BACKEND: 'postgres', AWM_DATABASE_URL: url }, timeout: 180_000 });
    return { ok: true, message: (stdout || '').trim().split('\n').pop()?.slice(0, 160) || 'memory copied' };
  } catch (e) {
    return { ok: false, message: `couldn't copy memory: ${(e as Error).message.slice(0, 200)}` };
  } finally { try { rmSync(tmp); } catch { /* */ } }
}

const realDeps: SetupFlowDeps = {
  ingest: (o) => runIngest({ days: o.days, dbPath: o.dbPath, signal: o.signal, onLog: o.onLog, onFact: o.onFact }),
  ingestAvailable: () => ingestAvailable(),
  warm: async () => { const emb = await loadEmbeddings(); await emb.embed('warm up'); },
  checkPostgres: async (url) => { const S = await loadPostgresStore(); const s: any = new S(url); await s.ready(); await s.close(); },
  migrate: (url) => migrateMemoryToPostgres(dbFile(), url),
  saveEnvFile: (kv) => keepProcess(Object.keys(kv), () => upsertEnv(kv)),
  removeEnvFile: (names) => keepProcess(names, () => wizardRemoveEnv(names)),
  envFile: readEnvFile,
  fromHost: (n) => fromHostEnvironment(n),
  busy: () => false, begin: () => {}, end: () => {},
  now: () => Date.now(),
};
let deps: SetupFlowDeps = realDeps;
export function setSetupFlowDeps(d: Partial<SetupFlowDeps> | null): void { deps = d ? { ...realDeps, ...d } : realDeps; }

// ── the brain ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether the helper can think at all: the brain chosen in mwa.config.json has what it needs (a key, or Ollama). */
export function brainState(): { ready: boolean; provider: string; model: string; missing: string | null } {
  let spec = '';
  try { spec = loadConfig().models.fetch || ''; } catch { /* no config yet */ }
  const { provider, model } = parseSpec(spec);
  let ready = false;
  try { ready = wizardStatus().ready; } catch { ready = false; }
  if (ready) return { ready, provider, model, missing: null };
  const missing = !model ? 'No AI brain is set up yet, so I can’t answer, sort your mail or do jobs. Pick one in Settings › Your assistant.'
    : envKeyForProvider(provider) ? `The AI brain (${provider || 'its provider'}) has no key saved, so I can’t answer, sort your mail or do jobs. Add the key in Settings › Your assistant.`
      : 'The AI brain isn’t working, so I can’t answer, sort your mail or do jobs. Check it in Settings › Your assistant.';
  return { ready, provider, model, missing };
}

/** Get the local memory models ready (the first use downloads them, about 500 MB); quick when they are cached. */
let warming: Promise<{ ready: boolean; message: string }> | null = null;
export function warmMemory(): Promise<{ ready: boolean; message: string }> {
  if (warming) return warming;
  warming = (async () => {
    try { await deps.warm(); return { ready: true, message: 'Your memory is ready.' }; }
    catch (e) { return { ready: false, message: `I couldn’t get the memory models ready: ${(e as Error).message.slice(0, 160)}` }; }
    finally { setTimeout(() => { warming = null; }, 0); }
  })();
  return warming;
}

// ── warm up memory from a folder ────────────────────────────────────────────────────────────────────────────────

/** What a folder scan costs and takes, in words. No AI is used: the files are read and cut into notes here. */
export const FOLDER_NOTE = 'Reading a folder uses no AI, so it costs nothing. I read up to 60 documents (text, Markdown, PDF, Word, CSV, HTML), which takes a few seconds, and nothing is saved until you choose.';
const SCAN_TTL_MS = 30 * 60_000;
export interface FolderScan { id: string; folder: string; at: number; candidates: (Candidate & { id: string })[]; filesScanned: number; truncated: boolean }
const scans = new Map<string, FolderScan>();
function sweepScans(now = deps.now()): void { for (const [k, s] of scans) if (now - s.at > SCAN_TTL_MS) scans.delete(k); }

/** Read one folder (it must pass the folder rules) into candidate notes. Nothing is saved, nothing is granted. */
export async function scanFolder(path: unknown): Promise<Outcome<{ scan: FolderScan }>> {
  if (typeof path !== 'string') return fail('bad_folder', 'Type the folder’s full path.');
  const p = path.trim();
  const problem = folderProblem(p);
  if (problem) return fail(problem.code, problem.message);
  const folder = resolve(p);
  let r: { candidates: Candidate[]; filesScanned: number; truncated: boolean };
  try { r = await scanSources(folder, [folder], [folder]); } catch { return fail('unreadable', 'I couldn’t read that folder.'); }
  sweepScans();
  const id = `scan_${randomBytes(6).toString('hex')}`;
  const scan: FolderScan = { id, folder, at: deps.now(), filesScanned: r.filesScanned, truncated: r.truncated, candidates: r.candidates.map((c, i) => ({ ...c, id: `c${i + 1}` })) };
  scans.set(id, scan);
  const message = !r.filesScanned ? 'I didn’t find any documents I can read in that folder.'
    : `Read ${r.filesScanned} file${r.filesScanned === 1 ? '' : 's'}: ${scan.candidates.length} note${scan.candidates.length === 1 ? '' : 's'} to look over.${r.truncated ? ' There was more; I stopped at 150.' : ''}`;
  return { ok: true, message, scan };
}

const flat = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
async function writeFacts(rows: { name: string; text: string; outside: string | null }[]): Promise<number> {
  let saved = 0;
  const m = new MwaMemory(memoryAgent(), dbFile());
  try {
    for (const r of rows) {
      const name = r.name.trim().slice(0, 120), text = r.text.trim().slice(0, 4000);
      if (!name || text.length < 4) continue;
      // outside content (a file) stays a note from that file: untrusted, its origin recorded. Only the owner's own words
      // are kept as theirs.
      const id = r.outside
        ? await m.write(name, text, ['src=onboarding', 'intent=context', 'source=folder'], { provenance: 'ingested', canonical: true, origin: `file/${basename(r.outside).slice(0, 120)}` })
        : await m.write(name, text, ['src=onboarding', 'intent=context'], { provenance: 'user', ownName: true, canonical: true, origin: 'onboarding' });
      if (id) saved++;
    }
  } finally { try { m.close(); } catch { /* */ } }
  return saved;
}

/** v1: save the notes the owner kept from one scan (edits allowed). They stay notes from their files (untrusted). */
export async function saveFolderNotes(scanId: unknown, keep: unknown): Promise<Outcome<{ saved: number }>> {
  sweepScans();
  const scan = typeof scanId === 'string' ? scans.get(scanId) : undefined;
  if (!scan) return fail('scan_expired', 'That reading of the folder has expired. Read the folder again.');
  if (!Array.isArray(keep) || !keep.length || keep.length > 150) return fail('bad_notes', 'Pick at least one note to keep.');
  const rows: { name: string; text: string; outside: string }[] = [];
  for (const k of keep as unknown[]) {
    const o = (k && typeof k === 'object' ? k : {}) as Record<string, unknown>;
    const c = scan.candidates.find((x) => x.id === o.id);
    if (!c) return fail('bad_notes', 'One of those notes isn’t from this reading. Read the folder again.');
    const name = typeof o.name === 'string' && o.name.trim() ? o.name : c.concept;
    const text = typeof o.text === 'string' && o.text.trim() ? o.text : c.content;
    if (!LINE.test(name) || name.length > 120 || text.length > 4000) return fail('bad_notes', 'A note’s name is one line (120 characters at most) and its text 4,000 characters at most.');
    rows.push({ name, text, outside: c.source });
  }
  let saved = 0;
  try { saved = await writeFacts(rows); } catch (e) { return fail('unavailable', `I couldn’t save them: ${(e as Error).message.slice(0, 120)}`); }
  scans.delete(scan.id);
  return { ok: true, saved, message: `Saved ${saved} note${saved === 1 ? '' : 's'} from your files. I use them as background, never as instructions.` };
}

/** Classic /api/onboard/scan: several paths (folders, or files in them); each must pass the folder rules. */
export async function legacyScan(paths: unknown): Promise<{ candidates: Candidate[]; filesScanned: number; truncated: boolean; refused: { path: string; message: string }[] }> {
  const list: string[] = Array.isArray(paths) ? paths.map(String).filter(Boolean).slice(0, 20) : [];
  const roots: string[] = [], refused: { path: string; message: string }[] = [];
  for (const p of list) {
    const abs = resolve(p);
    let dir = abs;
    try { if (!statSync(abs).isDirectory()) dir = dirname(abs); } catch { /* folderProblem says it isn't there */ }
    const problem = folderProblem(dir);
    if (problem) refused.push({ path: p, message: problem.message }); else roots.push(dir);
  }
  if (!roots.length) return { candidates: [], filesScanned: 0, truncated: false, refused };
  const r = await scanSources(roots[0], list.filter((p) => !refused.some((x) => x.path === p)).map((p) => resolve(p)), roots);
  sweepScans();
  const id = `scan_${randomBytes(6).toString('hex')}`;
  scans.set(id, { id, folder: roots[0], at: deps.now(), filesScanned: r.filesScanned, truncated: r.truncated, candidates: r.candidates.map((c, i) => ({ ...c, id: `c${i + 1}` })) });
  return { ...r, refused };
}

/** Classic /api/onboard/save: the wizard's interview answers (the owner's words) and notes from a scan (outside: any
 *  note whose text came from a scanned file stays a note from that file). */
export async function legacySaveNotes(items: unknown): Promise<number> {
  sweepScans();
  const all = [...scans.values()].flatMap((s) => s.candidates);
  const list = Array.isArray(items) ? items.slice(0, 200) as { concept?: unknown; content?: unknown }[] : [];
  const rows = list.map((it) => {
    const name = String(it?.concept ?? ''), text = String(it?.content ?? '');
    const t = flat(text);
    const from = t.length >= 4 ? all.find((c) => { const ct = flat(c.content); return ct.includes(t) || t.includes(ct) || (t.length >= 40 && ct.includes(t.slice(0, 40))); }) : undefined;
    return { name, text, outside: from ? from.source : null };
  });
  return writeFacts(rows);
}

// ── get to know me (the inbox) ──────────────────────────────────────────────────────────────────────────────────

export const INBOX_MAX = 400;
const INBOX_ROUND = 12;
/** What a scan of `days` days may cost and take: at most 400 emails, read 12 at a time, at the default step. */
export function inboxEstimate(days = 30) {
  const rounds = Math.ceil(INBOX_MAX / INBOX_ROUND);
  const usd = Math.round(rounds * DEFAULT_STEP.usd * 100) / 100, ms = rounds * DEFAULT_STEP.ms;
  return { days, maxEmails: INBOX_MAX, rounds, usd, ms, text: `I read up to ${INBOX_MAX} emails from the last ${days} days, ${INBOX_ROUND} at a time, with your AI brain. That costs at most ${aboutUsd(usd)} and takes ${aboutTime(ms)}. You can stop it at any time.` };
}

export type InboxState = 'idle' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed';
export interface InboxScan {
  id: string | null; state: InboxState; days: number; startedAt: number | null; endedAt: number | null;
  log: string[]; learned: string[]; learnedCount: number; emails: number | null; message: string;
}
const idle = (): InboxScan => ({ id: null, state: 'idle', days: 30, startedAt: null, endedAt: null, log: [], learned: [], learnedCount: 0, emails: null, message: '' });
let scanNow: InboxScan = idle();
let abort: AbortController | null = null;
const listeners = new Set<(e: { type: 'log' | 'end'; scan: InboxScan; line?: string }) => void>();
let onScanChange: (s: InboxScan) => void = () => {};
/** serve.ts: an event on the v2 stream when a scan starts or ends */
export function setInboxScanListener(fn: ((s: InboxScan) => void) | null): void { onScanChange = fn ?? (() => {}); }
const KEEP_LOG = 60, KEEP_LEARNED = 60;

export function inboxScanView(): InboxScan & { available: boolean; estimate: ReturnType<typeof inboxEstimate> } {
  let available = false;
  try { available = deps.ingestAvailable(); } catch { available = false; }
  return { ...scanNow, log: [...scanNow.log], learned: [...scanNow.learned], available, estimate: inboxEstimate(scanNow.state === 'idle' ? 30 : scanNow.days) };
}
/** Follow a scan's lines and its end (the classic page's server-sent events). Returns the unsubscribe. */
export function followInboxScan(fn: (e: { type: 'log' | 'end'; scan: InboxScan; line?: string }) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
const emit = (type: 'log' | 'end', line?: string) => { for (const l of [...listeners]) { try { l({ type, scan: scanNow, line }); } catch { /* a gone page */ } } };

/** Start learning from the inbox (one scan at a time). Answers at once; the scan runs on. */
export function startInboxScan(o: { days?: unknown }): Outcome<{ scan: InboxScan }> {
  const days = o.days === undefined ? 30 : Number(o.days);
  if (!Number.isInteger(days) || days < 1 || days > 730) return fail('bad_days', 'Pick how many days back to read: 1 to 730.');
  if (scanNow.state === 'running' || scanNow.state === 'stopping') return fail('already_running', 'I’m already reading your email. Watch it here, or stop it.');
  let available = false;
  try { available = deps.ingestAvailable(); } catch { available = false; }
  if (!available) return fail('no_email', 'Connect Gmail or Outlook first, then I can learn from your email.');
  if (deps.busy()) return fail('busy', 'I’m busy right now — try again in a moment.');
  const ctrl = new AbortController();
  abort = ctrl;
  scanNow = { id: `inbox_${randomBytes(6).toString('hex')}`, state: 'running', days, startedAt: deps.now(), endedAt: null, log: [], learned: [], learnedCount: 0, emails: null, message: 'Reading your email…' };
  const mine = scanNow;
  const line = (m: string) => {
    if (scanNow !== mine) return;
    const clean = scrub(String(m)).replace(/\s+$/, '').slice(0, 200);
    mine.log.push(clean); if (mine.log.length > KEEP_LOG) mine.log.splice(0, mine.log.length - KEEP_LOG);
    emit('log', clean);
  };
  try { onScanChange(mine); } catch { /* best effort */ }
  deps.begin();
  void (async () => {
    try {
      const r = await deps.ingest({
        days, dbPath: dbFile(), signal: ctrl.signal, onLog: line,
        onFact: (name) => { mine.learnedCount++; if (mine.learned.length < KEEP_LEARNED) mine.learned.push(String(name).replace(/[\r\n]+/g, ' ').slice(0, 80)); },
      });
      mine.emails = r.unique;
      mine.learnedCount = Math.max(mine.learnedCount, r.learned);
      if (ctrl.signal.aborted) { mine.state = 'stopped'; mine.message = `Stopped. I had learned ${mine.learnedCount} thing${mine.learnedCount === 1 ? '' : 's'} by then; they are kept.`; }
      else { mine.state = 'done'; mine.message = `Done: ${r.unique} email${r.unique === 1 ? '' : 's'} read, ${mine.learnedCount} thing${mine.learnedCount === 1 ? '' : 's'} learned.`; }
    } catch (e) {
      if (ctrl.signal.aborted) { mine.state = 'stopped'; mine.message = `Stopped. I had learned ${mine.learnedCount} thing${mine.learnedCount === 1 ? '' : 's'} by then; they are kept.`; }
      else { mine.state = 'failed'; mine.message = `That didn’t finish: ${scrub((e as Error).message).slice(0, 200)}`; }
    } finally {
      mine.endedAt = deps.now();
      if (abort === ctrl) abort = null;
      deps.end();
      emit('end');
      try { onScanChange(mine); } catch { /* best effort */ }
    }
  })();
  return { ok: true, message: 'I’m reading your email now. This page shows how it goes.', scan: inboxScanView() };
}

/** Stop the scan between rounds (what it learned so far is kept). */
export function stopInboxScan(): Outcome<{ scan: InboxScan }> {
  if (scanNow.state !== 'running' || !abort) return fail('not_running', 'Nothing is being read right now.');
  scanNow.state = 'stopping'; scanNow.message = 'Stopping after this round…';
  abort.abort();
  return { ok: true, message: 'Stopping after this round. What I learned so far is kept.', scan: inboxScanView() };
}
/** Tests. */
export function _resetInboxScan(): void { abort?.abort(); abort = null; scanNow = idle(); listeners.clear(); }

// ── setup cards (a password or key the agent asked for mid-task) ───────────────────────────────────────────────

export interface SetupCardView {
  id: string; name: string; howTo: string; where: string;
  fields: { name: string; label: string; help: string | null; secret: boolean; optional: boolean }[];
  state: SetupRequest['status']; message: string; expiresInSec: number; vault: { site: string | null } | null;
}
/** The cards waiting, and those opened in the last 40 minutes (newest first). No value is ever in them. */
export function setupCardsView(now = deps.now()): SetupCardView[] {
  return listSetupRequests().filter((r) => r.status === 'waiting' || now - r.createdAt < 40 * 60_000).map((r) => ({
    id: r.id, name: r.name, howTo: r.howTo, where: whereOf({ session: r.session }).where,
    fields: r.fields.map((f) => ({ name: f.env, label: f.label, help: f.help ?? null, secret: f.secret, optional: !!f.optional })),
    state: r.status, message: r.message, expiresInSec: Math.max(0, Math.round((r.expiresAt - now) / 1000)),
    vault: r.vault ? { site: r.vault.site ?? null } : null,
  }));
}
/** Fill a card: only its own fields are taken; a check's message never carries what was typed. */
export async function submitCard(id: unknown, values: unknown): Promise<Outcome & { found: boolean }> {
  const r = typeof id === 'string' ? getSetupRequest(id) : undefined;
  if (!r) return { ...fail('not_found', 'That setup card is gone — ask me to connect it again.'), found: false };
  if (r.status !== 'waiting') return { ...fail('not_waiting', `That setup card is already ${r.status}.`), found: true };
  const v = (values && typeof values === 'object' && !Array.isArray(values) ? values : {}) as Record<string, unknown>;
  for (const f of r.fields) {
    const x = v[f.env];
    if (x !== undefined && (typeof x !== 'string' || x.length > 4096 || !LINE.test(x))) return { ...fail('bad_value', `${f.label} is one line of text.`), found: true };
  }
  const typed = r.fields.map((f) => String(v[f.env] ?? '').trim()).filter((x) => x.length >= 4);
  let out: { ok: boolean; message: string };
  try { out = await submitSetupRequest(r.id, Object.fromEntries(r.fields.map((f) => [f.env, v[f.env] ?? '']))); }
  catch (e) { out = { ok: false, message: `That didn’t work: ${(e as Error).message.slice(0, 120)}` }; }
  let message = out.message;
  for (const t of typed) { message = message.split(t).join('•••'); const compact = t.replace(/\s+/g, ''); if (compact.length >= 4) message = message.split(compact).join('•••'); }
  // the card itself keeps the message too (the classic page and the agent read it): the same cleaned words
  const now = getSetupRequest(r.id);
  if (now) now.message = message;
  return out.ok ? { ok: true, message, found: true } : { ...fail(now?.status === 'waiting' ? 'check_failed' : 'failed', message), found: true };
}
export function cancelCard(id: unknown): Outcome & { found: boolean } {
  const r = typeof id === 'string' ? getSetupRequest(id) : undefined;
  if (!r) return { ...fail('not_found', 'That setup card is gone.'), found: false };
  if (!cancelSetupRequest(r.id)) return { ...fail('not_waiting', `That setup card is already ${r.status}.`), found: true };
  return { ok: true, message: 'Closed. I’ll tell the conversation it wasn’t filled in.', found: true };
}

// ── where memory is kept ───────────────────────────────────────────────────────────────────────────────────────

type Kind = 'sqlite' | 'postgres' | 'pglite';
const kindOf = (v: string | undefined): Kind => { const b = (v ?? '').toLowerCase(); return b === 'postgres' ? 'postgres' : b === 'pglite' ? 'pglite' : 'sqlite'; };
/** The server's name only (never the user, password, port or database). */
function hostOf(url: string | undefined): string | null { try { return url ? new URL(url).hostname.slice(0, 120) || null : null; } catch { return null; } }

export function storageView(admin: boolean) {
  const file = deps.envFile();
  const running = kindOf(process.env.AWM_STORE_BACKEND);
  const fixed = deps.fromHost('AWM_STORE_BACKEND') || deps.fromHost('AWM_DATABASE_URL');
  const next = fixed ? running : kindOf(file.AWM_STORE_BACKEND);
  const runningUrl = process.env.AWM_DATABASE_URL, nextUrl = fixed ? runningUrl : file.AWM_DATABASE_URL;
  const restartNeeded = next !== running || (next === 'postgres' && (nextUrl ?? '') !== (runningUrl ?? ''));
  return {
    running, next, restartNeeded, fixed, hosted: isHosted(), host: hostName(),
    // the server's name only, and only for admin (a phone sees which kind)
    server: admin && running === 'postgres' ? hostOf(runningUrl) : null,
    nextServer: admin && next === 'postgres' ? hostOf(nextUrl) : null,
  };
}

/** Take a Postgres address (and its password, and user:pass@) out of a message. */
export function scrubUrl(message: string, url: string): string {
  let m = String(message ?? '');
  if (url) m = m.split(url).join('(your database address)');
  try {
    const u = new URL(url);
    for (const part of [u.password, decodeURIComponent(u.password || ''), u.username && u.password ? `${u.username}:${u.password}` : '']) if (part && part.length >= 3) m = m.split(part).join('•••');
  } catch { /* not a URL */ }
  return m.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '(a database address)').replace(/\/\/[^\s/@:'"]+:[^\s/@'"]+@/g, '//•••@');
}

export const RESTART = 'It takes effect when your helper restarts.';
export async function saveStorage(b: { kind?: unknown; url?: unknown; bringMemory?: unknown }): Promise<Outcome> {
  if (deps.fromHost('AWM_STORE_BACKEND') || deps.fromHost('AWM_DATABASE_URL')) return fail('fixed', 'The server’s AWM_STORE_BACKEND setting chooses where memory is kept, and it wins over a choice here. Change it there.');
  const kind = String(b.kind ?? '').toLowerCase();
  if (kind === 'sqlite') {
    deps.removeEnvFile(['AWM_STORE_BACKEND', 'AWM_DATABASE_URL']);
    return { ok: true, message: `${isHosted() ? `Memory will be kept in a file on this ${hostName()} deploy.` : 'Memory will be kept privately on this computer.'} ${RESTART} What is in a database server stays there.` };
  }
  if (kind !== 'postgres') return fail('bad_kind', 'Pick this computer or a database server.');
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  let parsed: URL | null = null;
  try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
  if (!url || url.length > 2000 || !LINE.test(url) || !/^postgres(ql)?:\/\//i.test(url) || !parsed?.hostname) return fail('bad_url', 'Enter a Postgres connection address, like postgres://user:password@host:5432/database.');
  try { await deps.checkPostgres(url); } catch (e) {
    return fail('check_failed', `I couldn’t connect to that database: ${scrubUrl((e as Error).message, url).slice(0, 200)}. Check the address and password, and that the pgvector extension is available.`);
  }
  const lead = `Connected. Your database server (${parsed.hostname}) becomes the memory store when your helper restarts.`;
  if (b.bringMemory === true) {
    let m: { ok: boolean; message: string };
    try { m = await deps.migrate(url); } catch (e) { m = { ok: false, message: (e as Error).message }; }
    if (!m.ok) return fail('copy_failed', `Connected, but ${scrubUrl(m.message, url).slice(0, 200)}. Staying on this computer, so nothing is lost.`);
    deps.saveEnvFile({ AWM_STORE_BACKEND: 'postgres', AWM_DATABASE_URL: url });
    return { ok: true, message: `${lead} Your memory was copied over (${scrubUrl(m.message, url).slice(0, 120)}).` };
  }
  deps.saveEnvFile({ AWM_STORE_BACKEND: 'postgres', AWM_DATABASE_URL: url });
  return { ok: true, message: `${lead} Your memory on this computer stays where it is; it isn’t copied.` };
}
