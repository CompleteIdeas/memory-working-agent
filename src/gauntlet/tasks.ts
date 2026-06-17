/**
 * The gauntlet's fictional world + the ordered task chain. Tasks are delivered as separate
 * sessions with a HARD context reset and a WIPED working dir between each — so the ONLY thing
 * that can carry a fact from a seed task to a later probe is the memory substrate under test.
 *
 * HARDENED suite: a dense, confusable world (3 projects × {owner, codename, budget}, churning
 * dates, a taught transformation rule, a 3-term glossary), deep gaps between seed and probe,
 * and probes that need disambiguation / multi-hop / supersession / cross-session assembly —
 * the patterns the literature + the Codex consult flagged as where capable agents break.
 * Seeds are kept ≤6 facts each so the harness's auto-learn cap (6) doesn't silently drop facts
 * for ANY arm (the cap is a held-constant; splitting keeps it from causing a floor effect).
 *
 * Difficulty is memory-SENSITIVE, not reasoning-sensitive: every probe asks for a specific
 * value stated earlier that cannot be derived from the probe text. Failure is informative.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResult } from '../agent.js';

export const WORLD = {
  scheduler: 'Sarah Chen',
  engLead: 'Marcus Lee',
  designLead: 'Priya Rao',
  // 3 confusable projects. main = Atlas. Atlas due churns July 1 → Sep 30 → Aug 15.
  projects: {
    Atlas: { owner: 'Marcus Lee', codename: 'Magpie', budget: '$42,000', dueFinal: 'August 15' },
    Borealis: { owner: 'Priya Rao', codename: 'Heron', budget: '$18,500', due: 'July 1' },
    Cygnus: { owner: 'Sarah Chen', codename: 'Falcon', budget: '$73,000', due: 'October 3' },
  },
  glossary: { spinwave: 'the weekly status sync', redbook: 'the compliance checklist', glasshouse: 'the staging environment' },
};

export interface ScoreCtx { dir: string; result: AgentResult }
export interface GauntletTask {
  id: string;
  mechanism: string;
  memoryDependent: boolean;
  instruction: string;
  setup?: (dir: string) => void;
  score: (ctx: ScoreCtx) => { pass: boolean; note: string };
}

const lc = (s: string) => (s || '').toLowerCase().replace(/[‘’]/g, "'"); // normalize curly→straight apostrophes (models emit ’, scorers match ')
const ans = (c: ScoreCtx) => lc(c.result.summary);
const ran = (c: ScoreCtx) => ({ pass: c.result.reason === 'done', note: c.result.reason });

export const TASKS: GauntletTask[] = [
  // ---------- SEED / SETUP sessions (≤6 facts each; scored on "did it run") ----------
  {
    id: 's1-people', mechanism: 'seed', memoryDependent: false,
    instruction: "Please remember, for later: my scheduler/assistant is Sarah Chen, Marcus Lee leads engineering, and Priya Rao leads design. My main project is called Atlas. Confirm you've noted them.",
    score: ran,
  },
  {
    id: 's2-owners', mechanism: 'seed', memoryDependent: false,
    instruction: "Project ownership to remember: Atlas is owned by Marcus Lee, Borealis is owned by Priya Rao, and Cygnus is owned by Sarah Chen. Confirm.",
    score: ran,
  },
  {
    id: 's3-codenames', mechanism: 'seed', memoryDependent: false,
    instruction: "Internal codenames to remember: Atlas's codename is Magpie, Borealis's codename is Heron, and Cygnus's codename is Falcon. Confirm.",
    score: ran,
  },
  {
    id: 's4-budgets', mechanism: 'seed', memoryDependent: false,
    instruction: "Budgets to remember: Atlas is $42,000, Borealis is $18,500, and Cygnus is $73,000. Confirm.",
    score: ran,
  },
  {
    id: 's5-skill', mechanism: 'seed', memoryDependent: false,
    instruction: "A rule to remember and apply later: the 'release tag' of a project is the word REL- followed by that project's codename in capital letters. For example, a project codenamed Robin has the release tag REL-ROBIN. Confirm you understand the rule.",
    score: ran,
  },
  {
    id: 's6-glossary', mechanism: 'seed', memoryDependent: false,
    instruction: "Three internal terms to remember: 'spinwave' means the weekly status sync; 'redbook' means the compliance checklist; 'glasshouse' means the staging environment. Confirm.",
    score: ran,
  },
  {
    id: 's7-policy', mechanism: 'seed', memoryDependent: false,
    instruction: "Please remember a standing preference: end every note or status file you write with a closing line that says 'Regards, Rob'. Confirm you'll do this from now on.",
    score: ran,
  },
  {
    id: 's8-update1', mechanism: 'seed', memoryDependent: false,
    instruction: "Update: Atlas's due date has moved from July 1 to September 30. Note the change.",
    score: ran,
  },
  {
    id: 's9-filler', mechanism: 'filler', memoryDependent: false,
    instruction: 'Quick unrelated question: what is 17 multiplied by 23? Reply with just the number.',
    score: (c) => ({ pass: /391/.test(ans(c)), note: ans(c).slice(0, 30) }),
  },
  {
    id: 's10-update2', mechanism: 'seed', memoryDependent: false,
    instruction: "Another update: Atlas's due date moved again, from September 30 to August 15. Note the new date.",
    score: ran,
  },

  // ---------------------------- PROBES (memory-dependent) ----------------------------
  {
    id: 'recall-person', mechanism: 'recall', memoryDependent: true,
    instruction: 'Who leads design? Reply in one short line.',
    score: (c) => ({ pass: /priya/.test(ans(c)), note: ans(c).slice(0, 50) }),
  },
  {
    id: 'multihop', mechanism: 'multihop', memoryDependent: true,
    // 3 hops, no restatement: scheduler → Sarah → owns Cygnus → codename Falcon.
    instruction: 'What is the codename of the project owned by my scheduler? Reply with just the codename.',
    score: (c) => ({ pass: /falcon/.test(ans(c)) && !/magpie|heron/.test(ans(c)), note: ans(c).slice(0, 50) }),
  },
  {
    id: 'supersede-due', mechanism: 'supersede', memoryDependent: true,
    instruction: 'When is Atlas due now? Reply with just the date.',
    score: (c) => {
      const a = ans(c);
      return { pass: (/aug(ust)?\s*\.?\s*15|8\s*[\/-]\s*15/.test(a)) && !/(jul(y)?\b|sept(ember)?|9\s*[\/-]\s*30|7\s*[\/-]\s*1)/.test(a), note: a.slice(0, 50) };
    },
  },
  {
    id: 'distractor-codename', mechanism: 'distractor', memoryDependent: true,
    // disambiguate among 3 codenames
    instruction: "What is Borealis's codename? Reply with just the codename.",
    score: (c) => ({ pass: /heron/.test(ans(c)) && !/magpie|falcon/.test(ans(c)), note: ans(c).slice(0, 50) }),
  },
  {
    id: 'distractor-budget', mechanism: 'distractor', memoryDependent: true,
    instruction: 'What is the budget of Cygnus? Reply with just the number.',
    score: (c) => ({ pass: /73[,.]?000|\$?73k/.test(ans(c)) && !/42|18/.test(ans(c)), note: ans(c).slice(0, 50) }),
  },
  {
    id: 'sparse-cue', mechanism: 'sparse-cue', memoryDependent: true,
    instruction: 'What is the internal codename for my main project? Reply with just the codename.',
    score: (c) => ({ pass: /magpie/.test(ans(c)) && !/heron|falcon/.test(ans(c)), note: ans(c).slice(0, 50) }),
  },
  {
    id: 'skill-apply', mechanism: 'skill', memoryDependent: true,
    // needs the taught rule (REL-<CODENAME>) + Borealis's codename (Heron) → REL-HERON
    instruction: 'Using the release-tag rule I taught you, what is the release tag for Borealis? Reply with just the tag.',
    score: (c) => ({ pass: /rel-\s*heron/.test(ans(c).replace(/\s+/g, ' ')), note: ans(c).slice(0, 50) }),
  },
  {
    id: 'composite', mechanism: 'composite', memoryDependent: true,
    // assemble ALL glossary terms from memory after the working dir was wiped
    instruction: 'Write a file called glossary.md in this folder listing every internal term I have taught you, one per line, each with its meaning.',
    score: (c) => {
      let body = '';
      try { body = lc(readFileSync(join(c.dir, 'glossary.md'), 'utf8')); } catch { /* */ }
      const have = ['spinwave', 'redbook', 'glasshouse'].filter((t) => body.includes(t));
      return { pass: have.length === 3, note: body ? `${have.length}/3 terms` : 'no file' };
    },
  },
  {
    id: 'policy-signoff', mechanism: 'policy', memoryDependent: true,
    instruction: 'Write a one-line status note about Atlas and save it to status.txt in this folder.',
    score: (c) => {
      let body = '';
      try { body = readFileSync(join(c.dir, 'status.txt'), 'utf8'); } catch { /* */ }
      const signed = /regards,?\s*rob|[—–-]{1,2}\s*rob/i.test(body);
      return { pass: body.length > 0 && signed, note: body ? (signed ? 'signed' : 'no signoff') : 'no file' };
    },
  },
  {
    id: 'abstain', mechanism: 'abstain', memoryDependent: false, // safety check, not a memory-compounding differentiator
    instruction: "What is my spouse's name? Reply in one short line.",
    score: (c) => {
      const a = ans(c);
      const abstained = /(don'?t|do not|haven'?t|never|no record|not (sure|told|aware|mentioned|provided)|isn'?t something|unknown|you haven'?t|could ?n'?t (find|locate)|could not (find|locate)|no (info|information)|wasn'?t (told|given|provided)|i don'?t have)/.test(a);
      return { pass: abstained, note: a.slice(0, 50) };
    },
  },
];

// ============================ CONTEXT-SWITCHING SUITE ============================
// AWM's standout that plain RAG / notes structurally lack. Four clients with PARALLEL-shaped
// attributes (contact / deadline / budget) are seeded INTERLEAVED across sessions; then the
// probes switch client every single turn. Because "Apex's deadline" and "Beacon's deadline"
// are near-identical in embedding space, cosine-RAG tends to pull the WRONG client's value
// (bleed) and a lexical notes file bleeds too; AWM's entity/session bridges should keep each
// context separate. The scorer rewards the right client's value AND penalizes any OTHER
// client's same-type value appearing — i.e. it measures CONTEXT BLEED, not just recall.
const CLIENTS = {
  Apex: { contact: 'Dana Cole', deadline: 'March 3', budget: '$12,000' },
  Beacon: { contact: 'Owen Wells', deadline: 'May 9', budget: '$30,000' },
  Cedar: { contact: 'Lena Ford', deadline: 'June 21', budget: '$8,500' },
  Delta: { contact: 'Raj Patel', deadline: 'August 14', budget: '$55,000' },
};
export const CONTEXT_WORLD = CLIENTS;

const seed = (id: string, name: keyof typeof CLIENTS): GauntletTask => ({
  id, mechanism: 'seed', memoryDependent: false,
  instruction: `Remember these details for the ${name} account: the main contact is ${CLIENTS[name].contact}, the deadline is ${CLIENTS[name].deadline}, and the budget is ${CLIENTS[name].budget}. Confirm.`,
  score: ran,
});

// a switch-probe: ask one attribute of one client; pass = that client's value present AND none
// of the OTHER clients' values for that same attribute present (bleed).
const others = (name: keyof typeof CLIENTS, attr: 'contact' | 'deadline' | 'budget') =>
  (Object.keys(CLIENTS) as (keyof typeof CLIENTS)[]).filter((n) => n !== name).map((n) => CLIENTS[n][attr]);
const probe = (id: string, name: keyof typeof CLIENTS, attr: 'contact' | 'deadline' | 'budget', q: string): GauntletTask => ({
  id, mechanism: 'context-switch', memoryDependent: true,
  instruction: q,
  score: (c) => {
    const a = ans(c);
    const want = lc(CLIENTS[name][attr]).replace(/[$,]/g, '');
    const norm = a.replace(/[$,]/g, '');
    const hit = norm.includes(want) || (attr !== 'budget' && norm.includes(lc(CLIENTS[name][attr].split(' ')[0])));
    const bled = others(name, attr).some((v) => {
      const vn = lc(v).replace(/[$,]/g, '');
      return norm.includes(vn) || (attr === 'contact' && norm.includes(lc(v.split(' ')[0])));
    });
    return { pass: hit && !bled, note: (bled ? 'BLEED ' : '') + a.slice(0, 45) };
  },
});

export const CONTEXT_TASKS: GauntletTask[] = [
  // interleaved seeds (rotate clients; each across non-adjacent sessions)
  seed('seed-apex-1', 'Apex'), seed('seed-beacon-1', 'Beacon'), seed('seed-cedar-1', 'Cedar'), seed('seed-delta-1', 'Delta'),
  // a filler gap, then probes that SWITCH client every turn
  {
    id: 'cs-filler', mechanism: 'filler', memoryDependent: false,
    instruction: 'Quick unrelated question: what is 12 plus 30? Reply with just the number.',
    score: (c) => ({ pass: /\b42\b/.test(ans(c)), note: ans(c).slice(0, 20) }),
  },
  probe('cs-1', 'Cedar', 'contact', 'For the Cedar account, who is the main contact? Reply with just the name.'),
  probe('cs-2', 'Apex', 'deadline', 'What is the deadline for the Apex account? Reply with just the date.'),
  probe('cs-3', 'Delta', 'budget', 'What is the budget for the Delta account? Reply with just the number.'),
  probe('cs-4', 'Beacon', 'contact', 'Who is the main contact for the Beacon account? Reply with just the name.'),
  probe('cs-5', 'Cedar', 'budget', 'What is the budget for the Cedar account? Reply with just the number.'),
  probe('cs-6', 'Beacon', 'deadline', 'What is the deadline for the Beacon account? Reply with just the date.'),
  probe('cs-7', 'Delta', 'contact', 'Who is the main contact for the Delta account? Reply with just the name.'),
  probe('cs-8', 'Apex', 'budget', 'What is the budget for the Apex account? Reply with just the number.'),
  // ASSOCIATION across contexts — must pull TWO accounts and relate them (RAG/notes tend to
  // surface one or bleed; AWM associates).
  {
    id: 'cs-assoc-budget', mechanism: 'association', memoryDependent: true,
    instruction: 'Which account has the larger budget: Apex or Delta? Reply with just the account name.',
    score: (c) => ({ pass: /delta/.test(ans(c)) && !/apex/.test(ans(c)), note: ans(c).slice(0, 45) }), // 55k > 12k
  },
  {
    id: 'cs-assoc-contacts', mechanism: 'association', memoryDependent: true,
    instruction: 'List the main contacts for the Beacon and Cedar accounts.',
    score: (c) => { const a = ans(c); return { pass: /owen/.test(a) && /lena/.test(a) && !/dana|raj/.test(a), note: a.slice(0, 45) }; },
  },
];

export const SUITES: Record<string, GauntletTask[]> = { memory: TASKS, contextswitch: CONTEXT_TASKS };

/** A filler distractor to PAD the store — simulates notes accumulated over a large corpus
 *  (the "what if I have 10,000 docs/accounts" case). CRITICAL: these are NEAR-DUPLICATES of the
 *  real account facts (same contact/deadline/budget structure) — NOT off-topic notes. Off-topic
 *  padding creates zero interference (every arm scored 100% at pad=1000); to actually stress
 *  retrieval precision at scale, "Apex's deadline" must compete with hundreds of similar
 *  "<Acct>'s deadline" facts in embedding + lexical space. Names are drawn from pools DISJOINT
 *  from the real clients' so a distractor never becomes a correct answer. Deterministic (index,
 *  no RNG) so runs reproduce. */
const PAD_FIRST = ['Alex', 'Jordan', 'Sam', 'Riley', 'Taylor', 'Casey', 'Morgan', 'Quinn', 'Drew', 'Reese'];
const PAD_LAST = ['Nguyen', 'Park', 'Silva', 'Khan', 'Reyes', 'Brooks', 'Hale', 'Ortiz', 'Vance', 'Doyle'];
const PAD_MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function padNote(i: number): { concept: string; content: string } {
  const name = `Acct-${String(i).padStart(4, '0')}`;
  const contact = `${PAD_FIRST[i % PAD_FIRST.length]} ${PAD_LAST[(i * 7) % PAD_LAST.length]}`;
  const deadline = `${PAD_MONTH[i % 12]} ${(i % 27) + 1}`;
  const budget = `$${(i % 90) + 5},000`;
  return {
    concept: `account: ${name}`,
    content: `The ${name} account: the main contact is ${contact}, the deadline is ${deadline}, and the budget is ${budget}.`,
  };
}
