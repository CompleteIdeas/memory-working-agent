import { useEffect, useRef, useState } from 'react';
import {
  getConnections, toggleTool, connectGmail, connectOutlook, saveGoogle, saveMicrosoft,
  type Connections as Conn,
} from '../api';

// Turn tools & accounts on without editing files. Email uses a GUIDED bring-your-own
// sign-in: you make a free app at Google/Microsoft (one time), paste the ID, and approve —
// the token stays on this machine, never on our servers. No managed broker (it would mean
// a per-user cost + third-party token custody we won't take on for an open project); a
// homegrown `mwa connect` helper will make this near-turnkey (see docs/connect-email.md).
// The sign-in opens a window on THIS computer, so connect from the machine running MWA.

type Provider = 'google' | 'microsoft';

interface ProviderUI {
  key: 'gmail' | 'outlook';
  name: string;
  sub: string;
  steps: React.ReactNode;
  fields: { id: string; label: string; placeholder: string }[];
}

const REDIRECT_MS = 'http://localhost:7798/oauth';

const PROVIDERS: Record<Provider, ProviderUI> = {
  google: {
    key: 'gmail', name: 'Google (Gmail & Calendar)', sub: 'Read & draft — never sends',
    fields: [
      { id: 'clientId', label: 'Client ID', placeholder: '…apps.googleusercontent.com' },
      { id: 'clientSecret', label: 'Client secret', placeholder: 'GOCSPX-…' },
    ],
    steps: (
      <ol className="list-decimal ml-4 space-y-1.5 text-sm text-dim">
        <li>Open the <a className="text-signal underline" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud Console</a> and create (or pick) a project.</li>
        <li>Enable the <a className="text-signal underline" href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">Gmail API</a> and <a className="text-signal underline" href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noreferrer">Calendar API</a>.</li>
        <li>Under <span className="mono text-[12px]">Credentials → Create OAuth client ID</span>, choose application type <b>Desktop app</b>.</li>
        <li>On the consent screen, keep it in <b>Testing</b> and add your own email as a test user.</li>
        <li>Copy the <b>Client ID</b> and <b>Client secret</b> below.</li>
      </ol>
    ),
  },
  microsoft: {
    key: 'outlook', name: 'Microsoft (Outlook & Calendar)', sub: 'Read & draft — never sends',
    fields: [
      { id: 'clientId', label: 'Application (client) ID', placeholder: '11111111-2222-3333-4444-555555555555' },
    ],
    steps: (
      <ol className="list-decimal ml-4 space-y-1.5 text-sm text-dim">
        <li>Open the <a className="text-signal underline" href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Azure App registrations</a> → <b>New registration</b>.</li>
        <li>Supported accounts: <b>“Accounts in any org directory and personal Microsoft accounts.”</b></li>
        <li>Add a redirect URI — platform <b>Mobile &amp; desktop applications</b> — exactly:
          <code className="block mono text-[12px] bg-bone border border-line rounded px-2 py-1 mt-1 select-all">{REDIRECT_MS}</code>
        </li>
        <li>Under <span className="mono text-[12px]">API permissions</span> add Graph <b>delegated</b>: Mail.ReadWrite, Calendars.ReadWrite, User.Read, offline_access.</li>
        <li>Copy the <b>Application (client) ID</b> below.</li>
      </ol>
    ),
  },
};

function EmailConnect({ provider, connected, onDone }: { provider: Provider; connected: boolean; onDone: () => void }) {
  const ui = PROVIDERS[provider];
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [readonly, setReadonly] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  async function saveAndConnect() {
    setBusy(true); setMsg('Saving…');
    const save = provider === 'google'
      ? await saveGoogle(vals.clientId ?? '', vals.clientSecret ?? '')
      : await saveMicrosoft(vals.clientId ?? '');
    if (!save.ok) { setMsg(save.message ?? 'Could not save.'); setBusy(false); return; }
    setMsg('Opening sign-in…');
    const r = provider === 'google' ? await connectGmail(readonly) : await connectOutlook(readonly);
    if (!r.ok || !r.url) { setMsg(r.message ?? 'Could not start sign-in.'); setBusy(false); return; }
    window.open(r.url, '_blank', 'noopener');
    setMsg('Approve access in the window that opened, then come back here…');
    let tries = 0;
    poll.current = window.setInterval(async () => {
      tries++;
      const c = await getConnections();
      if (c[ui.key]) { if (poll.current) clearInterval(poll.current); setMsg(''); setBusy(false); setOpen(false); onDone(); }
      else if (tries > 48) { if (poll.current) clearInterval(poll.current); setMsg('Still not connected — finish the sign-in, or try again.'); setBusy(false); }
    }, 2500);
  }

  return (
    <div className="rounded-[4px] border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div><div className="font-medium">{ui.name}</div><div className="text-dim text-sm">{ui.sub}</div></div>
        {connected
          ? <span className="mono text-[12px] text-signal">connected ✓</span>
          : <button onClick={() => setOpen((o) => !o)} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium">{open ? 'Cancel' : 'Set up'}</button>}
      </div>
      {open && !connected && (
        <div className="border-t border-line px-4 py-4 space-y-3">
          {ui.steps}
          <div className="space-y-2 pt-1">
            {ui.fields.map((f) => (
              <input key={f.id} value={vals[f.id] ?? ''} placeholder={f.placeholder}
                onChange={(e) => setVals((v) => ({ ...v, [f.id]: e.target.value }))}
                className="w-full rounded-[3px] border border-line bg-bone px-3 py-2 text-sm outline-none focus:border-signal" />
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-dim">
            <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} className="w-4 h-4 accent-[var(--color-signal)]" />
            Read-only (don’t let it draft replies)
          </label>
          <button disabled={busy} onClick={saveAndConnect} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
            {busy ? 'Working…' : 'Save & connect'}
          </button>
          <p className="mono text-[11px] text-dim">The sign-in opens on this computer — connect from the machine running MWA.</p>
          {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
        </div>
      )}
    </div>
  );
}

export function Connections() {
  const [c, setC] = useState<Conn | null>(null);
  const load = () => getConnections().then(setC);
  useEffect(() => { load(); }, []);

  async function flip(id: string, on: boolean) {
    setC((prev) => prev ? { ...prev, tools: prev.tools.map((t) => (t.id === id ? { ...t, on } : t)) } : prev);
    await toggleTool(id, on);
  }

  if (!c) return <div className="py-16 mono text-dim text-sm">loading…</div>;
  const row = 'flex items-center justify-between gap-3 rounded-[4px] border border-line bg-surface px-4 py-3';

  return (
    <div className="py-8 max-w-xl space-y-6">
      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">email & calendar</div>
        <div className="space-y-2">
          <EmailConnect provider="google" connected={c.gmail} onDone={load} />
          <EmailConnect provider="microsoft" connected={c.outlook} onDone={load} />
          <div className={row}>
            <div><div className="font-medium">Telegram</div><div className="text-dim text-sm">Chat with it from your phone</div></div>
            <span className={`mono text-[12px] ${c.telegram ? 'text-signal' : 'text-dim'}`}>{c.telegram ? 'connected ✓' : 'not set up'}</span>
          </div>
        </div>
      </div>

      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">tools</div>
        <div className="space-y-2">
          {c.tools.map((t) => (
            <label key={t.id} className={row + ' cursor-pointer'}>
              <div><div className="font-medium">{t.label}</div><div className="text-dim text-sm">{t.desc}</div></div>
              <input type="checkbox" checked={t.on} onChange={(e) => flip(t.id, e.target.checked)} className="w-5 h-5 accent-[var(--color-signal)]" />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
