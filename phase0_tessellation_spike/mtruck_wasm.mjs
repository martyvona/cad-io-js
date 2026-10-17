import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SKIP = /bicycle\.stp\.absr\.2016\./; // times out natively
const t0 = performance.now();
const wasmBytes = fs.readFileSync('mtruck_spike/pkg-node/mtruck_spike_bg.wasm');
await WebAssembly.compile(wasmBytes);
const tc = performance.now() - t0;
const load = () => { delete require.cache[require.resolve('./mtruck_spike/pkg-node/mtruck_spike.js')]; return require('./mtruck_spike/pkg-node/mtruck_spike.js'); };
const t1 = performance.now();
let mod = load();
const tl = performance.now() - t1;
console.log(`compile ${tc.toFixed(1)} ms, load+instantiate ${tl.toFixed(1)} ms`);
let total = 0, ok = 0, fail = 0, tris = 0, nfiles = 0, maxHeap = 0;
for (const dir of process.argv.slice(2)) for (const f of fs.readdirSync(dir).filter((f) => f.includes('.absr.')).sort()) {
  if (SKIP.test(f)) continue;
  nfiles++;
  const s = fs.readFileSync(path.join(dir, f), 'latin1');
  const t = performance.now();
  try {
    const j = JSON.parse(mod.tessellate(s, 0.05, false));
    total += performance.now() - t;
    if (j.error) { fail++; continue; }
    ok++; for (const sh of j.shells) for (const fc of sh.faces) tris += fc.tris;
  } catch (e) { fail++; mod = load(); }
  maxHeap = Math.max(maxHeap, process.memoryUsage().rss);
}
console.log(`files ${nfiles} ok ${ok} fail ${fail} wasm total ${total.toFixed(0)} ms tris ${tris} peak rss ${(maxHeap / 2 ** 20).toFixed(0)} MiB`);
