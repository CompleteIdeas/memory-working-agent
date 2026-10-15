/**
 * S1 proof — per-person Profile foundation (docs/true-agent-and-person-profile.md).
 *
 * Proves the privacy invariant that everything else rests on: person A's profile notes are HARD-isolated
 * from person B (recallPersonProfile(A) never returns B's notes, and vice-versa), the note `kind`
 * (incl. the adaptive `strategy` dimension) round-trips, and identity normalization is stable/idempotent.
 *
 *   npx tsx scripts/_person-scope.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MwaMemory } from '../src/awm.js';
import { normalizePersonId, resolvePersonId } from '../src/person.js';

const dir = mkdtempSync(join(tmpdir(), 'mwa-person-'));
const dbPath = join(dir, 'agent.db');
const checks: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (n: string, p: boolean, d?: string) => checks.push({ name: n, pass: p, detail: d });

async function main() {
  // identity normalization — stable, tag-safe, idempotent, channel-qualified
  ok('email normalizes as-is', normalizePersonId('Rob@Example.com') === 'rob@example.com');
  ok('spaces/commas/colons → underscore', normalizePersonId('Jane Doe, VIP: 3') === 'jane_doe_vip_3', normalizePersonId('Jane Doe, VIP: 3'));
  ok('normalize is idempotent', normalizePersonId(normalizePersonId('Jane Doe')) === normalizePersonId('Jane Doe'));
  ok('telegram id is channel-qualified', resolvePersonId({ channel: 'tg', id: 1000000001 }) === 'tg-1000000001', resolvePersonId({ channel: 'tg', id: 1000000001 }));
  ok('missing identity → shared unknown', resolvePersonId(undefined) === 'unknown' && resolvePersonId({ channel: 'web' }) === 'unknown');

  const mem = new MwaMemory('person-test', dbPath);
  const A = resolvePersonId({ channel: 'tg', id: 111 });   // tg-111
  const B = resolvePersonId({ email: 'jen@example.org' });

  // person A: non-technical, wants the why, needs gentle probing to surface the real question
  await mem.rememberAboutPerson(A, 'prefers short plain-language answers, no jargon', 'style');
  await mem.rememberAboutPerson(A, 'cares about the "why", not the how', 'preference');
  await mem.rememberAboutPerson(A, 'ask one clarifying question first — she under-specifies requests', 'strategy');
  // person B: power user, terse + technical, give options not questions
  await mem.rememberAboutPerson(B, 'wants terse, technical answers with exact identifiers', 'style');
  await mem.rememberAboutPerson(B, 'offer 2-3 concrete options rather than asking open questions', 'strategy');

  const profA = await mem.recallPersonProfile(A);
  const profB = await mem.recallPersonProfile(B);

  ok('A has exactly 3 notes', profA.length === 3, `got ${profA.length}`);
  ok('B has exactly 2 notes', profB.length === 2, `got ${profB.length}`);

  // THE INVARIANT: no cross-person bleed, in either direction
  const aText = profA.map((n) => n.content).join(' | ');
  const bText = profB.map((n) => n.content).join(' | ');
  ok('A profile contains none of B', !/terse|jen|options rather/i.test(aText), aText);
  ok('B profile contains none of A', !/plain-language|clarifying question|the "why"/i.test(bText), bText);
  ok('every A note is tagged personId A', profA.every((n) => n.personId === A));

  // the adaptive-interaction (strategy) dimension round-trips and is retrievable per person
  const stratA = profA.find((n) => n.kind === 'strategy');
  const stratB = profB.find((n) => n.kind === 'strategy');
  ok('A strategy note preserved', !!stratA && /clarifying question/i.test(stratA.content), stratA?.content);
  ok('B strategy differs from A', !!stratB && stratB.content !== stratA?.content && /options/i.test(stratB.content), stratB?.content);

  // listPeople aggregates distinct people (powers the "people I know" view)
  const people = await mem.listPeople();
  ok('listPeople returns exactly the 2 known people', people.length === 2, `got ${people.length}`);
  ok('listPeople is isolated (A and B both present, distinct)', people.some((x) => x.personId === A) && people.some((x) => x.personId === B));

  // an unknown person yields an empty (shared) profile — never another person's data
  ok('unknown person → empty profile', (await mem.recallPersonProfile('nobody-here')).length === 0);
  // empty content is a no-op, not a blank engram
  ok('empty note is a no-op', (await mem.rememberAboutPerson(A, '   ', 'fact')) === null && (await mem.recallPersonProfile(A)).length === 3);

  mem.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }

  const passed = checks.filter((c) => c.pass).length;
  console.log('\n=== per-person Profile — S1 (identity + person-scoped memory) ===');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  → ${c.detail ?? ''}`}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log('PASS — person profiles are isolated per person; kinds (incl. strategy) round-trip; identity is stable.');
}
main().catch((e) => { console.error('person-scope test failed:', e?.stack ?? e); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
