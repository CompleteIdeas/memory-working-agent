import { useEffect, useRef, useState } from 'react';
import { fileUrl, exportUrl, getShares, shareFile, unshareFile, shareLink, type FileShare } from '../api';
import { Markdown } from './Markdown';

/**
 * BL-70: see a file without leaving MWA. It opens over the chat, pops out into its own window, and
 * is the read-only page a share link lands on. Download offers the file as it is and, for a
 * document, as Word, PDF or a web page. Sharing makes a link that expires, and can be turned off.
 */
type Src = { kind: 'own'; path: string } | { kind: 'shared'; token: string };

const ext = (n: string) => (/\.[^./]+$/.exec(n.toLowerCase())?.[0] ?? '');
const DOC = ['.md', '.markdown', '.txt'];
const TEXT = ['.csv', '.tsv', '.json', '.jsonl', '.log', '.yaml', '.yml', '.xml', '.ics', '.eml', '.html', '.htm', '.svg', '.js', '.ts', '.py', '.sql', '.css'];
const IMAGE = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const MAX_PREVIEW = 2 * 1024 * 1024;
const FORMAT_LABEL: Record<string, string> = { docx: 'Word (.docx)', pdf: 'PDF', html: 'Web page (.html)' };

export function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function urls(src: Src) {
  if (src.kind === 'own') return { raw: fileUrl(src.path), download: fileUrl(src.path, true), export: (f: string) => exportUrl(src.path, f) };
  const b = `/api/share/${encodeURIComponent(src.token)}`;
  return { raw: `${b}/raw`, download: `${b}/raw?download=1`, export: (f: string) => `${b}/export?format=${f}` };
}

function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; if (rows.length > 500) break; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function Body({ name, size, src }: { name: string; size: number; src: Src }) {
  const e = ext(name), u = urls(src);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const isText = DOC.includes(e) || TEXT.includes(e) || !e;
  useEffect(() => {
    setText(null); setErr('');
    if (!isText || size > MAX_PREVIEW) return;
    fetch(u.raw).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`could not open it (${r.status})`)))).then(setText).catch((x) => setErr(x.message));
  }, [u.raw, isText, size]);
  if (IMAGE.includes(e)) return <img src={u.raw} alt={name} className="max-w-full mx-auto" />;
  if (e === '.pdf') return <iframe src={u.raw} title={name} className="w-full h-[75vh] border border-line bg-white" />;
  if (['.mp3', '.wav'].includes(e)) return <audio src={u.raw} controls className="w-full" />;
  if (e === '.mp4') return <video src={u.raw} controls className="w-full" />;
  if (!isText) return <p className="text-dim">There's no preview for this kind of file. Download it to open it.</p>;
  if (size > MAX_PREVIEW) return <p className="text-dim">This file is too large to preview ({fmtSize(size)}). Download it to open it.</p>;
  if (err) return <p className="mono text-[13px] text-signal">! {err}</p>;
  if (text === null) return <p className="mono text-[13px] text-dim">opening…</p>;
  if (e === '.md' || e === '.markdown') {
    const folder = src.kind === 'own' ? src.path.split('/').slice(0, -1).join('/') : undefined;
    return <Markdown text={text} folder={folder} />;
  }
  if (e === '.csv' || e === '.tsv') {
    const rows = parseCsv(text, e === '.tsv' ? '\t' : ',');
    return (
      <div className="overflow-x-auto"><table className="text-[13px] border-collapse">
        <tbody>{rows.map((r, i) => <tr key={i} className={i === 0 ? 'font-semibold' : ''}>{r.map((c, j) => <td key={j} className="border border-line px-2 py-1 align-top">{c}</td>)}</tr>)}</tbody>
      </table>{rows.length > 500 && <p className="mono text-[11px] text-dim mt-2">first 500 rows — download for the rest</p>}</div>
    );
  }
  return <pre className="mono text-[12.5px] whitespace-pre-wrap break-words">{text}</pre>;
}

function DownloadMenu({ formats, src }: { formats: string[]; src: Src }) {
  const [open, setOpen] = useState(false);
  const u = urls(src);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close);
  }, []);
  if (!formats.length) return <a href={u.download} className={BTN}>download ↓</a>;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className={BTN}>download ▾</button>
      {open && (
        <div className="absolute right-0 mt-1 z-10 min-w-[180px] rounded-[3px] border border-line bg-surface shadow-lg py-1">
          <a href={u.download} onClick={() => setOpen(false)} className={ITEM}>As written (original)</a>
          {['docx', 'pdf', 'html'].filter((f) => formats.includes(f)).map((f) => (
            <a key={f} href={u.export(f)} onClick={() => setOpen(false)} className={ITEM}>{FORMAT_LABEL[f]}</a>
          ))}
        </div>
      )}
    </div>
  );
}

function SharePanel({ path }: { path: string }) {
  const [shares, setShares] = useState<FileShare[]>([]);
  const [days, setDays] = useState(7);
  const [copied, setCopied] = useState('');
  const load = () => getShares(path).then(setShares);
  useEffect(() => { void load(); }, [path]);
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(shareLink(t)); setCopied(t); setTimeout(() => setCopied(''), 1500); } catch { /* the link is shown, so it can be copied by hand */ } };
  return (
    <div className="border border-line rounded-[3px] bg-surface p-3 mb-4 text-[13.5px]">
      <p className="mb-2">Anyone with a share link can open and download this file, without the MWA password, until the link expires or you turn it off.</p>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-[3px] border border-line bg-bone px-2 py-1">
          <option value={1}>for 1 day</option><option value={7}>for 7 days</option><option value={30}>for 30 days</option>
        </select>
        <button onClick={async () => { const r = await shareFile(path, days); if (r.ok && r.share) { await load(); void copy(r.share.token); } }} className={BTN}>make a link</button>
      </div>
      {shares.length > 0 && (
        <ul className="space-y-1.5">
          {shares.map((s) => (
            <li key={s.token} className="flex flex-wrap items-center gap-2">
              <code className="mono text-[11.5px] break-all basis-full sm:basis-auto flex-1 min-w-0">{shareLink(s.token)}</code>
              <span className="mono text-[11px] text-dim">until {new Date(s.expires).toLocaleDateString()}</span>
              <button onClick={() => copy(s.token)} className={BTN}>{copied === s.token ? 'copied ✓' : 'copy'}</button>
              <button onClick={async () => { await unshareFile(s.token); await load(); }} className={BTN}>turn off</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const BTN = 'mono text-[11px] uppercase tracking-wide rounded-[3px] border border-line px-2.5 py-1 hover:border-signal hover:text-signal transition-colors whitespace-nowrap';
const ITEM = 'block px-3 py-1.5 text-[13.5px] hover:bg-bone hover:text-signal';

/** One file: its toolbar and its preview. `onClose` makes it the pop-up over the app. */
export function FileViewer({ src, onClose }: { src: Src; onClose?: () => void }) {
  const [meta, setMeta] = useState<{ name: string; size: number; formats: string[]; expires?: number } | null>(null);
  const [err, setErr] = useState('');
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    setMeta(null); setErr('');
    if (src.kind === 'shared') {
      fetch(`/api/share/${encodeURIComponent(src.token)}`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'not found'); setMeta(j); }).catch((x) => setErr(x.message));
    } else {
      fetch(fileUrl(src.path), { method: 'HEAD' }).then((r) => {
        if (!r.ok) throw new Error('This file is no longer there.');
        const name = src.path.split('/').pop() ?? src.path;
        setMeta({ name, size: Number(r.headers.get('content-length') ?? 0), formats: DOC.includes(ext(name)) ? ['html', 'docx', 'pdf'] : [] });
      }).catch((x) => setErr(x.message));
    }
  }, [src.kind === 'own' ? src.path : src.token]);
  useEffect(() => {
    if (!onClose) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const own = src.kind === 'own';
  const where = own ? src.path.split('/').slice(0, -1).join('/') : '';
  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3 mb-4">
        <div className="basis-full sm:basis-auto flex-1 min-w-0">
          <div className="font-semibold text-[16px] truncate" title={meta?.name}>{meta?.name ?? (own ? src.path.split('/').pop() : 'Shared file')}</div>
          <div className="mono text-[11px] text-dim truncate">
            {meta && fmtSize(meta.size)}{where && ` · ${where}`}{meta?.expires && ` · link open until ${new Date(meta.expires).toLocaleDateString()}`}
          </div>
        </div>
        {meta && <DownloadMenu formats={meta.formats} src={src} />}
        {own && meta && <button onClick={() => setSharing(!sharing)} className={BTN}>{sharing ? 'hide sharing' : 'share'}</button>}
        {own && onClose && meta && <button onClick={() => window.open(`/view?path=${encodeURIComponent(src.path)}`, '_blank', 'noopener,width=900,height=1000')} className={BTN} title="Open in its own window">pop out ↗</button>}
        {onClose && <button onClick={onClose} aria-label="Close" className={BTN}>close ✕</button>}
      </div>
      {own && sharing && <SharePanel path={src.path} />}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {err ? <p className="text-signal">{err}</p> : meta ? <Body name={meta.name} size={meta.size} src={src} /> : <p className="mono text-[13px] text-dim">opening…</p>}
      </div>
    </div>
  );
}

/** The pop-up over the app. */
export function FileModal({ path, onClose }: { path: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch sm:items-center justify-center sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-bone w-full sm:max-w-3xl h-full sm:h-[88vh] sm:rounded-[4px] border border-line shadow-2xl p-4 sm:p-6 flex flex-col">
        <FileViewer src={{ kind: 'own', path }} onClose={onClose} />
      </div>
    </div>
  );
}

/** A whole page: the popped-out window (`/view?path=`) or a share link (`/s/<token>`). */
export function FilePage({ src }: { src: Src }) {
  useEffect(() => { document.documentElement.classList.toggle('dark', localStorage.getItem('mwa-dark') === '1'); }, []);
  return (
    <div className="min-h-full max-w-3xl mx-auto px-4 sm:px-6 py-6 flex flex-col">
      <FileViewer src={src} />
      {src.kind === 'shared' && <p className="mono text-[10.5px] text-dim mt-8 uppercase tracking-[0.16em]">shared from MWA</p>}
    </div>
  );
}
