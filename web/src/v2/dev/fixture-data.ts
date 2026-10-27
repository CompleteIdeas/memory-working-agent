/**
 * The approved prototype's seed data (scratchpad/ux/prototype-v2/data.js, round 3), ported as-is so fixture mode
 * shows the same Monday the design was approved on: Monday, November 9, 2026, 9:10 AM. EVERYTHING HERE IS EXAMPLE
 * DATA. ./fixtures.ts turns it into /api/v1 responses.
 *
 * Kept close to the original on purpose (same ids, same words) so W2–W5 can compare a screen with the prototype
 * line by line. The Important list (`ITEMS`, `SKIPPED`) is here for W3; no v1 route serves it until slice A9.
 */
export const YEAR = 2026, MONTH_INDEX = 10, FIRST = 9;
/** The prototype's clock: Monday, November 9, 2026, 9:10 AM (local time). */
export const FIXTURE_NOW = new Date(YEAR, MONTH_INDEX, FIRST, 9, 10).getTime();
export const dayStart = (day: number) => new Date(YEAR, MONTH_INDEX, FIRST + day).getTime();
export const at = (day: number, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return new Date(YEAR, MONTH_INDEX, FIRST + day, h, m).getTime(); };

export type Cat = 'family' | 'eventing' | 'work' | 'personal';
export const CATS: Record<Cat, { name: string }> = { family: { name: 'Family' }, eventing: { name: 'Eventing' }, work: { name: 'Work' }, personal: { name: 'Personal' } };

export const PROJECTS = [
  { id: 'eventing', name: 'Eventing', icon: 'horse' },
  { id: 'family', name: 'Family & school', icon: 'home' },
  { id: 'ainews', name: 'AI newsletter', icon: 'spark' },
  { id: 'house', name: 'House & garden', icon: 'leaf' },
  { id: 'health', name: 'Health', icon: 'heart' },
] as const;

export interface SeedEvent { id: string; day: number; start: string; end: string; title: string; where: string; cat: Cat; note?: string; draft?: boolean; from?: string }
export const EVENTS: SeedEvent[] = [
  { id: 'e1', day: 0, start: '08:15', end: '08:45', title: 'School drop-off', where: 'Oakwood Elementary', cat: 'family' },
  { id: 'e2', day: 0, start: '10:00', end: '10:30', title: 'Call with Dana', where: 'Newsletter plan · phone', cat: 'work' },
  { id: 'e3', day: 0, start: '12:30', end: '13:30', title: 'Lunch with Sam', where: 'Corner Bistro', cat: 'personal' },
  { id: 'e4', day: 0, start: '16:00', end: '17:15', title: 'Riley’s soccer practice', where: 'Miller Park field 2', cat: 'family' },
  { id: 'e5', day: 0, start: '17:45', end: '18:45', title: 'Lesson with Ellen', where: 'Willow Creek Farm', cat: 'eventing', note: 'Bring Willow’s studs and the cross-country vest.' },
  { id: 'e6', day: 1, start: '08:15', end: '08:45', title: 'School drop-off', where: 'Oakwood Elementary', cat: 'family' },
  { id: 'e7', day: 1, start: '11:00', end: '12:00', title: 'Newsletter writing block', where: 'Home office', cat: 'work' },
  { id: 'e8', day: 2, start: '08:15', end: '08:45', title: 'School drop-off', where: 'Oakwood Elementary', cat: 'family' },
  { id: 'e9', day: 2, start: '15:30', end: '16:15', title: 'Riley — dentist', where: 'Bright Smiles Dental', cat: 'family', draft: true, from: 'school email' },
  { id: 'e10', day: 3, start: '16:00', end: '17:15', title: 'Riley’s soccer practice', where: 'Miller Park field 2', cat: 'family' },
  { id: 'e11', day: 3, start: '16:00', end: '17:00', title: 'Farrier at the barn', where: 'Willow Creek Farm', cat: 'eventing' },
  { id: 'e12', day: 4, start: '08:15', end: '08:45', title: 'School drop-off', where: 'Oakwood Elementary', cat: 'family' },
  { id: 'e13', day: 4, start: '17:00', end: '17:30', title: 'Stable View entries close', where: 'Online', cat: 'eventing' },
  { id: 'e14', day: 5, start: '07:00', end: '13:00', title: 'Schooling day at Stable View', where: 'Stable View, Aiken', cat: 'eventing' },
  { id: 'e15', day: 6, start: '10:00', end: '11:00', title: 'Family brunch', where: 'Grandma’s', cat: 'personal' },
  { id: 'e16', day: 2, start: '14:00', end: '14:45', title: 'Board call', where: 'Video call', cat: 'work', note: 'Moved from Tuesday 11am, per Dana’s email this morning.' },
];

export interface SeedEmail { id: string; from: string; addr: string; subject: string; time: string; unread?: boolean; important?: boolean; project?: string; preview: string; body: string[]; note?: string; draft?: string; list?: string }
export const EMAILS: SeedEmail[] = [
  {
    id: 'm1', from: 'Coach Ellen', addr: 'ellen@willowcreekfarm.example', subject: 'Saturday schooling — are you in?', time: '7:12 AM', unread: true, important: true, project: 'eventing',
    preview: 'I have two spots left in the 7am trailer to Stable View. Can you confirm by Wednesday?',
    body: ['Hi Robert,', 'I have two spots left in the 7am trailer to Stable View this Saturday. If you and Willow want one, can you confirm by Wednesday? We’ll school the Training course and be back around 1.', 'Ellen'],
    note: 'Asks you to confirm Saturday. You’re free — I drafted a yes.',
    draft: 'Hi Ellen, yes please — count Willow and me in for the 7am trailer on Saturday. Thanks! Robert',
  },
  {
    id: 'm2', from: 'Oakwood PTA', addr: 'pta@oakwood.example', subject: 'Book fair this Saturday, 3–6pm', time: '6:40 AM', unread: true, important: true, project: 'family', list: 'pta.oakwood.example',
    preview: 'The fall book fair is in the gym on Saturday from 3 to 6. Volunteers welcome!',
    body: ['Hello Oakwood families,', 'The fall book fair is in the school gym this Saturday, November 14, from 3 to 6pm. Volunteers are welcome for 30-minute shifts — reply if you can help.', 'Thank you! Oakwood PTA'],
    note: 'Saturday 3–6pm. It’s not on your calendar yet.',
    draft: 'Hi! I can help with a 30-minute shift at the book fair on Saturday — any time after 3:30 works. Robert',
  },
  {
    id: 'm3', from: 'Dana Lee', addr: 'dana@example.com', subject: 'Newsletter: your top 3 for Thursday?', time: 'Yesterday', unread: false, important: true, project: 'ainews',
    preview: 'Can you send your top three stories by Wednesday so I can lay it out?',
    body: ['Hey Robert,', 'Can you send your top three stories by Wednesday so I can lay out Thursday’s issue? Short blurbs are fine.', 'Dana'],
    note: 'Wants your top 3 stories by Wednesday. I’m gathering candidates now.',
    draft: 'Hi Dana, I’ll have my top three to you by Wednesday morning. Robert',
  },
  { id: 'm4', from: 'Stable View', addr: 'entries@stableview.example', subject: 'Entry reminder: schooling day', time: '5:58 AM', unread: true, preview: 'Entries for Saturday close Friday at 5pm.', note: 'Entries for Saturday close Friday at 5pm. You haven’t entered yet.', body: ['Entries for Saturday’s schooling day close Friday at 5pm.', 'Stable View Office'], list: 'news.stableview.example' },
  { id: 'm5', from: 'Bright Smiles Dental', addr: 'office@brightsmiles.example', subject: 'Riley’s appointment Wednesday', time: 'Yesterday', preview: 'This is a reminder of Riley’s cleaning on Wednesday at 3:30pm.', body: ['This is a reminder of Riley’s cleaning on Wednesday, November 11 at 3:30pm.', 'Bright Smiles Dental'] },
  { id: 'm6', from: 'Hillside Hardware', addr: 'orders@hillside.example', subject: 'Your order has shipped', time: 'Yesterday', preview: 'Gutter guards (2) are on the way and should arrive Thursday.', body: ['Gutter guards (2) are on the way and should arrive Thursday.'] },
  { id: 'm7', from: 'Oakwood Elementary', addr: 'office@oakwood.example', subject: 'Lunch menu for next week', time: 'Sat', preview: 'Pizza Friday is back! Here is next week’s menu.', body: ['Pizza Friday is back! Here is next week’s menu.'], list: 'office.oakwood.example' },
  { id: 'm8', from: 'The Batch', addr: 'news@thebatch.example', subject: 'This week in AI', time: 'Sat', preview: 'Five stories worth your time this week, plus one tool to try.', body: ['Five stories worth your time this week, plus one tool to try.'], list: 'news.thebatch.example' },
  { id: 'm10', from: 'Dana Lee', addr: 'dana@example.com', subject: 'Board call → Wednesday 2pm', time: '6:55 AM', preview: 'Tuesday doesn’t work for two of us, so the board call moves to Wednesday at 2.', body: ['Hi all,', 'Tuesday doesn’t work for two of us, so the board call moves to Wednesday at 2pm. Same link.', 'Dana'], note: 'The board call moved to Wednesday 2pm. I updated your calendar.' },
];

/** The Important list ("Worth a look"), for W3 (no v1 route until A9). ts = minutes from midnight today. */
export const ITEMS = [
  { id: 'i-ellen', src: 'gmail', from: 'Coach Ellen', title: 'Saturday schooling — are you in?', why: 'Asks you to confirm Saturday. You’re free — I drafted a yes.', group: 'today', ts: 432, time: '7:12 AM', project: 'eventing', email: 'm1' },
  { id: 'i-board', src: 'calendar', from: 'Calendar · from Dana’s email', title: 'Board call moved to Wednesday 2pm', why: 'Per Dana’s email, Tuesday didn’t work. Your calendar is updated.', group: 'today', ts: 415, time: '6:55 AM', project: 'ainews', event: 'e16' },
  { id: 'i-bookfair', src: 'newsletter', from: 'Oakwood school newsletter', title: 'Book fair · Sat Nov 14, 3–6pm', why: 'Found in the school newsletter. It isn’t on your calendar yet.', group: 'today', ts: 400, time: '6:40 AM', project: 'family', email: 'm2', action: { label: 'Add to calendar', primary: true } },
  { id: 'i-clash', src: 'calendar', from: 'Calendar', title: 'Thursday at 4 is double-booked', why: 'Riley’s practice and the farrier overlap. I can ask the farrier for 5:30.', group: 'today', ts: 360, time: '6:00 AM', project: 'family', need: 'clash', action: { label: 'Draft the note', primary: true } },
  { id: 'i-dentist', src: 'helper', from: 'Your helper · from a dentist email', title: 'Riley’s dentist, Wed Nov 11 at 3:30', why: 'I added it as a draft. Confirm it when you see it.', group: 'today', ts: 330, time: '5:30 AM', project: 'family', event: 'e9' },
  { id: 'i-dana', src: 'gmail', from: 'Dana Lee', title: 'Dana is waiting on your top 3 stories', why: 'She asked yesterday; due Wednesday. I’ve gathered 3 candidates.', group: 'week', ts: -300, time: 'Yesterday', project: 'ainews', email: 'm3' },
  { id: 'i-entries', src: 'newsletter', from: 'Stable View newsletter', title: 'Entries close Friday at 5pm', why: 'For Saturday’s schooling day. You haven’t entered yet.', group: 'week', ts: -2400, time: 'Sat', project: 'eventing', email: 'm4', action: { label: 'Remind me Friday' } },
  { id: 'i-quotes', src: 'helper', from: 'Your helper', title: 'Two gutter quotes came in', why: 'Hillside is $60 cheaper than Peak Gutters for the same work.', group: 'earlier', ts: -10000, time: 'Nov 3', project: 'house' },
  { id: 'i-hillside', src: 'gmail', from: 'Hillside Hardware', title: 'Your gutter guards ship Thursday', why: 'An order update for the house.', group: 'earlier', ts: -11000, time: 'Nov 2', project: 'house', email: 'm6' },
] as const;

const t = (from: string, what: string, kind: string) => ({ from, what, kind });
export const SKIPPED = {
  today: [t('The Batch', 'This week in AI', 'newsletter'), t('Oakwood Elementary', 'Lunch menu for next week', 'newsletter'), t('Amazon', 'Your order receipt', 'receipt'), t('Netflix', 'New this week', 'promotion'), t('Corner Bistro', '20% off lunch this week', 'promotion')],
  week: [t('Tack Shack', 'Fall sale ends Sunday', 'promotion'), t('LinkedIn', '5 people viewed your profile', 'notification'), t('Spotify', 'Your weekly mix', 'promotion'), t('Riverside Pharmacy', 'Receipt for your order', 'receipt'), t('City of Aiken', 'Leaf pickup schedule', 'newsletter')],
  earlier: [t('Amazon', 'Your package was delivered', 'receipt'), t('Medium', 'Stories for you', 'newsletter'), t('Costco', 'Weekly deals', 'promotion'), t('Uber', 'Your Thursday trip', 'receipt')],
};

export const THREADS: Record<string, { who: 'you' | 'helper'; text: string; cross?: string }[]> = {
  eventing: [
    { who: 'you', text: 'When do entries close for the Stable View schooling day?' },
    { who: 'helper', text: 'Friday at 5pm. You haven’t entered yet — I put the deadline on Friday so it doesn’t slip.' },
  ],
  family: [
    { who: 'you', text: 'Can Riley go on the Saturday morning library trip?' },
    { who: 'helper', text: 'You’ll be at Stable View until about 1pm on Saturday, so someone else would need to do the 9am drop-off. Want me to ask Sam?', cross: 'Eventing' },
  ],
  ainews: [
    { who: 'you', text: 'Pull together this week’s AI news for the newsletter.' },
    { who: 'helper', text: 'On it. I’ll keep the five strongest stories and a one-line blurb for each.' },
  ],
  house: [
    { who: 'you', text: 'Remind me what the gutter quotes were.' },
    { who: 'helper', text: 'Two quotes: Peak Gutters $640 and Hillside $580, both for the full house.' },
  ],
  health: [],
};

/** Done for you (Today), for W2. */
export const DONE = [
  { id: 'd1', text: 'I added Riley’s dentist visit to Wednesday at 3:30 as a draft.' },
  { id: 'd2', text: 'I drafted a yes to Coach Ellen about Saturday.' },
  { id: 'd3', text: 'I found 3 AI stories for Thursday’s newsletter.' },
];
export const WEEK_COUNTS = { replies: 6, events: 4, pdfs: 2 };
export const SPEND = { month: 1.29, limit: 20 };
