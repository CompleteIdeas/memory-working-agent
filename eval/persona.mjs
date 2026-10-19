// The simulated person (docs/assessment-2026-10-19.md): Codex plays the persona through the OpenAI
// Responses API. It turns a scripted intent into the message the person would type, answers the
// assistant's questions in character, and rates each day. It sees only what the assistant told it.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = process.env.EVAL_PERSONA_MODEL || 'gpt-5.3-codex';
let key = process.env.OPENAI_API_KEY;
if (!key) {
  try { key = JSON.parse(readFileSync(join(process.env.APPDATA ?? '', 'io.datasette.llm', 'keys.json'), 'utf8')).openai; } catch { /* */ }
}

const RULES = [
  'Stay in character. Write only what the person would type, nothing else: no quotes, no labels, no explanations.',
  'Keep it short, like a message typed on a phone.',
  'Do not restate facts, preferences or instructions you gave the assistant before unless the intent says to. If the assistant should already know something, assume it does.',
  'Do not mention emails, web pages or where information came from unless the intent does.',
  'Do not add requirements, start dates, conditions or details that the intent does not include.', // pilot: "starting tomorrow" was invented
].join(' ');

let usageFile = null;
export function setPersonaUsageLog(file) { usageFile = file; }

async function respond(instructions, input, maxTokens = 600) {
  if (!key) throw new Error('no OpenAI key (OPENAI_API_KEY or llm keys.json)');
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, instructions, input, max_output_tokens: maxTokens, reasoning: { effort: 'low' } }),
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) {
      const body = await r.text();
      if (attempt < 3 && (r.status === 0 || r.status === 429 || r.status >= 500)) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
      throw new Error(`persona ${r.status}: ${body.slice(0, 200)}`);
    }
    const j = await r.json();
    const text = j.output_text ?? (j.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('').trim();
    if (usageFile && j.usage) appendFileSync(usageFile, JSON.stringify({ model: MODEL, in: j.usage.input_tokens, out: j.usage.output_tokens }) + '\n');
    return String(text).trim();
  }
  throw new Error('persona: retries exhausted');
}

const seenBlock = (seen) => seen.length
  ? `What the assistant has said to you recently (oldest first):\n${seen.map((s) => `- [${s.when}] ${s.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}`
  : 'The assistant has not said anything to you yet.';

/** The message the person types for this turn. */
export async function personMessage(world, turn, nowLabel, seen) {
  return respond(`${world.persona.sheet}\n\n${RULES}`, `It is ${nowLabel}.\n\n${seenBlock(seen)}\n\nWhat you want to do now: ${turn.intent}\n\nWrite the message.`);
}

/** The person's answer to a question the assistant asked, or null when nothing more is needed. */
export async function personAnswer(world, turn, nowLabel, exchange) {
  const out = await respond(`${world.persona.sheet}\n\n${RULES} If the assistant's last message asks you something you need to answer for your request to get done, answer it briefly. If it doesn't need an answer, reply with exactly NONE.`,
    `It is ${nowLabel}. What you wanted: ${turn.intent}\n\nThe conversation so far:\n${exchange.map((x) => `${x.who}: ${x.text}`).join('\n')}\n\nYour reply (or NONE):`);
  return /^\s*NONE\b/i.test(out) || !out ? null : out;
}

/** The person's 1–5 rating of the day's messages. */
export async function personRating(world, dayLabel, items) {
  const out = await respond(`${world.persona.sheet}\n\nYou are rating the assistant's messages from one day. Be honest and specific; a busy person is annoyed by noise and by anything wrong.`,
    `Day: ${dayLabel}\n\nEverything the assistant said to you today:\n${items.length ? items.map((s) => `- [${s.when}] ${s.text.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n') : '(nothing)'}\n\nReply as JSON only: {"rating": 1-5, "why": "one sentence"}. 5 = exactly what I need, 1 = I would stop using it.`, 300);
  try { const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); return { rating: Number(j.rating), why: String(j.why ?? '') }; }
  catch { return { rating: null, why: out.slice(0, 200) }; }
}
