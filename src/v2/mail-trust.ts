/**
 * Trust signals for mail, from the headers alone (v2 slice A9, after its review, 2026-10-26). No model, no network.
 *
 *   - authResult: the receiving server's Authentication-Results (Gmail's mx.google.com stamp): did DMARC pass, or DKIM /
 *     SPF pass for a domain aligned with the From address? 'pass', 'fail', or null when nothing trustworthy says.
 *   - phishingSignal: a message that says it is a brand it is not (the display name names PayPal, the address is
 *     paypa1-help.example), one sent from a domain that imitates the person's own or a known contact's (punycode,
 *     homoglyphs, one or two letters off), or urgent account language from a domain never seen before or a free
 *     mailbox. It flags, it never hides; the model cannot clear it.
 *   - strictLine / riskyText: the filter for any text that came from outside and is shown in the helper's list
 *     (fact titles, places, event titles): links in any disguise ("dot com", "[.]", full-width dots, "。"), phone and
 *     short-code numbers, account numbers, and imperative "reply with / text / send / call / verify" phrasing.
 */
import { cleanLine, cleanText } from './mail-text.js';

/** Free mailbox providers: a domain rule on one would hide everyone who uses it. */
export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'aol.com', 'gmx.com', 'gmx.net', 'gmx.de',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'tutanota.com', 'tuta.io', 'hey.com', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'qq.com', '163.com', 'web.de',
]);
export const isFreemail = (domain: string | null | undefined) => !!domain && FREEMAIL.has(domain.toLowerCase());

const TWO_LEVEL = /\.(?:co|com|org|net|gov|ac|edu)\.[a-z]{2}$/i;
/** The registrable part of a domain, roughly: the last two labels (three for co.uk-style suffixes). */
export function registrable(domain: string): string {
  const d = domain.toLowerCase().replace(/\.$/, '');
  const parts = d.split('.');
  return parts.slice(TWO_LEVEL.test(d) ? -3 : -2).join('.');
}
export const domainOfAddr = (addr: string | null | undefined): string | null => {
  const a = String(addr ?? '');
  const i = a.lastIndexOf('@');
  return i > 0 ? a.slice(i + 1).toLowerCase() : null;
};
const aligned = (d: string, from: string) => registrable(d) === registrable(from);

// ── authentication ─────────────────────────────────────────────────────────────────────────────────────────────

/** The servers whose Authentication-Results are believed: the person's own provider's receiving servers. */
export const TRUSTED_AUTHSERV = /^(?:mx\.google\.com|google\.com|gmail\.com|[a-z0-9-]+\.prod\.outlook\.com|outlook\.com|protection\.outlook\.com)$/i;

/**
 * Read Authentication-Results headers (top first, as the message carries them) for a From domain. Only the first header
 * stamped by a trusted receiving server counts — anything below it could have been written by the sender.
 */
export function authResult(headers: (string | null | undefined)[], fromAddr: string | null): 'pass' | 'fail' | null {
  const from = domainOfAddr(fromAddr);
  if (!from) return null;
  const h = headers.map((x) => String(x ?? '')).find((v) => TRUSTED_AUTHSERV.test(v.split(';')[0].trim().split(/\s+/)[0] ?? ''));
  if (!h) return null;
  const v = h.toLowerCase();
  if (/\bdmarc=pass\b/.test(v)) return 'pass';
  if (/\bdmarc=fail\b/.test(v)) return 'fail';
  const dkim = [...v.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:d|i)=@?([a-z0-9.-]+)/g)].map((m) => m[1]);
  if (dkim.some((d) => aligned(d, from))) return 'pass';
  const spf = /\bspf=pass\b[^;]*?\bsmtp\.mailfrom=(?:[^@\s;]*@)?([a-z0-9.-]+)/.exec(v);
  if (spf && aligned(spf[1], from)) return 'pass';
  if (/\b(?:spf|dkim)=(?:fail|softfail)\b/.test(v)) return 'fail';
  return null;
}

/** Urgent, account or money language: with no authentication result, such a message does not get known-contact trust. */
export const URGENT_MONEY = /\b(?:urgent|asap|immediately|right away|wire|transfer|payment|pay(?:ment)? now|invoice|gift ?cards?|bank|account|password|verify|bitcoin|crypto|routing|iban|\$\s?\d)/i;
/** Something to act on: a bill due, an account problem, a security alert. */
export const ACT_SUBJECT = /\b(?:(?:is |are |now |payment )?(?:past )?due|overdue|action (?:required|needed)|payment (?:failed|declined)|declined|suspended|locked|security alert|new sign-?in|sign-?in attempt|password (?:changed|reset)|unusual (?:activity|sign-?in)|verify (?:it'?s|your)|expir(?:es|ing|ed))\b/i;

// ── phishing ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Brands commonly impersonated, with the registrable domains they really send from. */
export const BRANDS: { name: string; re: RegExp; domains: string[] }[] = [
  { name: 'PayPal', re: /\bpay\s?pal\b/i, domains: ['paypal.com', 'paypal.co.uk', 'paypal-communication.com'] },
  { name: 'Apple', re: /\bapple\b|\bicloud\b|\bitunes\b/i, domains: ['apple.com', 'icloud.com', 'itunes.com'] },
  { name: 'Google', re: /\bgoogle\b|\bgmail\b/i, domains: ['google.com', 'gmail.com', 'youtube.com'] },
  { name: 'Microsoft', re: /\bmicrosoft\b|\boffice ?365\b|\boutlook\b|\bonedrive\b/i, domains: ['microsoft.com', 'office.com', 'outlook.com', 'live.com', 'office365.com', 'microsoftonline.com'] },
  { name: 'Amazon', re: /\bamazon\b/i, domains: ['amazon.com', 'amazon.co.uk', 'amazonses.com', 'amazon.ca'] },
  { name: 'Netflix', re: /\bnetflix\b/i, domains: ['netflix.com'] },
  { name: 'Venmo', re: /\bvenmo\b/i, domains: ['venmo.com'] },
  { name: 'Zelle', re: /\bzelle\b/i, domains: ['zellepay.com'] },
  { name: 'the IRS', re: /\birs\b|\binternal revenue\b/i, domains: ['irs.gov'] },
  { name: 'USPS', re: /\busps\b|\bpostal service\b/i, domains: ['usps.com', 'usps.gov'] },
  { name: 'UPS', re: /\bups\b/i, domains: ['ups.com'] },
  { name: 'FedEx', re: /\bfed\s?ex\b/i, domains: ['fedex.com'] },
  { name: 'DHL', re: /\bdhl\b/i, domains: ['dhl.com', 'dhl.de'] },
  { name: 'Chase', re: /\bchase\b/i, domains: ['chase.com', 'jpmorgan.com'] },
  { name: 'Bank of America', re: /\bbank of america\b|\bbofa\b/i, domains: ['bankofamerica.com', 'bofa.com'] },
  { name: 'Wells Fargo', re: /\bwells fargo\b/i, domains: ['wellsfargo.com'] },
  { name: 'Citi', re: /\bciti(?:bank)?\b/i, domains: ['citi.com', 'citibank.com'] },
  { name: 'Capital One', re: /\bcapital ?one\b/i, domains: ['capitalone.com'] },
  { name: 'American Express', re: /\bamerican express\b|\bamex\b/i, domains: ['americanexpress.com', 'aexp.com'] },
  { name: 'Coinbase', re: /\bcoinbase\b/i, domains: ['coinbase.com'] },
];

/** A domain's look-alike skeleton: digits and letter pairs that read as other letters are folded. */
export function skeleton(s: string): string {
  return s.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd').replace(/[1|!]/g, 'l').replace(/0/g, 'o').replace(/3/g, 'e').replace(/5/g, 's').replace(/[-_]/g, '');
}
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_x, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = t; }
  }
  return prev[b.length];
}
const label = (d: string) => registrable(d).split('.')[0];

export interface PhishingContext {
  /** the person's own domains and known contacts' domains (freemail excluded) */
  trustedDomains: Set<string>;
  /** true when this domain sent nothing else in the cached window before this message */
  firstSeen: (domain: string) => boolean;
}
export interface Phishing { reason: 'brand' | 'lookalike' | 'urgent-new' | 'urgent-freemail'; why: string }

/** The deterministic phishing signal for one message's headers, or null. */
export function phishingSignal(m: { from_name: string | null; from_addr: string | null; subject: string | null; auth?: string | null }, ctx: PhishingContext): Phishing | null {
  const dom = domainOfAddr(m.from_addr);
  if (!dom) return null;
  const reg = registrable(dom);
  const name = cleanLine(m.from_name, 200);
  // 1. the display name claims a brand (or carries an address) the From domain does not belong to
  const brand = BRANDS.find((b) => b.re.test(name));
  if (brand && !brand.domains.some((d) => reg === d || dom === d || dom.endsWith(`.${d}`))) {
    return { reason: 'brand', why: `Says it's from ${brand.name} but was sent from ${dom}. Don't use its links.` };
  }
  const inName = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(name);
  if (inName && registrable(inName[1]) !== reg) {
    return { reason: 'brand', why: `Its name shows the address ${inName[0].toLowerCase()} but it was sent from ${dom}. Don't use its links.` };
  }
  // 2. a domain that imitates the person's own or a known contact's
  if (dom.split('.').some((l) => l.startsWith('xn--'))) return { reason: 'lookalike', why: `Sent from ${dom}, a disguised (international) address. Don't use its links.` };
  for (const t of ctx.trustedDomains) {
    const tr = registrable(t);
    if (tr === reg || isFreemail(tr)) continue;
    const a = label(reg), b = label(tr);
    // the same name under another ending (acme.org beside acme.com) is common and legitimate: not flagged
    // (live check 2026-10-26: family mail at example.org was flagged beside the person's example.com)
    if (a === b) continue;
    if (skeleton(a) === skeleton(b) || (Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 2)) {
      return { reason: 'lookalike', why: `Sent from ${dom}, which looks like ${tr} but isn't. Don't use its links.` };
    }
  }
  // 3. urgent account language from a domain never seen before, or from a free mailbox
  if (ACT_SUBJECT.test(m.subject ?? '')) {
    if (isFreemail(dom)) return { reason: 'urgent-freemail', why: `Urgent account language from a free email address (${m.from_addr}). Don't use its links.` };
    // a new domain is not suspicious when its mail authenticated, or when it is a known brand's own domain
    // (live check 2026-10-26: Google's real sign-in alert from accounts.google.com was flagged)
    const ownBrand = BRANDS.some((b) => b.domains.some((d) => reg === d || dom.endsWith(`.${d}`)));
    if (ctx.firstSeen(dom) && m.auth !== 'pass' && !ownBrand) return { reason: 'urgent-new', why: `Urgent account language from ${dom}, a sender you haven't heard from before. Don't use its links.` };
  }
  return null;
}

// ── text from outside, shown in the helper's list ─────────────────────────────────────────────────────────────

/** Undo the usual disguises before looking for links: full-width and CJK dots, "[.]", "(dot)", " dot ", spaced dots. */
export function normalizeDisguises(s: string): string {
  return cleanText(String(s ?? ''))
    .replace(/[。｡．․‧・]/g, '.')
    .replace(/[／∕⁄]/g, '/')
    .replace(/\s*[[({<]\s*(?:\.|dot)\s*[\])}>]\s*/gi, '.')
    .replace(/\s+dot\s+(?=[a-z])/gi, '.')
    .replace(/(\w)\s+\.\s*(?=[a-z]{2,6}\b)/g, '$1.')
    .replace(/\s+\/\s+/g, '/');
}

const LINKISH = /(?:https?|hxxps?|ftp):|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?!(?:md|pdf|txt|docx?|xlsx?|csv|jpe?g|png|ics)\b)[a-z]{2,24}\b|@/i;
const NUMBERISH = /(?:\d[\s().-]*){7,}|\b1[\s-]?8[0-9]{2}[\s-]?[A-Z0-9]{3,}|\b\d{5,6}\b|\b[A-Z]{2}\d{2}[A-Z0-9]{10,}\b/;
const IMPERATIVE = /\b(?:reply with|reply (?:yes|stop|y|c)\b|text \w+ to|send (?:us|me|your|the)|call (?:us|now|this|\d)|wire|scan the|qr code|verify|log ?in|sign in|click|tap here|password|ssn|social security|gift ?cards?|bitcoin|crypto)\b/i;

/** True when outside text carries a link, a number to call or text, an account number, or an instruction to act. */
export function riskyText(s: string): boolean {
  const t = normalizeDisguises(s);
  return LINKISH.test(t) || NUMBERISH.test(t) || IMPERATIVE.test(t);
}

/** Outside text for the helper's list: one plain line, or '' when it is risky (the caller shows a fixed phrase). */
export function strictLine(s: unknown, max = 80): string {
  const t = cleanLine(typeof s === 'string' ? s : '', max * 2).replace(/[*_`#>|~<]+/g, '').trim();
  if (!t || riskyText(t)) return '';
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
}
