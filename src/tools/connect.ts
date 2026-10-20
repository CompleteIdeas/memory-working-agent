/**
 * BL-62 — the agent walks the person through connecting an account (src/connect/setup.ts). It can start a
 * connection and say how it went; it never sees or handles a password, key or token — those go into a setup card.
 */
import type { RegisteredTool } from './registry.js';
import { findService, openSetupRequest, connectionSummary, listSetupRequests, setupServices } from '../connect/setup.js';

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
