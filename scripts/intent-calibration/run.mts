// BL-52 step 3: classify every labelled message with each candidate and score it.
//   npx tsx scripts/intent-calibration/run.mts [regex,azure,openrouter:<model>,...]
// azure = MWA's own deployment (AZURE_GPT_* in .env); openrouter:<model> uses USEA's key (eval/openrouter-key.mjs:
// USEA_OPENROUTER_API_KEY, as eval/score.mjs does). Clef is scored by clef.mjs when its allowance allows.
// Results: results/intent-cal-<candidate>.json (git-ignored with the rest of results/). Keys are never printed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asksForLater } from '../../src/claim-check.ts';
import { asksToChangeJob, expectedJobCount } from '../../src/schedule-request.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const items: { text: string; category: string; jobs: number; reminders: number }[] = JSON.parse(readFileSync(join(HERE, 'labeled.json'), 'utf8'));
const env: Record<string, string> = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { openRouterKey } = await import('../../eval/openrouter-key.mjs');
const orKey = openRouterKey();

export const SYSTEM = `You classify ONE message a person sent to their personal AI assistant, which can answer questions, draft emails, read their inbox and calendar, and run jobs on a schedule.
Answer with JSON only: {"category": "later" | "change_job" | "setting" | "now", "jobs": <integer>, "reminders": <integer>}

category:
- later: the person asks to SET UP something that happens later or repeatedly — a reminder, a one-off or recurring scheduled task, a recurring brief or plan, or a watch that tells them when something changes ("tell me if the price changes", "warn me before anything renews").
- change_job: the person changes or stops something ALREADY scheduled — its format, contents, scope or time ("from now on keep the plan to 3 bullets", "move my brief to 7:30", "cancel the reminder").
- setting: a general setting or preference, not a job (quiet hours, "don't message me before 7", "call me Rob", "never send without asking").
- now: anything to do or answer now — a question, a lookup, a draft, a file, or a reply to the assistant's question. Asking about the schedule ("what do I have scheduled?") is now. Words like "tell me when X happened" or "each hour in this log" are now.
jobs: for later, how many separate things to set up ("set two reminders: …" is 2); otherwise 0.
reminders: how many of those jobs are reminders — the person will do the thing themselves and only wants to be told at that time ("remind me to call the bank"). A job the assistant carries out (check a page, summarize the inbox, draft a reply) is not a reminder.`;

type Pred = { category: string; jobs: number; reminders: number; ms?: number; error?: string };

function regex(text: string): Pred {
  if (asksToChangeJob(text)) return { category: 'change_job', jobs: 0, reminders: 0 };
  if (asksForLater(text)) { const n = expectedJobCount(text) || 1; return { category: 'later', jobs: n, reminders: /\bremind/i.test(text) ? n : 0 }; }
  return { category: 'now', jobs: 0, reminders: 0 };
}

function parse(out: string): Pred {
  const m = /\{[\s\S]*\}/.exec(out);
  const o = m ? JSON.parse(m[0]) : {};
  return { category: String(o.category ?? 'now'), jobs: Number(o.jobs ?? 0) || 0, reminders: Number(o.reminders ?? 0) || 0 };
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(8000, 600 * attempt * attempt)));
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as any);
    if (r.ok) return r.json();
    if (r.status && r.status < 500 && r.status !== 429) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error('retries exhausted');
}

async function azure(text: string): Promise<Pred> {
  const j = await post(`${env.AZURE_GPT_BASE_URL}/chat/completions`, { 'api-key': env.AZURE_GPT_API_KEY }, {
    model: env.AZURE_GPT_DEPLOYMENT || 'gpt-5-4-mini', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
    max_completion_tokens: 2000, reasoning_effort: 'minimal', response_format: { type: 'json_object' },
  });
  return { ...parse(j.choices?.[0]?.message?.content ?? ''), usage: j.usage } as Pred;
}

async function openrouter(model: string, text: string): Promise<Pred> {
  const j = await post('https://openrouter.ai/api/v1/chat/completions', { authorization: `Bearer ${orKey}` }, {
    model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }], max_tokens: 1500, temperature: 0,
  });
  return { ...parse(j.choices?.[0]?.message?.content ?? ''), usage: j.usage } as Pred;
}

// Clef (Cloudflare Workers AI decision models): the same definitions as questions — a choice for the category, a
// yes-probability for "later" (so a threshold can be set), and choices for the counts.
const CF_TOKEN = process.env.CIDEAS_CLOUDFLARE_API_TOKEN ?? '';
const CF_ACCOUNT = process.env.CIDEAS_CLOUDFLARE_ACCOUNT_ID || '43a57685180f3a792bda82145d6cab20';
const COUNT = { '0': 'none', '1': 'one', '2': 'two', '3': 'three', '4': 'four or more' };
const CLEF_Q = {
  category: { type: 'choice', instructions: 'Which best describes what the person asks their AI assistant for in this message?', criteria: {
    later: 'To SET UP something that happens later or repeatedly: a reminder, a one-off or recurring scheduled task, a recurring brief or plan, or a watch that tells them when something changes ("tell me if the price changes", "warn me before anything renews")',
    change_job: 'To change or stop something ALREADY scheduled: its format, contents, scope or time ("from now on keep the plan to 3 bullets", "move my brief to 7:30", "cancel the reminder")',
    setting: 'A general setting or preference that is not a job (quiet hours, "don\'t message me before 7", "call me Rob", "never send without asking")',
    now: 'Something to do or answer now: a question, a lookup, a draft, a file, or a reply to the assistant\'s question. Asking about the schedule, "tell me when X happened" or "each hour in this log" is now',
  } },
  later: { type: 'noul', instructions: 'Does the person ask the assistant to set up something that will happen later or repeatedly (a reminder, a scheduled or recurring task, a recurring brief, or a watch that reports changes)? A question about the schedule, a one-off task done now, or a general setting is not.' },
  jobs: { type: 'choice', instructions: 'How many separate things does the person ask to be set up for later or to repeat? ("Set two reminders: …" is two.)', criteria: COUNT },
  reminders: { type: 'choice', instructions: 'How many of those are reminders — the person will do the thing themselves and only wants to be told at that time ("remind me to call the bank")? A job the assistant carries out (check a page, summarize the inbox, draft a reply) is not a reminder.', criteria: COUNT },
};
async function clef(model: string, text: string): Promise<Pred & { pLater?: number }> {
  const j = await post(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/cloudflare/${model}`, { authorization: `Bearer ${CF_TOKEN}` },
    { model, state: { message: text }, questions: CLEF_Q });
  if (j.success === false) throw new Error(JSON.stringify(j.errors ?? j).slice(0, 160));
  const a = j.result?.answers ?? {};
  const pick = (x: any) => String(x?.choice ?? x?.answer ?? '');
  return { category: pick(a.category) || 'now', jobs: Number(pick(a.jobs)) || 0, reminders: Number(pick(a.reminders)) || 0, pLater: Number(a.later?.noul ?? NaN), raw: a } as Pred & { pLater?: number };
}

const which = (process.argv[2] ?? 'regex,azure').split(',');
for (const cand of which) {
  const file = join(ROOT, 'results', `intent-cal-${cand.replace(/[^a-z0-9.-]+/gi, '_')}.json`);
  const preds: Pred[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  for (let i = preds.length; i < items.length; i++) {
    const t0 = Date.now();
    try {
      const p = cand === 'regex' ? regex(items[i].text) : cand === 'azure' ? await azure(items[i].text)
        : cand.startsWith('clef:') ? await clef(cand.slice('clef:'.length), items[i].text) : await openrouter(cand.slice('openrouter:'.length), items[i].text);
      preds.push({ ...p, ms: Date.now() - t0 });
    } catch (e) { preds.push({ category: 'error', jobs: 0, reminders: 0, error: (e as Error).message.slice(0, 160) }); }
    if (i % 10 === 9) writeFileSync(file, JSON.stringify(preds));
  }
  writeFileSync(file, JSON.stringify(preds));
  // Score.
  const isLater = (c: string) => c === 'later';
  const tp = items.filter((x, i) => isLater(x.category) && isLater(preds[i].category)).length;
  const fn = items.filter((x, i) => isLater(x.category) && !isLater(preds[i].category));
  const fp = items.filter((x, i) => !isLater(x.category) && isLater(preds[i].category));
  const laterN = items.filter((x) => isLater(x.category)).length, otherN = items.length - laterN;
  const ch = (c: string) => c === 'change_job';
  const chTp = items.filter((x, i) => ch(x.category) && ch(preds[i].category)).length, chN = items.filter((x) => ch(x.category)).length;
  const chFp = items.filter((x, i) => !ch(x.category) && ch(preds[i].category));
  const both = items.map((x, i) => [x, preds[i]] as const).filter(([x, p]) => isLater(x.category) && isLater(p.category));
  const jobsOk = both.filter(([x, p]) => x.jobs === p.jobs).length, remOk = both.filter(([x, p]) => x.reminders === p.reminders).length;
  const exact = items.filter((x, i) => x.category === preds[i].category).length;
  const errors = preds.filter((p) => p.error).length;
  const ms = preds.map((p) => p.ms ?? 0).sort((a, b) => a - b)[Math.floor(preds.length / 2)];
  console.log(`\n== ${cand}${errors ? ` (${errors} errors)` : ''}  median ${ms} ms`);
  console.log(`later: recall ${tp}/${laterN} (${Math.round(100 * tp / laterN)}%), false triggers ${fp.length}/${otherN} (${(100 * fp.length / otherN).toFixed(1)}%)`);
  console.log(`change_job: recall ${chTp}/${chN}, false ${chFp.length}`);
  console.log(`all four categories exact: ${exact}/${items.length}; on later-and-later: jobs ${jobsOk}/${both.length}, reminders ${remOk}/${both.length}`);
  for (const x of fn) console.log(`  MISSED later: ${x.text.slice(0, 110)}`);
  for (const x of fp) console.log(`  FALSE later: ${x.text.slice(0, 110)}`);
  for (const [x, p] of both) if (x.jobs !== p.jobs || x.reminders !== p.reminders) console.log(`  count ${p.jobs}/${p.reminders} want ${x.jobs}/${x.reminders}: ${x.text.slice(0, 90)}`);
}
