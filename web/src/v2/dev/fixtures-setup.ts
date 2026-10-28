/**
 * Fixture mode for getting going (v2 build, slice S6): /setup, warming memory up from a folder, the inbox scan, setup
 * cards and where memory is kept, answered the way src/api/routes/setup.ts and src/setup-flow.ts do, with the
 * server's own words. Whether the brain works follows Settings › Your assistant's fixtures (./fixtures-assistant.ts):
 * saving a brain there makes it work here. Values typed into a card and a database address are never kept.
 *
 * Scenarios: `fresh` (first run on a new computer with no AI brain: first run starts with the brain), `no-brain` (set
 * up, but the brain has no key: every screen says so), `setup-card` (a Telegram card and a vault card are waiting),
 * `phone-card` (the same, on the paired phone);
 * any other: the brain works, memory on this computer, nothing waiting.
 * A folder path with "missing" in it isn't there; "/Users/robert/mwa" holds the helper's keys; a card value with
 * "bad" in it fails its check; a database address with "bad" in it can't be reached.
 * The inbox scan moves one round each time it is read, and is done after four. EVERYTHING HERE IS EXAMPLE DATA.
 */
import type { InboxScan, SetupCard, SetupState, StorageView } from '../api/client';
import type { AssistantFixtures } from './fixtures-assistant';
import { FIXTURE_HELPER_HOME } from './fixtures-assistant';

type Resp = { status: number; body: unknown };
const err = (status: number, code: string, message: string): Resp => ({ status, body: { error: { code, message } } });
const FOLDER_NOTE = 'Reading a folder uses no AI, so it costs nothing. I read up to 60 documents (text, Markdown, PDF, Word, CSV, HTML), which takes a few seconds, and nothing is saved until you choose.';
const KEYLESS = new Set(['ollama']);
const estimate = (days: number) => ({ days, maxEmails: 400, rounds: 34, usd: 0.68, ms: 510_000, text: `I read up to 400 emails from the last ${days} days, 12 at a time, with your AI brain. That costs at most about 68¢ and takes about 9 minutes. You can stop it at any time.` });
const LEARNED = ['Fair Hill entries close Friday', 'Dan Moore is your farrier', 'Pony Club rally on Nov 14', 'Barn invoice due on the 1st', 'Coach Sarah: lessons Tuesdays'];
const NOTES = [
  { name: 'Feeding', text: 'The horses get hay at six and grain at seven, every day of the week.', source: 'barn.md' },
  { name: 'Farrier', text: 'The farrier comes every eight weeks; Dan books it and texts the day before.', source: 'barn.md' },
  { name: 'Arena rules', text: 'The arena is closed on Mondays for dragging. Lessons have priority over hacks.', source: 'rules.pdf' },
];

export class SetupFixtures {
  storage: StorageView = { running: 'sqlite', next: 'sqlite', restartNeeded: false, fixed: false, hosted: false, host: 'this computer', server: null, nextServer: null };
  inbox: InboxScan = { id: null, state: 'idle', days: 30, startedAt: null, endedAt: null, log: [], learned: [], learnedCount: 0, emails: null, message: '', available: true, estimate: estimate(30) };
  cards: SetupCard[] = [];
  private scans = new Map<string, string[]>();
  private n = 0;
  constructor(private scenario: string, private assistant: AssistantFixtures, private clock: () => number, private emailConnected: () => boolean) {
    if (scenario === 'fresh') { assistant.brain = { provider: '', model: '' }; assistant.saved.clear(); }
    if (scenario === 'no-brain') assistant.saved.clear();
    if (scenario === 'setup-card' || scenario === 'phone-card') {
      this.cards = [
        { id: 'setup_tg', name: 'Telegram', where: 'General', howTo: 'Telegram talks to me through a bot that only you control:\n1. In Telegram, open @BotFather and send /newbot. Give it a name, then a username ending in "bot".\n2. BotFather replies with a token (numbers, a colon, then letters). Put it into the setup card.',
          fields: [{ name: 'TELEGRAM_BOT_TOKEN', label: 'Bot token from @BotFather', help: null, secret: true, optional: false }], state: 'waiting', message: '', expiresInSec: 25 * 60, vault: null },
        { id: 'setup_vault', name: 'Vault · barn-bookings', where: 'Eventing', howTo: 'Saved encrypted on this computer as "barn-bookings" for bookings.example. I can use it without seeing it, and only on that site.',
          fields: [{ name: 'username', label: 'username', help: null, secret: false, optional: false }, { name: 'password', label: 'password', help: null, secret: true, optional: false }], state: 'waiting', message: '', expiresInSec: 18 * 60, vault: { site: 'bookings.example' } },
      ];
    }
  }

  private brain() {
    const b = this.assistant.brain;
    const keyName = ({ openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' } as Record<string, string>)[b.provider];
    const ready = !!b.model && (KEYLESS.has(b.provider) || (!!keyName && this.assistant.saved.has(keyName)));
    const missing = ready ? null : !b.model ? 'No AI brain is set up yet, so I can’t answer, sort your mail or do jobs. Pick one in Settings › Your assistant.'
      : `The AI brain (${b.provider}) has no key saved, so I can’t answer, sort your mail or do jobs. Add the key in Settings › Your assistant.`;
    return { ready, provider: b.provider, model: b.model, missing };
  }
  private inboxView(): InboxScan { return { ...this.inbox, available: this.emailConnected(), log: [...this.inbox.log], learned: [...this.inbox.learned] }; }
  /** each read moves a running scan one round on */
  private advance() {
    const s = this.inbox;
    if (s.state === 'stopping') { s.state = 'stopped'; s.endedAt = this.clock(); s.message = `Stopped. I had learned ${s.learnedCount} things by then; they are kept.`; s.log.push('Stopped after 2 of 9 rounds.'); return; }
    if (s.state !== 'running') return;
    const round = s.log.filter((l) => l.includes('batch')).length + 1;
    s.learned = LEARNED.slice(0, Math.min(LEARNED.length, round + 1)); s.learnedCount = s.learned.length;
    s.log.push(`  batch ${round}/4 → ${s.learnedCount} facts learned so far`);
    if (round >= 4) { s.state = 'done'; s.endedAt = this.clock(); s.emails = 46; s.message = `Done: 46 emails read, ${s.learnedCount} things learned.`; s.log.push(`Done — 46 unique messages, ${s.learnedCount} durable facts learned.`); }
  }

  read(path: string, admin: boolean): Resp | null {
    if (path === '/setup') {
      const st: SetupState = { brain: this.brain(), storage: { ...this.storage, server: admin ? this.storage.server : null, nextServer: admin ? this.storage.nextServer : null }, inbox: this.inboxView(), folderNote: FOLDER_NOTE, cardsWaiting: this.cards.filter((c) => c.state === 'waiting').length };
      return { status: 200, body: st };
    }
    if (path === '/setup/inbox') { this.advance(); return { status: 200, body: this.inboxView() }; }
    if (path === '/setup/cards') return { status: 200, body: { cards: this.cards, canSubmit: admin } };
    return null;
  }

  write(method: string, path: string, body: unknown): Resp | null {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/setup/warm') return { status: 200, body: { ready: true, message: 'Your memory is ready.' } };
    if (method === 'POST' && path === '/setup/folder/scan') {
      const p = typeof b.path === 'string' ? b.path.trim() : '';
      if (!p || !/^(\/|[a-z]:[\\/])/i.test(p)) return err(400, 'bad_folder', 'Type the folder’s full path, starting from the drive or /.');
      if (/missing/i.test(p)) return err(400, 'not_found', `I couldn’t find a folder at ${p}.`);
      if (FIXTURE_HELPER_HOME.startsWith(p.replace(/\/+$/, '')) || p.startsWith(FIXTURE_HELPER_HOME)) return err(400, 'refused', 'That folder holds your helper’s own keys and settings, so it can’t be granted. Pick a folder that doesn’t contain them.');
      const scanId = `scan_${++this.n}`;
      const notes = NOTES.map((x, i) => ({ id: `c${i + 1}`, ...x }));
      this.scans.set(scanId, notes.map((x) => x.id));
      return { status: 200, body: { scanId, folder: p, filesScanned: 2, truncated: false, message: `Read 2 files: ${notes.length} notes to look over.`, notes } };
    }
    if (method === 'POST' && path === '/setup/folder/save') {
      const ids = typeof b.scanId === 'string' ? this.scans.get(b.scanId) : undefined;
      if (!ids) return err(409, 'scan_expired', 'That reading of the folder has expired. Read the folder again.');
      const keep = Array.isArray(b.keep) ? b.keep as { id?: unknown }[] : [];
      if (!keep.length) return err(400, 'bad_notes', 'Pick at least one note to keep.');
      if (keep.some((k) => !ids.includes(String(k?.id)))) return err(400, 'bad_notes', 'One of those notes isn’t from this reading. Read the folder again.');
      this.scans.delete(String(b.scanId));
      return { status: 200, body: { saved: keep.length, message: `Saved ${keep.length} note${keep.length === 1 ? '' : 's'} from your files. I use them as background, never as instructions.` } };
    }
    if (method === 'POST' && path === '/setup/inbox') {
      const days = b.days === undefined ? 30 : Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 730) return err(400, 'bad_days', 'Pick how many days back to read: 1 to 730.');
      if (b.confirmed !== true) return err(409, 'confirm_needed', `${estimate(days).text} Send confirmed: true to start.`);
      if (this.inbox.state === 'running' || this.inbox.state === 'stopping') return err(409, 'already_running', 'I’m already reading your email. Watch it here, or stop it.');
      if (!this.emailConnected()) return err(409, 'no_email', 'Connect Gmail or Outlook first, then I can learn from your email.');
      this.inbox = { ...this.inbox, id: `inbox_${++this.n}`, state: 'running', days, startedAt: this.clock(), endedAt: null, log: [`Reading your last ${days} days of email…`, 'Found 46 unique Gmail messages after collapsing duplicates. Learning from them…'], learned: [], learnedCount: 0, emails: null, message: 'Reading your email…', estimate: estimate(days) };
      return { status: 202, body: { scan: this.inboxView(), message: 'I’m reading your email now. This page shows how it goes.' } };
    }
    if (method === 'POST' && path === '/setup/inbox/stop') {
      if (this.inbox.state !== 'running') return err(409, 'not_running', 'Nothing is being read right now.');
      this.inbox.state = 'stopping'; this.inbox.message = 'Stopping after this round…';
      return { status: 200, body: { scan: this.inboxView(), message: 'Stopping after this round. What I learned so far is kept.' } };
    }
    if (method === 'POST' && (m = /^\/setup\/cards\/([^/]+)\/(submit|cancel)$/.exec(path))) {
      const c = this.cards.find((x) => x.id === decodeURIComponent(m![1]));
      if (!c) return err(404, 'not_found', 'That setup card is gone — ask me to connect it again.');
      if (c.state !== 'waiting') return err(409, 'not_waiting', `That setup card is already ${c.state}.`);
      if (m[2] === 'cancel') { c.state = 'cancelled'; c.message = 'You closed the setup card.'; return { status: 200, body: { card: c, message: 'Closed. I’ll tell the conversation it wasn’t filled in.' } }; }
      const values = (b.values && typeof b.values === 'object' ? b.values : {}) as Record<string, unknown>;
      for (const f of c.fields) if (!f.optional && !String(values[f.name] ?? '').trim()) return err(400, 'check_failed', `${f.label} is needed.`);
      if (Object.values(values).some((v) => /bad/i.test(String(v)))) return err(400, 'check_failed', 'Telegram didn’t accept that token (401 Unauthorized). Check it and try again.');
      c.state = 'done'; c.message = c.vault ? `Saved to the vault as "barn-bookings" for ${c.vault.site}.` : `${c.name} is connected.`;
      return { status: 200, body: { card: c, message: c.message } };
    }
    if (method === 'PUT' && path === '/setup/storage') {
      if (b.confirmed !== true) return err(409, 'confirm_needed', `Keep memory on ${b.kind === 'postgres' ? 'a database server' : 'this computer'} from the next restart? Send confirmed: true to go ahead.`);
      if (b.kind === 'sqlite') {
        this.storage = { ...this.storage, next: 'sqlite', restartNeeded: this.storage.running !== 'sqlite', nextServer: null };
        return { status: 200, body: { storage: this.storage, message: 'Memory will be kept privately on this computer. It takes effect when your helper restarts. What is in a database server stays there.' } };
      }
      if (b.kind !== 'postgres') return err(400, 'bad_kind', 'Pick this computer or a database server.');
      const url = typeof b.url === 'string' ? b.url.trim() : '';
      let host = '';
      try { host = new URL(url).hostname; } catch { host = ''; }
      if (!/^postgres(ql)?:\/\//i.test(url) || !host) return err(400, 'bad_url', 'Enter a Postgres connection address, like postgres://user:password@host:5432/database.');
      if (/bad/i.test(url)) return err(400, 'check_failed', 'I couldn’t connect to that database: connection refused. Check the address and password, and that the pgvector extension is available.');
      this.storage = { ...this.storage, next: 'postgres', restartNeeded: true, nextServer: host };
      return { status: 200, body: { storage: this.storage, message: `Connected. Your database server (${host}) becomes the memory store when your helper restarts.${b.bringMemory === true ? ' Your memory was copied over (imported 214 memories).' : ' Your memory on this computer stays where it is; it isn’t copied.'}` } };
    }
    return null;
  }
}
