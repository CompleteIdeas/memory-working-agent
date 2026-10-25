/**
 * Tool registry — the pluggable tooling layer. A tool is just a ToolDef (the
 * schema the model sees) + a handler (what runs). This shape matches MCP's tool
 * model 1:1 (name / description / inputSchema → call(name, args) → result), so the
 * Phase-2 MCP bridge registers an MCP server's tools as RegisteredTools with a
 * handler that proxies to the MCP client — additive, no rewrite.
 *
 * The brain merges registry.defs() into its native tool list; when the model calls
 * a registered tool, the loop runs registry.call(name, args, ctx) and feeds the
 * result back. Built-in orchestration tools (dispatch/recall/read/supersede/done)
 * stay in the brain; the registry is for ACTION/domain tools (run_command, http, …).
 */
import type { ToolDef } from '../provider.js';

export interface ToolContext {
  sandboxDir: string;
  /** extra folders THIS run may touch, on top of the sandbox + the user's granted roots. The
   *  scheduler passes the folder a task was created in (see agent.ts `extraRoots`). */
  extraRoots?: string[];
  /** this run has read external content (BL-17) — a tool that writes lasting memory checks it. */
  tainted?: boolean;
  /** this run has read local content (a file, a dropped document) — goals refuse it too (BL-05). */
  readLocal?: boolean;
  /** whether a human is watching this run (gates run_command in Assistant mode). */
  interactive?: boolean;
  /** the resolved person this turn is for (S6) — used to gate sensitive confirms on step-up. */
  personId?: string;
  /** true when this person's identity is in doubt (S6 mismatch) — a sensitive confirm then requires
   *  a satisfied step-up (2nd factor via a validated connection). */
  identityInDoubt?: boolean;
  /** the run making this call — an action it stages can't be approved by the same run (BL-03). */
  runId?: string;
  /** the conversation this run belongs to (e.g. `tg-<chatId>`): where an approval is offered. */
  session?: string;
  /** BL-45/47: the person's own message this turn (not on a job's fire) — what a job change is kept as, and
   *  what a cancel must answer to. */
  personMessage?: string;
  /** BL-72: a background job's own request — the person's words that started it — for the approval reviewer, which
   *  otherwise sees no request on a job and judges its own `ls` "not what you asked for" (hard test 2026-10-23). */
  jobRequest?: string;
  /** BL-47: the job this run is a fire of (its lineage) — a fire may stop its own job. */
  jobId?: string;
  /** BL-52: the request classifier's reading — the person asks to change or stop an existing job. Absent when
   *  there is no reading (the cancel tool then goes by the person's words). */
  asksJobChange?: boolean;
  /** What this job may do although nobody is watching, given by the person when they set the job up (browser review
   *  2026-10-25): saved logins it may type on their own sites, and controls it may click that sign in, submit or pay. */
  jobAllow?: JobAllow;
  /** the model running this run's loop, so a tool knows whether it can see an image (`browser_look`). */
  brainModel?: string;
}

/** A job's allowance for unattended browser work: vault entry names, and "host + control text" pairs. */
export interface JobAllow { vault?: string[]; click?: { host: string; label: string }[] }

/** A tool's output with an image the model is to look at on its next step (`browser_look`). */
export interface ToolOutput { text: string; image?: { mime: 'image/jpeg' | 'image/png'; data: string } }
/** A handler's reply as text, for callers that run a handler directly. */
export const toolText = (out: string | ToolOutput): string => (typeof out === 'string' ? out : out.text);

export interface RegisteredTool {
  def: ToolDef;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolOutput>;
}

/**
 * A first-party handler's own refusal or failure (BL-16). Thrown, the registry flags the call `failed`
 * and passes the text through unchanged. For a tool classed EXTERNAL — one whose output is someone
 * else's text (`http_request`, `read_document`) — only that flag counts as a refusal, so without it
 * MWA's own "(refused: …)" from such a tool read as a successful action and the Glass Box over-reported.
 */
export class ToolRefusal extends Error {
  constructor(readonly text: string) { super(text); }
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(t: RegisteredTool): void {
    this.tools.set(t.def.name, t);
  }
  registerAll(ts: RegisteredTool[]): void {
    for (const t of ts) this.register(t);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  /** Tool schemas to merge into the model's tool list. */
  defs(): ToolDef[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  /** Run a registered tool; never throws — errors come back as a string the model can read. */
  async call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return (await this.callDetailed(name, args, ctx)).text;
  }

  /** As `call`, plus whether the REGISTRY itself failed the call (unknown tool, or the handler
   *  threw). A tool's own text can say anything — an MCP server or a fetched page can start with
   *  "(tool x failed: …)" — so this flag, not the text, is what says a call really failed. (BL-01:
   *  matching on text let an external tool fake a refusal and skip the action log and tripwires.) */
  async callDetailed(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ text: string; failed: boolean; image?: ToolOutput['image'] }> {
    const t = this.tools.get(name);
    if (!t) return { text: `(unknown tool: ${name})`, failed: true };
    try {
      const out = await t.handler(args ?? {}, ctx);
      if (out && typeof out === 'object' && typeof (out as ToolOutput).text === 'string') return { text: (out as ToolOutput).text, failed: false, ...((out as ToolOutput).image ? { image: (out as ToolOutput).image } : {}) };
      return { text: typeof out === 'string' ? out : JSON.stringify(out), failed: false };
    } catch (e) {
      if (e instanceof ToolRefusal) return { text: e.text, failed: true }; // MWA's own refusal, its words intact
      return { text: `(tool ${name} failed: ${(e as Error).message.slice(0, 200)})`, failed: true };
    }
  }
}
