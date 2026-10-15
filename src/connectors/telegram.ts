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
import { preparePersonTurn, learnFromTurn } from '../person-turn.js';
import { runScheduler } from '../scheduler.js';
import { loadEnv } from '../env.js';
import type { ToolRegistry } from '../tools/registry.js';
import { pendingMeta, confirmPending, cancelPending } from '../tools/approval.js';

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

/**
 * APPROVAL BUTTONS (BL-03). The model cannot approve anything; a person does, here, by tapping a
 * button the connector sent. Telegram delivers the tap to this process (the bot token is the
 * authentication), and an id is honored only from the chat it was offered to, once.
 */
export function approvalKeyboard(id: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return { inline_keyboard: [[{ text: '✅ Approve', callback_data: `ap:${id}` }, { text: '✖ Cancel', callback_data: `cx:${id}` }]] };
}

/** The card for one pending action — plain text (no parse_mode), so a preview can't restyle itself. */
export function approvalCardText(id: string): string | null {
  const m = pendingMeta(id);
  if (!m) return null;
  return [
    `🔐 Needs your approval: ${m.kind === 'captured-policy' ? 'a standing preference' : m.tool}`,
    '',
    m.summary.slice(0, 3000),
    m.tainted ? '\n⚠ Proposed by a run that read outside content (an email, a web page or a file). Make sure it is what you want.' : '',
  ].filter((x) => x !== '').join('\n');
}

/** Where an approval card was sent: its chat, and the card's own message (BL-03 review — a look-alike
 *  card carrying the same callback data, sent by anything holding the bot token, is not honored). */
export interface Offer { chat: string; message?: number }

/** Handle an Approve/Cancel tap. `offered` maps action id → the card it was offered on. */
export async function handleApprovalCallback(data: string, chatId: string, offered: Map<string, Offer>, dir: string, messageId?: number): Promise<string> {
  const m = /^(ap|cx):(act_[0-9a-f]{16})$/.exec(data);
  if (!m) return '(not an approval button)';
  const [, verb, id] = m;
  const offer = offered.get(id);
  if (!offer || offer.chat !== chatId) return '(that approval was not offered in this chat)';
  if (offer.message !== undefined && offer.message !== messageId) return '(that is not the card this approval was offered on)';
  const out = verb === 'cx' ? cancelPending(id) : await confirmPending(id, { sandboxDir: dir, interactive: true });
  if (!pendingMeta(id)) offered.delete(id); // used up (run, cancelled or expired); a step-up block keeps it
  return out;
}

interface Deps { memory: MwaMemory; brain: Provider; worker: Provider; registry: ToolRegistry; maxSteps: number; maxMin: number; outRoot: string }

/**
 * Testable core: an instruction from a chat → run the agent → format a reply.
 * Channel-agnostic; the Telegram loop just transports text in/out.
 */
export async function handleInstruction(text: string, chatId: string | number, deps: Deps, recentContext = '', recentTainted = false): Promise<{ replyText: string; files: string[]; dir: string; reason: string; tainted: boolean; staged: string[] }> {
  // PERSISTENT per-chat working dir (not per-message) → follow-ups can read/modify
  // files from earlier turns. Absolute path (Windows spawnSync).
  const dir = resolve(deps.outRoot, `tg-${chatId}`);
  mkdirSync(dir, { recursive: true });
  const flat = (): string[] => { try { return readdirSync(dir).filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isFile()); } catch { return []; } };
  const before = new Map<string, number>();
  for (const f of flat()) { try { before.set(f, statSync(join(dir, f)).mtimeMs); } catch { /* */ } }
  const instruction = [
    // A tainted earlier turn's reply goes in fenced via `carried`, not here (BL-17).
    recentContext && !recentTainted ? `RECENT CONVERSATION (for follow-ups; the user may refer to it):\n${recentContext}` : '',
    text,
    'Your working directory persists across this conversation — files from earlier messages are already here; read or modify them for follow-ups, or create new ones. If something referenced is missing, just create it fresh.',
  ].filter(Boolean).join('\n\n');
  // Per-person Profile: this chat IS a person (tg-<chatId>) → adapt + learn. channelVerified: Telegram
  // authenticated this chat id, so it's recorded as a validated connection for out-of-band step-up (S6 v2).
  const prepared = await preparePersonTurn(deps.memory, { channel: 'tg', id: chatId }, text, { channelVerified: true });
  const r = await runAgent({
    instruction, userMessage: text,
    ...(recentContext && recentTainted ? { carried: `RECENT CONVERSATION (for follow-ups):\n${recentContext}`, startTainted: true } : {}),
    dir, memory: deps.memory, brain: deps.brain, worker: deps.worker, tools: deps.registry,
    session: `tg-${chatId}`, // per-chat session → conversation continuity
    personContext: prepared.personContext, // who I'm talking to (redacted on identity mismatch)
    personId: prepared.personId, identityInDoubt: prepared.mismatch, // S6 v2: arm the step-up gate on Telegram too
    interactive: true, // a human is on the other end of the chat → ask_user / confirm can involve them
    budget: { maxSteps: deps.maxSteps, maxWallMs: deps.maxMin * 60_000, consolidateEvery: 10 },
  });
  // learn about them + recompress dossier — but not from a reply that read external content (BL-17)
  if (!r.tainted) await learnFromTurn(deps.brain, deps.memory, prepared, text, r.summary);
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
  return { replyText: reply.slice(0, 3900), files, dir, reason: r.reason, tainted: r.tainted === true, staged: r.staged ?? [] }; // Telegram msg cap 4096
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
  const { registry } = await buildRegistry(opts.config, memory);
  const deps: Deps = { memory, brain, worker, registry, maxSteps: opts.maxSteps ?? 40, maxMin: opts.maxMin ?? 10, outRoot: join(opts.config.workspace ?? './mwa-workspace', 'outputs') };

  // Approvals offered (BL-03): action id → the chat and card its buttons were sent on.
  const offered = new Map<string, Offer>();
  const offerApprovals = async (chatId: string, ids: string[]): Promise<void> => {
    for (const id of ids.slice(0, 5)) {
      const text = approvalCardText(id);
      if (!text) continue;
      try {
        const sent = await tg(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 3900), reply_markup: approvalKeyboard(id) });
        offered.set(id, { chat: chatId, message: Number(sent?.message_id) || undefined });
      } catch (e) { log(`approval card failed: ${(e as Error).message.slice(0, 80)}`); }
    }
  };
  const convo = new Map<string, { u: string; a: string; t?: boolean }[]>(); // per-chat recent exchanges (multi-turn); t = that turn read external content
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
      await offerApprovals(chatId, res.staged ?? []);
    },
  });

  let offset = 0;
  for (;;) {
    let updates: any[];
    try { updates = await tg(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }); }
    catch (e) { log(`poll error: ${(e as Error).message.slice(0, 100)}`); await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      // An Approve/Cancel tap — handled here, never by the model (BL-03).
      const cq = u.callback_query;
      if (cq) {
        const cqChat = String(cq.message?.chat?.id ?? '');
        const ok = allowed.has(cqChat);
        const out = ok ? await handleApprovalCallback(String(cq.data ?? ''), cqChat, offered, resolve(deps.outRoot, `tg-${cqChat}`), cq.message?.message_id) : '(not authorized)';
        log(`approval tap in ${cqChat}: ${String(cq.data ?? '').slice(0, 30)} → ${out.replace(/\n/g, ' ').slice(0, 100)}`);
        await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: out.slice(0, 190) }).catch(() => {});
        // A step-up block keeps the buttons: the person verifies, then taps Approve again.
        if (ok && cq.message && !out.startsWith('(blocked:')) {
          await tg(token, 'editMessageReplyMarkup', { chat_id: cqChat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await tg(token, 'sendMessage', { chat_id: cqChat, text: out.slice(0, 3900) }).catch(() => {});
        }
        continue;
      }
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
        const turns = (convo.get(String(chatId)) ?? []).slice(-3);
        const recent = turns.map((x) => `You: ${x.u}\nAgent: ${x.a}`).join('\n');
        const { replyText, files, dir, tainted, staged } = await handleInstruction(textIn, chatId, deps, recent, turns.some((x) => x.t));
        log(`reply to ${chatId}: ${replyText.replace(/\n/g, ' ').slice(0, 200)}`);
        await tg(token, 'sendMessage', { chat_id: chatId, text: replyText });
        // Deliver output files (up to 5, under 10MB) as Telegram documents.
        for (const f of files.slice(0, 5)) {
          try { const p = join(dir, f); if (statSync(p).isFile() && statSync(p).size < 10_000_000) await sendDocument(token, chatId, p); }
          catch (e) { log(`sendDocument ${f} failed: ${(e as Error).message.slice(0, 80)}`); }
        }
        await offerApprovals(String(chatId), staged);
        // Remember the exchange for follow-ups.
        const arr = convo.get(String(chatId)) ?? []; arr.push({ u: textIn, a: replyText.slice(0, 300), t: tainted }); if (arr.length > 6) arr.shift(); convo.set(String(chatId), arr);
      } catch (e) {
        await tg(token, 'sendMessage', { chat_id: chatId, text: `error: ${(e as Error).message.slice(0, 200)}` }).catch(() => {});
      }
    }
  }
}
