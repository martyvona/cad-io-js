// Compare mesh algorithms (Watson vs Delabella) and min-size options: time, failed faces, area vs Watson.
import fs from 'node:fs';
import path from 'node:path';
const occtTess = (await import(process.env.MOD ?? './occt_tess/final_Os.mjs')).default;
const M = await occtTess();
const triArea = (P, a, b, c) => { const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]; return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]); };
function run(buf, root) {
  const p = M._malloc(buf.length); M.HEAPU8.set(buf, p);
  const t = performance.now(); const rc = M._occt_tessellate(p, buf.length, root, 0.05, 0.5, 0); const ms = performance.now() - t; M._free(p);
  if (rc) return { ms, ok: false };
  const d = JSON.parse(M.UTF8ToString(M._occt_diag()));
  const P = M.HEAPF32.subarray(M._occt_positions() / 4), I = M.HEAPU32.subarray(M._occt_indices() / 4, M._occt_indices() / 4 + M._occt_num_indices());
  let a = 0; for (let k = 0; k < I.length; k += 3) a += triArea(P, 3 * I[k], 3 * I[k + 1], 3 * I[k + 2]);
  const tris = I.length / 3; M._occt_free();
  return { ms, ok: true, noTri: d.noTriangulation, area: a, tris };
}
const configs = [['watson', 0, 0, 0, 1], ['delabella', 1, 0, 0, 1], ['watson+adjustMinSize', 0, 1, 0, 1]];
const files = process.argv.slice(2).flatMap((d) => fs.readdirSync(d).filter((f) => /\.absr\.\d+\.stp$/.test(f)).sort().map((f) => path.join(d, f)));
const res = {};
for (const [name, algo, adj, minSize, csd] of configs) {
  M._occt_set_mesh_options(algo, adj, minSize, csd);
  res[name] = files.map((f) => run(fs.readFileSync(f), +f.match(/\.absr\.(\d+)\.stp$/)[1]));
}
const ref = res.watson;
for (const [name] of configs) {
  const r = res[name];
  const ms = r.reduce((a, x) => a + x.ms, 0), noTri = r.reduce((a, x) => a + (x.noTri ?? 0), 0), tris = r.reduce((a, x) => a + (x.tris ?? 0), 0);
  const fails = r.filter((x) => !x.ok).length;
  const off = r.filter((x, i) => x.ok && ref[i].ok && Math.abs(x.area / ref[i].area - 1) > 0.001).length;
  const i2022 = files.findIndex((f) => f.includes('bicycle.stp.absr.2022.'));
  console.log(`${name.padEnd(22)} total ${(ms / 1000).toFixed(1)} s, #2022 ${i2022 >= 0 ? (r[i2022].ms / 1000).toFixed(1) + ' s' : '-'}, failed parts ${fails}, faces without triangulation ${noTri}, triangles ${(tris / 1e6).toFixed(2)}M, parts with area off >0.1% vs watson ${off}`);
}
