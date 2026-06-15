/**
 * Self-install tooling — lets the agent browse the connector library and enable curated
 * connectors itself. Curated tier only (vetted, safe); installing from outside the library
 * (web/npm) goes through the installation-model review + approval gate (Phase 2), not here.
 * Every enable is appended to an install audit log.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { RegisteredTool } from './registry.js';
import { listConnectors, getConnector, enableConnector, enabledConnectorIds, missingSecrets, type ConnectorEntry } from '../connectors/registry.js';

function auditInstall(entry: ConnectorEntry): void {
  try {
    const p = process.env.MWA_INSTALL_LOG ?? resolve('./data/installs.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: Date.now(), id: entry.id, name: entry.name, tier: entry.tier, source: entry.source ?? 'bundled' }) + '\n');
  } catch { /* best-effort */ }
}

export function installerTools(): RegisteredTool[] {
  return [
    {
      def: {
        name: 'list_connectors',
        description: 'List connectors/services from the curated library that can be enabled (web search, reading web pages, file access in a chosen folder, GitHub, …). Each shows whether it is already on and what access it has. Optionally filter by a keyword.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'optional keyword filter' } } },
      },
      handler: async (args) => {
        const enabled = new Set(enabledConnectorIds());
        const rows = listConnectors(args.query ? String(args.query) : undefined).map((c) => {
          const need = (c.secrets ?? []).filter((s) => !s.optional).map((s) => s.label);
          return `${enabled.has(c.id) ? '[on] ' : '[  ] '}${c.id} — ${c.name}: ${c.description} (can touch: ${c.access})${need.length ? ` — needs ${need.join(', ')}` : ''}`;
        });
        return rows.join('\n') || '(no connectors match)';
      },
    },
    {
      def: {
        name: 'install_connector',
        description: 'Enable a connector from the curated library by its id (from list_connectors). Curated connectors are vetted and safe to enable. If it needs a key/secret that is not set yet, this returns what is needed — ask the user to add it (in Connections) first. Newly enabled tools become available on the next message.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      handler: async (args) => {
        const id = String(args.id ?? '');
        const entry = getConnector(id);
        if (!entry) return `No connector "${id}" in the library. Use list_connectors to see what's available.`;
        const miss = missingSecrets(entry);
        if (miss.length) return `"${entry.name}" needs ${miss.map((m) => `${m.label} (${m.env})`).join(', ')} before it can be enabled. Ask the user to add it in Connections, then try install_connector again.`;
        const r = enableConnector(id);
        if (r.ok) auditInstall(entry);
        return r.message;
      },
    },
  ];
}
