/**
 * Gauntlet memory arms — the SINGLE independent variable of the experiment. Each arm is a
 * drop-in `Memory` implementation; the agent harness is byte-identical across all four.
 *
 *   awm        — the real cognitive substrate (MwaMemory): semantic recall, supersede, salience.
 *   off        — NullMemory: recall→[], write→noop. The no-memory control (one bit flipped).
 *   notes      — naive DIY: an append-only flat notes file, recalled by LEXICAL substring match
 *                only (no embeddings, no supersede, no ranking). The "just keep notes" baseline.
 *   longctx    — no retrieval: recall returns the ENTIRE store (the "stuff it all in context"
 *                baseline). Capped to a byte budget so it can't win by unbounded brute force;
 *                the harness's primeCap is raised for this arm so the dump actually reaches the
 *                prompt. This is a DIFFERENT MECHANISM, reported as such — not a clean control.
 *
 * notes + longctx persist to a JSON file so state carries across the gauntlet's sessions; the
 * file lives in a SEPARATE store dir (never the per-task working dir, which is wiped between
 * tasks) so the ONLY cross-task carryover is the memory substrate.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { embed, cosineSimilarity } from 'agent-working-memory/dist/core/embeddings.js';
import type { Memory, RecalledMemory, WriteOpts } from '../awm.js';
import { MwaMemory, NullMemory } from '../awm.js';

export type ArmName = 'awm' | 'off' | 'notes' | 'longctx' | 'rag';

interface Entry { id: string; concept: string; content: string; tags: string[] }

/** Shared file-backed store for the notes + long-context arms (differ only in recall()). */
abstract class FileMemory implements Memory {
  readonly enabled = true;
  protected entries: Entry[] = [];
  private seq = 0;
  private sessionId?: string;
  constructor(protected readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) { try { this.entries = JSON.parse(readFileSync(path, 'utf8')); } catch { this.entries = []; } }
    this.seq = this.entries.length;
  }
  private save(): void { try { writeFileSync(this.path, JSON.stringify(this.entries)); } catch { /* */ } }

  abstract recall(query: string, opts?: { limit?: number; full?: boolean; workspace?: string }): Promise<RecalledMemory[]>;

  async write(concept: string, content: string, tags: string[] = [], _opts: WriteOpts = {}): Promise<string | null> {
    const id = `e${++this.seq}`;
    this.entries.push({ id, concept: concept.slice(0, 80), content, tags });
    this.save();
    return id;
  }
  // Naive DIY supersede = APPEND a correction; the old line stays (notes files go stale — the point).
  async supersede(_oldId: string, concept: string, content: string, tags: string[] = [], opts: WriteOpts = {}): Promise<string | null> {
    return this.write(concept, content, tags, opts);
  }
  setSessionId(id: string): void { this.sessionId = id; void this.sessionId; }
  async feedback(): Promise<void> { /* no learning signal in a flat file */ }
  async consolidate(): Promise<Record<string, number>> { return {}; }
  async addScheduledTask(): Promise<string | null> { return null; }
  async saveSkill(name: string, steps: string): Promise<string | null> {
    return this.write(`skill: ${name}`.slice(0, 80), steps, ['topic=skill']);
  }
  async saveFriction(topic: string, lesson: string): Promise<string | null> {
    return this.write(`lesson: ${topic}`.slice(0, 80), lesson, ['topic=friction']);
  }
  async savePolicy(rule: string): Promise<string | null> {
    return this.write(`policy: ${rule}`.slice(0, 80), rule.trim(), ['topic=policy']);
  }
  // Standing policies CAN live in a flat file too — the arms differ on recall QUALITY, not on
  // whether a rule can be stored. So this is fair: policy carryover works for notes/longctx;
  // only the no-memory arm forgets.
  listPolicies(): string[] {
    const seen = new Set<string>(); const out: string[] = [];
    for (const e of [...this.entries].reverse()) {
      if (!e.tags.includes('topic=policy')) continue;
      const k = e.content.toLowerCase().trim();
      if (e.content && !seen.has(k)) { seen.add(k); out.push(e.content); }
    }
    return out;
  }
  async saveQuestion(q: string): Promise<string | null> { return this.write(`question: ${q}`.slice(0, 80), q, ['topic=open-question']); }
  close(): void { this.save(); }
}

/** notes arm — recall by LEXICAL substring match only (no semantics, no ranking by salience). */
class NotesMemory extends FileMemory {
  async recall(query: string, opts: { limit?: number } = {}): Promise<RecalledMemory[]> {
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    const scored = this.entries.map((e) => {
      const hay = `${e.concept} ${e.content}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { e, score };
    }).filter((x) => x.score > 0);
    // tie-break OLDEST-first (you scroll your notes top-down and hit the stale line first) —
    // so a later correction does NOT automatically outrank the original it superseded.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit ?? 5).map((x) => ({ id: x.e.id, concept: x.e.concept, content: x.e.content, score: x.score }));
  }
}

/** longctx arm — NO retrieval: return the whole store (newest-first), capped to a byte budget. */
class LongCtxMemory extends FileMemory {
  constructor(path: string, private readonly byteBudget: number) { super(path); }
  async recall(_query: string, opts: { limit?: number } = {}): Promise<RecalledMemory[]> {
    const out: RecalledMemory[] = []; let bytes = 0;
    for (const e of [...this.entries].reverse()) {
      bytes += e.concept.length + e.content.length;
      if (bytes > this.byteBudget) break; // capped so it can't win by unbounded context
      out.push({ id: e.id, concept: e.concept, content: e.content, score: 1 });
      if (out.length >= (opts.limit ?? 1000)) break;
    }
    return out;
  }
}

/**
 * rag arm — the STRONG baseline + the controlled head-to-head. Uses AWM's OWN embedding model
 * (same vectors) but plain cosine top-k retrieval — and NONE of AWM's cognitive layer: no
 * salience gating, no supersede (a correction is just appended → both vectors compete, the
 * classic RAG staleness failure), no cross-encoder rerank, no query expansion, no consolidation.
 * So awm-vs-rag isolates exactly what the cognitive machinery adds over a well-tuned vector DB.
 */
class VectorRagMemory implements Memory {
  readonly enabled = true;
  private entries: { id: string; concept: string; content: string; tags: string[]; vec: number[] }[] = [];
  private seq = 0;
  constructor(private readonly path: string, private readonly topK = 6) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) { try { this.entries = JSON.parse(readFileSync(path, 'utf8')); } catch { this.entries = []; } }
    this.seq = this.entries.length;
  }
  private save(): void { try { writeFileSync(this.path, JSON.stringify(this.entries)); } catch { /* */ } }
  async recall(query: string, opts: { limit?: number } = {}): Promise<RecalledMemory[]> {
    if (!this.entries.length) return [];
    let qv: number[]; try { qv = await embed(query); } catch { return []; }
    const scored = this.entries.map((e) => ({ e, score: cosineSimilarity(qv, e.vec) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit ?? this.topK).map((x) => ({ id: x.e.id, concept: x.e.concept, content: x.e.content, score: x.score }));
  }
  async write(concept: string, content: string, tags: string[] = [], _opts: WriteOpts = {}): Promise<string | null> {
    const id = `e${++this.seq}`;
    let vec: number[] = []; try { vec = await embed(`${concept}. ${content}`); } catch { /* */ }
    this.entries.push({ id, concept: concept.slice(0, 80), content, tags, vec });
    this.save();
    return id;
  }
  async supersede(_o: string, concept: string, content: string, tags: string[] = [], opts: WriteOpts = {}): Promise<string | null> {
    return this.write(concept, content, tags, opts); // append only — no real supersede (the point)
  }
  setSessionId(): void { /* */ }
  async feedback(): Promise<void> { /* */ }
  async consolidate(): Promise<Record<string, number>> { return {}; }
  async addScheduledTask(): Promise<string | null> { return null; }
  async saveSkill(n: string, s: string): Promise<string | null> { return this.write(`skill: ${n}`.slice(0, 80), s, ['topic=skill']); }
  async saveFriction(t: string, l: string): Promise<string | null> { return this.write(`lesson: ${t}`.slice(0, 80), l, ['topic=friction']); }
  async savePolicy(r: string): Promise<string | null> { return this.write(`policy: ${r}`.slice(0, 80), r.trim(), ['topic=policy']); }
  listPolicies(): string[] {
    const seen = new Set<string>(); const out: string[] = [];
    for (const e of [...this.entries].reverse()) { if (!e.tags.includes('topic=policy')) continue; const k = e.content.toLowerCase().trim(); if (e.content && !seen.has(k)) { seen.add(k); out.push(e.content); } }
    return out;
  }
  async saveQuestion(q: string): Promise<string | null> { return this.write(`question: ${q}`.slice(0, 80), q, ['topic=open-question']); }
  close(): void { this.save(); }
}

/**
 * Wraps any Memory to METER it: recall/write latency + call counts + result volume. This is
 * how the gauntlet measures the axes pass-rate hides — SPEED (mean recall ms; AWM's in-process
 * ~300ms vs a network-backed system) and how much it returns (feeds the token-efficiency story:
 * a small pruned recall costs far fewer prompt tokens than a full-context dump).
 */
export class MeteredMemory implements Memory {
  readonly enabled: boolean;
  recallMs = 0; recallCalls = 0; recallResults = 0; writeMs = 0; writeCalls = 0;
  constructor(private readonly inner: Memory) { this.enabled = inner.enabled; }
  async recall(q: string, opts?: { limit?: number; full?: boolean; workspace?: string }): Promise<RecalledMemory[]> {
    const t = Date.now(); const r = await this.inner.recall(q, opts);
    this.recallMs += Date.now() - t; this.recallCalls++; this.recallResults += r.length; return r;
  }
  async write(c: string, content: string, tags?: string[], opts?: WriteOpts): Promise<string | null> {
    const t = Date.now(); const r = await this.inner.write(c, content, tags, opts);
    this.writeMs += Date.now() - t; this.writeCalls++; return r;
  }
  async supersede(o: string, c: string, content: string, tags?: string[], opts?: WriteOpts): Promise<string | null> { return this.inner.supersede(o, c, content, tags, opts); }
  setSessionId(id: string): void { this.inner.setSessionId(id); }
  async feedback(id: string, useful: boolean): Promise<void> { return this.inner.feedback(id, useful); }
  async consolidate(): Promise<Record<string, number>> { return this.inner.consolidate(); }
  async addScheduledTask(i: string, d: number, o?: { recur?: string; notify?: string; dir?: string; resumeAttempt?: number }): Promise<string | null> { return this.inner.addScheduledTask(i, d, o); }
  async saveSkill(n: string, s: string): Promise<string | null> { return this.inner.saveSkill(n, s); }
  async saveFriction(t: string, l: string): Promise<string | null> { return this.inner.saveFriction(t, l); }
  async savePolicy(r: string): Promise<string | null> { return this.inner.savePolicy(r); }
  listPolicies(): string[] { return this.inner.listPolicies(); }
  async saveQuestion(q: string): Promise<string | null> { return this.inner.saveQuestion(q); }
  close(): void { this.inner.close(); }
  stats(): { recallCalls: number; meanRecallMs: number; meanRecallResults: number; writeCalls: number; meanWriteMs: number } {
    return {
      recallCalls: this.recallCalls,
      meanRecallMs: this.recallCalls ? this.recallMs / this.recallCalls : 0,
      meanRecallResults: this.recallCalls ? this.recallResults / this.recallCalls : 0,
      writeCalls: this.writeCalls,
      meanWriteMs: this.writeCalls ? this.writeMs / this.writeCalls : 0,
    };
  }
}

export interface Arm { name: ArmName; memory: MeteredMemory; primeCap?: number; note: string }

/** Build an arm's memory substrate. `storeDir` persists across the gauntlet's sessions; it is
 *  SEPARATE from the per-task working dir (which is wiped between tasks). */
export function makeArm(name: ArmName, storeDir: string, byteBudget = 6000): Arm {
  mkdirSync(storeDir, { recursive: true });
  const wrap = (inner: Memory, extra: Partial<Arm> = {}): Arm => ({ name, memory: new MeteredMemory(inner), note: extra.note ?? '', primeCap: extra.primeCap });
  switch (name) {
    case 'awm': return wrap(new MwaMemory(`gauntlet-awm`, join(storeDir, 'awm.db')), { note: 'cognitive recall + supersede + salience' });
    case 'off': return wrap(new NullMemory(), { note: 'no memory (control)' });
    case 'notes': return wrap(new NotesMemory(join(storeDir, 'notes.json')), { note: 'flat notes, lexical match only' });
    case 'longctx': return wrap(new LongCtxMemory(join(storeDir, 'longctx.json'), byteBudget), { primeCap: 200, note: `full-dump context, capped ${byteBudget}B` });
    case 'rag': return wrap(new VectorRagMemory(join(storeDir, 'rag.json')), { note: 'vector RAG (same embeddings, no cognitive layer)' });
  }
}

/** Build a CROSS-AGENT pair (agent A + agent B) for the shared-substrate benchmark. The
 *  sharing semantics ARE the variable under test:
 *   - awm: A and B are DIFFERENT agent ids on the SAME store + workspace → B recalls A's writes.
 *   - rag/notes/longctx: A and B get SEPARATE per-process stores → B CANNOT see A's writes
 *     (a library/file is per-process; this is the structural thing a shared substrate fixes).
 *   - off: neither remembers.
 *  This is the one test AWM should win by construction — RAG-as-a-library can't share at all. */
export function makeCrossAgentPair(name: ArmName, dir: string): { a: Memory; b: Memory } {
  mkdirSync(dir, { recursive: true });
  switch (name) {
    case 'awm': {
      const db = join(dir, 'shared.db');
      return { a: new MwaMemory('xagent-A', db, 'team'), b: new MwaMemory('xagent-B', db, 'team') };
    }
    case 'rag': return { a: new VectorRagMemory(join(dir, 'ragA.json')), b: new VectorRagMemory(join(dir, 'ragB.json')) };
    case 'notes': return { a: new NotesMemory(join(dir, 'notesA.json')), b: new NotesMemory(join(dir, 'notesB.json')) };
    case 'longctx': return { a: new LongCtxMemory(join(dir, 'lcA.json'), 6000), b: new LongCtxMemory(join(dir, 'lcB.json'), 6000) };
    case 'off': return { a: new NullMemory(), b: new NullMemory() };
  }
}
