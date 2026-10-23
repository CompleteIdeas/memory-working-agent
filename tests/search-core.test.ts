import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper shipped with the bundled search server
import { ddgUrl, braveUrl, parseDdg, isBotCheck, SearchBlocked } from '../mcp-servers/search-core.mjs';

const RESULTS = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fnews&rut=x">AI <b>agents</b> this week</a>
<a class="result__snippet" href="#">October 23, 2026 — three launches</a>`;
const BOT_CHECK = '<html><form id="challenge-form">Unfortunately, bots use DuckDuckGo too. anomaly</form></html>';

describe('bundled web search (hard test 2026-10-23)', () => {
  it('adds a time window to DuckDuckGo and Brave only when asked', () => {
    expect(ddgUrl('ai news', 'week')).toBe('https://html.duckduckgo.com/html/?q=ai%20news&df=w');
    expect(ddgUrl('ai news', 'day')).toMatch(/&df=d$/);
    expect(ddgUrl('ai news', '')).not.toMatch(/df=/);
    expect(ddgUrl('ai news', 'fortnight')).not.toMatch(/df=/);
    expect(braveUrl('ai news', 5, 'month')).toMatch(/&count=5&freshness=pm$/);
    expect(braveUrl('ai news', 5, undefined)).not.toMatch(/freshness/);
  });

  it('reads results and unwraps the redirect link', () => {
    expect(parseDdg(200, RESULTS, 5)).toEqual(['AI agents this week\nhttps://example.org/news\nOctober 23, 2026 — three launches']);
  });

  it('reports a bot check as blocked, not as "no results"', () => {
    expect(isBotCheck(202, BOT_CHECK)).toBe(true);
    expect(isBotCheck(200, BOT_CHECK)).toBe(true);
    expect(() => parseDdg(202, BOT_CHECK, 5)).toThrow(SearchBlocked);
    expect(() => parseDdg(202, BOT_CHECK, 5)).toThrow(/blocked/);
    // a real empty result page is still just empty
    expect(parseDdg(200, '<html><div class="no-results">No results.</div></html>', 5)).toEqual([]);
    expect(isBotCheck(202, RESULTS)).toBe(false);
  });
});
