/**
 * Files for the v2 app (v2 build, slice W5): add a file to a project (for an ask), and list a project's added files.
 *
 *   POST /files?projectId=&name=   (act) the body is the file itself (any content type but multipart), or
 *                                  multipart/form-data with one file part. Capped at MWA_MAX_UPLOAD_MB (25 MB).
 *                                  Saved under the project's folder (`serve/p-<id>/uploads`, General when no project
 *                                  is given) with a cleaned name, never over another file. Answers
 *                                  {id, path, name, size, projectId, pages} — `path` goes straight into /ask `files`.
 *   GET  /files?projectId=         (read) the files added to that project, newest first.
 *
 * Replaces the legacy /api/files/upload for the v2 app, which (until W5) had no caller check at all without a
 * password. The name is never trusted: no folders, no leading dots, nothing odd (files.ts cleanName), and the folder
 * comes from the project's id, which must be an existing project.
 */
import { basename } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { ApiError, type Route } from '../router.js';
import { projectRouteDeps } from './projects.js';
import { getProject, sessionOf, GENERAL } from '../../v2/projects.js';
import { cleanName, insideRoot, listFiles, saveUpload, sessionFolder, MAX_UPLOAD } from '../../files.js';
import { documentSize } from '../../tools/builtins.js';

const MULTIPART_SLACK = 64 * 1024; // the part headers and boundaries around the file
const COUNT_TIMEOUT_MS = 5_000;
const tooLarge = () => `That file is too big. The limit is ${Math.round(MAX_UPLOAD / 1048576)} MB.`;

function root(): string {
  const d = projectRouteDeps();
  if (!d) throw new ApiError(503, 'unavailable', 'Files are not available on this server.', true);
  return d.workspace();
}
function projectOf(raw: string | null) {
  const id = (raw ?? '').trim() || GENERAL;
  const p = getProject(id);
  if (!p) throw new ApiError(404, 'not_found', 'No such project.');
  return p;
}
const uploadsFolder = (projectId: string) => `${sessionFolder(sessionOf(projectId))}/uploads`;

/** The first file part of a multipart/form-data body: its file name and bytes. Null when there is none. */
export function firstFilePart(raw: Buffer, contentType: string): { filename: string; data: Buffer } | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary || boundary.length > 200) return null;
  const delim = Buffer.from(`--${boundary}`);
  let at = raw.indexOf(delim);
  while (at !== -1) {
    const start = at + delim.length;
    if (raw.slice(start, start + 2).toString() === '--') return null; // the closing boundary
    const headEnd = raw.indexOf('\r\n\r\n', start);
    if (headEnd === -1) return null;
    const head = raw.slice(start, headEnd).toString('utf8');
    const next = raw.indexOf(delim, headEnd + 4);
    if (next === -1) return null;
    const fn = /content-disposition:[^\r\n]*\bfilename\*?=(?:UTF-8'')?(?:"([^"]*)"|([^;\r\n]*))/i.exec(head);
    if (fn) {
      let name = fn[1] ?? fn[2] ?? '';
      try { name = decodeURIComponent(name); } catch { /* keep it as sent */ }
      return { filename: name, data: raw.slice(headEnd + 4, next - 2) }; // the part ends with CRLF before the boundary
    }
    at = next;
  }
  return null;
}

/** Pages, counted the way read_document reads them; null when it takes too long or can't be read. */
async function pagesOf(abs: string): Promise<number | null> {
  try {
    const buf = readFileSync(abs);
    return await Promise.race([
      documentSize(abs, buf).then((s) => s.pages).catch(() => null),
      new Promise<null>((r) => { const t = setTimeout(() => r(null), COUNT_TIMEOUT_MS); (t as { unref?: () => void }).unref?.(); }),
    ]);
  } catch { return null; }
}

export const fileRoutes: Route[] = [
  {
    method: 'POST', path: '/files', scope: 'act',
    rawBody: { max: MAX_UPLOAD + MULTIPART_SLACK, tooLarge: tooLarge() },
    handler: async ({ req, url, raw }) => {
      const p = projectOf(url.searchParams.get('projectId'));
      if (p.archived) throw new ApiError(409, 'archived', `${p.name} is archived. Restore it first.`);
      const type = String(req.headers['content-type'] ?? '');
      let name = url.searchParams.get('name') ?? '', data = raw ?? Buffer.alloc(0);
      if (/^multipart\/form-data/i.test(type)) {
        const part = firstFilePart(data, type);
        if (!part) throw new ApiError(400, 'no_file', 'No file came with that. Pick a file and try again.');
        name = name || part.filename; data = part.data;
      }
      if (!name.trim()) throw new ApiError(400, 'no_name', 'Send the file’s name (`name`).');
      if (data.length > MAX_UPLOAD) throw new ApiError(413, 'too_large', tooLarge());
      if (!data.length) throw new ApiError(400, 'empty_file', 'That file is empty.');
      const ws = root();
      let path: string;
      try { path = saveUpload(ws, uploadsFolder(p.id), cleanName(name), data); }
      catch { throw new ApiError(400, 'bad_name', 'That file name can’t be used. Rename the file and try again.'); }
      const abs = insideRoot(ws, path);
      const pages = abs ? await pagesOf(abs) : null;
      return { status: 201, body: { id: path, path, name: basename(path), size: data.length, projectId: p.id, pages } };
    },
  },
  {
    method: 'GET', path: '/files', scope: 'read',
    handler: ({ url }) => {
      const p = projectOf(url.searchParams.get('projectId'));
      const folder = uploadsFolder(p.id);
      const ws = root();
      const abs = insideRoot(ws, folder);
      let files: { id: string; path: string; name: string; size: number; mtime: number }[] = [];
      try {
        if (abs && statSync(abs).isDirectory()) {
          files = listFiles(abs).map((f) => { const path = `${folder}/${f.path}`; return { id: path, path, name: basename(f.path), size: f.size, mtime: f.mtime }; });
        }
      } catch { files = []; }
      return { body: { projectId: p.id, folder, files } };
    },
  },
];
