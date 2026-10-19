// MCP face of the simulated world (eval/world.mjs) for the MWA arms: `node world-server.mjs gmail|calendar|web`.
// Reads WORLD_FILE, logs to WORLD_LOG, and keeps virtual time through the clock shim.
import './clock-shim.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeWorld, MODES } from './world.mjs';

const mode = process.argv[2];
if (!MODES[mode]) { console.error(`mode must be one of ${Object.keys(MODES).join(', ')}`); process.exit(2); }
const { tools } = makeWorld(process.env.WORLD_FILE, process.env.WORLD_LOG);
const mine = MODES[mode];

const server = new Server({ name: mode, version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: mine.map((name) => ({
    name,
    description: tools[name].description,
    inputSchema: tools[name].parameters,
    ...(tools[name].readOnly ? { annotations: { readOnlyHint: true } } : {}),
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = mine.includes(req.params.name) ? tools[req.params.name] : null;
  if (!t) return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
  try { return { content: [{ type: 'text', text: String(t.run(req.params.arguments ?? {})) }] }; }
  catch (e) { return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }; }
});
await server.connect(new StdioServerTransport());
