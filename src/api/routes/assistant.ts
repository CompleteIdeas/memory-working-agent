/**
 * The assistant itself, for the v2 app (v2 build, slice S2): its AI brain, the image model, what it can touch and how
 * it works with you. The same save logic as the classic page (src/assistant-settings.ts, which serve.ts /api/save
 * also calls), as routes:
 *
 *   GET  /assistant                  the brain, the image model, the providers (whether a key is saved for each,
 *                                    never the key), the access level and granted folders, the style, and whether
 *                                    "add from npm" is available (it depends on the brain) (read)
 *   POST /assistant/models           a provider's models (chat or image); a key typed now is used for this listing
 *                                    only; each chat model says whether adding plug-ins from npm stays available (admin)
 *   PUT  /assistant/brain            check provider + model live with the key, then save them (admin)
 *   PUT  /assistant/image            set the image model (admin) · DELETE /assistant/image turns it off (admin)
 *   PUT  /assistant/access           the access level: locked-down, assistant or developer (admin)
 *   POST /assistant/folders          grant one more folder (admin) · POST /assistant/folders/remove un-grants one (admin)
 *   PUT  /assistant/style            Guided or Direct (admin)
 *
 * Every change takes effect on the next message. Key values go in, never out.
 */
import { ApiError, type Route } from '../router.js';
import {
  assistantState, saveBrain, saveImage, saveAccess, saveStyle, modelChoices, folderProblem, samePath, type Outcome,
} from '../../assistant-settings.js';
import { accessPolicy } from '../../tools/access.js';
import { isHosted, hostName } from '../../hosting.js';
import { externalView, APPLIES } from './plugins.js';
import { logger } from '../../logger.js';
import { resolve } from 'node:path';

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const STATUS: Record<string, number> = { fixed: 409, check_failed: 400 };

export function assistantView() {
  const s = assistantState();
  return { ...s, access: { ...s.access, hosted: isHosted(), host: hostName() }, addFromNpm: externalView(), applies: APPLIES };
}

/** An outcome as a reply, or its refusal as an ApiError. A failed live check may pass on a retry (the network, a
 *  provider hiccup), so it is not remembered against the Idempotency-Key. */
function done(o: Outcome, extra = ''): { body: { assistant: ReturnType<typeof assistantView>; message: string } } {
  if (!o.ok) throw new ApiError(STATUS[o.code] ?? 400, o.code, o.message, o.code === 'check_failed');
  return { body: { assistant: assistantView(), message: `${o.message}${extra}` } };
}

/** What changed for "add from npm" when the brain changed, in words (empty when nothing did). */
function npmChange(before: boolean): string {
  const after = externalView();
  if (after.available === before) return '';
  return after.available ? ' Adding plug-ins from npm is available now.' : ' Adding plug-ins from npm is off now: it needs a stronger model to check them.';
}

export const assistantRoutes: Route[] = [
  { method: 'GET', path: '/assistant', scope: 'read', handler: () => ({ body: assistantView() }) },
  {
    method: 'POST', path: '/assistant/models', scope: 'admin',
    handler: async ({ body }) => {
      const r = await modelChoices(bodyOf(body));
      if (!r.ok) throw new ApiError(400, r.code, r.message);
      return { body: { provider: r.provider, kind: r.kind, models: r.models } };
    },
  },
  {
    method: 'PUT', path: '/assistant/brain', scope: 'admin',
    handler: async ({ body }) => {
      const b = bodyOf(body);
      const before = externalView().available;
      const o = await saveBrain({ provider: b.provider, model: b.model, key: b.key, baseUrl: b.baseUrl });
      if (o.ok) logger.info('assistant', 'brain changed', { provider: b.provider, model: b.model, keyGiven: !!b.key });
      return done(o, o.ok ? `${npmChange(before)} ${APPLIES}` : '');
    },
  },
  {
    method: 'PUT', path: '/assistant/image', scope: 'admin',
    handler: async ({ body }) => {
      const b = bodyOf(body);
      if (typeof b.model !== 'string' || !b.model.trim()) throw new ApiError(400, 'bad_model', 'Pick an image model first, or turn image generation off.');
      const o = await saveImage({ provider: b.provider, model: b.model, key: b.key, baseUrl: b.baseUrl });
      if (o.ok) logger.info('assistant', 'image model changed', { provider: b.provider, model: b.model, keyGiven: !!b.key });
      return done(o, o.ok ? ` ${APPLIES}` : '');
    },
  },
  {
    method: 'DELETE', path: '/assistant/image', scope: 'admin',
    handler: async () => done(await saveImage({ model: '' })),
  },
  {
    method: 'PUT', path: '/assistant/access', scope: 'admin',
    handler: ({ body }) => {
      const o = saveAccess(bodyOf(body).preset);
      if (o.ok) logger.info('assistant', 'access level changed', { preset: bodyOf(body).preset });
      return done(o, o.ok ? ` ${APPLIES}` : '');
    },
  },
  {
    method: 'POST', path: '/assistant/folders', scope: 'admin',
    handler: ({ body }) => {
      const path = bodyOf(body).path;
      if (typeof path !== 'string') throw new ApiError(400, 'bad_folder', 'Type the folder’s full path.');
      const p = path.trim();
      const pol = accessPolicy();
      if (pol.grantedRoots.some((f) => samePath(f, p))) return { body: { assistant: assistantView(), message: 'That folder is already granted.' } };
      // the v1 path refuses a folder outright (the classic one saves the rest and lists what it left out)
      const problem = folderProblem(p);
      if (problem) throw new ApiError(400, problem.code, problem.message);
      const o = saveAccess(pol.preset, [...pol.grantedRoots, p]);
      if (o.ok && o.dropped?.some((d) => d.path === p)) throw new ApiError(400, o.dropped.find((d) => d.path === p)!.code, o.dropped.find((d) => d.path === p)!.message);
      if (o.ok) logger.info('assistant', 'folder granted', { path: resolve(p) });
      return done(o.ok ? { ok: true, message: pol.preset === 'locked-down' ? 'Granted. It’s used once you pick Assistant or Developer.' : `Granted. ${APPLIES}` } : o);
    },
  },
  {
    method: 'POST', path: '/assistant/folders/remove', scope: 'admin',
    handler: ({ body }) => {
      const path = bodyOf(body).path;
      const pol = accessPolicy();
      const match = typeof path === 'string' ? pol.grantedRoots.find((f) => f === path) ?? pol.grantedRoots.find((f) => samePath(f, path)) : undefined;
      if (match === undefined) throw new ApiError(404, 'not_granted', 'That folder isn’t granted, or it was already removed.');
      const o = saveAccess(pol.preset, pol.grantedRoots.filter((f) => f !== match));
      if (o.ok) logger.info('assistant', 'folder removed', { path });
      return done(o.ok ? { ok: true, message: `Removed. ${APPLIES}` } : o);
    },
  },
  {
    method: 'PUT', path: '/assistant/style', scope: 'admin',
    handler: ({ body }) => done(saveStyle(bodyOf(body).style)),
  },
];
