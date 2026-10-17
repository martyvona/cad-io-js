import fs from 'node:fs';
import { indexP21, closure } from './p21.mjs';
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f);
  let best = Infinity, idx;
  for (let k = 0; k < 5; k++) { const t = performance.now(); idx = indexP21(buf); best = Math.min(best, performance.now() - t); }
  // closure of every shape representation, as a per-part subset workload
  const t = performance.now(); let n = 0;
  for (const e of idx.ents.values()) if (e.types.some((x) => /SHAPE_REPRESENTATION$/.test(x))) { closure(idx, [e.id]); n++; }
  const tc = performance.now() - t;
  console.log(`${f.split('/').pop()}: ${(buf.length / 1e6).toFixed(1)} MB, ${idx.ents.size} ents, index ${best.toFixed(0)} ms (${(buf.length / 1e6 / best * 1000).toFixed(0)} MB/s), ${n} closures ${tc.toFixed(0)} ms, heap ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} MiB`);
}
