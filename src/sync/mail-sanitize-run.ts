/**
 * The reader's sanitiser with a time budget (review of A8). sanitizeMail is linear by design, but a body is hostile
 * input and the server's event loop serves everyone, so the conversion runs in a worker thread: if it is not done
 * within the budget (2 s by default, counted from when the worker is ready, not from its start-up), the thread is
 * terminated and the reader falls back to the message's plain-text part, or to a short note saying the email is too
 * complex to show safely here.
 *
 * Built code runs the compiled .js worker. Running from source (tsx, vitest) the worker starts with a one-line
 * bootstrap that loads the .ts worker through tsx's tsImport (`--import tsx` does not reach a worker started under
 * vitest). If a worker cannot start at all, the sanitiser runs inline (it is still linear; the budget is the backstop);
 * a worker that dies WHILE converting a body is never retried inline.
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { sanitizeMail, type SanitizedBody } from './mail-sanitize.js';

export const SANITIZE_BUDGET_MS = 2_000;
const START_TIMEOUT_MS = 20_000;

export interface SafeSanitized extends SanitizedBody { tooComplex: boolean }

function startWorker(): Worker {
  if (!import.meta.url.endsWith('.ts')) return new Worker(new URL('./mail-sanitize-worker.js', import.meta.url));
  const worker = new URL('./mail-sanitize-worker.ts', import.meta.url).href;
  const api = createRequire(import.meta.url).resolve('tsx/esm/api');
  return new Worker(`require(${JSON.stringify(api)}).tsImport(${JSON.stringify(worker)}, ${JSON.stringify(worker)}).catch((e) => { throw e; });`, { eval: true });
}

type Outcome = { kind: 'done'; body: SanitizedBody } | { kind: 'timeout' } | { kind: 'no-worker' } | { kind: 'error' };

/** Run sanitizeMail in a worker with `budgetMs` for the work itself. */
function inWorker(input: { html: string | null; text: string | null }, budgetMs: number, maxBytes?: number, testDelayMs?: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let w: Worker;
    try { w = startWorker(); } catch { resolve({ kind: 'no-worker' }); return; }
    let settled = false, working = false, timer: NodeJS.Timeout | null = null;
    const finish = (o: Outcome) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); void w.terminate().catch(() => {}); resolve(o); };
    timer = setTimeout(() => finish({ kind: 'no-worker' }), START_TIMEOUT_MS);
    w.on('message', (m: unknown) => {
      if (m === 'ready') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish({ kind: 'timeout' }), budgetMs);
        working = true;
        w.postMessage({ html: input.html, text: input.text, maxBytes, testDelayMs });
        return;
      }
      const r = m as { ok: boolean; body?: SanitizedBody };
      finish(r.ok && r.body ? { kind: 'done', body: r.body } : { kind: 'error' });
    });
    // dying while working on this body (out of memory…) is the body's fault: never retried inline
    w.on('error', () => finish(working ? { kind: 'error' } : { kind: 'no-worker' }));
    w.on('exit', () => finish(working ? { kind: 'error' } : { kind: 'no-worker' }));
  });
}

export function tooComplexNote(label: string): string {
  return `This email is too complex to show safely here. Open it in ${label} to read it.`;
}

/** Sanitise a body with a time budget; never throws, never blocks the event loop for long. */
export async function sanitizeMailSafe(input: { html: string | null; text: string | null }, o: { label: string; budgetMs?: number; maxBytes?: number; inline?: boolean; testDelayMs?: number }): Promise<SafeSanitized> {
  if (o.inline) return { ...sanitizeMail(input, { maxBytes: o.maxBytes }), tooComplex: false };
  const r = await inWorker(input, o.budgetMs ?? SANITIZE_BUDGET_MS, o.maxBytes, o.testDelayMs);
  if (r.kind === 'done') return { ...r.body, tooComplex: false };
  if (r.kind === 'no-worker') return { ...sanitizeMail(input, { maxBytes: o.maxBytes }), tooComplex: false };
  // timed out (or failed): the plain-text part, if there is one, through the same budget; else a short note
  if (input.html && input.text && input.text.trim()) {
    const t = await inWorker({ html: null, text: input.text }, o.budgetMs ?? SANITIZE_BUDGET_MS, o.maxBytes);
    if (t.kind === 'done') return { ...t.body, tooComplex: true };
  }
  return { text: tooComplexNote(o.label), truncated: true, quotedLinesHidden: 0, imagesHidden: 0, trackersRemoved: 0, tooComplex: true };
}
