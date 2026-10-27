/**
 * Adding files to an ask (v2 build, slice W4).
 *
 * /api/v1 has no upload yet, so this posts to the legacy `/api/files/upload` (the v1 app's route): the body is the
 * file, `name` and `session` in the query; it answers `{ok, path}` with a workspace path that POST /ask takes in
 * `files`. `session=p-<project id>` puts the file in that project's folder (serve/p-<id>/uploads), so it shows in the
 * project's Files tab.
 *
 * TODO(v1 upload): the legacy route is behind the password session cookie (mwa_session) only. A browser signed in
 * with the password, or the helper's own machine with no password set, can add files; a paired device (mwa_device
 * cookie or a bearer token) gets 401 here and is told so in plain words. Replace with an /api/v1 upload operation
 * (device-scoped, Idempotency-Key, in api/openapi.yaml) when one is added.
 *
 * Fixture mode never touches the network: a file "uploads" to `fixtures/uploads/<name>`, which the fixture server
 * counts by name (the prototype's two eventing PDFs are 76 and 73 pages; anything else 40).
 */
export interface Uploaded { name: string; path: string }
export type UploadResult = { ok: true; file: Uploaded } | { ok: false; message: string };

export const MAX_FILES = 10;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function uploadFile(file: File, o: { projectId: string | null; fixtures: boolean; fetch?: typeof fetch }): Promise<UploadResult> {
  const name = file.name || 'file';
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: `${name} is too big to add here: the limit is 25 MB.` };
  if (o.fixtures) return { ok: true, file: { name, path: `fixtures/uploads/${name}` } };
  const session = `p-${o.projectId ?? 'general'}`;
  const f = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  try {
    const r = await f(`/api/files/upload?session=${encodeURIComponent(session)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: file, credentials: 'same-origin' });
    if (r.status === 401) return { ok: false, message: 'Adding files needs your password sign-in on this device for now. Paired phones get files in a later update.' };
    const body = await r.json().catch(() => null) as { ok?: boolean; path?: string; message?: string } | null;
    if (!r.ok || !body?.ok || !body.path) return { ok: false, message: body?.message ? `${name}: ${body.message}` : `${name} couldn’t be added. Try again.` };
    return { ok: true, file: { name, path: body.path } };
  } catch {
    return { ok: false, message: 'Can’t reach your helper to add files right now.' };
  }
}
