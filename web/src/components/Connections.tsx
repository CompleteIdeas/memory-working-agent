import { useEffect, useRef, useState } from 'react';
import {
  getConnections, connectGmail, connectOutlook, connectGmailImap, connectOutlookDevice, saveGoogle, saveMicrosoft, saveTelegram, saveTailscale, saveBackend,
  enableConnector, disableConnector, saveConnectorSecret, reviewExternal, approveExternal, saveAccess,
  disconnectService, saveBrain, saveImageModel, getModels, saveStyle, scanEmail, getStatus,
  type Connections as Conn, type ConnectorItem, type ExternalInstall, type RiskReport, type Access, type AccessPreset, type Brain, type InteractionStyle, type StorageBackend,
} from '../api';

const STYLE_OPTIONS: { id: InteractionStyle; label: string; detail: string }[] = [
  { id: 'guided', label: 'Guided', detail: 'Explains in plain language, suggests next steps, takes initiative, learns about you' },
  { id: 'direct', label: 'Direct', detail: 'Concise and technical · leads with the answer · no extra suggestions' },
];

const PROVIDER_OPTIONS: { id: string; label: string; keyless?: boolean }[] = [
  { id: 'openrouter', label: 'OpenRouter (many models, one key)' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'ollama', label: 'Local (Ollama) — no key', keyless: true },
];

const ACCESS_PRESETS: { id: AccessPreset; label: string; detail: string }[] = [
  { id: 'locked-down', label: 'Locked-down', detail: 'Workspace only · never runs commands' },
  { id: 'assistant', label: 'Assistant', detail: 'Workspace + folders you grant · looks things up while you watch, asks before running anything else' },
  { id: 'developer', label: 'Developer', detail: 'Runs any command without asking · it can reach this machine, so approvals are not a safeguard here' },
];

// Turn tools & accounts on without editing files. Email uses a GUIDED bring-your-own
// sign-in: you make a free app at Google/Microsoft (one time), paste the ID, and approve —
// the token stays on this machine, never on our servers. No managed broker (it would mean
// a per-user cost + third-party token custody we won't take on for an open project); a
// homegrown `mwa connect` helper will make this near-turnkey (see docs/connect-email.md).
// The sign-in opens a window on THIS computer, so connect from the machine running MWA.

type Provider = 'google' | 'microsoft';
/** Where MWA runs: the page words itself for a server deploy (2026-10-23 settings review). */
interface Where { hosted: boolean; host: string }

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

/** Poll the connections endpoint until the given account flips to connected (used by the
 *  OAuth + device-code flows that finish out-of-band). */
function usePoll() {
  const poll = useRef<number | null>(null);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);
  return {
    start(check: (c: Conn) => boolean, onHit: () => void, onTimeout: () => void, tries = 120) {
      let n = 0;
      poll.current = window.setInterval(async () => {
        n++;
        const c = await getConnections();
        if (check(c)) { if (poll.current) clearInterval(poll.current); onHit(); }
        else if (n > tries) { if (poll.current) clearInterval(poll.current); onTimeout(); }
      }, 2500);
    },
    stop() { if (poll.current) clearInterval(poll.current); },
  };
}

const cardCls = 'rounded-[4px] border border-line bg-surface';
const inputCls = 'w-full rounded-[3px] border border-line bg-bone px-3 py-2 text-sm outline-none focus:border-signal';
const btnCls = 'rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium disabled:opacity-50';

/** Connected-state badge + a disconnect link (forgets the credentials on this machine). */
function Connected({ note, onDisconnect }: { note?: string; onDisconnect: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 shrink-0">
      <span className="mono text-[12px] text-signal">connected ✓{note ?? ''}</span>
      <button disabled={busy} onClick={async () => { setBusy(true); await onDisconnect(); setBusy(false); }}
        className="mono text-[11px] text-dim underline disabled:opacity-50">{busy ? '…' : 'disconnect'}</button>
    </div>
  );
}

/** The advanced bring-your-own OAuth flow (Cloud Console / Azure app-id) — the original path,
 *  now tucked behind an "Advanced" expander under the easy options. */
function AdvancedOAuth({ provider, connected, onDone, hosted }: { provider: Provider; connected: boolean; onDone: () => void; hosted?: boolean }) {
  const ui = PROVIDERS[provider];
  const [vals, setVals] = useState<Record<string, string>>({});
  const [readonly, setReadonly] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const poll = usePoll();

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
    poll.start((c) => !!c[ui.key], () => { setMsg(''); setBusy(false); onDone(); },
      () => { setMsg('Still not connected — finish the sign-in, or try again.'); setBusy(false); });
  }

  // The sign-in returns to localhost on the machine running MWA, so on a server it can never finish (2026-10-23 review).
  if (hosted) return <p className="text-sm text-dim">This sign-in only works when MWA runs on your own computer: it finishes on that computer's localhost. {provider === 'google' ? 'On a server deploy, use the app password above (email only).' : 'On a server deploy, Outlook needs a Microsoft app set up for one-click sign-in (MWA_DEFAULT_MS_CLIENT_ID).'}</p>;
  return (
    <div className="space-y-3">
      {ui.steps}
      <div className="space-y-2 pt-1">
        {ui.fields.map((f) => (
          <input key={f.id} value={vals[f.id] ?? ''} placeholder={f.placeholder}
            onChange={(e) => setVals((v) => ({ ...v, [f.id]: e.target.value }))} className={inputCls} />
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-dim">
        <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} className="w-4 h-4 accent-[var(--color-signal)]" />
        Read-only (don’t let it draft replies)
      </label>
      <button disabled={busy || connected} onClick={saveAndConnect} className={btnCls}>{busy ? 'Working…' : 'Save & connect'}</button>
      <p className="mono text-[11px] text-dim">The sign-in opens on this computer — connect from the machine running MWA.</p>
      {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
    </div>
  );
}

/** Gmail — the EASY default is an app password (no Google Cloud Console); the OAuth flow is
 *  tucked under "Advanced" for people who want scoped tokens + calendar. */
function GmailConnect({ connected, method, onDone, where }: { connected: boolean; method: 'oauth' | 'app-password' | null; onDone: () => void; where: Where }) {
  const [open, setOpen] = useState(false);
  const [adv, setAdv] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function connect() {
    setBusy(true); setMsg('Checking your sign-in…');
    const r = await connectGmailImap(user.trim(), pass);
    setBusy(false);
    if (r.ok) { setMsg(''); setOpen(false); setUser(''); setPass(''); onDone(); }
    else setMsg(r.message ?? 'Could not connect.');
  }

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div><div className="font-medium">Google (Gmail)</div><div className="text-dim text-sm">Read & draft — never sends</div></div>
        {connected
          ? <Connected note={method === 'app-password' ? ' · app password' : method === 'oauth' ? ' · Google sign-in' : ''} onDisconnect={async () => { await disconnectService('gmail'); onDone(); }} />
          : <button onClick={() => setOpen((o) => !o)} className={btnCls}>{open ? 'Cancel' : 'Set up'}</button>}
      </div>
      {open && !connected && (
        <div className="border-t border-line px-4 py-4 space-y-3">
          <ol className="list-decimal ml-4 space-y-1.5 text-sm text-dim">
            <li>Turn on <a className="text-signal underline" href="https://myaccount.google.com/signinoptions/two-step-verification" target="_blank" rel="noreferrer">2-Step Verification</a> for your Google account (required).</li>
            <li>Create an <a className="text-signal underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App Password</a> — name it “MWA” and copy the 16-letter password.</li>
            <li>Paste your Gmail address and that password below.</li>
          </ol>
          <input value={user} placeholder="you@gmail.com" onChange={(e) => setUser(e.target.value)} className={inputCls} />
          <input value={pass} type="password" placeholder="16-letter app password" onChange={(e) => setPass(e.target.value)} className={inputCls} />
          <button disabled={busy || !user.trim() || !pass.trim()} onClick={connect} className={btnCls}>{busy ? 'Working…' : 'Connect'}</button>
          {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
          <p className="mono text-[11px] text-dim">{where.hosted ? `Saved only in MWA's own settings on your ${where.host} deploy.` : 'Stays on this computer.'} Works for personal Gmail (not accounts on Advanced Protection). Calendar needs the Google sign-in option below.</p>
          <button onClick={() => setAdv((a) => !a)} className="mono text-[11px] text-signal underline">{adv ? 'Hide' : 'Prefer Google sign-in (OAuth)? Advanced setup ▸'}</button>
          {adv && <div className="border-t border-line pt-3"><AdvancedOAuth provider="google" connected={connected} onDone={onDone} hosted={where.hosted} /></div>}
        </div>
      )}
    </div>
  );
}

/** Outlook — the EASY default is device-code (enter a short code at microsoft.com/devicelogin);
 *  the bring-your-own Azure app-id flow is under "Advanced". */
function OutlookConnect({ connected, easy, onDone, hosted }: { connected: boolean; easy: boolean; onDone: () => void; hosted?: boolean }) {
  const [open, setOpen] = useState(false);
  const [adv, setAdv] = useState(!easy); // no one-click yet → show the Microsoft sign-in straight away
  const [readonly, setReadonly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [code, setCode] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const poll = usePoll();

  async function connect() {
    setBusy(true); setMsg('Getting your code…'); setCode(null);
    const r = await connectOutlookDevice(readonly);
    if (!r.ok || !r.user_code) { setMsg(r.message ?? 'Could not start.'); setBusy(false); return; }
    setCode({ user_code: r.user_code, verification_uri: r.verification_uri ?? 'https://microsoft.com/devicelogin' });
    setMsg('Waiting for you to finish signing in…');
    poll.start((c) => c.outlook, () => { setMsg(''); setBusy(false); setOpen(false); setCode(null); onDone(); },
      () => { setMsg('Didn’t finish in time — try again.'); setBusy(false); setCode(null); });
  }

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div><div className="font-medium">Microsoft (Outlook)</div><div className="text-dim text-sm">Read & draft — never sends</div></div>
        {connected
          ? <Connected onDisconnect={async () => { await disconnectService('outlook'); onDone(); }} />
          : <button onClick={() => setOpen((o) => !o)} className={btnCls}>{open ? 'Cancel' : 'Set up'}</button>}
      </div>
      {open && !connected && (
        <div className="border-t border-line px-4 py-4 space-y-3">
          {easy ? (
            <>
              {!code ? (
                <>
                  <p className="text-sm text-dim">Click connect, then sign in to Microsoft and type the code we show you. No setup needed.</p>
                  <label className="flex items-center gap-2 text-sm text-dim">
                    <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} className="w-4 h-4 accent-[var(--color-signal)]" />
                    Read-only (don’t let it draft replies)
                  </label>
                  <button disabled={busy} onClick={connect} className={btnCls}>{busy ? 'Working…' : 'Connect'}</button>
                </>
              ) : (
                <div className="rounded-[4px] border border-line bg-bone px-4 py-3 space-y-2">
                  <p className="text-sm">Go to <a className="text-signal underline" href={code.verification_uri} target="_blank" rel="noreferrer">{code.verification_uri.replace('https://', '')}</a> and enter:</p>
                  <div className="mono text-2xl tracking-[0.2em] select-all text-ink">{code.user_code}</div>
                  <p className="mono text-[11px] text-dim">Keep this window open — I’ll show as connected when you’re done.</p>
                </div>
              )}
              {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
            </>
          ) : (
            <p className="text-sm text-dim">Connect with your own Microsoft app — sign in below. (Microsoft now requires this for Outlook.)</p>
          )}
          {easy && <button onClick={() => setAdv((a) => !a)} className="mono text-[11px] text-signal underline">{adv ? 'Hide' : 'Use your own Microsoft app (advanced) ▸'}</button>}
          {adv && <div className={easy ? 'border-t border-line pt-3' : ''}><AdvancedOAuth provider="microsoft" connected={connected} onDone={onDone} hosted={hosted} /></div>}
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
          ? <Connected onDisconnect={async () => { await disconnectService('telegram'); onDone(); }} />
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

/** Tailscale — join a tailnet so a cloud (or NAS) deployment is reachable privately at its
 *  tailnet name with NO public port. Takes a Tailscale AUTH key (tskey-auth-…), saved to the
 *  /data .env; the container entrypoint brings up userspace networking on the next restart.
 *  There's no "connected" signal from the server (it activates at boot), so this is a save card. */
function TailscaleConnect({ onDone, saved, hosted }: { onDone: () => void; saved?: boolean; hosted?: boolean }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function save() {
    setBusy(true); setMsg('Saving the auth key…');
    const r = await saveTailscale(key.trim(), hostname.trim() || undefined);
    setBusy(false);
    if (r.ok) { setMsg(r.message ?? 'Saved.'); setKey(''); onDone(); }
    else { setMsg(r.message ?? 'Could not save the key.'); }
  }
  return (
    <div className="rounded-[4px] border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div><div className="font-medium">Tailscale</div><div className="text-dim text-sm">Reach a cloud deploy privately — no public port</div></div>
        <div className="flex items-center gap-3 shrink-0">
          {saved && <span className="mono text-[12px] text-signal">key saved ✓</span>}
          <button onClick={() => { setMsg(''); setOpen((o) => !o); }} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium">{open ? 'Cancel' : (saved ? 'Change' : 'Set up')}</button>
        </div>
      </div>
      {open && (
        <div className="border-t border-line px-4 py-4 space-y-3">
          {!hosted && <p className="text-sm text-dim">Only a Docker or cloud deploy uses this: it joins your tailnet when the container starts. A desktop install has no use for it.</p>}
          <ol className="list-decimal ml-5 text-sm text-dim space-y-1">
            <li>In the <a className="text-signal underline" href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noreferrer">Tailscale admin → Settings → Keys</a>, <b>Generate auth key</b> (not the management API key).</li>
            <li>Paste the <span className="mono text-[12px]">tskey-auth-…</span> key below. It takes effect on the next restart.</li>
          </ol>
          <input value={key} placeholder="tskey-auth-…" onChange={(e) => setKey(e.target.value)}
            className="w-full rounded-[3px] border border-line bg-bone px-3 py-2 text-sm outline-none focus:border-signal" />
          <input value={hostname} placeholder="hostname (optional, e.g. mwa)" onChange={(e) => setHostname(e.target.value)}
            className="w-full rounded-[3px] border border-line bg-bone px-3 py-2 text-sm outline-none focus:border-signal" />
          <button disabled={busy || !key.trim()} onClick={save} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
            {busy ? 'Working…' : 'Save key'}
          </button>
          {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
        </div>
      )}
    </div>
  );
}

/** Memory storage — where AWM keeps memory. Default is SQLite on this computer (private,
 *  zero-setup). A Postgres server is the "larger install" for always-on / cloud / multi-device;
 *  the server validates the URL by connecting. Takes effect on the next restart. PGlite is not
 *  surfaced (env-var power-user option only — single-process + a known Windows/Node22 crash). */
function MemoryStorageCard({ storage, onDone, where }: { storage: StorageBackend; onDone: () => void; where: Where }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [bringMemory, setBringMemory] = useState(true); // default: copy existing memory across
  const isPg = storage.kind === 'postgres';
  async function save(kind: 'sqlite' | 'postgres') {
    setBusy(true); setMsg(kind === 'postgres' ? (bringMemory ? 'Connecting + copying your memory…' : 'Connecting to your database…') : 'Saving…');
    const r = await saveBackend(kind, kind === 'postgres' ? url.trim() : undefined, kind === 'postgres' ? bringMemory : undefined);
    setBusy(false); setMsg(r.message ?? (r.ok ? 'Saved.' : 'Could not save.'));
    if (r.ok) onDone();
  }
  return (
    <div className="rounded-[4px] border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div><div className="font-medium">Memory storage</div><div className="text-dim text-sm">{isPg ? 'Database server (Postgres)' : where.hosted ? `A file on your ${where.host} deploy · private to it` : 'This computer · private'}</div></div>
        <button onClick={() => { setMsg(''); setOpen((o) => !o); }} className="rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium">{open ? 'Cancel' : 'Change'}</button>
      </div>
      {open && (
        <div className="border-t border-line px-4 py-4 space-y-3">
          <p className="text-dim text-sm">{where.hosted ? <>Memory is a file on your {where.host} deploy's disk: private to it, no setup. It lasts across redeploys only on a mounted volume.</> : <>Most people should keep memory <b>on this computer</b> — it's private and needs no setup.</>} Choose a <b>database server</b> only for an always-on, cloud, or multi-device install.</p>
          <button disabled={busy} onClick={() => save('sqlite')}
            className={`w-full text-left rounded-[4px] border px-4 py-3 transition-colors ${!isPg ? 'border-signal bg-surface' : 'border-line bg-surface hover:border-signal/60'}`}>
            <div className="font-medium">{where.hosted ? 'A file on this deploy' : 'This computer'} <span className="mono text-[11px] text-dim">recommended</span></div>
            <div className="text-dim text-sm">Private, zero-setup. The default.</div>
          </button>
          <div className={`rounded-[4px] border px-4 py-3 ${isPg ? 'border-signal' : 'border-line'}`}>
            <div className="font-medium">Database server <span className="mono text-[11px] text-dim">Postgres + pgvector</span></div>
            <div className="text-dim text-sm mb-2">For cloud / always-on / multiple devices. Paste a connection URL — or <a className="text-signal underline" href="https://railway.com/new/template/postgres" target="_blank" rel="noreferrer">spin one up on Railway</a> and copy its DATABASE_URL.</div>
            <input value={url} placeholder="postgres://user:pass@host:5432/db" onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-[3px] border border-line bg-bone px-3 py-2 text-[12px] mono outline-none focus:border-signal" />
            <label className="flex items-center gap-2 mt-2 text-sm text-dim cursor-pointer">
              <input type="checkbox" checked={bringMemory} onChange={(e) => setBringMemory(e.target.checked)} className="accent-[var(--signal,#000)]" />
              Bring my existing memory over (copied before switching — nothing lost if it fails)
            </label>
            <button disabled={busy || !url.trim()} onClick={() => save('postgres')}
              className="mt-2 rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium disabled:opacity-50">{busy ? (bringMemory ? 'Connecting + copying…' : 'Connecting…') : 'Connect & use'}</button>
          </div>
          <p className="text-dim text-[12px]">Changes apply on the next restart. With "bring my memory" on, your current memory is copied into the database first (embeddings included), so you keep everything.</p>
          {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
        </div>
      )}
    </div>
  );
}

/** Change the AI brain (provider, model, key) after onboarding — the setting the user
 *  couldn't find. The model list is filtered server-side to tool-capable chat models so an
 *  image/embedding model can't be picked again. */
function BrainSettings({ brain, onChange, fromEnv }: { brain: Brain; onChange: () => void; fromEnv?: boolean }) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(brain.provider || 'openrouter');
  const [key, setKey] = useState('');
  const [model, setModel] = useState(brain.model || '');
  const [models, setModels] = useState<{ id: string; name?: string }[]>([]);
  // BL-23: whether the saved model held against instructions planted in what it reads.
  const [notes, setNotes] = useState<{ standing: string; text: string }[]>([]);
  useEffect(() => {
    getStatus().then((s) => setNotes([s.modelNote, s.reasonNote].filter((n): n is NonNullable<typeof n> => !!n && n.standing !== 'held'))).catch(() => setNotes([]));
  }, [brain.provider, brain.model]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const keyless = PROVIDER_OPTIONS.find((p) => p.id === provider)?.keyless;

  async function loadModels() {
    setLoading(true); setMsg('');
    const m = await getModels(provider, key || undefined);
    setModels(m); setLoading(false);
    if (!m.length) setMsg(keyless ? 'No local models found — is Ollama running?' : 'Enter your key first, then load models.');
    else if (!model || !m.find((x) => x.id === model)) setModel(m[0].id);
  }
  async function save() {
    setBusy(true); setMsg('Checking the model…');
    const r = await saveBrain(provider, model.trim(), key || undefined);
    setBusy(false); setMsg(r.message ?? '');
    if (r.ok) { setOpen(false); setKey(''); onChange(); }
  }

  return (
    <div>
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">ai brain</div>
      <div className={cardCls}>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0"><div className="font-medium">Model</div><div className="text-dim mono text-[12px] break-all">{brain.provider ? `${brain.provider}:${brain.model}` : 'not set'}</div></div>
          {!fromEnv && <button onClick={() => setOpen((o) => !o)} className={open ? 'rounded-[3px] border border-line px-4 py-2 text-sm font-medium' : btnCls}>{open ? 'Cancel' : 'Change'}</button>}
        </div>
        {fromEnv && <p className="border-t border-line px-4 py-2 text-[12px] text-dim">Set by the server's MWA_MODEL setting, which wins over a choice saved here: change it there.</p>}
        {notes.map((n) => (
          <p key={n.text} className={`border-t border-line px-4 py-2 text-[12px] break-words ${n.standing === 'failed' ? 'text-signal' : 'text-dim'}`}>{n.text}</p>
        ))}
        {open && (
          <div className="border-t border-line px-4 py-4 space-y-3">
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setModels([]); }} className={inputCls}>
              {PROVIDER_OPTIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {!keyless && <input value={key} type="password" placeholder="API key (leave blank to keep current)" onChange={(e) => setKey(e.target.value)} className={inputCls} />}
            <div className="flex gap-2">
              <select value={model} onChange={(e) => setModel(e.target.value)} className={`${inputCls} flex-1`}>
                {models.length ? models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>) : <option value={model}>{model || '(load models)'}</option>}
              </select>
              <button onClick={loadModels} disabled={loading} className="shrink-0 rounded-[3px] border border-line px-3 py-2 text-sm font-medium disabled:opacity-50">{loading ? '…' : 'Load models'}</button>
            </div>
            <p className="text-dim text-[12px]">Only models that can run the assistant (tool-capable chat models) are listed — image and embedding models are hidden.</p>
            <button onClick={save} disabled={busy || !model.trim()} className={btnCls}>{busy ? 'Saving…' : 'Save model'}</button>
            {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Image generation — pick a diffusion/image model from a connected provider (mirrors the
 *  brain picker). If the provider has no image model, the user is told to try another. */
function ImageModelSettings({ image, onChange }: { image: Brain; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(image.provider || 'openrouter');
  const [key, setKey] = useState('');
  const [model, setModel] = useState(image.model || '');
  const [models, setModels] = useState<{ id: string; name?: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const keyless = PROVIDER_OPTIONS.find((p) => p.id === provider)?.keyless;
  const on = !!image.model;

  async function loadModels() {
    setLoading(true); setMsg('');
    const m = await getModels(provider, key || undefined, undefined, 'image');
    setModels(m); setLoaded(true); setLoading(false);
    if (!m.length) setMsg(`${provider} doesn’t offer image models with this key — try another provider (e.g. OpenRouter), or connect an image service.`);
    else if (!model || !m.find((x) => x.id === model)) setModel(m[0].id);
  }
  async function save() {
    setBusy(true); setMsg('Saving…');
    const r = await saveImageModel(provider, model.trim(), key || undefined);
    setBusy(false); setMsg(r.message ?? '');
    if (r.ok) { setOpen(false); setKey(''); onChange(); }
  }
  async function turnOff() { setBusy(true); await saveImageModel(provider, ''); setBusy(false); onChange(); }

  return (
    <div>
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">image generation</div>
      <div className={cardCls}>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div><div className="font-medium">Image model</div><div className="text-dim mono text-[12px]">{on ? `${image.provider}:${image.model}` : 'off — pick a model to let it draw'}</div></div>
          <div className="flex items-center gap-3 shrink-0">
            {on && <button disabled={busy} onClick={turnOff} className="mono text-[11px] text-dim underline disabled:opacity-50">turn off</button>}
            <button onClick={() => setOpen((o) => !o)} className={open ? 'rounded-[3px] border border-line px-4 py-2 text-sm font-medium' : btnCls}>{open ? 'Cancel' : (on ? 'Change' : 'Set up')}</button>
          </div>
        </div>
        {open && (
          <div className="border-t border-line px-4 py-4 space-y-3">
            <p className="text-dim text-sm">Pick an image model from a provider you use. With it on, you can say “draw me…” / “generate an image of…”.</p>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setModels([]); setLoaded(false); }} className={inputCls}>
              {PROVIDER_OPTIONS.filter((p) => p.id !== 'anthropic').map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {!keyless && <input value={key} type="password" placeholder="API key (leave blank to keep current)" onChange={(e) => setKey(e.target.value)} className={inputCls} />}
            <div className="flex gap-2">
              <select value={model} onChange={(e) => setModel(e.target.value)} className={`${inputCls} flex-1`} disabled={!models.length}>
                {models.length ? models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>) : <option value={model}>{model || '(load image models)'}</option>}
              </select>
              <button onClick={loadModels} disabled={loading} className="shrink-0 rounded-[3px] border border-line px-3 py-2 text-sm font-medium disabled:opacity-50">{loading ? '…' : 'Load models'}</button>
            </div>
            {loaded && !models.length
              ? <p className="text-dim text-[12px]">No image models from this provider. OpenRouter has several (e.g. Gemini image, FLUX). Switch the provider above and load again.</p>
              : <p className="text-dim text-[12px]">Images are saved to your first granted folder (or the workspace).</p>}
            <button onClick={save} disabled={busy || !model.trim()} className={btnCls}>{busy ? 'Saving…' : 'Save image model'}</button>
            {msg && <p className="mono text-[12px] text-dim">{msg}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// Offered right after an email account is connected: read recent email to seed memory about
// the user (people, projects, dates). Streams progress; everything stays on the machine.
function EmailLearn({ ready, onDone, where, method }: { ready: boolean; onDone: () => void; where: Where; method: 'oauth' | 'app-password' | null }) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState<{ unique: number; learned: number } | null>(null);
  const [err, setErr] = useState('');
  if (!ready) return null;
  function start() {
    setBusy(true); setLines([]); setDone(null); setErr('');
    scanEmail(days, {
      onLog: (m) => setLines((p) => [...p.slice(-6), m]),
      onResult: (r) => { setBusy(false); setDone(r); onDone(); },
      onError: (m) => { setBusy(false); setErr(m); },
    });
  }
  return (
    <div>
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">get to know me</div>
      <div className={cardCls}>
        <div className="px-4 py-3">
          <div className="font-medium">Learn about me from my email</div>
          <div className="text-dim text-[12.5px] mt-0.5">I’ll read your recent email ({method === 'app-password' ? 'senders and subjects' : 'senders, subjects and opening lines'}), have your AI model pick out the people, projects and dates that matter, and keep them in my memory {where.hosted ? `on your ${where.host} deploy` : 'on this computer'}. The email itself is not stored.</div>
        </div>
        <div className="border-t border-line px-4 py-3 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-dim">Look back</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={busy}
              className="rounded-[3px] border border-line bg-bone px-2 py-1.5 text-sm outline-none focus:border-signal">
              <option value={30}>30 days</option><option value={90}>3 months</option><option value={365}>1 year</option>
            </select>
            <button onClick={start} disabled={busy} className={`${btnCls} ml-auto`}>{busy ? 'Reading…' : (done ? 'Scan again' : 'Start')}</button>
          </div>
          {busy && lines.length > 0 && <div className="mono text-[12px] text-dim space-y-0.5">{lines.map((l, i) => <div key={i}>{l}</div>)}</div>}
          {done && <p className="text-sm text-signal">Learned {done.learned} thing{done.learned === 1 ? '' : 's'} about you from {done.unique} message{done.unique === 1 ? '' : 's'}. Ask me “what do you know about me?”</p>}
          {err && <p className="mono text-[12px] text-signal">{err}</p>}
        </div>
      </div>
    </div>
  );
}

function StyleSettings({ style, onChange }: { style: InteractionStyle; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function pick(s: InteractionStyle) { if (s === style) return; setBusy(true); await saveStyle(s); setBusy(false); onChange(); }
  return (
    <div>
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">how I work with you</div>
      <div className="space-y-2">
        {STYLE_OPTIONS.map((o) => (
          <button key={o.id} onClick={() => pick(o.id)} disabled={busy}
            className={`w-full text-left rounded-[4px] border px-4 py-3 transition-colors disabled:opacity-60 ${style === o.id ? 'border-signal bg-surface' : 'border-line bg-surface hover:border-signal/60'}`}>
            <div className="font-medium">{o.label}{style === o.id ? ' ✓' : ''}</div>
            <div className="text-dim text-sm">{o.detail}</div>
          </button>
        ))}
      </div>
      <p className="text-dim text-[12px] mt-2">Separate from access — this only changes how I talk and how proactive I am.</p>
    </div>
  );
}

export function Connections() {
  const [c, setC] = useState<Conn | null>(null);
  const load = () => getConnections().then(setC);
  useEffect(() => { load(); }, []);

  if (!c) return <div className="py-16 mono text-dim text-sm">loading…</div>;
  const where: Where = { hosted: !!c.hosted, host: c.host || 'your server' };

  return (
    <div className="py-8 max-w-xl space-y-6">
      <StyleSettings style={c.style} onChange={load} />
      <BrainSettings brain={c.brain} onChange={load} fromEnv={c.modelFromEnv} />
      <ImageModelSettings image={c.imageModel} onChange={load} />
      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">email & calendar</div>
        <div className="space-y-2">
          <GmailConnect connected={c.gmail} method={c.gmailMethod} onDone={load} where={where} />
          <OutlookConnect connected={c.outlook} easy={c.outlookEasy} onDone={load} hosted={where.hosted} />
          <TelegramConnect connected={c.telegram} onDone={load} />
          <TailscaleConnect onDone={load} saved={c.tailscale} hosted={where.hosted} />
          <MemoryStorageCard storage={c.storage} onDone={load} where={where} />
        </div>
      </div>

      <EmailLearn ready={c.ingestReady} onDone={load} where={where} method={c.gmailMethod} />

      <div>
        <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">connector library</div>
        <p className="text-dim text-sm mb-2">Vetted connectors — turn on what you need. Each shows what it can touch.</p>
        <div className="space-y-2">
          {c.connectors.map((k) => <ConnectorCard key={k.id} k={k} onChange={load} />)}
        </div>
      </div>

      <AccessPanel access={c.access} onChange={load} where={where} />
      <ExternalInstaller ext={c.externalInstall} onChange={load} />
    </div>
  );
}

function AccessPanel({ access, onChange, where }: { access: Access; onChange: () => void; where: Where }) {
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
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">{where.hosted ? `what it can touch on the ${where.host} server` : 'what it can touch on this computer'}</div>
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
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={where.hosted ? '/data/files' : /Win/i.test(navigator.userAgent) ? 'C:\\Users\\you\\Documents' : '~/Documents'}
              className="flex-1 rounded-[3px] border border-line bg-bone px-3 py-2 text-sm mono outline-none focus:border-signal" />
            <button onClick={addFolder} disabled={busy || !folder.trim()} className="rounded-[3px] border border-line px-3 py-2 text-sm font-medium disabled:opacity-50">Grant</button>
          </div>
          {where.hosted && <p className="text-dim text-[12px] mt-1">Folders on the server, not your own computer. Only /data lasts across a redeploy.</p>}
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
