// BL-52 step 1: every distinct message the simulated person sent in the BL-40 assessment, plus the
// messages the BL-43 review found the regex misreading. Labels are added by hand in labeled.json.
//   node scripts/intent-calibration/extract.mjs > scripts/intent-calibration/messages.json
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results', 'assessment');
const seen = new Map();
for (const d of readdirSync(ROOT).filter((x) => statSync(join(ROOT, x)).isDirectory())) {
  for (const line of readFileSync(join(ROOT, d, 'transcript.jsonl'), 'utf8').trim().split('\n')) {
    const m = JSON.parse(line);
    if (m.who !== 'person' || typeof m.text !== 'string') continue;
    const t = m.text.trim();
    if (t && !seen.has(t)) seen.set(t, { text: t, from: `${d}/${m.session}${m.followUp ? '/follow-up' : ''}` });
  }
}
console.log(JSON.stringify([...seen.values()], null, 1));
