/**
 * The parts of the bundled web search that can be tested without the network: building the request
 * for a time window and reading DuckDuckGo's results page.
 *
 * Hard test 2026-10-23: from a home connection that had searched heavily, DuckDuckGo answered every
 * search with a bot check (HTTP 202, "anomaly"), which the parser read as "(no results)". The
 * newsletter job searched blind for an hour and verified one article. A bot check is now an error that
 * says so. And "this week's news" searches had no time window, so they got the most popular pages,
 * often months old; `recency` maps to DuckDuckGo's df= and Brave's freshness=.
 */

export const RECENCY = ['day', 'week', 'month', 'year'];

/** DuckDuckGo HTML search URL, with df=d|w|m|y for a time window. */
export function ddgUrl(q, recency) {
  const df = RECENCY.includes(recency) ? `&df=${recency[0]}` : '';
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${df}`;
}

/** Brave search URL, with freshness=pd|pw|pm|py for a time window. */
export function braveUrl(q, count, recency) {
  const f = RECENCY.includes(recency) ? `&freshness=p${recency[0]}` : '';
  return `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}${f}`;
}

export class SearchBlocked extends Error {}

/** True when DuckDuckGo sent its bot check instead of results. */
export function isBotCheck(status, html) {
  if (/result__a/.test(html)) return false;
  return status === 202 || /anomaly|challenge-form|captcha/i.test(html);
}

/** Results from a DuckDuckGo HTML page as "title\nurl\nsnippet" strings. Throws SearchBlocked on a bot check. */
export function parseDdg(status, html, count) {
  if (isBotCheck(status, html)) {
    throw new SearchBlocked('search was blocked: DuckDuckGo sent a bot check instead of results, so nothing was searched. '
      + 'Do not treat this as "nothing exists". Try again in a few minutes, or open a news or source site directly with the browser.');
  }
  const snips = [...html.matchAll(/result__snippet"[^>]*>(.*?)<\/a>/gs)].map((s) => s[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  const out = [];
  const rx = /result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  let m, i = 0;
  while ((m = rx.exec(html)) && out.length < count) {
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    out.push(`${title}\n${url}\n${snips[i] ?? ''}`);
    i++;
  }
  return out;
}
