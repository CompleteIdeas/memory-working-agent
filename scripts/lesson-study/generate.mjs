// BL-35 quality study, step 1: MWA's own lesson prompt (the Reflexion pass, copied verbatim from
// src/agent.ts) turns each failed run in scenarios.mjs into a lesson, with the production model.
// Runs INSIDE the mwa-dev container, where /app/dist has MWA's provider and /data/.env its keys:
//   docker cp scripts/lesson-study mwa-dev:/tmp/ls && docker exec mwa-dev node /tmp/ls/generate.mjs 3 > results/lesson-study-generated.json
import { SCENARIOS } from './scenarios.mjs';

const SAMPLES = Number(process.argv[2] ?? 2);
const { getProvider } = await import('/app/dist/provider.js');
const brain = getProvider('fetch');
const SYSTEM = 'A task did NOT go cleanly. In ONE or TWO sentences, write a reusable lesson for a FUTURE similar attempt: what went wrong, the likely cause, and what to do differently next time. Be concrete and general enough to transfer (name the kind of task/tool, not one-off specifics). Output ONLY JSON {"topic":"2-5 word kind of task this applies to","lesson":"X failed because Y; next time Z"}. If there is no transferable lesson (a clean run, or a failure outside our control with no better next step), output exactly {}.';

const out = []; let cost = 0;
for (const s of SCENARIOS.filter((x) => !process.env.GROUPS || process.env.GROUPS.split(',').includes(x.group))) {
  for (let k = 0; k < SAMPLES; k++) {
    const r = await brain.chat({
      system: SYSTEM,
      messages: [{ role: 'user', content: `REQUEST: ${s.request}\n\nWHAT HAPPENED (most recent last):\n${s.history.join('\n')}\n\nOUTCOME: ${s.reason} — ${s.summary}` }],
      maxTokens: 220,
    });
    cost += (r.usage.input / 1e6) * brain.price[0] + (r.usage.output / 1e6) * brain.price[1];
    let parsed = {};
    try { parsed = JSON.parse(String(r.text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { parsed = { unparsed: String(r.text).slice(0, 400) }; }
    out.push({ scenario: s.id, group: s.group, sample: k, ...parsed });
  }
}
console.error(`model ${brain.model}; ${out.length} calls; ~$${cost.toFixed(4)}`);
process.stdout.write(JSON.stringify(out, null, 1));
