/**
 * Settings (v2 build, slice W5), from the avatar: Accounts, Spending, Devices, Your rules, Helper, What I keep up to
 * date, Saved logins, Notifications, Voice (P4), Look and About — in plain words, as the approved prototype's Settings and the
 * onboarding-and-pairing explanation say them. Changing connections, limits, devices and the helper is for admin
 * (this computer, or signed in with the password); a paired phone sees the same page with those parts read-only and
 * one line that says why.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMeta, useRules, useItemActions, useStore, useNow } from '../../store/react';
import { ruleEffectLine, ruleLine } from '../../store/important';
import type { Account, ConnectStart, Device, PairCode } from '../../api/client';
import { WEB_VERSION } from '../../api/client';
import { Back } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import { PairCodeCard } from './PairNewDevice';
import { InstallCard } from './InstallCard';
import { START_CHECK_EVENT } from '../start/events';
import { accountLine, activeDevices, backgroundLine, lastUsed, money, spendLine, useSettingsData, type ActOutcome } from './useSettings';
import { VoiceSettings } from '../ask/voice/VoiceSettings';
import { NotificationsCard } from './Notifications';
import './settings.css';

type Said = { text: string; error: boolean } | null;
function Note({ said }: { said: Said }) {
  if (!said) return null;
  return <p className={said.error ? 'setnote error' : 'setnote'} role={said.error ? 'alert' : 'status'}>{said.text}</p>;
}
const said = (o: ActOutcome, okText?: string): Said => (o.ok ? { text: o.message ?? okText ?? 'Saved.', error: false } : { text: o.message, error: true });

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section aria-labelledby={`set-${id}`} id={`sec-${id}`} className="setsec"><h2 className="sh" id={`set-${id}`}>{title}</h2>{children}</section>;
}

export function Settings({ go }: ScreenProps) {
  const data = useSettingsData();
  const { meta } = useMeta();
  const admin = data.admin;
  const top = useRef<HTMLDivElement>(null);
  // "Your rules" from the Important list lands here (#rules)
  useEffect(() => {
    // P3: "Send a test" lands here (#/settings/notifications)
    if (location.hash === '#notifications' && !data.loading) {
      document.getElementById('sec-notify')?.scrollIntoView({ block: 'start' });
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (location.hash === '#rules' && !data.loading) {
      document.getElementById('sec-rules')?.scrollIntoView({ block: 'start' });
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [data.loading]);
  const who = data.me?.kind === 'device' ? (data.me.deviceName ?? 'This phone') : data.settings?.ownerName ?? 'This device';
  return (
    <div className="col-main setpage" ref={top}>
      <button type="button" className="backbtn" onClick={() => go('today')}><Back />Today</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">{who}</p><h1>Settings</h1></div></header>
      {data.loading && <p className="empty">Loading…</p>}
      {data.error && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {!data.loading && !data.error && (
        <>
          {data.settings?.configError && (
            <p className="configerr" role="alert"><b>Your settings file can’t be read.</b> {data.settings.configError}</p>
          )}
          {!admin && (
            <p className="card adminnote" role="note">
              This {data.me?.kind === 'device' ? 'phone' : 'device'} can read your day, act on it and approve things. Connecting accounts, changing limits and
              managing devices happen on your computer, or after signing in with your password.
            </p>
          )}
          <Accounts data={data} admin={admin} />
          <SpendingSection data={data} admin={admin} />
          <Devices data={data} admin={admin} />
          {/* P1: install on this phone (the browser's Install, iPhone's Add to Home Screen, or the secure address) */}
          <Section id="this-device" title="This device"><InstallCard publicUrl={data.settings?.publicUrl ?? null} /></Section>
          <RulesSection />
          <HelperSection data={data} admin={admin} />
          <Switches data={data} admin={admin} />
          {admin && <SavedLogins data={data} />}
          <Section id="notify" title="Notifications">
            {/* P3: web push for this device, which kinds, the morning time, quiet hours, a test */}
            <NotificationsCard publicUrl={data.settings?.publicUrl ?? null} admin={admin} />
          </Section>
          <VoiceSettings />
          <Look />
          <About serverVersion={meta?.server ?? null} minClient={meta?.minClient ?? null} admin={admin} restart={() => data.updateSettings({ firstRunDone: false })} />
        </>
      )}
    </div>
  );
}

// ---------- Accounts ----------

function Accounts({ data, admin }: { data: ReturnType<typeof useSettingsData>; admin: boolean }) {
  const [started, setStarted] = useState<ConnectStart | null>(null);
  const [note, setNote] = useState<Said>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);
  const connect = async (a: Account) => {
    setBusy(a.provider); setNote(null); setStarted(null);
    const o = await data.connect(a.provider);
    setBusy(null);
    if (!o.ok || !o.start) { setNote({ text: o.ok ? 'That didn’t start. Try again.' : o.message, error: true }); return; }
    setStarted(o.start);
    if (o.start.kind === 'browser') window.open(o.start.url, '_blank', 'noopener');
    if (o.start.kind !== 'setup') {
      // the sign-in finishes on the provider's page: look again every few seconds for a while
      let n = 0;
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        const list = await data.refreshAccounts();
        const now = list?.find((x) => x.provider === a.provider);
        if ((now?.connected && !now.needsReconnect) || ++n > 60) {
          if (poll.current) clearInterval(poll.current);
          if (now?.connected) { setStarted(null); setNote({ text: `${a.label} is connected.`, error: false }); }
        }
      }, 3000);
    }
  };
  const accounts = data.accounts ?? [];
  return (
    <Section id="accounts" title="Connected">
      <div className="card setcard">
        {!accounts.length && <p className="soft">I couldn’t check your accounts just now.</p>}
        {accounts.map((a) => (
          <div className="setrow" key={a.provider}>
            <span className="logo" aria-hidden="true">{a.label[0]}</span>
            <div className="grow">
              <span className="rowtitle" id={`acct-${a.provider}`}>{a.label}{a.connected && !a.needsReconnect && <span className="okmark"> · connected</span>}</span>
              <span className={a.needsReconnect ? 's warnline' : 's'}>{accountLine(a)}</span>
            </div>
            {admin && (a.needsReconnect || !a.connected) && (
              <button type="button" className={a.needsReconnect ? 'vbtn vbtn-primary' : 'vbtn'} disabled={busy === a.provider}
                aria-describedby={`acct-${a.provider}`} onClick={() => void connect(a)}>
                {busy === a.provider ? 'Starting…' : a.needsReconnect ? 'Reconnect' : `Connect ${a.label}`}
              </button>
            )}
          </div>
        ))}
        {!admin && accounts.some((a) => !a.connected || a.needsReconnect) && <p className="soft">Connect them from your computer.</p>}
      </div>
      {started && <ConnectSteps s={started} onClose={() => setStarted(null)} />}
      <Note said={note} />
    </Section>
  );
}

export function ConnectSteps({ s, onClose }: { s: ConnectStart; onClose: () => void }) {
  const name = s.provider === 'google' ? 'Google' : 'Outlook';
  return (
    <div className="card connectsteps" role="status">
      {s.kind === 'code' && (
        <>
          <p>Go to <a className="linkish" href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\//, '')}</a> and enter this code:</p>
          <p className="paircode">{s.code}</p>
          <p className="soft">I’ll show {name} as connected once you finish. Keep this page open.</p>
        </>
      )}
      {s.kind === 'browser' && (
        <>
          <p>{s.message}</p>
          <p className="soft">No window? <a className="linkish" href={s.url} target="_blank" rel="noreferrer">Open the {name} sign-in</a></p>
        </>
      )}
      {s.kind === 'setup' && (
        <>
          <p>{s.message}</p>
          <p><a className="linkish" href={s.url}>Open the full settings</a></p>
        </>
      )}
      <div className="acts"><button type="button" className="vbtn vbtn-quiet" onClick={onClose}>Close</button></div>
    </div>
  );
}

// ---------- Spending ----------

function DollarField({ id, label, value, onSave, help, allowNone, noneLabel }: {
  id: string; label: string; value: number | null; onSave: (v: number | null) => Promise<ActOutcome>; help?: string; allowNone?: boolean; noneLabel?: string;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [note, setNote] = useState<Said>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(value === null ? '' : String(value)); }, [value]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim() === '' ? null : Number(text.replace(/[$,\s]/g, ''));
    if (v === null && !allowNone) { setNote({ text: 'Type a dollar amount.', error: true }); return; }
    if (v !== null && !Number.isFinite(v)) { setNote({ text: 'Type a dollar amount, for example 20.', error: true }); return; }
    setBusy(true); setNote(null);
    setNote(said(await onSave(v)));
    setBusy(false);
  };
  return (
    <form className="dollarform" onSubmit={submit}>
      <label htmlFor={id}>{label}</label>
      <span className="dollarrow">
        <span className="dollar" aria-hidden="true">$</span>
        <input id={id} className="setinput short" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-describedby={help ? `${id}-help` : undefined} />
        <button type="submit" className="vbtn" disabled={busy}>Save</button>
        {allowNone && value !== null && <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={async () => { setBusy(true); setNote(said(await onSave(null))); setBusy(false); }}>{noneLabel ?? 'No limit'}</button>}
      </span>
      {help && <span className="s" id={`${id}-help`}>{help}</span>}
      <Note said={note} />
    </form>
  );
}

function SpendingSection({ data, admin }: { data: ReturnType<typeof useSettingsData>; admin: boolean }) {
  const s = data.spending;
  if (!s) return <Section id="spending" title="This month"><div className="card"><p className="soft">I couldn’t read the spending just now.</p></div></Section>;
  const pct = s.limit.usd ? Math.min(100, Math.round((s.month.usd / s.limit.usd) * 100)) : null;
  const bg = backgroundLine(s);
  return (
    <Section id="spending" title="This month">
      <div className="card setcard">
        <p className="spendline"><b>{spendLine(s)}</b></p>
        {pct !== null && <div className="prog" role="progressbar" aria-label="Spent this month" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>}
        {s.limit.state === 'warn' && <p className="warnline">You’ve used most of this month’s limit. At the limit, jobs that run on their own wait until next month.</p>}
        {s.limit.state === 'over' && <p className="warnline">This month’s limit is reached. Jobs that run on their own wait until next month; chats still work.</p>}
        {bg && <p className="soft">{bg}</p>}
        {admin && !s.limit.fixed && (
          <DollarField id="limit-month" label="Monthly limit" value={s.limit.usd} allowNone noneLabel="No limit"
            help="I warn you at 80%. At the limit, jobs that run on their own wait until next month."
            onSave={(v) => data.updateSpending({ monthlyUsd: v })} />
        )}
        {s.limit.fixed && <p className="soft">The monthly limit was set when your helper was installed.</p>}
      </div>
      <h3 className="subhead">Limits for each kind of job</h3>
      <div className="card setcard">
        <div className="setrow"><div className="grow"><span className="rowtitle">A job you hand over</span><span className="s">Set from its estimate, at most {money(s.defaults.handoffMaxUsd)}. You can change it before it starts.</span></div></div>
        <div className="setrow"><div className="grow"><span className="rowtitle">Continue or start over</span><span className="s">Set from what’s left, at most {money(s.defaults.continueMaxUsd)}.</span></div></div>
        <div className="setrow col">
          <div className="grow"><span className="rowtitle">Each run of a repeating job</span>
            <span className="s">{s.defaults.perFireUsd ? `${money(s.defaults.perFireUsd)} a run, unless the job has its own limit.` : 'No limit unless the job has its own.'}</span></div>
          {admin && !s.defaults.perFireFixed && (
            <DollarField id="limit-fire" label="Limit for each run" value={s.defaults.perFireUsd} allowNone noneLabel="Use the default"
              onSave={(v) => data.updateSpending({ perFireUsd: v })} />
          )}
        </div>
      </div>
    </Section>
  );
}

// ---------- Devices ----------

function Devices({ data, admin }: { data: ReturnType<typeof useSettingsData>; admin: boolean }) {
  const store = useStore();
  const now = useNow(60_000);
  const [code, setCode] = useState<PairCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const me = data.me;
  const pair = async () => {
    setBusy(true); setNote(null);
    const r = await data.createPairCode();
    setBusy(false);
    if (r.ok) setCode(r.code); else setNote({ text: r.message, error: true });
  };
  const list = activeDevices(data.devices ?? [], me?.deviceId ?? null);
  const signOutLine = me?.kind === 'local' ? null : me?.kind === 'device' ? 'Sign out this phone' : 'Sign out on this device';
  return (
    <Section id="devices" title="Devices">
      <div className="card setcard">
        {me?.kind === 'local' && <div className="setrow"><div className="grow"><span className="rowtitle">This computer <span className="tagthis">This device</span></span><span className="s">Your helper runs here, so it is always signed in.</span></div></div>}
        {me?.kind === 'session' && <div className="setrow"><div className="grow"><span className="rowtitle">This browser <span className="tagthis">This device</span></span><span className="s">Signed in with your password.</span></div></div>}
        {admin && !list.length && <p className="soft pad">No phones paired yet.</p>}
        {!admin && me?.kind === 'device' && (
          <div className="setrow"><div className="grow"><span className="rowtitle">{me.deviceName ?? 'This phone'} <span className="tagthis">This device</span></span><span className="s">Paired with your helper.</span></div></div>
        )}
        {admin && list.map((d) => (
          <DeviceRow key={d.id} d={d} now={now} isThis={d.id === me?.deviceId} renaming={renaming === d.id} confirming={confirm === d.id}
            onRename={() => { setRenaming(d.id); setConfirm(null); }} onCancel={() => { setRenaming(null); setConfirm(null); }}
            onSaveName={async (name) => { const o = await data.renameDevice(d.id, name); setNote(said(o)); if (o.ok) setRenaming(null); }}
            onAskRemove={() => { setConfirm(d.id); setRenaming(null); }}
            onRemove={async () => { const o = await data.removeDevice(d); setConfirm(null); setNote(said(o)); }} />
        ))}
        {(admin || signOutLine) && (
          <div className="acts">
            {admin && !code && <button type="button" className="vbtn vbtn-primary" onClick={() => void pair()} disabled={busy}>Pair a new device</button>}
            {admin && me?.kind === 'session' && <button type="button" className="vbtn vbtn-quiet" onClick={async () => { const o = await data.signOutEverywhere(); if (!o.ok) setNote(said(o)); }}>Sign out everywhere</button>}
            {signOutLine && <button type="button" className="vbtn" onClick={async () => {
              const o = await data.signOut();
              if (!o.ok) setNote(said(o));
              else if (me?.kind === 'device' && !store.getState().fixtures) location.assign('/pair');
            }}>{signOutLine}</button>}
          </div>
        )}
        {me?.kind === 'device' && <p className="soft">Signing out removes this phone’s key and clears what it saved. To use it again, pair it from your computer.</p>}
      </div>
      {code && <PairCodeCard code={code} now={store.now} busy={busy} onNew={() => void pair()} onDone={() => { setCode(null); void data.reload(); }}
        onSetAddress={async (url) => { const o = await data.updateSettings({ publicUrl: url }); if (o.ok) await pair(); return o; }} />}
      <Note said={note} />
    </Section>
  );
}

function DeviceRow({ d, now, isThis, renaming, confirming, onRename, onCancel, onSaveName, onAskRemove, onRemove }: {
  d: Device; now: number; isThis: boolean; renaming: boolean; confirming: boolean;
  onRename: () => void; onCancel: () => void; onSaveName: (n: string) => Promise<void>; onAskRemove: () => void; onRemove: () => Promise<void>;
}) {
  const [name, setName] = useState(d.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(d.name); }, [d.name, renaming]);
  if (renaming) {
    return (
      <form className="setrow col" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onSaveName(name); setBusy(false); }}>
        <label htmlFor={`rn-${d.id}`} className="rowtitle">New name for {d.name}</label>
        <span className="dollarrow">
          <input id={`rn-${d.id}`} className="setinput" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />
          <button type="submit" className="vbtn" disabled={busy}>Save</button>
          <button type="button" className="vbtn vbtn-quiet" onClick={onCancel}>Cancel</button>
        </span>
      </form>
    );
  }
  return (
    <div className="setrow devrow" role="group" aria-label={d.name}>
      <div className="grow">
        <span className="rowtitle">{d.name}{isThis && <span className="tagthis">This device</span>}</span>
        <span className="s">{lastUsed(d.lastSeen, now)} · paired {new Date(d.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        {confirming && <span className="s warnline">Remove {d.name}? It stops working at once. You can pair it again later.</span>}
      </div>
      {confirming ? (
        <span className="rowacts">
          <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={async () => { setBusy(true); await onRemove(); setBusy(false); }}>Remove</button>
          <button type="button" className="vbtn vbtn-quiet" onClick={onCancel}>Keep</button>
        </span>
      ) : (
        <span className="rowacts">
          <button type="button" className="vbtn vbtn-quiet" onClick={onRename} aria-label={`Rename ${d.name}`}>Rename</button>
          <button type="button" className="vbtn" onClick={onAskRemove} aria-label={`Remove ${d.name}`}>Remove</button>
        </span>
      )}
    </div>
  );
}

// ---------- Your rules ----------

function RulesSection() {
  const rules = useRules(true);
  const actions = useItemActions();
  const [note, setNote] = useState<Said>(null);
  const when = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return (
    <Section id="rules" title="Your rules">
      <div className="card setcard">
        <p className="soft">What you taught me by marking mail important or not. I only make rules from your taps, never from what a message says.</p>
        {rules.loading && !rules.loaded && <p className="empty">Loading…</p>}
        {rules.error && !rules.loaded && <p className="soft">{rules.error}</p>}
        {rules.loaded && !rules.list.length && <p className="soft">No rules yet. When you mark something not important, I remember it here.</p>}
        {rules.list.map((r) => (
          <div className="setrow" key={r.id} role="group" aria-label={ruleLine(r)}>
            <div className="grow">
              <span className="rowtitle ruleline">{ruleLine(r)}</span>
              <span className="s">{ruleEffectLine(r)} Since {when(r.createdAt)}.</span>
            </div>
            <button type="button" className="vbtn" aria-label={`Remove the rule: ${ruleLine(r)}`} onClick={async () => {
              setNote(null);
              const res = await actions.deleteRule(r);
              if (res.ok) setNote({ text: res.message ?? 'Removed. That mail is sorted as usual again.', error: false });
              else if (!res.queued) setNote({ text: res.message, error: true });
            }}>Remove</button>
          </div>
        ))}
      </div>
      <Note said={note} />
    </Section>
  );
}

// ---------- the helper ----------

function zones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; }
}

function HelperSection({ data, admin }: { data: ReturnType<typeof useSettingsData>; admin: boolean }) {
  const s = data.settings;
  const [helperName, setHelperName] = useState(s?.helperName ?? '');
  const [ownerName, setOwnerName] = useState(s?.ownerName ?? '');
  const [tz, setTz] = useState(s?.timeZone ?? '');
  const [pub, setPub] = useState(s?.publicUrl ?? '');
  const [note, setNote] = useState<Said>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s) { setHelperName(s.helperName); setOwnerName(s.ownerName ?? ''); setTz(s.timeZone); setPub(s.publicUrl ?? ''); } }, [s]);
  if (!s) return null;
  const list = zones();
  const options = list.includes(s.timeZone) ? list : [s.timeZone, ...list];
  if (!admin) {
    return (
      <Section id="helper" title="Your helper">
        <div className="card setcard">
          <div className="setrow"><div className="grow"><span className="rowtitle">Name</span><span className="s">{s.helperName}</span></div></div>
          <div className="setrow"><div className="grow"><span className="rowtitle">What I call you</span><span className="s">{s.ownerName ?? 'Not set'}</span></div></div>
          <div className="setrow"><div className="grow"><span className="rowtitle">Time zone</span><span className="s">{s.timeZone.replace(/_/g, ' ')}</span></div></div>
          {s.publicUrl && <div className="setrow"><div className="grow"><span className="rowtitle">Address for phones</span><span className="s">{s.publicUrl}</span></div></div>}
        </div>
      </Section>
    );
  }
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (helperName.trim() !== s.helperName) patch.helperName = helperName;
    if (!s.ownerNameFixed && (ownerName.trim() || null) !== s.ownerName) patch.ownerName = ownerName.trim() || null;
    if (!s.timeZoneFixed && tz !== s.timeZone) patch.timeZone = tz;
    if (!s.publicUrlFixed && (pub.trim() || null) !== s.publicUrl) patch.publicUrl = pub.trim() || null;
    if (!Object.keys(patch).length) { setNote({ text: 'Nothing to save.', error: false }); return; }
    setBusy(true); setNote(null);
    setNote(said(await data.updateSettings(patch)));
    setBusy(false);
  };
  return (
    <Section id="helper" title="Your helper">
      <form className="card setcard setform" onSubmit={save}>
        <label htmlFor="set-helpername">What should I call myself?</label>
        <input id="set-helpername" className="setinput" value={helperName} maxLength={40} onChange={(e) => setHelperName(e.target.value)} />
        <label htmlFor="set-ownername">What should I call you?</label>
        <input id="set-ownername" className="setinput" value={ownerName} maxLength={40} disabled={s.ownerNameFixed} onChange={(e) => setOwnerName(e.target.value)} aria-describedby="set-ownername-help" />
        <span className="s" id="set-ownername-help">{s.ownerNameFixed ? 'Set when your helper was installed.' : 'I use it to greet you: “Good morning, Robert.”'}</span>
        <label htmlFor="set-tz">Time zone</label>
        {options.length > 1 ? (
          <select id="set-tz" className="setinput" value={tz} disabled={s.timeZoneFixed} onChange={(e) => setTz(e.target.value)} aria-describedby="set-tz-help">
            {options.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        ) : (
          <input id="set-tz" className="setinput" value={tz} disabled={s.timeZoneFixed} onChange={(e) => setTz(e.target.value)} aria-describedby="set-tz-help" />
        )}
        <span className="s" id="set-tz-help">{s.timeZoneFixed ? 'Set when your helper was installed.' : 'For your calendar, reminders and what counts as today.'}</span>
        <label htmlFor="set-pub">Your helper’s address for phones</label>
        <input id="set-pub" className="setinput" inputMode="url" placeholder="https://mwa.tail1a2b.ts.net" value={pub} disabled={s.publicUrlFixed} onChange={(e) => setPub(e.target.value)} aria-describedby="set-pub-help" />
        <span className="s" id="set-pub-help">{s.publicUrlFixed ? 'Set when your helper was installed.' : 'What your phone opens to reach your helper. Pairing codes use it.'}</span>
        <div className="acts"><button type="submit" className="vbtn vbtn-primary" disabled={busy}>Save</button></div>
        <Note said={note} />
      </form>
    </Section>
  );
}

function Switches({ data, admin }: { data: ReturnType<typeof useSettingsData>; admin: boolean }) {
  const s = data.settings;
  const [note, setNote] = useState<Said>(null);
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  return (
    <Section id="switches" title="What I keep up to date">
      <div className="card setcard">
        {s.features.map((f) => (
          <div className="setrow" key={f.id}>
            <div className="grow">
              <span className="rowtitle" id={`sw-${f.id}`}>{f.label}</span>
              <span className="s" id={`sw-${f.id}-note`}>{f.on ? f.note : f.canChange ? 'Off. Turn it on?' : f.note}</span>
            </div>
            {admin && f.canChange ? (
              <button type="button" className="switch" role="switch" aria-checked={f.on} aria-labelledby={`sw-${f.id}`} aria-describedby={`sw-${f.id}-note`} disabled={busy}
                onClick={async () => { setBusy(true); setNote(null); const o = await data.updateSettings({ features: { [f.id]: !f.on } }); setNote(o.ok ? { text: `${f.label}: ${!f.on ? 'on' : 'off'}.`, error: false } : said(o)); setBusy(false); }} />
            ) : (
              <span className={f.on ? 'onoff on' : 'onoff'}>{f.on ? 'On' : 'Off'}</span>
            )}
          </div>
        ))}
      </div>
      <Note said={note} />
    </Section>
  );
}

function SavedLogins({ data }: { data: ReturnType<typeof useSettingsData> }) {
  const [note, setNote] = useState<Said>(null);
  const v = data.vault ?? [];
  return (
    <Section id="logins" title="Saved logins">
      <div className="card setcard">
        <p className="soft">Sign-ins your helper may use for you. I show the names only, never a password.</p>
        {!v.length && <p className="soft">Nothing saved.</p>}
        {v.map((e) => (
          <div className="setrow" key={e.name}>
            <div className="grow"><span className="rowtitle">{e.name}</span><span className="s">{[e.site, e.fields.join(', ')].filter(Boolean).join(' · ')}</span></div>
            <button type="button" className="vbtn" aria-label={`Forget ${e.name}`} onClick={async () => setNote(said(await data.forgetLogin(e.name)))}>Forget</button>
          </div>
        ))}
      </div>
      <Note said={note} />
    </Section>
  );
}

// ---------- Look and About ----------

function Look() {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('mwa-v2-theme') ?? 'auto'; } catch { return 'auto'; } });
  const pick = (t: string) => {
    setTheme(t);
    try { localStorage.setItem('mwa-v2-theme', t); } catch { /* private mode */ }
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  };
  return (
    <section aria-labelledby="th-h" className="setsec">
      <h2 className="sh" id="th-h">Look</h2>
      <div className="seg" role="radiogroup" aria-labelledby="th-h">
        {['light', 'dark', 'auto'].map((t) => (
          <button key={t} type="button" role="radio" aria-checked={theme === t} onClick={() => pick(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
    </section>
  );
}

function About({ serverVersion, minClient, admin, restart }: { serverVersion: string | null; minClient: string | null; admin: boolean; restart: () => Promise<ActOutcome> }) {
  const classic = () => { try { localStorage.setItem('mwa-ui', 'v1'); } catch { /* */ } location.href = `${location.pathname}?ui=v1`; };
  const [note, setNote] = useState<Said>(null);
  return (
    <Section id="about" title="About">
      <div className="card setcard">
        <div className="setrow"><div className="grow"><span className="rowtitle">Your helper</span><span className="s">{serverVersion ? `Version ${serverVersion}. Works with this app from version ${minClient ?? '1.0.0'}.` : 'Not reached yet.'}</span></div></div>
        <div className="setrow"><div className="grow"><span className="rowtitle">This app</span><span className="s">Version {WEB_VERSION}.</span></div></div>
        <div className="setrow"><div className="grow"><span className="rowtitle">The new app is a preview</span><span className="s">Switch back to the app you know at any time.</span></div>
          <button type="button" className="vbtn" onClick={classic}>Use the current app</button></div>
        {admin && <div className="setrow"><div className="grow"><span className="rowtitle">Setup</span><span className="s">Go through the welcome again: name, accounts, your phone.</span></div>
          <button type="button" className="vbtn vbtn-quiet" onClick={async () => { const o = await restart(); if (o.ok) window.dispatchEvent(new Event(START_CHECK_EVENT)); else setNote(said(o)); }}>Start the welcome again</button></div>}
      </div>
      <Note said={note} />
    </Section>
  );
}
