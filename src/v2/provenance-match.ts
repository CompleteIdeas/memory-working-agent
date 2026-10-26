/**
 * v2 slice A5 (review fix): did an answer USE a memory it was shown? Stricter than AWM's implicit-use rule
 * (core/implicit-feedback matchUses), which counts two shared "distinctive" tokens — and a person's own name, a month
 * and a year are two tokens almost every memory and every answer share ("Robert … November … 2026"), so an answer
 * about the school concert was credited to an Eventing memory it never used.
 *
 * Here a memory counts as used when the answer quotes its id (first 8 characters), or carries at least two of its
 * distinctive content tokens: capitalised names (Comet, Stable, View), amounts ($450), numbers of three digits or more
 * that are not years, and identifiers that mix letters and digits. Never distinctive: years, months, weekday names,
 * common words, the people the memory itself is tagged about (`person=`), and the words of the person's own profile
 * (their name, their household's names) that the caller passes in.
 */
export interface ShownMemory { id: string; concept: string; content: string; tags: string[] }

const MONTHS = 'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec';
const DAYS = 'monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun weekend weekday today tomorrow yesterday tonight morning afternoon evening';
const COMMON = ('the and for are but not you all any can her was one our out his has had him how its may new now old see two way who did get let put say she too use yes yet also back been call came come could does done each even ever find from gave give goes good have here into just keep know last like long look made make many more most much must need next note only open over part plan please remember remembered same send sent should show some such sure take tell than that them then they this time told very want week were what when where which while will with would year your about after again always being below could first found great might never often other right since still their there these thing those three under until which while whole within without added asked check please thanks thank hello okay sorry maybe there here this that these those what which when where why how who whom whose am is are was were be been being do does did i me my mine we us our ours you your yours he him his she her hers it its they them their theirs a an of to in on at by as or if so no not up down off it\'s i\'m i\'ll i\'ve').split(/\s+/);
const NEVER = new Set([...MONTHS.split(' '), ...DAYS.split(' '), ...COMMON]);

const WORD = /\$\s?\d[\d,]*(?:\.\d+)?|[\p{L}\p{N}]+/gu;
const norm = (w: string) => w.toLowerCase().replace(/[\s,]/g, '');

/** The tokens that identify THIS memory (see above). */
export function distinctiveTokens(m: Pick<ShownMemory, 'concept' | 'content' | 'tags'>, exclude: Set<string> = new Set()): Set<string> {
  const about = new Set(m.tags.filter((t) => t.startsWith('person=')).flatMap((t) => t.slice(7).toLowerCase().split(/[\s_-]+/)));
  const out = new Set<string>();
  for (const w of `${m.concept}\n${m.content}`.match(WORD) ?? []) {
    const lw = norm(w);
    if (NEVER.has(lw) || about.has(lw) || exclude.has(lw)) continue;
    if (lw.startsWith('$')) { out.add(lw); continue; }
    if (/^\d+$/.test(lw)) { if (lw.length >= 3 && !/^(19|20)\d\d$/.test(lw)) out.add(lw); continue; }
    if (/\d/.test(lw) && /\p{L}/u.test(lw)) { if (!/^\d{1,2}(st|nd|rd|th|am|pm)$/.test(lw)) out.add(lw); continue; }
    if (w.length >= 3 && /^\p{Lu}/u.test(w)) out.add(lw);
  }
  return out;
}

/** The words of a text, as distinctiveTokens normalises them. */
export function textTokens(text: string): Set<string> {
  return new Set((text.match(WORD) ?? []).map(norm));
}

/** The memories, of those shown, that `text` shows were used. */
export function usedMemoriesIn(shown: ShownMemory[], text: string, exclude: Iterable<string> = []): ShownMemory[] {
  if (!text || text.length < 8) return [];
  const ex = new Set([...exclude].flatMap((w) => String(w).toLowerCase().split(/[\s_-]+/)).filter(Boolean));
  const words = textTokens(text);
  const lower = text.toLowerCase();
  return shown.filter((m) => {
    if (m.id.length >= 8 && lower.includes(m.id.slice(0, 8).toLowerCase())) return true;
    let hits = 0;
    for (const t of distinctiveTokens(m, ex)) if (words.has(t) && ++hits >= 2) return true;
    return false;
  });
}
