import { describe, it, expect } from 'vitest';
import { validateSubstance } from '../src/substance.js';

const TASK = 'Investigate ticket 18247 and report the membership status for the requester.';

describe('substance gate', () => {
  it('flags a fabricated action (claims a write with zero tools)', () => {
    const v = validateSubstance({ instruction: TASK, summary: 'I updated the membership record and emailed the member.', toolsUsed: [] });
    expect(v.ok).toBe(false);
    expect(v.fix).toMatch(/did not actually use any tool|NOT been done/i);
  });

  it('passes a real write backed by a tool', () => {
    const v = validateSubstance({ instruction: TASK, summary: 'I updated the record.', toolsUsed: ['legacy_db_confirm'] });
    expect(v.ok).toBe(true);
  });

  it('flags punting (asks the human on a doable task without acting)', () => {
    const v = validateSubstance({ instruction: TASK, summary: 'Would you like me to look up the member in the database?', toolsUsed: [] });
    expect(v.ok).toBe(false);
    expect(v.fix).toMatch(/asking for input instead/i);
  });

  it('passes when it asked but had actually acted first', () => {
    const v = validateSubstance({ instruction: TASK, summary: 'Found the record. Do you want me to also email her?', toolsUsed: ['legacy_db_query'] });
    expect(v.ok).toBe(true);
  });

  it('recall alone does NOT count as acting', () => {
    const v = validateSubstance({ instruction: TASK, summary: 'Could you confirm the member id so I can proceed?', toolsUsed: ['recall'] });
    expect(v.ok).toBe(false);
  });

  it('passes a normal substantive answer', () => {
    const v = validateSubstance({ instruction: TASK, summary: 'Shannon Collins (member 230159) is a Full Member, active through 2026-11-30.', toolsUsed: ['legacy_db_query'] });
    expect(v.ok).toBe(true);
  });

  it('does not flag a bare/trivial instruction that ends in a question', () => {
    const v = validateSubstance({ instruction: 'hi', summary: 'What would you like me to do?', toolsUsed: [] });
    expect(v.ok).toBe(true);
  });

  it('defaults to pass on a clean done with no tools, no claims, no asks', () => {
    const v = validateSubstance({ instruction: TASK, summary: 'Here is a summary of the eventing calendar.', toolsUsed: [] });
    expect(v.ok).toBe(true);
  });
});
