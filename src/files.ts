/**
 * BL-70 — the person's files. Everything MWA writes lands under the workspace (a chat's folder
 * serve/<session>, a scheduled job's run folder, the mailbox outbox), and until now nothing served it:
 * a chat reply linked "ai-newsletter-research.md" and the link went nowhere. This lists, serves,
 * accepts and deletes files under that one root, and nowhere else.
 */
import { readdirSync, statSync, realpathSync, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join, relative, sep, extname, basename } from 'node:path';

export interface FileRow { path: string; size: number; mtime: number; }

/** Biggest upload accepted, in bytes. */
export const MAX_UPLOAD = Number(process.env.MWA_MAX_UPLOAD_MB ?? 25) * 1024 * 1024;
const MAX_LIST = 1000;

/** A chat session's folder, relative to the workspace: the same name serve gives its run dir. */
export function sessionFolder(session: string): string {
  return `serve/${session.replace(/[^a-z0-9_-]/gi, '')}`;
}

/** Resolve a workspace-relative path to an absolute one inside the root, or null. Symlinks are
 *  followed before the check, so a link inside the workspace can't hand out a file outside it. */
export function insideRoot(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  // dot-files and dot-folders are MWA's own bookkeeping (the share list among them), not the person's files
  if (rel.split(/[/\\]/).some((seg) => seg.startsWith('.') && seg !== '.')) return null;
  const base = resolve(root);
  const abs = resolve(base, rel.replace(/^[/\\]+/, ''));
  const within = (p: string, b: string) => p === b || p.startsWith(b.endsWith(sep) ? b : b + sep);
  if (!within(abs, base)) return null;
  if (existsSync(abs)) {
    try { if (!within(realpathSync(abs), realpathSync(base))) return null; } catch { return null; }
  }
  return abs;
}

/** Every file under the root, newest first. Dot-files and dot-folders are left out. */
export function listFiles(root: string): FileRow[] {
  const base = resolve(root);
  const out: FileRow[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const abs = join(dir, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (st.isFile()) out.push({ path: relative(base, abs).split(sep).join('/'), size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(base, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_LIST);
}

const INLINE: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
};
const TEXT = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.log', '.yaml', '.yml', '.xml', '.ics', '.eml', '.html', '.htm', '.svg', '.js', '.ts', '.py', '.sql', '.css']);

/** The headers a file is served with. Anything that could run script (HTML, SVG) goes out as plain
 *  text: these files are written by a model that reads the web, and they are served on the app's own
 *  origin, next to the session cookie. Every response is also sandboxed by CSP. */
export function fileHeaders(name: string, size: number, download: boolean): Record<string, string> {
  const ext = extname(name).toLowerCase();
  const type = INLINE[ext] ?? (TEXT.has(ext) || !ext ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  const safe = basename(name).replace(/["\\\r\n]/g, '_');
  return {
    'content-type': type,
    'content-length': String(size),
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(basename(name))}`,
    'x-content-type-options': 'nosniff',
    // A browser's PDF viewer does not load under a sandbox, so a PDF gets the rest of the policy only.
    'content-security-policy': `${type === 'application/pdf' ? '' : 'sandbox; '}default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; object-src 'self'`,
    'cache-control': 'private, no-store',
  };
}

/** A safe file name for an upload: no folders, no leading dots, nothing odd. */
export function cleanName(name: string): string {
  const n = basename(String(name).replace(/\\/g, '/')).replace(/[^\w.\- ()]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120);
  return n || 'upload';
}

/** Save an upload into <folder> under the root, never over an existing file. Returns its relative path. */
export function saveUpload(root: string, folder: string, name: string, body: Buffer): string {
  const dir = insideRoot(root, folder);
  if (!dir) throw new Error('bad folder');
  mkdirSync(dir, { recursive: true });
  const clean = cleanName(name);
  const ext = extname(clean), stem = clean.slice(0, clean.length - ext.length);
  let target = join(dir, clean);
  for (let i = 2; existsSync(target); i++) target = join(dir, `${stem} (${i})${ext}`);
  writeFileSync(target, body);
  return relative(resolve(root), target).split(sep).join('/');
}

/** Delete one file under the root. Folders are never deleted; an emptied chat folder stays. */
export function deleteFile(root: string, rel: string): boolean {
  const abs = insideRoot(root, rel);
  if (!abs || abs === resolve(root) || !existsSync(abs) || !statSync(abs).isFile()) return false;
  rmSync(abs);
  return true;
}

/** Files the person added to a chat, for the run's instruction. */
export function uploadsIn(root: string, folder: string): string[] {
  const dir = insideRoot(root, `${folder}/uploads`);
  if (!dir) return [];
  try { return readdirSync(dir).filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isFile()).map((n) => `uploads/${n}`); } catch { return []; }
}

/** A share link: anyone holding the token can open that one file until it expires or is revoked. */
export interface Share { token: string; path: string; created: number; expires: number; }
const sharesFile = (root: string) => join(resolve(root), '.shares.json');

export function readShares(root: string, now = Date.now()): Share[] {
  try { return (JSON.parse(readFileSync(sharesFile(root), 'utf8')) as Share[]).filter((s) => s.expires > now); } catch { return []; }
}
function writeShares(root: string, shares: Share[]): void {
  mkdirSync(resolve(root), { recursive: true });
  const f = sharesFile(root), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(shares, null, 1));
  renameSync(tmp, f);
}
export function createShare(root: string, path: string, days: number, now = Date.now()): Share | null {
  const abs = insideRoot(root, path);
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return null;
  const share = { token: randomBytes(18).toString('base64url'), path, created: now, expires: now + Math.min(Math.max(days, 1), 90) * 86_400_000 };
  writeShares(root, [...readShares(root, now), share]);
  return share;
}
export function revokeShare(root: string, token: string): boolean {
  const all = readShares(root);
  const kept = all.filter((s) => s.token !== token);
  if (kept.length === all.length) return false;
  writeShares(root, kept);
  return true;
}
/** The file a live token opens, or null. */
export function shareFor(root: string, token: string, now = Date.now()): { share: Share; abs: string } | null {
  const share = readShares(root, now).find((s) => s.token === token);
  const abs = share && insideRoot(root, share.path);
  return share && abs && existsSync(abs) && statSync(abs).isFile() ? { share, abs } : null;
}
