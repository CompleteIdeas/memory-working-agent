/**
 * Settings › Plug-ins (v2 build, slice S1): the extra skills your helper can use (MCP servers), in three groups — On,
 * Available, Your own — each saying what it can touch; a switch; keys typed into password fields that are cleared once
 * sent (a saved key is never shown, only "saved"); Remove for your own; and "Add from npm" with the safety review
 * shown before anything is installed (or the reason it is off). A paired phone sees the list read-only.
 */
import { useState, type FormEvent } from 'react';
import { Back } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import type { CustomPlugin, Plugin, PluginReview } from '../../api/client';
import { Note, Section, said, type Said } from './Settings';
import { customTitle, groupPlugins, installable, keyLine, needsTrust, scanLine, usePlugins, verdictWords } from './usePlugins';
import './settings.css';

type Data = ReturnType<typeof usePlugins>;

export function Plugins({ go }: ScreenProps) {
  const data = usePlugins();
  const groups = data.list ? groupPlugins(data.list) : null;
  return (
    <div className="col-main setpage plugpage">
      <button type="button" className="backbtn keep" onClick={() => go('settings')}><Back />Settings</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Settings</p><h1>Plug-ins</h1></div></header>
      <p className="plugintro">Plug-ins give your helper extra skills, like searching the web or reading your GitHub. Each one says what it can touch. Changes take effect on your next message.</p>
      {data.loading && <p className="empty">Loading…</p>}
      {data.error && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {!data.loading && !data.error && groups && data.list && (
        <>
          {!data.admin && (
            <p className="card adminnote" role="note">
              This {data.me?.kind === 'device' ? 'phone' : 'device'} can see your plug-ins but not change them. Turn them on or off, add keys and add new ones on your computer, or after signing in with your password.
            </p>
          )}
          <Section id="plug-on" title="On">
            <div className="card setcard">
              {!groups.on.length && <p className="soft">None on. Your helper still chats, and reads your mail and calendar.</p>}
              {groups.on.map((p) => <PluginRow key={p.id} p={p} data={data} />)}
            </div>
          </Section>
          <Section id="plug-available" title="Available">
            <div className="card setcard">
              {!groups.available.length && <p className="soft">Everything in the library is on.</p>}
              {groups.available.map((p) => <PluginRow key={p.id} p={p} data={data} />)}
            </div>
          </Section>
          <Section id="plug-own" title="Your own">
            <div className="card setcard">
              <p className="soft">Plug-ins you added yourself, by hand or from npm. They run on the computer your helper runs on.</p>
              {!groups.custom.length && <p className="soft">None yet.</p>}
              {groups.custom.map((c) => <CustomRow key={c.id} c={c} data={data} />)}
            </div>
          </Section>
          <AddFromNpm data={data} />
        </>
      )}
    </div>
  );
}

// ---------- a library plug-in ----------

function PluginRow({ p, data }: { p: Plugin; data: Data }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const [wantOn, setWantOn] = useState(false);
  const kl = keyLine(p);
  const flip = async () => {
    setNote(null);
    if (!p.on && p.missing.length) { setWantOn(true); setOpen(true); setNote({ text: 'Add the key first, then it turns on.', error: false }); return; }
    setBusy(true);
    const o = p.on ? await data.turnOff(p.id) : await data.turnOn(p.id);
    setNote(o.ok ? null : said(o)); // a success is a notice: the row moves to the other group
    setBusy(false);
  };
  return (
    <div className="setrow col plugrow" role="group" aria-labelledby={`pl-${p.id}`}>
      <div className="plughead">
        <div className="grow">
          <span className="rowtitle" id={`pl-${p.id}`}>{p.name}</span>
          <span className="s">{p.description}</span>
        </div>
        {data.admin ? (
          <button type="button" className="switch" role="switch" aria-checked={p.on} aria-labelledby={`pl-${p.id}`} aria-describedby={`pl-${p.id}-touch`} disabled={busy} onClick={() => void flip()} />
        ) : (
          <span className={p.on ? 'onoff on' : 'onoff'}>{p.on ? 'On' : 'Off'}</span>
        )}
      </div>
      <span className="s plugtouch" id={`pl-${p.id}-touch`}><b>Can touch:</b> {p.access}</span>
      {kl && <span className={p.missing.length ? 's warnline' : 's'}>{kl}</span>}
      {data.admin && p.keys.length > 0 && !open && (
        <div className="acts"><button type="button" className="vbtn vbtn-quiet" aria-label={`${p.keys.some((k) => k.saved) ? 'Change' : 'Add'} the key for ${p.name}`} onClick={() => { setOpen(true); setNote(null); }}>
          {p.keys.some((k) => k.saved) ? 'Change key' : p.keys.length > 1 ? 'Add keys' : 'Add key'}
        </button></div>
      )}
      {data.admin && open && (
        <KeyForm p={p} data={data} turnOn={wantOn && !p.on} onDone={(n) => { setOpen(false); setWantOn(false); setNote(n); }} onCancel={() => { setOpen(false); setWantOn(false); setNote(null); }} />
      )}
      {p.source && <a className="linkish plugsrc" href={p.source} target="_blank" rel="noreferrer">Where it comes from<span className="sr-only"> ({p.name})</span></a>}
      <Note said={note} />
    </div>
  );
}

function KeyForm({ p, data, turnOn, onDone, onCancel }: { p: Plugin; data: Data; turnOn: boolean; onDone: (n: Said) => void; onCancel: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const keys = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    if (!Object.keys(keys).length) { setNote({ text: 'Type a key, or Cancel.', error: true }); return; }
    setBusy(true); setNote(null);
    const o = await data.saveKeys(p.id, keys);
    setVals({}); // never kept on screen once sent
    if (!o.ok) { setBusy(false); setNote(said(o)); return; }
    if (turnOn) {
      const on = await data.turnOn(p.id);
      setBusy(false);
      onDone(on.ok ? null : { text: `Key saved, but ${on.message.charAt(0).toLowerCase()}${on.message.slice(1)}`, error: true });
      return;
    }
    setBusy(false);
    onDone(said(o));
  };
  return (
    <form className="setform plugkeys" onSubmit={submit} aria-label={`Keys for ${p.name}`}>
      {p.keys.map((k) => (
        <div key={k.name} className="plugkey">
          <label htmlFor={`key-${p.id}-${k.name}`}>{k.label}{k.optional ? ' (optional)' : ''}{k.saved && <span className="okmark"> · saved</span>}</label>
          <input id={`key-${p.id}-${k.name}`} className="setinput" type="password" autoComplete="off" spellCheck={false}
            placeholder={k.saved ? 'Saved. Type a new one to replace it' : ''} value={vals[k.name] ?? ''}
            onChange={(e) => setVals((v) => ({ ...v, [k.name]: e.target.value }))} aria-describedby={k.help ? `key-${p.id}-${k.name}-help` : undefined} />
          {k.help && <span className="s" id={`key-${p.id}-${k.name}-help`}>{k.help}</span>}
          {k.saved && (
            <span className="plugclear">
              <button type="button" className="vbtn vbtn-quiet" disabled={busy} aria-label={`Clear the saved ${k.label}`}
                onClick={async () => { setBusy(true); setNote(null); const o = await data.clearKey(p.id, k.name); setBusy(false); setNote(said(o)); }}>Clear saved key</button>
            </span>
          )}
        </div>
      ))}
      <span className="s">Keys are kept on the computer your helper runs on. I never show them again.</span>
      <div className="acts">
        <button type="submit" className="vbtn vbtn-primary" disabled={busy}>{busy ? 'Saving…' : turnOn ? 'Save and turn on' : 'Save'}</button>
        <button type="button" className="vbtn vbtn-quiet" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      <Note said={note} />
    </form>
  );
}

// ---------- your own ----------

function CustomRow({ c, data }: { c: CustomPlugin; data: Data }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const title = customTitle(c);
  return (
    <div className="setrow col plugrow" role="group" aria-label={title}>
      <div className="plughead">
        <div className="grow">
          <span className="rowtitle">{title}</span>
          <span className="s">{c.package ? 'Added from npm.' : 'Added by hand.'} Always on while it’s here.</span>
        </div>
        {!data.admin && <span className="onoff on">On</span>}
      </div>
      <span className="s plugcmd"><span className="sr-only">Runs: </span><code>{c.command}</code></span>
      {c.argsHidden && <span className="s">The rest of the command is hidden on this device. See it on your computer.</span>}
      {c.envNames.length > 0 && <span className="s">Has its own settings: {c.envNames.join(', ')} (not shown).</span>}
      {data.admin && (confirm ? (
        <>
          <span className="s warnline">Remove {title}? Your helper stops using it from your next message.</span>
          <div className="acts">
            <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={async () => { setBusy(true); const o = await data.remove(c.id); setBusy(false); setConfirm(false); if (!o.ok) setNote(said(o)); }}>Remove</button>
            <button type="button" className="vbtn vbtn-quiet" onClick={() => setConfirm(false)}>Keep</button>
          </div>
        </>
      ) : (
        <div className="acts"><button type="button" className="vbtn" aria-label={`Remove ${title}`} onClick={() => { setConfirm(true); setNote(null); }}>Remove</button></div>
      ))}
      <Note said={note} />
    </div>
  );
}

// ---------- add from npm ----------

function AddFromNpm({ data }: { data: Data }) {
  const x = data.list!.addFromNpm;
  const [pkg, setPkg] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const [review, setReview] = useState<PluginReview | null>(null);
  const [trust, setTrust] = useState(false);
  if (!data.admin) {
    return (
      <Section id="plug-npm" title="Add from npm">
        <div className="card setcard"><p className="soft">{x.available ? 'New plug-ins can be added from your computer, after a safety review.' : x.reason}</p></div>
      </Section>
    );
  }
  const doReview = async (e: FormEvent) => {
    e.preventDefault();
    const name = pkg.trim();
    if (!name) { setNote({ text: 'Type the npm package name, for example @scope/server-name.', error: true }); return; }
    setBusy(true); setNote(null); setReview(null); setTrust(false);
    const r = await data.review(name);
    setBusy(false);
    if (r.ok) setReview(r.review); else setNote({ text: r.message, error: true });
  };
  const install = async () => {
    if (!review) return;
    setBusy(true); setNote(null);
    const o = await data.approve(review.package, needsTrust(review) && trust);
    setBusy(false);
    setNote(said(o));
    if (o.ok) { setReview(null); setPkg(''); setTrust(false); }
  };
  const v = review ? verdictWords(review.verdict) : null;
  return (
    <Section id="plug-npm" title="Add from npm">
      <div className="card setcard">
        {!x.available ? (
          <p className="soft" id="npm-off">{x.reason}</p>
        ) : (
          <>
            <p className="soft">Add a plug-in that isn’t in the list above. First {x.reviewer ? <>a safety review by <span className="addrmono">{x.reviewer}</span></> : 'a safety review'} reads it; then you decide. Installing runs someone else’s code on the computer your helper runs on.</p>
            <form className="dollarform" onSubmit={doReview}>
              <label htmlFor="npm-pkg">npm package</label>
              <span className="dollarrow">
                <input id="npm-pkg" className="setinput" value={pkg} placeholder="@scope/server-name" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  onChange={(e) => { setPkg(e.target.value); setReview(null); }} aria-describedby="npm-pkg-help" />
                <button type="submit" className="vbtn" disabled={busy}>{busy && !review ? 'Reviewing…' : 'Review'}</button>
              </span>
              <span className="s" id="npm-pkg-help">The review takes up to a minute. Nothing is installed until you say so.</span>
            </form>
            {review && v && (
              <div className={`plugreview ${v.tone}`} role="region" aria-label={`Safety review of ${review.package}`}>
                <p className="plugverdict"><b>{v.title}</b> · {review.package}{review.version ? ` ${review.version}` : ''}</p>
                <p>{review.summary}</p>
                {!review.aiReviewed && <p className="warnline" role="note">The safety check couldn’t reach the AI reviewer. Only the automated checks ran.</p>}
                {review.capabilities.length > 0 && <><p className="s"><b>It could:</b></p><ul className="pluglist">{review.capabilities.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
                {review.redFlags.length > 0 && <><p className="s"><b>Warnings:</b></p><ul className="pluglist">{review.redFlags.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
                <p className="s">{scanLine(review)}{review.aiReviewed ? ` Reviewed by ${review.reviewer}.` : ''}</p>
                {!installable(review) && <p className="s warnline">This package couldn’t be checked, so it can’t be installed.</p>}
                {installable(review) && needsTrust(review) && (
                  <label className="plugtrust"><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> I trust where this came from and want it anyway.</label>
                )}
                <div className="acts">
                  {installable(review) && (
                    <button type="button" className="vbtn vbtn-primary" disabled={busy || (needsTrust(review) && !trust)} onClick={() => void install()}>
                      {busy ? 'Installing…' : needsTrust(review) ? 'Install anyway' : `Install ${review.package}`}
                    </button>
                  )}
                  <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => { setReview(null); setTrust(false); }}>{installable(review) ? 'Don’t install' : 'Close'}</button>
                </div>
              </div>
            )}
          </>
        )}
        <Note said={note} />
      </div>
    </Section>
  );
}
