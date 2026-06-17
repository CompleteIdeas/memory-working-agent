/**
 * Telegram connector — talk to your MWA agent from your phone. A connector bridges
 * an external channel to the agent: incoming message → run the agent → reply.
 * (The mailbox does the same over files; this does it over Telegram.)
 *
 * Setup: get a bot token from @BotFather → set TELEGRAM_BOT_TOKEN. SECURITY: the
 * agent can run_command/write files, so only authorized chats are served — set
 * TELEGRAM_ALLOWED_CHATS=<comma-separated chat ids>. Any other chat is rejected
 * and told its id so you can authorize it. Long-polling — no public webhook needed.
 *
 * `mwa connect telegram`
 */
import { mkdirSync, readdirSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import type { MwaConfig } from '../config.js';
import { getProvider, type Provider } from '../provider.js';
import { RoutedProvider } from '../model-router.js';
import { MwaMemory } from '../awm.js';
import { buildRegistry } from '../tools/build.js';
import { runAgent } from '../agent.js';
import { runScheduler } from '../scheduler.js';
import { loadEnv } from '../env.js';
import type { ToolRegistry } from '../tools/registry.js';

async function tg(token: string, method: string, body?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j: any = await res.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
  return j.result;
}

/** Send a file as a Telegram document (multipart). */
async function sendDocument(token: string, chatId: number | string, filePath: string): Promise<void> {
  const buf = readFileSync(filePath);
  const fd = new FormData();
  fd.set('chat_id', String(chatId));
  fd.set('document', new Blob([buf]), basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd });
  const j: any = await res.json();
  if (!j.ok) throw new Error(`sendDocument: ${j.description}`);
}

const HELP_TEXT = [
  '🧠 I\'m your Memory Working Agent. Send an instruction and I\'ll do it — coding, research, writing, file tasks — and reply with the result (and any files).',
  '',
  'Examples:',
  '· "Research X and summarize in 3 bullets"',
  '· "Write a script that does Y and save it"',
  '· "Search the web for Z and tell me"',
  '',
  'I remember across our chats, and follow-ups work ("now make it shorter").',
  'Commands:  /help  ·  /status',
].join('\n');

interface Deps { memory: MwaMemory; brain: Provider; worker: Provider; registry: ToolRegistry; maxSteps: number; maxMin: number; outRoot: string }

/**
 * Testable core: an instruction from a chat → run the agent → format a reply.
 * Channel-agnostic; the Telegram loop just transports text in/out.
 */
export async function handleInstruction(text: string, chatId: string | number, deps: Deps, recentContext = ''): Promise<{ replyText: string; files: string[]; dir: string; reason: string }> {
  // PERSISTENT per-chat working dir (not per-message) → follow-ups can read/modify
  // files from earlier turns. Absolute path (Windows spawnSync).
  const dir = resolve(deps.outRoot, `tg-${chatId}`);
  mkdirSync(dir, { recursive: true });
  const flat = (): string[] => { try { return readdirSync(dir).filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isFile()); } catch { return []; } };
  const before = new Map<string, number>();
  for (const f of flat()) { try { before.set(f, statSync(join(dir, f)).mtimeMs); } catch { /* */ } }
  const instruction = [
    recentContext ? `RECENT CONVERSATION (for follow-ups; the user may refer to it):\n${recentContext}` : '',
    text,
    'Your working directory persists across this conversation — files from earlier messages are already here; read or modify them for follow-ups, or create new ones. If something referenced is missing, just create it fresh.',
  ].filter(Boolean).join('\n\n');
  const r = await runAgent({
    instruction,
    dir, memory: deps.memory, brain: deps.brain, worker: deps.worker, tools: deps.registry,
    session: `tg-${chatId}`, // per-chat session → conversation continuity
    budget: { maxSteps: deps.maxSteps, maxWallMs: deps.maxMin * 60_000, consolidateEvery: 10 },
  });
  // deliver only files CREATED or MODIFIED this turn (the dir persists, so don't re-send old ones)
  const files = flat().filter((f) => { try { return !before.has(f) || statSync(join(dir, f)).mtimeMs > (before.get(f) ?? 0); } catch { return false; } });
  // If it produced files this turn, that's a success even if it didn't formally
  // say "done" (the deliverable is what matters) — present it positively.
  const produced = files.length > 0;
  const ok = r.reason === 'done' || produced;
  const reply = [
    `${ok ? '✅' : '⏹'} ${r.reason === 'done' ? r.summary : produced ? 'Done — produced the output below.' : r.summary}`,
    !ok && r.history.length ? `\n\n· ${r.history[r.history.length - 1].slice(0, 180).replace(/\n/g, ' ')}` : '',
    produced ? `\n\n📎 outputs: ${files.join(', ')}` : '',
    `\n\n(${r.steps} steps · ${Math.round(r.durationMs / 1000)}s · $${r.costUsd.toFixed(4)})`,
  ].join('');
  return { replyText: reply.slice(0, 3900), files, dir, reason: r.reason }; // Telegram msg cap 4096
}

export async function runTelegram(opts: { config: MwaConfig; dbPath?: string; maxSteps?: number; maxMin?: number; onLog?: (m: string) => void }): Promise<void> {
  loadEnv(); // pick up TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_CHATS from .env
  // tee logs to a file so they're visible even when stdout is buffered (background runs)
  const logFile = join(resolve(opts.config.workspace ?? './mwa-workspace'), 'connector.log');
  mkdirSync(resolve(opts.config.workspace ?? './mwa-workspace'), { recursive: true });
  const log = (m: string) => { (opts.onLog ?? ((s: string) => console.log(s)))(m); try { appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* */ } };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN (get a token from @BotFather).');
  const allowed = new Set((process.env.TELEGRAM_ALLOWED_CHATS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  const me = await tg(token, 'getMe');
  log(`connected as @${me.username}`);
  log(allowed.size ? `authorized chats: ${[...allowed].join(', ')}` : '⚠ TELEGRAM_ALLOWED_CHATS not set — all chats rejected until you add yours (message the bot to learn your chat id)');

  const brain = new RoutedProvider(getProvider('brain'), getProvider('high')); // conductor escalates on struggle/filter
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const memory = new MwaMemory('mwa-agent', opts.dbPath ?? './data/agent.db', opts.config.awm.workspace);
  const { registry } = await buildRegistry(opts.config);
  const deps: Deps = { memory, brain, worker, registry, maxSteps: opts.maxSteps ?? 40, maxMin: opts.maxMin ?? 10, outRoot: join(opts.config.workspace ?? './mwa-workspace', 'outputs') };

  const convo = new Map<string, { u: string; a: string }[]>(); // per-chat recent exchanges (multi-turn)
  const sessionStats = { tasks: 0, started: Date.now() };
  const statusText = () => [
    '📊 Status',
    `· tasks this session: ${sessionStats.tasks}`,
    `· uptime: ${Math.round((Date.now() - sessionStats.started) / 60_000)}m`,
    `· brain: ${deps.brain.id}`,
    `· tools: ${deps.registry.names().join(', ')}`,
  ].join('\n');

  // Scheduler: fire due AWM tasks and proactively deliver results to the right chat.
  void runScheduler({
    memory, brain, worker, tools: registry, outRoot: deps.outRoot,
    maxSteps: deps.maxSteps, maxMin: deps.maxMin, intervalMs: 60_000, onLog: log,
    onFire: async (task, res) => {
      const chatId = (task.notify ?? '').startsWith('tg-') ? task.notify!.slice(3) : null;
      if (!chatId) return;
      const text = `⏰ Scheduled: ${task.instruction.slice(0, 80)}\n\n${res.summary}`.slice(0, 3900);
      await tg(token, 'sendMessage', { chat_id: chatId, text }).catch(() => {});
      for (const f of res.files.slice(0, 5)) { try { const p = join(res.dir, f); if (statSync(p).isFile() && statSync(p).size < 10_000_000) await sendDocument(token, chatId, p); } catch { /* */ } }
    },
  });

  let offset = 0;
  for (;;) {
    let updates: any[];
    try { updates = await tg(token, 'getUpdates', { offset, timeout: 30 }); }
    catch (e) { log(`poll error: ${(e as Error).message.slice(0, 100)}`); await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text) continue;
      const chatId = msg.chat.id;
      if (!allowed.has(String(chatId))) {
        await tg(token, 'sendMessage', { chat_id: chatId, text: `Not authorized. Your chat id is ${chatId} — add it to TELEGRAM_ALLOWED_CHATS to use this agent.` }).catch(() => {});
        continue;
      }
      const textIn = msg.text.trim();
      log(`msg from ${chatId}: ${textIn.slice(0, 60)}`);
      // Slash commands — answered directly, no agent run.
      if (textIn === '/start' || textIn === '/help') { await tg(token, 'sendMessage', { chat_id: chatId, text: HELP_TEXT }).catch(() => {}); continue; }
      if (textIn === '/status') { await tg(token, 'sendMessage', { chat_id: chatId, text: statusText() }).catch(() => {}); continue; }

      sessionStats.tasks++;
      await tg(token, 'sendMessage', { chat_id: chatId, text: '🤖 on it…' }).catch(() => {});
      try {
        const recent = (convo.get(String(chatId)) ?? []).slice(-3).map((x) => `You: ${x.u}\nAgent: ${x.a}`).join('\n');
        const { replyText, files, dir } = await handleInstruction(textIn, chatId, deps, recent);
        log(`reply to ${chatId}: ${replyText.replace(/\n/g, ' ').slice(0, 200)}`);
        await tg(token, 'sendMessage', { chat_id: chatId, text: replyText });
        // Deliver output files (up to 5, under 10MB) as Telegram documents.
        for (const f of files.slice(0, 5)) {
          try { const p = join(dir, f); if (statSync(p).isFile() && statSync(p).size < 10_000_000) await sendDocument(token, chatId, p); }
          catch (e) { log(`sendDocument ${f} failed: ${(e as Error).message.slice(0, 80)}`); }
        }
        // Remember the exchange for follow-ups.
        const arr = convo.get(String(chatId)) ?? []; arr.push({ u: textIn, a: replyText.slice(0, 300) }); if (arr.length > 6) arr.shift(); convo.set(String(chatId), arr);
      } catch (e) {
        await tg(token, 'sendMessage', { chat_id: chatId, text: `error: ${(e as Error).message.slice(0, 200)}` }).catch(() => {});
      }
    }
  }
}
