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
import { readFileSync, existsSync, statSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import { getProvider, listModels, PROVIDERS, type Provider } from './provider.js';
import { RoutedProvider } from './model-router.js';
import { MwaMemory } from './awm.js';
import { recordReceipt, readReceipts, setReceiptProducer } from './receipts.js';
import { setTranscriptProducer, stopHeartbeat } from './transcript.js';
import { scanSources } from './onboard.js';
import { buildRegistry } from './tools/build.js';
import { listPendingActions, confirmPending, cancelPending, setApprovalOwner, runApproved, recentApprovalOutcomes } from './tools/approval.js';
import { logger, readLogs, type LogLevel } from './logger.js';
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
import { loadEnv } from './env.js';
import { mailboxDirs, watchInbox } from './mailbox.js';
import { googleConfigured, startGmailConnect } from './connectors/google.js';
import { gmailImapConfigured, verifyGmailImap } from './connectors/gmail-imap.js';
import { microsoftConfigured, microsoftClientReady, startMicrosoftConnect, startMicrosoftDeviceCode } from './connectors/microsoft.js';
import { listConnectors, enableConnector, disableConnector, enabledConnectorIds, enableExternalNpm } from './connectors/registry.js';
import { externalInstallState } from './installer/policy.js';
import { reviewConnector } from './installer/review.js';
import { accessPolicy, setAccess, ACCESS_PRESETS, type AccessPreset } from './tools/access.js';
import { status, testAnthropic, testAzure, testTelegram, testProvider, envKeyForProvider, upsertEnv, removeEnv } from './wizard.js';
import { disconnectGoogle } from './connectors/google.js';
import { disconnectMicrosoft } from './connectors/microsoft.js';
import { awmCliPath, loadEmbeddings, loadPostgresStore } from './awm-api.js';

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
const validTokens = new Set<string>(); // in-memory; cleared on restart → re-login (fine)

function issueToken(): string { const t = randomBytes(24).toString('hex'); validTokens.add(t); return t; }
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}
function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === 'mwa_session') return v.join('='); }
  return null;
}
function authed(req: IncomingMessage): boolean {
  if (!ACCESS_PW) return true;
  const t = cookieToken(req);
  return !!t && validTokens.has(t);
}

// Bundled MCP tools the Connections page can toggle on/off (no file editing).
/** Self-learning loop: answer up to 3 open questions in the background (the agent runs
 *  non-interactively → its auto-learn writes the answers as facts), then mark them resolved. */
async function resolveOpenQuestionsBg(): Promise<void> {
  const cfg = loadConfig();
  const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
  const memory = new MwaMemory(SERVE_AGENT, dbPath, cfg.awm.workspace);
  const open = (await memory.listOpenQuestions()).slice(0, 3);
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
    const p = process.env.MWA_NOTIFY ?? resolve('./data/notifications.jsonl');
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
const SERVER_START = Date.now();
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
  if (!s) { s = { dir: resolve(workspaceRoot, 'serve', id.replace(/[^a-z0-9_-]/gi, '')), history: [], lastUsed: Date.now(), topicStart: 0 }; sessions.set(id, s); }
  s.lastUsed = Date.now();
  return s;
}

// A gap this long since the last turn means it's almost certainly a new task/session, so we
// stop threading the earlier conversation. Tunable; MWA_TOPIC_BOUNDARY=0 disables the whole check.
const FRESH_IDLE_MS = Number(process.env.MWA_FRESH_IDLE_MS ?? 45 * 60_000);

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
  if (idleMs > FRESH_IDLE_MS) return 'fresh';     // long silence ⇒ new task/session
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
  const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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

/** Stream one runAgent over SSE: every onEvent becomes an SSE event for the spine. */
async function chat(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const message = (url.searchParams.get('message') ?? '').trim();
  const sessionId = url.searchParams.get('session') || 'default';
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (!message) { send('error', { message: 'empty message' }); res.end(); return; }
  // Concurrency cap — reserve the slot ATOMICALLY (before any await) so a burst of near-simultaneous
  // chats can't all pass the gate during the classifyContinuity / preparePersonTurn round-trips.
  if (activeRuns >= MAX_CONCURRENT) { send('error', { message: "I'm at capacity right now (too many chats running) — try again in a moment." }); res.end(); return; }
  activeRuns++;
  // Heartbeat: keep the SSE stream alive during slow steps so proxies/browsers don't drop it mid-run.
  const hb = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* */ } }, 15_000);
  req.on('close', () => clearInterval(hb));

  // Hoisted so the finally can always release them even if setup (buildRegistry etc.) throws.
  let memory: MwaMemory | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    const cfg = loadConfig();
    const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
    const relation = await classifyContinuity(brain, topicTurns, message, idleMs);
    const hadContext = topicTurns.length > 0;
    if (relation === 'fresh') s.topicStart = s.history.length;
    // F5: topic-scoped memory is OPT-IN (MWA_TOPIC_NAMESPACE=1). Default OFF preserves cross-session continuity.
    if (process.env.MWA_TOPIC_NAMESPACE === '1') memory.setNamespace(`${sessionId}-t${s.topicStart}`);
    send('topic', { relation, hadContext });
    const carriedTurns = relation === 'continue' ? s.history.slice(Math.max(s.topicStart, s.history.length - 3)) : [];
    const ctx = carriedTurns.map((h, i) => `(${i + 1}) ${h.instruction} → ${h.summary}`).join('\n');
    // If any carried turn read external content, its replies may quote that content: send the whole
    // context fenced through `carried` (with this run starting tainted), not inside the instruction.
    const ctxTainted = carriedTurns.some((h) => h.tainted);
    const askNote = relation === 'ask' && topicTurns.length
      ? `\n\nNOTE: It's unclear whether this continues the recent conversation (about "${topicTurns[topicTurns.length - 1].instruction.slice(0, 60)}…") or is a new request. If that distinction affects your answer, ask the user ONE short yes/no question to confirm before proceeding; otherwise treat it as a new request.`
      : '';
    const instruction = (ctx && !ctxTainted ? `Recent conversation so far:\n${ctx}\n\nNew request: ${message}` : message) + askNote;

    // Per-person Profile (S1–S6): resolve who's talking, build their prompt context (identity guard +
    // primer + intake hint, with PII redacted on an identity mismatch). Off-switch MWA_PERSON_PROFILE=0.
    const personName = (url.searchParams.get('person') ?? '').trim() || undefined;
    const prepared = await preparePersonTurn(memory, { channel: 'web', name: personName }, message);
    const personContext = prepared.personContext;
    send('person', { id: prepared.personId, notes: prepared.notes }); // Glass-Box: who + how much we know
    // Surface the DOUBT to the UI, but NOT the reasons — they contain the real stored name/contact, and
    // this stream goes to the very client we're flagging as a possible impersonator (S6 redaction).
    if (prepared.mismatch) send('identity', { level: 'mismatch' });

    const r = await runAgent({
      instruction, userMessage: message, dir: s.dir, memory, brain, worker, tools: registry, transcript: true, // BL-10
      ...(ctx && ctxTainted ? { carried: `Recent conversation so far:\n${ctx}`, startTainted: true } : {}),
      workspace: cfg.awm.workspace, session: sessionId, interactive: true, // a human is watching → ask_user can ask them
      style: cfg.style, // guided (proactive/plain) vs direct (concise) — independent of access preset
      personContext, // S2: per-person adaptation block (empty for the shared/unknown profile)
      personId: prepared.personId, identityInDoubt: prepared.mismatch, // S6 v2: gate sensitive confirms on step-up
      domainPackDir: process.env.MWA_DOMAIN_PACK, // optional domain pack (AGENT.md + topics) for a domain agent
      budget: { maxSteps: 40, maxWallMs: 10 * 60_000, consolidateEvery: 10, maxTokens: Number(process.env.MWA_MAX_TOKENS ?? 400_000) },
      onEvent: (type, d) => send(type, d as Record<string, unknown>),
    });
    s.history.push({ instruction: message, summary: r.summary, tainted: r.tainted === true });
    send('result', { reason: r.reason, summary: r.summary, steps: r.steps, dispatches: r.dispatches, toolCalls: r.toolCalls, costUsd: Number(r.costUsd.toFixed(4)) });

    // S3/S5 — LEARN durable facts about this person + recompress their dossier (suppressed for the
    // shared 'unknown' profile and on an identity mismatch). Runs after the reply is sent.
    // Not from a reply that read external content: person notes are primed into every turn with them.
    const learned = r.tainted ? 0 : await learnFromTurn(brain, memory, prepared, message, r.summary);
    if (learned) send('learned', { about: prepared.personId, count: learned });
  } catch (e) {
    logger.error('chat', 'agent run failed', { session: sessionId, error: (e as Error).message.slice(0, 200) });
    send('error', { message: (e as Error).message });
  } finally {
    activeRuns--;
    clearInterval(hb);
    if (close) await close();
    memory?.close();
    res.end();
  }
}

function serveStatic(res: ServerResponse, dir: string, pathname: string): void {
  // SPA: unknown non-asset routes fall back to index.html (client-side routing).
  let rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let file = join(dir, rel);
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
  setInterval(() => {
    void runApproved().then((done) => {
      for (const r of done) appendNotification({ ts: Date.now(), instruction: `Approved in Telegram: ${r.tool}`, summary: r.result.slice(0, 2000), reason: 'done', outcome: r.ok ? 'changed' : 'could-not' });
    }).catch(() => { /* best-effort */ });
  }, 15_000).unref();

  loadEnv();

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
        config: icfg, dbPath: process.env.MWA_DB ?? resolve('./data/agent.db'), agentId: SERVE_AGENT,
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
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;

      // Access gate (no-op unless MWA_ACCESS_PASSWORD is set).
      if (ACCESS_PW) {
        if (p === '/api/login' && req.method === 'POST') {
          const b = await readBody(req);
          if (typeof b.password === 'string' && safeEqual(b.password, ACCESS_PW)) {
            res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `mwa_session=${issueToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'Wrong password.' }));
          }
          return;
        }
        // /api/health is exempt: it is the LIVENESS probe. With a password set it answered 401,
        // so the Dockerfile HEALTHCHECK failed forever and the container sat "unhealthy" — on a
        // NAS or under a restart policy that acts on health, permanently. Measured 2026-10-14:
        // FailingStreak 4 within two minutes of boot. The handler below still withholds the
        // detail (counts, sessions) from an unauthenticated caller; only ok/db go out.
        if (!authed(req) && p !== '/api/health') {
          if (p.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'locked', message: 'Sign in to continue.' })); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN_HTML); return;
        }
      }

      if (p === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...status(), gmail: googleConfigured() || gmailImapConfigured(), outlook: microsoftConfigured() }));
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
      if (p === '/api/stats') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let memories = 0;
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); memories = await m.memoryCount(); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ memories }));
        return;
      }
      if (p === '/api/memories') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let memories: Awaited<ReturnType<MwaMemory['recentMemories']>> = [];
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); memories = await m.recentMemories(40); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ memories }));
        return;
      }
      // F1 Glass Box — "what I did" history (the side-effecting action log).
      if (p === '/api/actions') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let actions: Awaited<ReturnType<MwaMemory['recentActions']>> = [];
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); actions = await m.recentActions(40); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ actions }));
        return;
      }
      // F1 Glass Box — export everything MWA knows as portable Markdown ("it's yours").
      if (p === '/api/memory/export') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let saved = 0;
        try {
          const m = new MwaMemory(SERVE_AGENT, dbPath);
          for (const it of items) {
            const concept = String(it.concept ?? '').trim().slice(0, 120);
            const content = String(it.content ?? '').trim();
            if (!concept || content.length < 4) continue;
            const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
            const id = await m.write(concept, content, [...tags, 'src=onboarding', 'intent=context'], { provenance: 'user', canonical: true, origin: 'onboarding' });
            if (id) saved++;
          }
          m.close();
        } catch (e) { logger.error('onboard', 'save failed', { error: (e as Error).message.slice(0, 200) }); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved }));
        return;
      }
      if (p === '/api/schedule') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let scheduled: { instruction: string; due: number; recur: string | null }[] = [];
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); scheduled = (await m.pendingScheduled()).map((t) => ({ instruction: t.instruction, due: t.due, recur: t.recur ?? null })); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ scheduled }));
        return;
      }
      if (p === '/api/notifications') {
        const np = process.env.MWA_NOTIFY ?? resolve('./data/notifications.jsonl');
        const since = Number(url.searchParams.get('since') ?? 0);
        let notifications: any[] = [];
        try { notifications = readFileSync(np, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((n: any) => Number(n.ts) > since).slice(-20); } catch { /* none yet */ }
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
        const logp = process.env.MWA_RUNLOG ?? resolve('./data/runs.jsonl');
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
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let memoryCount = -1, db = false;
        try { const m = new MwaMemory(SERVE_AGENT, dbPath); memoryCount = await m.memoryCount(); m.close(); db = true; } catch { /* db down */ }
        const schedulerLastTickAgoSec = lastSchedulerTick ? Math.round((Date.now() - lastSchedulerTick) / 1000) : -1;
        const full = { ok: db, uptimeSec: Math.round((Date.now() - SERVER_START) / 1000), db, memoryCount, activeRuns, sessions: sessions.size, schedulerLastTickAgoSec };
        // Locked + not signed in: the probe still gets its verdict (and the 503 when the DB is
        // down, which is the whole point of the check), but not the operational detail.
        const body = (ACCESS_PW && !authed(req)) ? { ok: db, db } : full;
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
        res.end(JSON.stringify({ pending: listPendingActions(), recent: recentApprovalOutcomes() }));
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
      if (p === '/api/approvals/cancel' && req.method === 'POST') {
        if (!sameOriginOk(req)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'cross-origin request blocked' })); return; }
        const b = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: cancelPending(String(b.id ?? '')) }));
        return;
      }
      if (p === '/api/questions' && req.method === 'GET') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
      if (p === '/api/skills') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
          brain: ((spec) => { const i = spec.indexOf(':'); return { provider: i > 0 ? spec.slice(0, i) : '', model: i > 0 ? spec.slice(i + 1) : spec }; })(loadConfig().models.fetch || ''),
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
          if (!/^[A-Z0-9_]+$/.test(env) || !value) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'Missing or invalid field.' })); }
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
            try { const lp = process.env.MWA_INSTALL_LOG ?? resolve('./data/installs.jsonl'); mkdirSync(dirname(lp), { recursive: true }); appendFileSync(lp, JSON.stringify({ ts: Date.now(), id: r.id, name: source, tier: 'approved-external', version: b.version ?? null, verdict: b.verdict ?? null, integrity: b.integrity ?? null }) + '\n'); } catch { /* */ }
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
            result = { ok: true, message: 'Memory will be stored privately on this computer (SQLite) after the next restart.' };
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
                  const sqlitePath = process.env.MWA_DB ?? resolve('./data/agent.db');
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
  await new Promise<void>((r) => server.listen(port, host, r));
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
  if (process.env.MWA_NO_OPEN !== '1') openBrowser(u);

  // Start the scheduler so timed / recurring ("cron") tasks actually FIRE in the web app
  // (previously only the Telegram connector ran it). Best-effort; needs a provider configured.
  (async () => {
    try {
      const cfg = loadConfig();
      const memory = new MwaMemory(SERVE_AGENT, process.env.MWA_DB ?? resolve('./data/agent.db'), cfg.awm.workspace);
      const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
      const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
      // PASS `memory`. Without it memoryTools()/workTools() register nothing, so every SCHEDULED
      // run — the only autonomous path in the web app and therefore in Docker — had no
      // schedule_list, schedule_cancel, policy_save/forget, routine_propose, memory_profile,
      // memory_store_map, memory_learn_person or memory_feedback. Measured 2026-10-14: a scheduled
      // task asked to call schedule_list replied "TOOL NOT AVAILABLE". A recurring task could not
      // see or cancel itself, which is the headline reason schedule_cancel exists.
      const { registry } = await buildRegistry(cfg, memory);
      console.log('  ⏰ scheduler on — say e.g. "every day at 8am, summarize my inbox"');
      await runScheduler({
        memory, brain, worker, tools: registry,
        outRoot: resolve(cfg.workspace ?? './mwa-workspace', 'scheduled'),
        onFire: async (task, r) => {
          // Carry the real numbers. The chat card for a fired task was built from this record with
          // steps/toolCalls/cost hardcoded to 0 and reason to 'done', so an autonomous run that did
          // 7 steps and $0.04 of work displayed as "what I did · 0 steps" — and one that refused
          // displayed as done. This is the only run a person cannot watch happen.
          const saved = appendNotification({
            ts: Date.now(), instruction: task.instruction, summary: r.summary, reason: r.reason, outcome: r.outcome, completion: r.completion,
            steps: r.steps, toolCalls: r.toolCalls, costUsd: r.costUsd, durationMs: r.durationMs,
            files: r.files, dir: r.dir, job: r.job, fire: r.fire,
          });
          // BL-13: saved in the app's feed (or not). Whether an open tab is handed it is recorded when one is.
          if (r.job && r.fire) recordReceipt({ job: r.job, fire: r.fire, channel: 'app', status: saved ? 'stored' : 'failed', ...(saved ? {} : { detail: 'could not write the app feed' }) });
          console.log(`  ⏰ fired: ${task.instruction.slice(0, 60)} → ${r.summary.slice(0, 80)}`);
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
