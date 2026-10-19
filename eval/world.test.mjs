// node eval/world.test.mjs — the simulated mailbox answers Gmail-style queries the way Gmail would.
import assert from 'node:assert/strict';
process.env.TZ = 'America/New_York';
const { parseQuery, matches } = await import('./world.mjs');
const now = new Date(2026, 10, 10, 9, 0).getTime();
const mk = (id, from, subject, body, at) => ({ id, from, subject, body, to: 'sam@mail.example', ms: new Date(...at).getTime() });
const mail = [
  mk('a', 'Ocean State Power <billing@oceanstatepower.example>', 'Autopay failed', 'Please pay $142.37 by November 9.', [2026, 10, 4, 9, 0]),
  mk('b', 'Brookside Elementary <office@brookside.example>', 'Grade 4 field trip - permission slip', 'Return the slip and the $15 fee by Friday.', [2026, 10, 2, 7, 30]),
  mk('c', 'FitLife Gym <members@fitlife.example>', 'Your membership renews soon', 'Renews automatically on November 14 at $480.', [2026, 10, 5, 19, 0]),
];
const hits = (q) => mail.filter((e) => matches(parseQuery(q), e, { read: new Set(['c']), now })).map((e) => e.id).join('');
const cases = [
  ['(bill OR due OR payment OR autopay) newer_than:7d', 'a'],
  ['newer_than:14d (bill OR invoice OR due OR payment OR school OR teacher)', 'a'], // "bill" in billing@ — substring matching, a little kinder than Gmail
  ['(fee OR slip) newer_than:14d', 'b'],
  ['Lily zoo field trip permission slip fee OR permission slip', ''],   // Gmail: AND of the words, "Lily" isn't there
  ['field trip OR permission slip', 'b'],
  ['"permission slip"', 'b'],
  ['from:(school OR brookside OR teacher) slip', 'b'],
  ['subject:"field trip"', 'b'],
  ['renew OR renews OR "auto-renew"', 'c'],
  ['is:unread', 'ab'],
  ['-from:fitlife newer_than:30d', 'ab'],
  ['after:2026/11/03 before:2026/11/05', 'a'],
  ['in:inbox category:primary', 'abc'],
  ['', 'abc'],
  ['bill | autopay', 'a'],
];
for (const [q, want] of cases) assert.equal(hits(q), want, q);
console.log(`world search: ${cases.length} cases pass`);
