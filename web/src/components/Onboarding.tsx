import { useState } from 'react';
import { motion } from 'framer-motion';
import { saveKey, getStatus, getConnections, saveAccess, saveBackend, getModels, warmModels, enableConnector, disableConnector, type ExternalInstall, type AccessPreset, type ConnectorItem } from '../api';

// Headline always-on capabilities shown in the feature walkthrough (informational; managed by
// the agent itself). The toggleable connectors come live from /api/connections below.
const CAPABILITIES: { name: string; detail: string }[] = [
  { name: 'Long-term memory', detail: 'Remembers facts, decisions, and context across every session.' },
  { name: 'Reads files & PDFs', detail: 'Point it at a document and it reads the real contents.' },
  { name: 'Schedules tasks', detail: 'Ask it to do something later, daily, or on a repeat.' },
  { name: 'Connect email & chat', detail: 'Gmail/Outlook and Telegram from the Connections page.' },
];

const ACCESS_PRESETS: { id: AccessPreset; label: string; sub: string; detail: string }[] = [
  { id: 'locked-down', label: 'Locked-down', sub: 'Most private', detail: 'Only its own workspace. Can’t run commands. Safest for sensitive machines.' },
  { id: 'assistant', label: 'Assistant', sub: 'Recommended', detail: 'Its workspace plus folders you grant. Runs commands only while you’re watching.' },
  { id: 'developer', label: 'Developer', sub: 'Full power', detail: 'Broad file access and can run commands freely. For coding on your own machine.' },
];

// Guided onboarding: pick the AI "brain" — including a no-key LOCAL option (Ollama).
// Keys stay on this machine; the choice is written to mwa.config.json (models.fetch).
interface Provider { id: string; label: string; sub: string; needsKey: boolean; keyHint?: string; model: string; url?: string; needsBase?: boolean; }
const PROVIDERS: Provider[] = [
  { id: 'anthropic', label: 'Claude', sub: 'Anthropic', needsKey: true, keyHint: 'sk-ant-…', model: 'claude-haiku-4-5-20251001', url: 'https://console.anthropic.com' },
  { id: 'openai', label: 'OpenAI', sub: 'GPT', needsKey: true, keyHint: 'sk-…', model: 'gpt-4o-mini', url: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', label: 'OpenRouter', sub: '300+ models', needsKey: true, keyHint: 'sk-or-…', model: 'meta-llama/llama-3.1-8b-instruct', url: 'https://openrouter.ai/keys' },
  { id: 'gemini', label: 'Gemini', sub: 'Google', needsKey: true, keyHint: 'AIza…', model: 'gemini-2.0-flash', url: 'https://aistudio.google.com/apikey' },
  { id: 'ollama', label: 'Local', sub: 'Ollama · no key', needsKey: false, model: 'llama3.1', url: 'https://ollama.com' },
  { id: 'azure', label: 'Azure', sub: 'OpenAI', needsKey: true, keyHint: 'api key', model: 'gpt-5-4-mini', url: '', needsBase: true },
];

export function Onboarding({ onReady }: { onReady: () => void }) {
  const [sel, setSel] = useState<Provider | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ext, setExt] = useState<ExternalInstall | null>(null);
  const [accessStep, setAccessStep] = useState(false);
  const [preset, setPreset] = useState<AccessPreset>('assistant');
  const [models, setModels] = useState<{ id: string; name?: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [featuresStep, setFeaturesStep] = useState(false);
  const [conns, setConns] = useState<ConnectorItem[]>([]);
  const [toggling, setToggling] = useState<string | null>(null);
  // Advanced setup (optional): point memory at a database server instead of this computer.
  const [advanced, setAdvanced] = useState(false);
  const [dbUrl, setDbUrl] = useState('');
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMsg, setDbMsg] = useState('');
  const [dbOk, setDbOk] = useState(false);

  async function connectDb() {
    setDbBusy(true); setDbMsg('Connecting to your database…'); setDbOk(false);
    const r = await saveBackend('postgres', dbUrl.trim());
    setDbBusy(false); setDbMsg(r.message ?? (r.ok ? 'Connected.' : 'Could not connect.')); setDbOk(!!r.ok);
  }

  function pick(p: Provider) { setSel(p); setModel(p.model); setKey(''); setBaseUrl(''); setMsg(''); setOk(false); setExt(null); setModels([]); }

  async function loadModels() {
    if (!sel) return;
    setLoadingModels(true);
    const m = await getModels(sel.id, key.trim() || undefined, baseUrl.trim() || undefined);
    setModels(m);
    setLoadingModels(false);
    if (m.length && !m.some((x) => x.id === model)) setModel(m[0].id);
  }

  async function connect() {
    if (!sel) return;
    setBusy(true); setMsg('checking that it works…'); setOk(false); setExt(null);
    const r = await saveKey({ which: 'provider', provider: sel.id, model: model.trim() || sel.model, key: key.trim(), baseUrl: baseUrl.trim() });
    setBusy(false); setMsg(r.message); setOk(r.ok);
    if (r.ok) {
      const s = await getStatus();
      if (s.ready) {
        // Connected → choose the access level before entering. Also note whether this model
        // is strong enough to vet + install new connectors (shown in the access step).
        const c = await getConnections().catch(() => null);
        if (c?.externalInstall && !c.externalInstall.enabled) setExt(c.externalInstall);
        setAccessStep(true);
      }
    }
  }

  async function gotoFeatures() {
    setBusy(true);
    await saveAccess(preset).catch(() => {}); // lock in the access choice before the tour
    const c = await getConnections().catch(() => null);
    setConns(c?.connectors ?? []);
    setBusy(false);
    setFeaturesStep(true);
  }

  async function toggleConn(item: ConnectorItem) {
    setToggling(item.id);
    if (item.on) await disableConnector(item.id).catch(() => {});
    else await enableConnector(item.id).catch(() => {});
    const c = await getConnections().catch(() => null);
    setConns(c?.connectors ?? []);
    setToggling(null);
  }

  async function start() {
    setBusy(true);
    // First-run: download the local memory models now (one-time) so the first chat doesn't hang.
    setMsg('Preparing your memory — downloading local models (one-time; this can take a few minutes)…');
    await warmModels().catch(() => {});
    onReady();
  }

  const field = 'w-full rounded-[3px] border border-line bg-bone px-4 py-3 text-[15px] outline-none focus:border-signal transition-colors';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="py-10 max-w-xl">
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">setup{featuresStep ? ' · features' : accessStep ? ' · access' : ''}</div>
      {!accessStep && (<>
      <h1 className="text-4xl font-semibold tracking-tight leading-[1.05] mb-2">Pick a brain to think with.</h1>
      <p className="text-dim mb-6">Choose any AI provider — or run a model <b>locally with no key</b>. Whatever you enter stays on this computer.</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => pick(p)}
            className={`rounded-[4px] border px-3 py-3 text-left transition-colors ${sel?.id === p.id ? 'border-signal bg-surface' : 'border-line bg-surface hover:border-signal/60'}`}
          >
            <div className="font-medium">{p.label}</div>
            <div className="mono text-[11px] text-dim">{p.sub}</div>
          </button>
        ))}
      </div>

      {sel && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-[4px] border border-line bg-surface p-5 space-y-3">
          {sel.id === 'ollama' ? (
            <p className="text-dim text-sm">
              No key needed — just have <a href="https://ollama.com" target="_blank" rel="noreferrer" className="text-signal underline">Ollama</a> running on your computer (e.g. <span className="mono">ollama run llama3.1</span>).
            </p>
          ) : (
            <p className="text-dim text-sm">
              {sel.url && <>Get a key at <a href={sel.url} target="_blank" rel="noreferrer" className="text-signal underline">{new URL(sel.url).host}</a>. </>}
              It's stored only on this machine.
            </p>
          )}
          {sel.needsBase && <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL (https://….openai/v1)" className={field} />}
          {sel.needsKey && <input value={key} onChange={(e) => setKey(e.target.value)} placeholder={`Key (${sel.keyHint})`} className={field} />}
          {sel.id === 'ollama' && <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Ollama URL (default http://localhost:11434/v1)" className={field} />}
          <div className="flex items-center gap-2">
            <input list="model-opts" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" className={`${field} flex-1 mono text-[13px]`} />
            <button type="button" disabled={loadingModels || (sel.needsKey && sel.id !== 'openrouter' && !key.trim())} onClick={loadModels}
              className="rounded-[3px] border border-line px-3 py-3 text-sm text-dim hover:border-signal whitespace-nowrap disabled:opacity-50">
              {loadingModels ? '…' : 'Load models'}
            </button>
          </div>
          <datalist id="model-opts">{models.map((m) => <option key={m.id} value={m.id}>{m.name && m.name !== m.id ? `${m.id} — ${m.name}` : m.id}</option>)}</datalist>
          {models.length > 0 && <p className="mono text-[11px] text-dim">{models.length} models available — pick from the list or type one.</p>}
          {sel.id === 'azure' && <p className="mono text-[11px] text-dim">Azure uses your deployment name as the model.</p>}
          <button disabled={busy || (sel.needsKey && !key.trim())} onClick={connect} className="w-full rounded-[3px] bg-signal text-white px-5 py-3 font-medium disabled:opacity-50">
            {busy ? '…' : 'Connect'}
          </button>
          {msg && <p className={`mono text-[13px] ${ok ? 'text-signal' : 'text-dim'}`}>{msg}</p>}
        </motion.div>
      )}
      </>)}

      {accessStep && !featuresStep && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-4xl font-semibold tracking-tight leading-[1.05] mb-2">How much can it touch?</h1>
          <p className="text-dim mb-5">You’re connected ✓ — pick how much of this computer the assistant may use. You can change this anytime in Connections.</p>
          <div className="space-y-2 mb-4">
            {ACCESS_PRESETS.map((a) => (
              <button key={a.id} onClick={() => setPreset(a.id)}
                className={`w-full text-left rounded-[4px] border px-4 py-3 transition-colors ${preset === a.id ? 'border-signal bg-surface' : 'border-line bg-surface hover:border-signal/60'}`}>
                <div className="font-medium">{a.label} <span className="mono text-[11px] text-dim">{a.sub}</span></div>
                <div className="text-dim text-sm">{a.detail}</div>
              </button>
            ))}
          </div>
          {ext && !ext.enabled && (
            <p className="text-dim text-[13px] mb-4">
              Note: this model isn’t strong enough for MWA to safely vet and install new connectors from the web, so that stays off. The built-in connector library still works; add a stronger model later (an <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-signal underline">OpenRouter</a> or Anthropic/OpenAI key) to enable it.
            </p>
          )}

          {/* Advanced setup (optional). Quick setup keeps everything local with sensible defaults
              (memory on this computer). Advanced lets you point memory at a database server. */}
          <div className="rounded-[4px] border border-line bg-surface mb-4">
            <button onClick={() => setAdvanced((a) => !a)} className="w-full flex items-center justify-between px-4 py-3 text-left">
              <div>
                <div className="font-medium">Advanced setup <span className="mono text-[11px] text-dim">optional</span></div>
                <div className="text-dim text-sm">Quick setup keeps memory on this computer. Open this to use a database server instead.</div>
              </div>
              <span className="mono text-dim text-sm">{advanced ? '–' : '+'}</span>
            </button>
            {advanced && (
              <div className="border-t border-line px-4 py-4 space-y-3">
                <div className="mono text-[11px] text-dim uppercase tracking-[0.2em]">where memory lives</div>
                <p className="text-dim text-sm"><b>This computer</b> (the default) is private and needs no setup. Choose a <b>database server</b> for an always-on, cloud, or multi-device install.</p>
                <div className="rounded-[4px] border border-line px-4 py-3">
                  <div className="font-medium">Database server <span className="mono text-[11px] text-dim">Postgres + pgvector</span></div>
                  <div className="text-dim text-sm mb-2">Paste a connection URL — or <a className="text-signal underline" href="https://railway.com/new/template/postgres" target="_blank" rel="noreferrer">spin one up on Railway</a> and copy its DATABASE_URL.</div>
                  <input value={dbUrl} placeholder="postgres://user:pass@host:5432/db" onChange={(e) => setDbUrl(e.target.value)}
                    className="w-full rounded-[3px] border border-line bg-bone px-3 py-2 text-[12px] mono outline-none focus:border-signal" />
                  <button disabled={dbBusy || !dbUrl.trim()} onClick={connectDb}
                    className="mt-2 rounded-[3px] bg-signal text-white px-4 py-2 text-sm font-medium disabled:opacity-50">{dbBusy ? 'Connecting…' : 'Connect & use'}</button>
                  {dbMsg && <p className={`mono text-[12px] mt-2 ${dbOk ? 'text-signal' : 'text-dim'}`}>{dbMsg}</p>}
                </div>
                <p className="text-dim text-[12px]">Applies when the app restarts. You can also change this anytime in Connections → Memory storage.</p>
              </div>
            )}
          </div>

          <button disabled={busy} onClick={gotoFeatures} className="rounded-[3px] bg-signal text-white px-6 py-3 font-medium disabled:opacity-50">{busy ? '…' : 'Next →'}</button>
        </motion.div>
      )}

      {featuresStep && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-4xl font-semibold tracking-tight leading-[1.05] mb-2">Here’s what I can do.</h1>
          <p className="text-dim mb-5">A quick tour. Flip on the extras you want — you can change any of this anytime in Connections.</p>
          <div className="space-y-2 mb-4">
            {CAPABILITIES.map((cap) => (
              <div key={cap.name} className="rounded-[4px] border border-line bg-surface px-4 py-3">
                <div className="font-medium">{cap.name}</div>
                <div className="text-dim text-sm">{cap.detail}</div>
              </div>
            ))}
          </div>
          {conns.length > 0 && (
            <>
              <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-2">optional tools</div>
              <div className="space-y-2 mb-4">
                {conns.map((c) => {
                  // Connectors needing a key/folder can't be flipped on from a bare toggle — the
                  // secret-entry form lives in Connections. Show a "set up" hint for those; only
                  // the ready-to-go (keyless) ones get a working On/Off here.
                  const needsSetup = (c.secrets ?? []).some((s) => !s.optional && !s.set);
                  return (
                    <div key={c.id} className="flex items-center justify-between gap-3 rounded-[4px] border border-line bg-surface px-4 py-3">
                      <div><div className="font-medium">{c.name}</div><div className="text-dim text-sm">{c.description}</div></div>
                      {needsSetup
                        ? <span className="mono text-[11px] text-dim whitespace-nowrap">set up in Connections</span>
                        : <button disabled={toggling === c.id} onClick={() => toggleConn(c)}
                            className={`rounded-[3px] px-3 py-2 text-sm font-medium whitespace-nowrap disabled:opacity-50 ${c.on ? 'bg-signal text-white' : 'border border-line text-dim hover:border-signal'}`}>
                            {toggling === c.id ? '…' : c.on ? 'On' : 'Off'}
                          </button>}
                    </div>
                  );
                })}
                <p className="mono text-[11px] text-dim">Tools marked "set up in Connections" need a key or folder — add those after setup.</p>
              </div>
            </>
          )}
          <button disabled={busy} onClick={start} className="rounded-[3px] bg-signal text-white px-6 py-3 font-medium disabled:opacity-50">{busy ? 'Preparing…' : 'Start'}</button>
          {busy && msg && <p className="mono text-[13px] text-dim mt-3">{msg}</p>}
        </motion.div>
      )}
    </motion.div>
  );
}
