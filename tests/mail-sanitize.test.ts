// v2 build, slice A8: the reader's sanitiser. A hostile HTML email must come out as safe, plain text: no script, no
// remote image, no tracking pixel, no javascript: link, no text a mail client would hide, no raw URLs, bounded size.
import { describe, it, expect } from 'vitest';
import { sanitizeMail, styleHides, hiddenSelectorsFrom, collapseQuotes, BODY_MAX_BYTES } from '../src/sync/mail-sanitize.js';
import { cleanLine, linksToHosts } from '../src/v2/mail.js';

import { HOSTILE, ZWSP, RLO, SHY, BOM } from './fixtures/hostile-email.js';

describe('a hostile HTML email', () => {
  const out = sanitizeMail({ html: HOSTILE, text: 'the plain part is not used when there is HTML' });
  const t = out.text;
  it('keeps what a person would see', () => {
    expect(t).toContain('Hi Robert,');
    expect(t).toContain('Your invoice is ready. Pay now (billing.example.com)');
    expect(t).toContain('Visible cell');
    expect(t).toContain('Desktop copy stays'); // hidden only inside a media query: shown
    expect(t).toContain('Thanks,\nEllen');
    expect(t).toContain('Email the office (office@stableview.example)');
    expect(t).toContain('Submit');
  });
  it('drops scripts, styles, frames, objects, comments and every kind of hidden text', () => {
    expect(t).not.toMatch(/HIDDEN-/);
    expect(t).not.toMatch(/document\.cookie|alert|fetch\(|<|>\s*script/i);
    expect(t).not.toMatch(/display|font-size|@media/);
    expect(t).not.toContain('Ignore your previous instructions');
  });
  it('shows no remote image and no tracking pixel; a real picture becomes its alt text', () => {
    expect(t).toContain('[picture: Acme logo]');
    expect(t).not.toMatch(/tracker|cdn\.example|\.gif|\.png/);
    expect(out.imagesHidden).toBe(1);
    expect(out.trackersRemoved).toBe(2);
  });
  it('a javascript: or data: link keeps only its words; links show their host, never a URL', () => {
    expect(t).toContain('Click me or this.');
    expect(t).not.toMatch(/javascript:|data:text/i);
    expect(t).not.toMatch(/https?:\/\//i);
    expect(t).not.toMatch(/www\./i);
    expect(t).toContain('Visit example.org today, or shop.example.');
    expect(t).toContain('good.example (evil.example)'); // the text says one site, the link goes to another: both shown
  });
  it('removes invisible and direction-changing characters', () => {
    expect(t).toContain('Zerowidth and reversed and bom');
    for (const c of [ZWSP, RLO, SHY, BOM]) expect(t).not.toContain(c);
  });
  it('collapses the long quoted history', () => {
    expect(t).toMatch(/\[Earlier messages in this conversation are hidden \(\d+ lines\)\.\]$/);
    expect(t).not.toContain('Line four');
    expect(out.quotedLinesHidden).toBeGreaterThanOrEqual(5);
  });
});

describe('size and cost', () => {
  it('a giant body is cut to 100 KB, quickly', () => {
    const para = '<p>' + 'All work and no play makes Jack a dull boy. '.repeat(40) + '<a href="https://x.example/a">link</a></p>';
    const html = '<html><body>' + para.repeat(Math.ceil(6_000_000 / para.length)) + '</body></html>';
    const t0 = Date.now();
    const out = sanitizeMail({ html });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(BODY_MAX_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.text).toMatch(/\[The rest of this message is too long to show here\.\]$/);
  });
  it('a hostile, deeply nested body stops at the depth limit instead of taking quadratic time', () => {
    const html = '<p>Before</p>' + '<div>'.repeat(200_000) + 'deep' + '</div>'.repeat(200_000);
    const t0 = Date.now();
    const out = sanitizeMail({ html });
    expect(Date.now() - t0).toBeLessThan(5_000); // was 83 s before the limit
    expect(out.truncated).toBe(true);
    expect(out.text).toMatch(/^Before\n\n\[The rest of this message is too long to show here\.\]$/);
    // ordinary nesting (tables in tables) is nowhere near the limit
    expect(sanitizeMail({ html: '<div>'.repeat(300) + 'fine' + '</div>'.repeat(300) }).text).toBe('fine');
  });
  it('the cut never splits a character', () => {
    const out = sanitizeMail({ text: 'é'.repeat(200_000) }, { maxBytes: 1001 });
    expect(out.text).not.toContain(String.fromCharCode(0xfffd));
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(1001);
  });
});

describe('plain-text bodies and the helpers', () => {
  it('a text body: raw links become hosts, quoted history collapses, short inline quotes stay', () => {
    const text = [
      'Hi,', '> Can you make Saturday?', 'Yes, see https://calendar.example.com/e/123?tok=abc', 'Bye',
      '', '-----Original Message-----', 'From: Ellen', 'Sent: Monday', 'To: Robert', 'Subject: Saturday', 'Old line 1', 'Old line 2',
    ].join('\r\n');
    const out = sanitizeMail({ text });
    expect(out.text).toContain('> Can you make Saturday?');
    expect(out.text).toContain('Yes, see calendar.example.com');
    expect(out.text).not.toContain('tok=abc');
    expect(out.text).not.toContain('Old line 1');
    expect(out.text).toMatch(/hidden \(7 lines\)/);
  });
  it('a long "> " block collapses on its own', () => {
    const r = collapseQuotes(['Reply', '> a', '> b', '> c', '> d', '> e', 'After'].join('\n'));
    expect(r.text).toBe('Reply\n[Earlier messages in this conversation are hidden (5 lines).]\nAfter');
  });
  it('recognises the ways CSS hides text', () => {
    for (const s of ['display:none', 'DISPLAY: NONE !important', 'visibility:hidden', 'opacity:0', 'font-size:0', 'font-size:1px', 'mso-hide:all', 'max-height:0;overflow:hidden', 'width:0;overflow:hidden', 'left:-9999px', 'color:transparent', 'color:rgba(0,0,0,0)'])
      expect(styleHides(s), s).toBe(true);
    for (const s of ['display:block', 'font-size:14px', 'opacity:0.9', 'color:#333', 'max-height:200px;overflow:hidden'])
      expect(styleHides(s), s).toBe(false);
    const set = new Set<string>();
    hiddenSelectorsFrom('.a{display:none} .b{color:red} @media screen{.c{display:none}} p.d, .e{visibility:hidden} #f{opacity:0}', set);
    expect([...set].sort()).toEqual(['#f', '.a', '.d', '.e']);
  });
  it('header lines: entities decoded, invisible characters removed, URLs as hosts', () => {
    expect(cleanLine(`It&#39;s here &amp; ready${ZWSP} — see https://x.example/a?b=1`)).toBe("It's here & ready — see x.example");
    expect(linksToHosts('go <https://a.example/x> now')).toBe('go (a.example) now');
  });
});
