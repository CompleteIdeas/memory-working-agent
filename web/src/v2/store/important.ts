/**
 * The Important list's pure parts (v2 build, slice W3): what the screens show from the store's items, with the
 * person's actions that are still on their way (in flight, or waiting in the outbox) already applied, so a tap shows
 * at once and goes back by itself if the server refuses it. Plain TypeScript: unit-tested in node.
 */
import type { ImportantGroup, ImportantItem, ImportantList, TriageRule } from '../api/client';
import type { NotImportantScope, OutboxEntry, SkippedRow } from './core';

export const GROUP_LABEL: Record<ImportantGroup, string> = { today: 'Today', week: 'This week', earlier: 'Earlier' };
/** "I skipped 5 others today", "… this week", "… before that" */
export const GROUP_WHEN: Record<ImportantGroup, string> = { today: 'today', week: 'this week', earlier: 'before that' };
export const GROUPS: ImportantGroup[] = ['today', 'week', 'earlier'];

/** The items as the person should see them now: the server's, with their own pending taps applied in order. */
export function withPending(items: Record<string, ImportantItem>, pending: OutboxEntry[], now: number): Record<string, ImportantItem> {
  let out = items;
  for (const e of pending) {
    const id = e.args.id;
    if (!id) continue;
    const it = out[id];
    if (!it) continue;
    let state: ImportantItem['state'] | null = null;
    if (e.kind === 'item.handled') state = 'handled';
    else if (e.kind === 'item.unhandle') state = 'open';
    else if (e.kind === 'item.notImportant') state = 'not-important';
    if (!state || it.state === state) continue;
    if (out === items) out = { ...items };
    out[id] = { ...it, state, handledAt: state === 'open' ? null : (it.handledAt ?? now) };
  }
  return out;
}

export interface ItemGroupView { group: ImportantGroup; label: string; items: ImportantItem[] }
/** Today / This week / Earlier, newest first; open (and snoozed-and-due) items only. */
export function groupItems(items: Record<string, ImportantItem>): ItemGroupView[] {
  const open = Object.values(items).filter((i) => i.state === 'open');
  return GROUPS.map((g) => ({ group: g, label: GROUP_LABEL[g], items: open.filter((i) => i.group === g).sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1)) }));
}
/** Handled · N, most recently handled first. */
export function handledItems(items: Record<string, ImportantItem>): ImportantItem[] {
  return Object.values(items).filter((i) => i.state === 'handled').sort((a, b) => (b.handledAt ?? 0) - (a.handledAt ?? 0) || b.ts - a.ts);
}

const KIND_PLURAL: Record<string, string> = {
  newsletter: 'newsletters', promotion: 'promotions', receipt: 'receipts', notification: 'notifications', personal: 'personal messages',
  work: 'work messages', social: 'social updates', other: 'other mail',
};
export const kindPlural = (k: string) => KIND_PLURAL[k] ?? `${k} messages`;

/** "I skipped 5 others today: newsletters, receipts, promotions" (most common kind first; the person's own rules
 *  as "what you marked not important"). Null when nothing was skipped. */
export function skipLine(group: ImportantGroup, s: ImportantList['skipped'][ImportantGroup] | undefined): string | null {
  if (!s || s.count <= 0) return null;
  const kinds = Object.entries(s.kinds).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => kindPlural(k));
  const names = [...(s.byYou > 0 ? ['what you marked not important'] : []), ...kinds];
  const others = s.count === 1 ? '1 other' : `${s.count} others`;
  return `I skipped ${others} ${GROUP_WHEN[group]}${names.length ? `: ${names.join(', ')}` : ''}`;
}

/** Skipped rows with the ones the person just said were important (in flight or queued) already gone. */
export function skippedWithPending(rows: SkippedRow[], pending: OutboxEntry[]): SkippedRow[] {
  const going = new Set(pending.filter((e) => e.kind === 'mail.important').map((e) => e.args.id));
  return going.size ? rows.filter((r) => !going.has(r.mail.id)) : rows;
}
/** Rules with the ones being removed already gone. */
export function rulesWithPending(rules: TriageRule[], pending: OutboxEntry[]): TriageRule[] {
  const going = new Set(pending.filter((e) => e.kind === 'rule.delete').map((e) => e.args.id));
  return going.size ? rules.filter((r) => !going.has(r.id)) : rules;
}

// ---------- "Not important": what the server will accept ----------

/** Free mailbox domains: skipping one would hide everyone who uses it, so the server refuses it (src/v2/mail-trust.ts). */
export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'aol.com', 'gmx.com', 'gmx.net', 'gmx.de',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'tutanota.com', 'tuta.io', 'hey.com', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'qq.com', '163.com', 'web.de',
]);
/** Kinds the server can learn from how a message is SENT (a list, a promotion, a receipt…), never personal or work. */
const HEADER_KINDS = new Set(['newsletter', 'promotion', 'receipt', 'notification', 'social']);

export interface ScopeOption { scope: NotImportantScope; label: string }
export interface ScopeChoice {
  /** what the sheet offers (sender first); empty: no choice to make (not from an email), it just leaves the list */
  options: ScopeOption[];
  /** a plain line on what is not offered and why ("gmail.com is a free email service…") */
  note: string | null;
  address: string | null;
  domain: string | null;
}
/**
 * The choices "Not important" offers for an item, as far as the client can tell: messages from this sender; from
 * this domain (not a free mailbox domain); of this kind (only a kind the headers can establish). The server has the
 * last word: a choice it refuses (400 freemail_domain, kind_not_available) is shown in its own words.
 */
export function scopeChoice(it: Pick<ImportantItem, 'source' | 'fromAddress' | 'kind' | 'mailId'>): ScopeChoice {
  const addr = it.fromAddress?.trim().toLowerCase() || null;
  if (!addr || !addr.includes('@') || !it.mailId) return { options: [], note: null, address: null, domain: null };
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  const options: ScopeOption[] = [{ scope: 'sender', label: `Messages from ${addr}` }];
  let note: string | null = null;
  if (FREEMAIL.has(domain)) note = `${domain} is a free email service: skipping all of it would hide everyone who uses it, people you know included. So I can only skip this sender.`;
  else options.push({ scope: 'domain', label: `Everything from ${domain}` });
  if (it.kind && HEADER_KINDS.has(it.kind)) options.push({ scope: 'kind', label: `All ${kindPlural(it.kind)}` });
  return { options, note, address: addr, domain };
}

/** What a rule does, in plain words: "Skip messages from orders@hillside.example", "Show newsletters". */
export function ruleLine(r: Pick<TriageRule, 'match' | 'value' | 'verdict'>): string {
  const verb = r.verdict === 'skip' ? 'Skip' : 'Show';
  if (r.match === 'kind') return `${verb} ${kindPlural(r.value)}`;
  if (r.match === 'list-id') return `${verb} the mailing list ${r.value}`;
  if (r.match === 'domain') return `${verb} everything from ${r.value}`;
  return `${verb} messages from ${r.value}`;
}
/** What it decides in the cached mail now: "Hides 14 messages from 3 senders". */
export function ruleEffectLine(r: Pick<TriageRule, 'verdict' | 'effect'>): string {
  const { messages, senders } = r.effect;
  const verb = r.verdict === 'skip' ? 'Hides' : 'Shows';
  if (!messages) return 'Nothing in your recent mail matches it now.';
  return `${verb} ${messages === 1 ? '1 message' : `${messages} messages`}${senders > 1 ? ` from ${senders} senders` : ''} in your recent mail.`;
}

/** The chip's words when the server has not named the thing yet: the item's title, cut short. */
export function shortLabel(s: string, n = 40): string { return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; }
