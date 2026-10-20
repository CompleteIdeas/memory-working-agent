/**
 * BL-62 — the agent walks the person through connecting an account (src/connect/setup.ts). It can start a
 * connection and say how it went; it never sees or handles a password, key or token — those go into a setup card.
 */
import type { RegisteredTool } from './registry.js';
import { findService, openSetupRequest, openVaultRequest, connectionSummary, listSetupRequests, setupServices } from '../connect/setup.js';
import { vaultList, vaultForget, vaultName } from '../vault/vault.js';

export function connectTools(): RegisteredTool[] {
  return [
    {
      def: {
        name: 'connect_account',
        description: 'Start connecting one of the person\'s accounts or services when THEY ask (e.g. "connect my Outlook", "set up Gmail", "hook up Telegram", "add GitHub"). '
          + 'Name the service; MWA knows what it needs. Outlook usually needs no password: you get a short sign-in code to give the person. Anything secret (a password, key or token) '
          + 'is typed by the person into a setup card in the app, never into the chat: tell them to use the card, and never ask them to paste a secret into a message. '
          + 'Call it again with the same service to see whether they finished.',
        parameters: { type: 'object', properties: { service: { type: 'string', description: 'gmail, outlook, telegram, or a connector id from list_connectors (github, notion, …)' } }, required: ['service'] },
      },
      handler: async (args, ctx) => {
        // Only for a person who is here and asked: not a scheduled run, and not a run steered by an email or page.
        if (ctx.interactive === false) return '(refused: connecting an account needs the person there — offer it next time they message.)';
        if (ctx.tainted) return '(refused: this conversation has read outside content (an email or a page), so I won\'t start a sign-in from it. If you want to connect something, ask me in a new message.)';
        const svc = findService(String(args.service ?? ''));
        if (!svc) return `I can connect: ${setupServices().map((s) => s.id).join(', ')}. Which one?`;
        let on = false;
        try { on = svc.connected(); } catch { return 'Setting up connections from chat needs the MWA app running (mwa serve). Use its Connections page.'; }
        const last = listSetupRequests().find((r) => r.service === svc.id && r.status !== 'waiting');
        if (on) return `${svc.name} is already connected.${last?.status === 'done' ? ` ${last.message}` : ''}`;
        if (svc.start) {
          try {
            const s = await svc.start();
            if (s.ok) return `Tell the person, in your own words: ${s.message}`;
          } catch (e) { return `Starting the ${svc.name} sign-in failed: ${(e as Error).message.slice(0, 160)}`; }
        }
        const r = openSetupRequest(svc, ctx.session);
        const prior = last && last.createdAt > Date.now() - 30 * 60_000 && last.status === 'failed' ? `\nThe last attempt didn't work: ${last.message}` : '';
        return [
          `A setup card for ${svc.name} is now showing in the MWA app (above the chat box). Walk the person through it:`,
          svc.howTo,
          `The card asks for: ${r.fields.map((f) => `${f.label}${f.optional ? ' (optional)' : ''}`).join('; ')}.`,
          'Tell them to type these into the card, not into this chat. When they say they did it, call connect_account again to check.',
        ].join('\n') + prior;
      },
    },
    // BL-63: the vault — saved logins and keys the agent uses without seeing them.
    {
      def: {
        name: 'vault_list',
        description: 'The logins and keys the person has saved in the vault: each entry\'s name, the site it is for, and its field names (never the values). Use a saved value in a tool by writing {{vault:<entry>.<field>}} where it goes, e.g. an Authorization header in http_request; MWA fills it in only for that entry\'s own site.',
        parameters: { type: 'object', properties: {} },
      },
      handler: async () => {
        const all = vaultList();
        if (!all.length) return 'The vault is empty. To save a login or key, call vault_request when the person asks.';
        return all.map((e) => `• ${e.name}${e.site ? ` (for ${e.site})` : ''}: ${e.fields.map((f) => `{{vault:${e.name}.${f}}}`).join(', ')}`).join('\n');
      },
    },
    {
      def: {
        name: 'vault_request',
        description: 'Ask the person to save a login, password, API key or token into the vault, when THEY want you to be able to use it (e.g. "remember my USEA portal login", "here is the API key for…"). Opens a card in the app where they type it; it is stored encrypted and you never see it. '
          + 'Never ask the person to paste a secret into the chat. If they already did, tell them to change it and save the new one here.',
        parameters: { type: 'object', properties: {
          name: { type: 'string', description: 'a short name for the entry, e.g. "usea-portal"' },
          site: { type: 'string', description: 'the website or API host it is for, e.g. "portal.useventing.com" — it will only ever be sent there' },
          fields: { type: 'array', items: { type: 'string' }, description: 'what to ask for, e.g. ["username", "password"] or ["api key"]' },
        }, required: ['name', 'site'] },
      },
      handler: async (args, ctx) => {
        if (ctx.interactive === false) return '(refused: saving to the vault needs the person there.)';
        if (ctx.tainted) return '(refused: this conversation has read outside content (an email or a page), so I won\'t ask for a password from it. If you want to save one, ask me in a new message.)';
        const name = vaultName(String(args.name ?? ''));
        if (!name) return 'Give the entry a short name.';
        const site = String(args.site ?? '').trim() || undefined;
        const fields = Array.isArray(args.fields) ? args.fields.map(String).filter(Boolean) : [];
        const r = openVaultRequest(name, site, fields, ctx.session);
        return `A vault card for "${name}"${site ? ` (${site})` : ''} is now showing in the MWA app, above the chat box. Tell the person to type ${r.fields.map((f) => f.label).join(' and ')} there, not in this chat. Once saved, use it as ${r.fields.map((f) => `{{vault:${name}.${f.env}}}`).join(', ')}.`;
      },
    },
    {
      def: {
        name: 'vault_forget',
        description: 'Delete a saved vault entry when the person asks.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      handler: async (args, ctx) => {
        if (ctx.interactive === false || ctx.tainted) return '(refused: only the person, in a clean conversation, can delete a vault entry.)';
        return vaultForget(String(args.name ?? '')) ? `Deleted "${vaultName(String(args.name))}" from the vault.` : `No vault entry "${String(args.name ?? '')}".`;
      },
    },
    {
      def: {
        name: 'connection_status',
        description: 'Which of the person\'s accounts and services are connected (email, Outlook, Telegram, connectors), and any setup card still waiting.',
        parameters: { type: 'object', properties: {} },
      },
      handler: async () => {
        try { return connectionSummary(); } catch { return 'Connection status is shown in the MWA app (Connections page).'; }
      },
    },
  ];
}
