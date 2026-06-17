# Embedding MWA as a backend / library

MWA is both a complete product (`mwa serve`) **and** a harness you build your own
agent on. The public API (`memory-working-agent`) exposes the pieces you compose:
the agent loop, the AWM-backed memory, the cost-tiered provider router, and the
tool registry. Your "agent" becomes a thin domain layer on top.

```ts
import {
  runAgent, MwaMemory, getProvider, RoutedProvider, buildRegistry, loadConfig,
} from 'memory-working-agent';

const cfg = loadConfig();                                  // mwa.config.json (+ env)
const memory = new MwaMemory('my-agent', './data/agent.db', cfg.awm.workspace);
const brain  = new RoutedProvider(getProvider('brain'), getProvider('high')); // cheap→strong
const worker = new RoutedProvider(getProvider('brain'), getProvider('high'));
const { registry, close } = await buildRegistry(cfg);     // built-ins + MCP + manage tools

const result = await runAgent({
  instruction: 'Summarize today’s open tickets and draft a reply to the oldest.',
  dir: './work',
  memory, brain, worker, tools: registry,
  interactive: false,                 // unattended → ask_user notes + assumes; writes need approval
  domainPackDir: './my-domain',       // optional: AGENT.md + topics/*.md (progressive disclosure)
  budget: { maxSteps: 40, maxWallMs: 10 * 60_000, maxTokens: 400_000, consolidateEvery: 10 },
  onEvent: (type, data) => console.log(type, data),  // start|recall|tool|verify|done|…
});
console.log(result.reason, result.summary, result.costUsd);
await close();   // shut down MCP child processes
memory.close();
```

## The key pieces

| Export | Role |
|---|---|
| `runAgent(opts)` | the live agent loop: PRIME (recall) → ACT (cost-tiered tools) → VERIFY (substance/approval gates) → LEARN (auto feedback/capture). Returns `{reason, summary, steps, costUsd, …}`. |
| `MwaMemory` | the AWM substrate (in-process). Pass a `workspace` for cross-agent shared recall. `NullMemory` disables it. |
| `getProvider(role)` + `RoutedProvider` | provider resolution from config + the cheap→strong tier router (escalates on struggle). |
| `buildRegistry(cfg)` | the tool registry: built-ins + MCP servers + the runtime tool-management tools. Register your own `RegisteredTool`s too. |
| `requireApproval(tool)` | wrap a write/irreversible tool so it previews then runs only after `confirm_action` (chat) or `/api/approvals/confirm` (UI). |

## Plugging in a domain (the "new agent")

A **domain pack** is a folder with `AGENT.md` (persona + rules) and `topics/*.md`
(scored by relevance, top-N injected per task). Point `runAgent({ domainPackDir })`
at it — no code change. Add domain tools by registering `RegisteredTool`s into the
registry (wrap any DB/write tool in `requireApproval`). This is how a domain agent
is built on MWA without forking the harness.

## Safety knobs (set for unattended use)

- `budget.maxTokens` / `maxWallMs` / `maxSteps` — hard caps per run.
- `interactive: false` for scheduled/unattended runs — `confirm_action` then refuses
  to execute writes unless `MWA_ALLOW_UNATTENDED_WRITES=1`.
- access preset (`mwa.config.json` `tools.access`) — `locked-down` / `assistant` /
  `developer` gate `run_command` + file reach.
