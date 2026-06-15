/**
 * First-run setup wizard — a LOCALHOST browser onboarding flow. Collects the keys
 * the agent needs through a guided, chat-style page, validates each with a live
 * test call, and writes them to a local `.env`. Because it's served on 127.0.0.1,
 * secrets the user types go ONLY to this local process — never to any server —
 * then to a plain `.env` on disk (or a mounted volume in Docker). The agent reads
 * them locally; keys only ever leave the box as calls to the provider the user chose.
 *
 * `mwa wizard` (and the Docker installer runs it first when unconfigured).
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { OPENAI_COMPAT } from './provider.js';
import { loadConfig } from './config.js';

const ENV_PATH = process.env.MWA_ENV_PATH ?? resolve('.env');

/** Upsert KEY=value lines in the .env (preserves other lines). Local file only. */
export function upsertEnv(kv: Record<string, string>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && kv[m[1]] !== undefined) { seen.add(m[1]); return `${m[1]}=${kv[m[1]]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(kv)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, out.filter((l, i) => !(l === '' && i === out.length - 1)).join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}

function envHas(key: string): boolean {
  if (process.env[key]) return true;
  if (!existsSync(ENV_PATH)) return false;
  return new RegExp(`^${key}=.+`, 'm').test(readFileSync(ENV_PATH, 'utf8'));
}

// --- live validators (a key is only saved if it actually works) ---
export async function testAnthropic(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const c = new Anthropic({ apiKey: key, maxRetries: 0 });
    await c.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] });
    return { ok: true, message: 'Anthropic key works ✓' };
  } catch (e) { return { ok: false, message: `Anthropic key failed: ${(e as Error).message.slice(0, 120)}` }; }
}
export async function testAzure(base: string, key: string, deployment: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: deployment, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 4 }),
    });
    return res.ok ? { ok: true, message: `Azure ${deployment} works ✓` } : { ok: false, message: `Azure failed: ${res.status} ${(await res.text()).slice(0, 100)}` };
  } catch (e) { return { ok: false, message: `Azure failed: ${(e as Error).message.slice(0, 120)}` }; }
}
export async function testTelegram(token: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r: any = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
    return r.ok ? { ok: true, message: `Bot @${r.result.username} works ✓` } : { ok: false, message: `Telegram failed: ${r.description}` };
  } catch (e) { return { ok: false, message: `Telegram failed: ${(e as Error).message.slice(0, 120)}` }; }
}

/** Which .env var holds the key for a provider (null = keyless, e.g. Ollama). */
export function envKeyForProvider(provider: string): string | null {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'azure') return 'AZURE_GPT_API_KEY';
  return OPENAI_COMPAT[provider]?.keyEnv ?? null;
}

async function testOpenAICompat(base: string, key: string | undefined, model: string): Promise<{ ok: boolean; message: string }> {
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }) });
    if (res.ok) return { ok: true, message: `${model} works ✓` };
    return { ok: false, message: `failed: ${res.status} ${(await res.text()).slice(0, 120)}` };
  } catch (e) { return { ok: false, message: `couldn't reach it: ${(e as Error).message.slice(0, 120)}` }; }
}

/** Validate any provider before saving — anthropic/azure/openai/openrouter/gemini/ollama. */
export async function testProvider(provider: string, model: string, key?: string, baseUrl?: string): Promise<{ ok: boolean; message: string }> {
  if (provider === 'anthropic') return testAnthropic(key ?? '');
  if (provider === 'azure') return testAzure(baseUrl ?? '', key ?? '', model || 'gpt-5-4-mini');
  const oc = OPENAI_COMPAT[provider];
  if (!oc) return { ok: false, message: `unknown provider "${provider}"` };
  if (!oc.keyless && !key) return { ok: false, message: 'a key is required for this provider' };
  const base = baseUrl || (oc.baseEnv && process.env[oc.baseEnv]) || oc.base;
  return testOpenAICompat(base, oc.keyless ? undefined : key, model);
}

export function status() {
  const anthropic = envHas('ANTHROPIC_API_KEY');
  const azure = envHas('AZURE_GPT_API_KEY') && envHas('AZURE_GPT_BASE_URL');
  const telegram = envHas('TELEGRAM_BOT_TOKEN');
  // ready = whatever brain is configured (models.fetch) has what it needs — so connecting
  // ONLY OpenAI / Ollama / etc. completes onboarding, not just Anthropic/Azure.
  let ready = anthropic || azure;
  try {
    const spec = loadConfig().models.fetch;
    const provider = spec.includes(':') ? spec.split(':')[0].toLowerCase() : (/claude/i.test(spec) ? 'anthropic' : /^gpt-/i.test(spec) ? 'azure' : '');
    if (provider === 'ollama') ready = true;
    else if (provider === 'anthropic') ready = anthropic;
    else if (provider === 'azure') ready = azure;
    else { const k = OPENAI_COMPAT[provider]?.keyEnv; if (k) ready = envHas(k); }
  } catch { /* keep the anthropic||azure default */ }
  return { anthropic, azure, telegram, ready };
}

const PAGE = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
<title>MWA setup</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;background:#0f1115;color:#e6e6e6}
h1{font-size:1.4rem}.card{background:#1a1d24;border:1px solid #2a2f3a;border-radius:10px;padding:1rem;margin:1rem 0}
.ok{color:#5fd38d}.bad{color:#ff6b6b}.muted{color:#8a93a3;font-size:.9rem}
input{width:100%;box-sizing:border-box;padding:.6rem;margin:.4rem 0;background:#0f1115;border:1px solid #2a2f3a;border-radius:6px;color:#e6e6e6}
button{background:#3b82f6;color:#fff;border:0;padding:.55rem 1rem;border-radius:6px;cursor:pointer;font-size:1rem}
a{color:#7aa2f7}.step{font-weight:600;margin-top:1rem}.msg{margin:.4rem 0}
</style></head><body>
<h1>🧠 Set up your Memory Working Agent</h1>
<p class=muted>Everything below stays on <b>this machine</b> — keys go to a local <code>.env</code>, never to any server.</p>
<div id=status class=card>checking…</div>

<div class=card><div class=step>1. A model provider (need at least one)</div>
<p class=muted>Anthropic Claude (recommended). Get a key at <a href="https://console.anthropic.com" target=_blank>console.anthropic.com</a>.</p>
<input id=anthropic placeholder="ANTHROPIC_API_KEY (sk-ant-...)"><button onclick="save('anthropic')">Save & test</button>
<div class=msg id=m_anthropic></div>
<details><summary class=muted>…or Azure OpenAI (gpt-5-4-mini)</summary>
<input id=az_base placeholder="AZURE_GPT_BASE_URL (https://….openai/v1)">
<input id=az_key placeholder="AZURE_GPT_API_KEY">
<input id=az_dep placeholder="AZURE_GPT_DEPLOYMENT (gpt-5-4-mini)">
<button onclick="save('azure')">Save & test</button><div class=msg id=m_azure></div></details></div>

<div class=card><div class=step>2. Reach it from your phone (optional)</div>
<p class=muted>Create a bot with <a href="https://t.me/botfather" target=_blank>@BotFather</a>, paste the token, then message your bot to get your chat id.</p>
<input id=tg placeholder="TELEGRAM_BOT_TOKEN"><button onclick="save('telegram')">Save & test</button><div class=msg id=m_telegram></div></div>

<div class=card><div class=step>Done?</div><p class=muted>When a provider shows ✓, your agent is ready: run <code>mwa watch</code> or <code>mwa connect telegram</code>.</p></div>

<script>
async function refresh(){const s=await (await fetch('/api/status')).json();
document.getElementById('status').innerHTML='Status: '+
['anthropic','azure','telegram'].map(k=>k+': '+(s[k]?'<span class=ok>✓</span>':'<span class=bad>✗</span>')).join(' &nbsp; ')+
'<br>'+(s.ready?'<span class=ok><b>Ready — you can run the agent.</b></span>':'<span class=bad>Add a model provider key to continue.</span>');}
async function save(which){
 let body={which};
 if(which==='anthropic')body.ANTHROPIC_API_KEY=anthropic.value.trim();
 if(which==='azure'){body.AZURE_GPT_BASE_URL=az_base.value.trim();body.AZURE_GPT_API_KEY=az_key.value.trim();body.AZURE_GPT_DEPLOYMENT=(az_dep.value.trim()||'gpt-5-4-mini');}
 if(which==='telegram')body.TELEGRAM_BOT_TOKEN=tg.value.trim();
 const el=document.getElementById('m_'+which);el.textContent='testing…';
 const r=await (await fetch('/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
 el.innerHTML='<span class="'+(r.ok?'ok':'bad')+'">'+r.message+'</span>';refresh();}
refresh();
</script></body></html>`;

export async function runWizard(port = Number(process.env.MWA_WIZARD_PORT ?? 7788)): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
      if (req.method === 'GET' && req.url === '/api/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status())); return; }
      if (req.method === 'POST' && req.url === '/api/save') {
        let raw = ''; for await (const c of req) raw += c;
        const b = JSON.parse(raw || '{}');
        let result: { ok: boolean; message: string };
        if (b.which === 'anthropic') { result = await testAnthropic(b.ANTHROPIC_API_KEY); if (result.ok) upsertEnv({ ANTHROPIC_API_KEY: b.ANTHROPIC_API_KEY }); }
        else if (b.which === 'azure') { result = await testAzure(b.AZURE_GPT_BASE_URL, b.AZURE_GPT_API_KEY, b.AZURE_GPT_DEPLOYMENT); if (result.ok) upsertEnv({ AZURE_GPT_BASE_URL: b.AZURE_GPT_BASE_URL, AZURE_GPT_API_KEY: b.AZURE_GPT_API_KEY, AZURE_GPT_DEPLOYMENT: b.AZURE_GPT_DEPLOYMENT }); }
        else if (b.which === 'telegram') { result = await testTelegram(b.TELEGRAM_BOT_TOKEN); if (result.ok) upsertEnv({ TELEGRAM_BOT_TOKEN: b.TELEGRAM_BOT_TOKEN }); }
        else result = { ok: false, message: 'unknown field' };
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return;
      }
      res.statusCode = 404; res.end('not found');
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, message: (e as Error).message.slice(0, 200) })); }
  });
  // Bind localhost by default (secure for direct use). In Docker set MWA_WIZARD_HOST=0.0.0.0
  // and map the port host-localhost-only: -p 127.0.0.1:7788:7788
  const host = process.env.MWA_WIZARD_HOST ?? '127.0.0.1';
  await new Promise<void>((r) => server.listen(port, host, r));
  console.log(`\n🧠 MWA setup wizard → http://localhost:${port}`);
  console.log(`   open it in your browser; keys are saved locally to ${ENV_PATH} (never sent to a server).`);
  console.log(`   Ctrl-C when done; then run: mwa watch  (or  mwa connect telegram)\n`);
}

const _entry = process.argv[1] ?? '';
if (_entry.endsWith('wizard.ts') || _entry.endsWith('wizard.js')) {
  runWizard().catch((e) => { console.error('wizard failed:', e); process.exit(1); });
}
