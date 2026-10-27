/**
 * How a helper's answer is shown (v2 build, W4 review): plain text only, links as their host, and — when the answer
 * read someone else's words (`tainted`: an email, a web page, a file) — a label that says so. Shared by the Ask flow,
 * a project's thread and "Ask about this"; W3's screens use it too.
 *
 *   <AnswerText text={turn.reply} tainted={turn.tainted} />
 *
 * The text rules are the mail sanitiser's (src/v2/mail-text.ts: cleanText + linksToHosts), kept client side in
 * store/text.ts (shared with W3's screens; tests check them against the server's).
 * React escapes the text, nothing is auto-linked, and `[label](javascript:…)` stays inert words.
 */
import type { ReactNode } from 'react';
import { cleanText, linksToHosts } from '../../store/text';

export const TAINTED_NOTE = 'Based on outside content — check before acting';

/** An answer's words as they are shown: cleaned, links as hosts. */
export function answerWords(text: string | null | undefined): string {
  return linksToHosts(cleanText(String(text ?? '')));
}

/** The tainted label, on its own (for places that lay the answer out themselves). `note`: other words for it (the mail
 *  reader: "Based on what the email says — check before acting"). */
export function TaintedNote({ note = TAINTED_NOTE }: { note?: string }) {
  return (
    <p className="taintnote" role="note">
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" /><path d="M12 10v4M12 17v.5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" /></svg>
      {note}
    </p>
  );
}

/** An answer: the tainted label first (when it read outside content), then its words, links as hosts. */
export function AnswerText({ text, tainted, lead, note }: { text: string | null | undefined; tainted?: boolean | null; lead?: ReactNode; note?: string }) {
  return (
    <>
      {tainted ? <TaintedNote note={note} /> : null}
      <span className="answertext">{lead}{answerWords(text)}</span>
    </>
  );
}
