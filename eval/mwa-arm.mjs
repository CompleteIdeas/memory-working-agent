// Arms A (`mwa`) and B (`mwa-nomem`) of the promise assessment: a fresh MWA container per persona
// and arm, its own volume and port, the world as three MCP servers (gmail, calendar, web), the clock
// shim, and a 4-second scheduler tick. The person talks to it over its web API.
import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const sh = (args, timeout = 60_000) => new Promise((res) => {
  execFile('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout), err: String(stderr || err?.message || '') }));
});
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function makeMwaArm({ world, worldName, arm, port, envFile, evalDir, outDir, image = 'mwa:dev' }) {
  const name = `mwa-eval-${worldName}-${arm}`;
  const pw = randomBytes(12).toString('hex');
  const base = `http://127.0.0.1:${port}`;
  const tz = world.tz;
  const mcp = (mode) => ({ command: 'node', args: ['/app/eval/world-server.mjs', mode], env: { WORLD_FILE: `/app/eval/worlds/${worldName}.json`, WORLD_LOG: '/data/world-log.jsonl', MWA_EVAL_CLOCK_FILE: '/data/eval-clock.json', TZ: tz } });
  const config = { models: { fetch: 'azure:gpt-5-4-mini', reason: 'azure:gpt-5-4-mini' }, tools: { mcpServers: { gmail: mcp('gmail'), calendar: mcp('calendar'), web: mcp('web') } } };
  mkdirSync(outDir, { recursive: true });
  const cfgFile = join(outDir, 'mwa.config.json');
  writeFileSync(cfgFile, JSON.stringify(config, null, 2));
  let cookie = '';

  async function setClock(offsetMs) {
    const r = await sh(['exec', name, 'sh', '-c', `printf '%s' '{"offsetMs":${Math.round(offsetMs)}}' > /data/eval-clock.json`]);
    if (!r.ok) throw new Error(`setClock: ${r.err}`);
  }
  async function login() {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (!r.ok) throw new Error(`login ${r.status}`);
    cookie = (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  }
  async function readLines(file) {
    const r = await sh(['exec', name, 'sh', '-c', `cat ${file} 2>/dev/null || true`], 60_000);
    return r.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  return {
    name: arm,
    async start(initialOffsetMs) {
      await sh(['rm', '-f', name]);
      await sh(['volume', 'rm', '-f', name]);
      const create = await sh(['create', '--name', name, '-p', `127.0.0.1:${port}:7788`, '-v', `${name}:/data`, '-v', `${resolve(evalDir)}:/app/eval:ro`,
        '-e', `MWA_ACCESS_PASSWORD=${pw}`, '-e', 'MWA_CONFIG_PATH=/data/mwa.config.json', '-e', 'MWA_ENV_PATH=/data/.env', '-e', `TZ=${tz}`,
        '-e', 'NODE_OPTIONS=--import=/app/eval/clock-shim.mjs', '-e', 'MWA_EVAL_CLOCK_FILE=/data/eval-clock.json',
        '-e', 'MWA_SCHEDULER_TICK_MS=4000', '-e', 'MWA_INBOX=0', ...(arm === 'mwa-nomem' ? ['-e', 'MWA_MEMORY=off'] : []), image]);
      if (!create.ok) throw new Error(`docker create: ${create.err}`);
      const clockFile = join(outDir, 'eval-clock.json');
      writeFileSync(clockFile, JSON.stringify({ offsetMs: Math.round(initialOffsetMs) }));
      for (const [src, dst] of [[cfgFile, '/data/mwa.config.json'], [envFile, '/data/.env'], [clockFile, '/data/eval-clock.json']]) {
        const c = await sh(['cp', src, `${name}:${dst}`]);
        if (!c.ok) throw new Error(`docker cp ${src}: ${c.err}`);
      }
      const st = await sh(['start', name]);
      if (!st.ok) throw new Error(`docker start: ${st.err}`);
      for (let i = 0; i < 90; i++) {
        await realSleep(2000);
        try { await login(); return; } catch { /* not up yet */ }
      }
      throw new Error('container did not come up');
    },
    setClock,
    async chat(session, message) {
      const url = `${base}/api/chat?message=${encodeURIComponent(message)}&session=${encodeURIComponent(session)}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await fetch(url, { headers: { cookie, accept: 'text/event-stream' }, signal: AbortSignal.timeout(15 * 60_000) });
        if (r.status === 401) { await login(); continue; }
        const out = { reply: '', asked: false, tools: [], costUsd: 0, events: [] };
        let buf = ''; const dec = new TextDecoder();
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const type = /^event: (.*)$/m.exec(frame)?.[1];
            if (!type) continue;
            let d = {}; try { d = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? '{}'); } catch { /* */ }
            out.events.push(type);
            if (type === 'tool' && d.name) out.tools.push(d.name);
            if (type === 'ask') out.asked = true;
            if (type === 'result') { out.reply = String(d.summary ?? ''); out.costUsd = Number(d.costUsd ?? 0); }
            if (type === 'error') out.reply = `(error) ${JSON.stringify(d).slice(0, 200)}`;
            if (type === 'result' || type === 'error') return out;
          }
        }
        return out;
      }
      throw new Error('chat: not logged in');
    },
    async dueJobs() {
      const r = await fetch(`${base}/api/schedule`, { headers: { cookie } });
      if (r.status === 401) { await login(); return this.dueJobs(); }
      return ((await r.json()).scheduled ?? []).map((t) => ({ due: Number(t.due), instruction: t.instruction }));
    },
    /** Wait until `k` fires recorded at or after virtual time `sinceVt` (one receipt per fire, delivered or not). */
    async waitFires(k, sinceVt, timeoutMs = 10 * 60_000) {
      const t0 = performance.now();
      while (performance.now() - t0 < timeoutMs) {
        const done = (await readLines('/data/deliveries-serve.jsonl')).filter((x) => Number(x.ts) >= sinceVt).length;
        if (done >= k) return done;
        await realSleep(2500);
      }
      return -1;
    },
    async deliveries() { return readLines('/data/notifications.jsonl'); },
    async consolidate() {
      const code = "import('/app/src/awm.ts').then(async (m) => { const mem = new m.MwaMemory(process.env.MWA_AGENT_ID ?? 'mwa-serve', process.env.MWA_DB ?? '/data/agent.db'); const r = await mem.consolidate(); console.log(JSON.stringify(r)); mem.close(); process.exit(0); })";
      const r = await sh(['exec', '-w', '/app', name, 'node', '--import', 'tsx', '-e', code], 10 * 60_000);
      return r.ok ? r.out.trim().split('\n').pop() : `consolidate failed: ${r.err.slice(0, 200)}`;
    },
    async collect() {
      for (const f of ['runs.jsonl', 'notifications.jsonl', 'world-log.jsonl', 'deliveries-serve.jsonl', 'mwa.log']) await sh(['cp', `${name}:/data/${f}`, join(outDir, f)]);
    },
    async stop() { await sh(['stop', name], 90_000); },
  };
}
