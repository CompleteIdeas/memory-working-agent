// Arm C of the promise assessment: a plain model + cron, what a person could set up themselves.
// The same model and client as MWA (src/provider.ts getProvider('brain')), the same world tools, a
// scheduler with the same options as MWA's `schedule`, one running conversation (the last 60
// messages, scheduled results included) and nothing else: no memory store, no gates, no compaction.
import { makeWorld, stamp } from './world.mjs';
import { appendFileSync } from 'node:fs';

const THREAD_MAX = 60;
const MAX_STEPS = 12;

export async function makeCronArm({ worldFile, logFile, runLog, persona }) {
  const { getProvider } = await import('../src/provider.ts');
  const { nowLine, parseLocalAt, localStamp } = await import('../src/agent.ts');
  const brain = getProvider('brain');
  const { tools: world } = makeWorld(worldFile, logFile);
  const thread = []; // {role, content}
  const jobs = []; // {id, instruction, due, recur}
  const deliveries = []; // {vt, text, job}
  let seq = 0;

  const nextDaily = (hhmm, from) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(from); d.setHours(h || 0, m || 0, 0, 0); let t = d.getTime(); if (t <= from) t += 86_400_000; return t; };
  const scheduleTools = {
    schedule: {
      description: 'Schedule an instruction to run later; when it runs, its reply is sent to the person. Use in_minutes (one-shot delay), at "YYYY-MM-DD HH:MM" (one-shot, local time), daily_at "HH:MM" (every day), or every_minutes (repeating).',
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
  const defs = Object.entries(all).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }));
  const system = () => [
    `You are ${persona.name}'s personal assistant. You can search and read their email, look at their calendar, open web pages, draft emails (drafts are never sent; ${persona.name.split(' ')[0]} sends them), and schedule tasks that run later; a scheduled task's reply is sent to ${persona.name.split(' ')[0]}.`,
    'If a scheduled task finds nothing worth telling, reply with exactly NOTHING and no message is sent.',
    nowLine(Date.now()),
  ].join('\n');

  async function loop(input, label) {
    const t0 = Date.now(); let cost = 0; const used = [];
    let transcript = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const msgs = [...thread.slice(-THREAD_MAX), { role: 'user', content: transcript ? `${input}\n\nYOUR TOOL CALLS SO FAR THIS TURN:\n${transcript}\n\nContinue: call another tool, or reply to ${persona.name.split(' ')[0]}.` : input }];
      const out = await brain.chat({ system: system(), messages: msgs, tools: defs, maxTokens: 900 });
      cost += (out.usage.input * brain.price[0] + out.usage.output * brain.price[1]) / 1_000_000;
      if (!out.toolCalls?.length) {
        const reply = String(out.text ?? '').trim();
        if (runLog) appendFileSync(runLog, JSON.stringify({ ts: t0, vts: stamp(t0), label, steps: step + 1, tools: used, costUsd: Number(cost.toFixed(5)), reply: reply.slice(0, 300) }) + '\n');
        return { reply, cost, tools: used };
      }
      for (const c of out.toolCalls) {
        used.push(c.name);
        let res;
        try { res = all[c.name] ? String(all[c.name].run(c.args ?? {})) : `unknown tool ${c.name}`; } catch (e) { res = `error: ${e.message}`; }
        transcript += `- ${c.name}(${JSON.stringify(c.args ?? {}).slice(0, 300)}) → ${res.slice(0, 2500)}\n`;
      }
    }
    if (runLog) appendFileSync(runLog, JSON.stringify({ ts: t0, vts: stamp(t0), label, steps: MAX_STEPS, tools: used, costUsd: Number(cost.toFixed(5)), reply: '(step limit)' }) + '\n');
    return { reply: '(I ran out of steps.)', cost, tools: used };
  }

  return {
    name: 'cron',
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
