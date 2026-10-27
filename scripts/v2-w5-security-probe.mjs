#!/usr/bin/env node
/**
 * v2 build, slice W5: the security review's live probes (2026-10-26), against REAL `mwa serve` processes with fresh
 * data folders and throwaway passwords. Stops every server it starts, by PID.
 *
 *   node scripts/v2-w5-security-probe.mjs [--out <dir>] [--base-port 7911]
 *
 *   A  password set, bound to 127.0.0.1                 (1) throttle, (2) sign-out, (3) the docx bomb, (4) per-run
 *                                                        limit, (8) pairing link, (9) cookies, names
 *   B  no password, bound to 127.0.0.1 (one computer)    (5) DNS rebinding → 421; this machine still works
 *   C  no password, MWA_RELAYED=1, behind a raw TCP relay (5) Host: localhost / Host: 127.0.0.1 through the relay →
 *                                                        nothing; (6) the legacy /api inventory → 401
 *   D  a broken mwa.config.json                          (9) a clear error, not a first-run trap
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', join(ROOT, 'reports', 'v2-w5-security-probe'));
const P0 = Number(arg('base-port', '7911'));
mkdirSync(OUT, { recursive: true });
const results = []; let failed = 0;
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok, d: ok ? '' : d }); if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${!ok && d ? ` — ${d}` : ''}`); };

function req(method, port, path, headers = {}, body, host = '127.0.0.1') {
  return new Promise((res, rej) => {
    const r = http.request({ host, port, path, method, headers, setHost: !('Host' in headers || 'host' in headers) }, (x) => {
      const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', rej); if (body !== undefined) r.write(body); r.end();
  });
}
const J = { 'content-type': 'application/json' };
let kn = 0; const key = () => `probe-${Date.now()}-${++kn}`;

const servers = [];
async function start(name, port, env) {
  const dir = join(OUT, `data-${name}-${Date.now()}`);
  mkdirSync(join(dir, 'ws'), { recursive: true });
  writeFileSync(join(dir, '.env'), '');
  if (!env.__config) writeFileSync(join(dir, 'mwa.config.json'), JSON.stringify({ workspace: join(dir, 'ws') }));
  else writeFileSync(join(dir, 'mwa.config.json'), env.__config);
  delete env.__config;
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'serve'], {
    cwd: ROOT,
    env: { ...process.env, MWA_NO_OPEN: '1', MWA_MEMORY: 'off', MWA_DATA_DIR: dir, MWA_CONFIG_PATH: join(dir, 'mwa.config.json'), MWA_ENV_PATH: join(dir, '.env'),
      MWA_SERVE_PORT: String(port), PORT: '', MWA_CALENDAR_SYNC: '0', MWA_MAIL_SYNC: '0', MWA_TRIAGE: '0', MWA_ACCESS_PASSWORD: '', MWA_RELAYED: '', MWA_ALLOWED_HOSTS: '', MWA_PUBLIC_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  servers.push({ name, pid: child.pid });
  for (let i = 0; ; i++) {
    try { const r = await req('GET', port, '/api/health'); if (r.status < 500) break; } catch { /* not yet */ }
    if (i > 200) throw new Error(`${name} did not start:\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`  (server ${name} on ${port}, PID ${child.pid})`);
  return { dir, log: () => log };
}
function stopAll() { for (const s of servers) { try { execFileSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } }
process.on('exit', stopAll);

const PW = randomBytes(12).toString('base64url'); // throwaway, never printed
const A = P0, B = P0 + 1, C = P0 + 2, RELAY = P0 + 3, D = P0 + 4;
try {
  await start('A', A, { MWA_ACCESS_PASSWORD: PW });
  await start('B', B, {});
  await start('C', C, { MWA_RELAYED: '1' });
  await start('D', D, { MWA_ACCESS_PASSWORD: PW, __config: '{ not json' });

  // ---------- (1) the sign-in throttle (A) ----------
  console.log('== (1) sign-in throttle');
  const tryPw = (pw, h = {}, path = '/api/v1/session') => req('POST', A, path, { ...J, ...h }, JSON.stringify({ password: pw }));
  const timed = async (f) => { const t = Date.now(); const r = await f(); return { ...r, ms: Date.now() - t }; };
  const rot = [];
  for (let i = 0; i < 7; i++) rot.push(await timed(() => tryPw(`wrong${i}`, { 'X-Forwarded-For': `10.0.0.${i}` })));
  check('(1) rotating X-Forwarded-For: still one source — the waits grow (0,0,0,¼,½,1,2 s)', rot.every((r) => r.status === 401) && rot[6].ms >= 1800 && rot[5].ms >= 900, rot.map((r) => `${r.status}/${r.ms}ms`).join(' '));
  const owner = await timed(() => tryPw(PW, { 'X-Forwarded-For': '100.64.0.7' }));
  check('(1) the owner with the right password after spoofed failures: let in (only delayed)', owner.status === 200 && owner.ms < 31_000, `${owner.status} ${owner.ms}ms`);
  // junk flood in parallel from one source, then the right password
  const flood = await Promise.all(Array.from({ length: 6 }, (_, i) => timed(() => tryPw(`flood${i}`))));
  const after = await timed(() => tryPw(PW));
  check('(1) after a parallel junk flood the right password works (never refused)', after.status === 200 && flood.every((r) => r.status === 401), `${after.status} ${after.ms}ms`);
  const legacy = [];
  for (let i = 0; i < 6; i++) legacy.push(await timed(() => tryPw(`L${i}`, {}, '/api/login')));
  check('(1) legacy /api/login goes through the same throttle (waits grow)', legacy.every((r) => r.status === 401) && legacy[5].ms >= 900, legacy.map((r) => `${r.status}/${r.ms}ms`).join(' '));
  const lok = await tryPw(PW, {}, '/api/login');
  check('(1) /api/login with the right password: a session', lok.status === 200 && /^mwa_session=/.test(String(lok.headers['set-cookie']?.[0] ?? '')));

  // ---------- (2) sign-out ends the session (A) ----------
  console.log('== (2) sessions');
  const s1 = await tryPw(PW);
  const cookie = String(s1.headers['set-cookie']?.[0] ?? '').split(';')[0];
  check('(9) the session cookie has no Secure flag on plain http', !/;\s*Secure/i.test(String(s1.headers['set-cookie']?.[0])));
  check('(2) signed in', (await req('GET', A, '/api/v1/settings', { cookie })).status === 200);
  await req('DELETE', A, '/api/v1/session', { cookie, 'Idempotency-Key': key() });
  check('(2) a copied cookie fails after sign-out (v1)', (await req('GET', A, '/api/v1/settings', { cookie })).status === 401);
  check('(2) and on the legacy API', (await req('GET', A, '/api/memories', { cookie })).status === 401);
  const s2 = String((await tryPw(PW)).headers['set-cookie']?.[0] ?? '').split(';')[0];
  const s3 = String((await tryPw(PW)).headers['set-cookie']?.[0] ?? '').split(';')[0];
  const all = await req('POST', A, '/api/v1/session/sign-out-everywhere', { cookie: s2, 'Idempotency-Key': key() });
  check('(2) sign out everywhere ends every session', all.status === 200 && (await req('GET', A, '/api/v1/settings', { cookie: s3 })).status === 401, all.body);
  const admin = String((await tryPw(PW)).headers['set-cookie']?.[0] ?? '').split(';')[0];
  const AH = { cookie: admin };

  // ---------- (4) the per-run limit (A) ----------
  console.log('== (4) per-run limit');
  const pf = (v) => req('PATCH', A, '/api/v1/spending', { ...J, ...AH, 'Idempotency-Key': key() }, JSON.stringify({ perFireUsd: v }));
  const r0001 = await pf(0.001), r0 = await pf(0);
  check('(4) perFireUsd 0.001 is refused (400 bad_cap)', r0001.status === 400 && /bad_cap/.test(r0001.body), r0001.body);
  check('(4) perFireUsd 0 means the default (25¢), not "no limit"', r0.status === 200 && JSON.parse(r0.body).defaults.perFireUsd === 0.25, r0.body);

  // ---------- (8) the pairing link at localhost ----------
  console.log('== (8) pairing link');
  const pc = JSON.parse((await req('POST', A, '/api/v1/pair/codes', { ...J, ...AH, 'Idempotency-Key': key() }, '{}', '127.0.0.1')).body);
  check('(8) at localhost with no address known: reachable false', pc.reachable === false, JSON.stringify(pc));
  await req('PATCH', A, '/api/v1/settings', { ...J, ...AH, 'Idempotency-Key': key() }, JSON.stringify({ publicUrl: 'mwa.tail1a2b.ts.net' }));
  const pc2 = JSON.parse((await req('POST', A, '/api/v1/pair/codes', { ...J, ...AH, 'Idempotency-Key': key() }, '{}')).body);
  check('(8) with the address saved: the link uses it', pc2.reachable === true && pc2.pairUrl.startsWith('https://mwa.tail1a2b.ts.net/pair#c='), pc2.pairUrl);

  // ---------- (9) names (A) ----------
  const pair = JSON.parse((await req('POST', A, '/api/v1/pair', J, JSON.stringify({ code: pc2.code, name: 'evil‮gnp.exe', cookie: false }))).body);
  const devs = JSON.parse((await req('GET', A, '/api/v1/devices', AH)).body).devices;
  check('(9) bidi controls stripped from a device name', devs.find((d) => d.id === pair.deviceId)?.name === 'evil gnp.exe', JSON.stringify(devs.map((d) => d.name)));
  const B_ = { authorization: `Bearer ${pair.token}` };
  const con = JSON.parse((await req('POST', A, '/api/v1/files?name=CON', { ...B_, 'Idempotency-Key': key(), 'content-type': 'application/octet-stream' }, 'x')).body);
  check('(9) a Windows device name is never a file name', con.name === '_CON', JSON.stringify(con));
  check('(9) non-string settings are 400', (await req('PATCH', A, '/api/v1/settings', { ...J, ...AH, 'Idempotency-Key': key() }, JSON.stringify({ helperName: ['a', 'b'] }))).status === 400);

  // ---------- (3) the docx bomb (A) ----------
  console.log('== (3) upload bomb');
  const JSZip = require('jszip');
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const para = '<w:p><w:r><w:t>' + 'A'.repeat(1000) + '</w:t></w:r></w:p>';
  z.file('word/document.xml', '<w:document><w:body>' + para.repeat(Math.round(150 * 1048576 / para.length)) + '</w:body></w:document>');
  const bomb = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  const pidA = servers.find((s) => s.name === 'A').pid;
  const ws = () => { try { return Math.round(Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pidA}" | ForEach-Object { (Get-Process -Id $_.ProcessId).WorkingSet64 } | Measure-Object -Sum).Sum + (Get-Process -Id ${pidA}).WorkingSet64`]).toString().trim()) / 1048576); } catch { return -1; } };
  const before = ws();
  const t0 = Date.now();
  const up = await req('POST', A, '/api/v1/files?name=bomb.docx', { ...B_, 'Idempotency-Key': key(), 'content-type': 'application/octet-stream' }, bomb);
  const upMs = Date.now() - t0;
  const t1 = Date.now(); const h = await req('GET', A, '/api/health'); const hMs = Date.now() - t1;
  const afterMb = ws();
  // re-review: a .docx over 20 MB unzipped is refused at upload (it would be unreadable anyway)
  check('(3) the bomb (150 MB of XML in a small .docx) is refused in plain words, never fully inflated', up.status === 400 && /unsafe_document/.test(up.body), `${up.status} ${up.body.slice(0, 120)}`);
  check('(3) quickly, and /api/health answers at once', upMs < 5000 && h.status === 200 && hMs < 1000, `upload ${upMs}ms, health ${hMs}ms`);
  check('(3) memory stays small (under 120 MB more)', before < 0 || afterMb - before < 120, `${before} MB → ${afterMb} MB`);
  console.log(`     (working set ${before} MB → ${afterMb} MB, ${(bomb.length / 1024).toFixed(0)} KB file)`);
  // the re-review's bomb: the directory lies (1 GB inside, "1,716 bytes" claimed)
  const zlib = await import('node:zlib');
  const plain = Buffer.concat([Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'), Buffer.alloc(1000 * 1048576, 0x41), Buffer.from('</w:t></w:r></w:p></w:body></w:document>')]);
  const deflated = zlib.deflateRawSync(plain, { level: 9 });
  const entry = (name, data, method, usize, off) => {
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(nm.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(usize, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(off, 42);
    return { local: Buffer.concat([lh, nm, data]), cd: Buffer.concat([cd, nm]) };
  };
  const ct = Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const e1 = entry('[Content_Types].xml', ct, 0, ct.length, 0), e2 = entry('word/document.xml', deflated, 8, 1716, e1.local.length);
  const cdb = Buffer.concat([e1.cd, e2.cd]), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(2, 8); eocd.writeUInt16LE(2, 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(e1.local.length + e2.local.length, 16);
  const forged = Buffer.concat([e1.local, e2.local, cdb, eocd]);
  const b3before = ws(), t3 = Date.now();
  const up3 = await req('POST', A, '/api/v1/files?name=bomb3.docx', { ...B_, 'Idempotency-Key': key(), 'content-type': 'application/octet-stream' }, forged);
  const up3ms = Date.now() - t3, b3after = ws();
  check('(3, re-review) a forged-directory .docx (1 GB inside, "1,716 bytes") is refused in plain words', up3.status === 400 && /unsafe_document/.test(up3.body) && /too big to read here once unzipped/.test(up3.body), `${up3.status} ${up3.body.slice(0, 160)}`);
  check('(3, re-review) quickly, without the memory growing', up3ms < 5000 && (b3before < 0 || b3after - b3before < 120), `${up3ms}ms, ${b3before} MB → ${b3after} MB`);
  console.log(`     (forged ${(forged.length / 1024).toFixed(0)} KB; working set ${b3before} MB → ${b3after} MB; ${up3ms} ms)`);

  // ---------- (5) DNS rebinding (B, no password, one computer) ----------
  console.log('== (5) host allowlist, this machine');
  const R = { Host: `rebind.attacker.example:${B}`, 'Sec-Fetch-Site': 'same-origin', Origin: `http://rebind.attacker.example:${B}` };
  for (const p of ['/api/v1/me', '/api/files', '/api/memory/export', '/', '/api/vault']) {
    const r = await req('GET', B, p, R);
    check(`(5) a rebinding Host on ${p} → 421`, r.status === 421, `${r.status}`);
  }
  check('(5) the one-computer install still trusts this machine', JSON.parse((await req('GET', B, '/api/v1/me')).body).kind === 'local');
  check('(5) and its legacy UI still works', (await req('GET', B, '/api/status')).status === 200);

  // ---------- (5) and (6): relayed (C, no password, MWA_RELAYED=1) ----------
  const relay = net.createServer((c) => { const u = net.connect(C, '127.0.0.1'); c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); });
  await new Promise((r) => relay.listen(RELAY, '127.0.0.1', r));
  for (const host of ['localhost:7788', '127.0.0.1']) {
    const H = { Host: host };
    check(`(5) through a raw relay, Host: ${host} is not "this machine" (/me)`, JSON.parse((await req('GET', RELAY, '/api/v1/me', H)).body).signedIn === false);
    check(`(5) through a raw relay, Host: ${host}: no pairing code`, (await req('POST', RELAY, '/api/v1/pair/codes', { ...H, ...J, 'Idempotency-Key': key() }, '{}')).status === 401);
    check(`(5) through a raw relay, Host: ${host}: no settings change`, (await req('PATCH', RELAY, '/api/v1/settings', { ...H, ...J, 'Idempotency-Key': key() }, '{"helperName":"owned"}')).status === 401);
  }
  console.log('== (6) the legacy inventory, relayed, no password');
  const INV = ['/api/status', '/api/connections', '/api/memories', '/api/vault', '/api/billing', '/api/logs', '/api/conversations', '/api/schedule', '/api/approvals', '/api/people', '/api/notifications', '/api/memory/export', '/api/files', '/api/quiet', '/api/v1/settings'];
  const codes = [];
  for (const p of INV) codes.push([p, (await req('GET', RELAY, p, { Host: 'localhost:7788' })).status]);
  check('(6) every legacy route answers 401 to a stranger through a relay', codes.every(([, s]) => s === 401), JSON.stringify(codes.filter(([, s]) => s !== 401)));
  const posts = [];
  for (const p of ['/api/open', '/api/files/upload?name=x.txt', '/api/save', '/api/quiet']) posts.push([p, (await req('POST', RELAY, p, { Host: 'localhost:7788', ...J }, '{}')).status]);
  check('(6) and writes too', posts.every(([, s]) => s === 401), JSON.stringify(posts));
  check('(6) health stays public', (await req('GET', RELAY, '/api/health', { Host: 'localhost:7788' })).status === 200);
  relay.close();

  // ---------- (9) a broken settings file (D) ----------
  console.log('== (9) broken settings file');
  const dpw = String((await req('POST', D, '/api/v1/session', J, JSON.stringify({ password: PW }))).headers['set-cookie']?.[0] ?? '').split(';')[0];
  const ds = JSON.parse((await req('GET', D, '/api/v1/settings', { cookie: dpw })).body);
  check('(9) a broken mwa.config.json is reported, in plain words', /isn’t valid JSON/.test(ds.configError ?? ''), JSON.stringify(ds.configError));
  const skip = await req('PATCH', D, '/api/v1/settings', { ...J, cookie: dpw, 'Idempotency-Key': key() }, '{"firstRunDone":true}');
  check('(9) and "Skip setup" still works (first run lives in app.db)', skip.status === 200 && JSON.parse(skip.body).firstRunDone === true, skip.body.slice(0, 200));
} catch (e) {
  check('the probe run finished', false, String(e?.stack ?? e));
} finally {
  stopAll();
  console.log(`  (stopped PIDs ${servers.map((s) => s.pid).join(', ')})`);
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} probes passed`);
process.exit(failed ? 1 : 0);
