/**
 * Adding files to an ask (v2 build, slice W4; on the v1 upload since W5).
 *
 * POST /api/v1/files (act scope, Idempotency-Key, in api/openapi.yaml): the body is the file, `name` and `projectId`
 * in the query; it answers {path, name, pages…} with a workspace path that POST /ask takes in `files`, saved in that
 * project's folder (serve/p-<id>/uploads), so it shows in the project's Files tab. A paired phone may add files like
 * the computer; a device without `act` is told so in the server's words.
 *
 * Fixture mode never touches the network: a file "uploads" to `fixtures/uploads/<name>`, which the fixture server
 * counts by name (the prototype's two eventing PDFs are 76 and 73 pages; anything else 40).
 */
import { MwaClient, ApiError, NetworkError, SignInRequired } from '../../api/client';

export interface Uploaded { name: string; path: string }
export type UploadResult = { ok: true; file: Uploaded } | { ok: false; message: string };

export const MAX_FILES = 10;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function uploadFile(file: File, o: { projectId: string | null; fixtures: boolean; fetch?: typeof fetch; client?: MwaClient }): Promise<UploadResult> {
  const name = file.name || 'file';
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: `${name} is too big to add here: the limit is 25 MB.` };
  if (o.fixtures) return { ok: true, file: { name, path: `fixtures/uploads/${name}` } };
  const client = o.client ?? new MwaClient(o.fetch ? { fetch: o.fetch } : {});
  try {
    const r = await client.uploadFile(file, { name, projectId: o.projectId ?? 'general' });
    return { ok: true, file: { name: r.name, path: r.path } };
  } catch (e) {
    if (e instanceof SignInRequired) return { ok: false, message: 'Sign in again to add files.' };
    if (e instanceof NetworkError) return { ok: false, message: 'Can’t reach your helper to add files right now.' };
    if (e instanceof ApiError) return { ok: false, message: `${name}: ${e.message}` };
    return { ok: false, message: `${name} couldn’t be added. Try again.` };
  }
}
