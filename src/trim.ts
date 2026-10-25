/**
 * Cost (2026-10-23) — keep only what a page says about the task. A fetched page entered the run's history at up to
 * 6,000 characters, and the history is sent again on every step, so one long page was paid for a dozen times; the
 * hard test's research jobs read 20+ pages each. Locally, with no model: split the page into passages, score each
 * against the words of the task and of the call (the search query, the URL), and keep the opening passage plus the
 * best-scoring ones, in their original order, up to the cap. MWA_TRIM_PAGES=0 turns it off; MWA_TRIM_CHARS sets the cap.
 */

/** Tools whose results are pages or documents someone else wrote. Not the browser's: its snapshot already has its own
 *  cap and is mostly a numbered control list, which this prose trim kept while dropping the article the question was
 *  about (review 2026-10-25, F10: npr.org 20,717 → 2,937 characters with none of the lead story's paragraphs). */
export const PAGE_TOOLS = /^(fetch__fetch_url|read_document|http_request|search__web_search)$/;

const STOP = new Set(('a an and are as at be but by can did do does for from had has have how i if in into is it its me my no not of on or our so that the their them then there these they this to us was we were what when where which who why will with you your about after all also any been before both each few more most other over same some such than too very just only own out up down off again further once here while during above below between through until against').split(' '));

function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2);
}

/** Split into passages of about 300–600 characters: by paragraph, then by sentence for long ones. */
function passages(text: string): string[] {
  const paras = text.split(/\n\s*\n|(?<=[.!?])\s{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of paras.length > 1 ? paras : [text]) {
    if (p.length <= 600) { out.push(p); continue; }
    let cur = '';
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if (cur && cur.length + s.length > 500) { out.push(cur); cur = ''; }
      cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
  }
  // a page with no sentence breaks at all (a stripped HTML blob): fixed windows
  return out.flatMap((p) => (p.length > 900 ? p.match(/[\s\S]{1,500}/g) ?? [p] : [p]));
}

export function trimCap(env: NodeJS.ProcessEnv = process.env): number {
  if (env.MWA_TRIM_PAGES === '0') return 0;
  return Math.max(800, Number(env.MWA_TRIM_CHARS ?? 2500) || 2500);
}

/** The page cut to about `cap` characters of what matters to `query`, or unchanged when it is already short. */
export function trimPage(text: string, query: string, cap = trimCap()): { text: string; trimmed: boolean; from: number } {
  const from = text.length;
  if (!cap || from <= cap + 300) return { text, trimmed: false, from };
  const ps = passages(text);
  const q = new Set(words(query));
  // rarer words count more: a word in every passage says nothing about which one matters
  const df = new Map<string, number>();
  for (const p of ps) for (const w of new Set(words(p))) df.set(w, (df.get(w) ?? 0) + 1);
  const score = (p: string) => {
    let s = 0;
    for (const w of new Set(words(p))) if (q.has(w)) s += Math.log(1 + ps.length / (df.get(w) ?? 1));
    return s / Math.sqrt(Math.max(1, p.length / 300)); // don't let one long passage win on length
  };
  const ranked = ps.map((p, i) => ({ i, p, s: i === 0 ? Infinity : score(p) })).sort((a, b) => b.s - a.s);
  const keep = new Set<number>(); let used = 0;
  for (const r of ranked) {
    if (used >= cap) break;
    if (r.s <= 0 && keep.size > 1) break;               // nothing else mentions the task
    keep.add(r.i); used += r.p.length + 5;
  }
  const kept = ps.filter((_, i) => keep.has(i));
  const body = kept.join(' … ').slice(0, cap + 400);
  return { text: `${body}\n(trimmed to the parts about your task: ${kept.length} of ${ps.length} passages, ${body.length} of ${from} characters)`, trimmed: true, from };
}
