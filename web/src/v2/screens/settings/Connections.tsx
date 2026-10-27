/**
 * Settings › Connections (v2 build, slice S3): everything the classic Connections page does for accounts and reach, in
 * the new app's words. Google: sign in (with your own Google sign-in app, set up here once) or a Gmail app password.
 * Outlook: a code typed at microsoft.com (the page shows it and watches for the sign-in to finish) or a browser
 * window with your own Microsoft app. Telegram: a bot token. Tailscale: an auth key and a name, and how that relates
 * to the address phones use. Disconnecting asks first and says what stops working.
 *
 * Passwords, secrets, tokens and keys go into password fields that are cleared once sent; the page only ever says
 * whether one is saved. A paired phone sees what is connected, read-only, with one line that says why.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Back, Chev } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import type { ConnectStart, Connections as Conn } from '../../api/client';
import { useNow, useStore } from '../../store/react';
import { Note, Section, said, type Said } from './Settings';
import {
  SERVICE_LABEL, browserNote, codeLeft, disconnectWarning, googleLine, outlookLine, tailscaleLine, takeConnectionsAt, useConnections,
  type ConnTarget,
} from './useConnections';
import './settings.css';

type Data = ReturnType<typeof useConnections>;

export function Connections({ go }: ScreenProps) {
  const data = useConnections();
  const [at] = useState(() => takeConnectionsAt());
  const c = data.c;
  // a link from Today, the Calendar or a setup note lands on its part of the screen
  useEffect(() => {
    if (!at || data.loading || !c) return;
    const h = document.getElementById(`set-conn-${at}`);
    h?.scrollIntoView({ block: 'start' });
    h?.focus({ preventScroll: true });
  }, [at, data.loading, c]);
  // Settings scrolls to #accounts or #helper when it opens
  const toSettings = (hash: string) => { history.replaceState(null, '', `${location.pathname}${location.search}${hash}`); go('settings'); };
  return (
    <div className="col-main setpage connpage">
      <button type="button" className="backbtn keep" onClick={() => toSettings('#accounts')}><Back />Settings</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Settings</p><h1>Connections</h1></div></header>
      <p className="plugintro">Your email and calendar, Telegram, and reaching your helper from anywhere. Passwords and keys you type here go to your helper and are never shown again.</p>
      {data.loading && <p className="empty">Loading…</p>}
      {data.error && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {!data.loading && !data.error && c && (
        <>
          {!data.admin && (
            <p className="card adminnote" role="note">
              This {data.me?.kind === 'device' ? 'phone' : 'device'} can see what’s connected but not change it. Connect and disconnect on your computer, or after signing in with your password.
            </p>
          )}
          <Google c={c} data={data} />
          <Outlook c={c} data={data} />
          <Telegram c={c} data={data} />
          <Tailscale c={c} data={data} toHelper={() => toSettings('#helper')} />
        </>
      )}
    </div>
  );
}

// ---------- shared pieces ----------

function ConnSection({ id, title, children }: { id: ConnTarget; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`set-conn-${id}`} id={`sec-conn-${id}`} className="setsec">
      <h2 className="sh" id={`set-conn-${id}`} tabIndex={-1}>{title}</h2>
      {children}
    </section>
  );
}

function Head({ id, logo, title, connected, line, warn }: { id: string; logo: string; title: string; connected: boolean; line: string; warn?: boolean }) {
  return (
    <div className="setrow">
      <span className="logo" aria-hidden="true">{logo}</span>
      <div className="grow">
        <span className="rowtitle" id={`${id}-title`}>{title}{connected && !warn && <span className="okmark"> · connected</span>}</span>
        <span className={warn ? 's warnline' : 's'} id={`${id}-line`}>{line}</span>
      </div>
    </div>
  );
}

/** Disconnect asks first and says what stops working. */
function Disconnect({ service, c, data, onDone }: { service: ConnTarget; c: Conn; data: Data; onDone: (n: Said) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = SERVICE_LABEL[service];
  const verb = service === 'tailscale' ? 'Remove the Tailscale key' : `Disconnect ${name}`;
  if (!asking) return <button type="button" className="vbtn vbtn-quiet" onClick={() => { setAsking(true); onDone(null); }}>{service === 'tailscale' ? 'Remove key' : 'Disconnect'}</button>;
  return (
    <div className="plugreview bad conncheck" role="region" aria-label={`${verb}?`}>
      <p><b>{verb}?</b> {disconnectWarning(service, c)}</p>
      <div className="acts">
        <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={async () => { setBusy(true); const o = await data.disconnect(service); setBusy(false); setAsking(false); onDone(said(o)); }}>{busy ? 'Working…' : verb}</button>
        <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => setAsking(false)}>{service === 'tailscale' ? 'Keep it' : `Keep ${name}`}</button>
      </div>
    </div>
  );
}

/** A sign-in that finishes on the provider's page: show what to do, and look every few seconds until it is done. */
function useSignIn(provider: 'google' | 'outlook', data: Data) {
  const store = useStore(); // the app's clock (frozen in fixture mode), as useNow reads it
  const [started, setStarted] = useState<(ConnectStart & { until: number }) | null>(null);
  const [note, setNote] = useState<Said>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => { if (poll.current) clearInterval(poll.current); poll.current = null; };
  useEffect(() => stop, []);
  const done = (c: Conn) => {
    const a = provider === 'google' ? c.google : c.outlook;
    return a.connected && !a.needsReconnect && (provider !== 'google' || c.google.method === 'sign-in');
  };
  const begin = async (o: { method?: 'browser' | 'code'; readOnly?: boolean }, onSetup: () => void) => {
    setBusy(true); setNote(null); setStarted(null); stop();
    const r = await data.start(provider, o);
    setBusy(false);
    if (!r.ok) { setNote({ text: r.message, error: true }); return; }
    if (r.start.kind === 'setup') { setNote({ text: r.start.message, error: false }); onSetup(); return; }
    const until = store.now() + (r.start.kind === 'code' ? (r.start.expiresIn ?? 900) * 1000 : 5 * 60_000);
    setStarted({ ...r.start, until });
    if (r.start.kind === 'browser') window.open(r.start.url, '_blank', 'noopener');
    poll.current = setInterval(async () => {
      const c = await data.refresh();
      if (c && done(c)) { stop(); setStarted(null); setNote({ text: `${provider === 'google' ? 'Google' : 'Outlook'} is connected.`, error: false }); }
      else if (store.now() > until) { stop(); setStarted(null); setNote({ text: r.start.kind === 'code' ? 'The code ran out before the sign-in finished. Get a new one.' : 'The sign-in didn’t finish. Try again.', error: true }); }
    }, 3000);
  };
  const cancel = () => { stop(); setStarted(null); };
  return { started, note, busy, begin, cancel, setNote };
}

function SignInSteps({ s, cancel }: { s: ConnectStart & { until: number }; cancel: () => void }) {
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const name = s.provider === 'google' ? 'Google' : 'Microsoft';
  return (
    <div className="card connectsteps conncode" role="status" aria-label={s.kind === 'code' ? 'Your sign-in code' : `${name} sign-in`}>
      {s.kind === 'code' ? (
        <>
          <p>1. Open <a className="linkish" href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\//, '')}</a> on any device.</p>
          <p>2. Enter this code and sign in to your Outlook account:</p>
          <p className="paircode" id="outlook-code">{s.code}</p>
          <div className="acts">
            <button type="button" className="vbtn" onClick={async () => { try { await navigator.clipboard.writeText(s.code ?? ''); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy the code'}</button>
            <button type="button" className="vbtn vbtn-quiet" onClick={cancel}>Cancel</button>
          </div>
          <p className="soft">{codeLeft(s.until, now)} I’ll show Outlook as connected once you finish. Keep this page open.</p>
        </>
      ) : (
        <>
          <p>{s.message}</p>
          <p className="soft">No window? <a className="linkish" href={s.url} target="_blank" rel="noreferrer">Open the {name} sign-in</a>. I’ll show it as connected once you finish.</p>
          <div className="acts"><button type="button" className="vbtn vbtn-quiet" onClick={cancel}>Cancel</button></div>
        </>
      )}
    </div>
  );
}

function ReadOnlyBox({ id, value, onChange }: { id: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="plugtrust connro" htmlFor={id}>
      <input id={id} type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      Read only: don’t let it make drafts
    </label>
  );
}

const ext = (href: string, text: string) => <a className="linkish" href={href} target="_blank" rel="noreferrer">{text}</a>;

// ---------- Google ----------

function Google({ c, data }: { c: Conn; data: Data }) {
  const g = c.google;
  const sign = useSignIn('google', data);
  const [readOnly, setReadOnly] = useState(false);
  const [pw, setPw] = useState(false);
  const [app, setApp] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const re = g.needsReconnect;
  const canSignIn = g.signIn === 'ready';
  const signIn = () => void sign.begin({ readOnly }, () => setApp(true));
  const bnote = browserNote(g.signIn, 'google', c.host);
  return (
    <ConnSection id="google" title="Google">
      <div className="card setcard">
        <Head id="google" logo="G" title="Gmail and Google Calendar" connected={g.connected} warn={re} line={googleLine(c)} />
        {data.admin && (
          <>
            {(!g.connected || re || g.method === 'app-password') && canSignIn && <ReadOnlyBox id="google-ro" value={readOnly} onChange={setReadOnly} />}
            <div className="acts">
              {re && canSignIn && <button type="button" className="vbtn vbtn-primary" disabled={sign.busy} onClick={signIn}>{sign.busy ? 'Starting…' : 'Reconnect'}</button>}
              {re && !canSignIn && g.method === 'app-password' && <button type="button" className="vbtn vbtn-primary" onClick={() => { setPw(true); setNote(null); }}>Reconnect with an app password</button>}
              {!g.connected && canSignIn && <button type="button" className="vbtn vbtn-primary" disabled={sign.busy} onClick={signIn}>{sign.busy ? 'Starting…' : 'Sign in with Google'}</button>}
              {g.connected && !re && g.method === 'app-password' && canSignIn && <button type="button" className="vbtn" disabled={sign.busy} onClick={signIn}>{sign.busy ? 'Starting…' : 'Add Calendar: sign in with Google'}</button>}
              {!g.connected && !pw && <button type="button" className={canSignIn ? 'vbtn' : 'vbtn vbtn-primary'} onClick={() => { setPw(true); setNote(null); }}>Use an app password</button>}
              {g.connected && <Disconnect service="google" c={c} data={data} onDone={setNote} />}
            </div>
            {!g.connected && bnote && <p className="soft">{bnote}</p>}
          </>
        )}
        {sign.started && <SignInSteps s={sign.started} cancel={sign.cancel} />}
        <Note said={sign.note} />
        {data.admin && pw && (!g.connected || re) && <AppPasswordForm data={data} onDone={(n) => { setPw(false); setNote(n); }} onCancel={() => setPw(false)} />}
        <Note said={note} />
        <h3 className="subhead" id="google-app">Your own Google sign-in app</h3>
        <p className="soft" id="google-app-line">{g.appSaved ? 'Set up. Its ID and secret are saved on your helper and never shown.' : 'Not set up. You need it once, to sign in with Google (and for Google Calendar).'}</p>
        {data.admin && g.signIn === 'server' && <p className="soft">It can’t be used on your {c.host} server: the sign-in finishes on the computer your helper runs on.</p>}
        {data.admin && g.signIn !== 'server' && !app && (
          <div className="acts"><button type="button" className="vbtn" aria-describedby="google-app-line" onClick={() => setApp(true)}>{g.appSaved ? 'Replace the sign-in app' : 'Set up Google sign-in'}</button></div>
        )}
        {data.admin && g.signIn !== 'server' && app && <GoogleAppForm data={data} onDone={(n) => { setApp(false); setNote(n); }} onCancel={() => setApp(false)} />}
      </div>
    </ConnSection>
  );
}

function AppPasswordForm({ data, onDone, onCancel }: { data: Data; onDone: (n: Said) => void; onCancel: () => void }) {
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!address.trim() || !password.trim()) { setNote({ text: 'Type your Gmail address and the app password.', error: true }); return; }
    setBusy(true); setNote({ text: 'Checking your sign-in with Gmail…', error: false });
    const o = await data.appPassword(address.trim(), password);
    setPassword(''); // never kept on screen once sent
    setBusy(false);
    if (o.ok) onDone(said(o)); else setNote(said(o));
  };
  return (
    <form className="setform asform" onSubmit={submit} aria-label="Connect Gmail with an app password">
      <ol className="connsteps">
        <li>Turn on {ext('https://myaccount.google.com/signinoptions/two-step-verification', '2-Step Verification')} for your Google account (Google requires it).</li>
        <li>Make an {ext('https://myaccount.google.com/apppasswords', 'app password')}: name it MWA and copy the 16 letters.</li>
        <li>Paste your Gmail address and that password here.</li>
      </ol>
      <label htmlFor="gmail-address">Gmail address</label>
      <input id="gmail-address" className="setinput" type="email" autoComplete="email" autoCapitalize="off" spellCheck={false} value={address} placeholder="you@gmail.com" onChange={(e) => setAddress(e.target.value)} />
      <label htmlFor="gmail-app-password">App password</label>
      <input id="gmail-app-password" className="setinput" type="password" autoComplete="off" spellCheck={false} value={password} placeholder="16 letters" onChange={(e) => setPassword(e.target.value)} aria-describedby="gmail-app-password-help" />
      <span className="s" id="gmail-app-password-help">Gmail only: Calendar needs Google sign-in. Works for personal Gmail, not accounts on Advanced Protection. I never send.</span>
      <div className="acts">
        <button type="submit" className="vbtn vbtn-primary" disabled={busy}>{busy ? 'Checking…' : 'Check and connect'}</button>
        <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <Note said={note} />
    </form>
  );
}

function GoogleAppForm({ data, onDone, onCancel }: { data: Data; onDone: (n: Said) => void; onCancel: () => void }) {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setNote(null);
    const o = await data.saveGoogleApp(id.trim(), secret.trim());
    setSecret('');
    setBusy(false);
    if (o.ok) onDone(said(o)); else setNote(said(o));
  };
  return (
    <form className="setform asform" onSubmit={submit} aria-label="Set up Google sign-in">
      <ol className="connsteps">
        <li>Open the {ext('https://console.cloud.google.com/projectcreate', 'Google Cloud Console')} and make (or pick) a project.</li>
        <li>Turn on the {ext('https://console.cloud.google.com/apis/library/gmail.googleapis.com', 'Gmail API')} and the {ext('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Calendar API')}.</li>
        <li>Under Credentials › Create OAuth client ID, pick the type <b>Desktop app</b>.</li>
        <li>On the consent screen, leave it in Testing and add your own email as a test user.</li>
        <li>Copy the Client ID and the Client secret here.</li>
      </ol>
      <label htmlFor="google-client-id">Client ID</label>
      <input id="google-client-id" className="setinput" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={id} placeholder="…apps.googleusercontent.com" onChange={(e) => setId(e.target.value)} />
      <label htmlFor="google-client-secret">Client secret</label>
      <input id="google-client-secret" className="setinput" type="password" autoComplete="off" spellCheck={false} value={secret} placeholder="GOCSPX-…" onChange={(e) => setSecret(e.target.value)} aria-describedby="google-client-secret-help" />
      <span className="s" id="google-client-secret-help">Saved on your helper and never shown again. The sign-in opens on the computer your helper runs on.</span>
      <div className="acts">
        <button type="submit" className="vbtn vbtn-primary" disabled={busy || !id.trim() || !secret.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <Note said={note} />
    </form>
  );
}

// ---------- Outlook ----------

function Outlook({ c, data }: { c: Conn; data: Data }) {
  const o = c.outlook;
  const sign = useSignIn('outlook', data);
  const [readOnly, setReadOnly] = useState(false);
  const [app, setApp] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const re = o.needsReconnect;
  const offer = !o.connected || re;
  const browser = o.browser === 'ready';
  // the code needs no setup; without it (or your own app) there is no way in yet
  const bnote = !o.code && !browser ? 'Outlook needs your own Microsoft app first (a one-time setup, below).' : null;
  return (
    <ConnSection id="outlook" title="Outlook">
      <div className="card setcard">
        <Head id="outlook" logo="O" title="Outlook mail and calendar" connected={o.connected} warn={re} line={outlookLine(c)} />
        {data.admin && (
          <>
            {offer && (o.code || browser) && <ReadOnlyBox id="outlook-ro" value={readOnly} onChange={setReadOnly} />}
            <div className="acts">
              {offer && o.code && <button type="button" className="vbtn vbtn-primary" disabled={sign.busy} onClick={() => void sign.begin({ method: 'code', readOnly }, () => setApp(true))}>{sign.busy ? 'Starting…' : re ? 'Reconnect with a code' : 'Connect with a code'}</button>}
              {offer && browser && <button type="button" className={o.code ? 'vbtn' : 'vbtn vbtn-primary'} disabled={sign.busy} onClick={() => void sign.begin({ method: 'browser', readOnly }, () => setApp(true))}>{re && !o.code ? 'Reconnect' : 'Sign in in a browser window'}</button>}
              {o.connected && <Disconnect service="outlook" c={c} data={data} onDone={setNote} />}
            </div>
            {offer && o.code && <p className="soft">You’ll get a short code to type at microsoft.com, on this device or your phone. No setup needed.</p>}
            {offer && bnote && <p className="soft">{bnote}</p>}
          </>
        )}
        {sign.started && <SignInSteps s={sign.started} cancel={sign.cancel} />}
        <Note said={sign.note} />
        <Note said={note} />
        <h3 className="subhead" id="outlook-app">Your own Microsoft app</h3>
        <p className="soft" id="outlook-app-line">{o.appSaved ? `Set up${o.tenant ? ` (tenant ${o.tenant})` : ''}. Its ID is saved on your helper.` : 'Not set up. Only needed if the code doesn’t work for your account (some work or school accounts), or to sign in in a browser window.'}</p>
        {data.admin && !app && (
          <div className="acts"><button type="button" className="vbtn" aria-describedby="outlook-app-line" onClick={() => setApp(true)}>{o.appSaved ? 'Replace the Microsoft app' : 'Set up your own Microsoft app'}</button></div>
        )}
        {data.admin && app && <OutlookAppForm c={c} data={data} onDone={(n) => { setApp(false); setNote(n); }} onCancel={() => setApp(false)} />}
      </div>
    </ConnSection>
  );
}

function OutlookAppForm({ c, data, onDone, onCancel }: { c: Conn; data: Data; onDone: (n: Said) => void; onCancel: () => void }) {
  const [id, setId] = useState('');
  const [tenant, setTenant] = useState(c.outlook.tenant ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setNote(null);
    const o = await data.saveOutlookApp(id.trim(), tenant.trim() || undefined);
    setBusy(false);
    if (o.ok) onDone(said(o)); else setNote(said(o));
  };
  return (
    <form className="setform asform" onSubmit={submit} aria-label="Set up your own Microsoft app">
      <ol className="connsteps">
        <li>Open {ext('https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', 'App registrations')} at Microsoft and pick New registration.</li>
        <li>Supported accounts: <b>accounts in any organization’s directory and personal Microsoft accounts</b>.</li>
        <li>Add a redirect address, platform <b>Mobile and desktop applications</b>, exactly: <code className="addrmono connuri">{c.outlook.redirectUri}</code></li>
        <li>Under API permissions, add Microsoft Graph <b>delegated</b>: Mail.ReadWrite, Calendars.ReadWrite, User.Read, offline_access.</li>
        <li>For the code sign-in, turn on Allow public client flows (Authentication).</li>
        <li>Copy the Application (client) ID here.</li>
      </ol>
      <label htmlFor="ms-client-id">Application (client) ID</label>
      <input id="ms-client-id" className="setinput" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={id} placeholder="11111111-2222-3333-4444-555555555555" onChange={(e) => setId(e.target.value)} />
      <label htmlFor="ms-tenant">Tenant (optional)</label>
      <input id="ms-tenant" className="setinput" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={tenant} placeholder="common" onChange={(e) => setTenant(e.target.value)} aria-describedby="ms-tenant-help" />
      <span className="s" id="ms-tenant-help">Leave it empty for most accounts. A work account may need its organization’s tenant.</span>
      <div className="acts">
        <button type="submit" className="vbtn vbtn-primary" disabled={busy || !id.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <Note said={note} />
    </form>
  );
}

// ---------- Telegram ----------

function Telegram({ c, data }: { c: Conn; data: Data }) {
  const t = c.telegram;
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const [fnote, setFnote] = useState<Said>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) { setFnote({ text: 'Paste the bot token BotFather gave you.', error: true }); return; }
    setBusy(true); setFnote({ text: 'Checking the token with Telegram…', error: false });
    const o = await data.saveTelegram(token.trim());
    setToken('');
    setBusy(false);
    if (o.ok) { setOpen(false); setFnote(null); setNote(said(o)); } else setFnote(said(o));
  };
  return (
    <ConnSection id="telegram" title="Telegram">
      <div className="card setcard">
        <Head id="telegram" logo="T" title="Telegram" connected={t.connected}
          line={t.connected ? 'Connected. Message your bot to talk to your helper from your phone.' : 'Not connected. Chat with your helper from Telegram on your phone.'} />
        {data.admin && (
          <div className="acts">
            {!t.connected && !open && <button type="button" className="vbtn" onClick={() => { setOpen(true); setNote(null); }}>Set up Telegram</button>}
            {t.connected && <Disconnect service="telegram" c={c} data={data} onDone={setNote} />}
          </div>
        )}
        {data.admin && open && !t.connected && (
          <form className="setform asform" onSubmit={submit} aria-label="Connect Telegram">
            <ol className="connsteps">
              <li>In Telegram, message {ext('https://t.me/BotFather', '@BotFather')} and send /newbot.</li>
              <li>Copy the bot token it gives you and paste it here.</li>
            </ol>
            <label htmlFor="telegram-token">Bot token</label>
            <input id="telegram-token" className="setinput" type="password" autoComplete="off" spellCheck={false} value={token} placeholder="123456789:ABCdef…" onChange={(e) => setToken(e.target.value)} aria-describedby="telegram-token-help" />
            <span className="s" id="telegram-token-help">I check it with Telegram, then keep it on your helper. It’s never shown again.</span>
            <div className="acts">
              <button type="submit" className="vbtn vbtn-primary" disabled={busy}>{busy ? 'Checking…' : 'Check and save'}</button>
              <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => { setOpen(false); setToken(''); setFnote(null); }}>Cancel</button>
            </div>
            <Note said={fnote} />
          </form>
        )}
        <Note said={note} />
      </div>
    </ConnSection>
  );
}

// ---------- Tailscale ----------

function Tailscale({ c, data, toHelper }: { c: Conn; data: Data; toHelper: () => void }) {
  const ts = c.tailscale;
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [name, setName] = useState(ts.hostname ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const [fnote, setFnote] = useState<Said>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) { setFnote({ text: 'Paste a Tailscale auth key. It starts with tskey-auth-.', error: true }); return; }
    setBusy(true); setFnote(null);
    const o = await data.saveTailscale(key.trim(), name.trim() || undefined);
    setKey('');
    setBusy(false);
    if (o.ok) { setOpen(false); setNote(said(o)); } else setFnote(said(o));
  };
  return (
    <ConnSection id="tailscale" title="Reach it from anywhere">
      <div className="card setcard">
        <Head id="tailscale" logo="TS" title="Tailscale" connected={false} line={tailscaleLine(c)} />
        <p className="soft">Tailscale lets your phone reach a helper running in Docker or the cloud privately, with no public address. {c.hosted ? '' : 'A helper on your own computer usually doesn’t need it. '}The key is used when your helper starts.</p>
        <p className="soft" id="tailscale-address">
          Once it has joined, its private address looks like <span className="addrmono">https://{ts.hostname ?? 'mwa'}.your-tailnet.ts.net</span>. That’s the address your phone opens: it goes in Settings › Your helper › Address for phones, and your helper usually fills it in itself when it starts.
          {' '}Address for phones now: {data.publicUrl ? <span className="addrmono">{data.publicUrl}</span> : 'not set'}.
        </p>
        <div className="acts">
          <button type="button" className="vbtn vbtn-quiet" aria-describedby="tailscale-address" onClick={toHelper}>Address for phones<Chev /></button>
        </div>
        {data.admin && (
          <div className="acts">
            {!open && <button type="button" className="vbtn" onClick={() => { setOpen(true); setNote(null); }}>{ts.keySaved ? 'Replace the key' : 'Set up Tailscale'}</button>}
            {ts.keySaved && !open && <Disconnect service="tailscale" c={c} data={data} onDone={setNote} />}
          </div>
        )}
        {data.admin && open && (
          <form className="setform asform" onSubmit={submit} aria-label="Set up Tailscale">
            <ol className="connsteps">
              <li>In the {ext('https://login.tailscale.com/admin/settings/keys', 'Tailscale admin, Settings › Keys')}, pick Generate auth key (not an API access token).</li>
              <li>Paste the tskey-auth-… key here. Your helper joins your tailnet when it next restarts.</li>
            </ol>
            <label htmlFor="tailscale-key">Auth key</label>
            <input id="tailscale-key" className="setinput" type="password" autoComplete="off" spellCheck={false} value={key} placeholder="tskey-auth-…" onChange={(e) => setKey(e.target.value)} aria-describedby="tailscale-key-help" />
            <span className="s" id="tailscale-key-help">Kept on your helper and never shown again.</span>
            <label htmlFor="tailscale-name">Name on your tailnet (optional)</label>
            <input id="tailscale-name" className="setinput" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={name} placeholder="mwa" onChange={(e) => setName(e.target.value)} aria-describedby="tailscale-name-help" />
            <span className="s" id="tailscale-name-help">Letters, numbers and dashes. It becomes the first part of the address.</span>
            <div className="acts">
              <button type="submit" className="vbtn vbtn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
              <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => { setOpen(false); setKey(''); setFnote(null); }}>Cancel</button>
            </div>
            <Note said={fnote} />
          </form>
        )}
        <Note said={note} />
      </div>
    </ConnSection>
  );
}
