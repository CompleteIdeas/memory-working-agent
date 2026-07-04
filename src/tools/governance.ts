/**
 * F3 Governance — semantic classification of agent actions + runtime tripwires + the plain-language
 * "here's what I did" report. The Approve half (dry-run → human confirm) lives in approval.ts; this
 * module adds the WHAT-kind-of-action awareness that makes approval and explanation smart, plus
 * trajectory tripwires that pause a run before it does too much (the "execution authorization" layer
 * the field keeps rediscovering). All pure + dependency-free so it is fully unit-testable.
 */

export type ActionCategory = 'read' | 'write-local' | 'execute' | 'external' | 'schedule' | 'memory' | 'control';

// Map the real MWA tool names (builtins + connectors) to a semantic category.
const TOOL_CATEGORY: Record<string, ActionCategory> = {
  list_files: 'read', read_file: 'read', read_document: 'read', read_email: 'read', search_email: 'read', web_search: 'read',
  // Warm-start: reads the owner's OWN granted-folder docs (trusted, like read_file) — a local read,
  // NOT egress, and deliberately absent from UNTRUSTED_CONTENT_TOOLS so seed memories stay canonical.
  onboard_scan: 'read', onboard_questions: 'read',
  write_file: 'write-local',
  run_command: 'execute',
  http_request: 'external', draft_email: 'external', send_email: 'external',
  schedule: 'schedule',
  remember: 'memory', supersede: 'memory',
  ask_user: 'control', done: 'control', confirm_action: 'control', cancel_action: 'control', list_pending: 'control',
};

/** Classify a tool by what it does to the world. Unknown tools are treated as 'external' — the most
 *  cautious bucket — so a newly self-installed tool is governed by default, not silently trusted. */
export function classifyTool(name: string): ActionCategory {
  return TOOL_CATEGORY[String(name)] ?? 'external';
}

/** The coarse reach used by the SPINE action log + the Glass Box "what I did" view. */
export function effectOf(name: string): 'external' | 'local' | 'read' {
  const c = classifyTool(name);
  if (c === 'read') return 'read';
  if (c === 'external') return 'external';
  return 'local';
}

// Categories that change the user's machine or reach outside it — what governance watches/gates.
const SENSITIVE = new Set<ActionCategory>(['write-local', 'execute', 'external', 'schedule']);
/** True when a tool changes the world (vs a read/control no-op) — the gate/explain trigger. */
export function isSensitive(name: string): boolean { return SENSITIVE.has(classifyTool(name)); }

// Tools that pull in UNTRUSTED external content (an inbox, the open web, a fetched URL). A fact the
// agent `remember`s after using one of these inherits untrusted lineage — otherwise inbox/web text
// laundered through the model's own synthesis would be stored at medium trust (the transition path
// already inherits 'ingested'; this closes the same gap for the remember path).
const UNTRUSTED_CONTENT_TOOLS = new Set(['read_email', 'read_document', 'web_search', 'search_email', 'http_request']);
export function readsUntrustedContent(name: string): boolean { return UNTRUSTED_CONTENT_TOOLS.has(String(name)); }

export interface ActionLike { verb?: string; tool?: string; effect?: 'external' | 'local' | 'read' }
function reachOf(a: ActionLike): 'external' | 'local' | 'read' { return a.effect ?? effectOf(a.tool ?? ''); }

export interface TripwireConfig { maxExternal?: number; maxLocalWrites?: number }
export interface TripwireResult { tripped: boolean; reason?: string }

/**
 * Watch the run's TRAJECTORY (not just the next action) and pause-and-ask when it crosses a
 * threshold — the defense against an agent that quietly does too much (touches 50 files, fires
 * 10 outbound actions) before anyone notices. Distinct from per-action approval: this is cumulative.
 */
export function checkTripwires(actions: ActionLike[], cfg: TripwireConfig = {}): TripwireResult {
  const maxExternal = cfg.maxExternal ?? 3;
  const maxLocal = cfg.maxLocalWrites ?? 12;
  const ext = actions.filter((a) => reachOf(a) === 'external').length;
  if (ext > maxExternal) return { tripped: true, reason: `I've reached outside your machine ${ext} times (limit ${maxExternal}) — pausing to check with you before doing more.` };
  const local = actions.filter((a) => reachOf(a) === 'local').length;
  if (local > maxLocal) return { tripped: true, reason: `I've made ${local} changes on your machine (limit ${maxLocal}) — pausing to check with you before doing more.` };
  return { tripped: false };
}

/**
 * Plain-language "here's what I did" — groups actions by reach and foregrounds outward/irreversible
 * ones, so a run nobody watched still ends with an honest, scannable account (the cold-review report).
 */
export function buildDoneReport(actions: ActionLike[]): string {
  if (!actions.length) return '';
  const label = (a: ActionLike) => (a.verb ?? a.tool ?? '').trim();
  const ext = actions.filter((a) => reachOf(a) === 'external').map(label).filter(Boolean);
  const local = actions.filter((a) => reachOf(a) === 'local').map(label).filter(Boolean);
  const parts: string[] = [];
  if (ext.length) parts.push(`· Reached outside your machine: ${ext.join('; ')}`);
  if (local.length) parts.push(`· Changed things here: ${local.join('; ')}`);
  return parts.length ? `What I did:\n${parts.join('\n')}` : '';
}
