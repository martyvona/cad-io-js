// Test the custom OCCT build (occt_tess/) on subset files: bare vs wrapped x product mode OFF/ON,
// face-id correctness (vertex check, file units) and area vs occt-import-js.
// usage: node occt_tess_test.mjs <subsetDir> [filter]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { indexP21, closure, hasType, attrText } from './p21.mjs';
const occtTess = (await import(process.env.MOD ?? './occt_tess/final_Os.mjs')).default;
const require = createRequire(import.meta.url);

const t0 = performance.now();
const M = await occtTess();
const tInit = performance.now() - t0;
const ref = process.env.NOREF ? null : await require('occt-import-js')();
console.log(`occt_tess init ${tInit.toFixed(1)} ms, heap ${(M.HEAPU8.length / 2 ** 20).toFixed(0)} MiB`);

const DEFL = +(process.env.DEFL ?? 0.05), ANG = 0.5;
function tess(buf, rootId, productMode) {
  const p = M._malloc(buf.length);
  M.HEAPU8.set(buf, p);
  const t = performance.now();
  const rc = M._occt_tessellate(p, buf.length, rootId, DEFL, ANG, productMode);
  const ms = performance.now() - t;
  M._free(p);
  const diag = JSON.parse(M.UTF8ToString(M._occt_diag()));
  if (rc !== 0) return { ok: false, rc, ms, diag };
  const nv = M._occt_num_vertices(), ni = M._occt_num_indices(), nf = M._occt_num_faces();
  const positions = M.HEAPF32.slice(M._occt_positions() / 4, M._occt_positions() / 4 + 3 * nv);
  const indices = M.HEAPU32.slice(M._occt_indices() / 4, M._occt_indices() / 4 + ni);
  const fr = M.HEAP32.slice(M._occt_faces() / 4, M._occt_faces() / 4 + 3 * nf);
  M._occt_free();
  const faces = []; for (let i = 0; i < nf; i++) faces.push({ id: fr[3 * i], start: fr[3 * i + 1], count: fr[3 * i + 2] });
  return { ok: ni > 0, rc, ms, diag, positions, indices, faces };
}

const ORIG_DIRS = [import.meta.dirname + '/../test_corpus/third_party/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files', import.meta.dirname + '/../test_corpus/third_party/gkv311-opencascade-dataset/step'];
const origCache = new Map();
const orig = (base) => { if (!origCache.has(base)) origCache.set(base, indexP21(fs.readFileSync(ORIG_DIRS.map((d) => path.join(d, base)).find((p) => fs.existsSync(p))))); return origCache.get(base); };
const pointOf = (idx, id) => { const m = /\(([^()]*)\)\s*$/.exec(attrText(idx, idx.ents.get(id))); return m[1].split(',').map(Number); };
const triArea = (P, a, b, c) => { const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]; return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]); };

function checkFaces(idx, r) {
  const { positions: P, indices: I, faces } = r;
  let withId = 0, agree = 0, nearest = 0, checked = 0;
  const counts = new Map();
  const vsets = faces.map((f) => { const s = new Set(); for (let k = f.start; k < f.start + f.count; k++) s.add(I[k]); return s; });
  const dist = (vs, q) => { let b = Infinity; for (const v of vs) b = Math.min(b, Math.hypot(P[3 * v] - q[0], P[3 * v + 1] - q[1], P[3 * v + 2] - q[2])); return b; };
  // a STEP face may be split into several OCCT faces: check its vertices against the union of its ranges
  const byId = new Map();
  faces.forEach((f, i) => { if (f.id < 0) return; withId++; counts.set(f.id, (counts.get(f.id) ?? 0) + 1); if (!byId.has(f.id)) byId.set(f.id, new Set()); for (const v of vsets[i]) byId.get(f.id).add(v); });
  for (const [id, vs] of byId) {
    if (!vs.size) continue;
    const fe = idx.ents.get(id);
    const vps = [...closure(idx, fe.refs.slice(0, -1))].map((x) => idx.ents.get(x)).filter((e) => hasType(e, 'VERTEX_POINT')).map((e) => pointOf(idx, e.refs[0]));
    if (!vps.length) continue;
    checked++;
    const own = Math.max(...vps.map((q) => dist(vs, q)));
    if (own < 1e-3 * (1 + Math.max(...vps.flat().map(Math.abs))) * 1e-1) { agree++; nearest++; continue; }
    if ([...byId].every(([o, s]) => o === id || !s.size || Math.max(...vps.map((q) => dist(s, q))) >= own * 0.999)) nearest++;
  }
  const split = [...counts.values()].filter((c) => c > 1).length;
  return { withId, distinctIds: byId.size, checked, agree, nearest, split };
}

const [dir, filter = ''] = process.argv.slice(2);
const parts = [...new Set(fs.readdirSync(dir).filter((f) => /\.absr\.\d+\.stp$/.test(f) && f.includes(filter)).map((f) => f.replace(/\.absr\.(\d+)\.stp$/, '|$1')))].sort();
const S = { parts: 0, combos: {}, faces: 0, withId: 0, checked: 0, agree: 0, nearest: 0, split: 0, unmapped: 0, ms: 0, refMs: 0, area: [] };
for (const key of parts) {
  const [base, root] = key.split('|');
  const bare = fs.readFileSync(path.join(dir, `${base}.absr.${root}.stp`));
  const wrapped = fs.readFileSync(path.join(dir, `${base}.absr+wrap.${root}.stp`));
  S.parts++;
  const res = {};
  for (const [name, buf, pm] of [['bare/off', bare, 0], ['bare/on', bare, 1], ['wrap/off', wrapped, 0], ['wrap/on', wrapped, 1]]) {
    const r = tess(buf, +root, pm);
    res[name] = r;
    (S.combos[name] ??= { ok: 0, fail: 0 })[r.ok ? 'ok' : 'fail']++;
  }
  const r = res['bare/off'];
  let line = `${base} #${root}: ` + Object.entries(res).map(([k, v]) => `${k}=${v.ok ? 'ok' : 'FAIL'}`).join(' ');
  if (r.ok) {
    const c = checkFaces(orig(base), r);
    S.faces += r.faces.length; S.withId += c.withId; S.checked += c.checked; S.agree += c.agree; S.nearest += c.nearest; S.split += c.split; S.unmapped += r.diag.unmapped; S.ms += r.ms;
    // identical output for bare/off and wrap/on?
    const w = res['wrap/on'];
    const same = w.ok && w.indices.length === r.indices.length && w.faces.length === r.faces.length && w.faces.every((f, i) => f.id === r.faces[i].id && f.count === r.faces[i].count);
    line += ` | ${r.ms.toFixed(0)}ms faces=${r.faces.length} stepFaces=${r.diag.stepFaces} unmapped=${r.diag.unmapped} split=${c.split} idCheck=${c.agree}/${c.checked} nearest=${c.nearest} unitMm=${r.diag.unitMm} bare/off==wrap/on:${same}`;
    if (ref) {
      const t = performance.now();
      const rr = ref.ReadStepFile(wrapped, { linearDeflectionType: 'absolute_value', linearDeflection: DEFL * r.diag.unitMm, angularDeflection: ANG });
      S.refMs += performance.now() - t;
      if (rr.success) {
        let ao = 0; for (const m of rr.meshes) { const P = m.attributes.position.array, I = m.index.array; for (let k = 0; k < I.length; k += 3) ao += triArea(P, 3 * I[k], 3 * I[k + 1], 3 * I[k + 2]); }
        let at = 0; for (let k = 0; k < r.indices.length; k += 3) at += triArea(r.positions, 3 * r.indices[k], 3 * r.indices[k + 1], 3 * r.indices[k + 2]);
        const ratio = (at * r.diag.unitMm ** 2) / ao;
        S.area.push(ratio);
        line += ` areaRatio=${ratio.toFixed(4)}`;
      }
    }
  } else line += ` | ${JSON.stringify(r.diag)}`;
  console.log(line);
}
const within = (e) => S.area.filter((x) => Math.abs(x - 1) < e).length;
console.log(JSON.stringify({ ...S, area: undefined, areaWithin01pct: within(0.001), areaWithin1pct: within(0.01), areaN: S.area.length, peakHeapMiB: +(M.HEAPU8.length / 2 ** 20).toFixed(0) }));
