/**
 * S6 v2 integration proof — step-up challenge lifecycle + the REAL enforcement at the approval gate.
 *
 * Proves: (a) a code is delivered out-of-band, wrong codes fail, the right one passes, single-use, and
 * the person becomes step-up-satisfied; (b) delivery failure → no challenge; (c) attempts are capped;
 * (d) THE INTEGRATION — a sensitive action wrapped in requireApproval() is BLOCKED at confirmPending
 * for a person whose identity is in doubt, and only runs after that person passes step-up.
 *
 *   npx tsx scripts/_stepup.ts
 */
import { issueStepUp, verifyStepUp, isStepUpSatisfied, _resetStepUp } from '../src/step-up.js';
import { requireApproval, confirmPending } from '../src/tools/approval.js';

const checks: { name: string; pass: boolean; detail?: string }[] = [];
const ok = (n: string, p: boolean, d?: string) => checks.push({ name: n, pass: p, detail: d });
const other = (c: string) => (c === '000000' ? '111111' : '000000');

async function main() {
  // (a) lifecycle
  _resetStepUp();
  let code = '';
  const r1 = await issueStepUp({ personId: 'p1', deliver: async (c) => { code = c; return true; } });
  ok('issue → ok + challengeId + code delivered out-of-band', r1.ok && !!r1.challengeId && /^\d{6}$/.test(code));
  ok('wrong code rejected', !verifyStepUp(r1.challengeId!, other(code)).ok);
  ok('not satisfied before a correct code', !isStepUpSatisfied('p1'));
  ok('correct code passes', verifyStepUp(r1.challengeId!, code).ok);
  ok('person is now step-up-satisfied', isStepUpSatisfied('p1'));
  ok('single-use — the code can’t be replayed', !verifyStepUp(r1.challengeId!, code).ok);

  // (b) delivery failure → no challenge (person with no reachable validated connection can’t verify)
  const r2 = await issueStepUp({ personId: 'p2', deliver: async () => false });
  ok('delivery failure → issue not ok', !r2.ok && r2.reason === 'delivery-failed');

  // (c) attempts cap — 3 wrong tries burn the challenge
  _resetStepUp();
  let c3 = '';
  const r3 = await issueStepUp({ personId: 'p3', deliver: async (c) => { c3 = c; return true; } });
  verifyStepUp(r3.challengeId!, other(c3)); verifyStepUp(r3.challengeId!, other(c3)); verifyStepUp(r3.challengeId!, other(c3));
  ok('challenge burned after 3 wrong attempts (right code now fails)', !verifyStepUp(r3.challengeId!, c3).ok);

  // (d) THE INTEGRATION — sensitive action blocked at the approval gate until step-up passes
  _resetStepUp();
  let ran = false;
  const tool: any = { def: { name: 'wire_funds', description: 'move money', parameters: { type: 'object', properties: {} } }, handler: async () => { ran = true; return 'wired'; } };
  const gated = requireApproval(tool);
  // Identity-in-doubt is captured on the ACTION at dry-run time (from the run's ctx)…
  await gated.handler({}, { sandboxDir: '.', personId: 'pX', identityInDoubt: true } as any);
  // …so the gate fires even when the CONFIRM path (e.g. the UI endpoint) carries no identity in its ctx.
  const plainConfirmCtx: any = { sandboxDir: '.', interactive: true };
  const blocked = await confirmPending(undefined, plainConfirmCtx);
  ok('flagged action → sensitive confirm is BLOCKED even via an identity-less confirm path', /blocked/i.test(blocked) && !ran, blocked.slice(0, 80));

  let cX = '';
  const rX = await issueStepUp({ personId: 'pX', deliver: async (c) => { cX = c; return true; } });
  verifyStepUp(rX.challengeId!, cX); // pX passes step-up
  const confirmed = await confirmPending(undefined, plainConfirmCtx);
  ok('after step-up → the SAME confirm now proceeds + runs the action', ran && /CONFIRMED/.test(confirmed), confirmed.slice(0, 80));

  // sanity: an un-flagged person is never blocked
  _resetStepUp();
  let ran2 = false;
  const g2 = requireApproval({ def: { name: 't2', description: 'x', parameters: { type: 'object', properties: {} } }, handler: async () => { ran2 = true; return 'ok'; } } as any);
  await g2.handler({}, { sandboxDir: '.' } as any);
  await confirmPending(undefined, { sandboxDir: '.', interactive: true } as any);
  ok('no identity doubt → confirm runs normally (no step-up needed)', ran2);

  const passed = checks.filter((c) => c.pass).length;
  console.log('\n=== step-up verification — challenge lifecycle + approval-gate enforcement ===');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  → ${c.detail ?? ''}`}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log('PASS — a sensitive action is blocked for a doubted identity until a 2nd factor is verified out-of-band.');
}
main().catch((e) => { console.error('stepup test failed:', e?.stack ?? e); process.exit(1); });
