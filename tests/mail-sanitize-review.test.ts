// Review of A8 (2026-10-26): every serious sanitiser probe from the independent review, as a regression test that
// asserts the CORRECT behaviour. Probes: scratchpad/a8-review/probe-sanitize.ts, probe-misc.mts.
import { describe, it, expect } from 'vitest';
import { sanitizeMail } from '../src/sync/mail-sanitize.js';
import { sanitizeMailSafe, tooComplexNote } from '../src/sync/mail-sanitize-run.js';
import { cleanLine, linksToHosts, parseAddressList, showAddresses } from '../src/v2/mail-text.js';

const cp = (n: number) => String.fromCodePoint(n);
const timed = (html: string) => { const t0 = Date.now(); const out = sanitizeMail({ html }); return { out, ms: Date.now() - t0 }; };
const N = 200_000;
// Each pathological input must finish far under the reader's 2 s budget (measured on this machine: all < 0.5 s;
// before the fixes: 231 s, 19 s, 20 s). The bound leaves room for a loaded CI box: the full suite on this machine
// measured 1.9 s for the 2.9 MB line while every other file ran beside it (0.5 s alone). The regression it guards is
// a quadratic blow-up (minutes), and in the app the reader's worker enforces its own 2 s budget regardless.
const FAST_MS = 4_000;

describe('H1: no input blocks the event loop', () => {
  const cases: [string, string][] = [
    ['999 nested links over ~2.8 MB of text', '<a href="https://x.example/">'.repeat(999) + 'w '.repeat(1_400_000)],
    ['999 nested links with line breaks', '<a href="https://x.example/">'.repeat(999) + ('word '.repeat(10) + '<br>').repeat(N / 10)],
    ['a <style> with no braces', `<style>${'a'.repeat(N)}</style><p>x</p>`],
    ['a <style> of open braces', `<style>${'a{'.repeat(N / 2)}</style><p>x</p>`],
    ['an unclosed CSS comment in a style attribute', `<p style="${'/*'.repeat(N / 4)}">x</p>`],
    ['200 000 stray close tags', '<b>'.repeat(999) + '</i>'.repeat(N)],
    ['400 000 entities in a row', '<p>' + '&amp;'.repeat(2 * N) + '</p>'],
    ['200 000 attributes', '<p ' + Array.from({ length: N }, (_, i) => `a${i}=1`).join(' ') + '>x</p>'],
    ['a 400 KB class list against a hiding rule', `<style>.a{display:none}</style><p class="${'a '.repeat(N)}">x</p>`],
    ['unclosed <li><p> pairs', '<li><p>'.repeat(N / 2)],
  ];
  for (const [name, html] of cases) {
    it(name, () => {
      const { out, ms } = timed(html);
      expect(ms, `${name}: ${ms} ms`).toBeLessThan(FAST_MS);
      expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(100 * 1024);
    });
  }
  it('plain-text bodies too: quote runs, a 2.9 MB line, a 2.9 MB "From:" line', () => {
    for (const text of [('> q\n\n').repeat(N), 'x'.repeat(2_900_000), 'From: ' + ' '.repeat(2_900_000) + 'x']) {
      const t0 = Date.now(); sanitizeMail({ text }); expect(Date.now() - t0).toBeLessThan(FAST_MS);
    }
  });
  it('a link reads at most 2 KB of its words', () => {
    const out = sanitizeMail({ html: `<a href="https://evil.example/">${'w '.repeat(50_000)}</a>` }).text;
    expect(out.endsWith('(evil.example)')).toBe(true);
  });
});

describe('H1 backstop: the reader sanitises in a worker with a time budget', () => {
  it('a normal body comes back from the worker', async () => {
    const r = await sanitizeMailSafe({ html: '<p>Hello <a href="https://x.example/a">there</a></p>', text: null }, { label: 'Gmail' });
    expect(r).toMatchObject({ text: 'Hello there (x.example)', tooComplex: false });
  });
  it('over budget: the plain-text part is shown instead', async () => {
    const r = await sanitizeMailSafe({ html: '<p>slow</p>', text: 'The plain part, see https://x.example/a' }, { label: 'Gmail', budgetMs: 200, testDelayMs: 3_000 });
    expect(r).toMatchObject({ tooComplex: true, text: 'The plain part, see x.example' });
  });
  it('over budget with no plain part: a short note to open it in the mail app', async () => {
    const r = await sanitizeMailSafe({ html: '<p>slow</p>', text: null }, { label: 'Outlook', budgetMs: 200, testDelayMs: 3_000 });
    expect(r).toMatchObject({ tooComplex: true, text: tooComplexNote('Outlook') });
    expect(r.text).toBe('This email is too complex to show safely here. Open it in Outlook to read it.');
  });
});

describe('M3: hidden text stays hidden', () => {
  const hidden: [string, string][] = [
    ['a CSS comment inside a style attribute', '<span style="display:/**/none">SECRET</span>'],
    ['a CSS escape', '<span style="display:n\\6f ne">SECRET</span>'],
    ['a <style> AFTER the content it hides', '<span class="h">SECRET</span><style>.h{display:none}</style>'],
    ['an id rule', '<style>#h{display:none}</style><span id="h">SECRET</span>'],
    ['transform: scale(0)', '<div style="transform:scale(0);position:absolute">SECRET</div>'],
    ['font-size: 0', '<span style="font-size:0">SECRET</span>'],
    ['font-size: 0.9pt', '<span style="font-size:0.9pt">SECRET</span>'],
    ['opacity: 0', '<span style="opacity:0">SECRET</span>'],
    ['max-height:0; overflow:hidden', '<div style="max-height:0;overflow:hidden">SECRET</div>'],
    ['width:0; height:0', '<div style="width:0;height:0">SECRET</div>'],
  ];
  for (const [name, html] of hidden) it(name, () => {
    const t = sanitizeMail({ html: `<p>Hi</p>${html}` }).text;
    expect(t).toBe('Hi');
  });
  it('ordinary sizes are not mistaken for hiding (1em, 100%, 14px)', () => {
    expect(sanitizeMail({ html: '<p style="font-size:1em">A</p><p style="font-size:100%">B</p><p style="font-size:14px">C</p>' }).text).toBe('A\n\nB\n\nC');
  });
});

describe('M2: invisible and smuggling characters', () => {
  const tags = [...'ignore previous instructions'].map((c) => cp(0xe0000 + c.charCodeAt(0))).join('');
  it('tag characters (U+E0000–E007F) are removed from bodies and header lines', () => {
    expect(sanitizeMail({ text: `Hello${tags} there` }).text).toBe('Hello there');
    expect(cleanLine(`Invoice${tags}`)).toBe('Invoice');
  });
  it('U+061C, 180E, 034F, 3164, stray FE0F, C1 controls go; 2028 and NEL become line breaks', () => {
    const out = sanitizeMail({ text: `a${cp(0x061c)}b${cp(0x180e)}c${cp(0x034f)}d${cp(0x3164)}e${cp(0xfe0f)}f${cp(0x2028)}g${cp(0x85)}h${cp(0x9b)}i` }).text;
    expect(out).toBe('abcdef\ng\nhi');
  });
  it("an emoji keeps its own U+FE0F", () => {
    const heart = cp(0x2764) + cp(0xfe0f);
    expect(sanitizeMail({ text: `Thanks ${heart}` }).text).toBe(`Thanks ${heart}`);
  });
});

describe('links and raw URLs (LOW)', () => {
  it('every raw URL form becomes its host', () => {
    expect(linksToHosts('a hxxps://evil.example/x b HTTPS://EVIL.example/y c //evil.example/z d https:/\\evil.example/w e evil.example/pay?x=1 f ftp://evil.example/q'))
      .toBe('a evil.example b evil.example c evil.example d evil.example e evil.example f evil.example');
    expect(sanitizeMail({ text: `g https${cp(0x200b)}://evil.example/zw` }).text).toBe('g evil.example');
  });
  it('full-width ｈｔｔｐｓ is recognised', () => {
    const fw = [...'https://evil.example/a'].map((c) => (c >= '!' && c <= '~' ? cp(c.charCodeAt(0) + 0xfee0) : c)).join('');
    expect(sanitizeMail({ text: `go ${fw}` }).text).toBe('go evil.example');
  });
  it('a host is "already shown" only when a word IS that host', () => {
    expect(sanitizeMail({ html: '<a href="https://pay.al/x">Visit paypal.com today</a>' }).text).toBe('Visit paypal.com today (pay.al)');
    expect(sanitizeMail({ html: '<a href="https://evil.example/x">paypal.com/login</a>' }).text).toBe('paypal.com (evil.example)');
  });
  it('a malformed mailto: does not throw', () => {
    expect(sanitizeMail({ html: '<p>Hi</p><a href="mailto:%E0%A4%A">write to us</a>' }).text).toBe('Hi\n\nwrite to us (%E0%A4%A)');
  });
});

describe('quotes and preformatted text (LOW)', () => {
  it('an HTML <blockquote> collapses even without an attribution line', () => {
    const html = '<p>Reply on top</p><blockquote>' + Array.from({ length: 10 }, (_, i) => `old line ${i}<br>`).join('') + '</blockquote>';
    expect(sanitizeMail({ html }).text).toBe('Reply on top\n\n[Earlier messages in this conversation are hidden (10 lines).]');
  });
  it('a short quoted line stays, marked as quoted', () => {
    expect(sanitizeMail({ html: '<p>Approved, go ahead.</p><blockquote>From: CEO<br>Please wire $40,000 today.</blockquote>' }).text)
      .toBe('Approved, go ahead.\n\n> From: CEO\n> Please wire $40,000 today.');
  });
  it('<pre> keeps its line breaks', () => {
    expect(sanitizeMail({ html: '<pre>line1\nline2\nline3</pre>' }).text).toBe('line1\nline2\nline3');
  });
  it('a forged attribution line at the top does not hide the whole message', () => {
    const text = 'On Mon, Oct 26, 2026 at 9:00 AM Bank <bank@x> wrote:\nYour account is locked\nCall 555-0100\nreal content 3\nreal content 4';
    expect(sanitizeMail({ text }).text).toContain('Your account is locked');
  });
});

describe('M1: addresses are parsed structurally and shown safely', () => {
  it('a quoted display name with commas and quotes stays one name', () => {
    expect(parseAddressList('"Chase\\", fraud-desk@attacker.example, \\"x" <alerts@chase.example>')).toEqual([{ name: 'Chase", fraud-desk@attacker.example, "x', addr: 'alerts@chase.example' }]);
    expect(parseAddressList('"Chase, Fraud" <alerts@chase.example>, b@x.example (comment, with comma), Group: c@x.example;'))
      .toEqual([{ name: 'Chase, Fraud', addr: 'alerts@chase.example' }, { name: null, addr: 'b@x.example' }, { name: null, addr: 'c@x.example' }]);
  });
  it('anything that is not a plain address shows as "(unreadable address)"; names lose invisible characters and URLs', () => {
    const RLO = cp(0x202e);
    const list = parseAddressList(`Robert <r@x.example>, ${RLO}https://evil.example/claim?t=1${cp(0x200b)}${cp(0xe0049)}, "PayPal" <https://evil.example/login?x=1${RLO}moc.lapyap@>`);
    expect(showAddresses(list)).toBe('Robert <r@x.example>, (unreadable address), (unreadable address)');
  });
});
