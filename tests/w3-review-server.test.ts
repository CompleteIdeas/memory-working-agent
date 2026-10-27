// Review of W3 (server side): a display name never hides the real address (the probe's Coach Ellen and PayPal
// cases), the caution a message carries wherever it is shown (A9's verdict flags, or the phishing header signal for a
// message not sorted yet), and facts read from an unverified newsletter carry the unverified caution.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetAppDb } from '../src/v2/db.js';
import { applySync, apiMailHeader, getMail, mailCaution, mailId } from '../src/v2/mail.js';
import { putVerdict } from '../src/v2/important.js';
import { factItem } from '../src/v2/triage.js';
import { displayName, parseAddress, showAddresses, DISPLAY_NAME_MAX } from '../src/v2/mail-text.js';

const RLO = '‮', PDF = '‬';

describe('display names never hold an address', () => {
  it('the probe: Coach Ellen with an address and an office in her name', () => {
    expect(displayName('Coach Ellen Park <ellen@willowcreekfarm.example> · Willow Creek Farm Office')).toBe('Coach Ellen Park · Willow Creek Farm Office');
  });
  it('the probe: PayPal with a reversed address and an angle address in the quoted name', () => {
    const from = parseAddress(`"PayPal Service ${RLO}moc.lapyap@ecivres${PDF} <service@paypal.com>" <x@evil.example>`);
    expect(from.addr).toBe('x@evil.example');
    expect(displayName(from.name)).toBe('PayPal Service');
  });
  it('the probe: a long name with an address in parentheses is cut at 60 characters', () => {
    const n = displayName(parseAddress('"PayPal Support Team (service@paypal.com) Account Security Department Notifications Center" <attacker@evil.example>').name)!;
    expect(n).not.toMatch(/@|\(\s*\)/);
    expect(n.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX);
    expect(n.startsWith('PayPal Support Team Account Security Department')).toBe(true);
    expect(n.endsWith('…')).toBe(true);
  });
  it('a name that is only an address becomes no name; ordinary names pass unchanged', () => {
    expect(displayName('service@paypal.com')).toBeNull();
    expect(displayName('<service@paypal.com>')).toBeNull();
    expect(displayName('Coach Ellen')).toBe('Coach Ellen');
    expect(displayName(null)).toBeNull();
    expect(showAddresses([{ name: 'PayPal <service@paypal.com>', addr: 'x@evil.example' }])).toBe('PayPal <x@evil.example>');
  });
});

describe('a message carries its caution wherever it is shown', () => {
  const ACC = 'google:me@example.com';
  const header = (providerId: string, fromName: string, fromAddr: string, subject: string) => ({
    providerId, threadId: null, fromName, fromAddr, subject, snippet: '', receivedAt: Date.now() - 60_000, unread: true, labels: ['INBOX'], listId: null, hasUnsub: false, messageId: `<${providerId}@x>`,
  });
  beforeEach(() => {
    resetAppDb(':memory:');
    applySync(ACC, 'gmail', { full: true, upserts: [
      header('p1', 'PayPal Service <service@paypal.com>', 'x@evil.example', 'Your account has been limited'),
      header('n1', 'Coach Ellen', 'ellen@example.com', 'Saturday schooling'),
      header('u1', 'Account Services', 'no-reply@billing-notices.example', 'Action required'),
    ], deletes: [], cursor: '1', windowFrom: Date.now() - 14 * 86_400_000, windowTo: Date.now() });
  });
  const row = (id: string) => getMail(ACC, id)!;

  it('not sorted yet: the phishing header signal decides now; an ordinary message has none', () => {
    expect(mailCaution(row('p1'))).toBe('phishing');
    expect(mailCaution(row('n1'))).toBeNull();
    expect(apiMailHeader(row('p1'))).toMatchObject({ caution: 'phishing', from: { name: 'PayPal Service', addr: 'x@evil.example' } });
  });
  it('sorted: what triage decided (phishing, low-trust → unverified, none)', () => {
    const v = (id: string, flags: string | null) => putVerdict({ mail_id: mailId(ACC, id), verdict: 'important', kind: 'other', reason_code: 'unsorted', why: null, model: null, cost_usd: 0, ts: Date.now(), flags });
    v('u1', 'low-trust');
    v('n1', null);
    v('p1', 'phishing:brand');
    expect(mailCaution(row('u1'))).toBe('unverified');
    expect(mailCaution(row('n1'))).toBeNull();
    expect(mailCaution(row('p1'))).toBe('phishing');
  });
});

describe('facts from an unverified newsletter', () => {
  it('carry caution "unverified" and stay untrusted; the Add to calendar draft is still offered', () => {
    const f = { kind: 'event' as const, title: 'Book fair', date: '2099-11-14', start: '15:00', end: '18:00', place: 'Oakwood Elementary' };
    const r = { from_name: 'Oakwood PTA <pta@oakwood.example>', from_addr: 'pta@oakwood.example', received_at: Date.now() };
    const x = factItem(f, r, 'm_x', Date.now(), 'America/New_York', { caution: 'unverified' });
    expect(x).toMatchObject({ caution: 'unverified', trust: 'untrusted', from: 'Oakwood PTA', action: { kind: 'add-to-calendar' } });
    expect(factItem(f, r, 'm_x', Date.now(), 'America/New_York').caution).toBeNull();
  });
});
