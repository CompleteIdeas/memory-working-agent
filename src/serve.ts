/**
 * `mwa serve` — the ONE command for humans. Starts a local web app you open in your
 * browser: guided setup if unconfigured, otherwise a chat surface where you watch the
 * agent recall, act, and learn (the "activity spine"). No terminal jargon, no flags.
 *
 * The same static bundle (web/ → dist-ui/) later becomes the PWA, the Tauri desktop
 * app, and the hosted version — this server is just a file-server + a small JSON/SSE API.
 *
 * Routes:
 *   GET  /                 → the SPA (dist-ui/) or a functional inline fallback
 *   GET  /api/status       → what's configured (providers, connections)
 *   POST /api/save         → save+validate a provider/Telegram key (local .env only)
 *   GET  /api/suggestions  → starter actions for the empty state
 *   GET  /api/chat?message=&session= → SSE: streams the agent's activity + final reply
 *
 * Secrets stay local (reuses the wizard's local-.env model). Bind 127.0.0.1 by default;
 * Docker/Tauri can set MWA_SERVE_HOST=0.0.0.0 and map the port host-localhost-only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, appendFileSync, mkdirSync, rmSync, createReadStream } from 'node:fs';
import { resolve, join, extname, normalize, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Copy the current SQLite memory into a Postgres target before switching backends, using AWM's
 *  backend-agnostic export/import CLI (embeddings included). Best-effort: returns ok:false (and the
 *  caller then does NOT switch) on error, so a failed copy never strands you on an empty store. */
async function migrateMemoryToPostgres(sqliteDbPath: string, url: string): Promise<{ ok: boolean; message: string }> {
  let cli: string;
  try { cli = awmCliPath(); }
  catch { return { ok: false, message: 'the migration tool is not available in this build' }; }
  if (!existsSync(sqliteDbPath)) return { ok: true, message: 'no existing memory to copy' };
  const tmp = join(tmpdir(), `mwa-migrate-${randomBytes(6).toString('hex')}.json`);
  // export the CURRENT store with a clean env so `--db` selects SQLite (not the postgres target).
  const exportEnv = { ...process.env };
  delete exportEnv.AWM_STORE_BACKEND; delete exportEnv.AWM_DB_PATH; delete exportEnv.AWM_DATABASE_URL;
  try {
    await execFileP(process.execPath, [cli, 'export', '--db', sqliteDbPath, '--agent', SERVE_AGENT, '--all-stages', '--output', tmp], { env: exportEnv, timeout: 120_000 });
    const { stdout } = await execFileP(process.execPath, [cli, 'import', tmp, '--remap-agent', SERVE_AGENT, '--dedupe'],
      { env: { ...process.env, AWM_STORE_BACKEND: 'postgres', AWM_DATABASE_URL: url }, timeout: 180_000 });
    return { ok: true, message: (stdout || '').trim() || 'memory copied' };
  } catch (e) {
    return { ok: false, message: `couldn't copy memory: ${(e as Error).message.slice(0, 200)}` };
  } finally { try { rmSync(tmp); } catch { /* */ } }
}
import { getProvider, listModels, PROVIDERS, backgroundCalls, type Provider } from './provider.js';
import { RoutedProvider } from './model-router.js';
import { MwaMemory } from './awm.js';
import { recordReceipt, readReceipts, setReceiptProducer } from './receipts.js';
import { setTranscriptProducer, stopHeartbeat } from './transcript.js';
import { scanSources } from './onboard.js';
import { buildRegistry } from './tools/build.js';
import { AGENT_BROWSER_HEADER } from './tools/browser.js';
import { goalsMentioned, WORK_NOTE_HEAD } from './work-note.js';
import { listPendingActions, confirmPending, cancelPending, setApprovalOwner, runApproved, recentApprovalOutcomes, recentAutoApproved } from './tools/approval.js';
import { logger, readLogs, type LogLevel } from './logger.js';
import { createV1Handler } from './api/v1.js';
import { makeAuthenticate, hasValidDeviceCookie } from './api/auth.js';
import { configureSessions, sessionValid, secretEquals, pruneSessions } from './api/sessions.js';
import { signInWithPassword } from './api/signin.js';
import { hostAllowed, relayedMode, detectTailscaleServe } from './api/trust.js';
import { setSettingsRouteDeps } from './api/routes/settings.js';
import { handleLegacyFiles, signedOutPageAllowed, legacyApiScope } from './api/legacy.js';
import { applyStoredSettings } from './v2/settings.js';
import { setJobRouteDeps, capFor, setCap } from './api/routes/jobs.js';
import { setStreamDeps } from './api/routes/stream.js';
import { startCalendarSync } from './sync/calendar.js';
import { startMailSync, openMail } from './sync/mail.js';
import { startImportant } from './v2/important-serve.js';
import { setTodayDeps } from './v2/today.js';
import { mailSyncOn } from './sync/flags.js';
import { migrateV2Once, describeReport } from './v2/migrate.js';
import { reapDeadTries, personAction, jobByGoal, busyReason, viewJob, jobBySchedule, getJob } from './v2/jobs.js';
import { historyStats } from './v2/estimate.js';
import { runAgent } from './agent.js';
import { preparePersonTurn, learnFromTurn } from './person-turn.js';
import { INTAKE_FIELDS } from './person-intake.js';
import { hasVerifiedFactor } from './person-identity.js';
import { issueStepUp, verifyStepUp } from './step-up.js';
import { runIngest, ingestAvailable } from './ingest.js';
import { runScheduler } from './scheduler.js';
// configPath(), not the bare CONFIG_PATH constant: MWA_CONFIG_PATH is how a container points
// config at its /data volume, and loadConfig() already honors it. setFetchModel/setImageModel
// below used the constant, so the UI saved to /app/mwa.config.json while the agent read
// /data/mwa.config.json — the model picker looked like it silently did nothing.
import { loadConfig, configPath, setStyle, INTERACTION_STYLES, type InteractionStyle } from './config.js';
import { injectionNote, modelWarnings } from './model-safety.js';
import { loadEnv } from './env.js';
import { mailboxDirs, watchInbox } from './mailbox.js';
import { googleConfigured, startGmailConnect } from './connectors/google.js';
import { gmailImapConfigured, verifyGmailImap } from './connectors/gmail-imap.js';
import { microsoftConfigured, microsoftClientReady, startMicrosoftConnect, startMicrosoftDeviceCode } from './connectors/microsoft.js';
import { isHosted, hostName } from './hosting.js';
import { listConnectors, enableConnector, disableConnector, enabledConnectorIds, enableExternalNpm } from './connectors/registry.js';
import { externalInstallState } from './installer/policy.js';
import { reviewConnector } from './installer/review.js';
import { accessPolicy, setAccess, ACCESS_PRESETS, grantedFolders, type AccessPreset } from './tools/access.js';
import { status, testAnthropic, testAzure, testTelegram, testProvider, envKeyForProvider, upsertEnv, removeEnv } from './wizard.js';
import { disconnectGoogle } from './connectors/google.js';
import { disconnectMicrosoft } from './connectors/microsoft.js';
import { setSetupDeps, listSetupRequests, submitSetupRequest, cancelSetupRequest } from './connect/setup.js';
import { awmCliPath, loadEmbeddings, loadPostgresStore } from './awm-api.js';
import { MEMORY_OFF, agentMemory } from './memory-off.js';
import { fileHeaders, sessionFolder, uploadsIn, shareFor } from './files.js';
import { offersBackground, OFFER_TEXT, startBackgroundWork, continueGoal, resumeInstruction } from './handoff.js';
import { scheduleRows, scheduleControl, type ScheduleAction } from './schedule-api.js';
import { liveRuns, FINAL_EVENTS } from './live-runs.js';
import { resolvePersonId } from './person.js';
import { appendTurn, answerOffer, readConversation, listConversations, conversationsPath } from './conversations.js';
import { GENERAL, getProject, sessionOf, projectOfSession, crossTalk, apiProvenance, interruptStaleRunning, resultSessionFor, threadOfSession, runningIn, type Provenance } from './v2/projects.js';
import { importConversations, describeConversationsReport } from './v2/migrate-conversations.js';
import { setProjectRouteDeps, type ChatStart, type ChatExtras } from './api/routes/projects.js';
import { setAskRouteDeps } from './api/routes/ask.js';
import { finishAsk, setNarrowModel, narrowPrompt, firstJson, framedQuestion, askOfferAccepted, narrowAffordable, NARROW_CAP_USD } from './v2/ask.js';
import { newLedger, withLedger, metered } from './spend.js';
import { readCalls, billingSummary, callsCsv, setMonthlyBudget, providerBalance, monthStart, budgetHold } from './billing.js';
import { thinkMode, thinkDue, thinkOnce, thinkEveryMs, thinkDailyUsd, readThoughts, latestThoughts } from './thinking.js';
import { exportDoc, exportFormats } from './doc-export.js';
import { dbFile, runLogPath, notifyPath, installLogPath } from './paths.js';
import { vaultRows, forgetVaultEntry, quietState, setQuiet } from './settings-api.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// dist-ui sits next to dist/ (built) or at repo root in dev.
const UI_DIRS = [resolve(HERE, '../dist-ui'), resolve(HERE, '../../dist-ui'), resolve(process.cwd(), 'dist-ui')];
function uiDir(): string | null {
  for (const d of UI_DIRS) if (existsSync(join(d, 'index.html'))) return d;
  return null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

// The agent id serve reads/writes memory under. Override with MWA_AGENT_ID to point an instance
// at a memory store written by a different agent (e.g. testing a ported USEA store under its own id).
const SERVE_AGENT = process.env.MWA_AGENT_ID ?? 'mwa-serve';
/** The stores whose routines the Memory tab lists and promotes: this app's, and the Telegram connector's. */
const ROUTINE_AGENTS = [...new Set([SERVE_AGENT, process.env.MWA_TELEGRAM_AGENT_ID ?? 'mwa-agent'])];

export async function readBody(req: AsyncIterable<Buffer | string>): Promise<any> {
  // Collect raw bytes, then decode UTF-8 ONCE. Decoding per-chunk (raw += c) corrupts a
  // multi-byte char split across a chunk boundary — real for large bodies (e.g. an
  // onboarding save with em-dashes/accents/emoji in the content).
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/**
 * CSRF defense for state-changing endpoints. The access cookie is SameSite=Lax, which does NOT
 * stop a cross-origin top-level POST, and readBody parses text/plain (no preflight) — so any web
 * page the user visits while MWA runs on localhost could otherwise POST to it. We reject unless
 * the request is same-origin: prefer Sec-Fetch-Site (sent by modern browsers), fall back to an
 * Origin host == Host check. Requests with NO Origin/Sec-Fetch-Site (curl, server-to-server) are
 * allowed — those are not browser CSRF vectors.
 */
export function sameOriginOk(req: IncomingMessage): boolean {
  const sfs = String(req.headers['sec-fetch-site'] ?? '');
  if (sfs) return sfs === 'same-origin' || sfs === 'none';
  const origin = req.headers['origin'];
  if (!origin) return true;
  try { return new URL(String(origin)).host === String(req.headers['host'] ?? ''); } catch { return false; }
}

// --- Access gate. When MWA_ACCESS_PASSWORD is set (recommended for any networked /
// NAS deployment), the UI + API are locked behind a single shared password until the
// browser holds a valid session cookie. Unset (the localhost default) = no gate, so the
// existing one-machine flow is unchanged. Cookie-based on purpose: EventSource (the SSE
// chat) can't send custom headers but does send same-origin cookies automatically.
const ACCESS_PW = process.env.MWA_ACCESS_PASSWORD || '';
// BL-71: a session survives a restart or a deploy (signed with a key from the password and a salt beside the data).
// W5 security review: each session also has a record in app.db, so signing out ends it on the server too
// (src/api/sessions.ts). With no password, "authed" means nothing on its own: every /api route checks its caller.
configureSessions({ password: ACCESS_PW });
function authed(req: IncomingMessage): boolean {
  if (!ACCESS_PW) return true;
  return sessionValid(req);
}

// Bundled MCP tools the Connections page can toggle on/off (no file editing).
/** Self-learning loop: answer up to 3 open questions in the background (the agent runs
 *  non-interactively → its auto-learn writes the answers as facts), then mark them resolved. */
async function resolveOpenQuestionsBg(): Promise<void> {
  const cfg = loadConfig();
  const dbPath = dbFile();
  const memory = new MwaMemory(SERVE_AGENT, dbPath, cfg.awm.workspace);
  const open = MEMORY_OFF ? [] : (await memory.listOpenQuestions()).slice(0, 3); // memory off: no open questions
  if (!open.length) { memory.close(); return; }
  const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const { registry, close } = await buildRegistry(cfg, memory);
  const dir = resolve(cfg.workspace ?? './mwa-workspace', 'serve', 'resolve');
  for (const q of open) {
    try {
      await runAgent({ instruction: `Answer this open question and report what you found: ${q.question}`, dir, memory, brain, worker, tools: registry, workspace: cfg.awm.workspace, session: 'resolve', interactive: false, style: cfg.style, budget: { maxSteps: 20, maxWallMs: 5 * 60_000, consolidateEvery: 10 } });
      await memory.resolveQuestion(q.id);
    } catch { /* best-effort */ }
  }
  await close(); memory.close();
}

/** Fires already recorded as served to a browser (BL-13) — seeded from the receipts on first use. */
let servedFires: Set<string> | null = null;

/** Record a fired scheduled-task result so the UI can surface it (proactive delivery). */
function appendNotification(entry: Record<string, unknown>): boolean {
  try {
    const p = notifyPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + '\n');
    return true;
  } catch { return false; /* best-effort — but a receipt must not claim it was saved */ }
}

/** Persist the chosen brain into mwa.config.json. The cheap tier (fetch) becomes the
 *  picked model; the strong tier (reason) stays Anthropic Sonnet ONLY when an Anthropic
 *  key is present — otherwise it mirrors the picked provider, so a single-provider setup
 *  (e.g. keyless Ollama) doesn't leave reason pointing at a provider with no key (which
 *  would break escalation + the scheduler with "Missing ANTHROPIC_API_KEY"). */
function setFetchModel(provider: string, model: string): void {
  const spec = `${provider}:${model}`;
  let raw: any = {};
  try { if (existsSync(configPath())) raw = JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* */ }
  raw.models = raw.models ?? {};
  raw.models.fetch = spec;
  // Reason tier: keep/restore a Sonnet ceiling iff Anthropic is usable; else mirror fetch.
  raw.models.reason = (provider === 'anthropic' || process.env.ANTHROPIC_API_KEY)
    ? (provider === 'anthropic' ? spec : (raw.models.reason || 'anthropic:claude-sonnet-4-6'))
    : spec;
  writeFileSync(configPath(), JSON.stringify(raw, null, 2) + '\n');
}

/** Set (or clear, when model is empty) the image-generation model in mwa.config.json. */
function setImageModel(provider: string, model: string): void {
  let raw: any = {};
  try { if (existsSync(configPath())) raw = JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* */ }
  raw.models = raw.models ?? {};
  if (model) raw.models.image = `${provider}:${model}`; else delete raw.models.image;
  writeFileSync(configPath(), JSON.stringify(raw, null, 2) + '\n');
}

/** Per-session working dir + memory, so chat follow-ups build on earlier turns.
 *  topicStart = index into history where the CURRENT topic began; only turns from there
 *  forward are threaded as context, so a new task doesn't drag stale context with it. */
// `tainted`: the turn read external content (BL-17). Its reply is carried into later turns FENCED, via
// runAgent's `carried`, instead of being pasted into the next instruction as if the person said it.
interface Session { dir: string; history: { instruction: string; summary: string; tainted?: boolean }[]; lastUsed: number; topicStart: number; }
const sessions = new Map<string, Session>();
// How much of the conversation a turn carries (BL-53). The product carries the last 3 turns of the current topic;
// the fair rerun of the promise assessment gives every arm the same window as its plain-loop arm — one long
// conversation, scheduled results included — so memory is measured on top of a window, not instead of one.
//   MWA_CARRY_TURNS        turns carried (default 3)
//   MWA_CARRY_ALL=1        carry the last N turns whatever the topic (no continue/fresh classification)
//   MWA_CARRY_JOB_RESULTS=1  a delivered scheduled result joins its session's conversation (fenced: outside content)
const CARRY_TURNS = Math.max(1, Math.min(60, Number(process.env.MWA_CARRY_TURNS) || 3));
const CARRY_ALL = process.env.MWA_CARRY_ALL === '1';
const CARRY_JOB_RESULTS = process.env.MWA_CARRY_JOB_RESULTS === '1';
const SERVER_START = Date.now();
/** v2: the jobs migration at start (runServe); the scheduler and the first /api/v1 request wait for it. */
let v2Ready: Promise<void> = Promise.resolve();
let activeRuns = 0;          // in-flight agent runs — capped to protect the box
let lastSchedulerTick = 0;   // scheduler liveness heartbeat (for /api/health)
const MAX_CONCURRENT = Number(process.env.MWA_MAX_CONCURRENT ?? 4);
const SESSION_TTL_MS = Number(process.env.MWA_SESSION_TTL_MS ?? 30 * 60_000);
const MAX_SESSIONS = 100;

/** Drop idle/excess sessions so the map can't grow unbounded. */
function evictSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_TTL_MS) sessions.delete(id);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed).slice(0, sessions.size - MAX_SESSIONS);
    for (const [id] of oldest) sessions.delete(id);
  }
}

function sessionFor(id: string, workspaceRoot: string): Session {
  evictSessions();
  let s = sessions.get(id);
  if (!s) {
    // BL-71d: after a restart or on another device, carry on from the kept conversation, not from nothing. A turn
    // with no taint record (or one that read outside content) comes back fenced.
    const kept = readConversation(id, 12).filter((t) => t.kind === 'chat' || t.kind === 'result').map((t) => ({ instruction: t.kind === 'result' ? `(background result) ${t.message}` : t.message, summary: t.reply.slice(0, 1500), tainted: t.tainted !== false }));
    s = { dir: resolve(workspaceRoot, 'serve', id.replace(/[^a-z0-9_-]/gi, '')), history: kept, lastUsed: Date.now(), topicStart: 0 };
    sessions.set(id, s);
  }
  s.lastUsed = Date.now();
  return s;
}

// A gap this long since the last turn used to mean a new task, so the earlier conversation was dropped
// silently — after 45 minutes by default. BL-71d: conversations are explicit now (a list to reopen, and
// "+ new"), and Robert came back to a chat and could not continue it; so a gap alone no longer starts fresh
// (0 = off) — what the message says decides, below. MWA_FRESH_IDLE_MS brings the old rule back;
// MWA_TOPIC_BOUNDARY=0 disables the whole check.
const FRESH_IDLE_MS = Number(process.env.MWA_FRESH_IDLE_MS ?? 0);

/**
 * Decide how a new chat message relates to the current topic, so we auto-CHAIN follow-ups but
 * don't drag stale context into a genuinely new task:
 *   'continue' → thread the recent turns as context (a follow-up, a reference back, an answer).
 *   'fresh'    → a clearly different task → drop the earlier context (start a new topic).
 *   'ask'      → genuinely ambiguous → let the agent confirm with the user before assuming.
 * Heuristics settle the clear cases for free (idle gap, leading connectives/anaphora, short
 * confirmations); only a true tie costs one cheap model call. Errs toward 'continue' (a few
 * extra context lines the agent can ignore) over 'fresh' (dropping context it actually needed).
 */
async function classifyContinuity(brain: Provider, recent: { instruction: string; summary: string }[], message: string, idleMs: number): Promise<'continue' | 'fresh' | 'ask'> {
  if (process.env.MWA_TOPIC_BOUNDARY === '0') return 'continue';
  if (recent.length === 0) return 'fresh';        // nothing to chain onto yet
  if (FRESH_IDLE_MS > 0 && idleMs > FRESH_IDLE_MS) return 'fresh'; // long silence ⇒ new task (only when switched on)
  const t = message.trim().toLowerCase();
  // Clear continuations: a leading connective ("and/also/then/now…"), an opening anaphor
  // ("it/that/them/he/she…" — refers back), or a short answer to a prior turn/offer.
  const cont = /^(and\b|also\b|then\b|next\b|now\b|plus\b|but\b|so\b|ok(ay)?,?\s+(now|then|do|go|and|next)|what about|how about|same\b|continue|keep going|go on|go ahead|do it|yes\b|yep|yeah|sure\b|please do|sounds good|that works|the (first|second|third|last|same|other|one)\b|option\s*\d|that one|this one|it\b|that\b|they\b|them\b|those\b|these\b|he\b|she\b|his\b|her\b|their\b)/.test(t);
  if (cont) return 'continue';
  // Ambiguous → one cheap call comparing the message to the last couple of turns.
  try {
    if (brain instanceof RoutedProvider) brain.reset('fetch');
    const last = recent.slice(-2).map((h, i) => `(${i + 1}) ${h.instruction} → ${h.summary}`).join('\n').slice(0, 800);
    const out = await brain.chat({
      system: 'Decide if the NEW MESSAGE continues the RECENT CONVERSATION or starts a different, unrelated task. Reply with ONE word only: CONTINUE (it follows on or refers back), NEW (a clearly different topic/task), or UNCLEAR (could be either). No other text.',
      messages: [{ role: 'user', content: `RECENT CONVERSATION:\n${last}\n\nNEW MESSAGE: ${message.slice(0, 400)}` }],
      maxTokens: 4,
    });
    const v = (out.text ?? '').trim().toUpperCase();
    if (v.startsWith('CONTINUE')) return 'continue';
    if (v.startsWith('NEW')) return 'fresh';
    return 'ask';
  } catch { return 'continue'; }   // never block a chat on the classifier
}

/** "Learn about me from my email" — stream the inbox scan over SSE. Pages whichever email
 *  account is connected (Gmail OAuth / app-password / Outlook), extracts durable facts about
 *  the user's world into memory. Reads only; nothing leaves the machine. */
async function ingestScan(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30), 1), 730);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (!ingestAvailable()) { send('error', { message: 'Connect Gmail or Outlook first, then I can learn from your email.' }); res.end(); return; }
  if (activeRuns >= MAX_CONCURRENT) { send('error', { message: "I'm busy right now — try again in a moment." }); res.end(); return; }
  const hb = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* */ } }, 15_000);
  req.on('close', () => clearInterval(hb));
  const dbPath = dbFile();
  try {
    activeRuns++;
    const r = await runIngest({ days, dbPath, onLog: (m) => send('log', { message: m }) });
    send('result', { unique: r.unique, learned: r.learned });
  } catch (e) {
    logger.error('ingest', 'scan failed', { error: (e as Error).message.slice(0, 200) });
    send('error', { message: (e as Error).message.slice(0, 200) });
  } finally {
    activeRuns--; clearInterval(hb); res.end();
  }
}

/** Deliver a step-up code OUT-OF-BAND to a person's validated connection. Today only Telegram-
 *  authenticated persons (personId `tg-<chatId>`) have a reachable OOB channel; returns false otherwise
 *  so the sensitive action stays blocked. Cross-channel linking (web↔telegram) is the follow-on. */
async function deliverStepUpCode(personId: string, code: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token && personId.startsWith('tg-')) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: personId.slice(3), text: `MWA verification code: ${code}\nSomeone is trying to take a sensitive action as you — if that wasn't you, ignore this.` }),
      });
      return r.ok;
    } catch { return false; }
  }
  return false;
}

/** BL-71: the work in progress, so a chat knows about it. Hard test 2026-10-23: "shorten the newsletter" in the
 *  newsletter's own conversation asked the person to upload it — the job had paused before writing it, and the
 *  chat had no idea there was a goal. Titles are the person's own words; a state noted after outside content is
 *  left out (the Work tab shows it). At most five, kept short. */
async function workNote(memory: MwaMemory, sessionId: string, person: string | null, message: string): Promise<string> {
  try {
    const me = resolvePersonId({ channel: 'web', name: (person ?? '').trim() || undefined });
    const [goals, records, jobs] = await Promise.all([memory.listGoals(), memory.listGoalRecords(), memory.pendingScheduled()]);
    const open = goals.filter((g) => g.status !== 'done' && (!g.person || g.person === me)).slice(0, 5);
    if (!open.length) return '';
    // Only the goals this message is about (interface slice replay 2026-10-26: told about every goal with "offer to
    // continue it", a run answered "write me an informal note" by writing the board briefing instead).
    const about = goalsMentioned(message, open.map((g) => ({ ...g, fromHere: records.find((r) => r.goalId === g.id)?.conv === sessionId })));
    if (!about.length) return '';
    const lines = about.map((g) => {
      const rec = records.find((r) => r.goalId === g.id);
      const state = !rec ? 'no note yet' : rec.trust === 'untrusted' ? 'see the Work tab' : (rec.text.split('\n')[0] ?? '').replace(/^Where we are on "[^"]*" \(goal [^)]*\): /, '').slice(0, 160);
      const here = rec?.conv === sessionId ? ' (from this conversation)' : '';
      const running = jobs.some((t) => t.goal === g.id && !t.recur) ? '; a background job is on it' : '';
      return `- goal ${g.id.slice(0, 8)} "${g.title.slice(0, 90)}"${here}: ${g.status.replace('_', ' ')}${running}; ${state}`;
    });
    return `\n\n${WORK_NOTE_HEAD}\n${lines.join('\n')})`;
  } catch { return ''; }
}

/** Where a chat's events go: an SSE response (/api/chat), or the v1 send that answers as soon as the run starts. */
interface ChatSink { write(type: string, data: Record<string, unknown>): void; ping(): void; end(): void; onClose(fn: () => void): void }
interface ChatParams { message: string; sessionId: string; resumeParam: string; stay: boolean; person: string | null; /** A6: an ask's shaping of the run */ extras?: ChatExtras }

/** Stream one runAgent over SSE: every onEvent becomes an SSE event for the spine. */
async function chat(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const sink: ChatSink = {
    write: (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } },
    ping: () => { try { res.write(': keepalive\n\n'); } catch { /* */ } },
    end: () => res.end(),
    onClose: (fn) => { req.on('close', fn); },
  };
  // A5: `projectId` sends it into that project's thread (session p-<id>); without it, the session as before (kept in General).
  let sessionId = url.searchParams.get('session') || 'default';
  const projectParam = url.searchParams.get('projectId');
  if (projectParam) {
    const p = getProject(projectParam);
    if (!p || p.archived) { sink.write('error', { message: p ? `${p.name} is archived. Restore it first.` : 'No such project.' }); sink.end(); return; }
    sessionId = sessionOf(p.id);
  }
  await runChat({ message: (url.searchParams.get('message') ?? '').trim(), sessionId, resumeParam: url.searchParams.get('resume') ?? '', stay: url.searchParams.get('stay') === '1', person: url.searchParams.get('person') }, sink);
}

/** A5: "Work on it" on an offer in a project's thread (v1): the same as /api/work/start — a goal and a job that starts
 *  now in the thread's folder; the offer turn records it. Null when there is no waiting offer with those words. */
async function acceptProjectOffer(projectId: string, o: { message?: string; person?: string }): Promise<{ goal: string; message: string } | null> {
  if (MEMORY_OFF) return null;
  const session = sessionOf(projectId);
  const waiting = readConversation(session, 200).filter((t) => t.kind === 'offer' && !t.offer);
  const offer = o.message ? waiting.find((t) => t.message === o.message) : waiting[waiting.length - 1];
  if (!offer) return null;
  const cfg = loadConfig();
  const memory = new MwaMemory(SERVE_AGENT, dbFile(), cfg.awm.workspace);
  try {
    const personId = resolvePersonId({ channel: 'web', name: (o.person ?? '').trim() || undefined });
    const started = await startBackgroundWork(memory, { message: offer.message, session, personId, workspace: cfg.workspace ?? './mwa-workspace' });
    if (!started) return null;
    answerOffer(session, 'background', started.goalId.slice(0, 8), undefined, undefined, offer.message);
    // A6 review: an offer an ask made records the job it became
    if (offer.id && started.v2JobId) { try { askOfferAccepted(offer.id, started.v2JobId); } catch { /* bookkeeping */ } }
    return { goal: started.goalId.slice(0, 8), message: "On it. I'll work on this in the background and post the result here when it's done." };
  } finally { memory.close(); }
}

/** A5: a message sent into a project from /api/v1: the same run as /api/chat, answered once it has started (or offered,
 *  or refused as busy). Its progress goes out on /stream; its answer lands in the thread. */
function startProjectChat(projectId: string, text: string, o: { stay?: boolean; person?: string; extras?: ChatExtras }): Promise<ChatStart> {
  return new Promise((done) => {
    let settled = false;
    const settle = (v: ChatStart) => { if (!settled) { settled = true; done(v); } };
    const sink: ChatSink = {
      write: (type, data) => {
        if (type === 'run') settle({ state: 'started', runId: String(data.runId), ...(data.turn ? { turnId: String(data.turn) } : {}) });
        else if (type === 'result' && data.reason === 'offer') settle({ state: 'offer', message: String(data.summary ?? OFFER_TEXT), ...(data.turn ? { turnId: String(data.turn) } : {}) });
        else if (type === 'busy') settle({ state: 'busy', message: 'An answer is still being written in this project. Wait for it, or add to it.' });
        else if (type === 'error') settle({ state: 'busy', message: String(data.message ?? 'That could not start just now. Try again in a moment.') });
      },
      ping: () => { /* */ },
      end: () => settle({ state: 'busy', message: 'That could not start just now. Try again in a moment.' }),
      onClose: () => { /* nobody to detach: the run is followed on /stream */ },
    };
    void runChat({ message: text, sessionId: sessionOf(projectId), resumeParam: '', stay: o.stay === true, person: o.person ?? null, ...(o.extras ? { extras: o.extras } : {}) }, sink)
      .catch((e) => settle({ state: 'busy', message: (e as Error).message.slice(0, 200) }));
  });
}

async function runChat(p: ChatParams, sink: ChatSink): Promise<void> {
  const { message, sessionId } = p;
  const send = (type: string, data: Record<string, unknown>) => sink.write(type, data);
  if (!message) { send('error', { message: 'empty message' }); sink.end(); return; }
  // 3b (pending list 2026-10-26): "Continue from where it stopped" — the run the person stopped is picked up from
  // its own words, framed as a resume (resumeInstruction), not re-read from the page's title. Never offered to the
  // background (the task's words could match the offer test) and never put to the continuity classifier.
  const resumeParam = p.resumeParam;
  const resume = resumeParam !== '' && resumeParam !== '0';
  const resumeTs = /^\d{6,}$/.test(resumeParam) ? Number(resumeParam) : undefined; // the card's own stopped turn, when the page names it
  // BL-71b: a request that researches and writes something up is offered to the background first; the
  // person picks. "Stay here" sends it again with stay=1, and it runs in the chat as before.
  if (!resume && !p.stay && process.env.MWA_OFFER_BACKGROUND !== '0' && offersBackground(message)) {
    const turn = appendTurn({ ts: Date.now(), session: sessionId, message, reply: OFFER_TEXT, reason: 'offer', kind: 'offer' });
    send('result', { reason: 'offer', summary: OFFER_TEXT, steps: 0, dispatches: 0, toolCalls: 0, costUsd: 0, offer: { kind: 'start', message }, ...(turn ? { turn } : {}) });
    sink.end(); return;
  }
  // F08 (usability review 2026-10-24): one live run per conversation. A message sent while one is going is not a
  // second run: the page hears `busy` and offers to add it to the running task (/api/chat/steer), send it
  // separately (a new conversation) or stop the run (/api/chat/stop) and send it.
  // A5: one run at a time per PROJECT, whichever session names it (p-general and an older client's conversation kept in
  // General are the same thread).
  const busy = liveRuns.describe(sessionId) ?? busyInProject(threadOf(sessionId));
  if (busy) { send('busy', busy as unknown as Record<string, unknown>); sink.end(); return; }
  // "do it here": the offer with these words records the choice — only once the run really starts (audit 2026-10-26)
  if (p.stay) answerOffer(sessionId, 'now', undefined, undefined, undefined, message);
  // Concurrency cap — reserve the slot ATOMICALLY (before any await) so a burst of near-simultaneous
  // chats can't all pass the gate during the classifyContinuity / preparePersonTurn round-trips.
  if (activeRuns >= MAX_CONCURRENT) { send('error', { message: "I'm at capacity right now (too many chats running) — try again in a moment." }); sink.end(); return; }
  activeRuns++;
  // The live run: its events are kept and handed to every reader attached to this conversation — this response
  // first, and any page that re-attaches after a reload (F09). Its abort handle is the person's Stop (F06).
  const run = liveRuns.start(sessionId, message);
  const off = liveRuns.attach(sessionId, (e) => sink.write(e.type, e.data as Record<string, unknown>));
  const emitLive = (type: string, data: Record<string, unknown>) => liveRuns.record(sessionId, type, data);
  const ex = p.extras;
  const runningTurn = appendTurn({ ts: run.startedAt, session: sessionId, message, reply: '', kind: 'running', runId: run.runId, ...(ex?.about ? { about: ex.about } : {}), ...(ex?.source === 'voice' ? { source: 'voice' as const } : {}) });
  emitLive('run', { runId: run.runId, startedAt: run.startedAt, ...(runningTurn ? { turn: runningTurn } : {}) });
  // Heartbeat: keep the SSE stream alive during slow steps so proxies/browsers don't drop it mid-run.
  const hb = setInterval(() => sink.ping(), 15_000);
  // The page going away does not stop the run (it re-attaches); only its reader is detached.
  sink.onClose(() => { clearInterval(hb); off?.(); });

  // Hoisted so the finally can always release them even if setup (buildRegistry etc.) throws.
  let memory: MwaMemory | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    const cfg = loadConfig();
    const dbPath = dbFile();
    // Idle gap BEFORE sessionFor() bumps lastUsed — a long gap signals a new task.
    const idleMs = sessions.has(sessionId) ? Date.now() - (sessions.get(sessionId)!.lastUsed) : Infinity;
    const s = sessionFor(sessionId, cfg.workspace ?? './mwa-workspace');
    memory = new MwaMemory(SERVE_AGENT, dbPath, cfg.awm.workspace);
    memory.setSessionId(sessionId); // entity-bridge continuity across this conversation
    const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
    const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
    const reg = await buildRegistry(cfg, memory); close = reg.close; const registry = reg.registry;

    // AUTO-CHAIN, but know when to stop: continue the current topic, start a new one, or ask.
    const topicTurns = s.history.slice(s.topicStart);
    const resumed = resume ? resumeInstruction(readConversation(sessionId, 80), resumeTs) : null; // null: nothing stopped — a plain message
    // A6: a question about one thing stands on its own (the thing is its context): no conversation is carried, no
    // classifier call, and the thread's topic is left as it was
    const relation = resumed ? 'continue' as const : ex?.about ? 'fresh' as const : CARRY_ALL ? (s.history.length ? 'continue' as const : 'fresh' as const) : await classifyContinuity(brain, topicTurns, message, idleMs);
    const hadContext = topicTurns.length > 0;
    if (relation === 'fresh' && !ex?.about) s.topicStart = s.history.length;
    // F5: topic-scoped memory is OPT-IN (MWA_TOPIC_NAMESPACE=1). Default OFF preserves cross-session continuity.
    if (process.env.MWA_TOPIC_NAMESPACE === '1') memory.setNamespace(`${sessionId}-t${s.topicStart}`);
    emitLive('topic', { relation, hadContext, ...(resumed ? { resumed: true } : {}) });
    const carriedTurns = relation === 'continue' ? s.history.slice(Math.max(CARRY_ALL ? 0 : s.topicStart, s.history.length - CARRY_TURNS)) : [];
    const ctx = carriedTurns.map((h, i) => `(${i + 1}) ${h.instruction} → ${h.summary}`).join('\n');
    // If any carried turn read external content, its replies may quote that content: send the whole
    // context fenced through `carried` (with this run starting tainted), not inside the instruction.
    const ctxTainted = carriedTurns.some((h) => h.tainted);
    const askNote = relation === 'ask' && topicTurns.length
      ? `\n\nNOTE: It's unclear whether this continues the recent conversation (about "${topicTurns[topicTurns.length - 1].instruction.slice(0, 60)}…") or is a new request. If that distinction affects your answer, ask the user ONE short yes/no question to confirm before proceeding; otherwise treat it as a new request.`
      : '';
    // BL-70: the person sees this chat's folder in the Files tab, and a link by file name opens it there.
    const added = uploadsIn(resolve(cfg.workspace ?? './mwa-workspace'), sessionFolder(sessionId));
    const filesNote = `\n\n(Files you write here are saved for the person and appear in their Files tab; when you mention one, link it by its path, e.g. [the notes](notes.md). Files from their earlier chats and jobs are theirs too: list_files with \`search\` finds one by name, and read_file opens it by that full path.${added.length ? ` Files they added to this chat: ${added.join(', ')}.` : ''})`;
    // A6: an ask's framing comes before the person's words (never the thing's own text: that is fenced, below), and its
    // attached files are named after them
    // (A6 review) the files' paths are not here: they reach the run fenced, in `carried`; the note is fixed wording
    const asked = (resumed?.instruction ?? framedQuestion(ex?.framing, message)) + (ex?.note ?? ''); // a resume runs the stopped task's own words, framed; the person's words stay the turn
    const instruction = (ctx && !ctxTainted ? `Recent conversation so far:\n${ctx}\n\nNew request: ${asked}` : asked) + askNote + filesNote + await workNote(memory, sessionId, p.person, resumed?.stopped.message ?? message);

    // Per-person Profile (S1–S6): resolve who's talking, build their prompt context (identity guard +
    // primer + intake hint, with PII redacted on an identity mismatch). Off-switch MWA_PERSON_PROFILE=0.
    const personName = (p.person ?? '').trim() || undefined;
    const prepared = await preparePersonTurn(memory, { channel: 'web', name: personName }, message);
    const personContext = prepared.personContext;
    emitLive('person', { id: prepared.personId, notes: prepared.notes }); // Glass-Box: who + how much we know
    // Surface the DOUBT to the UI, but NOT the reasons — they contain the real stored name/contact, and
    // this stream goes to the very client we're flagging as a possible impersonator (S6 redaction).
    if (prepared.mismatch) emitLive('identity', { level: 'mismatch' });

    const r = await runAgent({
      instruction, userMessage: resumed?.stopped.message ?? message, dir: s.dir, memory: agentMemory(memory), brain, worker, tools: registry, transcript: true, // BL-10; a resume is judged on the task's words, not the button's
      // Fenced context: a tainted earlier turn, and a stopped run's last word when that run had read outside content
      ...(((ctx && ctxTainted) || resumed?.tainted || ex?.carried) ? {
        carried: [ctx && ctxTainted ? `Recent conversation so far:\n${ctx}` : '', resumed?.tainted ? `Last word of the stopped attempt: ${resumed.lastWord}` : '', ex?.carried ?? ''].filter(Boolean).join('\n\n'),
        // A6: the thing an ask is about starts the run tainted when its words are someone else's
        startTainted: !!((ctx && ctxTainted) || resumed?.tainted || ex?.startTainted),
      } : {}),
      workspace: cfg.awm.workspace, session: sessionId, interactive: true, // a human is watching → ask_user can ask them
      style: cfg.style, // guided (proactive/plain) vs direct (concise) — independent of access preset
      personContext, // S2: per-person adaptation block (empty for the shared/unknown profile)
      personId: prepared.personId, identityInDoubt: prepared.mismatch, // S6 v2: gate sensitive confirms on step-up
      domainPackDir: process.env.MWA_DOMAIN_PACK, // optional domain pack (AGENT.md + topics) for a domain agent
      budget: { maxSteps: ex?.budget?.maxSteps ?? 40, maxWallMs: ex?.budget?.maxWallMs ?? 10 * 60_000, consolidateEvery: 10, maxTokens: Number(process.env.MWA_MAX_TOKENS ?? 400_000), ...(ex?.budget?.maxUsd ? { maxUsd: ex.budget.maxUsd } : {}) },
      onEvent: (type, d) => emitLive(type, d as Record<string, unknown>),
      signal: run.controller.signal, inbox: () => liveRuns.takeInbox(sessionId), // F06 Stop, F08 steer
    });
    s.history.push({ instruction: message, summary: r.summary, tainted: r.tainted === true });
    // BL-71b: it ran out of room and already queued a resume — say so, rather than leave a half answer.
    // Billing: a chat still runs at the monthly budget, and says so (unattended jobs wait).
    const hold = budgetHold();
    const summary = (r.resumeQueued ? `${r.summary}\n\nI ran out of room in this chat, so I'm continuing in the background. The result will appear here when it's done.` : r.summary)
      + (hold.held ? `\n\n(This month's model spend has reached the $${hold.budgetUsd} budget — $${hold.usedUsd} so far. Scheduled jobs wait until next month or a higher budget in Settings › Billing; chats still run.)` : '');
    const turnTs = Date.now();
    // A5: the other projects whose memories this answer used ("using what I know from Eventing").
    const provenance = crossTalkFor(sessionId, await memory.usedMemories(r.summary, { exclude: prepared.terms ?? [] }).catch(() => []));
    const turnId = appendTurn({ ts: turnTs, session: sessionId, message, reply: summary, reason: r.reason, kind: 'chat', tainted: r.tainted === true, runId: run.runId, ...(provenance.length ? { provenance } : {}), ...(r.v2JobId ? { job: r.v2JobId } : {}), ...(resumed?.stopped.ts !== undefined ? { resumes: resumed.stopped.ts } : {}), ...(ex?.about ? { about: ex.about } : {}), ...(ex?.source === 'voice' ? { source: 'voice' as const } : {}) }); // BL-71d; the runId retires the `running` turn (F09); `resumes` keeps the task's own words reachable (3b)
    // A6: the ask is answered — on the ask, and under the item it was about
    if (ex?.askId) { try { finishAsk(ex.askId, { turnId, runId: run.runId, reply: summary, tainted: r.tainted === true, ok: true }); } catch (e) { logger.error('ask', 'the answer could not be kept on its ask', { error: (e as Error).message.slice(0, 160) }); } }
    // S3/S5 — LEARN durable facts about this person + recompress their dossier (suppressed for the
    // shared 'unknown' profile and on an identity mismatch). Before the result closes the stream, so an attached
    // page hears it too; it is quick and runs on the reply, not the person's wait.
    const learned = r.tainted || MEMORY_OFF ? 0 : await learnFromTurn(brain, memory, prepared, message, r.summary);
    if (learned) emitLive('learned', { about: prepared.personId, count: learned });
    emitLive('result', { reason: r.reason, summary, steps: r.steps, dispatches: r.dispatches, toolCalls: r.toolCalls, costUsd: Number(r.costUsd.toFixed(4)), runId: run.runId, turnId: turnTs, elapsedMs: turnTs - run.startedAt,
      ...(turnId ? { turn: turnId } : {}), ...(provenance.length ? { provenance: apiProvenance(provenance) } : {}), ...(r.staged?.length ? { staged: r.staged } : {}), ...(r.v2JobId ? { job: r.v2JobId } : {}) });
  } catch (e) {
    logger.error('chat', 'agent run failed', { session: sessionId, error: (e as Error).message.slice(0, 200) });
    // A5: the turn is finished with what went wrong, so no `running` turn stays behind
    const errReply = `This stopped with an error before it finished: ${(e as Error).message.slice(0, 300)}`;
    const errTurn = appendTurn({ ts: Date.now(), session: sessionId, message, reply: errReply, reason: 'error', kind: 'chat', runId: run.runId, ...(ex?.about ? { about: ex.about } : {}), ...(ex?.source === 'voice' ? { source: 'voice' as const } : {}) });
    if (ex?.askId) { try { finishAsk(ex.askId, { turnId: errTurn, runId: run.runId, reply: errReply, tainted: ex.startTainted === true, ok: false }); } catch { /* */ } }
    emitLive('error', { message: (e as Error).message, runId: run.runId });
  } finally {
    activeRuns--;
    clearInterval(hb);
    liveRuns.finish(sessionId); off?.();
    if (close) await close();
    memory?.close();
    sink.end();
  }
}

/** A5: a run's used memories as cross-talk provenance — the projects other than this thread's (General for an older
 *  conversation's session). Never fails the chat. */
function crossTalkFor(sessionId: string, used: { id: string; session?: string }[]): Provenance[] {
  try { return crossTalk(used, { projectId: threadOf(sessionId), session: sessionId }); } catch { return []; }
}

const threadOf = (sessionId: string) => threadOfSession(sessionId);
/** A run going in a project's thread, under whichever session it was started. */
function busyInProject(projectId: string): ReturnType<typeof liveRuns.describe> {
  try { const s = runningIn(projectId, liveRuns.all().map((r) => r.session)); return s ? liveRuns.describe(s) : null; } catch { return null; }
}
/** The live session of a project's run, if one is going. */
function liveSessionOf(projectId: string): string | null {
  try { return runningIn(projectId, liveRuns.all().map((r) => r.session)); } catch { return null; }
}

/** BL-70: a document converted for download (web page, Word or PDF), always as an attachment. */
async function sendExport(res: ServerResponse, abs: string, format: string): Promise<void> {
  try {
    const out = await exportDoc(abs, readFileSync(abs, 'utf8'), format);
    res.writeHead(200, { ...fileHeaders(out.filename, out.body.length, true), 'content-type': out.type });
    res.end(out.body);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

function serveStatic(res: ServerResponse, dir: string, pathname: string): void {
  // SPA: unknown non-asset routes fall back to index.html (client-side routing).
  let rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let file = join(dir, rel);
  // The build's asset paths are relative (base './', for the desktop app), so a page one folder down
  // (a share link, /s/<token>) asks for s/assets/…: drop leading folders until the asset is found.
  for (let parts = rel.split(/[/\\]/); extname(rel) && parts.length > 1 && !existsSync(file);) { parts = parts.slice(1); file = join(dir, ...parts); }
  if (!rel || !existsSync(file) || statSync(file).isDirectory()) {
    if (extname(rel)) { res.writeHead(404); res.end('not found'); return; }
    file = join(dir, 'index.html');
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

// Port precedence: MWA_SERVE_PORT (explicit) → PORT (injected by PaaS like Railway/Render/Fly so
// the platform's router and the app agree) → 7788 (local/Docker default). Honoring PORT means a
// cloud deploy binds the platform's expected port automatically — no manual port var needed.
export async function runServe(port = Number(process.env.MWA_SERVE_PORT ?? process.env.PORT ?? 7788)): Promise<void> {
  setReceiptProducer('serve'); // BL-13: this process's own delivery receipts file
  setTranscriptProducer('serve'); // BL-10: and its own run transcripts
  // What this process stages, it owns: its memory identity (BL-18). Approvals for it made in Telegram
  // run here — swept independently of the scheduler, so it works with no model configured too.
  setApprovalOwner(SERVE_AGENT);
  // BL-62: what a setup card checks against and saves to (the agent starts it; the person fills it here).
  setSetupDeps({
    save: (v) => upsertEnv(v),
    gmailConnected: () => gmailImapConfigured() || googleConfigured(),
    checkGmail: verifyGmailImap,
    outlookConnected: microsoftConfigured,
    outlookAppReady: microsoftClientReady,
    startOutlookDeviceCode: () => startMicrosoftDeviceCode(false),
    telegramConnected: () => !!process.env.TELEGRAM_BOT_TOKEN,
    checkTelegram: testTelegram,
  });
  setInterval(() => {
    void runApproved().then((done) => {
      for (const r of done) appendNotification({ ts: Date.now(), instruction: `Approved in Telegram: ${r.tool}`, summary: r.result.slice(0, 2000), reason: 'done', outcome: r.ok ? 'changed' : 'could-not' });
    }).catch(() => { /* best-effort */ });
  }, 15_000).unref();

  loadEnv();
  // v2 (W5): what Settings saved that the server reads from the environment (time zone, mail sorting, the per-fire
  // limit), unless the deployment set it — before the calendar, mail and triage loops start.
  applyStoredSettings();

  // THE INBOX (BL-06): drop an instruction file (*.md / *.txt) into <workspace>/inbox and MWA works it
  // unattended — in Docker, /data/mwa-workspace/inbox — writes outbox/<id>.md, and posts the result to
  // the chat. It runs as this app (its memory, its approvals panel), unattended, so every hard gate
  // applies. On by default; MWA_INBOX=0 turns it off (read after loadEnv, so /data/.env works too).
  if (process.env.MWA_INBOX !== '0') {
    try {
      const icfg = loadConfig();
      const inboxDir = mailboxDirs(icfg.workspace ?? './mwa-workspace').inbox;
      console.log(`  📥 inbox on — drop instruction files (.md / .txt) in ${inboxDir}`);
      void watchInbox({
        config: icfg, dbPath: dbFile(), agentId: SERVE_AGENT,
        intervalMs: Number(process.env.MWA_INBOX_POLL_MS ?? 5_000),
        onLog: (m) => logger.info('inbox', m),
        onDone: (r) => appendNotification({
          ts: Date.now(), instruction: `📥 Inbox · ${r.instruction.slice(0, 120)}`, summary: r.summary, reason: r.reason, outcome: r.outcome,
          steps: r.steps, toolCalls: r.toolCalls, costUsd: r.costUsd, durationMs: r.durationMs, files: r.files, dir: r.dir,
        }),
      });
    } catch (e) { logger.error('inbox', 'not started', { error: (e as Error).message.slice(0, 100) }); }
  }
  const ui = uiDir();
  // v2 (A3a): what /api/v1/jobs needs from this server — a memory store per request, the live runs, the approvals
  // waiting, and the existing schedule and goal controls.
  setJobRouteDeps({
    memory: () => new MwaMemory(SERVE_AGENT, dbFile(), loadConfig().awm.workspace),
    running: () => new Set(liveRuns.all().map((r) => r.session)),
    stopLive: (key) => liveRuns.stop(key),
    pendingApprovals: () => new Set(listPendingActions().map((a) => a.id)),
    scheduleControl: async (person, action, id) => {
      const m = new MwaMemory(SERVE_AGENT, dbFile(), loadConfig().awm.workspace);
      try { return await scheduleControl(m, person, action, { id }); } finally { m.close(); }
    },
    continueGoal: async (goalId, personId) => {
      const m = new MwaMemory(SERVE_AGENT, dbFile(), loadConfig().awm.workspace);
      try { return await continueGoal(m, { goalId, personId, workspace: loadConfig().workspace ?? './mwa-workspace', holdsReservation: true }); } finally { m.close(); }
    },
  });
  // v2 (A5): the conversations kept before Projects move into General's thread, once, before anything is answered
  // (synchronous: a turn written meanwhile would land beside them). The old log is only read.
  // Review of A5: incremental (it picks up lines an older build appended since), streamed in batches, and in the
  // background — /meta and /projects say "Importing older conversations…" while it runs. Then the turns a crashed
  // process left `running` are marked interrupted.
  void importConversations({ file: conversationsPath() })
    .then((conv) => { if (conv.lines || conv.badLines) logger.info('v2', describeConversationsReport(conv)); })
    .catch((e) => logger.error('v2', 'importing older conversations failed (it continues from where it stopped at the next start)', { error: (e as Error).message.slice(0, 200) }))
    .finally(() => { try { interruptStaleRunning(SERVER_START, new Set(liveRuns.all().map((r) => r.runId))); } catch { /* */ } });
  setProjectRouteDeps({
    workspace: () => resolve(loadConfig().workspace ?? './mwa-workspace'),
    startChat: startProjectChat,
    // what the server carried for both threads (and the older conversation it left) is read again on their next run
    onTurnMoved: (from, to, legacy) => { sessions.delete(sessionOf(from)); sessions.delete(sessionOf(to)); if (legacy) sessions.delete(legacy); },
    live: (projectId) => { const s = liveSessionOf(projectId); return s ? { session: s, run: liveRuns.describe(s) } : null; },
    stop: (projectId) => { const s = liveSessionOf(projectId); return s ? liveRuns.stop(s) : false; },
    steer: (projectId, text) => { const s = liveSessionOf(projectId); return s ? liveRuns.steer(s, text) : false; },
    attach: (projectId, fn) => { const s = liveSessionOf(projectId); return s ? liveRuns.attach(s, fn) : null; },
    finalEvents: FINAL_EVENTS,
    acceptOffer: acceptProjectOffer,
  });
  // v2 (A6): /ask — the background hand-off on the background tier, the mail reader for an ask about an email, the
  // models (the background tier is priced by its list price), and the cheap model that proposes one narrower ask.
  setAskRouteDeps({
    workspace: () => resolve(loadConfig().workspace ?? './mwa-workspace'),
    startBackground: async (projectId, o) => {
      if (MEMORY_OFF) return null;
      const cfg = loadConfig();
      const memory = new MwaMemory(SERVE_AGENT, dbFile(), cfg.awm.workspace);
      try {
        const personId = resolvePersonId({ channel: 'web', name: (o.person ?? '').trim() || undefined });
        const started = await startBackgroundWork(memory, { message: o.message, session: sessionOf(projectId), personId, workspace: cfg.workspace ?? './mwa-workspace', capUsd: o.capUsd, modelTier: 'background',
          ...(o.attachments ? { attachments: o.attachments } : {}),
          // a model's suggested focus goes as fenced context, and the job starts tainted
          ...(o.suggestedFocus ? { context: { text: o.suggestedFocus, tainted: true } } : {}) });
        return started?.v2JobId ? { jobId: started.v2JobId, goalId: started.goalId } : null;
      } finally { memory.close(); }
    },
    mailBody: async (account, providerId) => (await openMail(account, providerId)).body.text,
    models: () => { try { const m = loadConfig().models; return { fetch: m.fetch, background: m.background }; } catch { return null; } },
  });
  // (A6 review) on the background tier, and only when it fits a 1¢ ledger: a model that would cost more is not asked
  setNarrowModel(async (input) => {
    const { system, user } = narrowPrompt(input);
    return backgroundCalls.run(true, async () => {
      const provider = getProvider('brain');
      if (!narrowAffordable(provider.model, { system, user })) return null;
      const ledger = newLedger({ cap: NARROW_CAP_USD });
      const out = await withLedger(ledger, () => metered(provider).chat({ system, messages: [{ role: 'user', content: user }], maxTokens: 200, reasoningEffort: 'minimal' }));
      const j = firstJson(out.text ?? '');
      return j ? { label: String(j.label ?? '') } : null;
    });
  });
  // v2 (A4): the live stream and /sync compute job views with the same running runs and waiting approvals.
  setStreamDeps({ running: () => new Set(liveRuns.all().map((r) => r.session)), pending: () => new Set(listPendingActions().map((a) => a.id)) });
  // v2 (A7): keep the calendar cache fresh — shortly after start, then every 30 minutes (no model calls). The app
  // also asks for a refresh when it opens (POST /api/v1/calendar/refresh). MWA_CALENDAR_SYNC=0 turns it off.
  startCalendarSync();
  // v2 (A9): the Important list — triage after each mail sync, double-bookings after each calendar sync, the derived
  // sources (job results, approvals, reconnects) every minute. No model configured: rules and bulk-mail signs only.
  startImportant({ memory: () => new MwaMemory(SERVE_AGENT, dbFile(), loadConfig().awm.workspace), running: () => new Set(liveRuns.all().map((r) => r.session)) });
  // v2 (A10): Today composes the slices above (what the helper did comes from app.db `actions`). No model calls.
  setTodayDeps({
    running: () => new Set(liveRuns.all().map((r) => r.session)),
    pendingApprovals: () => listPendingActions(),
  });
  // v1 answers for itself: the password session, this machine (no password), or a paired device (src/api/auth.ts).
  // v2 (A3a review): existing goals, scheduled tasks and results become Jobs and Tries once, at server start, with or
  // without a model (the scheduler starts only with one), and Tries a crashed process left running are reaped. The
  // first /api/v1 request waits for it (at most 15 s; the slow reads happen before its short transaction).
  // v2 (A3b review, M7): read the run history once now, off any request, so estimates never parse logs inline.
  { const t = setTimeout(() => { try { historyStats(); } catch { /* estimates fall back to the default */ } }, 2_000); t.unref?.(); }
  v2Ready = MEMORY_OFF ? Promise.resolve() : (async () => {
    reapDeadTries();
    const m = new MwaMemory(SERVE_AGENT, dbFile(), loadConfig().awm.workspace);
    try {
      const report = await migrateV2Once(m, { notifyFile: notifyPath(), runsFile: runLogPath() });
      if (report) logger.info('v2', `jobs migration: ${describeReport(report).replace(/\n/g, ' | ')}`);
    } catch (e) { logger.error('v2', 'jobs migration failed (it is tried again at the next start)', { error: (e as Error).message.slice(0, 200) }); }
    finally { m.close(); }
  })();
  const authenticate = makeAuthenticate({ passwordSet: !!ACCESS_PW, sessionValid: authed });
  const v1 = createV1Handler({ authenticate, sameOrigin: sameOriginOk });
  // v2 (W5): sign-in, Settings and Connect for the v2 app use the server's own password, session and sign-in flows.
  setSettingsRouteDeps({
    passwordSet: () => !!ACCESS_PW,
    checkPassword: (pw) => !!ACCESS_PW && secretEquals(pw, ACCESS_PW),
    connections: () => ({
      googleClient: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET, gmailAppPassword: gmailImapConfigured(),
      googleConnected: googleConfigured() || gmailImapConfigured(),
      outlookDeviceCode: microsoftClientReady(), microsoftClient: !!process.env.MICROSOFT_CLIENT_ID, outlookConnected: microsoftConfigured(),
    }),
    startGoogle: () => startGmailConnect(false),
    startOutlookDeviceCode: () => startMicrosoftDeviceCode(false),
    startOutlook: () => startMicrosoftConnect(false),
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;

      // The agent browser may never talk to MWA itself (review 2026-10-25, F01: a public page's redirect reached
      // /api/chat on 127.0.0.1 through the browser and started a run). Its every request carries this header.
      if (req.headers[AGENT_BROWSER_HEADER]) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'the agent browser may not call MWA' })); return; }

      // W5 security review (5): the Host must be one this server answers to — DNS rebinding sends the attacker's name.
      // The liveness probe is exempt (a platform's health check may use any name; it says only ok/db to strangers).
      if (p !== '/api/health' && !hostAllowed(req)) {
        res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`This helper doesn't answer to "${String(req.headers.host ?? '').slice(0, 80)}". Add the name to MWA_ALLOWED_HOSTS if it is yours.`);
        return;
      }

      // Signing in with the password (the legacy page's form): the same throttle and session record as /api/v1/session.
      if (p === '/api/login' && req.method === 'POST') {
        if (!ACCESS_PW) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'No password is set on this helper.' })); return; }
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const cookie = typeof b.password === 'string' ? await signInWithPassword(req, b.password, (pw) => secretEquals(pw, ACCESS_PW), 'legacy-login') : null;
        if (cookie) { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie }); res.end(JSON.stringify({ ok: true })); }
        else { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'Wrong password.' })); }
        return;
      }

      // Pages with a password set: the lock page unless signed in. /api/health is the LIVENESS probe (2026-10-14: with
      // a password it answered 401 and the container sat "unhealthy"). BL-70: a share link opens one file for whoever
      // holds it. v2 (W5): the app's page loads for /pair, the v2 app and a paired device, so they can show their own
      // sign-in and pairing screens (src/api/legacy.ts). Every /api route checks its own callers below.
      if (ACCESS_PW && !p.startsWith('/api/') && !authed(req)) {
        const shared = p.startsWith('/s/') || p.startsWith('/assets/') || signedOutPageAllowed(p, url.search, hasValidDeviceCookie(req));
        if (!shared) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN_HTML); return; }
      }

      // W5 security review (6): every legacy /api route takes the same callers as /api/v1 — the password session, this
      // machine (as trust.ts defines it), or a paired device with the scope the route needs — password or not.
      // /api/v1 and /api/files answer for themselves; health, login and share links are public (legacyApiScope).
      if (p.startsWith('/api/') && p !== '/api/v1' && !p.startsWith('/api/v1/') && p !== '/api/files' && !p.startsWith('/api/files/')) {
        const need = legacyApiScope(req.method ?? 'GET', p);
        if (need !== 'public') {
          const who = authenticate(req);
          if (!who) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'locked', message: 'Sign in to continue.' })); return; }
          if (!who.scopes.has(need)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden', message: 'This device is not allowed to do that. Use the app on your computer, or sign in with the password.' })); return; }
        }
      }

      // v2 client API: its own route table (src/api/v1.ts); everything under /api/v1 is answered there.
      if (p === '/api/v1' || p.startsWith('/api/v1/')) {
        await Promise.race([v2Ready, new Promise((r) => { setTimeout(r, 15_000).unref?.(); })]);
        if (await v1(req, res)) return;
      }

      if (p === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        // BL-23: how the configured brain fared against planted instructions, for the model settings.
        // The stronger model is reported too when it is a different one: it reads the same content.
        let modelNote: ReturnType<typeof injectionNote> | null = null, reasonNote: ReturnType<typeof injectionNote> | null = null;
        try { const m = loadConfig().models; modelNote = injectionNote(m.fetch); if (m.reason !== m.fetch) reasonNote = injectionNote(m.reason); } catch { /* no config yet */ }
        res.end(JSON.stringify({ ...status(), gmail: googleConfigured() || gmailImapConfigured(), outlook: microsoftConfigured(), modelNote, reasonNote }));
        return;
      }
      // Open an external link in the OS browser. The desktop (Tauri) webview swallows
      // target="_blank", so the UI routes external links here when running in the app.
      if (p === '/api/open' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const u = String(b.url ?? '');
        const ok = /^https?:\/\//i.test(u);
        if (ok) openBrowser(u);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok }));
        return;
      }
      // List a provider's available models for the onboarding picker (B). GET ?provider=… uses the
      // saved key; POST {provider,key,baseUrl} lists with a not-yet-saved key (so the dropdown can
      // populate during setup; OpenRouter lists even with no key). Best-effort → [] on error.
      if (p === '/api/models') {
        const urlq = new URL(req.url ?? '/', 'http://localhost').searchParams;
        let provider = (urlq.get('provider') ?? '').trim();
        let kind: 'chat' | 'image' = urlq.get('kind') === 'image' ? 'image' : 'chat';
        let key: string | undefined;
        let baseUrl: string | undefined;
        if (req.method === 'POST') {
          const b = await readBody(req);
          provider = String(b.provider ?? provider).trim();
          if (b.kind === 'image') kind = 'image';
          key = b.key ? String(b.key) : undefined;
          baseUrl = b.baseUrl ? String(b.baseUrl) : undefined;
        }
        const models = provider ? await listModels(provider, { key, baseUrl, kind }) : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ provider, models, providers: PROVIDERS }));
        return;
      }
      // First-run setup (A): warm the local memory models. The first embed downloads the
      // recall models (~500MB) on a fresh machine — do it here as an explicit one-time step
      // (onboarding shows a "preparing…" screen) instead of letting the first chat hang.
      // Returns quickly when the models are already cached. Best-effort.
      if (p === '/api/setup/warm' && req.method === 'POST') {
        let ready = false; let message = '';
        try {
          const emb = await loadEmbeddings();
          await emb.embed('warm up');
          ready = true;
        } catch (e) { message = (e as Error).message.slice(0, 160); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ready, message }));
        return;
      }
      if (p === '/api/suggestions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ suggestions: SUGGESTIONS }));
        return;
      }
      // F07 (usability review 2026-10-24): what MWA can read for this chat — the person's granted folders (with a
      // capped file count, and whether each still exists) and the files added to the chat — for an "I can read"
      // line above the input, where the review found the granted folder listed only at the foot of Connect.
      // Settings in one place (interface slice 2026-10-25, D5): saved logins (names only) with Forget, and quiet hours.
      if (p === '/api/vault' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ entries: vaultRows() }));
        return;
      }
      if ((p === '/api/vault/forget' || p === '/api/quiet') && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(p === '/api/quiet' ? setQuiet(String(b.value ?? '')) : forgetVaultEntry(String(b.name ?? ''))));
        return;
      }
      if (p === '/api/quiet' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(quietState()));
        return;
      }
      // Billing and token tracking (Robert, 2026-10-27): the month so far, the last 30 days, by model, the costliest
      // conversations and jobs, the budget, and the provider's own balance; the calls as CSV; the budget setting.
      if (p === '/api/billing' && req.method === 'GET') {
        const calls = readCalls(undefined, Math.min(monthStart(Date.now()), Date.now() - 30 * 86_400_000));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(billingSummary(calls, Date.now(), undefined, undefined, await providerBalance())));
        return;
      }
      if (p === '/api/billing.csv' && req.method === 'GET') {
        const days = Math.max(1, Math.min(366, Number(url.searchParams.get('days') ?? 30) || 30));
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="mwa-model-calls-${days}d.csv"`, 'cache-control': 'no-store' });
        res.end(callsCsv(readCalls(undefined, Date.now() - days * 86_400_000)));
        return;
      }
      if (p === '/api/billing/budget' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(setMonthlyBudget(String(b.value ?? ''))));
        return;
      }
      // Pending list 2026-10-26, 5c: the person removes a standing preference from its card or the Memory view
      // directly — their own click, the same authority as Forget on a memory — instead of asking the chat for a
      // policy_forget card. Every engram carrying the rule goes (removePolicy), or the rule stays in force.
      if (p === '/api/policies/forget' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const rule = String(b.rule ?? '').slice(0, 600);
        let removed = 0;
        try { const m = new MwaMemory(SERVE_AGENT, dbFile()); removed = await m.removePolicy(rule); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: removed > 0, removed, message: removed > 0 ? 'Removed. It no longer applies to new tasks.' : 'No standing preference with those words was found.' }));
        return;
      }
      if (p === '/api/sources') {
        const session = String(url.searchParams.get('session') ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
        const ws = resolve(loadConfig().workspace ?? './mwa-workspace');
        const folders = grantedFolders(session ? resolve(ws, 'serve', session) : ws);
        const added = session ? uploadsIn(ws, sessionFolder(session)) : [];
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ preset: accessPolicy().preset, folders, added }));
        return;
      }
      if (p === '/api/stats') {
        const dbPath = dbFile();
        let memories = 0;
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); memories = await m.memoryCount(); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ memories }));
        return;
      }
      if (p === '/api/memories') {
        const dbPath = dbFile();
        let memories: Awaited<ReturnType<MwaMemory['recentMemories']>> = [];
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); memories = await m.recentMemories(40); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ memories }));
        return;
      }
      // F1 Glass Box — "what I did" history (the side-effecting action log).
      if (p === '/api/actions') {
        const dbPath = dbFile();
        let actions: Awaited<ReturnType<MwaMemory['recentActions']>> = [];
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); actions = await m.recentActions(40); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ actions }));
        return;
      }
      // F1 Glass Box — export everything MWA knows as portable Markdown ("it's yours").
      if (p === '/api/memory/export') {
        const dbPath = dbFile();
        let md = '# What MWA knows about you\n';
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); md = await m.exportMarkdown(); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="mwa-memory.md"' });
        res.end(md);
        return;
      }
      // F1 Glass Box — PRIVACY: forget (hard-delete) a single memory.
      if (p === '/api/memory/forget' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const dbPath = dbFile();
        let ok = false;
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); ok = await m.forget(String(b.id ?? '')); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok }));
        return;
      }
      // F1 Glass Box — correct a fact: supersede with the user's text (provenance=user → trusted).
      if (p === '/api/memory/correct' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const dbPath = dbFile();
        let ok = false; let id: string | null = null;
        try {
          const m = new MwaMemory(SERVE_AGENT, dbPath);
          const concept = String(b.concept ?? '').slice(0, 80);
          const content = String(b.content ?? '').trim();
          if (b.id && content) { id = await m.correctFact(String(b.id), concept, content); ok = !!id; }
          m.close();
        } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok, id }));
        return;
      }
      // Onboarding wizard — scan the folders/files the user points at into candidate memories.
      // Pointing MWA at a folder in the setup wizard is explicit consent to read it, so we grant
      // read access to those folders first (same-origin only). Nothing is saved here.
      if (p === '/api/onboard/scan' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const paths: string[] = Array.isArray(b.paths) ? b.paths.map(String).filter(Boolean) : [];
        try {
          const pol = accessPolicy();
          const dirs = paths.map((p2) => { const abs = resolve(p2); try { return statSync(abs).isDirectory() ? abs : dirname(abs); } catch { return null; } }).filter((x): x is string => !!x);
          if (dirs.length) setAccess(pol.preset, [...new Set([...pol.grantedRoots, ...dirs])]);
        } catch { /* grant is best-effort */ }
        let result: { candidates: unknown[]; filesScanned: number; truncated: boolean } = { candidates: [], filesScanned: 0, truncated: false };
        try { result = await scanSources(resolve('.'), paths); } catch (e) { logger.error('onboard', 'scan failed', { error: (e as Error).message.slice(0, 200) }); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }
      // Onboarding wizard — save the memories the user confirmed. Owner-provided → trusted + canonical.
      if (p === '/api/onboard/save' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const items: { concept?: string; content?: string; tags?: string[] }[] = Array.isArray(b.memories) ? b.memories : [];
        const dbPath = dbFile();
        let saved = 0;
        try {
          const m = new MwaMemory(SERVE_AGENT, dbPath);
          for (const it of items) {
            const concept = String(it.concept ?? '').trim().slice(0, 120);
            const content = String(it.content ?? '').trim();
            if (!concept || content.length < 4) continue;
            const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
            const id = await m.write(concept, content, [...tags, 'src=onboarding', 'intent=context'], { provenance: 'user', ownName: true, canonical: true, origin: 'onboarding' });
            if (id) saved++;
          }
          m.close();
        } catch (e) { logger.error('onboard', 'save failed', { error: (e as Error).message.slice(0, 200) }); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved }));
        return;
      }
      // The person's scheduled jobs, with ids and state, and the controls on them (F04, 2026-10-24: the list had no
      // ids and no controls, and a watch could not be stopped from the app). `scheduled` keeps the old shape plus
      // the new fields, so the Log tab's list still renders.
      if (p === '/api/schedule' && req.method === 'GET') {
        const me = resolvePersonId({ channel: 'web', name: String(url.searchParams.get('person') ?? '').trim() || undefined });
        let scheduled: unknown[] = [];
        if (!MEMORY_OFF) { const m = new MwaMemory(SERVE_AGENT, dbFile(), loadConfig().awm.workspace); try { scheduled = await scheduleRows(m, me); } catch { /* */ } finally { m.close(); } }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ scheduled }));
        return;
      }
      if (/^\/api\/schedule\/(cancel|uncancel|pause|resume|update)$/.test(p) && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const action = p.split('/').pop() as ScheduleAction;
        res.writeHead(200, { 'content-type': 'application/json' });
        if (MEMORY_OFF) { res.end(JSON.stringify({ ok: false, message: 'Memory is off here, so there are no scheduled jobs.' })); return; }
        const me = resolvePersonId({ channel: 'web', name: String(b.person ?? '').trim() || undefined });
        const m = new MwaMemory(SERVE_AGENT, dbFile(), loadConfig().awm.workspace);
        try {
          const out = await scheduleControl(m, me, action, b);
          logger.info('schedule', `${action} ${out.ok ? 'ok' : 'refused'}: ${String(b.id ?? '').slice(0, 8)} — ${out.message.slice(0, 120)}`);
          res.end(JSON.stringify(out));
        } finally { m.close(); }
        return;
      }
      if (p === '/api/notifications') {
        const np = notifyPath();
        const since = Number(url.searchParams.get('since') ?? 0);
        let notifications: any[] = [];
        try { notifications = readFileSync(np, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((n: any) => Number(n.ts) > since).slice(-20); } catch { /* none yet */ }
        // BL-70: where a run's files sit, relative to the workspace, so the card can link them.
        const wsRoot = resolve(loadConfig().workspace ?? './mwa-workspace');
        for (const n of notifications) {
          if (typeof n?.dir !== 'string' || !n.dir) continue;
          const rel = relative(wsRoot, resolve(n.dir)).split(sep).join('/');
          if (rel && !rel.startsWith('..') && !isAbsolute(rel)) n.folder = rel;
        }
        // BL-13: a scheduled result handed to a signed-in browser is `served` — recorded once per fire.
        // (Served, not read: an open tab polls whether anyone is looking.)
        for (const n of notifications) {
          if (typeof n?.fire !== 'string' || typeof n?.job !== 'string') continue;
          if (!servedFires) servedFires = new Set(readReceipts().filter((r) => r.channel === 'app' && r.status === 'served').map((r) => r.fire));
          if (servedFires.has(n.fire)) continue;
          servedFires.add(n.fire);
          recordReceipt({ job: n.job, fire: n.fire, channel: 'app', status: 'served' });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ notifications }));
        return;
      }
      if (p === '/api/runs') {
        const logp = runLogPath();
        let runs: any[] = [];
        try {
          runs = readFileSync(logp, 'utf8').trim().split('\n').slice(-60).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
        } catch { /* no log yet */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runs }));
        return;
      }
      // Operational health — for the Docker/NAS healthcheck and operators. 503 if the DB
      // (the substrate) is unreachable; reports scheduler liveness + load.
      if (p === '/api/health') {
        const dbPath = dbFile();
        let memoryCount = -1, db = false;
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); memoryCount = await m.memoryCount(); m.close(); db = true; } catch { /* db down */ }
        const schedulerLastTickAgoSec = lastSchedulerTick ? Math.round((Date.now() - lastSchedulerTick) / 1000) : -1;
        // v2 (A3a): scheduler runs count too (they run under job_<id>); before, a background job ran while this said 0.
        const schedulerRuns = liveRuns.all().filter((r) => r.session.startsWith('job_')).length;
        const full = { ok: db, uptimeSec: Math.round((Date.now() - SERVER_START) / 1000), db, memoryCount, activeRuns: activeRuns + schedulerRuns, chatRuns: activeRuns, schedulerRuns, sessions: sessions.size, schedulerLastTickAgoSec };
        // Locked + not signed in: the probe still gets its verdict (and the 503 when the DB is
        // down, which is the whole point of the check), but not the operational detail.
        const body = authenticate(req) ? full : { ok: db, db };
        res.writeHead(db ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      // Recent structured logs (newest first) — operator visibility into why runs/scheduler/MCP failed.
      if (p === '/api/logs') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const level = (url.searchParams.get('level') as LogLevel) || undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ logs: readLogs({ since, limit: 100, level }) }));
        return;
      }
      // Pending approvals — the ONLY place the app approves anything (BL-03): the model can stage an
      // action but not approve it; the person approves or declines it here (the chat's approvals panel).
      if (p === '/api/approvals' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ pending: listPendingActions(), recent: recentApprovalOutcomes(), auto: recentAutoApproved() }));
        return;
      }
      if (p === '/api/approvals/confirm' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        // An explicit id only: a person approves the card they are looking at, never "the latest".
        // The action runs in the context it was staged in (BL-03), so the ctx here only gates.
        if (!b.id) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'which approval? (id is required)' })); return; }
        const out = await confirmPending(String(b.id), { sandboxDir: resolve('.'), interactive: true });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: out.startsWith('[CONFIRMED'), message: out }));
        return;
      }
      // BL-70: what a share link opens — that one file, read-only: its name, its bytes, its exports.
      if (p.startsWith('/api/share/') && req.method === 'GET') {
        const [, , , token, what] = p.split('/');
        const hit = shareFor(resolve(loadConfig().workspace ?? './mwa-workspace'), token ?? '');
        if (!hit) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'This link has expired or was turned off.' })); return; }
        if (what === 'raw') { res.writeHead(200, fileHeaders(hit.abs, statSync(hit.abs).size, url.searchParams.get('download') === '1')); createReadStream(hit.abs).pipe(res); return; }
        if (what === 'export') { await sendExport(res, hit.abs, url.searchParams.get('format') ?? ''); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ name: hit.share.path.split('/').pop(), size: statSync(hit.abs).size, expires: hit.share.expires, formats: exportFormats(hit.abs) }));
        return;
      }
      // BL-70: the person's files — what MWA wrote under the workspace, and what they added. W5: the same callers as
      // /api/v1 (the session, this machine, a paired device with the scope), password or not (src/api/legacy.ts).
      if (p === '/api/files' || p.startsWith('/api/files/')) {
        await handleLegacyFiles(req, res, url, { root: () => resolve(loadConfig().workspace ?? './mwa-workspace'), authenticate, sameOrigin: sameOriginOk, sendExport });
        return;
      }
      // BL-71d: conversations to go back to, from any device.
      if (p === '/api/conversations' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ conversations: listConversations(40) }));
        return;
      }
      if (p === '/api/conversation' && req.method === 'GET') {
        const session = String(url.searchParams.get('session') ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ session, folder: sessionFolder(session), turns: session ? readConversation(session, 80) : [] }));
        return;
      }
      // BL-71e: welcome back — what moved while the person was away. No model call: results that came in, goals
      // whose record changed, what MWA thought about, approvals waiting.
      if (p === '/api/welcome' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0) || Date.now() - 24 * 3_600_000;
        res.writeHead(200, { 'content-type': 'application/json' });
        const np = notifyPath();
        let results: { title: string; session?: string; outcome?: string }[] = [];
        try { results = readFileSync(np, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((n: any) => n && Number(n.ts) > since).slice(-10).map((n: any) => ({ title: String(n.title ?? n.instruction ?? '').slice(0, 120), session: n.session, outcome: n.outcome })); } catch { /* none */ }
        let goals: { id: string; title: string; state: string; conv?: string }[] = [];
        if (!MEMORY_OFF) {
          const cfg = loadConfig();
          const memory = new MwaMemory(SERVE_AGENT, dbFile(), cfg.awm.workspace);
          try {
            const [all, records] = await Promise.all([memory.listGoals(), memory.listGoalRecords()]);
            const me = resolvePersonId({ channel: 'web', name: String(url.searchParams.get('person') ?? '').trim() || undefined });
            goals = records.filter((r) => r.at > since).map((r) => {
              const g = all.find((x) => x.id === r.goalId);
              const state = r.trust === 'untrusted' ? '(noted after reading outside content — open the Work view)' : (r.text.split('\n')[0] ?? '').replace(/^Where we are on "[^"]*" \(goal [^)]*\): /, '').slice(0, 220);
              return g && g.status !== 'done' && (!g.person || g.person === me) ? { id: g.id.slice(0, 8), title: g.title, state, conv: r.conv } : null;
            }).filter((x) => x !== null).slice(0, 6) as { id: string; title: string; state: string; conv?: string }[];
          } finally { memory.close(); }
        }
        // Only questions, only from notes MWA can stand behind, only this person's (BL-71e review).
        const me = resolvePersonId({ channel: 'web', name: String(url.searchParams.get('person') ?? '').trim() || undefined });
        const thoughts = readThoughts().filter((t) => t.at > since && t.goalId && t.kind === 'ask' && !t.untrusted && (!t.person || t.person === me)).slice(-6).map((t) => ({ title: t.title, kind: t.kind, text: t.text }));
        res.end(JSON.stringify({ since, results, goals, thoughts, approvals: listPendingActions().length }));
        return;
      }
      // BL-71d: the Work view — every goal, where it stands, what it waits on.
      if (p === '/api/work' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (MEMORY_OFF) { res.end(JSON.stringify({ goals: [] })); return; }
        const cfg = loadConfig();
        const memory = new MwaMemory(SERVE_AGENT, dbFile(), cfg.awm.workspace);
        try {
          const me = resolvePersonId({ channel: 'web', name: String(url.searchParams.get('person') ?? '').trim() || undefined });
          const [goals, records, jobs] = await Promise.all([memory.listGoals(), memory.listGoalRecords(), memory.pendingScheduled()]);
          const ws = resolve(cfg.workspace ?? './mwa-workspace');
          const rel = (f: string) => { const r = relative(ws, resolve(f)).split(sep).join('/'); return r.startsWith('..') || isAbsolute(r) ? null : r; };
          const thoughts = latestThoughts(); // BL-71e
          res.end(JSON.stringify({ goals: goals.filter((g) => !g.person || g.person === me).map((g) => {
            const rec = records.find((r) => r.goalId === g.id);
            const files = rec ? [...rec.text.matchAll(/^Files: (.*)$/gm)].flatMap((m) => m[1].split(', ')).map(rel).filter(Boolean) : [];
            return { id: g.id.slice(0, 8), title: g.title, status: g.status, priority: g.priority, createdAt: g.createdAt,
              jobs: jobs.filter((t) => t.goal === g.id).length,
              record: rec ? { text: rec.text, at: rec.at, by: rec.by, conv: rec.conv, untrusted: rec.trust === 'untrusted', files } : null,
              thought: (() => { const t = thoughts.get(g.id); return t && (!rec || t.at >= rec.at) ? { kind: t.kind, text: t.text, at: t.at, untrusted: t.untrusted === true } : null; })() };
          }) }));
        } finally { memory.close(); }
        return;
      }
      if ((p === '/api/work/continue' || p === '/api/work/status') && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (MEMORY_OFF) { res.end(JSON.stringify({ ok: false, message: 'Memory is off here.' })); return; }
        const cfg = loadConfig();
        const memory = new MwaMemory(SERVE_AGENT, dbFile(), cfg.awm.workspace);
        try {
          const me = resolvePersonId({ channel: 'web', name: String(b.person ?? '').trim() || undefined });
          const goal = await memory.getGoal(String(b.goal ?? ''));
          if (!goal || (goal.person && goal.person !== me)) { res.end(JSON.stringify({ ok: false, message: 'No such goal.' })); return; }
          if (p.endsWith('/status')) {
            const status = String(b.status ?? '');
            if (!['open', 'in_progress', 'blocked', 'done'].includes(status)) { res.end(JSON.stringify({ ok: false, message: 'Unknown status.' })); return; }
            await personAction(() => memory.setGoalStatus(goal.id, status as 'open' | 'in_progress' | 'blocked' | 'done')); // the person's own tap (v2 review M8)
            res.end(JSON.stringify({ ok: true, message: status === 'done' ? 'Marked done. Its jobs stop.' : status === 'blocked' ? 'Paused. Its jobs wait.' : 'Updated.' }));
            return;
          }
          // v2 (A3b review, M6): this older Continue sets the goal's Job a spending limit too — the one asked for
          // (capUsd), else the default policy — so it is not a way around the limit the job stopped at.
          let undoCap: (() => void) | undefined;
          const gj = jobByGoal(goal.id);
          if (gj && !busyReason(gj.id)) {
            try { undoCap = setCap(gj, capFor(b, viewJob(gj, { running: new Set(), pending: new Set() }), 'continue')); }
            catch (e) { res.end(JSON.stringify({ ok: false, message: (e as Error).message })); return; }
          }
          const c = await continueGoal(memory, { goalId: goal.id, personId: me, workspace: cfg.workspace ?? './mwa-workspace' });
          if (!c || c.already) undoCap?.();
          res.end(JSON.stringify(c ? { ok: true, session: c.session, message: c.already ? "I'm already on it. The result will appear in its conversation." : "Picking it up now. I'll post the result in its conversation." } : { ok: false, message: 'That goal is finished. Reopen it first.' }));
        } finally { memory.close(); }
        return;
      }
      // BL-71b: the person tapped "Work on it" — a goal and a job that starts now, in this chat's folder.
      if (p === '/api/work/start' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const message = String(b.message ?? '').trim().slice(0, 4000);
        const session = String(b.session ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 60) || 'default';
        res.writeHead(200, { 'content-type': 'application/json' });
        if (!message) { res.end(JSON.stringify({ ok: false, message: 'Nothing to work on.' })); return; }
        if (MEMORY_OFF) { res.end(JSON.stringify({ ok: false, message: 'Background work needs memory, which is off here.' })); return; }
        const cfg = loadConfig();
        const memory = new MwaMemory(SERVE_AGENT, dbFile(), cfg.awm.workspace);
        try {
          const personId = resolvePersonId({ channel: 'web', name: String(b.person ?? '').trim() || undefined });
          // The turns before it: "look those up and write it up" needs them (BL-71 review). Fenced if any read outside content.
          const recent = (sessions.get(session)?.history ?? []).slice(-3);
          const context = recent.length ? { text: recent.map((h, i) => `(${i + 1}) ${h.instruction.slice(0, 400)} → ${h.summary.slice(0, 600)}`).join('\n'), tainted: recent.some((h) => h.tainted) } : undefined;
          // v2 (A3b): an optional spending limit for the hand-off (the "cap" in its Details): above 0, at most $20.
          const capRaw = typeof b.capUsd === 'number' ? b.capUsd : undefined;
          if (capRaw !== undefined && !(Number.isFinite(capRaw) && capRaw > 0 && capRaw <= 20)) { res.end(JSON.stringify({ ok: false, message: 'A spending limit must be above $0 and at most $20.' })); return; }
          const started = await startBackgroundWork(memory, { message, session, personId, workspace: cfg.workspace ?? './mwa-workspace', context, ...(capRaw !== undefined ? { capUsd: capRaw } : {}) });
          if (started) answerOffer(session, 'background', started.goalId.slice(0, 8), undefined, undefined, message); // the offer turn now says so, on every device
          res.end(JSON.stringify(started
            ? { ok: true, goal: started.goalId.slice(0, 8), message: "On it. I'll work on this in the background and post the result here when it's done. You can close this page." }
            : { ok: false, message: 'I couldn\'t set that up just now. Try again, or ask me to do it here.' }));
        } finally { memory.close(); }
        return;
      }
      // Live runs (F06, F08, F09 — usability review 2026-10-24). `live` says whether this conversation has a run
      // going; `attach` replays its events so far and follows it to the end (a reload re-attaches instead of
      // losing the answer); `stop` is the person's Stop; `steer` queues a message into the run.
      if (p === '/api/chat/live' && req.method === 'GET') {
        const session = String(url.searchParams.get('session') ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ live: session ? liveRuns.describe(session) : null, running: liveRuns.all().length }));
        return;
      }
      if (p === '/api/chat/attach' && req.method === 'GET') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'cross-origin request blocked' })); return; }
        const session = String(url.searchParams.get('session') ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const write = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        let detach: (() => void) | null = null;
        detach = liveRuns.attach(session, (e) => { write(e.type, e.data); if (FINAL_EVENTS.has(e.type)) { detach?.(); clearInterval(hb); res.end(); } });
        if (!detach) { write('gone', { session }); res.end(); return; }
        const hb = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* */ } }, 15_000);
        req.on('close', () => { detach?.(); clearInterval(hb); });
        return;
      }
      if ((p === '/api/chat/stop' || p === '/api/chat/steer') && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const session = String(b.session ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (p.endsWith('/stop')) { const ok = liveRuns.stop(session); res.end(JSON.stringify({ ok, message: ok ? 'Stopping. The step that is running finishes; nothing new starts.' : 'Nothing is running in this conversation.' })); return; }
        const message = String(b.message ?? '').trim().slice(0, 4000);
        if (!message) { res.end(JSON.stringify({ ok: false, message: 'Nothing to add.' })); return; }
        const ok = liveRuns.steer(session, message);
        res.end(JSON.stringify({ ok, message: ok ? 'Added to the running task. It is taken into account from the next step.' : 'Nothing is running in this conversation — send it as a message.' }));
        return;
      }
      if (p === '/api/approvals/cancel' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: cancelPending(String(b.id ?? '')) }));
        return;
      }
      // BL-62: setup cards. The person types a secret here; it is checked and saved, and never shown back or to the model.
      if (p === '/api/setup' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ requests: listSetupRequests().map(({ id, name, howTo, fields, status, message, expiresAt }) => ({ id, name, howTo, fields, status, message, expiresInSec: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) })) }));
        return;
      }
      if ((p === '/api/setup/submit' || p === '/api/setup/cancel') && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const out = p.endsWith('cancel')
          ? { ok: cancelSetupRequest(String(b.id ?? '')), message: 'Closed.' }
          : await submitSetupRequest(String(b.id ?? ''), (b.values && typeof b.values === 'object') ? b.values as Record<string, unknown> : {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      if (p === '/api/questions' && req.method === 'GET') {
        const dbPath = dbFile();
        let questions: { id: string; question: string }[] = [];
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); questions = await m.listOpenQuestions(); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ questions }));
        return;
      }
      if (p === '/api/stepup/issue' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        // S6 v2: issue a step-up challenge for a flagged person, delivering the code OUT-OF-BAND to
        // their validated connection (currently: their authenticated Telegram chat).
        const b = await readBody(req);
        const personId = String(b.personId ?? '');
        const dbPath = dbFile();
        let out: unknown = { ok: false, reason: 'no-factor' };
        try {
          const m = new MwaMemory(SERVE_AGENT, dbPath);
          const profile = await m.recallPersonProfile(personId); m.close();
          if (hasVerifiedFactor(profile)) {
            out = await issueStepUp({ personId, purpose: String(b.purpose ?? 'sensitive-action'), deliver: (code) => deliverStepUpCode(personId, code) });
          }
        } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
        return;
      }
      if (p === '/api/stepup/verify' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(verifyStepUp(String(b.challengeId ?? ''), String(b.code ?? ''))));
        return;
      }
      if (p === '/api/people' && req.method === 'GET') {
        const dbPath = dbFile();
        let people: unknown[] = [];
        try {
          const m = new MwaMemory(SERVE_AGENT, dbPath);
          const rows = await m.listPeople(); m.close();
          people = rows.map((r) => ({ ...r, missing: INTAKE_FIELDS.filter((f) => !r.fields.includes(f.key)).map((f) => f.key) }));
        } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ people }));
        return;
      }
      if (p === '/api/questions' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        if (b.action === 'resolve') {
          resolveOpenQuestionsBg().catch(() => { /* */ }); // background: agent answers them, marks resolved, learns the answers
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Looking into your open questions in the background — check back shortly.' }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'unknown action' }));
        }
        return;
      }
      // BL-12: routines a run proposed — listed for the person, who alone promotes or retires them.
      // Both stores that share this database: the web app's and the Telegram connector's (BL-12 review —
      // a routine proposed in Telegram must be promotable here, into the store its runs recall from).
      if (p === '/api/routines' && req.method === 'GET') {
        const dbPath = dbFile();
        const routines: unknown[] = [];
        for (const agent of ROUTINE_AGENTS) {
          try { const m = new MwaMemory(agent, dbPath); routines.push(...(await m.listRoutines()).map((r) => ({ ...r, agent }))); m.close(); } catch { /* */ }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ routines }));
        return;
      }
      if ((p === '/api/routines/promote' || p === '/api/routines/retire') && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        const dbPath = dbFile();
        let out: { ok: boolean; error?: string } = { ok: false, error: 'not done' };
        const agent = ROUTINE_AGENTS.includes(String(b.agent ?? SERVE_AGENT)) ? String(b.agent ?? SERVE_AGENT) : null;
        if (!agent) out = { ok: false, error: 'unknown store' };
        else try {
          const m = new MwaMemory(agent, dbPath);
          out = p.endsWith('/promote') ? await m.promoteRoutine(String(b.id ?? '')) : await m.retireRoutine(String(b.id ?? ''));
          m.close();
        } catch (e) { out = { ok: false, error: (e as Error).message.slice(0, 120) }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      if (p === '/api/skills') {
        const dbPath = dbFile();
        let skills: { name: string; content: string }[] = [];
        let lessons: { topic: string; content: string }[] = [];
        let policies: string[] = [];
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); skills = await m.listSkills(); lessons = await m.listFriction(); policies = await m.listPolicies(); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ skills, lessons, policies }));
        return;
      }
      if (p === '/api/connections' && req.method === 'GET') {
        const enabled = new Set(enabledConnectorIds());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          gmail: googleConfigured() || gmailImapConfigured(),
          gmailMethod: googleConfigured() ? 'oauth' : (gmailImapConfigured() ? 'app-password' : null),
          outlook: microsoftConfigured(),
          outlookEasy: microsoftClientReady(), // device-code (zero-setup) available
          telegram: !!process.env.TELEGRAM_BOT_TOKEN,
          // 2026-10-23 settings review: the page's wording, and the controls a server cannot use, follow where it runs.
          hosted: isHosted(), host: hostName(),
          modelFromEnv: !!process.env.MWA_MODEL, imageFromEnv: !!process.env.MWA_MODEL_IMAGE, // a Change here is overridden on load
          tailscale: !!process.env.TAILSCALE_AUTHKEY,
          brain:((spec) => { const i = spec.indexOf(':'); return { provider: i > 0 ? spec.slice(0, i) : '', model: i > 0 ? spec.slice(i + 1) : spec }; })(loadConfig().models.fetch || ''),
          imageModel: ((spec) => { const i = spec.indexOf(':'); return { provider: i > 0 ? spec.slice(0, i) : '', model: i > 0 ? spec.slice(i + 1) : spec }; })(loadConfig().models.image || ''),
          externalInstall: externalInstallState(loadConfig()),
          access: accessPolicy(),
          style: loadConfig().style ?? 'guided', // interaction style (independent of access)
          ingestReady: ingestAvailable(), // an email account is connected → "learn about me" can run
          storage: ((b) => ({
            kind: b === 'postgres' ? 'postgres' : b === 'pglite' ? 'pglite' : 'sqlite',
            configured: b === 'postgres' ? !!process.env.AWM_DATABASE_URL : true,
          }))((process.env.AWM_STORE_BACKEND ?? '').toLowerCase()),
          connectors: listConnectors().map((c) => ({
            id: c.id, name: c.name, category: c.category, description: c.description, access: c.access,
            tier: c.tier, source: c.source ?? null, on: enabled.has(c.id),
            secrets: (c.secrets ?? []).map((s) => ({ env: s.env, label: s.label, help: s.help ?? null, optional: !!s.optional, set: !!process.env[s.env] })),
          })),
        }));
        return;
      }
      if (p === '/api/connections' && req.method === 'POST') {
        // CSRF: this POST mutates config (connect/disconnect, save-secret writes arbitrary env).
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        if (b.action === 'enable-connector') {
          const r = enableConnector(String(b.id ?? ''));
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r));
        } else if (b.action === 'disable-connector') {
          disableConnector(String(b.id ?? ''));
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
        } else if (b.action === 'save-secret') {
          const env = String(b.env ?? '').trim(), value = String(b.value ?? '');
          // Only a key a library connector asks for (2026-10-23 settings test: any name was taken, PATH or
          // MWA_ACCESS_PASSWORD included, and written to .env and this process).
          const wanted = new Set(listConnectors().flatMap((c) => (c.secrets ?? []).map((s) => s.env)));
          if (!/^[A-Z0-9_]+$/.test(env) || !value || !wanted.has(env)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'Missing or invalid field.' })); }
          else { upsertEnv({ [env]: value }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: 'Saved.' })); }
        } else if (b.action === 'review-external') {
          // Run the installation-model security review on an npm package (does NOT install).
          const st = externalInstallState(loadConfig());
          if (!st.enabled) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: st.reason })); }
          else {
            try { const report = await reviewConnector(String(b.source ?? '').trim(), loadConfig()); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, report })); }
            catch (e) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: (e as Error).message.slice(0, 160) })); }
          }
        } else if (b.action === 'approve-external') {
          // Human-approved install of a reviewed external package, version-pinned + audited.
          const st = externalInstallState(loadConfig());
          const source = String(b.source ?? '').trim();
          if (!st.enabled) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: st.reason })); }
          else if (!source) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'No package given.' })); }
          else {
            const r = enableExternalNpm(source, b.version ? String(b.version) : undefined);
            try { const lp = installLogPath(); mkdirSync(dirname(lp), { recursive: true }); appendFileSync(lp, JSON.stringify({ ts: Date.now(), id: r.id, name: source, tier: 'approved-external', version: b.version ?? null, verdict: b.verdict ?? null, integrity: b.integrity ?? null }) + '\n'); } catch { /* */ }
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: `Installed ${source}${b.version ? '@' + b.version : ''} — its tools are available on your next message.` }));
          }
        } else if (b.action === 'connect-gmail') {
          if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: 'Add your Google app ID and secret first (the steps above), then connect.' }));
          } else {
            try {
              const url = startGmailConnect(!!b.readonly); // loopback consent; UI opens this + polls status
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, url, message: 'Approve access in the Google window, then come back — I\'ll show as connected.' }));
            } catch (e) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, message: (e as Error).message.slice(0, 160) }));
            }
          }
        } else if (b.action === 'disconnect-gmail') {
          disconnectGoogle();
          removeEnv(['MWA_GMAIL_USER', 'MWA_GMAIL_APP_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: 'Gmail disconnected — its sign-in was removed from this computer.' }));
        } else if (b.action === 'disconnect-outlook') {
          disconnectMicrosoft();
          removeEnv(['MICROSOFT_CLIENT_ID', 'MICROSOFT_TENANT']);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: 'Outlook disconnected — its sign-in was removed from this computer.' }));
        } else if (b.action === 'disconnect-telegram') {
          removeEnv(['TELEGRAM_BOT_TOKEN']);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: 'Telegram disconnected.' }));
        } else if (b.action === 'connect-gmail-imap') {
          // EASY Gmail path: validate the address + app password by opening a real IMAP
          // session, then save the creds locally (no OAuth, no Cloud Console).
          const user = String(b.user ?? '').trim();
          const pass = String(b.appPassword ?? '').replace(/\s+/g, '');
          const v = await verifyGmailImap(user, pass);
          if (v.ok) upsertEnv({ MWA_GMAIL_USER: user, MWA_GMAIL_APP_PASSWORD: pass });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: v.ok, message: v.message }));
        } else if (b.action === 'connect-outlook-device') {
          // EASY Outlook path: device-code — show a short code + URL; we poll in the background.
          if (!microsoftClientReady()) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: 'Outlook isn\'t set up on this build yet — use the advanced (app ID) option below for now.' }));
          } else {
            try {
              const dc = await startMicrosoftDeviceCode(!!b.readonly);
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ...dc, message: `Go to ${dc.verification_uri} and enter the code ${dc.user_code}. I'll show as connected once you finish.` }));
            } catch (e) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, message: (e as Error).message.slice(0, 160) }));
            }
          }
        } else if (b.action === 'connect-outlook') {
          if (!process.env.MICROSOFT_CLIENT_ID) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: 'Add your Microsoft app (client) ID first (the steps above), then connect.' }));
          } else {
            try {
              const url = startMicrosoftConnect(!!b.readonly);
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, url, message: 'Approve access in the Microsoft window, then come back — I\'ll show as connected.' }));
            } catch (e) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, message: (e as Error).message.slice(0, 160) }));
            }
          }
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'unknown action' }));
        }
        return;
      }
      if (p === '/api/save' && req.method === 'POST') {
        // CSRF: this POST writes secrets to .env (API keys, Tailscale auth key, bot tokens).
        // A cross-origin page must not be able to swap the model API key (prompt exfil) or
        // join the instance to an attacker's tailnet. Same-origin SPA/Tauri + CLI(no Origin) pass.
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        let result: { ok: boolean; message: string };
        if (b.which === 'anthropic') { result = await testAnthropic(b.ANTHROPIC_API_KEY); if (result.ok) upsertEnv({ ANTHROPIC_API_KEY: b.ANTHROPIC_API_KEY }); }
        else if (b.which === 'azure') { result = await testAzure(b.AZURE_GPT_BASE_URL, b.AZURE_GPT_API_KEY, b.AZURE_GPT_DEPLOYMENT); if (result.ok) upsertEnv({ AZURE_GPT_BASE_URL: b.AZURE_GPT_BASE_URL, AZURE_GPT_API_KEY: b.AZURE_GPT_API_KEY, AZURE_GPT_DEPLOYMENT: b.AZURE_GPT_DEPLOYMENT }); }
        else if (b.which === 'telegram') { result = await testTelegram(b.TELEGRAM_BOT_TOKEN); if (result.ok) upsertEnv({ TELEGRAM_BOT_TOKEN: b.TELEGRAM_BOT_TOKEN }); }
        else if (b.which === 'provider') {
          const provider = String(b.provider ?? ''), model = String(b.model ?? '');
          result = await testProvider(provider, model, b.key, b.baseUrl);
          if (result.ok) {
            const envKey = envKeyForProvider(provider);
            const kv: Record<string, string> = {};
            if (envKey && b.key) kv[envKey] = String(b.key);
            if (provider === 'azure') { if (b.baseUrl) kv.AZURE_GPT_BASE_URL = String(b.baseUrl); if (model) kv.AZURE_GPT_DEPLOYMENT = model; }
            if (provider === 'ollama' && b.baseUrl) kv.OLLAMA_BASE_URL = String(b.baseUrl);
            if (Object.keys(kv).length) upsertEnv(kv);
            setFetchModel(provider, model); // make the picked brain actually take effect
          }
        }
        else if (b.which === 'image-model') {
          // Set (or clear) the image-generation model. Save the provider key if given; we don't
          // run a live image gen to validate (costly) — the first generate_image surfaces errors.
          const provider = String(b.provider ?? '').trim(), model = String(b.model ?? '').trim();
          if (!model) { setImageModel(provider, ''); result = { ok: true, message: 'Image generation turned off.' }; }
          else {
            const envKey = envKeyForProvider(provider);
            const kv: Record<string, string> = {};
            if (envKey && b.key) kv[envKey] = String(b.key);
            if (provider === 'ollama' && b.baseUrl) kv.OLLAMA_BASE_URL = String(b.baseUrl);
            if (Object.keys(kv).length) upsertEnv(kv);
            setImageModel(provider, model);
            result = { ok: true, message: `Image model set to ${provider}:${model}.` };
          }
        }
        else if (b.which === 'google') {
          const id = String(b.GOOGLE_CLIENT_ID ?? '').trim(), secret = String(b.GOOGLE_CLIENT_SECRET ?? '').trim();
          if (!id || !secret) result = { ok: false, message: 'Paste both the Client ID and the Client secret.' };
          else if (!/\.apps\.googleusercontent\.com$/.test(id)) result = { ok: false, message: "That doesn't look like a Client ID — it should end in .apps.googleusercontent.com" };
          else { upsertEnv({ GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret }); result = { ok: true, message: 'Saved. Now connect your account.' }; }
        }
        else if (b.which === 'microsoft') {
          const id = String(b.MICROSOFT_CLIENT_ID ?? '').trim();
          if (!id) result = { ok: false, message: 'Paste the Application (client) ID from your Azure app.' };
          else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) result = { ok: false, message: "That doesn't look like a client ID — it should be a GUID like 11111111-2222-3333-4444-555555555555." };
          else {
            const kv: Record<string, string> = { MICROSOFT_CLIENT_ID: id };
            if (b.MICROSOFT_TENANT) kv.MICROSOFT_TENANT = String(b.MICROSOFT_TENANT).trim();
            upsertEnv(kv); result = { ok: true, message: 'Saved. Now connect your account.' };
          }
        }
        else if (b.which === 'access') {
          const preset = (ACCESS_PRESETS as readonly string[]).includes(b.preset) ? (b.preset as AccessPreset) : 'assistant';
          const saved = setAccess(preset, Array.isArray(b.grantedRoots) ? b.grantedRoots.map(String) : undefined);
          result = { ok: true, message: saved.dropped.length ? `Saved. Couldn't find: ${saved.dropped.join(', ')}` : 'Saved.' };
        }
        else if (b.which === 'style') {
          const style = (INTERACTION_STYLES as readonly string[]).includes(b.style) ? (b.style as InteractionStyle) : 'guided';
          setStyle(style);
          result = { ok: true, message: style === 'direct' ? 'Switched to Direct — concise replies.' : 'Switched to Guided — I\'ll explain and suggest next steps.' };
        }
        else if (b.which === 'tailscale') {
          // Store a Tailscale AUTH key (tskey-auth-…), used by the container entrypoint to join the
          // tailnet so the admin UI is reachable privately with no public port. (Not the mgmt API key.)
          const key = String(b.TAILSCALE_AUTHKEY ?? b.key ?? '').trim();
          if (!key.startsWith('tskey-')) {
            result = { ok: false, message: 'That doesn\'t look like a Tailscale auth key — it should start with "tskey-auth-". Use an auth key (Settings → Keys → Generate auth key), not the management API key.' };
          } else {
            upsertEnv({ TAILSCALE_AUTHKEY: key, ...(b.hostname ? { TAILSCALE_HOSTNAME: String(b.hostname).replace(/[^a-z0-9-]/gi, '').slice(0, 40) } : {}) });
            result = { ok: true, message: 'Tailscale auth key saved. On the next restart the app joins your tailnet and is reachable at its tailnet name — no public port needed.' };
          }
        }
        else if (b.which === 'backend') {
          // Choose where memory lives: "this computer" (SQLite, the default) or a Postgres
          // server (cloud / multi-instance / always-on). Postgres is validated by actually
          // connecting (which also provisions the schema). Takes effect on the next restart.
          const kind = String(b.kind ?? 'sqlite').toLowerCase();
          if (kind === 'sqlite') {
            removeEnv(['AWM_STORE_BACKEND', 'AWM_DATABASE_URL']);
            result = { ok: true, message: isHosted() ? `Memory will be kept in a file on this ${hostName()} deploy (SQLite) after the next restart.` : 'Memory will be stored privately on this computer (SQLite) after the next restart.' };
          } else if (kind === 'postgres') {
            const url = String(b.url ?? '').trim();
            if (!/^postgres(ql)?:\/\//i.test(url)) {
              result = { ok: false, message: 'Enter a Postgres connection URL (postgres://user:pass@host:5432/db).' };
            } else {
              try {
                // Connect for real — this validates creds + that pgvector is available, and
                // provisions the AWM schema on the target.
                const PostgresEngramStore = await loadPostgresStore();
                const s: any = new PostgresEngramStore(url);
                await s.ready();
                await s.close();
                // Optionally copy the current memory over FIRST (so a failed copy doesn't strand
                // you on an empty store). If the copy fails, do NOT switch.
                const lead = 'Connected ✓ — your database server becomes the memory store on the next restart.';
                if (b.migrate) {
                  const sqlitePath = dbFile();
                  const m = await migrateMemoryToPostgres(sqlitePath, url);
                  if (!m.ok) {
                    result = { ok: false, message: `Connected, but ${m.message} — staying on this computer so nothing is lost.` };
                  } else {
                    upsertEnv({ AWM_STORE_BACKEND: 'postgres', AWM_DATABASE_URL: url });
                    result = { ok: true, message: `${lead} Copied your memory over (${m.message}).` };
                  }
                } else {
                  upsertEnv({ AWM_STORE_BACKEND: 'postgres', AWM_DATABASE_URL: url });
                  result = { ok: true, message: `${lead} Your current on-computer memory stays put — turn on "bring my memory" to copy it.` };
                }
              } catch (e) {
                result = { ok: false, message: `Couldn't connect to that database: ${(e as Error).message}. Check the URL/credentials and that the pgvector extension is available.` };
              }
            }
          } else {
            result = { ok: false, message: 'Unknown storage option.' };
          }
        }
        else result = { ok: false, message: 'unknown field' };
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
        return;
      }
      if (p === '/api/chat') {
        // CSRF: /api/chat drives the agent (tools, files, network). Block cross-origin EventSource/GET
        // so a page the user visits can't silently run the agent on the no-password localhost default.
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'cross-origin request blocked' })); return; }
        await chat(req, res, url); return;
      }
      if (p === '/api/ingest') {
        // CSRF: like /api/chat, this GET/EventSource endpoint has side effects (scans the inbox, writes
        // durable memories), so block cross-origin so a visited page can't trigger it on localhost.
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'cross-origin request blocked' })); return; }
        await ingestScan(req, res, url); return;
      }
      // static SPA, or the dev fallback page
      if (ui) { serveStatic(res, ui, p); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(FALLBACK_HTML);
    } catch (e) {
      res.writeHead(500); res.end((e as Error).message);
    }
  });
  const host = process.env.MWA_SERVE_HOST ?? '127.0.0.1';
  // W5 security review (5): `tailscale serve` forwarding to this port makes every tailnet request arrive from
  // 127.0.0.1 — then nobody may count as "this machine" (trust.ts).
  if (await detectTailscaleServe(port)) logger.info('serve', `tailscale serve forwards to port ${port}: relayed mode (sign in with the password or a paired device)`);
  await new Promise<void>((r) => server.listen(port, host, r));
  // W5 security review (5): reachable through a relay, nobody counts as "this machine" — with no password nobody can
  // sign in to make a pairing code either. Say so where the operator looks.
  if (relayedMode() && !ACCESS_PW) {
    logger.warn('serve', 'This helper can be reached through the network or a relay and has no password: nobody can sign in or pair a phone. Set MWA_ACCESS_PASSWORD.');
    console.warn('  [mwa] No password is set and this helper is reachable through the network or a relay: set MWA_ACCESS_PASSWORD to sign in and pair your phone.');
  } else if (!ACCESS_PW) {
    // W5 re-review (M-1): MWA can't see a hand-made forwarder; whoever adds one must say so
    const note = 'No password is set, so this computer is trusted as "this machine". If you expose MWA through socat, netsh portproxy, ssh -R or an nginx stream, set MWA_RELAYED=1 (and MWA_ACCESS_PASSWORD): every request through such a forwarder looks local.';
    logger.info('serve', note);
    console.log(`  [mwa] ${note}`);
  }
  // W5 re-review: `tailscale serve` may be switched on after MWA starts — look again every 5 minutes. Sessions that
  // can't come back are pruned now and daily.
  { const t = setInterval(() => { void detectTailscaleServe(port).then((hit) => { if (hit) logger.info('serve', `tailscale serve now forwards to port ${port}: relayed mode`); }).catch(() => {}); }, 5 * 60_000); t.unref?.(); }
  try { pruneSessions(); } catch { /* app.db unavailable: next time */ }
  { const t = setInterval(() => { try { pruneSessions(); } catch { /* next time */ } }, 24 * 3_600_000); t.unref?.(); }
  // v2 (A8): mail headers for "All email" and triage — every 15 minutes (and on app open via POST /api/v1/mail/refresh).
  // Headers only, no model calls; nothing happens while no mail account is connected.
  // It starts once v2 is ready (the jobs migration at server start), like the rest of v2.
  if (mailSyncOn()) void v2Ready.then(() => startMailSync(), () => startMailSync());
  // Graceful shutdown: stop accepting connections, let in-flight requests drain, then exit
  // (a supervisor / Docker restart policy brings us back). Hard-exit after 10s as a backstop.
  const shutdown = (sig: string) => {
    console.log(`\n[mwa] ${sig} received — shutting down…`);
    stopHeartbeat(); // BL-10: the next process picks up whatever this one was running, at once
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  const u = `http://localhost:${port}`;
  console.log(`\n  MWA is running → ${u}`);
  console.log(ui ? '  (serving the built app)\n' : '  (no built app yet — serving the simple built-in page; run `npm run build:ui` for the full UI)\n');
  // BL-23: say so when the configured model hasn't held against instructions planted in what it reads.
  try { for (const w of modelWarnings(loadConfig().models)) console.log(`  ⚠ ${w}`); } catch { /* no config yet */ }
  if (process.env.MWA_NO_OPEN !== '1') openBrowser(u);

  // Start the scheduler so timed / recurring ("cron") tasks actually FIRE in the web app
  // (previously only the Telegram connector ran it). Best-effort; needs a provider configured.
  (async () => {
    try {
      const cfg = loadConfig();
      const memory = new MwaMemory(SERVE_AGENT, dbFile(), cfg.awm.workspace);
      const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
      const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
      // BL-71e: thinking time — between conversations, one proposal per open goal (MWA_THINK=propose; off by default).
      if (thinkMode() !== 'off' && !MEMORY_OFF) {
        let lastAt = Math.max(0, ...readThoughts().map((t) => t.at));
        let thinking = false;
        setInterval(() => {
          if (thinking || !thinkDue({ lastAt, now: Date.now() })) return;
          thinking = true; lastAt = Date.now();
          void backgroundCalls.run(true, () => thinkOnce(memory, getProvider('brain'), { person: resolvePersonId({ channel: 'web' }) }))
            .then((t) => { if (t.length) logger.info('think', `${t.length} thought(s)`, { asks: t.filter((x) => x.kind === 'ask').length }); })
            .finally(() => { thinking = false; });
        }, 5 * 60_000).unref();
        console.log(`  💭 thinking time on — proposals only, every ${Math.round(thinkEveryMs() / 3_600_000 * 10) / 10} h, at most $${thinkDailyUsd()} a day`);
      }
      // PASS `memory`. Without it memoryTools()/workTools() register nothing, so every SCHEDULED
      // run — the only autonomous path in the web app and therefore in Docker — had no
      // schedule_list, schedule_cancel, policy_save/forget, routine_propose, memory_profile,
      // memory_store_map, memory_learn_person or memory_feedback. Measured 2026-10-14: a scheduled
      // task asked to call schedule_list replied "TOOL NOT AVAILABLE". A recurring task could not
      // see or cancel itself, which is the headline reason schedule_cancel exists.
      await v2Ready; // the jobs migration (at server start) before the first tick
      const { registry } = await buildRegistry(cfg, memory);
      console.log('  ⏰ scheduler on — say e.g. "every day at 8am, summarize my inbox"');
      await runScheduler({
        memory, brain, worker, tools: registry, agentMemory: agentMemory(memory),
        // Eval only: a faster tick for the accelerated-clock assessment (MWA_SCHEDULER_TICK_MS, at least 1 s).
        ...(Number(process.env.MWA_SCHEDULER_TICK_MS) >= 1000 ? { intervalMs: Number(process.env.MWA_SCHEDULER_TICK_MS) } : {}),
        outRoot: resolve(cfg.workspace ?? './mwa-workspace', 'scheduled'),
        onFire: async (task, r) => {
          // Carry the real numbers. The chat card for a fired task was built from this record with
          // steps/toolCalls/cost hardcoded to 0 and reason to 'done', so an autonomous run that did
          // 7 steps and $0.04 of work displayed as "what I did · 0 steps" — and one that refused
          // displayed as done. This is the only run a person cannot watch happen.
          // A goal's job is shown by the goal's title (a hand-off's task is a page of framing); else the job's own words.
          let title: string | undefined;
          try { title = task.goal ? (await memory.getGoal(task.goal))?.title : undefined; } catch { /* the job's words */ }
          title = (title ?? (task.task && task.task !== task.instruction ? task.task : undefined))?.slice(0, 200);
          const saved = appendNotification({
            ts: Date.now(), instruction: task.instruction, summary: r.summary, reason: r.reason, outcome: r.outcome, completion: r.completion,
            steps: r.steps, toolCalls: r.toolCalls, costUsd: r.costUsd, durationMs: r.durationMs,
            files: r.files, dir: r.dir, job: r.job, fire: r.fire,
            // BL-71: the job's own words for the card (a hand-off's instruction is a page of framing), and its conversation.
            ...(title ? { title } : {}), ...(task.notify ? { session: task.notify } : {}),
          });
          // BL-71d: the result belongs to the conversation that asked for it, so it is there when that one is reopened.
          if (task.notify && !task.notify.startsWith('tg-')) {
            // A5: a job whose message was moved to another project reports there now
            let session = task.notify;
            try { const job = (task.v2job ? getJob(task.v2job) : undefined) ?? jobBySchedule(task.id); session = resultSessionFor(task.notify, job?.project_id); } catch { /* where the task said */ }
            appendTurn({ ts: Date.now(), session, message: title ?? task.instruction.slice(0, 300), reply: r.summary, reason: r.reason, kind: 'result', ...(r.job ? { job: String(r.job) } : {}) });
          }
          // BL-13: saved in the app's feed (or not). Whether an open tab is handed it is recorded when one is.
          if (r.job && r.fire) recordReceipt({ job: r.job, fire: r.fire, channel: 'app', status: saved ? 'stored' : 'failed', ...(saved ? {} : { detail: 'could not write the app feed' }) });
          console.log(`  ⏰ fired: ${task.instruction.slice(0, 60)} → ${r.summary.slice(0, 80)}`);
          // BL-53: in a carried conversation the person saw this result, so later turns may refer to it.
          if (CARRY_JOB_RESULTS && task.notify) { const sess = sessions.get(task.notify); if (sess) sess.history.push({ instruction: `(scheduled result: ${task.instruction.slice(0, 120)})`, summary: r.summary.slice(0, 1500), tainted: true }); }
        },
        // BL-10: a chat or job cut off by a restart and not resumed — say so in the app's feed.
        onInterrupted: (x) => { appendNotification({ ts: Date.now(), instruction: `Interrupted by a restart: ${x.instruction}`, summary: x.jobId ? `This scheduled job was cut off ${x.steps ? `after ${x.steps} step(s)` : 'before it did anything'}. ${x.recurring ? 'Its next scheduled run will pick the work up.' : 'It has used its resumes, so it was not started again.'}` : `This request was cut off ${x.steps ? `after ${x.steps} step(s)` : 'before it did anything'} by a restart. It was not started again — ask again if you still want it.${x.unfinished ? ` ${x.unfinished} step(s) had started without a recorded result: check whether they happened.` : ''}`, reason: 'interrupted', outcome: 'could-not' }); },
        onTick: () => { lastSchedulerTick = Date.now(); },
        onLog: (m) => logger.info('scheduler', m),
      });
    } catch (e) { logger.error('scheduler', 'not started', { error: (e as Error).message.slice(0, 100) }); }
  })();
}

const SUGGESTIONS = [
  'Warm up your memory — learn about my project from a folder of docs',
  'Summarize what came into my inbox today',
  'Catch me up on a topic I care about',
  'Draft a reply to the most important email',
  'What can you do for me?',
];

/** Best-effort cross-platform browser open (no dependency). */
function openBrowser(u: string): void {
  import('node:child_process').then(({ spawn }) => {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', u] : [u];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
  }).catch(() => { /* ignore */ });
}

// Lock screen shown for every request without a valid session cookie when
// MWA_ACCESS_PASSWORD is set. Posts to /api/login; on success the server sets the
// cookie and we drop into the app.
const LOGIN_HTML = String.raw`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MWA — Sign in</title><style>
:root{--paper:#e8e6e1;--ink:#1e2127;--dim:#76746d;--line:#cfccc3;--signal:#ec4a18}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto;display:grid;place-items:center}
.card{width:min(92vw,360px)}
.tag{font:600 11px/1 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.22em;text-transform:uppercase;color:var(--dim);margin-bottom:12px}
h1{font-size:24px;letter-spacing:-.01em;margin:0 0 6px}
p{color:var(--dim);margin:0 0 20px}
input{width:100%;border:1px solid var(--line);background:#fff;border-radius:3px;padding:12px 14px;font-size:15px;outline:none}
input:focus{border-color:var(--signal)}
button{width:100%;margin-top:10px;border:0;border-radius:3px;background:var(--signal);color:#fff;font:600 15px/1 ui-sans-serif,system-ui;padding:13px;cursor:pointer}
.err{color:var(--signal);font-size:13px;min-height:18px;margin-top:10px}
</style></head><body><form class="card" onsubmit="return go(event)">
<div class="tag">Memory Working Agent</div>
<h1>This agent is locked</h1>
<p>Enter the access password to continue.</p>
<input id="pw" type="password" autofocus autocomplete="current-password" placeholder="Password" />
<button type="submit">Unlock</button>
<div class="err" id="err"></div>
</form><script>
try{if(localStorage.getItem('mwa-ui')==='v2'&&!/[?&]ui=/.test(location.search)){location.replace('/?ui=v2');}}catch(_){}
async function go(e){e.preventDefault();var err=document.getElementById('err');err.textContent='';
try{var r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.ok){location.href='/';}else{var d=await r.json().catch(function(){return{}});err.textContent=d.message||'Wrong password.';}}
catch(_){err.textContent='Could not reach the server.';}return false;}
</script></body></html>`;

// Functional, dependency-free fallback so the activity spine is usable before the
// React app is built. Intentionally plain — the real UI is the Vite/React app.
const FALLBACK_HTML = String.raw`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MWA</title><style>
:root{--paper:#e8e6e1;--ink:#1e2127;--dim:#76746d;--line:#cfccc3;--accent:#ec4a18}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,Segoe UI,Roboto;font-feature-settings:"tnum" 1}
.wrap{max-width:740px;margin:0 auto;padding:32px 20px 80px}
h1{font:700 26px/1.2 ui-sans-serif,system-ui;letter-spacing:-.01em;margin:0 0 2px}.sub{color:var(--dim);margin-bottom:22px}
.spine{border-left:2px solid var(--line);margin:16px 0;padding:2px 0 2px 16px}
.step{margin:6px 0;color:var(--ink)}.step .k{color:var(--accent);font-weight:600}
.you{background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:14px 0}
.sugg{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 18px}
.sugg button{background:#fff;border:1px solid var(--line);border-radius:999px;padding:8px 12px;cursor:pointer;font:inherit;color:var(--ink)}
.bar{display:flex;gap:8px;position:sticky;bottom:0;background:var(--paper);padding:12px 0}
input{flex:1;padding:12px 14px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff;color:var(--ink)}
.send{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:600;cursor:pointer}
.reply{border-top:1px solid var(--line);margin-top:10px;padding-top:10px}
</style></head><body><div class="wrap">
<h1>Your assistant</h1><div class="sub">Ask for something. You'll watch it remember, look things up, and do the work.</div>
<div class="sugg" id="sugg"></div>
<div id="feed"></div>
<div class="bar"><input id="msg" placeholder="What should I take care of?" autofocus><button class="send" id="send">Send</button></div>
</div><script>
const feed=document.getElementById('feed'),input=document.getElementById('msg');
const PLAIN={start:'Getting started',recall:'Remembering what I know',read:'Reading',remember:'Learned something',tool:'Using a tool',dispatch:'Working on it',sleep:'Organizing my memory',escalate:'Thinking harder',done:'Done'};
fetch('/api/suggestions').then(r=>r.json()).then(d=>{const s=document.getElementById('sugg');for(const t of d.suggestions){const b=document.createElement('button');b.textContent=t;b.onclick=()=>{input.value=t;go();};s.appendChild(b);}});
function el(c,html){const d=document.createElement('div');d.className=c;d.innerHTML=html;feed.appendChild(d);d.scrollIntoView({block:'end'});return d;}
function go(){const m=input.value.trim();if(!m)return;input.value='';el('you','<b>You:</b> '+m.replace(/</g,'&lt;'));
 const spine=el('spine','');const es=new EventSource('/api/chat?session=web&message='+encodeURIComponent(m));
 const add=(k,t)=>{const s=document.createElement('div');s.className='step';s.innerHTML='<span class=k>'+k+'</span> '+t;spine.appendChild(s);s.scrollIntoView({block:'end'});};
 for(const ev of Object.keys(PLAIN)){es.addEventListener(ev,e=>{let extra='';try{const d=JSON.parse(e.data);extra=d.path||d.concept||d.name||d.query||'';}catch{}; add(PLAIN[ev],String(extra).slice(0,80));});}
 es.addEventListener('result',e=>{es.close();const d=JSON.parse(e.data);el('reply','<b>Assistant:</b> '+(d.summary||'(done)').replace(/</g,'&lt;'));});
 es.addEventListener('error',e=>{es.close();let msg='something went wrong';try{msg=JSON.parse(e.data).message;}catch{}; el('reply','<b>Hmm:</b> '+msg);});}
document.getElementById('send').onclick=go;input.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
</script></body></html>`;

const _entry = process.argv[1] ?? '';
if (_entry.endsWith('serve.ts') || _entry.endsWith('serve.js')) {
  runServe().catch((e) => { console.error('serve failed:', e); process.exit(1); });
}
