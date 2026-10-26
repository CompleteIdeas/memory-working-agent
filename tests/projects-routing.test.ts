// v2 slice A5: where a message should go. The decision logic runs on a stub embedder (fast, exact); the accuracy gate
// runs the real model AWM loads for recall (bge-small-en-v1.5) on the 40-message fixture, and needs ≥ 80 %. When the
// model cannot be loaded here (no cache, no network) the accuracy case says so and is skipped, the logic cases still run.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resetAppDb } from '../src/v2/db.js';
import { GENERAL, createProject, insertTurn, suggestProject, setEmbedder, decide, routingTokens, updateProject, ROUTING } from '../src/v2/projects.js';
import { loadEmbeddings } from '../src/awm-api.js';

afterAll(() => setEmbedder(null));

/** A stub "embedding": one dimension per topic word list, so the tests say exactly which project a message is near. */
const TOPICS = [['horse', 'dressage', 'saddle', 'eventing', 'farrier'], ['school', 'teacher', 'riley', 'family', 'homework'], ['news', 'newsletter', 'ai', 'model']];
const stub = async (text: string) => {
  const t = text.toLowerCase();
  return [...TOPICS.map((words) => words.filter((w) => t.includes(w)).length), 0.2];
};

function seed() {
  const ev = createProject({ name: 'Eventing' });
  const fam = createProject({ name: 'Family' });
  const ai = createProject({ name: 'AI news' });
  let ts = 1;
  for (const m of ['Book the farrier', 'Practise the dressage test']) insertTurn({ projectId: ev.id, ts: ts++, kind: 'chat', message: m, reply: 'ok' });
  for (const m of ['Email the teacher', 'Riley homework plan']) insertTurn({ projectId: fam.id, ts: ts++, kind: 'chat', message: m, reply: 'ok' });
  for (const m of ['Gather the newsletter stories', 'Summarise the new model']) insertTurn({ projectId: ai.id, ts: ts++, kind: 'chat', message: m, reply: 'ok' });
  return { ev, fam, ai };
}

describe('routing decisions (stub embedder)', () => {
  beforeEach(() => { resetAppDb(':memory:'); setEmbedder(stub); });

  it('from Now or General: a clear match is suggested, with the runners-up', async () => {
    const { ev } = seed();
    const s = await suggestProject('Is the saddle fitter coming for the horse?');
    expect(s).toMatchObject({ projectId: ev.id, confidence: 'suggested' });
    expect(s.alternatives).toHaveLength(2);
    expect(await suggestProject('Is the saddle fitter coming for the horse?', GENERAL)).toMatchObject({ projectId: ev.id, confidence: 'suggested' });
  });

  it('weak or ambiguous: General, "not sure", with the two closest as alternatives', async () => {
    const { ev, fam } = seed();
    const vague = await suggestProject('Thanks!');
    expect(vague).toMatchObject({ projectId: GENERAL, confidence: 'not sure' });
    const tie = await suggestProject('The horse and the school');
    expect(tie.projectId).toBe(GENERAL);
    expect(tie.alternatives.map((a) => a.projectId).sort()).toEqual([ev.id, fam.id].sort());
  });

  it('inside a project it stays there; a strong match elsewhere is a hint, never a switch', async () => {
    const { ev, fam } = seed();
    expect(await suggestProject('Is the saddle fitter coming for the horse?', ev.id)).toEqual({ projectId: ev.id, confidence: 'this project', alternatives: [] });
    const hint = await suggestProject('Did the teacher reply about Riley and school?', ev.id);
    expect(hint).toMatchObject({ projectId: ev.id, confidence: 'this project', alternatives: [{ projectId: fam.id }] });
    expect(await suggestProject('Thanks!', ev.id)).toEqual({ projectId: ev.id, confidence: 'this project', alternatives: [] });
  });

  it('an archived project is never suggested, and the model being unavailable never blocks a send', async () => {
    const { ev } = seed();
    updateProject(ev.id, { archived: true });
    expect((await suggestProject('Is the saddle fitter coming for the horse?')).projectId).not.toBe(ev.id);
    setEmbedder(async () => { throw new Error('no model'); });
    expect(await suggestProject('anything')).toEqual({ projectId: GENERAL, confidence: 'not sure', alternatives: [] });
    const fam = createProject({ name: 'Family 2' });
    expect(await suggestProject('anything', fam.id)).toEqual({ projectId: fam.id, confidence: 'this project', alternatives: [] });
  });

  it('the words that tell projects apart', () => {
    expect([...routingTokens("Can we make the book fair on Saturday the 14th? Thanks, Riley's teachers")].sort()).toEqual(['book', 'fair', 'riley', 'saturday', 'teacher']);
    expect(decide([], undefined)).toEqual({ projectId: GENERAL, confidence: 'not sure', alternatives: [] });
  });
});

// ── Accuracy on the fixture, with the real model ────────────────────────────────────────────────────────────────
const fx = JSON.parse(readFileSync(new URL('./fixtures/routing-40.json', import.meta.url), 'utf8')) as {
  projects: { key: string; name: string; thread: string[] }[]; messages: { text: string; project: string }[]; unsure: string[];
};
let modelOk = false;
try {
  const { embed } = await loadEmbeddings();
  const v = await Promise.race([embed('warm up'), new Promise<null>((r) => setTimeout(() => r(null), 90_000))]);
  modelOk = Array.isArray(v) && v.length > 0;
} catch { modelOk = false; }

describe('routing accuracy on 40 labelled messages (bge-small-en-v1.5)', () => {
  it.skipIf(!modelOk)('suggests the right project for at least 80 % of them, and keeps vague ones in General', async () => {
    resetAppDb(':memory:'); setEmbedder(null);
    const ids = new Map<string, string>();
    let ts = 1;
    for (const p of fx.projects) {
      const row = createProject({ name: p.name });
      ids.set(p.key, row.id);
      for (const m of p.thread) insertTurn({ projectId: row.id, ts: ts++, kind: 'chat', message: m, reply: 'ok' });
    }
    let right = 0, wrongProject = 0;
    for (const m of fx.messages) {
      const s = await suggestProject(m.text);
      if (s.projectId === ids.get(m.project)) right++;
      else if (s.projectId !== GENERAL) wrongProject++;
    }
    let vague = 0;
    for (const t of fx.unsure) if ((await suggestProject(t)).confidence === 'not sure') vague++;
    console.log(`[A5 routing] ${right}/${fx.messages.length} suggested correctly (${Math.round((100 * right) / fx.messages.length)} %), ${wrongProject} sent to a wrong project, ${fx.messages.length - right - wrongProject} left in General as not sure; ${vague}/${fx.unsure.length} vague messages kept in General. Weights ${JSON.stringify(ROUTING)}`);
    expect(right / fx.messages.length).toBeGreaterThanOrEqual(0.8);
    expect(wrongProject).toBeLessThanOrEqual(4);
    expect(vague).toBeGreaterThanOrEqual(3);
  }, 120_000);
  it.skipIf(modelOk)('(skipped: the embedding model could not be loaded here; the logic cases above ran on a stub)', () => {
    console.warn('[A5 routing] embedding model unavailable: accuracy gate not run');
  });
});
