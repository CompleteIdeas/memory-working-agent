// Thin client for the `mwa serve` API + translation of raw agent events into the
// plain-language "activity spine" (no jargon — the Mom-test rule).

export interface StatusResp {
  anthropic: boolean;
  azure: boolean;
  telegram: boolean;
  gmail: boolean;
  ready: boolean;
}

// If the access gate is on and our session expired (e.g. the server restarted),
// any API call returns 401 → reload, which the server answers with the lock screen.
function bounceIfLocked(r: Response): Response {
  if (r.status === 401) location.reload();
  return r;
}

export async function getStatus(): Promise<StatusResp> {
  const r = bounceIfLocked(await fetch('/api/status'));
  return r.json();
}

export async function getStats(): Promise<{ memories: number }> {
  try { const r = await fetch('/api/stats'); return await r.json(); } catch { return { memories: 0 }; }
}

export interface Connections { gmail: boolean; telegram: boolean; tools: { id: string; label: string; desc: string; on: boolean }[]; }
export async function getConnections(): Promise<Connections> {
  try { const r = await fetch('/api/connections'); return await r.json(); } catch { return { gmail: false, telegram: false, tools: [] }; }
}
export async function toggleTool(tool: string, on: boolean): Promise<void> {
  await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'toggle-tool', tool, on }) });
}
export async function connectGmail(): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'connect-gmail' }) });
  return r.json();
}
export async function getMemories(): Promise<{ id: string; concept: string; content: string }[]> {
  try { const r = await fetch('/api/memories'); return (await r.json()).memories ?? []; } catch { return []; }
}
export async function getSkills(): Promise<{ name: string; content: string }[]> {
  try { const r = await fetch('/api/skills'); return (await r.json()).skills ?? []; } catch { return []; }
}
export interface RunLog { ts: number; instruction: string; reason: string; steps: number; toolCalls: number; learned: number; skills: number; questions: number; costUsd: number; summary: string; }
export async function getRuns(): Promise<RunLog[]> {
  try { const r = await fetch('/api/runs'); return (await r.json()).runs ?? []; } catch { return []; }
}
export async function getNotifications(since: number): Promise<{ ts: number; instruction: string; summary: string }[]> {
  try { const r = await fetch('/api/notifications?since=' + since); return (await r.json()).notifications ?? []; } catch { return []; }
}
export async function getSchedule(): Promise<{ instruction: string; due: number; recur: string | null }[]> {
  try { const r = await fetch('/api/schedule'); return (await r.json()).scheduled ?? []; } catch { return []; }
}
export async function getQuestions(): Promise<{ id: string; question: string }[]> {
  try { const r = await fetch('/api/questions'); return (await r.json()).questions ?? []; } catch { return []; }
}
export async function resolveQuestions(): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/questions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resolve' }) });
  return r.json();
}

export async function getSuggestions(): Promise<string[]> {
  try {
    const r = await fetch('/api/suggestions');
    const d = await r.json();
    return d.suggestions ?? [];
  } catch {
    return [];
  }
}

export async function saveKey(body: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

export type StepTone = 'recall' | 'act' | 'learn' | 'think' | 'done';
export interface SpineStep { id: number; label: string; detail: string; tone: StepTone; }
export interface ChatResult { reason: string; summary: string; steps: number; dispatches: number; toolCalls: number; costUsd: number; }

// Friendly names for tools — never show the raw tool id to a person.
const TOOL_LABELS: Record<string, string> = {
  list_files: 'Looking through files',
  read_file: 'Reading a file',
  write_file: 'Saving a file',
  run_command: 'Running something',
  http_request: 'Fetching a page',
  search_email: 'Searching your email',
  read_email: 'Reading an email',
  draft_email: 'Drafting a reply for you',
  propose_event: 'Proposing a calendar event',
  search__web_search: 'Searching the web',
};

function shortPath(p?: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

/** Translate one raw SSE event into a human spine step (or null to ignore). */
export function plainStep(type: string, data: any): { label: string; detail: string; tone: StepTone } | null {
  switch (type) {
    case 'start': return { label: 'Getting started', tone: 'recall', detail: data?.recalled ? `recalled ${data.recalled} things I already know` : '' };
    case 'recall': return { label: 'Remembering what I know', tone: 'recall', detail: data?.query ?? '' };
    case 'read': return { label: 'Reading', tone: 'act', detail: shortPath(data?.path) };
    case 'remember': return { label: 'Learned something', tone: 'learn', detail: data?.concept ?? '' };
    case 'tool': return { label: TOOL_LABELS[data?.name] ?? 'Using a tool', tone: 'act', detail: '' };
    case 'dispatch': return { label: 'Working on it', tone: 'act', detail: (data?.files as string[])?.join(', ') ?? '' };
    case 'sleep': return { label: 'Tidying up my memory', tone: 'learn', detail: '' };
    case 'escalate': return { label: 'Thinking harder about this', tone: 'think', detail: '' };
    case 'question': return { label: 'Noted a question to look into later', tone: 'learn', detail: data?.question ?? '' };
    case 'ask': return { label: 'Asking you something', tone: 'think', detail: '' };
    case 'done': return { label: 'Finishing up', tone: 'done', detail: '' };
    default: return null; // 'end'/'result' handled separately
  }
}

export interface ChatHandlers {
  onStep: (s: { label: string; detail: string; tone: StepTone }) => void;
  onResult: (r: ChatResult) => void;
  onError: (message: string) => void;
}

/** Open the SSE chat stream for one message; returns the EventSource so it can be closed. */
export function chatStream(message: string, session: string, h: ChatHandlers): EventSource {
  const es = new EventSource(`/api/chat?session=${encodeURIComponent(session)}&message=${encodeURIComponent(message)}`);
  const TYPES = ['start', 'recall', 'read', 'remember', 'tool', 'dispatch', 'sleep', 'escalate', 'question', 'ask', 'done'];
  for (const t of TYPES) {
    es.addEventListener(t, (e) => {
      let data: any = {}; try { data = JSON.parse((e as MessageEvent).data); } catch { /* */ }
      const step = plainStep(t, data);
      if (step) h.onStep(step);
    });
  }
  es.addEventListener('result', (e) => {
    es.close();
    try { h.onResult(JSON.parse((e as MessageEvent).data)); } catch { h.onResult({ reason: 'done', summary: 'Done.', steps: 0, dispatches: 0, toolCalls: 0, costUsd: 0 }); }
  });
  es.addEventListener('error', (e) => {
    es.close();
    let msg = 'I lost the connection. Try again?';
    try { msg = JSON.parse((e as MessageEvent).data).message; } catch { /* */ }
    h.onError(msg);
  });
  return es;
}
