import type { ReactNode } from 'react';
import { fileUrl } from '../api';

/** Open a file in the viewer (App listens). Ctrl/Cmd-click still opens the raw file in a tab. */
export function openFile(path: string): void { window.dispatchEvent(new CustomEvent('mwa-open-file', { detail: path })); }

/**
 * BL-70: replies are markdown, and the chat showed them as raw text ("**Your angle…**",
 * "[notes](notes.md)"). A small renderer for what replies actually use: headings, lists, paragraphs,
 * code, bold, italic and links. It builds React elements, never HTML, so nothing in a reply can run.
 * A link with no scheme is a file the run wrote: it opens from `folder` through the Files API.
 */
export function Markdown({ text, folder }: { text: string; folder?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push(<pre key={k++} className="mono text-[12.5px] bg-surface border border-line rounded-[3px] p-3 my-2 overflow-x-auto whitespace-pre">{body.join('\n')}</pre>);
      continue;
    }
    // F14 (usability review 2026-10-24): a markdown table showed as raw "| Category | Budget |" lines.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      blocks.push(
        <div key={k++} className="overflow-x-auto my-2" tabIndex={0} role="region" aria-label="table">
          <table className="md-table">
            <thead><tr>{head.map((c, j) => <th key={j} scope="col">{inline(c, folder)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? '', folder)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const size = h[1].length <= 2 ? 'text-[18px]' : 'text-[16px]';
      blocks.push(<div key={k++} className={`${size} font-semibold mt-3 mb-1`}>{inline(h[2], folder)}</div>);
      i++; continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '');
        // a wrapped item continues on indented lines
        for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) item += ' ' + lines[i].trim();
        items.push(item);
      }
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={k++} className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 my-1.5 space-y-1`}>{items.map((t, j) => <li key={j}>{inline(t, folder)}</li>)}</L>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*•]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++} className="my-1.5">{para.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l, folder)}</span>)}</p>);
  }
  return <div className="text-[15.5px] leading-relaxed break-words">{blocks}</div>;
}

/** Where a link in a reply goes: the web as is, a file through the Files API, anything else nowhere. */
export function linkTarget(href: string, folder?: string): { url: string; file: boolean; path?: string } | null {
  const h = href.trim();
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return { url: h, file: false };
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//') || h.startsWith('#') || !folder) return null;
  let path = h.replace(/^\.\//, '');
  try { path = decodeURIComponent(path); } catch { /* keep as written */ }
  // BL-71c: a full server path to another chat's file (/data/mwa-workspace/serve/web-x/notes.md) — keep it from
  // the workspace folder down
  const abs = /^(?:[A-Za-z]:)?[\\/].*?[\\/]((?:serve|scheduled)[\\/].+)$/.exec(path);
  if (abs) path = abs[1].replace(/\\/g, '/');
  // a path written from the workspace root (serve/…, scheduled/…) is used as is
  const full = /^(serve|scheduled|outbox|outputs|done|inbox)\//.test(path) ? path : `${folder}/${path.replace(/^\/+/, '')}`;
  return { url: fileUrl(full), file: true, path: full };
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)<>]+|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))/g;

function inline(text: string, folder?: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of text.matchAll(INLINE)) {
    const t = m[0], at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    last = at + t.length;
    if (t.startsWith('**')) out.push(<strong key={k++}>{inline(t.slice(2, -2), folder)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k++} className="mono text-[13px] bg-surface border border-line rounded-[2px] px-1">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      const to = linkTarget(lm[2], folder);
      out.push(to
        ? <a key={k++} href={to.url} target="_blank" rel="noreferrer" className="text-signal underline" title={to.file ? 'Open this file' : to.url}
            onClick={to.path ? (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); openFile(to.path!); } : undefined}>{lm[1]}{to.file && <span className="mono text-[11px]"> ↗</span>}</a>
        : <span key={k++}>{lm[1]}</span>);
    } else if (/^https?:/i.test(t)) out.push(<a key={k++} href={t} target="_blank" rel="noreferrer" className="text-signal underline break-all">{t}</a>);
    else out.push(<em key={k++}>{inline(t.slice(1, -1), folder)}</em>);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
