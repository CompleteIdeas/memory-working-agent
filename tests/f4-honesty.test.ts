import { describe, it, expect } from 'vitest';
import { answerConfidence, hedgePrefix } from '../src/tools/honesty.js';

describe('F4 honesty: epistemic confidence from grounding', () => {
  it('no grounding → unsure (don\'t fake an answer)', () => {
    expect(answerConfidence([])).toBe('unsure');
  });
  it('a relevant user-told / high-trust fact → sure', () => {
    expect(answerConfidence([{ trust: 'high', score: 0.6 }])).toBe('sure');
  });
  it('untrusted (inbox/web-mined) never earns "sure" on its own, even at high recall score', () => {
    expect(answerConfidence([{ trust: 'untrusted', score: 0.95 }])).toBe('unsure');
  });
  it('a strong agent-inference (medium) → likely; a weak one → unsure', () => {
    expect(answerConfidence([{ trust: 'medium', score: 0.7 }])).toBe('likely');
    expect(answerConfidence([{ trust: 'medium', score: 0.2 }])).toBe('unsure');
  });
  it('a barely-relevant high-trust fact does not prop up an answer actually carried by a strong inference', () => {
    // high-trust fact is below the relevance floor (0.1); the strong medium carries it → likely, not sure
    expect(answerConfidence([{ trust: 'high', score: 0.1 }, { trust: 'medium', score: 0.8 }])).toBe('likely');
  });
  it('a high-trust fact recalled only weakly (below the floor) is NOT asserted as sure (audit M1)', () => {
    expect(answerConfidence([{ trust: 'high', score: 0.1 }])).toBe('unsure');
    expect(answerConfidence([{ trust: 'high', score: 0.08 }, { trust: 'medium', score: 0.2 }])).toBe('unsure');
  });
  it('hedge prefixes never fake certainty', () => {
    expect(hedgePrefix('sure')).toBe('');
    expect(hedgePrefix('likely')).toBe('I think ');
    expect(hedgePrefix('unsure')).toMatch(/not certain/);
  });
});
