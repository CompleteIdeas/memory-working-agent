import { useEffect, useRef, useState } from 'react';
import {
  getConnections, connectGmail, connectOutlook, saveGoogle, saveMicrosoft, saveTelegram,
  enableConnector, disableConnector, saveConnectorSecret, reviewExternal, approveExternal, saveAccess,
  type Connections as Conn, type ConnectorItem, type ExternalInstall, type RiskReport, type Access, type AccessPreset,
} from '../api';

const ACCESS_PRESETS: { id: AccessPreset; label: string; detail: string }[] = [
  { id: 'locked-down', label: 'Locked-down', detail: 'Workspace only · never runs commands' },
  { id: 'assistant', label: 'Assistant', detail: 'Workspace + folders you grant · runs commands only while you watch' },
  { id: 'developer', label: 'Developer', detail: 'Broad file access · runs commands freely' },
];

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

function TelegramConnect({ connected, onDone }: { connected: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function save() {
    setBusy(true); setMsg('Checking the bot token…');
    const r = await saveTelegram(token.trim());
    if (r.ok) { setMsg(''); setBusy(false); setOpen(false); setToken(''); onDone(); }
    else { setMsg(r.message ?? 'Could not connect.'); setBusy(false); }
  }
  return (
    <div className="rounded-[4px] border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div><div className="font-medium">Telegram</div><div className="text-dim text-sm">Chat with it from your phone</div></div>
        {connected
          ? <span className="mono text-[12px] text-signal">connected ✓</span>
          : <button onClick={() => setOpen((o) => !o)} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium">{open ? 'Cancel' : 'Set up'}</button>}
      </div>
      {open && !connected && (
        <div className="border-t border-line px-4 py-4 space-y-3">
          <ol className="list-decimal ml-5 text-sm text-dim space-y-1">
            <li>In Telegram, message <a className="text-signal underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> and send <span className="mono text-[12px]">/newbot</span>.</li>
            <li>Copy the <b>bot token</b> it gives you and paste it below.</li>
          </ol>
          <input value={token} placeholder="123456789:ABCdef…" onChange={(e) => setToken(e.target.value)}
            className="w-full rounded-[3px] border border-line bg-bone px-3 py-2 text-sm outline-none focus:border-signal" />
          <button disabled={busy || !token.trim()} onClick={save} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
            {busy ? 'Working…' : 'Save & connect'}
          </button>
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

  if (!c) return <div className="py-16 mono text-dim text-sm">loading…</div>;
  const row = 'flex items-center justify-between gap-3 rounded-[4px] border border-line bg-surface px-4 py-3';

  return (
    <div className="py-8 max-w-xl space-y-6">
      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">email & calendar</div>
        <div className="space-y-2">
          <EmailConnect provider="google" connected={c.gmail} onDone={load} />
          <EmailConnect provider="microsoft" connected={c.outlook} onDone={load} />
          <TelegramConnect connected={c.telegram} onDone={load} />
        </div>
      </div>

      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">connector library</div>
        <p className="text-dim text-sm mb-2">Vetted connectors — turn on what you need. Each shows what it can touch.</p>
        <div className="space-y-2">
          {c.connectors.map((k) => <ConnectorCard key={k.id} k={k} onChange={load} />)}
        </div>
      </div>

      <AccessPanel access={c.access} onChange={load} />
      <ExternalInstaller ext={c.externalInstall} onChange={load} />
    </div>
  );
}

function AccessPanel({ access, onChange }: { access: Access; onChange: () => void }) {
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const roots = access?.grantedRoots ?? [];

  async function setPreset(p: AccessPreset) { setBusy(true); await saveAccess(p, roots); setBusy(false); onChange(); }
  async function addFolder() {
    const f = folder.trim(); if (!f) return;
    setBusy(true); setMsg('');
    const r = await saveAccess(access.preset, [...roots, f]);
    setBusy(false); setFolder(''); setMsg(r.message && r.message !== 'Saved.' ? r.message : ''); onChange();
  }
  async function removeFolder(f: string) { setBusy(true); await saveAccess(access.preset, roots.filter((x) => x !== f)); setBusy(false); onChange(); }

  return (
    <div>
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">what it can touch on this computer</div>
      <div className="space-y-2">
        {ACCESS_PRESETS.map((a) => (
          <button key={a.id} onClick={() => setPreset(a.id)} disabled={busy}
            className={`w-full text-left rounded-[4px] border px-4 py-3 transition-colors disabled:opacity-60 ${access?.preset === a.id ? 'border-signal bg-surface' : 'border-line bg-surface hover:border-signal/60'}`}>
            <div className="font-medium">{a.label}{access?.preset === a.id ? ' ✓' : ''}</div>
            <div className="text-dim text-sm">{a.detail}</div>
          </button>
        ))}
      </div>
      {access?.preset !== 'locked-down' && (
        <div className="mt-3 rounded-[4px] border border-line bg-surface px-4 py-3">
          <div className="text-sm font-medium mb-1">Granted folders</div>
          {roots.length ? roots.map((f) => (
            <div key={f} className="flex items-center justify-between gap-2 text-sm py-1">
              <span className="mono text-[12px] break-all">{f}</span>
              <button onClick={() => removeFolder(f)} disabled={busy} className="mono text-[11px] text-signal underline shrink-0">remove</button>
            </div>
          )) : <p className="text-dim text-sm">None yet — the assistant can only use its own workspace.</p>}
          <div className="flex gap-2 mt-2">
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\you\Documents"
              className="flex-1 rounded-[3px] border border-line bg-bone px-3 py-2 text-sm mono outline-none focus:border-signal" />
            <button onClick={addFolder} disabled={busy || !folder.trim()} className="rounded-[3px] border border-line px-3 py-2 text-sm font-medium disabled:opacity-50">Grant</button>
          </div>
          {msg && <p className="mono text-[12px] text-signal mt-1">{msg}</p>}
        </div>
      )}
    </div>
  );
}

const VERDICT_STYLE: Record<string, string> = { safe: 'text-green-700', caution: 'text-amber-600', dangerous: 'text-signal' };

function ExternalInstaller({ ext, onChange }: { ext: ExternalInstall; onChange: () => void }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [report, setReport] = useState<RiskReport | null>(null);

  async function review() {
    setBusy(true); setMsg(''); setReport(null);
    const r = await reviewExternal(source.trim());
    setBusy(false);
    if (!r.ok || !r.report) { setMsg(r.message ?? 'Could not review.'); return; }
    setReport(r.report);
  }
  async function approve() {
    if (!report) return;
    setBusy(true); setMsg('Installing…');
    const r = await approveExternal(report.source, report.pinnedVersion, report.verdict, report.integrity);
    setBusy(false); setMsg(r.message ?? '');
    if (r.ok) { setReport(null); setSource(''); onChange(); }
  }

  return (
    <div>
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">add from npm</div>
      {!ext.enabled ? (
        <p className="text-dim text-sm rounded-[4px] border border-line bg-surface px-4 py-3">{ext.reason}</p>
      ) : (
        <div className="rounded-[4px] border border-line bg-surface px-4 py-3 space-y-3">
          <p className="text-dim text-sm">Install a connector that isn’t in the library. It’s reviewed by your model ({ext.model}) first — then you approve. Running it executes third-party code on this machine.</p>
          <div className="flex gap-2">
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="npm package, e.g. @scope/server-name"
              className="flex-1 rounded-[3px] border border-line bg-bone px-3 py-2 text-sm outline-none focus:border-signal" />
            <button onClick={review} disabled={busy || !source.trim()} className="rounded-[3px] border border-line px-3 py-2 text-sm font-medium disabled:opacity-50">{busy && !report ? 'Reviewing…' : 'Review'}</button>
          </div>
          {report && (
            <div className="border-t border-line pt-3 space-y-1.5">
              <div className="text-sm">Verdict: <b className={VERDICT_STYLE[report.verdict] ?? ''}>{report.verdict.toUpperCase()}</b> <span className="text-dim">· pinned {report.pinnedVersion ?? '?'}</span></div>
              {report.deepScan && (
                <p className="text-[12px] text-dim">{report.deepScan.ran
                  ? `Source scan: ${report.deepScan.filesScanned} files · checksum ${report.deepScan.integrityOk === undefined ? 'unknown' : report.deepScan.integrityOk ? 'verified ✓' : 'MISMATCH ✗'}`
                  : `Source scan skipped (${report.deepScan.note})`}</p>
              )}
              <p className="text-sm">{report.summary}</p>
              {!!report.redFlags.length && <p className="text-[13px] text-dim">Red flags: {report.redFlags.join('; ')}</p>}
              {!!report.capabilities.length && <p className="text-[13px] text-dim">Could do: {report.capabilities.join('; ')}</p>}
              <button onClick={approve} disabled={busy} className={`mt-1 rounded-[3px] px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${report.verdict === 'dangerous' ? 'bg-red-700' : 'bg-signal'}`}>
                {report.verdict === 'dangerous' ? 'Install anyway (risky)' : `Approve & install ${report.source}`}
              </button>
            </div>
          )}
          {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function ConnectorCard({ k, onChange }: { k: ConnectorItem; onChange: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const reqUnset = k.secrets.filter((s) => !s.optional && !s.set);
  const [open, setOpen] = useState(false);

  async function toggle() {
    setMsg(''); setBusy(true);
    if (k.on) { await disableConnector(k.id); setBusy(false); onChange(); return; }
    if (reqUnset.length) { setOpen(true); setBusy(false); return; } // need secrets first
    const r = await enableConnector(k.id); setBusy(false); setMsg(r.ok ? '' : (r.message ?? 'Could not enable.')); onChange();
  }
  async function saveSecretsAndEnable() {
    setBusy(true); setMsg('Saving…');
    for (const s of k.secrets) { const v = vals[s.env]; if (v) { const r = await saveConnectorSecret(s.env, v); if (!r.ok) { setMsg(r.message ?? 'Could not save.'); setBusy(false); return; } } }
    const r = await enableConnector(k.id); setBusy(false);
    if (r.ok) { setOpen(false); setMsg(''); onChange(); } else setMsg(r.message ?? 'Could not enable.');
  }

  return (
    <div className="rounded-[4px] border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div>
          <div className="font-medium">{k.name} <span className="mono text-[10px] text-dim uppercase">{k.tier}</span></div>
          <div className="text-dim text-sm">{k.description}</div>
          <div className="text-dim text-[12px] mt-0.5">Can touch: {k.access}</div>
        </div>
        <button onClick={toggle} disabled={busy}
          className={`shrink-0 rounded-[3px] px-3 py-1.5 text-sm font-medium ${k.on ? 'border border-line text-dim' : 'bg-signal text-white'} disabled:opacity-50`}>
          {k.on ? 'On — turn off' : (reqUnset.length ? 'Set up' : 'Turn on')}
        </button>
      </div>
      {open && !k.on && (
        <div className="border-t border-line px-4 py-3 space-y-2">
          {k.secrets.map((s) => (
            <div key={s.env}>
              <label className="text-sm">{s.label}{s.optional ? ' (optional)' : ''}</label>
              {s.help && <div className="text-dim text-[12px] mb-1">{s.help}</div>}
              <input value={vals[s.env] ?? ''} placeholder={s.set ? '•••• (already set — leave blank to keep)' : ''}
                onChange={(e) => setVals((v) => ({ ...v, [s.env]: e.target.value }))}
                className="w-full rounded-[3px] border border-line bg-bone px-3 py-2 text-sm outline-none focus:border-signal" />
            </div>
          ))}
          <button onClick={saveSecretsAndEnable} disabled={busy} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
            {busy ? 'Working…' : 'Save & turn on'}
          </button>
          {k.source && <a href={k.source} target="_blank" rel="noreferrer" className="block mono text-[11px] text-dim underline">view source</a>}
        </div>
      )}
      {msg && <p className="mono text-[12px] text-signal px-4 pb-2">{msg}</p>}
    </div>
  );
}
