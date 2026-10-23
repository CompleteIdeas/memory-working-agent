// Scores the background-job bake-off (eval/bakeoff/jobs.mts): node eval/bakeoff/jobs-score.mjs <roundDir>
// A fire passes when it did what the person asked: a watch stays quiet unless the thing they asked about happened,
// and a brief or digest arrives with the item the world planted for that day (the BL-68 world probe's own rubric,
// worded for substance in rubrics.json). Cost is the real cost OpenRouter reported per call
// (tokens.jsonl), not MWA's estimate. Writes <roundDir>/scores.json and prints a table.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRouterKey } from '../openrouter-key.mjs';

const dir = process.argv[2];
const judgeModel = 'google/gemini-3.8-flash';
const JUDGE_ROUTING = { data_collection: 'deny', only: ['openai', 'anthropic', 'google-vertex/us', 'azure/us', 'amazon-bedrock/us-east-1', 'amazon-bedrock/us-east-2', 'amazon-bedrock/us-west-2'], allow_fallbacks: false };
const orKey = openRouterKey();
// The current wording of each scenario's checks, so an earlier round can be rescored after a rubric is reworded.
const RUBRICS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'rubrics.json'), 'utf8'));
// Round 1 showed eval/score.mjs's prompt failing Sol for "Riverbend final results" (not "Riverbend Fall Horse Trials")
// and for leaving out "technical delegate": a brief is read for what it tells the person, not for the rubric's words.
const JUDGE_V = 'substance-1';
const cacheFile = join(dir, 'judge-cache.json');
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
async function judge(rubric, evidence) {
  const key = `${JUDGE_V}\u0000${rubric}\u0000${evidence}`;
  if (cache[key]) return cache[key];
  const prompt = `You check one claim about a personal assistant's messages to the person it works for.\n\nCLAIM TO CHECK: ${rubric}\n\nEVIDENCE (the assistant's messages, with local times):\n${evidence || '(no messages)'}\n\nDoes the evidence satisfy the claim? Judge only from the evidence, and judge substance, not wording: pass when a reader of these messages would come away knowing the fact the claim describes. Short names ("Riverbend results", "Paul", "Derek"), paraphrase, and leaving out details the claim gives only to identify something (in parentheses, or a member number) are fine. Fail when the key fact is missing, wrong or contradicted: a wrong day, date or time counts as wrong. Reply with JSON only: {"pass": true or false, "why": "one short sentence"}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${orKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: judgeModel, messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0, provider: JUDGE_ROUTING }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    const j = await r.json();
    const text = String(j.choices?.[0]?.message?.content ?? '');
    const o = [...text.matchAll(/\{[^{}]*\}/g)].map((m) => { try { return JSON.parse(m[0]); } catch { return null; } }).find((x) => x && typeof x.pass === 'boolean');
    if (o) { cache[key] = { pass: o.pass, why: String(o.why ?? '').slice(0, 200) }; return cache[key]; }
  }
  return { pass: false, why: 'judge gave no verdict' };
}
// Up to n judge calls at once, results in input order.
async function pool(xs, n, fn) {
  const out = new Array(xs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); } }));
  return out;
}
const jsonl = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
// A brief that gives up on its own job ("I can't complete this brief…") is not a brief, whatever it happens to mention.
const GAVE_UP = /\b(?:can(?:no|')t|could(?: not|n't)|unable to) (?:complete|produce|prepare|create|compile|finish) (?:this|the|your|a) (?:morning )?(?:brief|digest|summary)/i;

const out = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !/\.(runs|tokens)\.jsonl$/.test(x))) {
  const slug = f.replace(/\.jsonl$/, '');
  const fires = jsonl(join(dir, f));
  const tokens = jsonl(join(dir, `${slug}.tokens.jsonl`));
  const costByJob = new Map();
  for (const t of tokens) costByJob.set(t.job, (costByJob.get(t.job) ?? 0) + Number(t.cost ?? 0));
  // BL-73: with a background worker, any call on another model is the boss (MWA_MODEL) stepping in.
  const worker = String(fires[0]?.worker ?? '').replace(/^openrouter:/, '');
  const bossByJob = new Map();
  if (worker) for (const t of tokens) if (t.model && t.model !== worker) bossByJob.set(t.job, (bossByJob.get(t.job) ?? 0) + Number(t.cost ?? 0));
  const rows = await pool(fires, 8, async (r) => {
    let pass; let why;
    const msg = r.summary ?? '';
    if (r.expect === 'quiet') { pass = !r.delivered; why = r.delivered ? `sent: ${msg.replace(/\s+/g, ' ').slice(0, 140)}` : 'quiet'; }
    else if (!r.delivered) { pass = false; why = `nothing sent (${r.quiet ?? r.error ?? r.outcome})`; }
    else if (r.kind === 'brief' && GAVE_UP.test(msg)) { pass = false; why = 'gave up on the brief'; }
    else {
      const vs = [];
      for (const rubric of RUBRICS[r.scenario] ?? r.rubrics) vs.push(await judge(rubric, `[${r.stamp}] ${msg.replace(/\s+/g, ' ').slice(0, 3000)}`));
      pass = vs.every((v) => v.pass); why = vs.map((v) => v.why).join(' / ');
    }
    return { scenario: r.scenario, kind: r.kind, trial: r.trial, pass, why, outcome: r.outcome, steps: r.steps, seconds: Math.round(r.ms / 1000), cost: costByJob.get(r.jobId) ?? 0,
      bossCost: bossByJob.get(r.jobId) ?? 0, boss: bossByJob.has(r.jobId), watchGate: r.watchGate ?? null };
  });
  const by = (k) => { const xs = rows.filter((x) => x.kind === k); return { pass: xs.filter((x) => x.pass).length, n: xs.length }; };
  const avg = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  out[slug] = {
    model: fires[0]?.model, total: { pass: rows.filter((x) => x.pass).length, n: rows.length }, briefs: by('brief'), watches: by('watch'),
    costPerBrief: avg(rows.filter((x) => x.kind === 'brief').map((x) => x.cost)), costPerWatch: avg(rows.filter((x) => x.kind === 'watch').map((x) => x.cost)),
    secondsPerBrief: avg(rows.filter((x) => x.kind === 'brief').map((x) => x.seconds)), errors: fires.filter((x) => x.error).length,
    worker: worker || undefined, bossFires: rows.filter((x) => x.boss).length, bossShare: rows.reduce((s, x) => s + x.bossCost, 0) / (rows.reduce((s, x) => s + x.cost, 0) || 1),
    gateQuieted: rows.filter((x) => x.watchGate).length, rows,
  };
}
writeFileSync(cacheFile, JSON.stringify(cache));
writeFileSync(join(dir, 'scores.json'), JSON.stringify(out, null, 1));
const ids = [...new Set(Object.values(out).flatMap((m) => m.rows.map((r) => r.scenario)))];
console.log(`${'model'.padEnd(10)} ${'total'.padEnd(7)} ${'briefs'.padEnd(7)} ${'watches'.padEnd(8)} $/brief  $/watch  s/brief  ${ids.join(' ')}`);
for (const [slug, m] of Object.entries(out)) {
  const cell = (id) => { const xs = m.rows.filter((r) => r.scenario === id); return `${xs.filter((r) => r.pass).length}/${xs.length}`.padEnd(id.length); };
  console.log(`${slug.padEnd(10)} ${`${m.total.pass}/${m.total.n}`.padEnd(7)} ${`${m.briefs.pass}/${m.briefs.n}`.padEnd(7)} ${`${m.watches.pass}/${m.watches.n}`.padEnd(8)} ${m.costPerBrief.toFixed(4).padEnd(8)} ${m.costPerWatch.toFixed(4).padEnd(8)} ${m.secondsPerBrief.toFixed(0).padEnd(8)} ${ids.map(cell).join(' ')}`);
}
for (const [slug, m] of Object.entries(out)) if (m.worker) console.log(`${slug}: the boss stepped in on ${m.bossFires} of ${m.rows.length} fires (${(m.bossShare * 100).toFixed(0)}% of the cost); the watch gate quieted ${m.gateQuieted}`);
