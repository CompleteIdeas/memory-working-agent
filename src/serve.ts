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
import { readFileSync, existsSync, statSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getProvider } from './provider.js';
import { RoutedProvider } from './model-router.js';
import { MwaMemory } from './awm.js';
import { buildRegistry } from './tools/build.js';
import { runAgent } from './agent.js';
import { runScheduler } from './scheduler.js';
import { loadConfig, CONFIG_PATH } from './config.js';
import { loadEnv } from './env.js';
import { mailboxDirs } from './mailbox.js';
import { googleConfigured, connectGmail } from './connectors/google.js';
import { status, testAnthropic, testAzure, testTelegram, testProvider, envKeyForProvider, upsertEnv } from './wizard.js';

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

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = ''; for await (const c of req) raw += c;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
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
const BUNDLED_TOOLS: Record<string, { label: string; desc: string; spec: { command: string; args: string[] } }> = {
  search: { label: 'Web search', desc: 'Search the web (keyless; Brave if BRAVE_API_KEY set)', spec: { command: 'node', args: ['mcp-servers/search.mjs'] } },
  fetch: { label: 'Read web pages', desc: 'Open a link and read its text', spec: { command: 'node', args: ['mcp-servers/fetch.mjs'] } },
};

/** Self-learning loop: answer up to 3 open questions in the background (the agent runs
 *  non-interactively → its auto-learn writes the answers as facts), then mark them resolved. */
async function resolveOpenQuestionsBg(): Promise<void> {
  const cfg = loadConfig();
  const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
  const memory = new MwaMemory('mwa-serve', dbPath);
  const open = memory.listOpenQuestions().slice(0, 3);
  if (!open.length) { memory.close(); return; }
  const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const { registry, close } = await buildRegistry(cfg);
  const dir = resolve(cfg.workspace ?? './mwa-workspace', 'serve', 'resolve');
  for (const q of open) {
    try {
      await runAgent({ instruction: `Answer this open question and report what you found: ${q.question}`, dir, memory, brain, worker, tools: registry, workspace: cfg.awm.workspace, session: 'resolve', interactive: false, budget: { maxSteps: 20, maxWallMs: 5 * 60_000, consolidateEvery: 10 } });
      memory.resolveQuestion(q.id);
    } catch { /* best-effort */ }
  }
  await close(); memory.close();
}

/** Record a fired scheduled-task result so the UI can surface it (proactive delivery). */
function appendNotification(entry: Record<string, unknown>): void {
  try {
    const p = process.env.MWA_NOTIFY ?? resolve('./data/notifications.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch { /* best-effort */ }
}

/** Persist enabled MCP tool servers into mwa.config.json (tools.mcpServers). */
function writeMcpServers(servers: Record<string, unknown>): void {
  let raw: any = {};
  try { if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* */ }
  raw.tools = raw.tools ?? {};
  raw.tools.mcpServers = servers;
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
}

/** Persist the chosen brain into mwa.config.json (models.fetch = "provider:model"),
 *  keeping a Sonnet reason-tier when Anthropic is available, else mirroring fetch. */
function setFetchModel(provider: string, model: string): void {
  const spec = `${provider}:${model}`;
  let raw: any = {};
  try { if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* */ }
  raw.models = raw.models ?? {};
  raw.models.fetch = spec;
  if (!raw.models.reason) raw.models.reason = process.env.ANTHROPIC_API_KEY ? 'anthropic:claude-sonnet-4-6' : spec;
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
}

/** Per-session working dir + memory, so chat follow-ups build on earlier turns. */
interface Session { dir: string; history: { instruction: string; summary: string }[]; }
const sessions = new Map<string, Session>();

function sessionFor(id: string, workspaceRoot: string): Session {
  let s = sessions.get(id);
  if (!s) { s = { dir: resolve(workspaceRoot, 'serve', id.replace(/[^a-z0-9_-]/gi, '')), history: [] }; sessions.set(id, s); }
  return s;
}

/** Stream one runAgent over SSE: every onEvent becomes an SSE event for the spine. */
async function chat(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const message = (url.searchParams.get('message') ?? '').trim();
  const sessionId = url.searchParams.get('session') || 'default';
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (!message) { send('error', { message: 'empty message' }); res.end(); return; }
  // Heartbeat: keep the SSE stream alive during slow steps (e.g. an escalated
  // strong-model call) so proxies/browsers don't drop it mid-run.
  const hb = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* */ } }, 15_000);
  req.on('close', () => clearInterval(hb));

  const cfg = loadConfig();
  const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
  const s = sessionFor(sessionId, cfg.workspace ?? './mwa-workspace');
  const memory = new MwaMemory('mwa-serve', dbPath);
  memory.setSessionId(sessionId); // entity-bridge continuity across this conversation
  const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const { registry, close } = await buildRegistry(cfg);

  // Carry brief recent-turn context so follow-ups ("now do X to it") make sense.
  const ctx = s.history.slice(-3).map((h, i) => `(${i + 1}) ${h.instruction} → ${h.summary}`).join('\n');
  const instruction = ctx ? `Recent conversation so far:\n${ctx}\n\nNew request: ${message}` : message;

  try {
    const r = await runAgent({
      instruction, dir: s.dir, memory, brain, worker, tools: registry,
      workspace: cfg.awm.workspace, session: sessionId, interactive: true, // a human is watching → ask_user can ask them
      budget: { maxSteps: 40, maxWallMs: 10 * 60_000, consolidateEvery: 10 },
      onEvent: (type, d) => send(type, d as Record<string, unknown>),
    });
    s.history.push({ instruction: message, summary: r.summary });
    send('result', { reason: r.reason, summary: r.summary, steps: r.steps, dispatches: r.dispatches, toolCalls: r.toolCalls, costUsd: Number(r.costUsd.toFixed(4)) });
  } catch (e) {
    send('error', { message: (e as Error).message });
  } finally {
    clearInterval(hb); await close(); memory.close(); res.end();
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

export async function runServe(port = Number(process.env.MWA_SERVE_PORT ?? 7788)): Promise<void> {
  loadEnv();
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
        if (!authed(req)) {
          if (p.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'locked', message: 'Sign in to continue.' })); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN_HTML); return;
        }
      }

      if (p === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...status(), gmail: googleConfigured() }));
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
        try { const m = new MwaMemory('mwa-serve', dbPath); memories = m.memoryCount(); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ memories }));
        return;
      }
      if (p === '/api/memories') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let memories: { id: string; concept: string; content: string }[] = [];
        try { const m = new MwaMemory('mwa-serve', dbPath); memories = m.recentMemories(40); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ memories }));
        return;
      }
      if (p === '/api/schedule') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let scheduled: { instruction: string; due: number; recur: string | null }[] = [];
        try { const m = new MwaMemory('mwa-serve', dbPath); scheduled = m.pendingScheduled().map((t) => ({ instruction: t.instruction, due: t.due, recur: t.recur ?? null })); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ scheduled }));
        return;
      }
      if (p === '/api/notifications') {
        const np = process.env.MWA_NOTIFY ?? resolve('./data/notifications.jsonl');
        const since = Number(url.searchParams.get('since') ?? 0);
        let notifications: any[] = [];
        try { notifications = readFileSync(np, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((n: any) => Number(n.ts) > since).slice(-20); } catch { /* none yet */ }
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
      if (p === '/api/questions' && req.method === 'GET') {
        const dbPath = process.env.MWA_DB ?? resolve('./data/agent.db');
        let questions: { id: string; question: string }[] = [];
        try { const m = new MwaMemory('mwa-serve', dbPath); questions = m.listOpenQuestions(); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ questions }));
        return;
      }
      if (p === '/api/questions' && req.method === 'POST') {
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
        try { const m = new MwaMemory('mwa-serve', dbPath); skills = m.listSkills(); m.close(); } catch { /* */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ skills }));
        return;
      }
      if (p === '/api/connections' && req.method === 'GET') {
        const cfg = loadConfig();
        const enabled = Object.keys(cfg.tools.mcpServers ?? {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          gmail: googleConfigured(),
          telegram: !!process.env.TELEGRAM_BOT_TOKEN,
          tools: Object.entries(BUNDLED_TOOLS).map(([id, t]) => ({ id, label: t.label, desc: t.desc, on: enabled.includes(id) })),
        }));
        return;
      }
      if (p === '/api/connections' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.action === 'toggle-tool' && BUNDLED_TOOLS[b.tool]) {
          const cfg = loadConfig();
          const servers: Record<string, unknown> = { ...(cfg.tools.mcpServers ?? {}) };
          if (b.on) servers[b.tool] = BUNDLED_TOOLS[b.tool].spec; else delete servers[b.tool];
          writeMcpServers(servers);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
        } else if (b.action === 'connect-gmail') {
          if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: "Email isn't set up on this computer yet (it needs a Google app ID/secret). One-click email is coming." }));
          } else {
            connectGmail((m) => console.log(m)).catch(() => { /* */ }); // fire-and-forget loopback consent → opens Google sign-in
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'A sign-in window will open. Approve access, then refresh this page.' }));
          }
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'unknown action' }));
        }
        return;
      }
      if (p === '/api/save' && req.method === 'POST') {
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
        else result = { ok: false, message: 'unknown field' };
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
        return;
      }
      if (p === '/api/chat') { await chat(req, res, url); return; }
      // static SPA, or the dev fallback page
      if (ui) { serveStatic(res, ui, p); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(FALLBACK_HTML);
    } catch (e) {
      res.writeHead(500); res.end((e as Error).message);
    }
  });
  const host = process.env.MWA_SERVE_HOST ?? '127.0.0.1';
  await new Promise<void>((r) => server.listen(port, host, r));
  const u = `http://localhost:${port}`;
  console.log(`\n  MWA is running → ${u}`);
  console.log(ui ? '  (serving the built app)\n' : '  (no built app yet — serving the simple built-in page; run `npm run build:ui` for the full UI)\n');
  if (process.env.MWA_NO_OPEN !== '1') openBrowser(u);

  // Start the scheduler so timed / recurring ("cron") tasks actually FIRE in the web app
  // (previously only the Telegram connector ran it). Best-effort; needs a provider configured.
  (async () => {
    try {
      const cfg = loadConfig();
      const memory = new MwaMemory('mwa-serve', process.env.MWA_DB ?? resolve('./data/agent.db'));
      const brain = new RoutedProvider(getProvider('brain'), getProvider('high'));
      const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
      const { registry } = await buildRegistry(cfg);
      console.log('  ⏰ scheduler on — say e.g. "every day at 8am, summarize my inbox"');
      await runScheduler({
        memory, brain, worker, tools: registry,
        outRoot: resolve(cfg.workspace ?? './mwa-workspace', 'scheduled'),
        onFire: async (task, r) => {
          appendNotification({ ts: Date.now(), instruction: task.instruction, summary: r.summary });
          console.log(`  ⏰ fired: ${task.instruction.slice(0, 60)} → ${r.summary.slice(0, 80)}`);
        },
        onLog: (m) => console.log(`  ${m}`),
      });
    } catch (e) { console.error('  scheduler not started:', (e as Error).message.slice(0, 100)); }
  })();
}

const SUGGESTIONS = [
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
