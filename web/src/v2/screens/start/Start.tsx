/**
 * The start screens (v2 build, slice W5): what shows before the app itself.
 *
 *   Sign in      the server answered 401. With a password set: "Sign in to your helper" (POST /session), or pair with
 *                a code instead. With no password (a phone on the network): "Pair this device first".
 *   Pair         /pair (the QR's link, `/pair#c=CODE`) or "Type a code": "Pair this phone with MWA?", a name for the
 *                phone, Pair (POST /pair: the phone gets its own key as an HttpOnly cookie).
 *   First run    on the computer (admin), until setup is finished or skipped: name the helper, connect Google /
 *                Outlook, turn on what's off, then pair your phone with the code and QR.
 *
 * The shell asks `useStartGate()` first; it returns the screen to show, or null for the app. Words follow
 * docs/onboarding-and-pairing.html and the prototype's first run (N01).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMeta, useStore } from '../../store/react';
import type { Account, ConnectStart, HelperSettings, Me, PairCode } from '../../api/client';
import { codeFromHash, guessDeviceName, guessPlatform, messageOf, normalizeCode, useSettingsData } from '../settings/useSettings';
import { PairCodeCard } from '../settings/PairNewDevice';
import { ConnectSteps } from '../settings/Settings';
import { START_CHECK_EVENT } from './events';
import '../settings/settings.css';

/** The pairing page: /pair (the QR's link) or ?view=pair (fixture mode, links inside the app). */
export function isPairLocation(loc: { pathname: string; search: string } = location): boolean {
  return /^\/pair\/?$/.test(loc.pathname) || new URLSearchParams(loc.search).get('view') === 'pair';
}
/** Leave the pairing page without reloading (keeps ?fixtures, &scenario and &theme for fixture mode). */
function leavePairPage() {
  const q = new URLSearchParams(location.search);
  q.delete('view');
  if (!q.get('ui') && !q.get('fixtures')) q.set('ui', 'v2');
  history.replaceState(null, '', `/?${q.toString()}`);
}

export function useStartGate(): ReactNode | null {
  const store = useStore();
  const { auth, meta } = useMeta();
  const [pairRoute, setPairRoute] = useState(() => isPairLocation());
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [settings, setSettings] = useState<HelperSettings | null>(null);
  const [check, setCheck] = useState(0);
  const [configSeen, setConfigSeen] = useState(false);
  const hasSettings = !!meta?.features.includes('settings');
  useEffect(() => {
    const again = () => setCheck((n) => n + 1);
    window.addEventListener(START_CHECK_EVENT, again);
    return () => window.removeEventListener(START_CHECK_EVENT, again);
  }, []);
  useEffect(() => {
    let on = true;
    if (auth === 'ok' && !pairRoute && !hasSettings) return; // an older server: no first run, no /me
    setMeError(null);
    store.client.getMe().then(async (m) => {
      if (!on) return;
      setMe(m);
      if (auth === 'ok' && m.scopes.includes('admin') && hasSettings) {
        try { const s = await store.client.getSettings(); if (on) setSettings(s); } catch { /* the app opens as usual */ }
      }
    }).catch((e) => { if (on) setMeError(messageOf(e)); });
    return () => { on = false; };
  }, [store, auth, pairRoute, hasSettings, check]);

  const signedIn = useCallback(() => { void store.resume(); setCheck((n) => n + 1); }, [store]);
  if (pairRoute) {
    return <PairScreen me={me} onPaired={() => { leavePairPage(); setPairRoute(false); signedIn(); }}
      onCancel={() => { leavePairPage(); setPairRoute(false); }} />;
  }
  if (auth === 'signin') return <SignInScreen me={me} error={meError} onSignedIn={signedIn} onPair={() => setPairRoute(true)} onRetry={() => setCheck((n) => n + 1)} />;
  // a settings file that can't be read: say what is wrong (W5 security review) instead of trapping the owner in first run
  if (settings?.configError && me?.scopes.includes('admin') && !configSeen) return <ConfigErrorScreen text={settings.configError} onRetry={() => setCheck((n) => n + 1)} onGoOn={() => setConfigSeen(true)} />;
  if (settings && !settings.firstRunDone && !settings.configError && me?.scopes.includes('admin')) return <FirstRun onDone={(s) => setSettings(s)} />;
  return null;
}

// ---------- sign in ----------

function StartPage({ children, label }: { children: ReactNode; label: string }) {
  const h = useRef<HTMLDivElement>(null);
  useEffect(() => { h.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }); }, [label]);
  return <main id="main" className="startpage" aria-label={label}><div className="ob" ref={h}>{children}</div></main>;
}

export function SignInScreen({ me, error, onSignedIn, onPair, onRetry }: { me: Me | null; error: string | null; onSignedIn: () => void; onPair: () => void; onRetry: () => void }) {
  const store = useStore();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  if (error && !me) {
    return (
      <StartPage label="Can’t reach your helper">
        <h1 tabIndex={-1}>Can’t reach your helper</h1>
        <p className="lede">{error}</p>
        <div className="actions"><button type="button" className="vbtn vbtn-primary vbtn-wide" onClick={onRetry}>Try again</button></div>
      </StartPage>
    );
  }
  if (!me) return <StartPage label="Opening"><p className="empty" style={{ paddingTop: 40 }}>Opening…</p></StartPage>;
  if (!me.passwordSet) {
    return (
      <StartPage label="Pair this device first">
        <h1 tabIndex={-1}>Pair this device first</h1>
        <p className="lede">This device isn’t paired with your helper yet.</p>
        <p className="small">On your computer, open Settings, then Devices, then <b>Pair a new device</b>. Scan the code with this phone’s camera, or type it here.</p>
        <div className="actions"><button type="button" className="vbtn vbtn-primary vbtn-wide" onClick={onPair}>Type a code</button></div>
      </StartPage>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw) { setRefusal('Type your password.'); return; }
    setBusy(true); setRefusal(null);
    try { await store.client.signIn(pw); setPw(''); onSignedIn(); }
    catch (err) { setRefusal(messageOf(err)); }
    finally { setBusy(false); }
  };
  return (
    <StartPage label="Sign in to your helper">
      <h1 tabIndex={-1}>Sign in to your helper</h1>
      <p className="lede">This device isn’t signed in. Type your password, or pair this phone with a code from your computer.</p>
      <form onSubmit={submit}>
        <label htmlFor="signin-pw">Password</label>
        <input id="signin-pw" className="setinput" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)}
          aria-describedby={refusal ? 'signin-err' : undefined} aria-invalid={refusal ? true : undefined} />
        {refusal && <p className="refusal" id="signin-err" role="alert">{refusal}</p>}
        <div className="actions">
          <button type="submit" className="vbtn vbtn-primary vbtn-wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="vbtn vbtn-quiet" onClick={onPair}>Pair with a code instead</button>
        </div>
      </form>
    </StartPage>
  );
}

function ConfigErrorScreen({ text, onRetry, onGoOn }: { text: string; onRetry: () => void; onGoOn: () => void }) {
  return (
    <StartPage label="Your settings file can’t be read">
      <h1 tabIndex={-1}>Your settings file can’t be read</h1>
      <p className="configerr">{text}</p>
      <p className="small">Until it is fixed, your helper uses its defaults and can’t save changes to names, the time zone or limits.</p>
      <div className="actions">
        <button type="button" className="vbtn vbtn-primary vbtn-wide" onClick={onRetry}>I fixed it — check again</button>
        <button type="button" className="vbtn vbtn-quiet" onClick={onGoOn}>Open the app anyway</button>
      </div>
    </StartPage>
  );
}

// ---------- pair this phone ----------

export function PairScreen({ me, onPaired, onCancel }: { me: Me | null; onPaired: () => void; onCancel: () => void }) {
  const store = useStore();
  const [code, setCode] = useState(() => codeFromHash(location.hash) ?? '');
  const [name, setName] = useState(() => guessDeviceName(navigator.userAgent));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // the code came in the link's fragment: take it out of the address bar (and the history)
  useEffect(() => { if (location.hash) history.replaceState(null, '', location.pathname + location.search); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = normalizeCode(code);
    if (!c) { setRefusal('The code has 8 letters and numbers, like ABCD-EFGH. You’ll find it in Settings on your computer.'); return; }
    setBusy(true); setRefusal(null);
    try {
      await store.client.pairDevice({ code: c, name: name.trim() || 'Phone', platform: guessPlatform(navigator.userAgent) });
      if (!store.getState().fixtures) { try { localStorage.setItem('mwa-ui', 'v2'); } catch { /* private mode */ } }
      setDone(true);
    } catch (err) { setRefusal(messageOf(err)); }
    finally { setBusy(false); }
  };
  if (done) {
    return (
      <StartPage label="Paired">
        <h1 tabIndex={-1}>This phone is paired</h1>
        <p className="lede">{name.trim() || 'This phone'} can now reach your helper. You can remove it in Settings at any time.</p>
        <p className="small">To keep MWA on your home screen: Android, tap Install app in the browser menu. iPhone, tap Share, then Add to Home Screen.</p>
        <div className="actions"><button type="button" className="vbtn vbtn-primary vbtn-wide" onClick={onPaired}>Open MWA</button></div>
      </StartPage>
    );
  }
  return (
    <StartPage label="Pair this phone with MWA">
      <h1 tabIndex={-1}>Pair this phone with MWA?</h1>
      <p className="host">{location.host}</p>
      {me?.signedIn && <p className="okline">This device is already signed in. Pairing gives it its own key as well.</p>}
      <form onSubmit={submit}>
        <label htmlFor="pair-code">Code from your computer</label>
        <input id="pair-code" className="setinput codein" value={code} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-EFGH"
          onChange={(e) => setCode(e.target.value)} aria-describedby={`pair-code-help${refusal ? ' pair-err' : ''}`} aria-invalid={refusal ? true : undefined} />
        <span className="small" id="pair-code-help">On your computer: Settings, then Devices, then Pair a new device.</span>
        <label htmlFor="pair-name">Name for this phone</label>
        <input id="pair-name" className="setinput" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <div className="whatitcan">
          <p>This phone will be able to read your day, act on it (mark handled, confirm, save drafts) and approve things. It can’t change connections or keys.</p>
          <p className="small">You can remove it in Settings at any time.</p>
        </div>
        {refusal && <p className="refusal" id="pair-err" role="alert">{refusal}</p>}
        <div className="actions">
          <button type="submit" className="vbtn vbtn-primary vbtn-wide" disabled={busy}>{busy ? 'Pairing…' : 'Pair'}</button>
          <button type="button" className="vbtn vbtn-quiet" onClick={onCancel}>Not now</button>
        </div>
      </form>
    </StartPage>
  );
}

// ---------- first run (on the computer) ----------

type Step = 'welcome' | 'names' | 'connect' | 'switches' | 'phone';
const SUN = (
  <svg className="sun" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="40" fill="var(--card)" /><circle cx="42" cy="46" r="15" fill="var(--accent)" />
    <path d="M14 58h56" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" /><path d="M42 20v6M24 28l4 4M60 28l-4 4" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" /></svg>
);

export function FirstRun({ onDone }: { onDone: (s: HelperSettings) => void }) {
  const store = useStore();
  const data = useSettingsData();
  const [step, setStep] = useState<Step>('welcome');
  const [refusal, setRefusal] = useState<string | null>(null);
  const s = data.settings;
  const off = (s?.features ?? []).filter((f) => !f.on);
  // whether "A few things are off" is a step is decided once, when the settings arrive (turning one on keeps the count)
  const [withSwitches, setWithSwitches] = useState<boolean | null>(null);
  useEffect(() => { if (s && withSwitches === null) setWithSwitches(off.length > 0); }, [s, withSwitches, off.length]);
  const steps: Step[] = ['welcome', 'names', 'connect', ...(withSwitches ? ['switches' as const] : []), 'phone'];
  const at = steps.indexOf(step);
  const next = () => { setRefusal(null); setStep(steps[Math.min(steps.length - 1, at + 1)]); };
  const finish = async () => {
    const o = await data.updateSettings({ firstRunDone: true });
    if (!o.ok) { setRefusal(o.message); return; }
    const fresh = await store.client.getSettings().catch(() => null);
    onDone(fresh ?? { ...(s as HelperSettings), firstRunDone: true });
  };
  const dots = (
    <>
      <div className="stepdots" aria-hidden="true">{steps.map((x) => <i key={x} className={x === step ? 'on' : undefined} />)}</div>
      <p className="sr-only">Step {at + 1} of {steps.length}</p>
    </>
  );
  if (data.loading) return <StartPage label="Opening"><p className="empty" style={{ paddingTop: 40 }}>Opening…</p></StartPage>;
  return (
    <StartPage label={`Setup, step ${at + 1}`}>
      {step === 'welcome' && (
        <section aria-labelledby="ob-h">
          {SUN}
          <h1 id="ob-h" tabIndex={-1}>Hi, I’m your helper.</h1>
          <p className="lede">I keep an eye on your day — your calendar, your email and the things you’re working on — and take care of the small stuff.</p>
          <p className="small">I never send, delete or buy anything without asking you first.</p>
          <div className="actions">
            <button type="button" className="vbtn vbtn-primary vbtn-wide" onClick={next}>Get started</button>
            <button type="button" className="vbtn vbtn-quiet" onClick={() => void finish()}>Skip setup</button>
          </div>
        </section>
      )}
      {step === 'names' && s && <NamesStep s={s} save={data.updateSettings} onNext={next} />}
      {step === 'connect' && <ConnectStep accounts={data.accounts ?? []} connect={data.connect} refresh={data.refreshAccounts} onNext={next} />}
      {step === 'switches' && s && <SwitchesStep s={s} save={data.updateSettings} onNext={next} />}
      {step === 'phone' && <PhoneStep createCode={data.createPairCode} now={store.now} onFinish={() => void finish()} saveAddress={(url) => data.updateSettings({ publicUrl: url })} />}
      {refusal && <p className="refusal" role="alert">{refusal}</p>}
      {dots}
    </StartPage>
  );
}

function NamesStep({ s, save, onNext }: { s: HelperSettings; save: ReturnType<typeof useSettingsData>['updateSettings']; onNext: () => void }) {
  const [helper, setHelper] = useState(s.helperName === 'Your helper' ? '' : s.helperName);
  const [owner, setOwner] = useState(s.ownerName ?? '');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (helper.trim() && helper.trim() !== s.helperName) patch.helperName = helper.trim();
    if (!s.ownerNameFixed && (owner.trim() || null) !== s.ownerName) patch.ownerName = owner.trim() || null;
    if (Object.keys(patch).length) {
      setBusy(true);
      const o = await save(patch);
      setBusy(false);
      if (!o.ok) { setRefusal(o.message); return; }
    }
    onNext();
  };
  return (
    <section aria-labelledby="ob-h">
      <h1 id="ob-h" tabIndex={-1}>Let’s get to know each other</h1>
      <form onSubmit={submit}>
        <label htmlFor="ob-helper">What should I call myself?</label>
        <input id="ob-helper" className="setinput" value={helper} maxLength={40} placeholder="Your helper" onChange={(e) => setHelper(e.target.value)} />
        <label htmlFor="ob-owner">What should I call you?</label>
        <input id="ob-owner" className="setinput" value={owner} maxLength={40} disabled={s.ownerNameFixed} autoComplete="given-name" onChange={(e) => setOwner(e.target.value)} />
        <p className="small">Your time zone: {s.timeZone.replace(/_/g, ' ')}. You can change it in Settings.</p>
        {refusal && <p className="refusal" role="alert">{refusal}</p>}
        <div className="actions">
          <button type="submit" className="vbtn vbtn-primary vbtn-wide" disabled={busy}>Next</button>
        </div>
      </form>
    </section>
  );
}

function ConnectStep({ accounts, connect, refresh, onNext }: {
  accounts: Account[]; connect: ReturnType<typeof useSettingsData>['connect']; refresh: ReturnType<typeof useSettingsData>['refreshAccounts']; onNext: () => void;
}) {
  const [started, setStarted] = useState<ConnectStart | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);
  const start = async (a: Account) => {
    setRefusal(null); setStarted(null);
    const o = await connect(a.provider);
    if (!o.ok || !o.start) { setRefusal(o.ok ? 'That didn’t start. Try again.' : o.message); return; }
    setStarted(o.start);
    if (o.start.kind === 'browser') window.open(o.start.url, '_blank', 'noopener');
    let n = 0;
    if (poll.current) clearInterval(poll.current);
    const look = async () => {
      const list = await refresh();
      if (list?.find((x) => x.provider === a.provider)?.connected || ++n > 60) { if (poll.current) clearInterval(poll.current); if (n <= 60) setStarted(null); }
    };
    void look();
    if (o.start.kind !== 'setup') poll.current = setInterval(() => void look(), 3000);
  };
  const any = accounts.some((a) => a.connected);
  return (
    <section aria-labelledby="ob-h">
      <h1 id="ob-h" tabIndex={-1}>Connect your calendar and email</h1>
      <p className="lede">So I can see your day and draft things for you.</p>
      <div className="actions">
        {accounts.map((a) => (
          <button key={a.provider} type="button" className={a.connected && !a.needsReconnect ? 'connect done' : 'connect'} onClick={() => void start(a)} disabled={a.connected && !a.needsReconnect}>
            <span className="logo" aria-hidden="true">{a.label[0]}</span>
            <span><span className="t">{a.needsReconnect ? `Reconnect ${a.label}` : a.label}</span><span className="s">{a.what}</span></span>
            {a.connected && !a.needsReconnect && <span className="state">Connected</span>}
          </button>
        ))}
        {started && <ConnectSteps s={started} onClose={() => setStarted(null)} />}
        {refusal && <p className="refusal" role="alert">{refusal}</p>}
        <button type="button" className={any ? 'vbtn vbtn-primary vbtn-wide' : 'vbtn vbtn-quiet'} onClick={onNext}>{any ? 'Next' : 'Skip for now'}</button>
        {!any && <p className="small" style={{ textAlign: 'center', marginTop: 0 }}>You can connect them any time in Settings.</p>}
      </div>
    </section>
  );
}

function SwitchesStep({ s, save, onNext }: { s: HelperSettings; save: ReturnType<typeof useSettingsData>['updateSettings']; onNext: () => void }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-labelledby="ob-h">
      <h1 id="ob-h" tabIndex={-1}>A few things are off</h1>
      <p className="lede">Turn on what you’d like me to do.</p>
      <div className="whatitcan">
        {s.features.map((f) => (
          <div className="featrow" key={f.id}>
            <span className="grow"><b>{f.label}</b><span className="s">{f.on ? 'On.' : f.canChange ? f.note : f.note}</span></span>
            {!f.on && f.canChange && (
              <button type="button" className="vbtn" disabled={busy} onClick={async () => {
                setBusy(true); setRefusal(null);
                const o = await save({ features: { [f.id]: true } });
                if (!o.ok) setRefusal(o.message);
                setBusy(false);
              }}>Turn it on</button>
            )}
            {f.on && <span className="onoff on">On</span>}
          </div>
        ))}
      </div>
      {refusal && <p className="refusal" role="alert">{refusal}</p>}
      <div className="actions"><button type="button" className="vbtn vbtn-primary vbtn-wide" onClick={onNext}>Next</button></div>
    </section>
  );
}

function PhoneStep({ createCode, now, onFinish, saveAddress }: {
  createCode: ReturnType<typeof useSettingsData>['createPairCode']; now: () => number; onFinish: () => void;
  saveAddress: (url: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [code, setCode] = useState<PairCode | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const make = useCallback(async () => {
    setBusy(true); setRefusal(null);
    const r = await createCode();
    setBusy(false);
    if (r.ok) setCode(r.code); else setRefusal(r.message);
  }, [createCode]);
  useEffect(() => { void make(); }, [make]);
  return (
    <section aria-labelledby="ob-h">
      <h1 id="ob-h" tabIndex={-1}>Put MWA on your phone</h1>
      <p className="lede">Scan this with your phone’s camera, then tap Pair. The code works once, for 10 minutes.</p>
      {code && <PairCodeCard code={code} now={now} busy={busy} level={2} onNew={() => void make()}
        onSetAddress={async (url) => { const o = await saveAddress(url); if (o.ok) await make(); return o; }} />}
      {refusal && <p className="refusal" role="alert">{refusal}</p>}
      <div className="actions">
        <button type="button" className="vbtn vbtn-primary vbtn-wide" onClick={onFinish}>Finish</button>
        <p className="small" style={{ textAlign: 'center', marginTop: 0 }}>No phone right now? You can pair one later in Settings, under Devices.</p>
      </div>
    </section>
  );
}
