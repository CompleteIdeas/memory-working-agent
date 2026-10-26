// v2 slice A5: cross-talk provenance from a real memory store. A fact taught in Eventing (its run's memory carries
// session=p-<eventing>) is recalled by a run in Family & school; the answer that uses it names Eventing, and one that
// does not use it names nothing.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { resetAppDb } from '../src/v2/db.js';
import { createProject, crossTalk, sessionOf } from '../src/v2/projects.js';

describe('cross-talk provenance from a fixture memory', () => {
  beforeEach(() => resetAppDb(':memory:'));

  it('an answer in Family & school that used an Eventing memory names Eventing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-a5-prov-'));
    const db = join(dir, 'm.db');
    const ev = createProject({ name: 'Eventing' });
    const fam = createProject({ name: 'Family & school' });
    const teach = new MwaMemory('a5-prov', db);
    const ask = new MwaMemory('a5-prov', db);
    try {
      // a run in Eventing: what it writes carries the thread's session
      teach.setSessionId(sessionOf(ev.id));
      const id = await teach.write("Comet's competition", "Comet's competition is at Stable View the weekend of Nov 14 (Saturday and Sunday).", ['topic=eventing'], { provenance: 'user' });
      expect(id).toBeTruthy();
      teach.close();

      // a run in Family & school recalls it and answers with it
      ask.setSessionId(sessionOf(fam.id));
      const got = await ask.recall('Can we make the book fair on Saturday the 14th?', { limit: 5, full: true });
      expect(got.map((r) => r.id)).toContain(id);
      expect(await ask.usedMemories('The book fair is at 3pm.')).toEqual([]); // recalled but not used: not cross-talk
      const used = await ask.usedMemories("Saturday the 14th clashes: Comet's competition is at Stable View that weekend.");
      expect(used).toEqual([{ id, session: sessionOf(ev.id) }]);
      expect(crossTalk(used, fam.id)).toEqual([{ projectId: ev.id, n: 1 }]);
      // in Eventing's own thread it is not cross-talk
      expect(crossTalk(used, ev.id)).toEqual([]);
      // noteUse (the run's end) records what it found the same way
      const ask2 = new MwaMemory('a5-prov', db);
      ask2.setSessionId(sessionOf(fam.id));
      expect((await ask2.recall('Can we make the book fair on Saturday the 14th?', { limit: 5, full: true })).map((r) => r.id)).toContain(id);
      await ask2.noteUse("No: Comet's competition at Stable View is that weekend.", 'reply');
      expect((await ask2.usedMemories()).map((u) => u.session)).toEqual([sessionOf(ev.id)]);
      ask2.close();
    } finally {
      ask.close(); teach.close();
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold the SQLite file a moment longer */ }
    }
  }, 120_000);
});
