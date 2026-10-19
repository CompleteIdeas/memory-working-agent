// BL-52 step 2: the labelled set. Categories:
//   later      set up something that happens later or repeatedly (a reminder, a scheduled or recurring task, a watch)
//   change_job change or stop something already scheduled (its format, scope or time)
//   setting    a general setting or preference (quiet hours, how to be addressed)
//   now        anything to do or answer now (a question, a draft, a lookup, an answer to a question)
// jobs = how many jobs a `later` message sets up; reminders = how many of them are reminders (the person does it).
// Labels: the BL-40 persona's messages (written by Codex, labelled here by hand), BL-19's test phrases, the BL-43
// review's misfire list, and a few mixed requests. Labeller = the same author as the regex: read the numbers as a
// direction, and check disagreements by hand.
//   node scripts/intent-calibration/label.mjs   → scripts/intent-calibration/labeled.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const msgs = JSON.parse(readFileSync(join(HERE, 'messages.json'), 'utf8'));

const L = (category, jobs = 0, reminders = 0) => ({ category, jobs, reminders });
const T = L('later', 1), R2 = L('later', 2, 2), CH = L('change_job'), S = L('setting'), N = L('now');
// By index into messages.json (69 messages, BL-40).
const byIndex = [
  T, T, T, S, R2, N, N, CH, N, N, N, N, N, // 0-12
  T, T, T, S, R2, N, N, N, CH, N, N, N, // 13-24
  T, T, T, S, R2, N, CH, N, N, N, N, N, // 25-36
  T, T, S, T, R2, N, CH, N, N, N, N, N, // 37-48
  T, T, S, T, R2, N, CH, N, N, N, // 49-58
  T, T, S, T, R2, N, N, N, N, N, // 59-68
];
if (byIndex.length !== msgs.length) throw new Error(`labels ${byIndex.length} != messages ${msgs.length}`);

const extra = [
  // BL-19's positive test phrases
  ['In 1 minute, write a file called e2e-x-1.txt whose contents are exactly OK. Schedule it to run later — do not create the file now.', T],
  ['Remind me tomorrow at 9am to call the bank', L('later', 1, 1)], ['Every morning, summarize my inbox', T], ['Schedule a weekly report for Mondays', T],
  ['Remind me to call Dana in 2 hours', L('later', 1, 1)], ['Every day at 9, delete old files from Downloads', T], ['Remind me to stop by the store at 5', L('later', 1, 1)],
  ['Remind me every hour to stretch', L('later', 1, 1)], ['Remind me in an hour to call Sam', L('later', 1, 1)], ["I'd like you to schedule it in 5 minutes, that's all", T],
  ['Set a reminder for 5pm to call Dana', L('later', 1, 1)],
  // BL-19's negative test phrases
  ['What do I have scheduled tomorrow?', N], ['Write notes.md with the summary', N], ['Did the reminder run?', N], ['Summarize this later if you can', N],
  ['Remind me what we decided about the venue', N], ['Remind me how the backup script works', N], ['Summarize the schedule for the conference', N],
  ['Read schedule.csv and total the hours', N], ['Write the shift schedule to schedule.md', N], ["Summarize this email: 'The review moved to Thursday at 3pm, please confirm.'", N],
  ['Draft a reply confirming our call at 2pm', N], ['Cancel the reminder for tomorrow at 9', CH], ['Stop the every morning inbox summary', CH], ['Sum every 5 rows of data.csv', N],
  ['Look at the schedule my coach made and list conflicts', N], ['Email Dana my schedule this week', N],
  // The BL-43 review's misfires
  ['Refactor utils.ts and tell me when you are done', N], ['Tell me when the Battle of Hastings happened', N], ['Tell me when the store closes today', N],
  ['Count errors for each hour in server.log', N], ["Make a plan for Thursday's board meeting", N], ['Create a daily meal plan as meal-plan.md', N], ['Create a weekly report template', N],
  ['Make a list of my Google alerts', N], ['Add a section about smoke alarms to the safety doc', N], ['Create a summary of the 9:30 standup notes', N],
  ['Tell me if anything changed in this diff', N], ['Tell me if the meeting was cancelled', N], ['Watch for typos while you edit', N], ['Keep an eye on the tone', N],
  ['Make a watch list of these five stocks', N], ['Email me before you send anything', S],
  // Corrections to a job, and near misses
  ['Keep the morning plan to 3 bullets from now on.', CH], ['Can you keep the plan to three bullets?', CH], ['Put wedding inquiries first in the daily brief.', CH],
  ['Going forward, skip the weather in my morning summary.', CH], ['Move my morning brief to 7:30.', CH], ['Summarize this report', N], ["What was in this morning's brief?", N],
  ['Add a heading to notes.md', N], ['From now on call me Rob', S],
  // Mixed and multi-job requests
  ['Remind me Thursday at 10 to call the bank and Friday at 4 to order ribbon', R2], ['Every weekday at 8 send me my calendar, and remind me Friday to call mom', L('later', 2, 1)],
  ['Summarize my inbox now and every morning at 8', T], ['Tell me the moment the package shows delivered', T], ['Text me if the flight gets delayed', T],
  ['Can you check the invoices every Monday?', T], ['Ping me in 20 minutes to take the bread out', L('later', 1, 1)], ['Set four reminders: 9am stretch, noon lunch, 3pm walk, 6pm call mom', L('later', 4, 4)],
];
const out = [...msgs.map((m, i) => ({ text: m.text, from: m.from, ...byIndex[i] })), ...extra.map(([text, lab]) => ({ text, from: 'written', ...lab }))];
writeFileSync(join(HERE, 'labeled.json'), JSON.stringify(out, null, 1));
const count = (c) => out.filter((x) => x.category === c).length;
console.log(`${out.length} labelled: later ${count('later')}, change_job ${count('change_job')}, setting ${count('setting')}, now ${count('now')}`);
