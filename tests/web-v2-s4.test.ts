// v2 build, slice S4: approvals in fixture mode (web/src/v2/dev/fixtures-approvals.ts) answer with the contract's shapes
// and the server's rules (a decision is final, a declined one keeps the note, the phishing one is never a Needs-you card
// but is in Important with its caution and a Review that opens it), Today's Needs-you card opens the approval sheet
// (no classic-app hand-off), a tapped notification's #/approval/<id> names the approval, and the sheet's words
// (screens/approvals/words.ts). The sheet itself runs in the browser: scripts/v2-s4-smoke.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { FixtureServer } from '../web/src/v2/dev/fixtures';
import { forJob, groupPending, looseCount, reviewerLine, stateLine, sureLine, waitsLine } from '../web/src/v2/screens/approvals/words';
import { parseNotifyHash } from '../web/src/v2/shell/notifyRoute';
import type { ApprovalView } from '../web/src/v2/api/client';

const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as typeof addFormats.default)(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });
function valid(path: string, method: string, res: { status: number; body: unknown }) {
  const op = spec.paths[path][method];
  const r = op.responses[String(res.status)] ?? op.responses.default;
  const resolved = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
  const fn = ajv.compile(JSON.parse(JSON.stringify(resolved.content['application/json'].schema).replace(/"#\/components\//g, '"spec#/components/')));
  expect(fn(res.body) ? null : `${method.toUpperCase()} ${path} ${res.status}: ${ajv.errorsText(fn.errors)}`).toBeNull();
  return res as { status: number; body: any };
}
const H = { 'x-mwa-client': 'web/1.0.0' };
let k = 0;
const call = (s: FixtureServer, method: string, path: string, body?: unknown) =>
  s.handle({ method, path, query: new URLSearchParams(), headers: { ...H, 'idempotency-key': `s4-key-${++k}` }, body });
const get = (s: FixtureServer, path: string) => s.handle({ method: 'GET', path, query: new URLSearchParams(), headers: H, body: undefined });

describe('S4 fixture mode answers like the server', () => {
  it('the list, one, approve and deny have the contract\'s shapes; a decision is final', () => {
    const s = new FixtureServer('approvals');
    const list = valid('/approvals', 'get', get(s, '/approvals')).body;
    expect(list.pending.map((a: ApprovalView) => a.id)).toEqual(['ap_report', 'ap_clean', 'ap_phish', 'ap_contact']);
    // review of S4: a high-risk one needs confirmed: true
    expect(valid('/approvals/{id}/approve', 'post', call(s, 'POST', '/approvals/ap_clean/approve')).body.error.code).toBe('confirm_needed');
    // the lists: yours (no phishing), others apart; the pill counts yours that no job asked for
    const g = groupPending(list.pending);
    expect([g.mine.map((a) => a.id), g.others.map((a) => a.id)]).toEqual([['ap_report', 'ap_clean'], ['ap_contact']]);
    expect(looseCount(list.pending)).toBe(1);
    expect((get(s, '/today').body as { status: { text: string } }).status.text).toBe('Working on 1 · 2 waiting for you');
    expect(list.recent.map((a: ApprovalView) => a.state)).toEqual(['expired']);
    const one = valid('/approvals/{id}', 'get', get(s, '/approvals/ap_phish')).body.approval as ApprovalView;
    expect(one).toMatchObject({ caution: 'phishing', confirm: true });
    expect(one.risks[0].kind).toBe('phishing');
    expect(valid('/approvals/{id}', 'get', get(s, '/approvals/ap_nope')).status).toBe(404);
    const ok = valid('/approvals/{id}/approve', 'post', call(s, 'POST', '/approvals/ap_report/approve'));
    expect(ok.body).toMatchObject({ outcome: 'done', approval: { state: 'done' } });
    expect(s.jobs.get('j_report')?.status.state).toBe('done'); // the job that waited goes on
    expect(valid('/approvals/{id}/approve', 'post', call(s, 'POST', '/approvals/ap_report/approve')).body.error.code).toBe('already_decided');
    const no = valid('/approvals/{id}/deny', 'post', call(s, 'POST', '/approvals/ap_clean/deny', { note: 'Keep the drafts' }));
    expect(no.body.approval).toMatchObject({ state: 'declined', result: 'declined by the person: Keep the drafts' });
    expect(valid('/approvals/{id}/approve', 'post', call(s, 'POST', '/approvals/ap_old/approve')).body.error.code).toBe('expired');
    expect(valid('/approvals/{id}/deny', 'post', call(s, 'POST', '/approvals/ap_phish/deny', { note: 3 })).status).toBe(400);
  });
  it('Today counts the two that may be a Needs-you card (never the phishing one) and opens them in the app, not the classic one', () => {
    const s = new FixtureServer('approvals');
    const today = get(s, '/today').body as { needsYou: { kind: string; count: number; title: string; action: { kind: string } | null; open: { kind: string; id: string | null } }[] };
    const card = today.needsYou.find((n) => n.kind === 'approval')!;
    expect(card).toMatchObject({ count: 2, title: '2 things need your OK', action: { kind: 'review-approval' }, open: { kind: 'approvals', id: null } });
    expect(JSON.stringify(today.needsYou)).not.toContain('contacts.csv');
    // the job that waits for ap_report has its own card with Review
    expect(today.needsYou.find((n) => n.kind === 'job')).toMatchObject({ action: { kind: 'review' }, open: { kind: 'job', id: 'j_report' } });
    // Important: the phishing one is there, with the caution, and its Review says where to go (the approval)
    const list = valid('/items', 'get', get(s, '/items')).body as { groups: { items: { id: string; caution: string | null; source: string; action: { kind: string } | null }[] }[] };
    const items = list.groups.flatMap((g) => g.items);
    const phish = items.find((i) => i.id === 'it_ap_ap_phish')!;
    expect(phish).toMatchObject({ source: 'approval', caution: 'phishing', action: { kind: 'review-approval' } });
    const r = call(s, 'POST', '/items/it_ap_ap_phish/action', {});
    expect(r.body).toMatchObject({ done: false, route: { view: 'approval', approvalId: 'ap_phish' } });
    // the screen source has no hand-off to the classic app for approvals any more
    const src = readFileSync(new URL('../web/src/v2/screens/today/Today.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/ui=v1/);
    expect(readFileSync(new URL('../web/src/v2/shell/sheets.tsx', import.meta.url), 'utf8')).not.toMatch(/classic app/);
  });
  it('no other scenario has approvals', () => {
    const s = new FixtureServer('N00');
    expect(get(s, '/approvals').body).toEqual({ pending: [], recent: [] });
  });
  it('a tapped notification names the approval to open', () => {
    expect(parseNotifyHash('#/approval/ap_clean')).toEqual({ to: 'approval', id: 'ap_clean' });
    expect(parseNotifyHash('#/approval/')).toEqual({ to: 'today' });
  });
});

describe('the sheet\'s words', () => {
  const now = new Date(2026, 10, 9, 9, 10).getTime();
  it('how long it waits', () => {
    expect(waitsLine({ expiresAt: now + 30 * 60_000 }, now)).toBe('It waits for you until 9:40 AM (30 min left).');
    expect(waitsLine({ expiresAt: now + 30_000 }, now)).toBe('It expires in under a minute.');
    expect(waitsLine({ expiresAt: now - 1 }, now)).toBe('It has expired.');
    expect(waitsLine({ expiresAt: now + 24 * 3_600_000 }, now)).toMatch(/^It waits for you until Tue 9:10 AM \(24 h left\)\.$/);
  });
  it('what happened', () => {
    expect(stateLine({ state: 'declined', decidedAt: now, expiresAt: now, ranIn: null })).toBe('You said no. Nothing was changed.');
    expect(stateLine({ state: 'approved', decidedAt: now, expiresAt: now, ranIn: 'Telegram or the mailbox' })).toBe('Approved. It runs in Telegram or the mailbox, within a minute or so.');
    expect(stateLine({ state: 'expired', decidedAt: now, expiresAt: now, ranIn: null })).toBe('It expired at 9:10 AM, so nothing was done.');
  });
  it('the reviewer and the confirm question', () => {
    expect(reviewerLine({ decision: 'ask', by: 'command', reason: 'it reaches the home folder' })).toBe('MWA’s reviewer would ask you too: it reaches the home folder.');
    expect(reviewerLine(null)).toBeNull();
    expect(sureLine({ caution: 'phishing', risks: [{ kind: 'phishing', level: 'high', text: '' }, { kind: 'network', level: 'high', text: '' }, { kind: 'runs-as-you', level: 'warn', text: '' }] }))
      .toBe('Approve it even though it came from an email that looks like phishing and it reaches the internet?');
  });
  it('a job\'s Review finds its own approval', () => {
    const s = new FixtureServer('approvals');
    const pending = get(s, '/approvals').body.pending as ApprovalView[];
    expect(forJob(pending, 'j_report').map((a) => a.id)).toEqual(['ap_report']);
  });
});
