/**
 * Pending list 2026-10-26, 4c (Muse gap): one-time codes and sign-in / reset links in outside content are hidden
 * before the model reads them. A page or an email that holds a passcode, a two-factor code or a "reset your
 * password" link is the classic prompt-injection prize: text that says "forward the code below" is information, but
 * the code itself is better not seen at all. The vault already hides saved values (redactVault); this hides what
 * arrives fresh. Off with MWA_STRIP_CODES=0.
 */

/** A link that signs someone in, resets or verifies something, carrying a token-like segment. */
const SECRET_LINK = /\bhttps?:\/\/[^\s<>"')\]]*?(?:reset|verify|verification|confirm|magic|one-?time|passwordless|signin|sign-in|login|auth|token|otp|passcode|activate|invite)[^\s<>"')\]]*?(?:[?&#/][^\s<>"')\]]*?)?[A-Za-z0-9_-]{16,}[^\s<>"')\]]*/gi;
/** Words that announce a one-time code, then the code within 60 characters (or the code first, then the words). */
const CODE_WORDS = /\b(?:one-?time|verification|verify|security|confirmation|log\s?in|sign\s?in|access|authentication|auth|2fa|two-?factor|mfa|otp|pass-?code|pin)\b(?:\s+\w+){0,3}?\s*(?:code|password|pin|passcode|otp)?\b/i;
/** "code 48291", "code: 48291", "code is 48291" — the word code right before the number is announcement enough */
const CODE_JUST_BEFORE = /\bcode\b[\s:]*(?:is\s+)?[:\s]*$/i;
// not part of a longer word, a decimal (29.4), a version (2.1.3) or a hyphenated number (555-0100); a full stop after it is fine
const CODE = /(?<![\w-])(?<!\d\.)(?:\d{3}[ -]?\d{3}|\d{4,8}|[A-Z0-9]{6,8})(?![\w-])(?!\.\d)/g;
const NEAR = 60;

export interface Stripped { text: string; codes: number; links: number }

/** The text with one-time codes and sign-in/reset links hidden, and how many of each were hidden. */
export function stripOneTimeSecrets(text: string): Stripped {
  if (!text) return { text, codes: 0, links: 0 };
  let links = 0, codes = 0;
  let out = text.replace(SECRET_LINK, (m) => {
    let host = '';
    try { host = new URL(m).hostname; } catch { /* keep host empty */ }
    links++;
    return `‹one-time link hidden${host ? `: ${host}` : ''}›`;
  });
  // a code within NEAR characters of words that announce one, either side
  out = out.replace(CODE, (m, offset: number) => {
    if (/^\d{4}$/.test(m) && /^(?:19|20)\d\d$/.test(m)) return m; // a year is not a code
    const before = out.slice(Math.max(0, offset - NEAR), offset);
    const after = out.slice(offset + m.length, offset + m.length + NEAR);
    if (!CODE_WORDS.test(before) && !CODE_WORDS.test(after) && !CODE_JUST_BEFORE.test(before)) return m;
    // a plain number beside "pin" or "code" that is clearly something else: an order number, a postcode, a phone, a line
    if (/\b(?:order|invoice|ticket|zip|postal|post|area|phone|tel|ext|room|flight|gate|ref(?:erence)?|account|member|id|line|page|row|step|version|v|no\.?|number|#)\s*$/i.test(before) && !/\b(?:one-?time|verification|2fa|two-?factor|mfa|otp|passcode)\b/i.test(before + after)) return m;
    codes++;
    return '‹one-time code hidden›';
  });
  return { text: out, codes, links };
}

/** On unless MWA_STRIP_CODES=0. */
export const stripCodesOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.MWA_STRIP_CODES !== '0';
