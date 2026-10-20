// Model bake-off driver (Robert, 2026-10-19: "a best of seven and then two or three rounds dropping two each time").
// For each model: a fresh MWA container on that model, the safety harnesses against it (planted instructions,
// scheduled delivery), then the judgement replays (eval/bakeoff/replay.mts) in the same image. OpenRouter calls are
// pinned to the model's US hosts (MWA_OPENROUTER_PROVIDERS, BL-58) and refuse hosts that keep prompts.
//   node eval/bakeoff/run.mjs <round> <models.json> [--trials 3] [--inj 8] [--deliv 6] [--parallel 3] [--image mwa:bl58]
// models.json: [{ "slug": "haiku-5.5", "model": "openrouter:anthropic/claude-haiku-5.5", "providers": "anthropic,google-vertex/us" }, …]
// An Azure entry ({ "model": "azure:gpt-5-4-mini", "azureEnv": "<env file>" }) runs on Azure instead.
// Results: results/bakeoff/<round>/<slug>.json. Keys come from the environment; none is written to a file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openRouterKey } from '../openrouter-key.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const [round, modelsFile] = argv;
const TRIALS = Number(opt('trials', 3)), INJ = Number(opt('inj', 8)), DELIV = Number(opt('deliv', 6)), PAR = Number(opt('parallel', 3));
const IMAGE = opt('image', 'mwa:bl58');
const SCENARIOS = opt('scenarios', 'plan,flight,dentist,dana').split(',');
const OUT = join(ROOT, 'results', 'bakeoff', round);
const STORES = join(ROOT, 'results', 'bakeoff', 'stores');
const CELLS = join(ROOT, 'results', 'assessment-2b');
mkdirSync(OUT, { recursive: true });
const models = JSON.parse(readFileSync(modelsFile, 'utf8'));
const OR_KEY = openRouterKey();
const win = (p) => p.replace(/\//g, '\\'); // docker on Windows wants native paths for -v

const docker = (args, opts = {}) => run('docker', args, { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts });
const envArgs = (m) => {
  const e = ['-e', 'TZ=America/New_York', '-e', `MWA_MODEL=${m.model}`];
  if (m.model.startsWith('openrouter:')) {
    e.push('-e', `OPENROUTER_API_KEY=${OR_KEY}`);
    if (m.providers) e.push('-e', `MWA_OPENROUTER_PROVIDERS=${m.providers}`);
  }
  if (m.azureEnv) e.push('--env-file', win(m.azureEnv));
  return e;
};
const count = (text, label) => { const x = new RegExp(`${label}[^:]*:\\s*(\\d+)\\/(\\d+)`).exec(text); return x ? { n: Number(x[1]), of: Number(x[2]) } : null; };

async function oneModel(m, port) {
  const name = `bo-${m.slug.replace(/[^a-z0-9-]/gi, '-')}`;
  const res = { slug: m.slug, model: m.model, providers: m.providers ?? null, round, startedAt: new Date().toISOString(), replays: [] };
  const pw = randomBytes(12).toString('hex');
  await docker(['rm', '-f', name]).catch(() => {});
  await docker(['volume', 'rm', '-f', name]).catch(() => {});
  try {
    await docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:7788`, '-v', `${name}:/data`, '-e', `MWA_ACCESS_PASSWORD=${pw}`,
      '-e', 'MWA_CONFIG_PATH=/data/mwa.config.json', '-e', 'MWA_ENV_PATH=/data/.env', ...envArgs(m), IMAGE]);
    for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status < 500) break; } catch { /* */ } await new Promise((s) => setTimeout(s, 2000)); }
    const harness = async (script, n) => {
      try {
        const { stdout } = await run('node', [join(ROOT, 'scripts', script), String(n)], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 45 * 60_000,
          env: { ...process.env, MWA_BASE: `http://127.0.0.1:${port}`, MWA_CONTAINER: name, MWA_E2E_PASSWORD: pw } });
        return stdout;
      } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? e.message); }
    };
    if (INJ > 0) { const t = await harness('e2e-injection.mjs', INJ); res.injection = { complied: count(t, 'COMPLIED'), echoed: count(t, 'ECHOED'), answered: count(t, 'ANSWERED'), log: t.slice(-4000) }; }
    if (DELIV > 0) { const t = await harness('e2e-scheduled.mjs', DELIV); res.delivery = { delivered: count(t, 'DELIVERED'), log: t.slice(-3000) }; }
    try {
      const { stdout } = await docker(['exec', name, 'sh', '-c', 'cat /data/runs.jsonl 2>/dev/null || true']);
      const runs = stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      res.harnessRuns = runs.length;
      res.harnessCostUsd = runs.reduce((s, r) => s + Number(r.costUsd ?? 0), 0);
      res.harnessFailures = runs.filter((r) => r.reason === 'error').map((r) => String(r.summary).slice(0, 160));
    } catch { /* */ }
  } finally {
    await docker(['rm', '-f', name]).catch(() => {});
    await docker(['volume', 'rm', '-f', name]).catch(() => {});
  }
  for (const sc of SCENARIOS) {
    try {
      const { stdout } = await docker(['run', '--rm', ...envArgs(m), '-e', 'MWA_CONFIG_PATH=/tmp/none.json', '-e', 'MWA_ENV_PATH=/tmp/none.env', '-e', 'MWA_FAST_CHAT=0',
        '-v', `${win(HERE)}:/b:ro`, '-v', `${win(STORES)}:/stores:ro`, '-v', `${win(CELLS)}:/r:ro`, '--entrypoint', 'sh', IMAGE,
        '-c', `cd /app && cp /b/replay.mts rp.mts && node --import tsx rp.mts ${sc} ${TRIALS}`], { timeout: 60 * 60_000 });
      for (const l of stdout.split('\n')) { if (l.startsWith('{"scenario"')) { try { res.replays.push(JSON.parse(l)); } catch { /* */ } } }
    } catch (e) { res.replays.push({ scenario: sc, error: String(e.stderr ?? e.message).slice(-500) }); }
  }
  res.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, `${m.slug}.json`), JSON.stringify(res, null, 1));
  console.log(`${m.slug}: injection ${JSON.stringify(res.injection?.complied)}/${JSON.stringify(res.injection?.echoed)} delivery ${JSON.stringify(res.delivery?.delivered)} replays ${res.replays.length}`);
}

if (!OR_KEY && models.some((m) => m.model.startsWith('openrouter:'))) { console.error('no OpenRouter key (USEA_OPENROUTER_API_KEY)'); process.exit(2); }
if (!existsSync(STORES)) { console.error(`missing ${STORES}`); process.exit(2); }
const queue = models.map((m, i) => ({ m, port: 7900 + i }));
await Promise.all(Array.from({ length: Math.min(PAR, queue.length) }, async () => { while (queue.length) { const { m, port } = queue.shift(); await oneModel(m, port).catch((e) => console.error(`${m.slug}: ${e.message}`)); } }));
console.log('round done');
