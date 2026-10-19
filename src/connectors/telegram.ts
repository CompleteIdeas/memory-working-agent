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
import { pendingMeta, confirmPending, cancelPending, claimOffer, setOfferMessage, releaseOffer, offerOf, unofferedFor, approvalStatus, setApprovalOwner, setApprovalStorePath, runApproved } from '../tools/approval.js';
import { dirname } from 'node:path';
import { isQuietNow, holdPush, flushHeld, firesOf } from '../quiet.js';
import { recordReceipt, setReceiptProducer } from '../receipts.js';
import { setTranscriptProducer } from '../transcript.js';

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

/** Who may tap Approve: the allowlisted chats (a private chat's id IS its person's id) plus
 *  TELEGRAM_ALLOWED_USERS. In an allowlisted GROUP chat the tapper must be allowed individually, so any
 *  member of the group can't approve (BL-03 review). */
export function approversFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const list = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return new Set([...list(env.TELEGRAM_ALLOWED_CHATS), ...list(env.TELEGRAM_ALLOWED_USERS)]);
}

/** Handle an Approve/Cancel tap. The offer — the chat and the card it went out as — lives in the shared
 *  approval store (BL-18), so a card sent before a restart, or by another process, still works, and a
 *  look-alike card carrying the same callback data is not honored. */
export async function handleApprovalCallback(data: string, chatId: string, dir: string, messageId: number | undefined, from: { userId?: string | number; approvers: Set<string> }): Promise<string> {
  const m = /^(ap|cx):(act_[0-9a-f]{16})$/.exec(data);
  if (!m) return '(not an approval button)';
  const [, verb, id] = m;
  // Required, never optional: an approver check that can be left out fails open (BL-18 review).
  if (!from.approvers.has(String(from.userId ?? ''))) return '(you are not allowed to approve actions here)';
  const offer = offerOf(id);
  if (offer.chat !== chatId) return '(that approval was not offered in this chat)';
  if (offer.message !== undefined && offer.message !== messageId) return '(that is not the card this approval was offered on)';
  return verb === 'cx' ? cancelPending(id) : await confirmPending(id, { sandboxDir: dir, interactive: true });
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
    dir, memory: deps.memory, brain: deps.brain, worker: deps.worker, tools: deps.registry, transcript: true, // BL-10
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
  setReceiptProducer('telegram'); // BL-13: this process's own receipts file
  setTranscriptProducer('telegram'); // BL-10: and its own run transcripts

  const me = await tg(token, 'getMe');
  log(`connected as @${me.username}`);
  log(allowed.size ? `authorized chats: ${[...allowed].join(', ')}` : '⚠ TELEGRAM_ALLOWED_CHATS not set — all chats rejected until you add yours (message the bot to learn your chat id)');

  const brain = new RoutedProvider(getProvider('brain'), getProvider('high')); // conductor escalates on struggle/filter
  const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
  const memory = new MwaMemory('mwa-agent', opts.dbPath ?? './data/agent.db', opts.config.awm.workspace);
  // Approvals: this process owns what it stages under its memory identity, and shares the store with
  // the web app — beside the agent DB it was given, not wherever the working directory points (BL-18).
  setApprovalOwner('mwa-agent');
  if (!process.env.MWA_APPROVALS_DB) setApprovalStorePath(resolve(dirname(opts.dbPath ?? './data/agent.db'), 'approvals.db'));
  const { registry } = await buildRegistry(opts.config, memory);
  const deps: Deps = { memory, brain, worker, registry, maxSteps: opts.maxSteps ?? 40, maxMin: opts.maxMin ?? 10, outRoot: join(opts.config.workspace ?? './mwa-workspace', 'outputs') };

  // Approval cards (BL-18): each action is offered once, by whichever process claims it first in the
  // shared store, and the card's chat + message are recorded there.
  const approvers = approversFromEnv();
  const offerApprovals = async (chatId: string, ids: string[]): Promise<void> => {
    for (const id of ids.slice(0, 5)) {
      const text = approvalCardText(id);
      if (!text || !claimOffer(id, chatId)) continue;
      try {
        const sent = await tg(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 3900), reply_markup: approvalKeyboard(id) });
        if (Number(sent?.message_id)) setOfferMessage(id, Number(sent.message_id));
      } catch (e) { releaseOffer(id); log(`approval card failed: ${(e as Error).message.slice(0, 80)}`); }
    }
  };
  // Actions staged for one of these chats by ANY process — the web app's scheduler firing a Telegram
  // job, or this process before a restart — that nobody has offered yet.
  const offerWaiting = async (): Promise<void> => {
    try {
      for (const id of unofferedFor([...allowed].map((c) => `tg-${c}`))) {
        const session = pendingMeta(id)?.session ?? '';
        await offerApprovals(session.slice(3), [id]);
      }
    } catch (e) { log(`offer sweep failed: ${(e as Error).message.slice(0, 80)}`); }
  };
  /** Send a result: the message, up to 5 files under 10 MB, then any approval cards. Says whether
   *  Telegram ACCEPTED the message (BL-13) — it used to swallow the failure and report nothing. */
  const deliverPush = async (chatId: string, text: string, files: string[], approvals: string[]): Promise<{ ok: boolean; error?: string }> => {
    try { await tg(token, 'sendMessage', { chat_id: chatId, text }); }
    catch (e) { return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160) }; }
    for (const p of files) { try { if (statSync(p).isFile() && statSync(p).size < 10_000_000) await sendDocument(token, chatId, p); } catch { /* */ } }
    await offerApprovals(chatId, approvals);
    return { ok: true };
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
    // BL-10: a chat or job cut off by a restart and not resumed — tell the chat it came from.
    onInterrupted: async (x) => {
      const chat = (x.session ?? '').startsWith('tg-') ? x.session!.slice(3) : null;
      if (!chat || !allowed.has(chat)) return;
      await tg(token, 'sendMessage', { chat_id: chat, text: `⚠ Interrupted by a restart: ${x.instruction.slice(0, 120)}\n\n${x.jobId ? (x.recurring ? 'Its next scheduled run will pick the work up.' : 'This scheduled job has used its resumes, so it was not started again.') : 'It was not started again — send it again if you still want it.'}${x.unfinished ? `\n${x.unfinished} step(s) had started without a recorded result: check whether they happened.` : ''}`.slice(0, 3900) }).catch(() => {});
    },
    onFire: async (task, res) => {
      const chatId = (task.notify ?? '').startsWith('tg-') ? task.notify!.slice(3) : null;
      const job = res.job ?? task.resumeOf ?? task.id, fire = res.fire ?? `${job.slice(0, 8)}-${Date.now()}`;
      if (!chatId) { recordReceipt({ job, fire, channel: 'none', status: 'failed', detail: 'no chat to send it to' }); return; }
      // A reminder (BL-43) is its own text — "⏰ Scheduled: X" over "Reminder: X" said it twice.
      const text = (task.kind === 'reminder' ? `⏰ ${res.summary}` : `⏰ Scheduled: ${task.instruction.slice(0, 80)}\n\n${res.summary}`).slice(0, 3900);
      const files = res.files.slice(0, 5).map((f) => join(res.dir, f));
      // Quiet hours (BL-07): the job ran on time; its message waits for the morning unless urgent.
      if (isQuietNow() && !task.urgent) {
        // One held item per job: a later result replaces it and is counted, so a frequent monitor
        // doesn't queue a hundred messages overnight.
        try { holdPush({ chat: chatId, text, files, approvals: res.staged ?? [], key: task.resumeOf ?? task.id, job, fire }); }
        catch (e) { recordReceipt({ job, fire, channel: 'telegram', status: 'failed', detail: `could not hold it for quiet hours: ${(e as Error).message}` }); return; }
        recordReceipt({ job, fire, channel: 'telegram', status: 'held', detail: 'quiet hours' });
        log(`· held for quiet hours: ${task.instruction.slice(0, 40)}`);
        return;
      }
      const sent = await deliverPush(chatId, text, files, res.staged ?? []);
      if (sent.ok) recordReceipt({ job, fire, channel: 'telegram', status: 'sent' });
      else {
        // Not lost: held, so the flush retries it with Telegram's own answer deciding (a blocked chat
        // is dropped, a rate limit waits, anything else is retried and given up on after five tries).
        // (If Telegram did accept it and only the reply was lost, the retry sends a duplicate: at least once, never zero.)
        try { holdPush({ chat: chatId, text, files, approvals: res.staged ?? [], key: task.resumeOf ?? task.id, job, fire }); }
        catch (e) { recordReceipt({ job, fire, channel: 'telegram', status: 'failed', detail: `${sent.error}; could not hold it to retry: ${(e as Error).message}` }); return; }
        recordReceipt({ job, fire, channel: 'telegram', status: 'held', detail: `send failed, will retry: ${sent.error}` });
        log(`· send failed, held to retry: ${task.instruction.slice(0, 40)} — ${sent.error}`);
      }
    },
  });

  let offset = 0;
  let flushNotBefore = 0; // after a Telegram rate limit, held messages wait this long
  for (;;) {
    let updates: any[];
    try { updates = await tg(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }); }
    catch (e) { log(`poll error: ${(e as Error).message.slice(0, 100)}`); await new Promise((r) => setTimeout(r, 3000)); continue; }
    // Quiet hours (BL-07): no cards or held results during the window; when it ends, what was held goes
    // out, oldest first, with one "while it was quiet" line for a chat that has more than three.
    const quiet = isQuietNow();
    if (!quiet) {
      if (Date.now() >= flushNotBefore) try {
        // The text must be ACCEPTED (tg throws otherwise), or the item stays for the next poll — a rate
        // limit can't make a held message vanish. Paced at about one a second per chat, Telegram's
        // guidance; files and cards are best-effort (cards are re-offered from the store anyway).
        const flushed = await flushHeld(
          async (i) => {
            const n = (i.count ?? 1) > 1 ? `\n\n(${i.count} results from this job while it was quiet — this is the latest)` : '';
            await tg(token, 'sendMessage', { chat_id: i.chat, text: `${i.text}${n}`.slice(0, 3900) });
            if (i.job && i.fire) {
              recordReceipt({ job: i.job, fire: i.fire, channel: 'telegram', status: 'sent', detail: 'after being held' });
              for (const f of i.replaced ?? []) recordReceipt({ job: i.job, fire: f, channel: 'telegram', status: 'superseded' });
            }
            for (const p of i.files ?? []) { try { if (statSync(p).isFile() && statSync(p).size < 10_000_000) await sendDocument(token, i.chat, p); } catch { /* */ } }
            await offerApprovals(i.chat, i.approvals ?? []);
            await new Promise((r) => setTimeout(r, 1100));
          },
          async (chat, n) => { await tg(token, 'sendMessage', { chat_id: chat, text: `🌅 ${n} messages arrived while it was quiet:` }); },
          (chat) => allowed.has(chat),
          // Telegram's own answer decides: a rate limit pauses the whole flush for its retry_after; a
          // chat that is gone or blocked the bot can never receive it, so the item is dropped.
          (err) => {
            const msg = String((err as Error)?.message ?? err);
            const ra = /retry after (\d+)/i.exec(msg);
            if (ra || /too many requests/i.test(msg)) return { action: 'stop', retryAfterMs: (ra ? Number(ra[1]) : 30) * 1000 };
            if (/chat not found|bot was blocked|forbidden|kicked|deactivated/i.test(msg)) return { action: 'drop' };
            return { action: 'skip' };
          },
          20, // per poll: the person's own messages interleave with a long morning queue
          log,
          // BL-13: a held result that can never arrive says so in its receipt.
          (items, why, status) => { for (const i of items) if (i.job) for (const f of firesOf(i)) recordReceipt({ job: i.job, fire: f, channel: 'telegram', status, detail: why.slice(0, 160) }); },
        );
        if (flushed.retryAfterMs) flushNotBefore = Date.now() + flushed.retryAfterMs;
      } catch (e) { log(`held-message flush failed: ${(e as Error).message.slice(0, 80)}`); }
      await offerWaiting();
    }
    // Actions this process owns that a person approved elsewhere (the web app): run them here,
    // against this process's memory, and report back in the chat that asked.
    try {
      for (const r of await runApproved()) {
        const chat = (r.session ?? '').startsWith('tg-') ? r.session!.slice(3) : null;
        log(`approved elsewhere, ran here: ${r.tool} → ${r.ok ? 'done' : 'failed'}`);
        const msg = `${r.ok ? '✅' : '⚠'} Approved in the app: ${r.tool}\n\n${r.result}`.slice(0, 3900);
        if (chat && allowed.has(chat)) {
          if (quiet) holdPush({ chat, text: msg });
          else await tg(token, 'sendMessage', { chat_id: chat, text: msg }).catch(() => {});
        }
      }
    } catch (e) { log(`approved-actions sweep failed: ${(e as Error).message.slice(0, 80)}`); }
    for (const u of updates) {
      offset = u.update_id + 1;
      // An Approve/Cancel tap — handled here, never by the model (BL-03).
      const cq = u.callback_query;
      if (cq) {
        const cqChat = String(cq.message?.chat?.id ?? '');
        const ok = allowed.has(cqChat);
        const out = ok ? await handleApprovalCallback(String(cq.data ?? ''), cqChat, resolve(deps.outRoot, `tg-${cqChat}`), cq.message?.message_id, { userId: cq.from?.id, approvers }) : '(not authorized)';
        log(`approval tap in ${cqChat}: ${String(cq.data ?? '').slice(0, 30)} → ${out.replace(/\n/g, ' ').slice(0, 100)}`);
        await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: out.slice(0, 190) }).catch(() => {});
        // Clear the buttons only once the action is no longer waiting: a tap from someone not allowed,
        // or a step-up block, must not take the approver's only button away (BL-18 review). Step-up is
        // completed in the web app, which can then approve it there.
        const m = /^(?:ap|cx):(act_[0-9a-f]{16})$/.exec(String(cq.data ?? ''));
        if (ok && cq.message && m && approvalStatus(m[1])?.status !== 'pending') {
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
