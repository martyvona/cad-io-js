// Phase 1 step 2: list strings where the lenient end-of-string rule differs from the strict one (first lone ').
import fs from 'node:fs';
import { stringEnd } from '../packages/step-parser/src/index.ts';
const strictEnd = (b: Uint8Array, i: number) => { for (let j = i + 1; j < b.length; j++) if (b[j] === 0x27) { if (b[j + 1] === 0x27) { j++; continue; } return j + 1; } return -1; };
for (const f of fs.readFileSync(process.argv[2]!, 'utf8').trim().split('\n')) {
  const b = fs.readFileSync(f);
  let i = 0, n = 0; const ex: string[] = [];
  while (i < b.length) {
    const c = b[i];
    if (c === 0x2f && b[i + 1] === 0x2a) { const j = b.indexOf(0x2a, i + 2); let k = j; while (k >= 0 && b[k + 1] !== 0x2f) k = b.indexOf(0x2a, k + 1); i = k < 0 ? b.length : k + 2; continue; }
    if (c !== 0x27) { i++; continue; }
    const e = stringEnd(b, i), s = strictEnd(b, i);
    if (e !== s) { n++; if (ex.length < 2) ex.push(Buffer.from(b.subarray(i, Math.min(e, i + 80))).toString('latin1')); }
    i = e < 0 ? b.length : e;
  }
  if (n) console.log(n, f.replace(/^.*\/others\//, ''), JSON.stringify(ex));
}
