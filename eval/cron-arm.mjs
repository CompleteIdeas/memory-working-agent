// Arm C of the promise assessment: a plain model + cron, what a person could set up themselves.
// The same Azure deployment as MWA, called the ordinary way (chat/completions with native tool calls,
// the API's default reasoning), the same world tools, a scheduler with the same options as MWA's
// `schedule`, and one running conversation: the last 60 messages, scheduled results included. No
// memory store, no gates, no compaction.
//
// Pilot, 2026-10-19: a first version replayed tool results as text in the next user message (MWA's
// own prompt style) and the model re-called schedule after it had succeeded — duplicate jobs. That
// was the harness, not the baseline; this one uses the standard tool-message loop.
import { makeWorld, stamp } from './world.mjs';
import { appendFileSync, readFileSync } from 'node:fs';

const THREAD_MAX = 60;
const MAX_STEPS = 12;
const PRICE = [0.75, 4.5]; // per million tokens, as MWA prices this deployment (src/provider.ts)

function envFrom(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  return out;
}

// freshJobs (BL-53, arm C2 "cron-fresh"): a scheduled task runs with only its own instruction — no running
// conversation — while chats keep the thread and the task's reply still joins it. Tests whether the plain loop's
// invented details came from re-reading its own thread.
export async function makeCronArm({ worldFile, logFile, runLog, persona, envFile, freshJobs = false, model: spec = 'azure:gpt-5-4-mini' }) {
  const { nowLine, parseLocalAt, localStamp } = await import('../src/agent.ts');
  const env = envFrom(envFile);
  // BL-62 assessment: the same model as the MWA arms. OpenRouter runs on US hosts only, as MWA does (src/provider.ts).
  const viaOpenRouter = spec.startsWith('openrouter:');
  const base = viaOpenRouter ? 'https://openrouter.ai/api/v1' : env.AZURE_GPT_BASE_URL;
  const key = viaOpenRouter ? process.env.OPENROUTER_API_KEY : env.AZURE_GPT_API_KEY;
  const model = viaOpenRouter ? spec.slice('openrouter:'.length) : (env.AZURE_GPT_DEPLOYMENT || spec.replace(/^azure:/, ''));
  if (!base || !key) throw new Error(`cron arm: no endpoint or key for ${spec}`);
  const US_HOSTS = ['openai', 'anthropic', 'google-vertex/us', 'azure/us', 'amazon-bedrock/us-east-1', 'amazon-bedrock/us-east-2', 'amazon-bedrock/us-west-2'];
  const auth = viaOpenRouter ? { authorization: `Bearer ${key}` } : { 'api-key': key };
  const extra = viaOpenRouter ? { max_tokens: 6000, provider: { data_collection: 'deny', only: US_HOSTS, allow_fallbacks: false } } : { max_completion_tokens: 6000 };
  const { tools: world } = makeWorld(worldFile, logFile);
  const first = persona.name.split(' ')[0];
  const thread = []; // {role: 'user'|'assistant', content}
  const jobs = []; // {id, instruction, due, recur}
  const deliveries = [];
  let seq = 0;

  const nextDaily = (hhmm, from) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(from); d.setHours(h || 0, m || 0, 0, 0); let t = d.getTime(); if (t <= from) t += 86_400_000; return t; };
  const scheduleTools = {
    schedule: {
      description: `Schedule an instruction to run later; when it runs, its reply is sent to ${first}. Use in_minutes (one-shot delay), at "YYYY-MM-DD HH:MM" (one-shot, local time), daily_at "HH:MM" (every day), or every_minutes (repeating).`,
      parameters: { type: 'object', properties: { instruction: { type: 'string', description: 'what to do when it runs' }, in_minutes: { type: 'number' }, at: { type: 'string' }, daily_at: { type: 'string' }, every_minutes: { type: 'number' } }, required: ['instruction'] },
      run(a) {
        const now = Date.now(); let due = now + 60_000; let recur;
        if (typeof a.in_minutes === 'number') due = now + a.in_minutes * 60_000;
        else if (typeof a.at === 'string') { const t = parseLocalAt(a.at); if (t === null || t <= now) return `Not scheduled: "${a.at}" is ${t === null ? 'not a valid YYYY-MM-DD HH:MM' : 'in the past'}.`; due = t; }
        else if (typeof a.daily_at === 'string') { due = nextDaily(a.daily_at, now); recur = `daily:${a.daily_at}`; }
        else if (typeof a.every_minutes === 'number') { due = now + a.every_minutes * 60_000; recur = `every:${a.every_minutes}`; }
        const id = `j${++seq}`;
        jobs.push({ id, instruction: String(a.instruction), due, recur });
        return `Scheduled ${id} for ${localStamp(due)}${recur ? ` (${recur})` : ''}.`;
      },
    },
    schedule_list: {
      description: 'List scheduled jobs.', parameters: { type: 'object', properties: {} },
      run() { return jobs.length ? jobs.map((j) => `${j.id} | next ${localStamp(j.due)}${j.recur ? ` | ${j.recur}` : ''} | ${j.instruction}`).join('\n') : 'No scheduled jobs.'; },
    },
    schedule_cancel: {
      description: 'Cancel a scheduled job by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run(a) { const i = jobs.findIndex((j) => j.id === a.id); if (i < 0) return `No job ${a.id}.`; jobs.splice(i, 1); return `Cancelled ${a.id}.`; },
    },
  };
  const all = { ...world, ...scheduleTools };
  const toolSpec = Object.entries(all).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));
  const system = () => [
    `You are ${persona.name}'s personal assistant. You can search and read their email, look at their calendar, open web pages, draft emails (drafts are never sent; ${first} sends them), and schedule tasks that run later; a scheduled task's reply is sent to ${first}.`,
    'If a scheduled task finds nothing worth telling, reply with exactly NOTHING and no message is sent.',
    nowLine(Date.now()),
  ].join('\n');

  // Rate limits (BL-53: eight runs in parallel exhausted six tries at an 8 s ceiling) get patient retries — up to
  // 12 tries with a 60 s ceiling. How the arm behaves is unchanged; only a transient 429 no longer ends the run.
  async function call(messages) {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(60_000, 1000 * attempt * attempt)));
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: toolSpec, tool_choice: 'auto', ...extra }),
        signal: AbortSignal.timeout(120_000),
      }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
      if (r.ok) return r.json();
      if (r.status && r.status < 500 && r.status !== 429) throw new Error(`azure ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    throw new Error('azure: retries exhausted');
  }

  async function loop(input, label) {
    const t0 = Date.now(); let cost = 0; const used = [];
    const history = freshJobs && label.startsWith('job:') ? [] : thread.slice(-THREAD_MAX);
    const msgs = [{ role: 'system', content: system() }, ...history, { role: 'user', content: input }];
    for (let step = 0; step < MAX_STEPS; step++) {
      const j = await call(msgs);
      // OpenRouter reports what the call cost; Azure is priced from tokens.
      cost += typeof j.usage?.cost === 'number' ? j.usage.cost : ((j.usage?.prompt_tokens ?? 0) * PRICE[0] + (j.usage?.completion_tokens ?? 0) * PRICE[1]) / 1_000_000;
      const m = j.choices?.[0]?.message ?? {};
      if (!m.tool_calls?.length) {
        const reply = String(m.content ?? '').trim();
        if (runLog) appendFileSync(runLog, JSON.stringify({ ts: t0, vts: stamp(t0), label, steps: step + 1, tools: used, costUsd: Number(cost.toFixed(5)), reply: reply.slice(0, 300) }) + '\n');
        return { reply, cost, tools: used };
      }
      msgs.push({ role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        const name = tc.function?.name; used.push(name);
        let args = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* */ }
        let res;
        try { res = all[name] ? String(all[name].run(args)) : `unknown tool ${name}`; } catch (e) { res = `error: ${e.message}`; }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: res.slice(0, 6000) });
        if (runLog) appendFileSync(runLog.replace(/runs\.jsonl$/, 'cron-trace.jsonl'), JSON.stringify({ vts: stamp(Date.now()), label, step, tool: name, args, res: res.slice(0, 300) }) + '\n');
      }
    }
    if (runLog) appendFileSync(runLog, JSON.stringify({ ts: t0, vts: stamp(t0), label, steps: MAX_STEPS, tools: used, costUsd: Number(cost.toFixed(5)), reply: '(step limit)' }) + '\n');
    return { reply: '(I ran out of steps.)', cost, tools: used };
  }

  return {
    name: freshJobs ? 'cron-fresh' : 'cron',
    async chat(_session, message) {
      const r = await loop(message, 'chat');
      thread.push({ role: 'user', content: message }, { role: 'assistant', content: r.reply });
      return { reply: r.reply, asked: /\?\s*$/.test(r.reply), tools: r.tools, costUsd: r.cost };
    },
    dueJobs() { return jobs.map((j) => ({ due: j.due, instruction: j.instruction })); },
    async fireDue() {
      const due = jobs.filter((j) => j.due <= Date.now());
      for (const j of due) {
        if (j.recur?.startsWith('daily:')) j.due = nextDaily(j.recur.slice(6), Date.now());
        else if (j.recur?.startsWith('every:')) j.due = Date.now() + Number(j.recur.slice(6)) * 60_000;
        else jobs.splice(jobs.indexOf(j), 1);
        const input = `[A task you scheduled earlier is due now: ${j.instruction}]`;
        const r = await loop(input, `job:${j.id}`);
        thread.push({ role: 'user', content: input }, { role: 'assistant', content: r.reply });
        if (r.reply && !/^\s*NOTHING\b/.test(r.reply)) deliveries.push({ ts: Date.now(), instruction: j.instruction, summary: r.reply, job: j.id, costUsd: r.cost });
      }
      return due.length;
    },
    deliveries() { return deliveries; },
  };
}
