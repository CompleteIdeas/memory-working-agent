import { describe, it, expect } from 'vitest';
import { classifyIntent, isComplexTask, wantsPlan, startTier, RoutedProvider } from '../src/model-router.js';
import type { Provider, ChatResult } from '../src/provider.js';

function stub(id: string, price: [number, number]): { p: Provider; calls: () => number } {
  let calls = 0;
  const p: Provider = {
    id, model: id, price,
    chat: async (): Promise<ChatResult> => { calls++; return { text: 'ok', usage: { input: 10, output: 5 } }; },
  };
  return { p, calls: () => calls };
}

describe('model-router tier logic', () => {
  it('classifyIntent: reason for analytical verbs, fetch for mechanical, fetch by default', () => {
    expect(classifyIntent('investigate why the build fails')).toBe('reason');
    expect(classifyIntent('refactor the auth module')).toBe('reason');
    expect(classifyIntent('list the open tickets')).toBe('fetch');
    expect(classifyIntent('hello there')).toBe('fetch');
  });

  it('isComplexTask: long instruction OR multi-step research+produce', () => {
    expect(isComplexTask('x'.repeat(230))).toBe(true);
    expect(isComplexTask('research the options and then write a report')).toBe(true);
    expect(isComplexTask('list the files')).toBe(false);
  });

  it('wantsPlan: a long question is answered directly; a long task that names steps or asks for a product is planned', () => {
    // Experience pilot 2026-10-25: every framed question over ~130 characters was planned on length alone (arm F2R 31/54);
    // the same runs direct scored 39/54 at half the cost (F2P).
    const framed = (q: string) => `Answer this question about the MWA project (an AI assistant we are building).\n\nQuestion: ${q}`;
    expect(wantsPlan(framed('MWA\'s build loop gave goals a structural fan-out budget (BL-05) to stop scheduled runs from creating unbounded scheduled tasks. What are its numeric limits: the maximum depth, and the pending follow-ups per job, per run and per goal?'))).toBe(false);
    expect(wantsPlan(framed('Evaluate this proposal for MWA and say whether to accept, reject or modify it, citing the record: "The BL-36 claim check caught all 3 known false claims in 843 labelled runs and flagged nothing else, so switch MWA_CLAIM_CHECK to enforce now. For extra coverage, also have Clef judge every reply for whether it claims work the action record doesn\'t show."'))).toBe(false);
    expect(wantsPlan('Research the three cheapest US-hosted models on OpenRouter, run the injection suite on each, then write a one-page report with a table of results and save it as report.md in the working folder for Robert to read tomorrow morning.')).toBe(true);
    expect(wantsPlan('Could you go through the meeting notes in the folder, pull out every action item with an owner and a date, build a spreadsheet of them, and then draft a short email to the team listing what is due this week and who owns each item?')).toBe(true); // steps named: a question in form only
    expect(wantsPlan('Please review the four supplier quotes in the granted folder, compare their delivery terms and unit prices against last year\'s contract, and write a one-page recommendation for the board with a comparison table; save it as quotes.md in the working folder.')).toBe(true);
    expect(wantsPlan('research the options and then write a report')).toBe(true); // the short multi-step rule is unchanged
    expect(wantsPlan('list the files')).toBe(false);
    expect(isComplexTask('x'.repeat(230))).toBe(true); // the tier choice still reads a long message as complex
  });

  it('startTier: strong for complex/analytical, cheap otherwise', () => {
    expect(startTier('investigate the regression')).toBe('reason');
    expect(startTier('research X then produce a summary document')).toBe('reason');
    expect(startTier('add a button')).toBe('fetch');
  });
});

describe('RoutedProvider escalation + cost', () => {
  it('routes to the active tier and escalates fetch→reason once', async () => {
    const f = stub('fetch', [1, 2]);
    const r = stub('reason', [10, 20]);
    const routed = new RoutedProvider(f.p, r.p);
    expect(routed.getTier()).toBe('fetch');

    await routed.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(f.calls()).toBe(1);
    expect(r.calls()).toBe(0);

    expect(routed.escalate()).toBe(true);
    expect(routed.getTier()).toBe('reason');
    await routed.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(r.calls()).toBe(1);

    expect(routed.escalate()).toBe(false); // already at the top tier
  });

  it('reset returns to fetch and zeroes counters', async () => {
    const f = stub('fetch', [1, 2]);
    const r = stub('reason', [10, 20]);
    const routed = new RoutedProvider(f.p, r.p);
    routed.escalate();
    routed.reset();
    expect(routed.getTier()).toBe('fetch');
    expect(routed.escalations).toBe(0);
  });

  it('spentUsd bills each tier at its own price', async () => {
    const f = stub('fetch', [3, 6]); // $/M in, out
    const r = stub('reason', [30, 60]);
    const routed = new RoutedProvider(f.p, r.p);
    await routed.chat({ messages: [{ role: 'user', content: 'x' }] }); // fetch: 10 in, 5 out
    const expected = (10 / 1e6) * 3 + (5 / 1e6) * 6;
    expect(routed.spentUsd()).toBeCloseTo(expected, 10);
  });
});
