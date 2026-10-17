// Phase 1 step 2: time pass 1 (scan) and pass 2 (decode everything) on large files.
import fs from 'node:fs';
import { parseStep } from '../packages/step-parser/src/index.ts';
const D = '/Users/vona/src/others/gkv311-opencascade-dataset/step/';
for (const f of process.argv.slice(2)) {
  const bytes = fs.readFileSync(D + f);
  const mb = bytes.length / 1e6;
  for (let run = 0; run < 3; run++) {
    global.gc?.();
    const h0 = process.memoryUsage().heapUsed;
    let t = performance.now();
    const file = parseStep(bytes);
    const tScan = performance.now() - t;
    const h1 = process.memoryUsage().heapUsed;
    t = performance.now();
    let n = 0, errs = 0;
    for (const _ of file.instances(() => errs++)) n++;
    const tDec = performance.now() - t;
    if (run === 2) console.log(`${f}: ${mb.toFixed(1)} MB, ${file.count} instances, ${file.index.refs.length} refs | scan ${tScan.toFixed(0)} ms (${(mb / tScan * 1000).toFixed(0)} MB/s), +${((h1 - h0) / 1e6).toFixed(0)} MB heap | decode all ${tDec.toFixed(0)} ms (${(mb / tDec * 1000).toFixed(0)} MB/s), ${errs} errors, ${file.diagnostics.length} diagnostics`);
  }
}
