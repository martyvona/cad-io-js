// Edge prototype checks for the custom OCCT build: id mapping, endpoints vs EDGE_CURVE vertices,
// coincidence of polyline points with mesh vertices, kinds and dihedral angles.
// usage: MOD=./occt_tess/final_Os.mjs node occt_edges_test.mjs <subsetDir> [filter]
import fs from 'node:fs';
import path from 'node:path';
import { indexP21, attrText } from './p21.mjs';
const occtTess = (await import(process.env.MOD ?? './occt_tess/final_Os.mjs')).default;
const M = await occtTess();

const ORIG_DIRS = [import.meta.dirname + '/../test_corpus/third_party/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files', import.meta.dirname + '/../test_corpus/third_party/gkv311-opencascade-dataset/step'];
const origCache = new Map();
const orig = (base) => { if (!origCache.has(base)) origCache.set(base, indexP21(fs.readFileSync(ORIG_DIRS.map((d) => path.join(d, base)).find((p) => fs.existsSync(p))))); return origCache.get(base); };
const pointOf = (idx, id) => { const m = /\(([^()]*)\)\s*$/.exec(attrText(idx, idx.ents.get(id))); return m[1].split(',').map(Number); };
const KINDS = ['shared', 'seam', 'free', 'degenerate'];

const [dir, filter = ''] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f) && f.includes(filter)).sort();
const T = { parts: 0, stepEdges: 0, edges: 0, mapped: 0, splitIds: 0, endpointsBoth: 0, endpointsOne: 0, endpointsNone: 0, endpointsChecked: 0,
  points: 0, pointsOnMesh: 0, noPolygon: 0, kinds: [0, 0, 0, 0], angleHist: { '<1deg': 0, '1-10deg': 0, '10-30deg': 0, '>30deg': 0, 'n/a': 0 }, edgePoints: 0, meshVerts: 0, ms: 0 };
for (const f of files) {
  const base = f.replace(/\.absr\.\d+\.stp$/, ''), root = +f.match(/\.absr\.(\d+)\.stp$/)[1];
  const buf = fs.readFileSync(path.join(dir, f));
  const p = M._malloc(buf.length); M.HEAPU8.set(buf, p);
  const t = performance.now();
  const rc = M._occt_tessellate(p, buf.length, root, 0.05, 0.5, 0);
  T.ms += performance.now() - t; M._free(p);
  if (rc) { console.log(f, 'FAIL', M.UTF8ToString(M._occt_diag())); continue; }
  const diag = JSON.parse(M.UTF8ToString(M._occt_diag()));
  const nv = M._occt_num_vertices(), ne = M._occt_num_edges(), np = M._occt_num_edge_points();
  const P = M.HEAPF32.slice(M._occt_positions() / 4, M._occt_positions() / 4 + 3 * nv);
  const EP = M.HEAPF32.slice(M._occt_edge_positions() / 4, M._occt_edge_positions() / 4 + 3 * np);
  const E = M.HEAP32.slice(M._occt_edges() / 4, M._occt_edges() / 4 + 4 * ne);
  const A = M.HEAPF32.slice(M._occt_edge_angles() / 4, M._occt_edge_angles() / 4 + ne);
  M._occt_free();
  T.parts++; T.stepEdges += diag.stepEdges; T.edges += ne; T.noPolygon += diag.edgesNoPolygon; T.edgePoints += np; T.meshVerts += nv;
  // exact coincidence: hash mesh vertex coordinates (float32 bit patterns)
  const key = (a, i) => `${a[i]},${a[i + 1]},${a[i + 2]}`;
  const meshSet = new Set(); for (let i = 0; i < P.length; i += 3) meshSet.add(key(P, i));
  const idx = orig(base);
  const idCount = new Map();
  let ext = 0; for (let i = 0; i < P.length; i++) ext = Math.max(ext, Math.abs(P[i]));
  const tol = 1e-5 * (ext || 1);
  const near = (x, i, q) => Math.hypot(x[i] - q[0], x[i + 1] - q[1], x[i + 2] - q[2]) <= tol;
  for (let k = 0; k < ne; k++) {
    const [id, first, count, kind] = [E[4 * k], E[4 * k + 1], E[4 * k + 2], E[4 * k + 3]];
    T.kinds[kind]++;
    const a = A[k];
    T.angleHist[a < 0 ? 'n/a' : a < Math.PI / 180 ? '<1deg' : a < Math.PI / 18 ? '1-10deg' : a < Math.PI / 6 ? '10-30deg' : '>30deg']++;
    for (let j = first; j < first + count; j++) { T.points++; if (meshSet.has(key(EP, 3 * j))) T.pointsOnMesh++; }
    if (id < 0) continue;
    T.mapped++; idCount.set(id, (idCount.get(id) ?? 0) + 1);
    if (count < 2 || kind === 3) continue;
    const ec = idx.ents.get(id); // EDGE_CURVE('', #start, #end, #curve, .T.)
    const vs = [ec.refs[0], ec.refs[1]].map((v) => pointOf(idx, idx.ents.get(v).refs[0]));
    const s0 = 3 * first, s1 = 3 * (first + count - 1);
    const hits = vs.filter((q) => near(EP, s0, q) || near(EP, s1, q)).length;
    T.endpointsChecked++;
    if (hits === 2 || (vs[0].every((x, i) => x === vs[1][i]) && hits >= 1)) T.endpointsBoth++; else if (hits === 1) T.endpointsOne++; else T.endpointsNone++;
  }
  T.splitIds += [...idCount.values()].filter((c) => c > 1).length;
}
T.ms = Math.round(T.ms);
console.log(JSON.stringify({ ...T, kinds: Object.fromEntries(KINDS.map((k, i) => [k, T.kinds[i]])) }, null, 1));
