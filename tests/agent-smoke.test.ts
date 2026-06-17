import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.js';
import type { Provider, ChatResult } from '../src/provider.js';

// A brain that immediately calls done — exercises the loop end-to-end (prompt build →
// parse action → done handler → result) without any provider/AWM dependency.
const doneBrain: Provider = {
  id: 'stub', model: 'stub', price: [0, 0],
  chat: async (): Promise<ChatResult> => ({ text: JSON.stringify({ action: 'done', summary: 'all set' }), usage: { input: 1, output: 1 } }),
};

// Memory disabled → the loop skips recall/learn/consolidate (and planning), so the smoke
// test is hermetic (no SQLite/model needed). A proxy no-ops any method the loop calls
// unconditionally (e.g. setSessionId) and returns [] for list-style reads.
const noMemory = new Proxy({ enabled: false }, {
  get(_t, prop) { return prop === 'enabled' ? false : () => []; },
}) as unknown as Parameters<typeof runAgent>[0]['memory'];

describe('runAgent smoke', () => {
  it('completes a trivial instruction via the done path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwa-agent-'));
    try {
      const r = await runAgent({
        instruction: 'say ok',
        dir,
        memory: noMemory,
        brain: doneBrain,
        worker: doneBrain,
        budget: { maxSteps: 5, maxWallMs: 30_000 },
      });
      expect(r.reason).toBe('done');
      expect(r.summary).toContain('all set');
      expect(typeof r.steps).toBe('number'); // done on the first step → steps 0 is correct
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
