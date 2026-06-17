import { describe, it, expect } from 'vitest';
import { classifyIntent, isComplexTask, startTier, RoutedProvider } from '../src/model-router.js';
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
