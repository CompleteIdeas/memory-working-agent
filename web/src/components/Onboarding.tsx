import { useState } from 'react';
import { motion } from 'framer-motion';
import { saveKey, getStatus, getConnections, saveAccess, type ExternalInstall, type AccessPreset } from '../api';

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

  function pick(p: Provider) { setSel(p); setModel(p.model); setKey(''); setBaseUrl(''); setMsg(''); setOk(false); setExt(null); }

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

  async function start() {
    setBusy(true);
    await saveAccess(preset).catch(() => {});
    onReady();
  }

  const field = 'w-full rounded-[3px] border border-line bg-bone px-4 py-3 text-[15px] outline-none focus:border-signal transition-colors';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="py-10 max-w-xl">
      <div className="mono text-[11px] text-dim uppercase tracking-[0.2em] mb-3">setup{accessStep ? ' · access' : ''}</div>
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
          <div className="flex items-center gap-3">
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" className={`${field} flex-1 mono text-[13px]`} />
            <button disabled={busy || (sel.needsKey && !key.trim())} onClick={connect} className="rounded-[3px] bg-signal text-white px-5 py-3 font-medium disabled:opacity-50 whitespace-nowrap">
              {busy ? '…' : 'Connect'}
            </button>
          </div>
          {msg && <p className={`mono text-[13px] ${ok ? 'text-signal' : 'text-dim'}`}>{msg}</p>}
        </motion.div>
      )}
      </>)}

      {accessStep && (
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
          <button disabled={busy} onClick={start} className="rounded-[3px] bg-signal text-white px-6 py-3 font-medium disabled:opacity-50">{busy ? '…' : 'Start'}</button>
        </motion.div>
      )}
    </motion.div>
  );
}
