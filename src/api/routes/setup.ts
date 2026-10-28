/**
 * Getting the helper going, for the v2 app (v2 build, slice S6). The same logic as the classic routes
 * (src/setup-flow.ts, which serve.ts /api/setup/warm, /api/onboard/*, /api/ingest, /api/setup/* and /api/save
 * which: 'backend' also call), as routes:
 *
 *   GET  /setup                       whether the AI brain works (and what is missing when it doesn't), where memory is
 *                                     kept, the inbox scan, how many setup cards wait (read)
 *   POST /setup/warm                  get the local memory models ready (the first time downloads them) (admin)
 *   POST /setup/folder/scan           read one folder into notes to look over; it must pass Your assistant's folder
 *                                     rules; nothing is saved or granted (admin)
 *   POST /setup/folder/save           keep some of those notes (edits allowed); they stay notes from your files
 *                                     (untrusted) (admin)
 *   GET  /setup/inbox                 "Get to know me": how the inbox scan is going, what it learned (read)
 *   POST /setup/inbox                 start it (admin); it costs money, so without confirmed: true the answer is 409
 *                                     confirm_needed with what it may cost and take
 *   POST /setup/inbox/stop            stop it between rounds; what it learned is kept (admin)
 *   GET  /setup/cards                 setup cards: a password or key your helper asked for mid-task (read; never a
 *                                     value)
 *   POST /setup/cards/{id}/submit     fill one (admin): the values are checked, saved, and never come back
 *   POST /setup/cards/{id}/cancel     close one without filling it (approve: saying no needs no admin)
 *   PUT  /setup/storage               where memory is kept: this computer or a Postgres server (admin); it asks first
 *                                     (confirmed: true) and takes effect at the restart; the address never comes back
 *
 * Why a card needs admin to fill: what it saves is a credential in the helper's .env (a Gmail app password, a bot
 * token, a plug-in's key) or a login in the vault, which the classic page (src/api/legacy.ts) and Settings ›
 * Connections, Plug-ins and Saved logins keep for admin. A paired phone sees the card and can close it.
 */
import { ApiError, type Route } from '../router.js';
import {
  brainState, storageView, inboxScanView, setupCardsView, warmMemory, scanFolder, saveFolderNotes, startInboxScan,
  stopInboxScan, submitCard, cancelCard, saveStorage, inboxEstimate, FOLDER_NOTE, type Outcome,
} from '../../setup-flow.js';
import { logger } from '../../logger.js';

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const STATUS: Record<string, number> = {
  not_found: 404, confirm_needed: 409, already_running: 409, no_email: 409, busy: 409, not_running: 409, not_waiting: 409,
  scan_expired: 409, fixed: 409, failed: 409,
};
/** A refusal that may pass on a retry (the network, a busy helper, a failed check) is not remembered against the key. */
const TRANSIENT = new Set(['busy', 'check_failed', 'copy_failed', 'unavailable', 'unreadable']);
function refuse(o: { ok: false; code: string; message: string }): never {
  throw new ApiError(STATUS[o.code] ?? 400, o.code, o.message, TRANSIENT.has(o.code));
}
const isAdmin = (who: { scopes: Set<string> } | null) => !!who?.scopes.has('admin');

function setupState(admin: boolean) {
  const cards = setupCardsView();
  return {
    brain: brainState(),
    storage: storageView(admin),
    inbox: inboxScanView(),
    folderNote: FOLDER_NOTE,
    cardsWaiting: cards.filter((c) => c.state === 'waiting').length,
  };
}

export const setupRoutes: Route[] = [
  { method: 'GET', path: '/setup', scope: 'read', handler: ({ who }) => ({ body: setupState(isAdmin(who)) }) },
  {
    method: 'POST', path: '/setup/warm', scope: 'admin',
    handler: async () => {
      const r = await warmMemory();
      if (!r.ready) throw new ApiError(503, 'unavailable', r.message, true);
      return { body: r };
    },
  },
  {
    method: 'POST', path: '/setup/folder/scan', scope: 'admin',
    handler: async ({ body }) => {
      const r = await scanFolder(bodyOf(body).path);
      if (!r.ok) refuse(r);
      logger.info('setup', 'folder read for warm-up', { files: r.scan.filesScanned, notes: r.scan.candidates.length });
      const s = r.scan;
      return {
        body: {
          scanId: s.id, folder: s.folder, filesScanned: s.filesScanned, truncated: s.truncated, message: r.message,
          notes: s.candidates.map((c) => ({ id: c.id, name: c.concept, text: c.content, source: c.source })),
        },
      };
    },
  },
  {
    method: 'POST', path: '/setup/folder/save', scope: 'admin',
    handler: async ({ body }) => {
      const b = bodyOf(body);
      const r = await saveFolderNotes(b.scanId, b.keep);
      if (!r.ok) refuse(r);
      logger.info('setup', 'folder notes saved', { saved: r.saved });
      return { body: { saved: r.saved, message: r.message } };
    },
  },
  { method: 'GET', path: '/setup/inbox', scope: 'read', handler: () => ({ body: inboxScanView() }) },
  {
    method: 'POST', path: '/setup/inbox', scope: 'admin',
    handler: ({ body }) => {
      const b = bodyOf(body);
      const days = b.days === undefined ? 30 : Number(b.days);
      if (b.confirmed !== true) {
        const e = Number.isInteger(days) && days >= 1 && days <= 730 ? inboxEstimate(days) : inboxEstimate(30);
        throw new ApiError(409, 'confirm_needed', `${e.text} Send confirmed: true to start.`);
      }
      const r = startInboxScan({ days: b.days });
      if (!r.ok) refuse(r);
      logger.info('setup', 'inbox scan started', { days });
      return { status: 202, body: { scan: r.scan, message: r.message } };
    },
  },
  {
    method: 'POST', path: '/setup/inbox/stop', scope: 'admin',
    handler: () => {
      const r = stopInboxScan();
      if (!r.ok) refuse(r);
      return { body: { scan: r.scan, message: r.message } };
    },
  },
  { method: 'GET', path: '/setup/cards', scope: 'read', handler: ({ who }) => ({ body: { cards: setupCardsView(), canSubmit: isAdmin(who) } }) },
  {
    method: 'POST', path: '/setup/cards/{id}/submit', scope: 'admin',
    handler: async ({ params, body }) => {
      const values = bodyOf(body).values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ApiError(400, 'bad_value', 'Fill in the card first.');
      const r: Outcome & { found: boolean } = await submitCard(params.id, values);
      const card = setupCardsView().find((c) => c.id === params.id) ?? null;
      if (!r.ok) refuse(r);
      logger.info('setup', 'setup card filled', { id: params.id });
      return { body: { card, message: r.message } };
    },
  },
  {
    method: 'POST', path: '/setup/cards/{id}/cancel', scope: 'approve',
    handler: ({ params }) => {
      const r = cancelCard(params.id);
      if (!r.ok) refuse(r);
      return { body: { card: setupCardsView().find((c) => c.id === params.id) ?? null, message: r.message } };
    },
  },
  {
    method: 'PUT', path: '/setup/storage', scope: 'admin',
    handler: async ({ body, who }) => {
      const b = bodyOf(body);
      if (b.confirmed !== true) {
        const to = String(b.kind ?? '') === 'postgres' ? 'a database server' : 'this computer';
        throw new ApiError(409, 'confirm_needed', `Keep memory on ${to} from the next restart?${b.bringMemory === true ? ' Your memory is copied there first.' : ''} Send confirmed: true to go ahead.`);
      }
      const r = await saveStorage({ kind: b.kind, url: b.url, bringMemory: b.bringMemory });
      if (!r.ok) refuse(r);
      logger.info('setup', 'memory storage changed', { kind: b.kind, copied: b.bringMemory === true });
      return { body: { storage: storageView(isAdmin(who)), message: r.message } };
    },
  },
];
