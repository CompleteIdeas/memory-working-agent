/** BL-74: a learned fact is written the way AWM's own guide asks (src/fact-shape.ts). */
import { describe, it, expect } from 'vitest';
import { factTags, FACT_SHAPE } from '../src/fact-shape.js';

describe('a learned fact', () => {
  it('gets a specific topic, people, a date and an end date', () => {
    const t = factTags({ topic: 'Troop 58 Summer Camp', kind: 'event', people: ['Nancy Jones', 'Susee Natarajan'], date: '2026-07-12', valid_to: '2026-07-18' });
    expect(t.tags).toEqual(['topic=world', 'topic=troop-58-summer-camp', 'intent=finding', 'fact=event', 'person=Nancy Jones', 'person=Susee Natarajan', 'date=2026-07-12']);
    expect(t.validTo).toBe('2026-07-18');
  });
  it('a decision or a preference is a decision', () => {
    expect(factTags({ topic: 'ai-newsletter', kind: 'preference' })).toMatchObject({ decision: true, tags: expect.arrayContaining(['intent=decision', 'fact=preference']) });
  });
  it('a lasting fact has no end date; bad fields are dropped, not trusted', () => {
    const t = factTags({ topic: 'world', kind: 'nonsense', people: ['<script>x', 'A', 7], date: 'June 14', valid_to: 'soon' });
    expect(t.tags).toEqual(['topic=world', 'intent=finding', 'fact=fact', 'person=scriptx']);
    expect(t.validTo).toBeUndefined();
  });
  it('the prompt asks for each field', () => {
    for (const k of ['"concept"', '"content"', '"topic"', '"kind"', '"people"', '"date"', '"valid_to"']) expect(FACT_SHAPE).toContain(k);
  });
});
