/**
 * /api/v1 Important ("Worth a look", v2 slice A9): the cross-source list, and the person's controls on it.
 *
 *   GET  /items?state=open&group=         the list, grouped Today / This week / Earlier, with what was skipped per group
 *   GET  /items/skipped?group=            the skipped mail (headers only), each with why it was skipped
 *   POST /items/{id}/handled              Handled (it leaves the list); POST /items/{id}/unhandle is the Undo
 *   POST /items/{id}/not-important        {scope: sender|domain|kind} — teaches the filter (a rule), and it leaves
 *   POST /mail/{id}/important             "This was important" on a skipped message — teaches the other way
 *   POST /items/{id}/action               the item's one action, through the existing verbs: a calendar DRAFT, a
 *                                         reminder, or where to go (the reader, the job, Settings, the approval)
 *   POST /important/refresh               sort new mail and rebuild the list now
 *
 * Trust: rules are written here and only here, from the person's own taps. An item's action runs only when the
 * person taps it, and what it does is a draft (Add to calendar adds an MWA-held draft marked helper-after-reading,
 * confirmed separately) or a navigation. Nothing a message says reaches a write on its own.
 */
import { ApiError, type Route } from '../router.js';
import {
  apiItem, getItem, payloadOf, putRule, putVerdict, getVerdict, setItemState, visibleItem, itemByKey, listRules, deleteRule, GROUPS,
  type Group, type ItemRow,
} from '../../v2/important.js';
import { isFreemail } from '../../v2/mail-trust.js';
import {
  applyRulesNow, importantList, kindPlural, refreshImportant, skippedMail, sortingView, triageNow, triageTz, rebuildItems, headerKind, ruleEffect,
} from '../../v2/triage.js';
import { appDb, recordEvent } from '../../v2/db.js';
import { getMail, parseMailId, mailId } from '../../v2/mail.js';
import { cleanLine } from '../../v2/mail-text.js';
import { addDraft, DraftError, DRAFT_ADDED, AFTER_READING_NOTE } from '../../sync/drafts.js';
import { draftItem } from '../../v2/calendar.js';
import { localDate } from '../../sync/tz.js';

export interface ImportantRouteDeps {
  /** Set a reminder that is DELIVERED as written when due (a reminder job: no run, nothing carried out), marked as
   *  coming from outside content. Returns its id, or null when it could not be made. */
  remind?: (text: string, atMs: number) => Promise<string | null>;
}
let deps: ImportantRouteDeps = {};
export function setImportantRouteDeps(d: ImportantRouteDeps | null): void { deps = d ?? {}; }

const REFRESH_WAIT_MS = 20_000;
const SCOPES = ['sender', 'domain', 'kind'] as const;
type NotImportantScope = (typeof SCOPES)[number];

function groupParam(v: string | null): Group | undefined {
  if (v === null || v === '') return undefined;
  if (!(GROUPS as readonly string[]).includes(v)) throw new ApiError(400, 'bad_group', 'group must be today, week or earlier.');
  return v as Group;
}
function loadItem(id: string): ItemRow {
  const r = /^it_[A-Za-z0-9_-]{8,40}$/.test(id) ? getItem(id) : null;
  if (!r || !visibleItem(r)) throw new ApiError(404, 'not_found', 'No such item.');
  return r;
}
const out = (r: ItemRow) => apiItem(r, triageNow(), triageTz());
const bodyObj = (b: unknown): Record<string, unknown> => {
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'bad_json', 'Send a JSON object.');
  return b as Record<string, unknown>;
};
/** The message an item came from, if it is still in the cache. */
function mailOf(r: ItemRow) {
  const mid = r.source_ref?.startsWith('m_') ? r.source_ref : null;
  const p = mid ? parseMailId(mid) : null;
  return p && mid ? { id: mid, row: getMail(p.account, p.providerId) } : null;
}
const domainOf = (addr: string) => addr.slice(addr.lastIndexOf('@') + 1).toLowerCase();
function setPayload(r: ItemRow, patch: Record<string, unknown>, why?: string): ItemRow {
  const d = appDb();
  return d.transaction(() => {
    const seq = recordEvent({ entity: 'item', id: r.id }, d);
    d.prepare('UPDATE items SET action_payload = ?, action_kind = NULL, why = COALESCE(?, why), updated_seq = ? WHERE id = ?')
      .run(JSON.stringify({ ...(payloadOf(r) ?? {}), ...patch }), why ?? null, seq, r.id);
    return getItem(r.id, d)!;
  }).immediate();
}
const atText = (ms: number, tz: string) => {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(ms).replace(',', '');
  const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ms).replace(':00', '').replace(/\s/g, '').toLowerCase();
  return `${day} at ${t}`;
};

export const importantRoutes: Route[] = [
  {
    method: 'GET', path: '/items', scope: 'read',
    handler: ({ url }) => {
      const s = url.searchParams.get('state') ?? 'open';
      if (s !== 'open' && s !== 'handled' && s !== 'not-important') throw new ApiError(400, 'bad_state', 'state must be open, handled or not-important.');
      return { body: importantList({ state: s, group: groupParam(url.searchParams.get('group')) }) };
    },
  },
  {
    method: 'GET', path: '/items/skipped', scope: 'read',
    handler: ({ url }) => {
      const group = groupParam(url.searchParams.get('group'));
      const list = skippedMail(triageNow(), triageTz(), group);
      return {
        body: {
          group: group ?? null, count: list.length,
          skipped: list.map((x) => ({ mail: x.mail, group: x.group, kind: x.kind, reason: x.reason, byYou: x.byYou })),
        },
      };
    },
  },
  {
    method: 'POST', path: '/items/{id}/handled', scope: 'act',
    handler: ({ params }) => {
      const r = loadItem(params.id);
      const already = r.state === 'handled';
      const after = setItemState(r.id, 'handled', triageNow())!;
      return { body: { item: out(after), already, message: `Marked handled: ${after.title}` } };
    },
  },
  {
    method: 'POST', path: '/items/{id}/unhandle', scope: 'act',
    handler: ({ params }) => {
      const r = loadItem(params.id);
      if (r.state === 'not-important') throw new ApiError(409, 'not_handled', 'That item was marked not important, not handled.');
      const already = r.state === 'open';
      const after = setItemState(r.id, 'open', triageNow())!;
      return { body: { item: out(after), already, message: already ? 'It is already on your list.' : `Back on your list: ${after.title}` } };
    },
  },
  {
    method: 'POST', path: '/items/{id}/not-important', scope: 'act',
    handler: ({ params, body }) => {
      const r = loadItem(params.id);
      const b = bodyObj(body);
      const scope = (b.scope ?? 'sender') as NotImportantScope;
      if (!SCOPES.includes(scope)) throw new ApiError(400, 'bad_scope', 'scope must be sender, domain or kind.');
      const now = triageNow();
      const m = mailOf(r);
      let message: string;
      let rule: { id: string; match: string; value: string } | null = null;
      let effect: { messages: number; senders: number } | null = null;
      if (m?.row?.from_addr) {
        // the person's tap is the only thing that writes a rule
        const addr = m.row.from_addr.toLowerCase();
        const dom = domainOf(addr);
        // a kind is learned only when the headers establish it (a list, a promotion, a receipt) — never a kind the
        // model inferred from text the sender wrote (review of A9, H2)
        const kind = headerKind(m.row);
        if (scope === 'kind' && !kind) throw new ApiError(400, 'kind_not_available', `I can only learn a kind from how a message is sent (a mailing list, a promotion, a receipt). Choose "messages from ${addr}" instead.`);
        if (scope === 'domain' && isFreemail(dom)) throw new ApiError(400, 'freemail_domain', `${dom} is a free email service: skipping it would hide everyone who uses it, people you know included. Choose "messages from ${addr}" instead.`);
        const made = scope === 'kind' ? putRule('kind', kind!, 'skip', now) : scope === 'domain' ? putRule('domain', dom, 'skip', now) : putRule('sender', addr, 'skip', now);
        rule = { id: made.id, match: made.match_kind, value: made.value };
        effect = ruleEffect(made);
        const others = effect.senders > 1 ? ` This will hide mail from ${effect.senders} senders (${effect.messages} messages now).` : '';
        message = scope === 'kind' ? `Got it. I'll skip ${kindPlural(kind!)}.${others}` : scope === 'domain' ? `Got it. I'll skip messages from ${dom}.${others}` : `Got it. I'll skip messages like this from ${addr}.`;
      } else {
        message = m ? "Got it. I've taken it off your list (that message is no longer in your inbox, so I can't learn from it)." : "Got it. I've taken it off your list.";
      }
      const after = setItemState(r.id, 'not-important', now)!;
      if (rule) applyRulesNow(now, triageTz());
      return { body: { item: out(getItem(after.id) ?? after), rule, ...(effect ? { effect } : {}), message } };
    },
  },
  {
    method: 'GET', path: '/triage/rules', scope: 'read',
    handler: () => ({ body: { rules: listRules().map((x) => ({ id: x.id, match: x.match_kind, value: x.value, verdict: x.verdict, createdAt: x.ts, effect: ruleEffect(x) })) } }),
  },
  {
    method: 'DELETE', path: '/triage/rules/{id}', scope: 'act',
    handler: ({ params }) => {
      const x = /^tr_[A-Za-z0-9_-]{4,40}$/.test(params.id) ? deleteRule(params.id) : null;
      if (!x) throw new ApiError(404, 'not_found', 'No such rule.');
      applyRulesNow(triageNow(), triageTz());
      void refreshImportant().catch(() => { /* next refresh */ });
      const what = x.match_kind === 'sender' ? `messages from ${x.value}` : x.match_kind === 'domain' ? `messages from ${x.value}` : x.match_kind === 'kind' ? kindPlural(x.value) : `the list ${x.value}`;
      return { body: { removed: { id: x.id, match: x.match_kind, value: x.value, verdict: x.verdict }, message: `Undone. I'll sort ${what} as usual again.` } };
    },
  },
  {
    method: 'POST', path: '/mail/{id}/important', scope: 'act',
    handler: ({ params }) => {
      const p = parseMailId(params.id);
      const row = p ? getMail(p.account, p.providerId) : null;
      if (!p || !row) throw new ApiError(404, 'not_found', 'No such message.');
      const id = mailId(row.account, row.provider_id);
      const now = triageNow();
      const from = cleanLine(row.from_name, 120) || row.from_addr || 'this sender';
      let rule: { id: string; match: string; value: string } | null = null;
      if (row.from_addr) { const made = putRule('sender', row.from_addr, 'important', now); rule = { id: made.id, match: 'sender', value: made.value }; }
      else {
        const prev = getVerdict(id);
        putVerdict({ mail_id: id, verdict: 'important', kind: prev?.kind ?? 'other', reason_code: 'person', why: prev?.why ?? null, model: prev?.model ?? null, cost_usd: 0, ts: now });
      }
      applyRulesNow(now, triageTz());
      // a newsletter shown now may hold dated facts: read it in the background (within the budget)
      void refreshImportant().catch(() => { /* next refresh */ });
      const item = itemByKey(`mail:${id}`);
      if (item && item.state !== 'open') setItemState(item.id, 'open', now);
      const fresh = itemByKey(`mail:${id}`);
      return {
        body: {
          item: fresh && fresh.gone === 0 ? out(fresh) : null, rule,
          message: row.from_addr ? `Thanks — I'll show messages like this from ${from}.` : "Thanks — it's on your list.",
        },
      };
    },
  },
  {
    method: 'POST', path: '/items/{id}/action', scope: 'act',
    handler: async ({ params }) => {
      const r = loadItem(params.id);
      if (r.gone || r.state !== 'open') throw new ApiError(409, 'not_open', 'That item is no longer on your list.');
      if (!r.action_kind) throw new ApiError(409, 'no_action', 'This item has nothing to do.');
      const p = payloadOf(r) ?? {};
      const tz = triageTz();
      switch (r.action_kind) {
        case 'add-to-calendar': {
          const x = p.draft as { title?: string; start?: string; end?: string; allDay?: boolean; location?: string | null; tz?: string } | undefined;
          if (!x?.title || !x.start) throw new ApiError(409, 'no_action', 'This item has no date to add.');
          let res;
          try {
            res = addDraft({
              title: x.title, start: x.start, end: x.end, allDay: x.allDay, location: x.location ?? undefined, tz: x.tz || tz,
              origin: 'helper', suggestedAfterOutside: true, originNote: AFTER_READING_NOTE, sourceItem: r.id, projectId: r.project_id,
            });
          } catch (e) {
            if (e instanceof DraftError) throw new ApiError(e.status, e.code, e.message, e.transient);
            throw e;
          }
          rebuildItems(triageNow(), tz);
          return { status: res.existing ? 200 : 201, body: { kind: r.action_kind, done: true, message: DRAFT_ADDED, draft: draftItem(res.draft), item: out(getItem(r.id)!) } };
        }
        case 'remind': {
          const at = Number(p.at), text = typeof p.text === 'string' ? p.text : `Reminder: ${r.title}`;
          if (!Number.isFinite(at) || at <= triageNow()) throw new ApiError(409, 'no_action', 'It is too late to set that reminder.');
          if (!deps.remind) throw new ApiError(503, 'unavailable', 'Reminders are not available on this server.', true);
          const id = await deps.remind(text.slice(0, 300), at);
          if (!id) throw new ApiError(503, 'unavailable', 'I could not set that reminder just now. Try again in a moment.', true);
          const note = `I'll remind you ${atText(at, tz)}.`;
          const after = setPayload(r, { reminded: note, reminderId: id }, `${r.why ?? ''} ${note}`.trim());
          rebuildItems(triageNow(), tz);
          return { body: { kind: r.action_kind, done: true, message: note, item: out(after) } };
        }
        case 'review-reply':
          return { body: { kind: r.action_kind, done: false, route: { view: 'mail', mailId: String(p.mailId ?? r.source_ref ?? '') }, message: 'Open the message.', item: out(r) } };
        case 'open-job':
          return { body: { kind: r.action_kind, done: false, route: { view: 'job', jobId: String(p.jobId ?? r.source_ref ?? '') }, message: 'Open the job.', item: out(r) } };
        case 'reconnect':
          return { body: { kind: r.action_kind, done: false, route: { view: 'settings', section: 'connections', account: String(p.account ?? r.source_ref ?? '') }, message: 'Reconnect it in Settings.', item: out(r) } };
        case 'review-approval':
          return { body: { kind: r.action_kind, done: false, route: { view: 'approval', approvalId: String(p.approvalId ?? r.source_ref ?? '') }, message: 'Review it.', item: out(r) } };
        case 'draft-note':
          // the note itself is drafted by the helper when the person sends this to Ask (slice A6), which loads the two
          // events' titles itself, fenced: no title text travels in an instruction from here (review of A9, M4)
          {
            const about = p.about as { kind?: string; id?: string } | undefined;
            return { body: { kind: r.action_kind, done: false, route: { view: 'ask', item: r.id, about: { kind: 'conflict', id: String(about?.id ?? r.source_ref ?? '') }, date: String(p.date ?? localDate(triageNow(), tz)) }, message: 'Ask your helper to draft the note.', item: out(r) } };
          }
      }
      throw new ApiError(409, 'no_action', 'This item has nothing to do.');
    },
  },
  {
    method: 'POST', path: '/important/refresh', scope: 'act',
    handler: async () => {
      const run = refreshImportant();
      const done = await Promise.race([run.then(() => true), new Promise<false>((res) => setTimeout(() => res(false), REFRESH_WAIT_MS).unref?.())]);
      return {
        status: done ? 200 : 202,
        body: { done, sorting: sortingView(), message: done ? 'Up to date.' : 'Still sorting. New items will appear as they are ready.' },
      };
    },
  },
];
