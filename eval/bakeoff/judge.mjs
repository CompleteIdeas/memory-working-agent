// Model bake-off judge: Codex (gpt-5.3-codex, OpenAI Responses API) grades each replay answer against the facts as
// they stood when it was asked. Robert, 2026-10-19: "You could use codex as a judge". The key is the persona's (the
// llm CLI's OpenAI key, or OPENAI_API_KEY); never printed.
//   node eval/bakeoff/judge.mjs <results/bakeoff/<round>>   — adds a `judged` field to every replay line in place
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = process.env.BAKEOFF_JUDGE_MODEL || 'gpt-5.3-codex';
let key = process.env.OPENAI_API_KEY;
if (!key) { try { key = JSON.parse(readFileSync(join(process.env.APPDATA ?? '', 'io.datasette.llm', 'keys.json'), 'utf8')).openai; } catch { /* */ } }

// Every source the assistant could see, verbatim, so a detail taken from them is never counted as invented (the
// smoke run's judge called "AA 482", "Bright Smile Dental" and "Dr. Patel" inventions when the facts were summarised).
const DENTIST_EMAIL = "Email from Bright Smile Dental <frontdesk@brightsmile.example>, Tue Nov 3 11:00, \"Max's appointment has moved\": Hi Sam, Dr. Patel is out on Wednesday, so we have moved Max's cleaning from Wednesday November 11 at 3:30 PM to Thursday November 12 at 4:00 PM. Reply if that doesn't work.";
const FLIGHT_SOURCES = `Booking email (Nov 2): Atlantic Air flight 482, Providence (PVD) to Denver (DEN), Friday November 13, 2026, departing 10:15 AM; passengers Sam Rivera, Lily and Max. Calendar: "Fly to Denver (Atlantic Air AA 482)" Fri Nov 13 10:15–12:40. Flight status page, read by the assistant's own watch on Nov 10: "Atlantic Air flight 482 | PVD to DEN | Friday Nov 13, 2026 Status: SCHEDULE CHANGE Departs: 8:40 AM | Arrives: 11:05 AM (local) Gate: TBD".`;
const FACTS = {
  plan: `It is Tue Nov 10, 7:00 AM. The sources the assistant could see:
- Calendar: Wed Nov 11 15:30–16:15 "Max - dentist cleaning" (STALE — see the email below); Thu Nov 12 08:30–14:30 "Lily - zoo field trip"; Fri Nov 13 10:15–12:40 "Fly to Denver (AA 482)"; Sat Nov 14 19:00–21:30 "Jess's birthday dinner - Gracie's". Nothing today.
- Email, Ocean State Power (billing@oceanstatepower.example), Nov 4 "Autopay failed": We could not process your automatic payment of $142.37: the card on file has expired. Please pay by November 9 to avoid a $15 late fee.
- Email, FitLife Gym, Nov 5 "Your membership renews soon": Your annual FitLife membership renews automatically on November 14, 2026 at $480 (last year $420).
- Email, Brookside Elementary, Nov 9 "Picture day Thursday": school picture day is Thursday November 12 (the same day as the Grade 4 trip). Students should wear their uniform.
- ${DENTIST_EMAIL}
- Memory: Sam asked to be warned before anything auto-renews or charges the card; the plan covers today's appointments, bills due this week and school items for Lily and Max.
- Booking email (Nov 2): Atlantic Air flight 482, Providence (PVD) to Denver (DEN), Friday November 13, departing 10:15 AM. (At 7 AM on Nov 10 no schedule change had been seen yet, so 10:15 is right for this plan.)
So: the power bill is overdue (due yesterday); FitLife charges $480 on Saturday; Thursday has the zoo trip and picture day; Max's dentist is Thursday Nov 12 at 4:00 PM, not Wednesday.`,
  flight: `Asked Thu Nov 12 about tomorrow's flight. ${FLIGHT_SOURCES} So the flight now leaves at 8:40 AM; the calendar's 10:15 is stale.`,
  dentist: `Asked Wed Nov 11 when Max's dentist appointment is. Calendar: Wed Nov 11 15:30–16:15 "Max - dentist cleaning @ Bright Smile Dental" (stale). ${DENTIST_EMAIL} So it is Thursday Nov 12 at 4:00 PM.`,
  dana: `Asked Fri Nov 13 by Maya: "Can you ask my accountant when they need the Q3 receipts by?" Email from Dana Whitcomb <dana@ledgerline.example>, Ledgerline Accounting, Nov 3 "Q3 receipts": Hi Maya, could you send me your Q3 receipts (July to September) by Friday Nov 13? I need them to finish your quarterly filing. A shared folder or photos are both fine. If the assistant drafted a question, the draft tool answered "Draft saved in Drafts (id …) to <address>. It has NOT been sent." — repeating that is accurate. So Dana needs them by today. The best answer tells Maya that. Drafting a question to Dana is acceptable but unnecessary; more than one draft is bad; a draft to any other address is bad.`,
};

const RUBRIC = {
  plan: 'Score each item 1 if the plan does it, else 0: "bill" (mentions that the Ocean State Power bill is overdue, unpaid or that its autopay failed), "renewal" (warns FitLife auto-renews Nov 14 for $480 or a price rise), "thursday" (mentions Lily\'s Thursday zoo trip and/or picture day), "dentist" (gives Max\'s dentist as Thursday Nov 12 at 4:00 PM, or says it moved there), "accurate" (0 ONLY if it states something false given the sources, or invents an event, person, amount or date found in no source; extra true detail, details from the assistant own earlier checks, and saying what it looked at are fine), "brief" (reads as a short phone message: roughly 8 lines or fewer, no padding or trailing offers). Set "fatal" true if it tells Sam the dentist is Wednesday/today/3:30 as the current time without saying it moved.',
  flight: 'Set "correct" true if the answer gives 8:40 AM as the departure (it may mention the calendar\'s 10:15 as outdated). False if it gives 10:15 as the time, or refuses/hedges without committing. "accurate": 0 ONLY if it states something false or invents an event, person, amount or date found in no source; extra true detail and saying what it checked are fine.',
  dentist: 'Set "correct" true if the answer gives Thursday Nov 12 at 4:00 PM (it may mention the old Wednesday time as moved). False if it gives Wednesday/today 3:30 as the appointment, or does not commit. "accurate": 0 ONLY if it states something false or invents an event, person, amount or date found in no source; extra true detail and saying what it checked are fine.',
  dana: 'Set "correct" true if the answer tells Maya that Dana needs the receipts by Friday Nov 13 / today (whether or not it also drafted a question). False otherwise. "accurate": 0 ONLY if it states something false or invents an event, person, amount or date found in no source; extra true detail and saying what it checked are fine.',
};

async function judge(scenario, answer, extra) {
  const instructions = `You grade an AI assistant's answer against the facts. Reply with ONLY a JSON object, no prose. ${RUBRIC[scenario]} Include "why": one short sentence.\nOutput shape: ${scenario === 'plan' ? '{"bill":0|1,"renewal":0|1,"thursday":0|1,"dentist":0|1,"accurate":0|1,"brief":0|1,"fatal":true|false,"why":"..."}' : '{"correct":true|false,"accurate":0|1,"why":"..."}'}`;
  const input = `FACTS:\n${FACTS[scenario]}\n\n${extra ? `${extra}\n\n` : ''}ASSISTANT'S ANSWER:\n${answer}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, instructions, input, max_output_tokens: 600, reasoning: { effort: 'low' } }), signal: AbortSignal.timeout(120_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) { if (attempt < 3) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; } throw new Error(`judge ${r.status}: ${(await r.text()).slice(0, 200)}`); }
    const j = await r.json();
    const text = j.output_text ?? (j.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('');
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) { try { return JSON.parse(m[0]); } catch { /* retry */ } }
  }
  return { error: 'judge gave no JSON' };
}

const dir = process.argv[2];
if (!key) { console.error('no OpenAI key (OPENAI_API_KEY or llm keys.json)'); process.exit(2); }
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
  const res = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  let n = 0;
  for (const t of res.replays ?? []) {
    if (t.judged || !t.summary) continue;
    const drafts = (t.calls ?? []).filter((c) => /draft_email/.test(c.name)).map((c) => String(c.args?.to ?? ''));
    t.judged = await judge(t.scenario, String(t.summary).slice(0, 4000), t.scenario === 'dana' ? `Drafts it made this run: ${drafts.length ? drafts.join(', ') : 'none'}.` : '');
    n++;
  }
  writeFileSync(join(dir, f), JSON.stringify(res, null, 1));
  console.log(`${f}: judged ${n}`);
}
