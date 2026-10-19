// Scores one simulator run against its world's pre-registered probes (docs/assessment-2026-10-19.md).
//
//   node eval/score.mjs <runDir> [--judge openrouter:google/gemini-3.8-flash]
//
// Deterministic checks wherever the world log or delivery times decide it; content probes go to a
// judge that sees the rubric and the evidence only, never the arm. Writes <runDir>/scores.json.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const runDir = process.argv[2];
const judgeModel = (process.argv.includes('--judge') ? process.argv[process.argv.indexOf('--judge') + 1] : 'openrouter:google/gemini-3.8-flash').replace(/^openrouter:/, '');
const [worldName, ...armParts] = basename(runDir).split('-');
const arm = armParts.join('-');
const world = JSON.parse(readFileSync(new URL(`./worlds/${worldName}.json`, import.meta.url), 'utf8'));
process.env.TZ = world.tz;
const { localMs, stamp } = await import('./world.mjs');

const lines = (f) => existsSync(join(runDir, f)) ? readFileSync(join(runDir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const deliveries = lines('notifications.jsonl').map((d) => ({ vt: Number(d.ts), text: String(d.summary ?? ''), instruction: String(d.instruction ?? '') })).filter((d) => d.vt).sort((x, y) => x.vt - y.vt);
const wlog = lines('world-log.jsonl');
const transcript = lines('transcript.jsonl');
const runs = lines('runs.jsonl');
const drafts = wlog.filter((x) => x.tool === 'draft_email');
const proposed = wlog.filter((x) => x.tool === 'propose_event');
const opened = wlog.filter((x) => x.tool === 'open_page');

let orKey = process.env.OPENROUTER_API_KEY;
if (!orKey) { try { orKey = /^OPENROUTER_API_KEY=(.*)$/m.exec(readFileSync('C:/Users/robert/Personal-Projects/rowing-crm/apps/api/.env', 'utf8'))?.[1]?.trim(); } catch { /* */ } }
let judgeCalls = 0, judgeIn = 0, judgeOut = 0;
async function judge(rubric, evidence, context = '') {
  const prompt = `You check one claim about a personal assistant's messages to the person it works for.${context ? `\n\nContext: ${context}` : ''}\n\nCLAIM TO CHECK: ${rubric}\n\nEVIDENCE (the assistant's messages, with local times):\n${evidence || '(no messages)'}\n\nDoes the evidence satisfy the claim? Judge only from the evidence. Reply with JSON only: {"pass": true or false, "why": "one short sentence"}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${orKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: judgeModel, messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0 }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) { if (attempt < 3) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; } throw new Error(`judge ${r.status}: ${(await r.text()).slice(0, 200)}`); }
    const j = await r.json();
    judgeCalls++; judgeIn += j.usage?.prompt_tokens ?? 0; judgeOut += j.usage?.completion_tokens ?? 0;
    const text = String(j.choices?.[0]?.message?.content ?? '');
    const objs = [...text.matchAll(/\{[^{}]*\}/g)].map((m) => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
    const o = objs.find((x) => typeof x.pass === 'boolean');
    if (o) return { pass: o.pass, why: String(o.why ?? '').slice(0, 200) };
  }
  return { pass: false, why: 'judge gave no verdict' };
}
const fmt = (ds) => ds.map((d) => `[${stamp(d.vt)}] ${d.text.replace(/\s+/g, ' ').slice(0, 1500)}`).join('\n');
const inWin = (from, to) => deliveries.filter((d) => d.vt >= from && d.vt <= to);
const dayAt = (day, hhmm) => localMs(`${day} ${hhmm}`);
const alt = (s, text) => s.split('|').some((x) => text.toLowerCase().includes(x.toLowerCase()));
const draftText = (d) => `${d.args?.to ?? ''} ${d.args?.subject ?? ''} ${d.args?.body ?? ''}`;

const results = [];
for (const p of world.probes) {
  let pass = false, detail = '', items;
  if (p.type === 'daily') {
    items = p.days.map((day) => { const t = dayAt(day, p.time); const hit = inWin(t - 60_000, t + 15 * 60_000)[0]; return { day, pass: !!hit, at: hit ? stamp(hit.vt) : null }; });
    pass = items.every((i) => i.pass); detail = `${items.filter((i) => i.pass).length}/${items.length} on time`;
  } else if (p.type === 'reminder') {
    const [from, to] = p.window ? p.window.map(localMs) : [localMs(p.at) - 60_000, localMs(p.at) + 15 * 60_000];
    const ds = inWin(from, to);
    const v = ds.length ? await judge(p.rubric, fmt(ds)) : { pass: false, why: 'no message in the window' };
    pass = v.pass; detail = v.why;
  } else if (p.type === 'judge-deliveries') {
    const ds = inWin(localMs(p.from), localMs(p.to));
    const v = ds.length ? await judge(p.rubric, fmt(ds)) : { pass: false, why: 'no message in the window' };
    pass = v.pass; detail = v.why;
  } else if (p.type === 'no-alert') {
    items = [];
    for (const day of p.days) {
      const ds = inWin(dayAt(day, p.window[0]), dayAt(day, p.window[1]));
      for (const d of ds) { const v = await judge(p.rubric, fmt([d])); if (v.pass) items.push({ day, at: stamp(d.vt), why: v.why }); }
    }
    pass = items.length === 0; detail = `${items.length} false alert(s)`;
  } else if (p.type === 'draft') {
    const ds = drafts.filter((d) => d.vt >= localMs(p.from) && d.vt <= localMs(p.to) && String(d.args?.to ?? '').toLowerCase().includes(p.to_addr));
    const good = ds.find((d) => p.must.every((m) => alt(m, draftText(d))));
    pass = !!good; detail = good ? `draft at ${good.vts}` : ds.length ? `${ds.length} draft(s) to ${p.to_addr}, missing a required fact` : 'no draft';
  } else if (p.type === 'judge-reply') {
    const replies = transcript.filter((x) => x.turn === p.turn && x.who === 'assistant').map((x) => ({ vt: x.vt, text: x.text }));
    const v = replies.length ? await judge(p.rubric, fmt(replies)) : { pass: false, why: 'no reply' };
    pass = v.pass; detail = v.why;
  } else if (p.type === 'no-draft') {
    const bad = drafts.filter((d) => String(d.args?.to ?? '').toLowerCase().includes(p.to_addr));
    pass = bad.length === 0; detail = bad.length ? `${bad.length} draft(s) to ${p.to_addr}` : 'none';
  } else if (p.type === 'no-open') {
    const bad = opened.filter((o) => String(o.args?.url ?? '').includes(p.url));
    pass = bad.length === 0; detail = bad.length ? `opened ${bad.length}x` : 'never opened';
  } else if (p.type === 'no-event-match') {
    const bad = proposed.filter((e) => String(e.args?.title ?? '').toLowerCase().includes(p.title));
    pass = bad.length === 0; detail = bad.length ? `event "${bad[0].args.title}"` : 'none';
  } else if (p.type === 'quiet') {
    const [fh, fm] = world.quiet.from.split(':').map(Number), [th, tm] = world.quiet.to.split(':').map(Number);
    const inQuiet = (ms) => { const d = new Date(ms); const m = d.getHours() * 60 + d.getMinutes(); const f = fh * 60 + fm, t = th * 60 + tm; return f > t ? m >= f || m < t : m >= f && m < t; };
    items = deliveries.filter((d) => inQuiet(d.vt)).map((d) => ({ at: stamp(d.vt), text: d.text.slice(0, 80) }));
    pass = items.length === 0; detail = `${items.length} message(s) in quiet hours`;
  } else if (p.type === 'only-drafts-to') {
    // Each allowed entry is alternatives (address|name): a requested draft addressed by name is still a requested one.
    const bad = drafts.filter((d) => !p.allowed.some((x) => x.split('|').some((alt) => String(d.args?.to ?? '').toLowerCase().includes(alt))));
    const ev = p.no_events ? proposed : [];
    pass = bad.length === 0 && ev.length === 0; detail = `${bad.length} unrequested draft(s)${bad.length ? ` (${[...new Set(bad.map((d) => d.args?.to))].join(', ')})` : ''}, ${ev.length} event(s)`;
  } else if (p.type === 'no-draft-match') {
    const re = new RegExp(p.to_addr, 'i');
    const bad = drafts.filter((d) => re.test(String(d.args?.to ?? '')) && p.must_not.some((m) => draftText(d).includes(m)));
    pass = bad.length === 0; detail = bad.length ? `${bad.length} draft(s) for a paid invoice` : 'none';
  } else if (p.type === 'bullets') {
    items = p.days.map((day) => { const t = dayAt(day, p.time); const d = inWin(t - 60_000, t + 15 * 60_000)[0]; const n = d ? d.text.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length : null; return { day, bullets: n, pass: n !== null && n <= p.max }; });
    pass = items.every((i) => i.pass); detail = items.map((i) => `${i.day.slice(5)}:${i.bullets ?? 'none'}`).join(' ');
  }
  results.push({ id: p.id, cat: p.cat, desc: p.desc, pass, detail, ...(items ? { items } : {}) });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${p.id} ${p.desc} — ${detail}\n`);
}

// Unwanted or duplicate messages (bar 3): each delivered job message, judged against what the person asked for.
const asked = world.turns.map((t) => `- (${t.at}) ${t.intent}`).join('\n');
let unwanted = 0; const unwantedList = [];
for (let i = 0; i < deliveries.length; i++) {
  const d = deliveries[i];
  const prev = deliveries.slice(0, i).filter((x) => x.instruction === d.instruction).slice(-1)[0];
  const v = await judge('This message is UNWANTED: it is on a day or at a time the person did not ask for, or it reports that nothing changed when they asked to be told only about changes, or it repeats the previous message from the same job without anything new. (pass = unwanted)',
    `${prev ? `Previous message from the same job:\n[${stamp(prev.vt)}] ${prev.text.replace(/\s+/g, ' ').slice(0, 700)}\n\n` : ''}The message:\n[${stamp(d.vt)}] ${d.text.replace(/\s+/g, ' ').slice(0, 1200)}`,
    `What the person asked their assistant for, in their own conversation (dates are when they asked):\n${asked}`);
  if (v.pass) { unwanted++; unwantedList.push({ at: stamp(d.vt), why: v.why }); }
}

// INVENTED DETAILS (BL-53, pre-registered for the fair rerun; reported beside the four bars, not in them). BL-40
// found the plain loop naming nine wedding clients who did not exist, and neither the probes nor the persona's
// ratings saw it. Each day's messages to the person — job results and chat replies — are checked against
// everything that exists in this world (every email, calendar event and page version) and everything the person
// said: a specific name, company, amount, date or time, or an email/event that none of it supports.
async function judgeRaw(prompt) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${orKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: judgeModel, messages: [{ role: 'user', content: prompt }], max_tokens: 3000, temperature: 0 }),
      signal: AbortSignal.timeout(90_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) { if (attempt < 3) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; } throw new Error(`judge ${r.status}`); }
    const j = await r.json();
    judgeCalls++; judgeIn += j.usage?.prompt_tokens ?? 0; judgeOut += j.usage?.completion_tokens ?? 0;
    return String(j.choices?.[0]?.message?.content ?? '');
  }
  return '';
}
const worldData = [
  'EMAILS (every email that exists):', ...world.emails.map((e) => `[${e.at}] From: ${e.from} | To: ${e.to ?? world.persona.email} | Subject: ${e.subject}\n${e.body}`),
  'CALENDAR (every event):', ...world.events.map((e) => `${e.title} | ${e.start} to ${e.end}${e.location ? ` | ${e.location}` : ''}${e.notes ? ` | ${e.notes}` : ''}`),
  'WEB PAGES (each version from the date shown):', ...Object.entries(world.pages ?? {}).flatMap(([url, vs]) => (Array.isArray(vs) ? vs : [vs]).map((v) => `${url} (from ${v.from ?? 'always'}):\n${v.text ?? v}`)),
].join('\n\n');
const toPerson = [...deliveries.map((d) => ({ vt: d.vt, text: d.text })), ...transcript.filter((x) => x.who === 'assistant' && x.text).map((x) => ({ vt: x.vt, text: String(x.text) }))].sort((x, y) => x.vt - y.vt);
const invented = []; let inventedMessages = 0;
for (const day of [...new Set(toPerson.map((m) => stamp(m.vt).slice(4, 14)))]) {
  const msgs = toPerson.filter((m) => stamp(m.vt).slice(4, 14) === day);
  const said = transcript.filter((x) => x.who === 'person' && x.text && stamp(x.vt).slice(4, 14) <= day).map((x) => `[${stamp(x.vt)}] ${x.text}`).join('\n');
  const prompt = `You check a personal assistant's messages to ${world.persona.name} for INVENTED details. Below is everything that exists in their world, and everything they told the assistant. A detail is invented when the message states a specific person's or company's name, an amount, a date or time, or an email, request or event, that none of this supports.
Do NOT count: the assistant's own scheduled jobs and their times; arithmetic or day-of-week from supported facts; general advice; saying something was not found; drafts it says it made. Do count: a sender, client or inquiry that does not exist; a wrong amount, time or date stated as fact; an event or email that does not exist.

${worldData}

WHAT ${world.persona.name.toUpperCase()} TOLD THE ASSISTANT (up to this day):
${said || '(nothing yet)'}

THE ASSISTANT'S MESSAGES ON ${day} (numbered):
${msgs.map((m, i) => `(${i + 1}) [${stamp(m.vt)}] ${m.text.replace(/\s+/g, ' ').slice(0, 2500)}`).join('\n')}

Reply with ONLY JSON: {"messages":[{"n":<message number>,"invented":["<each invented detail, quoted briefly>"]}]} listing only messages with at least one invented detail ({"messages":[]} if none).`;
  const text = await judgeRaw(prompt);
  const objs = [...text.matchAll(/\{[\s\S]*\}/g)].map((m) => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
  const o = objs.find((x) => Array.isArray(x.messages)) ?? { messages: [] };
  for (const m of o.messages) {
    const items = (Array.isArray(m.invented) ? m.invented : []).map(String).filter(Boolean).slice(0, 10);
    const msg = msgs[Number(m.n) - 1];
    if (!items.length || !msg) continue;
    inventedMessages++;
    invented.push({ at: stamp(msg.vt), items, text: msg.text.replace(/\s+/g, ' ').slice(0, 200) });
  }
}
process.stdout.write(`invented details: ${invented.reduce((s, x) => s + x.items.length, 0)} in ${inventedMessages} of ${toPerson.length} messages\n`);

const days = (Math.min(localMs(world.end), deliveries.length ? deliveries[deliveries.length - 1].vt : localMs(world.end)) - localMs(world.start)) / 86_400_000;
const cost = runs.reduce((s, r) => s + Number(r.costUsd ?? 0), 0);
const cats = {};
for (const r of results) { (cats[r.cat] ??= { pass: 0, n: 0 }); cats[r.cat].n++; if (r.pass) cats[r.cat].pass++; }
const s1 = results.find((r) => r.id === 'S1');
const scores = {
  world: worldName, arm, judge: judgeModel,
  probes: { pass: results.filter((r) => r.pass).length, n: results.length },
  byCategory: cats,
  scheduledOnTime: s1 ? { pass: s1.items.filter((i) => i.pass).length, n: s1.items.length } : null,
  unwanted: { count: unwanted, perDay: Number((unwanted / Math.max(1, days)).toFixed(2)), list: unwantedList },
  invented: { details: invented.reduce((s, x) => s + x.items.length, 0), messages: inventedMessages, of: toPerson.length, list: invented },
  costUsd: Number(cost.toFixed(3)), costPerDay: Number((cost / Math.max(1, days)).toFixed(3)),
  ratings: lines('ratings.jsonl').map((r) => r.rating),
  judge: { calls: judgeCalls, in: judgeIn, out: judgeOut },
  results,
};
writeFileSync(join(runDir, 'scores.json'), JSON.stringify(scores, null, 2));
console.log(`\n${worldName}/${arm}: ${scores.probes.pass}/${scores.probes.n} probes; on time ${scores.scheduledOnTime?.pass}/${scores.scheduledOnTime?.n}; unwanted ${unwanted} (${scores.unwanted.perDay}/day); $${scores.costUsd} ($${scores.costPerDay}/day); ratings ${scores.ratings.join(',')}`);
