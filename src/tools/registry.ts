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
    const t = this.tools.get(name);
    if (!t) return `(unknown tool: ${name})`;
    try {
      const out = await t.handler(args ?? {}, ctx);
      return typeof out === 'string' ? out : JSON.stringify(out);
    } catch (e) {
      return `(tool ${name} failed: ${(e as Error).message.slice(0, 200)})`;
    }
  }
}
