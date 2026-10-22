import { useEffect, useRef, useState } from 'react';
import { getFiles, fileUrl, uploadFile, deleteFile, type FileRow } from '../api';
import { openFile } from './Markdown';
import { fmtSize } from './FileViewer';

/** BL-70: every file MWA has written or been given, newest first. A row opens in the viewer. */
function where(path: string): string {
  const [top, sub] = path.split('/');
  if (top === 'serve') return sub === 'resolve' ? 'Open questions' : path.includes('/uploads/') ? 'Added to a chat' : 'From a chat';
  if (top === 'scheduled') return 'Scheduled job';
  if (top === 'outbox' || top === 'outputs') return 'Inbox results';
  if (top === 'inbox' || top === 'done') return 'Inbox requests';
  return top;
}

export function Files() {
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const load = () => getFiles().then(setFiles);
  useEffect(() => { void load(); }, []);

  async function add(list: FileList | null) {
    if (!list?.length) return;
    const session = localStorage.getItem('mwa-session') || 'default';
    for (const f of Array.from(list)) { const r = await uploadFile(f, session); setMsg(r.ok ? `Added ${f.name} to your chat.` : (r.message ?? `Could not add ${f.name}.`)); }
    if (picker.current) picker.current.value = '';
    void load();
  }
  const shown = (files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="py-8">
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div className="flex-1 min-w-[200px]">
          <h2 className="text-2xl font-semibold tracking-tight">Files</h2>
          <p className="text-dim text-[14px]">What MWA has written for you, and what you've added. Open one to read it, download it, or share it.</p>
        </div>
        <input ref={picker} type="file" multiple className="hidden" onChange={(e) => void add(e.target.files)} />
        <button onClick={() => picker.current?.click()} className="mono text-[11px] uppercase tracking-wide rounded-[3px] border border-line px-3 py-1.5 hover:border-signal hover:text-signal transition-colors">add a file +</button>
      </div>
      {msg && <p className="mono text-[12px] text-dim mb-3">{msg}</p>}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file…" className="w-full rounded-[3px] border border-line bg-surface px-3 py-2 text-[14px] outline-none focus:border-signal mb-4" />
      {files === null ? <p className="mono text-[13px] text-dim">loading…</p>
        : !shown.length ? <p className="text-dim">{files.length ? 'Nothing matches.' : 'No files yet. When MWA writes a report or notes, they appear here.'}</p>
        : (
          <ul className="divide-y divide-line border-y border-line">
            {shown.map((f) => (
              <li key={f.path} className="flex items-center gap-3 py-2.5">
                <button onClick={() => openFile(f.path)} className="flex-1 min-w-0 text-left group">
                  <div className="truncate text-[15px] group-hover:text-signal">{f.path.split('/').pop()}</div>
                  <div className="mono text-[11px] text-dim truncate">{where(f.path)} · {new Date(f.mtime).toLocaleString()} · {fmtSize(f.size)}</div>
                </button>
                <a href={fileUrl(f.path, true)} title="Download" className="mono text-[13px] text-dim hover:text-signal px-1">↓</a>
                <button title="Delete" onClick={async () => { if (confirm(`Delete ${f.path.split('/').pop()}? This can't be undone.`)) { await deleteFile(f.path); void load(); } }} className="mono text-[13px] text-dim hover:text-signal px-1">✕</button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
