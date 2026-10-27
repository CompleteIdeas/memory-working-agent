/**
 * Settings › Your assistant (v2 build, slice S2): the assistant itself, as the classic Connections page has it: its AI
 * brain (provider, key, model, with what the choice does to adding plug-ins from npm), making images, what it can
 * touch (the access level and the folders it may use) and how it works with you (Guided or Direct). Keys go into
 * password fields that are cleared once sent; a saved key is never shown, only "saved". A paired phone sees the
 * settings read-only, with one line that says why.
 */
import { useState, type FormEvent } from 'react';
import { Back, Chev } from '../../shell/icons';
import type { ScreenProps } from '../../shell/screens';
import type { AccessPreset, AssistantSettings, InteractionStyle } from '../../api/client';
import { Note, Section, said, type Said } from './Settings';
import {
  PRESETS, STYLES, folderPlaceholder, imageLine, keyHint, noModelsLine, npmAfterLine, npmLine, presetOf, providerLabel, specOf, styleOf,
  useAssistant, type ModelChoice,
} from './useAssistant';
import './settings.css';

type Data = ReturnType<typeof useAssistant>;

export function Assistant({ go }: ScreenProps) {
  const data = useAssistant();
  const a = data.a;
  return (
    <div className="col-main setpage aspage">
      <button type="button" className="backbtn keep" onClick={() => go('settings')}><Back />Settings</button>
      <header className="vh"><div className="vh-text"><p className="vh-kicker">Settings</p><h1>Your assistant</h1></div></header>
      <p className="plugintro">Which AI does the thinking, what it can touch, and how it talks with you. Changes take effect on your next message.</p>
      {data.loading && <p className="empty">Loading…</p>}
      {data.error && <div className="card"><p>{data.error}</p><div className="acts"><button type="button" className="vbtn" onClick={() => void data.reload()}>Try again</button></div></div>}
      {!data.loading && !data.error && a && (
        <>
          {!data.admin && (
            <p className="card adminnote" role="note">
              This {data.me?.kind === 'device' ? 'phone' : 'device'} can see how your assistant is set up but not change it. Change these on your computer, or after signing in with your password.
            </p>
          )}
          <Brain a={a} data={data} go={go} />
          <Images a={a} data={data} />
          <Access a={a} data={data} />
          <Style a={a} data={data} />
        </>
      )}
    </div>
  );
}

// ---------- the brain ----------

function Brain({ a, data, go }: { a: AssistantSettings; data: Data; go: ScreenProps['go'] }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<Said>(null);
  return (
    <Section id="as-brain" title="AI brain">
      <div className="card setcard">
        <div className="setrow col">
          <span className="rowtitle">{providerLabel(a, a.brain.provider)}</span>
          <span className="s addrmono" id="brain-now">{specOf(a.brain) || 'Not set'}</span>
          {a.brain.notes.map((n) => <span key={n.text} className={n.standing === 'failed' ? 's warnline' : 's'}>{n.text}</span>)}
          {a.brain.fixed && <span className="s">The server’s MWA_MODEL setting chooses this, and it wins over a choice here. Change it there.</span>}
          {data.admin && !a.brain.fixed && !open && (
            <div className="acts"><button type="button" className="vbtn" aria-label="Change the AI brain" onClick={() => { setOpen(true); setNote(null); }}>Change</button></div>
          )}
        </div>
        {data.admin && open && <ModelForm kind="chat" a={a} data={data} onDone={(n) => { setOpen(false); setNote(n); }} onCancel={() => setOpen(false)} />}
        <Note said={note} />
        <div className="setrow">
          <div className="grow">
            <span className="rowtitle" id="npm-title">Adding plug-ins from npm</span>
            <span className="s" id="npm-line">{npmLine(a.addFromNpm)}</span>
          </div>
          <button type="button" className="vbtn vbtn-quiet" aria-describedby="npm-line" onClick={() => go('plugins')}>Plug-ins<Chev /></button>
        </div>
      </div>
    </Section>
  );
}

/** Pick a provider, give a key (write-only), load the models, pick one and save. `kind` image: the image model. */
function ModelForm({ kind, a, data, onDone, onCancel }: { kind: 'chat' | 'image'; a: AssistantSettings; data: Data; onDone: (n: Said) => void; onCancel: () => void }) {
  const choices = kind === 'image' ? a.providers.filter((p) => p.images) : a.providers;
  const current = kind === 'image' ? a.image : a.brain;
  const start = choices.some((p) => p.id === current.provider) ? current.provider : choices[0]?.id ?? 'openrouter';
  const [provider, setProvider] = useState(start);
  const [key, setKey] = useState('');
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [model, setModel] = useState(current.provider === start ? current.model : '');
  const [busy, setBusy] = useState<'load' | 'save' | null>(null);
  const [note, setNote] = useState<Said>(null);
  const p = choices.find((x) => x.id === provider);
  const pre = kind === 'image' ? 'img' : 'brain';
  const load = async () => {
    setBusy('load'); setNote(null);
    const r = await data.loadModels(provider, kind, key.trim() || undefined);
    setBusy(null);
    if (!r.ok) { setNote({ text: r.message, error: true }); return; }
    setModels(r.models);
    if (!r.models.length) { setNote({ text: noModelsLine(p, kind), error: true }); return; }
    if (!r.models.some((m) => m.id === model)) setModel(r.models[0].id);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!model.trim()) { setNote({ text: 'Load the models and pick one first.', error: true }); return; }
    setBusy('save'); setNote(kind === 'chat' ? { text: 'Checking the model…', error: false } : null);
    const o = kind === 'image' ? await data.saveImage(provider, model.trim(), key.trim() || undefined) : await data.saveBrain(provider, model.trim(), key.trim() || undefined);
    setKey(''); // never kept on screen once sent
    setBusy(null);
    if (o.ok) onDone(said(o)); else setNote(said(o));
  };
  const picked = models?.find((m) => m.id === model);
  const after = kind === 'chat' ? npmAfterLine(picked, a.addFromNpm) : null;
  const hint = keyHint(p);
  return (
    <form className="setform asform" onSubmit={save} aria-label={kind === 'image' ? 'Change the image model' : 'Change the AI brain'}>
      <label htmlFor={`${pre}-provider`}>{kind === 'image' ? 'Image provider' : 'AI provider'}</label>
      <select id={`${pre}-provider`} className="setinput" value={provider} onChange={(e) => { setProvider(e.target.value); setModels(null); setModel(''); setNote(null); }}>
        {choices.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      {p && !p.keyless && (
        <>
          <label htmlFor={`${pre}-key`}>API key{p.keySaved && <span className="okmark"> · saved</span>}</label>
          <input id={`${pre}-key`} className="setinput" type="password" autoComplete="off" spellCheck={false} value={key}
            placeholder={p.keySaved ? 'Saved. Leave empty to keep it' : ''} onChange={(e) => setKey(e.target.value)} aria-describedby={hint ? `${pre}-key-help` : undefined} />
          {hint && <span className="s" id={`${pre}-key-help`}>{hint}</span>}
        </>
      )}
      <div className="acts"><button type="button" className="vbtn" disabled={!!busy} onClick={() => void load()}>{busy === 'load' ? 'Loading…' : models ? 'Load again' : 'Load models'}</button></div>
      {models && models.length > 0 && (
        <>
          <label htmlFor={`${pre}-model`}>{kind === 'image' ? 'Image model' : 'Model'}</label>
          <select id={`${pre}-model`} className="setinput" value={model} onChange={(e) => setModel(e.target.value)} aria-describedby={after ? `${pre}-after` : `${pre}-model-help`}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
          </select>
          {after ? <span className="s warnline" id={`${pre}-after`}>{after}</span>
            : <span className="s" id={`${pre}-model-help`}>{kind === 'image' ? 'Pictures are saved to your first folder below, or the workspace.' : 'Only models that can run your assistant are listed.'}</span>}
        </>
      )}
      {models && !models.length && kind === 'chat' && (
        <>
          <label htmlFor={`${pre}-model-typed`}>Model name</label>
          <input id={`${pre}-model-typed`} className="setinput" value={model} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
        </>
      )}
      {!models && <span className="s">Load the models to pick one.</span>}
      <div className="acts">
        <button type="submit" className="vbtn vbtn-primary" disabled={!!busy || !model.trim()}>{busy === 'save' ? (kind === 'chat' ? 'Checking…' : 'Saving…') : kind === 'chat' ? 'Check and save' : 'Save'}</button>
        <button type="button" className="vbtn vbtn-quiet" disabled={busy === 'save'} onClick={onCancel}>Cancel</button>
      </div>
      <Note said={note} />
    </form>
  );
}

// ---------- making images ----------

function Images({ a, data }: { a: AssistantSettings; data: Data }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const off = async () => { setBusy(true); setNote(null); setNote(said(await data.turnOffImages())); setBusy(false); };
  return (
    <Section id="as-image" title="Making pictures">
      <div className="card setcard">
        <div className="setrow col">
          <span className="rowtitle">Image model</span>
          <span className={a.image.on ? 's addrmono' : 's'} id="image-now">{imageLine(a)}</span>
          {a.image.fixed && <span className="s">The server’s MWA_MODEL_IMAGE setting chooses this. Change it there.</span>}
          {data.admin && !a.image.fixed && !open && (
            <div className="acts">
              <button type="button" className="vbtn" aria-label={a.image.on ? 'Change the image model' : 'Set up an image model'} onClick={() => { setOpen(true); setNote(null); }}>{a.image.on ? 'Change' : 'Set up'}</button>
              {a.image.on && <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => void off()}>Turn off</button>}
            </div>
          )}
        </div>
        {data.admin && open && <ModelForm kind="image" a={a} data={data} onDone={(n) => { setOpen(false); setNote(n); }} onCancel={() => setOpen(false)} />}
        <Note said={note} />
      </div>
    </Section>
  );
}

// ---------- what it can touch ----------

function Access({ a, data }: { a: AssistantSettings; data: Data }) {
  const [confirm, setConfirm] = useState<AccessPreset | null>(null);
  const [pending, setPending] = useState<AccessPreset | null>(null); // shown as chosen while it saves
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const [folder, setFolder] = useState('');
  const [fnote, setFnote] = useState<Said>(null);
  const where = a.access.hosted ? `On the ${a.access.host} server, not your own computer.` : 'On the computer your helper runs on.';
  const pick = async (id: AccessPreset) => {
    if (id === a.access.preset) return;
    if (id === 'developer') { setConfirm(id); setNote(null); return; } // the widest level: say what it means first
    setBusy(true); setNote(null); setConfirm(null); setPending(id);
    setNote(said(await data.setPreset(id))); setBusy(false); setPending(null);
  };
  const grant = async (e: FormEvent) => {
    e.preventDefault();
    const f = folder.trim();
    if (!f) { setFnote({ text: 'Type the folder’s full path.', error: true }); return; }
    setBusy(true); setFnote(null);
    const o = await data.grant(f);
    setBusy(false); setFnote(said(o));
    if (o.ok) setFolder('');
  };
  const cur = presetOf(a.access.preset);
  return (
    <Section id="as-access" title="What it can touch">
      <div className="card setcard">
        <p className="soft">{where}</p>
        {data.admin ? (
          <fieldset className="aschoices" disabled={busy}>
            <legend className="rowtitle">Access level</legend>
            {PRESETS.map((p) => (
              <label key={p.id} className="aschoice">
                <input type="radio" name="as-preset" value={p.id} checked={(confirm ?? pending ?? a.access.preset) === p.id} onChange={() => void pick(p.id)} aria-describedby={`preset-${p.id}`} />
                <span className="grow"><span className="rowtitle">{p.label}</span><span className="s" id={`preset-${p.id}`}>{p.detail}</span></span>
              </label>
            ))}
          </fieldset>
        ) : (
          <div className="setrow col"><span className="rowtitle">Access level: {cur.label}</span><span className="s">{cur.detail}</span></div>
        )}
        {confirm === 'developer' && (
          <div className="plugreview bad" role="region" aria-label="Switch to Developer?">
            <p><b>Switch to Developer?</b> Your assistant will run any command on this computer without asking, and approvals stop being a safeguard. Choose it only on a computer you don’t mind it changing.</p>
            <div className="acts">
              <button type="button" className="vbtn vbtn-primary" disabled={busy} onClick={async () => { setBusy(true); const o = await data.setPreset('developer'); setBusy(false); setConfirm(null); setNote(said(o)); }}>Switch to Developer</button>
              <button type="button" className="vbtn vbtn-quiet" disabled={busy} onClick={() => setConfirm(null)}>Keep {cur.label}</button>
            </div>
          </div>
        )}
        <Note said={note} />
        <h3 className="subhead" id="as-folders">Folders it can use</h3>
        {a.access.preset === 'locked-down' && <p className="soft">Locked-down uses only its own workspace, so these folders aren’t used right now.</p>}
        {!a.access.folders.length && <p className="soft">None yet. It can only use its own workspace.</p>}
        {a.access.folders.map((f) => <FolderRow key={f.path} f={f} data={data} />)}
        {data.admin && (
          <form className="dollarform" onSubmit={grant}>
            <label htmlFor="as-folder">Add a folder</label>
            <span className="dollarrow">
              <input id="as-folder" className="setinput" value={folder} placeholder={folderPlaceholder(a.access.hosted)} autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(e) => setFolder(e.target.value)} aria-describedby="as-folder-help" />
              <button type="submit" className="vbtn" disabled={busy}>Add</button>
            </span>
            <span className="s" id="as-folder-help">{a.access.hosted ? 'The full path of a folder on the server, outside your helper’s own data folder.' : 'The full path of a folder on this computer, like your Documents.'}</span>
            <Note said={fnote} />
          </form>
        )}
      </div>
    </Section>
  );
}

function FolderRow({ f, data }: { f: AssistantSettings['access']['folders'][number]; data: Data }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  return (
    <div className="setrow col asfolder" role="group" aria-label={f.path}>
      <div className="plughead">
        <span className="grow addrmono">{f.path}</span>
        {data.admin && (
          <button type="button" className="vbtn vbtn-quiet" disabled={busy} aria-label={`Remove ${f.path}`}
            onClick={async () => { setBusy(true); const o = await data.remove(f.path); setBusy(false); if (!o.ok) setNote(said(o)); }}>Remove</button>
        )}
      </div>
      {!f.found && <span className="s warnline">This folder isn’t there any more.</span>}
      <Note said={note} />
    </div>
  );
}

// ---------- how I work with you ----------

function Style({ a, data }: { a: AssistantSettings; data: Data }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said>(null);
  const [pending, setPending] = useState<InteractionStyle | null>(null); // shown as chosen while it saves
  const pick = async (id: InteractionStyle) => { if (id === a.style) return; setBusy(true); setNote(null); setPending(id); setNote(said(await data.setStyle(id))); setBusy(false); setPending(null); };
  const cur = styleOf(a.style);
  return (
    <Section id="as-style" title="How I work with you">
      <div className="card setcard">
        {data.admin ? (
          <fieldset className="aschoices" disabled={busy}>
            <legend className="rowtitle">Style</legend>
            {STYLES.map((s) => (
              <label key={s.id} className="aschoice">
                <input type="radio" name="as-style" value={s.id} checked={(pending ?? a.style) === s.id} onChange={() => void pick(s.id)} aria-describedby={`style-${s.id}`} />
                <span className="grow"><span className="rowtitle">{s.label}</span><span className="s" id={`style-${s.id}`}>{s.detail}</span></span>
              </label>
            ))}
          </fieldset>
        ) : (
          <div className="setrow col"><span className="rowtitle">Style: {cur.label}</span><span className="s">{cur.detail}</span></div>
        )}
        <p className="soft">Separate from what it can touch. This only changes how I talk and how much I suggest.</p>
        <Note said={note} />
      </div>
    </Section>
  );
}
