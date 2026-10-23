/**
 * What a run asks memory first, and what is primed from it (src/agent.ts recallQuery, rankForPrime). Measured
 * 2026-10-23 on a copy of the production store: the chat's Files note, appended to every message, turned "Who is
 * Nancy Jones?" into a recall of file and task records; and MWA's own run records filled recall for questions about
 * the person's family ("agent run: What is 17 times 23?").
 */
import { describe, it, expect } from 'vitest';
import { recallQuery, rankForPrime } from '../src/agent.js';

const NOTE = '\n\n(Files you write here are saved for the person and appear in their Files tab; when you mention one, link it by its path.)';

describe('the first recall', () => {
  it("asks with the person's own words, not the note the chat adds", () => {
    expect(recallQuery(`Who is Nancy Jones?${NOTE}`, 'Who is Nancy Jones?')).toBe('Who is Nancy Jones?');
  });
  it('a follow-up keeps the end of the conversation it continues', () => {
    const q = recallQuery(`Recent conversation so far:\n(1) Who teaches Eli guitar? → Jonathan McCormick\n\nNew request: and his English teacher?${NOTE}`, 'and his English teacher?');
    expect(q).toContain('Jonathan McCormick');
    expect(q.endsWith('and his English teacher?')).toBe(true);
    expect(q).not.toContain('Files tab');
  });
  it('a job, or a run with no separate message, asks with its instruction', () => {
    expect(recallQuery('Prepare the morning brief')).toBe('Prepare the morning brief');
    expect(recallQuery('Prepare the morning brief', 'Prepare the morning brief')).toBe('Prepare the morning brief');
  });
});

describe('MWA logs are not primed', () => {
  it('run records, actions and job texts are dropped; a file it wrote, plan steps and goals stay', () => {
    const out = rankForPrime([
      { concept: 'agent run: What is 17 times 23?', score: 0.30 },
      { concept: 'action: fetch  fetch url', score: 0.28 },
      { concept: 'scheduled: Continue working on the goal', score: 0.27 },
      { concept: 'session: topic=agent', score: 0.26 },
      { concept: 'Purchase of Pepper Pong set', score: 0.22 },
      { concept: 'action: write file', score: 0.21 },
      { concept: 'plan step 2: Use research-notes.md', score: 0.20 },
      { concept: 'where we are: newsletter', score: 0.19 },
    ]).map((m) => m.concept);
    expect(out).toEqual(['Purchase of Pepper Pong set', 'action: write file', 'plan step 2: Use research-notes.md', 'where we are: newsletter']);
  });
});
