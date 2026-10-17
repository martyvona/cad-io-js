import fs from 'node:fs';
import path from 'node:path';
const occtTess = (await import(process.env.MOD ?? './occt_tess/final_Os.mjs')).default;
const M = await occtTess();
let n = 0, empty = 0, withId = 0, pts = 0, distinct = 0;
for (const dir of process.argv.slice(2)) for (const f of fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f))) {
  const buf = fs.readFileSync(path.join(dir, f)); const root = +f.match(/\.absr\.(\d+)\.stp$/)[1];
  const p = M._malloc(buf.length); M.HEAPU8.set(buf, p);
  const rc = M._occt_tessellate(p, buf.length, root, 0.05, 0.5, 0); M._free(p); if (rc) continue;
  const ne = M._occt_num_edges(), E = M.HEAP32.slice(M._occt_edges() / 4, M._occt_edges() / 4 + 4 * ne);
  const EP = M.HEAPF32.slice(M._occt_edge_positions() / 4, M._occt_edge_positions() / 4 + 3 * M._occt_num_edge_points());
  for (let k = 0; k < ne; k++) {
    if (E[4 * k + 3] !== 3) continue;
    n++; const first = E[4 * k + 1], count = E[4 * k + 2]; if (E[4 * k] >= 0) withId++;
    if (!count) { empty++; continue; }
    pts += count;
    const s = new Set(); for (let j = first; j < first + count; j++) s.add(`${EP[3 * j]},${EP[3 * j + 1]},${EP[3 * j + 2]}`);
    distinct += s.size;
  }
  M._occt_free();
}
console.log({ degenerate: n, emptyPolyline: empty, withEntityId: withId, points: pts, distinctPointsSum: distinct });
