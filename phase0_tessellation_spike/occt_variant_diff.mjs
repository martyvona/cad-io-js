// Compare two builds part by part: success, face ids, triangle count and area.
import fs from 'node:fs';
import path from 'node:path';
const [modA, modB, ...dirs] = process.argv.slice(2);
const A = await (await import(modA)).default(), B = await (await import(modB)).default();
const triArea = (P, a, b, c) => { const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]; return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]); };
function run(M, buf, root) {
  const p = M._malloc(buf.length); M.HEAPU8.set(buf, p); const rc = M._occt_tessellate(p, buf.length, root, 0.05, 0.5, 0); M._free(p);
  if (rc) return null;
  const nf = M._occt_num_faces(), F = M.HEAP32.slice(M._occt_faces() / 4, M._occt_faces() / 4 + 3 * nf);
  const P = M.HEAPF32.subarray(M._occt_positions() / 4), I = M.HEAPU32.subarray(M._occt_indices() / 4, M._occt_indices() / 4 + M._occt_num_indices());
  let a = 0; for (let k = 0; k < I.length; k += 3) a += triArea(P, 3 * I[k], 3 * I[k + 1], 3 * I[k + 2]);
  const r = { ids: [...F.filter((_, i) => i % 3 === 0)].join(','), tris: I.length / 3, area: a, edges: M._occt_num_edges() }; M._occt_free(); return r;
}
let n = 0, identical = 0, sameIds = 0, sameTris = 0, areaMax = 0, fails = 0;
for (const d of dirs) for (const f of fs.readdirSync(d).filter((f) => /\.absr\.\d+\.stp$/.test(f))) {
  const buf = fs.readFileSync(path.join(d, f)), root = +f.match(/\.absr\.(\d+)\.stp$/)[1];
  const a = run(A, buf, root), b = run(B, buf, root); n++;
  if (!a || !b) { fails++; continue; }
  if (a.ids === b.ids) sameIds++;
  if (a.tris === b.tris) sameTris++;
  if (a.ids === b.ids && a.tris === b.tris && a.area === b.area && a.edges === b.edges) identical++;
  areaMax = Math.max(areaMax, Math.abs(a.area / b.area - 1));
}
console.log({ parts: n, fails, sameFaceIds: sameIds, sameTriangleCount: sameTris, bitIdenticalArea: identical, maxRelAreaDiff: areaMax.toExponential(2) });
