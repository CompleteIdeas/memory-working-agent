/**
 * S3 proof — per-person LEARN trigger + compressed dossier (docs/true-agent-and-person-profile.md).
 *
 * Proves: (a) the agent learns durable notes about a person from an exchange and writes them scoped;
 * (b) it does NOT re-store facts it already knows (the "stop repeating" goal); (c) once notes reach a
 * cap, the dossier self-recompresses into one bounded note (the materialized-view idea) and supersedes
 * the prior dossier; (d) the primer then uses the dossier as its body. Model calls go through a spy
 * Provider (no network) that branches on the system prompt: learn → notes JSON, compress → bullets.
 *
 *   npx tsx scripts/_person-learn.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { resolvePersonId, buildPersonPrimer } from '../src/person.js';
import { learnAboutPerson, compressPersonDossier } from '../src/person-learn.js';

const dir = mkdtempSync(join(tmpdir(), 'mwa-learn-'));
const dbPath = join(dir, 'agent.db');
const checks: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (n: string, p: boolean, d?: string) => checks.push({ name: n, pass: p, detail: d });

// Spy Provider: learn-call returns a fixed notes JSON; compress-call returns fixed dossier bullets.
function spy(notes: { kind: string; content: string }[]) {
  const calls: string[] = [];
  return {
    calls,
    async chat({ system }: { system: string }) {
      if (/Compress these notes/i.test(system)) { calls.push('compress'); return { text: '• Call her Kim\n• Prefers bullet points, confirm scope first', usage: { input: 1, output: 1 } }; }
      calls.push('learn');
      return { text: JSON.stringify({ notes }), usage: { input: 1, output: 1 } };
    },
  } as any;
}

async function main() {
  const mem = new MwaMemory('learn-test', dbPath);
  const pid = resolvePersonId({ channel: 'web', name: 'Kim' });

  // (a) learn from an exchange → 2 durable notes written
  const brain1 = spy([{ kind: 'style', content: 'likes bullet-point answers' }, { kind: 'strategy', content: 'confirm scope before big tasks' }]);
  const r1 = await learnAboutPerson({ brain: brain1, memory: mem, personId: pid, userMessage: 'just give me bullets, and check with me before big changes', agentReply: 'got it' });
  ok('learned 2 notes from the exchange', r1.learned === 2, JSON.stringify(r1));
  ok('notes are stored + person-scoped', (await mem.recallPersonProfile(pid)).length === 2);

  // (b) same facts again → recognized as known, NOT repeated
  const brain2 = spy([{ kind: 'style', content: 'likes bullet-point answers' }, { kind: 'strategy', content: 'confirm scope before big tasks' }]);
  const r2 = await learnAboutPerson({ brain: brain2, memory: mem, personId: pid, userMessage: 'bullets please, ask before big changes', agentReply: 'ok' });
  ok('already-known facts are skipped (not repeated)', r2.learned === 0 && r2.skipped === 2, JSON.stringify(r2));

  // never learn into the shared/unknown bucket
  const r3 = await learnAboutPerson({ brain: spy([{ kind: 'fact', content: 'x' }]), memory: mem, personId: 'unknown', userMessage: 'hi', agentReply: 'hi' });
  ok('no learning for the shared unknown profile', r3.learned === 0);

  // (c) grow notes past a low cap, then compress → one dossier note, prior notes summarized
  await mem.rememberAboutPerson(pid, 'role: event organizer', 'fact');
  const brainC = spy([]);
  const c1 = await compressPersonDossier({ brain: brainC, memory: mem, personId: pid, name: 'Kim', cap: 3 });
  ok('dossier compressed once notes hit the cap', c1.compressed === true, JSON.stringify(c1));
  const prof = await mem.recallPersonProfile(pid);
  const dossiers = prof.filter((n) => n.kind === 'dossier');
  ok('exactly one dossier note exists', dossiers.length === 1, `got ${dossiers.length}`);
  ok('dossier holds the compressed summary', !!dossiers[0] && /Call her Kim/.test(dossiers[0].content));

  // compress again → still exactly one dossier (prior superseded, not piled up)
  await compressPersonDossier({ brain: spy([]), memory: mem, personId: pid, name: 'Kim', cap: 3 });
  ok('re-compress supersedes, never piles up dossiers', (await mem.recallPersonProfile(pid)).filter((n) => n.kind === 'dossier').length === 1);

  // (d) the primer now uses the dossier as its body (bounded), still surfacing a strategy line
  const primer = buildPersonPrimer(await mem.recallPersonProfile(pid), { name: 'Kim' });
  ok('primer body is the compressed dossier', /Call her Kim/.test(primer));
  ok('primer still surfaces HOW TO ENGAGE', /HOW TO ENGAGE/.test(primer));

  mem.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }

  const passed = checks.filter((c) => c.pass).length;
  console.log('\n=== per-person Profile — S3 (learn trigger + compressed dossier) ===');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  → ${c.detail ?? ''}`}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log('PASS — the agent learns about people, stops repeating known facts, and keeps a bounded self-recompressing dossier.');
}
main().catch((e) => { console.error('person-learn test failed:', e?.stack ?? e); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
