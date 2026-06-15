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
import { externalInstallState } from '../installer/policy.js';
import { reviewConnector } from '../installer/review.js';
import type { MwaConfig } from '../config.js';

function auditInstall(entry: ConnectorEntry): void {
  try {
    const p = process.env.MWA_INSTALL_LOG ?? resolve('./data/installs.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: Date.now(), id: entry.id, name: entry.name, tier: entry.tier, source: entry.source ?? 'bundled' }) + '\n');
  } catch { /* best-effort */ }
}

export function installerTools(cfg: MwaConfig): RegisteredTool[] {
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
          const state = enabled.has(c.id) ? 'ALREADY ON' : `OFF — to enable, call install_connector with id="${c.id}"`;
          return `• ${c.name} (id="${c.id}") — ${state}. ${c.description} Can touch: ${c.access}.${need.length ? ` Needs: ${need.join(', ')}.` : ''}`;
        });
        return `Connectors (ALREADY ON = enabled; OFF = not enabled yet):\n${rows.join('\n') || '(no connectors match)'}`;
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
    {
      def: {
        name: 'propose_connector',
        description: 'Propose installing a connector from OUTSIDE the curated library (an npm package the user found). This does NOT install anything — it runs a security review and returns a risk report for the USER to approve in Connections. Use only when the user explicitly asks for something not in list_connectors.',
        parameters: { type: 'object', properties: { source: { type: 'string', description: 'npm package name, e.g. "@scope/server-foo"' } }, required: ['source'] },
      },
      handler: async (args) => {
        const st = externalInstallState(cfg);
        if (!st.enabled) return `I can't install connectors from outside the library right now: ${st.reason}`;
        const source = String(args.source ?? '').trim();
        if (!source) return 'Tell me the npm package name to review.';
        const rep = await reviewConnector(source, cfg);
        return [
          `Security review of "${rep.source}" — verdict: ${rep.verdict.toUpperCase()} (reviewed by ${rep.model}).`,
          rep.summary,
          `Red flags: ${rep.redFlags.join('; ') || 'none found'}`,
          `What it could do: ${rep.capabilities.join('; ') || 'unclear'}`,
          '',
          `NOT installed yet — the user must approve it in Connections (it will be pinned to ${rep.pinnedVersion ?? 'the reviewed version'}). Running it executes third-party code on this machine.`,
        ].join('\n');
      },
    },
  ];
}
