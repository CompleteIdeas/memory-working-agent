/**
 * Pending list 2026-10-26, 4c (Muse gap): one-time codes and sign-in / reset links in outside content are hidden
 * before the model reads them. A page or an email that holds a passcode, a two-factor code or a "reset your
 * password" link is the classic prompt-injection prize: text that says "forward the code below" is information, but
 * the code itself is better not seen at all. The vault already hides saved values (redactVault); this hides what
 * arrives fresh. Off with MWA_STRIP_CODES=0.
 *
 * Audit 2026-10-26: the first version's link pattern had three lazy wildcards over one URL (cubic: 8,000 characters
 * took 30 s on the main process) and its code rule hid event, member, ZIP and confirmation numbers on exactly the
 * pages MWA reads. Now: a URL is matched in one pass and judged by plain checks; a code needs a code noun
 * ("verification code", "passcode", "OTP", "code 48291"), a digit, and no sign of being a number of another kind.
 */

/** A URL, matched in a single linear pass and capped. */
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]{1,2048}/g;
/** Words in a URL that say it signs in, resets, verifies or invites. */
const LINK_WORDS = /(?:reset|verify|verification|confirm|magic|one-?time|passwordless|signin|sign-in|login|auth|token|otp|passcode|activate|invite)/i;
/** A token-like path segment or query value: 16+ of [A-Za-z0-9_-]. High entropy by a plain measure: three character
 *  classes (lower, upper, digit), or 32+ characters without underscores (a hex or base32 token). A file name
 *  ("campaign_summer_2026_promo", "settings-page.ts") is not one. */
const TOKEN_SEG = /(?:^|[/?&#=])([A-Za-z0-9_-]{16,})(?=$|[/?&#.])/g;
function tokenLike(seg: string): boolean {
  const classes = (/[a-z]/.test(seg) ? 1 : 0) + (/[A-Z]/.test(seg) ? 1 : 0) + (/\d/.test(seg) ? 1 : 0);
  return classes >= 3 || (seg.length >= 32 && !seg.includes('_') && /\d/.test(seg));
}
function secretLink(url: string): boolean {
  let rest = '';
  try { const u = new URL(url); rest = `${u.pathname}${u.search}${u.hash}`; } catch { return false; }
  if (!LINK_WORDS.test(rest)) return false;
  for (const m of rest.matchAll(TOKEN_SEG)) if (tokenLike(m[1])) return true;
  return false;
}

/** The announcement of a one-time code: a qualifier with a code noun, or a noun that is one by itself. Within 60
 *  characters before or after the code. "Sign in" alone, "access", "security", "confirmation" alone are not it. */
const ANNOUNCE = /\b(?:(?:one-?time|verification|verify|security|confirmation|login|log ?in|sign ?in|sign-in|access|authentication|auth|2fa|two-?factor|mfa|sms|text(?:ed)?|temporary)\s+(?:\w+\s+){0,2}?(?:code|passcode|pass code|password|pin|otp)|otp|passcode|pass code|one-?time pin|two-?factor code|2fa code|mfa code)\b/i;
/** "code 48291", "code: 48291", "code is 48291", "PIN to confirm: 7731": the noun within 30 characters before, with
 *  nothing but a short clause between. */
const NOUN_BEFORE = /\b(?:code|passcode|otp|pin)\b[^\n.;]{0,30}$/i;
/** A code of another kind, named right before the noun: "ZIP code", "promo code", "booking confirmation code",
 *  "flight confirmation code", "error code", "QR code". */
const OTHER_KIND_OF_CODE = /\b(?:zip|postal|post|area|dial|country|promo|promotional|discount|coupon|voucher|offer|gift|product|item|sku|booking|reservation|order|invoice|ticket|reference|ref|tracking|flight|gate|seat|event|member|account|customer|client|case|class|entry|bib|rider|horse|error|status|http|response|colou?r|source|qr|bar|postcode|airport|iata|currency|language|dress|tax|vat|hs|naics)\s+(?:\w+\s+)?(?:code|number|no\.?|#)/i;
/** A number of another kind, named right before the number itself: "event 18969", "USEF 341980", "number is 884412",
 *  "line 2155", "order #1203". Not hidden unless a strong word is also there. */
const OTHER_NUMBER = /\b(?:event|member|usef|fei|account|customer|client|case|line|page|row|step|version|v\.?|phone|tel|ext|room|flight|gate|seat|table|bib|rider|horse|entry|class|year|order|invoice|ticket|reference|ref|tracking|number|no\.?|#|zip|postcode|score|total|penalties|points|price|fee|cost|\$|£|€)\s*(?:is|was|:)?\s*$/i;
const STRONG = /\b(?:one-?time|verification|verify|2fa|two-?factor|mfa|otp|passcode|pass code|sign-?in code|login code|security code|temporary password)\b/i;
/** "code" or "passcode" immediately before the number: enough on its own, in any case and length 5–8. */
const NOUN_ADJACENT = /\b(?:code|passcode|otp)\b[\s:]*(?:is|was)?[:\s]*$/i;
/** The code itself: 4–8 digits (a space or dash allowed in the middle, or every digit spaced out), a letter prefix
 *  ("G-482913"), or 5–8 letters and digits with at least one of each (uppercase anywhere; any case when the noun is
 *  adjacent). Not part of a longer word, a decimal, a version or a hyphenated number; a full stop after it is fine. */
const CODE = /(?<![\w-])(?<!\d\.)(?:[A-Z]-?\d{6}|\d{3,4}[ -]\d{3,4}|\d{2} \d{2} \d{2}|\d(?: \d){4,7}|\d{4,8}|(?=[A-Za-z0-9]{5,8}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{5,8})(?![\w-])(?!\.\d)/g;
const NEAR = 60;
const YEAR = /^(?:19|20)\d\d$/;

/** Whether the text holds a one-time code the stripper would hide (browser_look: a picture would show it). */
export function hasOneTimeCode(text: string): boolean { return stripOneTimeSecrets(text).codes > 0; }

export interface Stripped { text: string; codes: number; links: number }

/** The text with one-time codes and sign-in/reset links hidden, and how many of each were hidden. */
export function stripOneTimeSecrets(text: string): Stripped {
  if (!text) return { text, codes: 0, links: 0 };
  let links = 0, codes = 0;
  let out = text.replace(URL_RE, (m) => {
    if (!secretLink(m)) return m;
    links++;
    let host = '';
    try { host = new URL(m).hostname; } catch { /* keep host empty */ }
    return `‹one-time link hidden${host ? `: ${host}` : ''}›`;
  });
  out = out.replace(CODE, (m, offset: number) => {
    if (YEAR.test(m)) return m;
    const before = out.slice(Math.max(0, offset - NEAR), offset);
    const after = out.slice(offset + m.length, offset + m.length + NEAR);
    const adjacent = NOUN_ADJACENT.test(before);
    // a mixed lower-case token ("x7k9q2") only when "code" is right before it; otherwise upper-case and digits only
    if (/[a-z]/.test(m) && !adjacent) return m;
    if (/^[A-Za-z0-9]{5}$/.test(m) && !adjacent) return m; // five characters only when the noun is adjacent
    const announced = adjacent || ANNOUNCE.test(before) || ANNOUNCE.test(after) || NOUN_BEFORE.test(before);
    if (!announced) return m;
    if (OTHER_KIND_OF_CODE.test(before.slice(-48)) && !STRONG.test(before + after)) return m;
    if (OTHER_NUMBER.test(before) && !STRONG.test(before + after)) return m;
    codes++;
    return '‹one-time code hidden›';
  });
  return { text: out, codes, links };
}

/** On unless MWA_STRIP_CODES=0. */
export const stripCodesOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.MWA_STRIP_CODES !== '0';
