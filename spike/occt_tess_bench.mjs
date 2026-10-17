// clean timing: bare subsets, product mode OFF, one fresh module per run
import fs from 'node:fs';
import path from 'node:path';
const occtTess = (await import(process.env.MOD ?? './occt_tess/final_Os.mjs')).default;
const t0 = performance.now(); const M = await occtTess(); const tInit = performance.now() - t0;
let total = 0, n = 0, worst = [0, ''];
for (const dir of process.argv.slice(2)) for (const f of fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f)).sort()) {
  const buf = fs.readFileSync(path.join(dir, f)); const root = +f.match(/\.absr\.(\d+)\.stp$/)[1];
  const p = M._malloc(buf.length); M.HEAPU8.set(buf, p);
  const t = performance.now(); M._occt_tessellate(p, buf.length, root, 0.05, 0.5, 0); const ms = performance.now() - t;
  M._free(p); M._occt_free(); total += ms; n++; if (ms > worst[0]) worst = [ms, f];
}
console.log(`init ${tInit.toFixed(1)} ms, ${n} parts, total ${total.toFixed(0)} ms, worst ${worst[0].toFixed(0)} ms ${worst[1]}, heap ${(M.HEAPU8.length / 2 ** 20).toFixed(0)} MiB, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`);
