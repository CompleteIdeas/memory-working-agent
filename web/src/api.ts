// Thin client for the `mwa serve` API + translation of raw agent events into the
// plain-language "activity spine" (no jargon — the Mom-test rule).

export interface StatusResp {
  anthropic: boolean;
  azure: boolean;
  telegram: boolean;
  gmail: boolean;
  outlook: boolean;
  ready: boolean;
  /** BL-23: how the configured brain fared against instructions planted in what it reads. */
  modelNote?: { standing: 'held' | 'failed' | 'unmeasured'; text: string } | null;
  /** The same for the stronger model MWA escalates to, when it is a different one. */
  reasonNote?: { standing: 'held' | 'failed' | 'unmeasured'; text: string } | null;
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

/** An action staged for the person's approval (BL-03): only they approve it — here or in Telegram. */
export interface PendingApproval { id: string; tool: string; summary: string; expiresInSec: number; tainted: boolean; kind: 'tool' | 'captured-policy';
  /** since 2026-10-24: the clock time it lapses, whether the run only read the person's own files, where it came from */
  expiresAt?: number; readLocal?: boolean; session?: string; runId?: string; createdAt?: number }
export async function getApprovals(): Promise<PendingApproval[]> {
  return (await getApprovalsFull()).pending;
}
/** Approved here but owned by another app (waiting for it to run), or failed, in the last day (BL-18). */
export interface ApprovalOutcome { id: string; tool: string; status: 'approved' | 'failed' | 'done' | 'cancelled' | 'expired'; owner: string; result?: string; at: number;
  summary?: string; kind?: 'tool' | 'captured-policy'; session?: string; createdAt?: number }
/** BL-72: what the reviewer ran without asking, in the last day, and why. */
export interface AutoApproved { id: string; tool: string; summary: string; reason: string; status: string; result?: string; at: number }
export async function getApprovalsFull(): Promise<{ pending: PendingApproval[]; recent: ApprovalOutcome[]; auto: AutoApproved[] }> {
  try { const j = await (bounceIfLocked(await fetch('/api/approvals'))).json(); return { pending: j.pending ?? [], recent: j.recent ?? [], auto: j.auto ?? [] }; } catch { return { pending: [], recent: [], auto: [] }; }
}
export async function decideApproval(id: string, approve: boolean): Promise<{ ok: boolean; message: string }> {
  try {
    const r = bounceIfLocked(await fetch(`/api/approvals/${approve ? 'confirm' : 'cancel'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    }));
    const j = await r.json();
    const message = String(j.message ?? j.error ?? '');
    return { ok: r.ok && (approve ? j.ok === true : !message.startsWith('(')), message };
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}

export async function getStats(): Promise<{ memories: number }> {
  try { const r = await fetch('/api/stats'); return await r.json(); } catch { return { memories: 0 }; }
}

export interface ConnectorSecret { env: string; label: string; help: string | null; optional: boolean; set: boolean }
export interface ConnectorItem { id: string; name: string; category: string; description: string; access: string; tier: string; source: string | null; on: boolean; secrets: ConnectorSecret[] }
export interface ExternalInstall { enabled: boolean; policy: string; reason: string; model: string }
export type AccessPreset = 'locked-down' | 'assistant' | 'developer';
export interface Access { preset: AccessPreset; grantedRoots: string[] }
export interface Brain { provider: string; model: string }
export type InteractionStyle = 'guided' | 'direct';
export interface StorageBackend { kind: 'sqlite' | 'pglite' | 'postgres'; configured: boolean; }
export interface Connections { gmail: boolean; gmailMethod: 'oauth' | 'app-password' | null; outlook: boolean; outlookEasy: boolean; telegram: boolean; brain: Brain; imageModel: Brain; connectors: ConnectorItem[]; externalInstall: ExternalInstall; access: Access; style: InteractionStyle; ingestReady: boolean; storage: StorageBackend;
  /** where MWA runs (2026-10-23): a server deploy words the page for a server and hides what can't work there */
  hosted?: boolean; host?: string; modelFromEnv?: boolean; imageFromEnv?: boolean; tailscale?: boolean; }
export async function getConnections(): Promise<Connections> {
  try { const r = await fetch('/api/connections'); return await r.json(); } catch { return { gmail: false, gmailMethod: null, outlook: false, outlookEasy: false, telegram: false, brain: { provider: '', model: '' }, imageModel: { provider: '', model: '' }, connectors: [], externalInstall: { enabled: false, policy: 'review-required', reason: '', model: '' }, access: { preset: 'assistant', grantedRoots: [] }, style: 'guided', ingestReady: false, storage: { kind: 'sqlite', configured: true } }; }
}
// "Learn about me from my email": stream the inbox scan. onLog = progress lines, onResult =
// final { unique, learned } counts. Returns the EventSource so the caller can close it.
export function scanEmail(days: number, h: { onLog: (m: string) => void; onResult: (r: { unique: number; learned: number }) => void; onError: (m: string) => void }): EventSource {
  const es = new EventSource(`/api/ingest?days=${days}`);
  es.addEventListener('log', (e) => { try { h.onLog(JSON.parse((e as MessageEvent).data).message); } catch { /* */ } });
  es.addEventListener('result', (e) => { es.close(); try { h.onResult(JSON.parse((e as MessageEvent).data)); } catch { h.onResult({ unique: 0, learned: 0 }); } });
  es.addEventListener('error', (e) => { es.close(); let m = 'The scan stopped unexpectedly. Try again?'; try { m = JSON.parse((e as MessageEvent).data).message; } catch { /* */ } h.onError(m); });
  return es;
}
// Change the interaction style (how MWA talks / how proactive it is) — independent of access.
export async function saveStyle(style: InteractionStyle): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'style', style }) });
  return r.json();
}
// Set (or clear, when model is empty) the image-generation model.
export async function saveImageModel(provider: string, model: string, key?: string, baseUrl?: string): Promise<{ ok: boolean; message: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'image-model', provider, model, key, baseUrl }) });
  return r.json();
}
export async function disconnectService(which: 'gmail' | 'outlook' | 'telegram'): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: `disconnect-${which}` }) });
  return r.json();
}
// Change the AI brain after onboarding: validates the model/key, then saves it as the active model.
export async function saveBrain(provider: string, model: string, key?: string, baseUrl?: string): Promise<{ ok: boolean; message: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'provider', provider, model, key, baseUrl }) });
  return r.json();
}
// --- Onboarding wizard (warm-start memory from folders/files) ---
export interface OnboardCandidate { concept: string; content: string; source: string }
/** Scan the folders/files the user points at → candidate memories to review. Nothing is saved. */
export async function onboardScan(paths: string[]): Promise<{ ok: boolean; candidates: OnboardCandidate[]; filesScanned: number; truncated: boolean }> {
  const r = bounceIfLocked(await fetch('/api/onboard/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) }));
  try { return await r.json(); } catch { return { ok: false, candidates: [], filesScanned: 0, truncated: false }; }
}
/** Save the memories the user confirmed (owner-provided → trusted + canonical). */
export async function onboardSave(memories: { concept: string; content: string; tags?: string[] }[]): Promise<{ ok: boolean; saved: number }> {
  const r = bounceIfLocked(await fetch('/api/onboard/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memories }) }));
  try { return await r.json(); } catch { return { ok: false, saved: 0 }; }
}

export async function saveAccess(preset: AccessPreset, grantedRoots?: string[]): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'access', preset, grantedRoots }) });
  return r.json();
}
export interface RiskReport { source: string; verdict: 'safe' | 'caution' | 'dangerous'; summary: string; capabilities: string[]; redFlags: string[]; pinnedVersion?: string; integrity?: string; model: string; deepScan?: { ran: boolean; note?: string; integrityOk?: boolean; filesScanned?: number } }
export async function reviewExternal(source: string): Promise<{ ok: boolean; message?: string; report?: RiskReport }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'review-external', source }) });
  return r.json();
}
export async function approveExternal(source: string, version?: string, verdict?: string, integrity?: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve-external', source, version, verdict, integrity }) });
  return r.json();
}
export async function enableConnector(id: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'enable-connector', id }) });
  return r.json();
}
export async function disableConnector(id: string): Promise<void> {
  await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'disable-connector', id }) });
}
export async function saveConnectorSecret(env: string, value: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save-secret', env, value }) });
  return r.json();
}
export async function connectGmail(readonly = false): Promise<{ ok: boolean; message?: string; url?: string }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'connect-gmail', readonly }) });
  return r.json();
}
// EASY Gmail: app password over IMAP — no Google Cloud Console. Validated server-side by
// opening a real IMAP session before the creds are saved.
export async function connectGmailImap(user: string, appPassword: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'connect-gmail-imap', user, appPassword }) });
  return r.json();
}
// EASY Outlook: device code — show a short code + URL; the server polls until the user finishes.
export async function connectOutlookDevice(readonly = false): Promise<{ ok: boolean; message?: string; user_code?: string; verification_uri?: string; expires_in?: number }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'connect-outlook-device', readonly }) });
  return r.json();
}
export async function saveGoogle(clientId: string, clientSecret: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'google', GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret }) });
  return r.json();
}
export async function connectOutlook(readonly = false): Promise<{ ok: boolean; message?: string; url?: string }> {
  const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'connect-outlook', readonly }) });
  return r.json();
}
export async function saveMicrosoft(clientId: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'microsoft', MICROSOFT_CLIENT_ID: clientId }) });
  return r.json();
}
export async function saveTelegram(token: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'telegram', TELEGRAM_BOT_TOKEN: token }) });
  return r.json();
}

// Join a tailnet so a cloud deploy is reachable privately (no public port). Takes a Tailscale
// AUTH key (tskey-auth-…), not an API key; the server validates the prefix. Optional hostname.
export async function saveTailscale(key: string, hostname?: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'tailscale', key, hostname }) });
  return r.json();
}

// Choose where memory is stored: 'sqlite' (this computer, default) or 'postgres' (a database
// server — pass the postgres:// URL, which the server validates by connecting). Restart to apply.
// migrate=true copies the current memory into the new database before switching (agnostic
// import/export), so you keep everything you've learned.
export async function saveBackend(kind: 'sqlite' | 'postgres', url?: string, migrate?: boolean): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which: 'backend', kind, url, migrate }) });
  return r.json();
}
// List a provider's available models for the onboarding picker. Passes the (not-yet-saved) key so
// the list can load during setup; OpenRouter returns its full public catalog even with no key.
export async function getModels(provider: string, key?: string, baseUrl?: string, kind: 'chat' | 'image' = 'chat'): Promise<{ id: string; name?: string }[]> {
  try {
    const r = await fetch('/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, key, baseUrl, kind }) });
    return (await r.json()).models ?? [];
  } catch { return []; }
}
// First-run: download/warm the local memory models (~500MB on a fresh machine). Resolves fast
// when already cached. Long timeout — the one-time download can take a few minutes.
export async function warmModels(): Promise<{ ready: boolean; message?: string }> {
  try {
    const r = await fetch('/api/setup/warm', { method: 'POST', signal: AbortSignal.timeout(600000) });
    return await r.json();
  } catch { return { ready: false, message: 'timed out' }; }
}
export type Trust = 'high' | 'medium' | 'untrusted';
export type Provenance = 'user' | 'inferred' | 'ingested' | 'tool' | 'unknown';
export interface MemoryItem { id: string; concept: string; content: string; trust: Trust; provenance: Provenance; origin?: string }
export interface ActionItem { id: string; verb: string; summary: string; effect: 'external' | 'local' | 'read'; tool?: string; undo?: string }

export async function getMemories(): Promise<MemoryItem[]> {
  try { const r = await fetch('/api/memories'); return (await r.json()).memories ?? []; } catch { return []; }
}
export async function getActions(): Promise<ActionItem[]> {
  try { const r = await fetch('/api/actions'); return (await r.json()).actions ?? []; } catch { return []; }
}
export interface RoutineRow { id: string; slug: string; name: string; version: string; status: string; content: string; tainted: boolean; agent?: string }
/** BL-12 — routines a run proposed; the person promotes or retires them. */
export async function getRoutines(): Promise<RoutineRow[]> {
  try { const r = await fetch('/api/routines'); return (await r.json()).routines ?? []; } catch { return []; }
}
export async function setRoutine(id: string, action: 'promote' | 'retire', agent?: string): Promise<{ ok: boolean; error?: string }> {
  try { const r = await fetch(`/api/routines/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, agent }) }); return await r.json(); } catch { return { ok: false, error: 'network error' }; }
}
/** F1 Glass Box — hard-delete (forget) one memory. */
export async function forgetMemory(id: string): Promise<{ ok: boolean }> {
  try { const r = await fetch('/api/memory/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }); return await r.json(); } catch { return { ok: false }; }
}
/** F1 Glass Box — correct a fact (supersede with the user's text; becomes trusted). */
export async function correctMemory(id: string, concept: string, content: string): Promise<{ ok: boolean }> {
  try { const r = await fetch('/api/memory/correct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, concept, content }) }); return await r.json(); } catch { return { ok: false }; }
}
export async function getSkills(): Promise<{ name: string; content: string }[]> {
  try { const r = await fetch('/api/skills'); return (await r.json()).skills ?? []; } catch { return []; }
}
export interface PersonRow { personId: string; notes: number; fields: string[]; missing: string[]; dossier: string | null }
export async function getPeople(): Promise<PersonRow[]> {
  try { const r = await fetch('/api/people'); return (await r.json()).people ?? []; } catch { return []; }
}
export async function getLessons(): Promise<{ topic: string; content: string }[]> {
  try { const r = await fetch('/api/skills'); return (await r.json()).lessons ?? []; } catch { return []; }
}
export async function getPolicies(): Promise<string[]> {
  try { const r = await fetch('/api/skills'); return (await r.json()).policies ?? []; } catch { return []; }
}
export interface RunLog { ts: number; instruction: string; reason: string; steps: number; toolCalls: number; learned: number; skills: number; questions: number; costUsd: number; summary: string; }
export async function getRuns(): Promise<RunLog[]> {
  try { const r = await fetch('/api/runs'); return (await r.json()).runs ?? []; } catch { return []; }
}
export interface Notification {
  ts: number; instruction: string; summary: string;
  /** present since 2026-10-14; older records in notifications.jsonl have none, so treat as optional. */
  reason?: string; steps?: number; toolCalls?: number; costUsd?: number; durationMs?: number; files?: string[]; dir?: string; folder?: string;
  /** what the run achieved, and a two-phase completion's state (BL-02). */
  outcome?: string; completion?: 'candidate' | 'stopped';
  /** BL-71: the job's own words, and the conversation it reports to. */
  title?: string; session?: string;
}

// ── BL-71d: conversations and work ─────────────────────────────────────────────────────────────
export interface ConversationTurn { ts: number; session: string; message: string; reply: string; reason?: string; kind?: 'chat' | 'result' | 'offer' | 'running'; runId?: string }
export interface ConversationSummary { session: string; title: string; last: number; turns: number; lastMessage: string }
export async function getConversations(): Promise<ConversationSummary[]> {
  try { return (await (bounceIfLocked(await fetch('/api/conversations'))).json()).conversations ?? []; } catch { return []; }
}
export async function getConversation(session: string): Promise<ConversationTurn[]> {
  try { return (await (bounceIfLocked(await fetch(`/api/conversation?session=${encodeURIComponent(session)}`))).json()).turns ?? []; } catch { return []; }
}
export interface WorkGoal {
  id: string; title: string; status: 'open' | 'in_progress' | 'blocked' | 'done'; priority: string; createdAt?: number; jobs: number;
  record: { text: string; at: number; by: string; conv?: string; untrusted: boolean; files: string[] } | null;
  /** BL-71e: MWA's newest proposal for it, from thinking time */
  thought: { kind: 'next' | 'ask' | 'wait' | 'done'; text: string; at: number; untrusted?: boolean } | null;
}

/** BL-71e: what moved while the person was away. */
export interface Welcome { since: number; results: { title: string; session?: string; outcome?: string }[]; goals: { id: string; title: string; state: string; conv?: string }[]; thoughts: { title: string; kind: string; text: string }[]; approvals: number }
export async function getWelcome(since: number): Promise<Welcome | null> {
  try { return await (bounceIfLocked(await fetch(`/api/welcome?since=${since}`))).json(); } catch { return null; }
}
export async function getWork(): Promise<WorkGoal[]> {
  try { return (await (bounceIfLocked(await fetch('/api/work'))).json()).goals ?? []; } catch { return []; }
}
async function postWork(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; message: string; session?: string }> {
  try {
    const r = bounceIfLocked(await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const j = await r.json();
    return { ok: r.ok && j.ok === true, message: String(j.message ?? j.error ?? ''), session: j.session };
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}
export const continueWork = (goal: string) => postWork('/api/work/continue', { goal });
export const setWorkStatus = (goal: string, status: WorkGoal['status']) => postWork('/api/work/status', { goal, status });
/** Open a conversation in the chat (the Work view and the conversation list use this). */
export function openConversation(session: string): void { window.dispatchEvent(new CustomEvent('mwa-open-conversation', { detail: session })); }
export async function getNotifications(since: number): Promise<Notification[]> {
  try { const r = await fetch('/api/notifications?since=' + since); return (await r.json()).notifications ?? []; } catch { return []; }
}
/** A scheduled job of this person (F04, 2026-10-24): its words, when, state and the controls on it. */
export interface ScheduleRow {
  id: string; kind: 'reminder' | 'watch' | 'task'; request: string; instruction: string; due: number; recur: string | null; when: string;
  paused: boolean; tainted: boolean; allow: { vault?: string[]; click?: { host: string; label: string }[] } | null;
  goal?: string; session?: string; lastRun?: { at: number; summary: string; value?: string }; fails?: number;
}
export async function getSchedule(): Promise<ScheduleRow[]> {
  try { const r = await fetch('/api/schedule', { cache: 'no-store' }); return (await r.json()).scheduled ?? []; } catch { return []; }
}
export async function scheduleAction(action: 'cancel' | 'uncancel' | 'pause' | 'resume' | 'update', body: Record<string, unknown>): Promise<{ ok: boolean; message: string; id?: string }> {
  try {
    const r = bounceIfLocked(await fetch(`/api/schedule/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const j = await r.json(); return { ok: j.ok === true, message: String(j.message ?? j.error ?? ''), id: j.id };
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}

// -- Live runs (F06, F08, F09): see, stop, add to, and re-attach to a run going in a conversation --
export interface LiveRun { runId: string; message: string; startedAt: number; elapsedMs: number; stopping: boolean; stage?: Record<string, unknown> }
export async function getLive(session: string): Promise<LiveRun | null> {
  try { const j = await (bounceIfLocked(await fetch(`/api/chat/live?session=${encodeURIComponent(session)}`, { cache: 'no-store' }))).json(); return j.live ?? null; } catch { return null; }
}
async function postJson(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    const r = bounceIfLocked(await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const j = await r.json(); return { ok: j.ok === true, message: String(j.message ?? j.error ?? '') };
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}
export const stopRun = (session: string) => postJson('/api/chat/stop', { session });
export const steerRun = (session: string, message: string) => postJson('/api/chat/steer', { session, message });

/** What MWA can read for this chat (F07): the granted folders and the files added here. */
export interface Sources { preset: string; folders: { path: string; files: number; capped?: boolean; readable: boolean }[]; added: string[] }
export async function getSources(session: string): Promise<Sources | null> {
  try { return await (bounceIfLocked(await fetch(`/api/sources?session=${encodeURIComponent(session)}`, { cache: 'no-store' }))).json(); } catch { return null; }
}

// -- Settings (D5): saved logins and quiet hours --
export interface VaultRow { name: string; site?: string; fields: string[]; savedAt?: number }
export async function getVault(): Promise<VaultRow[]> {
  try { return (await (bounceIfLocked(await fetch('/api/vault', { cache: 'no-store' }))).json()).entries ?? []; } catch { return []; }
}
export const forgetVault = (name: string) => postJson('/api/vault/forget', { name });
export interface QuietState { window: string | null; timeZone: string; fixed: boolean; invalid: boolean }
export async function getQuiet(): Promise<QuietState | null> {
  try { return await (bounceIfLocked(await fetch('/api/quiet', { cache: 'no-store' }))).json(); } catch { return null; }
}
export const setQuiet = (value: string) => postJson('/api/quiet', { value });
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

// Ask the local backend to open a URL in the OS browser. Used inside the desktop app,
// where the webview ignores target="_blank" (see the global link handler in main.tsx).
export async function openExternal(url: string): Promise<void> {
  try { await fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); } catch { /* */ }
}

export async function saveKey(body: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const r = await fetch('/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

export type StepTone = 'recall' | 'act' | 'learn' | 'think' | 'done';
export interface SpineStep { id: number; label: string; detail: string; tone: StepTone; }
export interface ChatResult { reason: string; summary: string; steps: number; dispatches: number; toolCalls: number; costUsd: number;
  /** since 2026-10-24: the live run, the kept turn's id, how long it took, and the cards it staged */
  runId?: string; turnId?: number; elapsedMs?: number; staged?: string[];
  /** BL-71b: MWA offers to do this in the background instead of now. */
  offer?: { kind: 'start'; message: string };
}

/** BL-71b: the person chose "Work on it": a goal and a background job, reported back in the chat. */
export async function startWork(message: string, session: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = bounceIfLocked(await fetch('/api/work/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, session }) }));
    const j = await r.json();
    return { ok: r.ok && j.ok === true, message: String(j.message ?? j.error ?? '') };
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}

// Friendly names for tools — never show the raw tool id to a person.
export const TOOL_LABELS: Record<string, string> = {
  list_files: 'Looking through files',
  read_file: 'Reading a file',
  write_file: 'Saving a file',
  run_command: 'Running something',
  http_request: 'Fetching a page',
  search_email: 'Searching your email',
  read_email: 'Reading an email',
  draft_email: 'Drafting a reply for you',
  propose_event: 'Proposing a calendar event',
  search_outlook: 'Searching your Outlook',
  read_outlook: 'Reading an email',
  draft_outlook: 'Drafting a reply for you',
  propose_outlook_event: 'Proposing a calendar event',
  search__web_search: 'Searching the web',
  search_files: 'Searching your files',
  read_document: 'Reading a document',
  fetch__fetch_url: 'Fetching a page',
  // the agent browser (review 2026-10-25, F16: raw tool ids showed as "browser open")
  browser_open: 'Opening a page in the browser',
  browser_page: 'Reading the open page again',
  browser_click: 'Clicking on the page',
  browser_type: 'Typing on the page',
  browser_select: 'Choosing an option on the page',
  browser_scroll: 'Scrolling the page',
  browser_look: 'Looking at the page',
  browser_screenshot: 'Taking a screenshot',
  // the rest of the tools and actions a run can take (interface slice 2026-10-25: a stage line read "list connectors")
  read: 'Reading a file', recall: 'Remembering what I know', remember: 'Noting something to remember', supersede: 'Updating something I knew',
  ask_user: 'Asking you something', dispatch: 'Handing part of it to a helper', done: 'Finishing up',
  schedule: 'Setting up a schedule', schedule_list: 'Checking your schedule', schedule_cancel: 'Cancelling a scheduled job',
  schedule_update: 'Changing a scheduled job', schedule_detector: 'Setting up a change check',
  goal_add: 'Starting a piece of work', goal_list: 'Checking work in progress', goal_note: 'Noting where the work stands', goal_update: 'Updating work in progress',
  policy_save: 'Proposing a standing preference', policy_forget: 'Proposing to remove a preference',
  list_connectors: 'Checking what I can connect to', install_connector: 'Turning on a connector', uninstall_connector: 'Turning off a connector',
  propose_connector: 'Proposing a connector', connection_status: 'Checking your connections', connect_account: 'Asking you to connect an account',
  vault_request: 'Asking you to save a login', vault_list: 'Checking saved logins', vault_forget: 'Forgetting a saved login',
  knowledge_write: 'Saving notes', knowledge_list: 'Looking through saved notes', open_items: 'Checking open items', open_item_add: 'Noting an open item', open_item_close: 'Closing an open item',
  onboard_scan: 'Scanning documents', onboard_questions: 'Preparing questions', run_checks: 'Checking the work', routine_propose: 'Proposing a routine',
  memory_profile: 'Looking up what I know about you', memory_learn_person: 'Noting something about you', memory_feedback: 'Noting what helped', memory_store_map: 'Looking through memory',
  list_pending: 'Checking what waits for you', approval_results: 'Checking decisions', confirm_action: 'Checking a decision', cancel_action: 'Withdrawing a request',
  quiet_hours: 'Checking quiet hours', list_active_tools: 'Checking my tools', add_mcp_server: 'Adding a tool', remove_mcp_server: 'Removing a tool', mwa: 'Checking settings',
};

export function shortPath(p?: string): string {
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
    // Every tool call also arrives as a 'step' with the tool, what it touched and the time so far; this older event
    // doubled the list with a bare "Using a tool" line after each real step (review 2026-10-25, F16).
    case 'tool': return null;
    case 'dispatch': return { label: 'Working on it', tone: 'act', detail: (data?.files as string[])?.join(', ') ?? '' };
    case 'sleep': return { label: 'Tidying up my memory', tone: 'learn', detail: '' };
    case 'escalate': return { label: 'Thinking harder about this', tone: 'think', detail: '' };
    case 'plan': return { label: 'Making a plan', tone: 'think', detail: Array.isArray(data?.steps) ? `${data.steps.length} steps` : '' };
    case 'plan_step': return { label: `Step ${data?.n ?? ''} of ${data?.total ?? ''}`, tone: 'act', detail: data?.task ?? '' };
    case 'verify': return { label: data?.ok === false ? 'Double-checking the numbers' : 'Checked my work', tone: 'think', detail: '' };
    case 'question': return { label: 'Noted a question to look into later', tone: 'learn', detail: data?.question ?? '' };
    case 'ask': return { label: 'Asking you something', tone: 'think', detail: '' };
    case 'done': return { label: 'Finishing up', tone: 'done', detail: '' };
    // F06 (2026-10-24): a real stage — the tool and the thing it touches, with the time so far.
    case 'step': return { label: `Step ${data?.n ?? ''}: ${TOOL_LABELS[data?.tool] ?? String(data?.tool ?? 'working').replace(/_/g, ' ')}`, tone: 'act', detail: `${shortPath(data?.detail)}${data?.elapsedMs ? ` · ${Math.round(Number(data.elapsedMs) / 1000)}s` : ''}` };
    case 'stopping': return { label: 'Stopping after this step', tone: 'think', detail: '' };
    case 'stopped': return { label: 'Stopped', tone: 'done', detail: data?.step ? `after step ${data.step}` : '' };
    case 'steered': return { label: 'Took your added message into account', tone: 'think', detail: '' };
    default: return null; // 'end'/'result' handled separately
  }
}

/** A stage of a live run, from its `step` events (F06): the tool in plain words, what it touches, the time so far. */
export interface Stage { n: number; of?: number; tool: string; label: string; detail: string; elapsedMs: number }
// `of` on a step is the run's step budget, not a plan, so it is not shown as "of N".
export function stageOf(data: any): Stage {
  const tool = String(data?.tool ?? '');
  return { n: Number(data?.n ?? 0), tool, label: TOOL_LABELS[tool] ?? (tool ? tool.replace(/__/g, ' ').replace(/_/g, ' ') : 'Working'), detail: plainDetail(String(data?.detail ?? '')), elapsedMs: Number(data?.elapsedMs ?? 0) };
}
/** Granted folders, so a path in a stage (cut at 120 characters by the server) is named by its folder. */
let knownFolders: string[] = [];
export function setKnownFolders(f: string[]): void { knownFolders = f.map((x) => x.replace(/\\/g, '/')); }
export function plainDetail(d: string): string {
  const p = d.replace(/\\/g, '/').trim();
  if (!p) return '';
  if (!/[/]/.test(p)) return p.length > 70 ? p.slice(0, 68) + '…' : p;
  for (const f of knownFolders) {
    const name = f.split('/').filter(Boolean).pop() ?? f;
    if (f.toLowerCase().startsWith(p.toLowerCase())) return `${name} (your folder)`;
    if (p.toLowerCase().startsWith(f.toLowerCase())) { const rest = p.slice(f.length).replace(/^\/+/, ''); return rest ? rest : `${name} (your folder)`; }
  }
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}
export interface BusyInfo { runId: string; message: string; startedAt: number; elapsedMs: number; stopping: boolean; stage?: Record<string, unknown> }
export interface ChatHandlers {
  onStep: (s: { label: string; detail: string; tone: StepTone }) => void;
  /** the run started on the server (its id, for Stop and re-attach) */
  onRun?: (r: { runId: string; startedAt: number }) => void;
  /** a real stage (F06) */
  onStage?: (s: Stage) => void;
  onStopping?: () => void;
  /** another run is already going in this conversation (F08): nothing was started */
  onBusy?: (b: BusyInfo) => void;
  /** attach found nothing running */
  onGone?: () => void;
  onResult: (r: ChatResult) => void;
  onError: (message: string) => void;
  // How this message relates to the conversation: 'continue' (built on the recent chat),
  // 'fresh' (a new topic — earlier context set aside), or 'ask' (it's confirming with you).
  // hadContext = there was an earlier conversation in this session that could be carried.
  onTopic?: (t: { relation: 'continue' | 'fresh' | 'ask'; hadContext: boolean }) => void;
}

/** Open the SSE chat stream for one message; returns the EventSource so it can be closed. */
export function chatStream(message: string, session: string, h: ChatHandlers, opts: { stay?: boolean } = {}): EventSource {
  return listen(new EventSource(`/api/chat?session=${encodeURIComponent(session)}&message=${encodeURIComponent(message)}${opts.stay ? '&stay=1' : ''}`), h);
}
/** Re-attach to the run going in a conversation (F09): its events so far, then live, to the result. */
export function attachStream(session: string, h: ChatHandlers): EventSource {
  return listen(new EventSource(`/api/chat/attach?session=${encodeURIComponent(session)}`), h);
}
function listen(es: EventSource, h: ChatHandlers): EventSource {
  const TYPES = ['start', 'recall', 'read', 'remember', 'tool', 'dispatch', 'sleep', 'escalate', 'plan', 'plan_step', 'verify', 'question', 'ask', 'done', 'step', 'stopping', 'stopped', 'steered'];
  for (const t of TYPES) {
    es.addEventListener(t, (e) => {
      let data: any = {}; try { data = JSON.parse((e as MessageEvent).data); } catch { /* */ }
      const step = plainStep(t, data);
      if (step) h.onStep(step);
      if (t === 'step') h.onStage?.(stageOf(data));
      if (t === 'stopping') h.onStopping?.();
    });
  }
  es.addEventListener('run', (e) => { try { h.onRun?.(JSON.parse((e as MessageEvent).data)); } catch { /* */ } });
  es.addEventListener('gone', () => { es.close(); h.onGone?.(); });
  // Topic relation — a turn-level signal (not an activity step): drives the "new topic" marker.
  es.addEventListener('topic', (e) => {
    try { h.onTopic?.(JSON.parse((e as MessageEvent).data)); } catch { /* */ }
  });
  es.addEventListener('result', (e) => {
    es.close();
    try { h.onResult(JSON.parse((e as MessageEvent).data)); } catch { h.onResult({ reason: 'done', summary: 'Done.', steps: 0, dispatches: 0, toolCalls: 0, costUsd: 0 }); }
  });
  // F08 (2026-10-24): a run is already going in this conversation; the server did not start a second one.
  es.addEventListener('busy', (e) => {
    es.close();
    let d: any = {}; try { d = JSON.parse((e as MessageEvent).data); } catch { /* */ }
    if (h.onBusy) { h.onBusy(d as BusyInfo); return; }
    const since = d?.elapsedMs ? `${Math.round(Number(d.elapsedMs) / 1000)}s ago` : 'a moment ago';
    h.onResult({ reason: 'busy', summary: `I'm still working on your previous message here (started ${since}). Wait for it to finish, then send this again${d?.stage?.tool ? ` — I'm on ${String(d.stage.tool).replace(/_/g, ' ')}` : ''}.`, steps: 0, dispatches: 0, toolCalls: 0, costUsd: 0 });
  });
  es.addEventListener('error', (e) => {
    es.close();
    let msg = 'I lost the connection. Try again?';
    try { msg = JSON.parse((e as MessageEvent).data).message; } catch { /* */ }
    h.onError(msg);
  });
  return es;
}

// BL-62: setup cards the agent opens when the person asks it to connect something. Values go only to /api/setup.
export interface SetupField { env: string; label: string; help?: string; secret: boolean; optional?: boolean }
export interface SetupCard { id: string; name: string; howTo: string; fields: SetupField[]; status: 'waiting' | 'done' | 'failed' | 'cancelled' | 'expired'; message: string; expiresInSec: number }
export async function getSetupCards(): Promise<SetupCard[]> {
  try { const j = await (bounceIfLocked(await fetch('/api/setup'))).json(); return j.requests ?? []; } catch { return []; }
}
export async function submitSetupCard(id: string, values: Record<string, string> | null): Promise<{ ok: boolean; message: string }> {
  try {
    const r = bounceIfLocked(await fetch(`/api/setup/${values ? 'submit' : 'cancel'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, values }),
    }));
    const j = await r.json();
    return { ok: r.ok && j.ok === true, message: String(j.message ?? j.error ?? '') };
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}

// BL-70: the person's files (everything MWA wrote under its workspace, and what they added).
export interface FileRow { path: string; size: number; mtime: number; formats?: string[]; }
export async function getFiles(): Promise<FileRow[]> {
  try { const r = bounceIfLocked(await fetch('/api/files')); return (await r.json()).files ?? []; } catch { return []; }
}
/** The URL that opens (or, with download, saves) one file. */
export function fileUrl(path: string, download = false): string {
  return `/api/files/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
}
export async function uploadFile(file: File, session: string): Promise<{ ok: boolean; path?: string; message?: string }> {
  try {
    const r = bounceIfLocked(await fetch(`/api/files/upload?session=${encodeURIComponent(session)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }));
    return await r.json();
  } catch (e) { return { ok: false, message: (e as Error).message }; }
}
export async function deleteFile(path: string): Promise<{ ok: boolean }> {
  try { const r = bounceIfLocked(await fetch('/api/files/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })); return await r.json(); } catch { return { ok: false }; }
}
/** A chat's folder, as the server names it. */
export function sessionFolder(session: string): string {
  return `serve/${session.replace(/[^a-z0-9_-]/gi, '')}`;
}
export interface FileShare { token: string; path: string; created: number; expires: number; }
/** Conversions a file offers for download (BL-70): html, docx, pdf for documents. */
export function exportUrl(path: string, format: string): string {
  return `/api/files/export?path=${encodeURIComponent(path)}&format=${format}`;
}
export async function getShares(path: string): Promise<FileShare[]> {
  try { const r = bounceIfLocked(await fetch(`/api/files/shares?path=${encodeURIComponent(path)}`)); return (await r.json()).shares ?? []; } catch { return []; }
}
export async function shareFile(path: string, days: number): Promise<{ ok: boolean; share?: FileShare; message?: string }> {
  try { const r = bounceIfLocked(await fetch('/api/files/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, days }) })); return await r.json(); } catch (e) { return { ok: false, message: (e as Error).message }; }
}
export async function unshareFile(token: string): Promise<{ ok: boolean }> {
  try { const r = bounceIfLocked(await fetch('/api/files/unshare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })); return await r.json(); } catch { return { ok: false }; }
}
export function shareLink(token: string): string { return `${location.origin}/s/${token}`; }
