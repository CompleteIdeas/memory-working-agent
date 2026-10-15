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
  /** whether a human is watching this run (gates run_command in Assistant mode). */
  interactive?: boolean;
  /** the resolved person this turn is for (S6) — used to gate sensitive confirms on step-up. */
  personId?: string;
  /** true when this person's identity is in doubt (S6 mismatch) — a sensitive confirm then requires
   *  a satisfied step-up (2nd factor via a validated connection). */
  identityInDoubt?: boolean;
}

export interface RegisteredTool {
  def: ToolDef;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
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
  async callDetailed(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ text: string; failed: boolean }> {
    const t = this.tools.get(name);
    if (!t) return { text: `(unknown tool: ${name})`, failed: true };
    try {
      const out = await t.handler(args ?? {}, ctx);
      return { text: typeof out === 'string' ? out : JSON.stringify(out), failed: false };
    } catch (e) {
      return { text: `(tool ${name} failed: ${(e as Error).message.slice(0, 200)})`, failed: true };
    }
  }
}
