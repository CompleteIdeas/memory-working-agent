/**
 * Worker thread for the mail sanitiser (slice A8): runs sanitizeMail off the main event loop, so a body that is
 * somehow slow to convert can be abandoned (mail-sanitize-run.ts terminates the thread at its time budget).
 * Protocol: posts 'ready' once loaded; then answers each {html, text, maxBytes} with {ok, body} or {ok: false, error}.
 */
import { parentPort } from 'node:worker_threads';
import { sanitizeMail } from './mail-sanitize.js';

const port = parentPort;
if (port) {
  port.on('message', (m: { html?: string | null; text?: string | null; maxBytes?: number; testDelayMs?: number }) => {
    // tests only: a body that takes this long (the budget's fallback is otherwise hard to provoke)
    if (m.testDelayMs) { const until = Date.now() + m.testDelayMs; while (Date.now() < until) { /* busy */ } }
    try { port.postMessage({ ok: true, body: sanitizeMail({ html: m.html, text: m.text }, { maxBytes: m.maxBytes }) }); }
    catch (e) { port.postMessage({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
  });
  port.postMessage('ready');
}
