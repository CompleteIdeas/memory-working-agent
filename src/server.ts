/**
 * MWA turnkey setup + run UI — zero dependencies (node:http).
 * Serves a single lightweight page; runs the brain and streams live activity
 * over SSE. Start: `npm run ui` → http://localhost:7878
 *
 * Routes:
 *   GET /              → the page
 *   GET /api/config    → providers detected + built-in tasks
 *   GET /api/run?...   → SSE: streams recall/dispatch/done + final result
 *
 * (Design note: kept deliberately lightweight per the turnkey requirement — a
 * full /front-end-designer polish pass is a good awake follow-up.)
 */
import { createServer } from 'node:http';
import { getProvider } from './provider.js';
import { MwaMemory, NullMemory, type Memory } from './awm.js';
import { TASKS } from './tasks.js';
import { runBrain } from './brain.js';
import { loadEnv } from './env.js';

loadEnv();
const PORT = Number(process.env.PORT ?? 7878);

const HTML = String.raw`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MWA — Memory Working Agent</title>
<style>
  :root{--bg:#0e1014;--panel:#171a21;--line:#262b36;--txt:#e6e9ef;--dim:#8a93a6;--accent:#5ce1b0;--warn:#f0b15c;--bad:#f06c6c;--ok:#5ce1b0}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  .wrap{max-width:920px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:20px;margin:0 0 2px;letter-spacing:.2px}h1 b{color:var(--accent)}
  .sub{color:var(--dim);font-size:13px;margin-bottom:22px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:760px){.grid{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}
  label{display:block;font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px}
  select,input,textarea{width:100%;background:#0e1117;color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:9px 10px;font:inherit}
  textarea{min-height:74px;resize:vertical}
  .arms{display:flex;gap:8px;margin-top:6px}
  .arm{flex:1;text-align:center;border:1px solid var(--line);border-radius:8px;padding:9px 6px;cursor:pointer;font-size:13px;background:#0e1117}
  .arm.sel{border-color:var(--accent);background:#10241d;color:var(--accent)}
  .arm small{display:block;color:var(--dim);font-size:11px;margin-top:2px}
  button{margin-top:18px;width:100%;background:var(--accent);color:#06120d;border:0;border-radius:9px;padding:12px;font-weight:700;font-size:15px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .cfg{font-size:12px;color:var(--dim);margin-top:10px}.cfg b{color:var(--ok)}.cfg .x{color:var(--bad)}
  #log{font:12.5px/1.55 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;min-height:180px;max-height:340px;overflow:auto;background:#0b0d12;border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:4px}
  .ev{margin:0 0 4px}.ev .t{color:var(--accent)}.pass{color:var(--ok)}.fail{color:var(--bad)}
  .res{margin-top:14px;border:1px solid var(--line);border-radius:8px;padding:14px;display:none}
  .res.show{display:block}.res.win{border-color:var(--ok)}.res.lose{border-color:var(--bad)}
  .stat{display:inline-block;margin-right:20px}.stat b{font-size:20px;display:block}.stat span{font-size:11px;color:var(--dim);text-transform:uppercase}
</style></head><body><div class="wrap">
<h1><b>MWA</b> — Memory Working Agent</h1>
<div class="sub">Cheap-model autonomous orchestrator on the AWM substrate. Pick a task, an arm, and run it.</div>
<div class="grid">
  <div class="panel">
    <label>Task</label>
    <select id="task"></select>
    <div id="customWrap" style="display:none">
      <label>Goal</label><textarea id="goal" placeholder="Create greet.mjs exporting greet(name)... and test.mjs that asserts it."></textarea>
      <label>Test command</label><input id="testCmd" value="node test.mjs">
    </div>
    <label>Arm</label>
    <div class="arms" id="arms">
      <div class="arm sel" data-arm="A">A · cheap+AWM<small>gpt-5-4-mini + memory</small></div>
      <div class="arm" data-arm="B">B · cheap<small>gpt-5-4-mini, no memory</small></div>
      <div class="arm" data-arm="C">C · high<small>Sonnet, no memory</small></div>
    </div>
    <button id="run">Run agent</button>
    <div class="cfg" id="cfg"></div>
  </div>
  <div class="panel">
    <label>Live activity</label>
    <div id="log">Idle.</div>
    <div class="res" id="res"></div>
  </div>
</div></div>
<script>
let cfg={tasks:[]};
const $=s=>document.querySelector(s);
fetch('/api/config').then(r=>r.json()).then(c=>{cfg=c;
  const sel=$('#task'); for(const t of c.tasks){const o=document.createElement('option');o.value=t.id;o.textContent=t.id+' — '+t.goal;sel.appendChild(o);}
  const o=document.createElement('option');o.value='__custom';o.textContent='Custom task…';sel.appendChild(o);
  $('#cfg').innerHTML='providers: gpt-5-4-mini(Azure) '+(c.azure?'<b>✓</b>':'<span class=x>✗</span>')+' · Sonnet(Anthropic) '+(c.anthropic?'<b>✓</b>':'<span class=x>✗</span>');
});
$('#task').onchange=e=>{$('#customWrap').style.display=e.target.value==='__custom'?'block':'none';};
let arm='A';
document.querySelectorAll('.arm').forEach(a=>a.onclick=()=>{document.querySelectorAll('.arm').forEach(x=>x.classList.remove('sel'));a.classList.add('sel');arm=a.dataset.arm;});
const log=$('#log');function add(html){log.innerHTML+='<div class="ev">'+html+'</div>';log.scrollTop=log.scrollHeight;}
$('#run').onclick=()=>{
  const task=$('#task').value; log.innerHTML=''; $('#res').className='res';
  $('#run').disabled=true;
  let url='/api/run?arm='+arm;
  if(task==='__custom'){url+='&goal='+encodeURIComponent($('#goal').value)+'&testCmd='+encodeURIComponent($('#testCmd').value);}
  else{url+='&taskId='+encodeURIComponent(task);}
  const es=new EventSource(url);
  es.addEventListener('start',e=>{const d=JSON.parse(e.data);add('<span class=t>▶ start</span> arm '+d.arm+' · '+d.provider+' · AWM '+(d.useAwm?'on':'off'));});
  es.addEventListener('recall',e=>{const d=JSON.parse(e.data);add('<span class=t>recall</span> '+(d.awm?d.count+' prior memories primed':'(AWM off)'));});
  es.addEventListener('dispatch',e=>{const d=JSON.parse(e.data);add('<span class=t>dispatch #'+d.n+'</span> <span class="'+(d.pass?'pass':'fail')+'">'+(d.pass?'PASS':'FAIL')+'</span> — '+d.instruction.replace(/</g,'&lt;'));});
  es.addEventListener('done',e=>{const d=JSON.parse(e.data);add('<span class=t>done</span> '+(d.success?'<span class=pass>SUCCESS</span>':'<span class=fail>FAIL</span>'));});
  es.addEventListener('result',e=>{const d=JSON.parse(e.data);es.close();$('#run').disabled=false;
    const win=d.success&&d.constraintOk;const r=$('#res');r.className='res show '+(win?'win':'lose');
    r.innerHTML='<div class=stat><b class="'+(win?'pass':'fail')+'">'+(win?'PASS':'FAIL')+'</b><span>verdict</span></div>'
      +'<div class=stat><b>'+d.dispatches+'</b><span>dispatches</span></div>'
      +'<div class=stat><b>$'+d.costUsd+'</b><span>cost</span></div>'
      +'<div class=stat><b>'+d.recalledCount+'</b><span>recalled</span></div>'
      +(d.note?'<div style="margin-top:10px;color:var(--dim);font-size:12px">'+d.note+'</div>':'');});
  es.addEventListener('error',e=>{es.close();$('#run').disabled=false;add('<span class=fail>error</span> '+(e.data?JSON.parse(e.data).message:'connection lost'));});
};
</script></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        azure: !!process.env.AZURE_GPT_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        tasks: TASKS.map((t) => ({ id: t.id, goal: t.goal.slice(0, 64), constraint: t.constraint ?? null })),
      }),
    );
    return;
  }
  if (url.pathname === '/api/run') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const arm = url.searchParams.get('arm') ?? 'A';
      const taskId = url.searchParams.get('taskId');
      const task = TASKS.find((t) => t.id === taskId);
      const goal = task ? task.goal : url.searchParams.get('goal') ?? '';
      const testCmd = task ? task.testCmd : url.searchParams.get('testCmd') ?? 'node test.mjs';
      const constraint = task?.constraint;
      const brainRole = arm === 'C' ? 'high' : 'brain';
      const useAwm = arm === 'A';
      const provider = getProvider(brainRole);
      const mem: Memory = useAwm ? new MwaMemory('mwa-ui', './data/ui.db') : new NullMemory();
      const dir = `./sandbox/ui/${taskId ?? 'custom'}-${Date.now()}`;
      if (task) task.setup(dir);
      send('start', { arm, brainRole, useAwm, provider: provider.id, goal: goal.slice(0, 120) });
      const result = await runBrain({
        goal: { id: taskId ?? 'custom', goal, testCmd, constraint, protect: task ? undefined : [] },
        memory: mem,
        brain: provider,
        worker: provider,
        sandboxDir: dir,
        maxSteps: 6,
        onEvent: (type, data) => send(type, data),
      });
      mem.close();
      const extra = task?.gradeExtra ? task.gradeExtra(dir) : { ok: true, note: '' };
      send('result', { ...result, constraintOk: extra.ok, note: extra.note });
    } catch (e) {
      send('error', { message: (e as Error).message });
    }
    res.end();
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => console.log(`MWA UI → http://localhost:${PORT}`));
