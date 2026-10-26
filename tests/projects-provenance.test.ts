// v2 slice A5: cross-talk provenance. A fact taught in Eventing (its run's memory carries session=p-<eventing>) is
// recalled and SHOWN to a run in Family & school; the answer that uses it names Eventing. Review of A5: a memory that
// was recalled but not shown, or an answer that only shares a name, a month and a year with it, names nothing.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { resetAppDb } from '../src/v2/db.js';
import { createProject, crossTalk, sessionOf } from '../src/v2/projects.js';
import { usedMemoriesIn, distinctiveTokens } from '../src/v2/provenance-match.js';
import { profileTerms } from '../src/person-turn.js';

describe('which shown memories an answer used (review H4)', () => {
  const eventing = { id: 'aa11bb22-0000-0000-0000-000000000000', concept: 'Robert Eventing entries for November', content: 'Robert entered Dakota in the Pine Top horse trials on 2026-11-14, $450 entry.', tags: ['session=p-pr_eventing0001', 'person=Robert'] };
  const comet = { id: 'cc33dd44-0000-0000-0000-000000000000', concept: "Comet's competition", content: "Comet's competition is at Stable View the weekend of Nov 14 (Saturday and Sunday).", tags: ['session=p-pr_eventing0001'] };

  it("probe p3: a name, a month and a year in common is not use", () => {
    const answer = 'Robert, the school holiday concert is on November 20, 2026 at 6pm. I added it to your calendar.';
    expect(usedMemoriesIn([eventing], answer)).toEqual([]);
    expect([...distinctiveTokens(eventing)].sort()).toEqual(['$450', 'dakota', 'eventing', 'pine', 'top']);
  });

  it('the real Comet / Stable View answer is use (curly apostrophes too)', () => {
    const live = 'Possibly, but you mentioned Comet’s competition at Stable View the weekend of November 14, so there may be a clash.';
    expect(usedMemoriesIn([comet], live).map((m) => m.id)).toEqual([comet.id]);
    expect(usedMemoriesIn([eventing], 'Dakota goes to Pine Top this time; the entry was $450.').map((m) => m.id)).toEqual([eventing.id]);
    expect(usedMemoriesIn([eventing], `Per memory ${eventing.id.slice(0, 8)}, yes.`)).toHaveLength(1); // quoting its id
  });

  it("the person's profile names never count, nor weekdays or a single shared word", () => {
    const household = { id: 'ee55ff66-0000-0000-0000-000000000000', concept: 'Riley soccer', content: 'Riley has soccer practice with Coach Sam on Thursday.', tags: [] };
    const terms = profileTerms([{ content: 'Has a daughter, Riley, and a partner, Sam.' }], 'Robert');
    expect(terms).toEqual(expect.arrayContaining(['robert', 'riley', 'sam']));
    expect(usedMemoriesIn([household], 'Riley and Sam can go on Thursday.', terms)).toEqual([]);
    expect(usedMemoriesIn([household], 'Riley and Sam can go on Thursday.')).toHaveLength(1); // without the profile they would count
    expect(usedMemoriesIn([comet], 'The view is lovely this weekend.')).toEqual([]);
  });
});

describe('cross-talk provenance from a fixture memory', () => {
  beforeEach(() => resetAppDb(':memory:'));

  it('an answer in Family & school that used a SHOWN Eventing memory names Eventing; recalled-but-not-shown names nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a5-prov-'));
    const db = join(dir, 'm.db');
    const ev = createProject({ name: 'Eventing' });
    const fam = createProject({ name: 'Family & school' });
    const teach = new MwaMemory('a5-prov', db);
    const ask = new MwaMemory('a5-prov', db);
    try {
      teach.setSessionId(sessionOf(ev.id));
      const id = await teach.write("Comet's competition", "Comet's competition is at Stable View the weekend of Nov 14 (Saturday and Sunday).", ['topic=eventing'], { provenance: 'user' });
      expect(id).toBeTruthy();
      teach.close();

      ask.setSessionId(sessionOf(fam.id));
      const got = await ask.recall('Can we make the book fair on Saturday the 14th?', { limit: 5, full: true });
      expect(got.map((r) => r.id)).toContain(id);
      const answer = "Saturday the 14th clashes: Comet's competition is at Stable View that weekend.";
      // recalled, but the run never put it in front of the model: not used
      expect(await ask.usedMemories(answer)).toEqual([]);
      ask.markShown(got.map((r) => r.id));
      expect(await ask.usedMemories('The book fair is at 3pm.')).toEqual([]); // shown but not used
      const used = await ask.usedMemories(answer);
      expect(used).toEqual([{ id, session: sessionOf(ev.id) }]);
      expect(crossTalk(used, { projectId: fam.id, session: sessionOf(fam.id) })).toEqual([{ projectId: ev.id, n: 1 }]);
      expect(crossTalk(used, { projectId: ev.id, session: sessionOf(ev.id) })).toEqual([]);
      // a new run on the same handle (the scheduler's) starts clean
      ask.resetUse();
      expect(await ask.usedMemories()).toEqual([]);
      expect(await ask.usedMemories(answer)).toEqual([]); // nothing shown in this run yet
      // noteUse (a run's end) records what was shown and used
      ask.markShown([id!]);
      await ask.noteUse("No: Comet's competition at Stable View is that weekend.", 'reply');
      expect((await ask.usedMemories()).map((u) => u.session)).toEqual([sessionOf(ev.id)]);
    } finally {
      ask.close(); teach.close();
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold the SQLite file a moment longer */ }
    }
  }, 120_000);
});
