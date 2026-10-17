// Phase 0 spike: does occt-import-js tessellate per-part STEP subsets, and can faces be correlated to ADVANCED_FACE ids?
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { indexP21, closure, emitSubset, byType, hasType, attrText, typeOf } from './p21.mjs';
const require = createRequire(import.meta.url);

const files = process.argv.slice(2);
const OUT = path.resolve('out');
fs.mkdirSync(OUT, { recursive: true });

const t0 = performance.now();
const occt = await require('occt-import-js')();
const tInit = performance.now() - t0;
const mem0 = process.memoryUsage();
console.log(`occt init ${tInit.toFixed(0)} ms, rss ${(mem0.rss / 2 ** 20).toFixed(0)} MiB, wasm heap ${(occt.HEAP8.length / 2 ** 20).toFixed(0)} MiB`);

const params = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: +(process.env.DEFL ?? 0.05), angularDeflection: 0.5 };

function run(buf) {
  const t = performance.now();
  let r;
  try { r = occt.ReadStepFile(buf, params); } catch (e) { return { ok: false, err: String(e), ms: performance.now() - t }; }
  const ms = performance.now() - t;
  if (!r.success) return { ok: false, ms };
  let tris = 0, faces = 0;
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const m of r.meshes) {
    tris += m.index.array.length / 3; faces += m.brep_faces.length;
    const p = m.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { bb[k] = Math.min(bb[k], p[i + k]); bb[k + 3] = Math.max(bb[k + 3], p[i + k]); }
  }
  return { ok: tris > 0, ms, meshes: r.meshes.length, tris, faces, bb, r };
}

const fmtBB = (bb) => bb ? bb.map((v) => v.toFixed(1)).join(',') : '';

// ---- face correlation: expected ADVANCED_FACE order from the shells of a solid ----
function faceIdsOf(idx, rootId) {
  const out = [];
  const visitShell = (id) => { const e = idx.ents.get(id); for (const r of e.refs) if (hasType(idx.ents.get(r), 'ADVANCED_FACE') || hasType(idx.ents.get(r), 'FACE_SURFACE')) out.push(r); };
  const visit = (id) => {
    const e = idx.ents.get(id);
    if (!e) return;
    if ((hasType(e, 'CLOSED_SHELL') || hasType(e, 'OPEN_SHELL')) && !hasType(e, 'ORIENTED_CLOSED_SHELL')) return visitShell(id);
    if (hasType(e, 'MANIFOLD_SOLID_BREP') || hasType(e, 'BREP_WITH_VOIDS') || hasType(e, 'SHELL_BASED_SURFACE_MODEL') || hasType(e, 'FACETED_BREP') || hasType(e, 'ORIENTED_CLOSED_SHELL') || hasType(e, 'ADVANCED_BREP_SHAPE_REPRESENTATION') || hasType(e, 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION') || hasType(e, 'SHAPE_REPRESENTATION'))
      for (const r of e.refs) visit(r);
  };
  visit(rootId);
  return out;
}
function pointOf(idx, id) {
  const m = /\(\s*([^,()]+)\s*,\s*([^,()]+)\s*(?:,\s*([^,()]+)\s*)?\)\s*$/.exec(attrText(idx, idx.ents.get(id)));
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}
// STEP vertex coordinates of one face (via its bounds, not its surface)
function faceVertices(idx, fid) {
  const f = idx.ents.get(fid);
  const ids = closure(idx, f.refs.slice(0, -1));
  const pts = [];
  for (const id of ids) { const e = idx.ents.get(id); if (hasType(e, 'VERTEX_POINT')) pts.push(pointOf(idx, e.refs[0])); }
  return pts;
}
// Face i of the OCCT output agrees with STEP face i if every STEP vertex of the face is (nearly) a vertex of OCCT face i's mesh.
function correlate(idx, rootId, res) {
  const fids = faceIdsOf(idx, rootId);
  const occFaces = res.r.meshes.flatMap((m) => m.brep_faces.map((bf) => ({ m, bf })));
  const stepPts = fids.map((f) => faceVertices(idx, f));
  const obb = [0, 1, 2].map((k) => res.bb[k + 3] - res.bb[k]);
  const tol = 1e-4 * Math.hypot(...obb) + 1e-6;
  let best = { checked: 0, agree: -1, scale: 1 };
  for (const scale of [1, 25.4, 10, 1000, 304.8]) {
    let checked = 0, agree = 0;
    const n = Math.min(fids.length, occFaces.length);
    for (let i = 0; i < n; i++) {
      const { m, bf } = occFaces[i];
      if (!stepPts[i].length || bf.last < bf.first) continue;
      const p = m.attributes.position.array, ix = m.index.array;
      const vs = new Set(); for (let t = bf.first; t <= bf.last; t++) for (let v = 0; v < 3; v++) vs.add(ix[3 * t + v]);
      checked++;
      const ok = stepPts[i].every((q) => { for (const v of vs) if (Math.hypot(p[3 * v] - q[0] * scale, p[3 * v + 1] - q[1] * scale, p[3 * v + 2] - q[2] * scale) < tol) return true; return false; });
      if (ok) agree++;
    }
    if (agree > best.agree) best = { checked, agree, scale };
  }
  const { checked, agree, scale } = best;
  return { stepFaces: fids.length, occtFaces: occFaces.length, checked, agree, scale: +scale.toFixed(4) };
}

function wrapper(idx, rootId) {
  let b = (idx.maxId ??= idx.order.reduce((a, x) => Math.max(a, x), 0)) + 1;
  const id = () => '#' + b++;
  const [ac, pc, p, pdf, pdc, pd, pds, sdr] = Array.from({ length: 8 }, id);
  return [
    `${ac}=APPLICATION_CONTEXT('');`,
    `${pc}=PRODUCT_CONTEXT('',${ac},'mechanical');`,
    `${p}=PRODUCT('part','part','',(${pc}));`,
    `${pdf}=PRODUCT_DEFINITION_FORMATION('','',${p});`,
    `${pdc}=PRODUCT_DEFINITION_CONTEXT('part definition',${ac},'design');`,
    `${pd}=PRODUCT_DEFINITION('design','',${pdf},${pdc});`,
    `${pds}=PRODUCT_DEFINITION_SHAPE('','',${pd});`,
    `${sdr}=SHAPE_DEFINITION_REPRESENTATION(${pds},#${rootId});`,
  ];
}

const rows = [];
for (const f of files) {
  const buf = fs.readFileSync(f);
  const ti = performance.now();
  const idx = indexP21(buf);
  const tIdx = performance.now() - ti;
  const base = path.basename(f);
  const whole = run(buf);
  console.log(`\n== ${base} (${(buf.length / 1e6).toFixed(2)} MB, ${idx.ents.size} ents, index ${tIdx.toFixed(0)} ms)`);
  console.log(`  whole: ok=${whole.ok} ${whole.ms.toFixed(0)}ms meshes=${whole.meshes} faces=${whole.faces} tris=${whole.tris} bb=${fmtBB(whole.bb)}`);
  rows.push({ file: base, variant: 'whole', root: '', ...strip(whole) });

  // candidate part roots: every ADVANCED_BREP_SHAPE_REPRESENTATION (and MANIFOLD_SURFACE_SHAPE_REPRESENTATION), plus their solids
  const SOLIDISH = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'SHELL_BASED_SURFACE_MODEL', 'FACETED_BREP'];
  const reps = idx.order.map((id) => idx.ents.get(id)).filter((e) => e.types.some((t) => /SHAPE_REPRESENTATION$/.test(t)) &&
    e.refs.some((r) => idx.ents.get(r) && SOLIDISH.some((t) => hasType(idx.ents.get(r), t))));
  for (const rep of reps) {
    const solids = rep.refs.map((r) => idx.ents.get(r)).filter((e) => e && (hasType(e, 'MANIFOLD_SOLID_BREP') || hasType(e, 'BREP_WITH_VOIDS') || hasType(e, 'SHELL_BASED_SURFACE_MODEL')));
    const variants = process.env.ONLY_WRAP ? [['absr+wrap', rep.id, closure(idx, [rep.id]), wrapper(idx, rep.id)]] : [
      ['absr', rep.id, closure(idx, [rep.id]), []],
      ['absr+wrap', rep.id, closure(idx, [rep.id]), wrapper(idx, rep.id)],
      ...solids.map((s) => ['solid', s.id, closure(idx, [s.id]), []]),
    ];
    for (const [name, root, ids, extra] of variants) {
      const sub = emitSubset(idx, ids, extra);
      if (!process.env.ONLY_WRAP) fs.writeFileSync(path.join(OUT, `${base}.${name}.${root}.stp`), sub);
      const res = run(sub);
      const corr = res.ok ? correlate(idx, root, res) : null;
      console.log(`  ${name.padEnd(9)} #${root} ${typeOf(idx.ents.get(root))} (${ids.size} ents, ${(sub.length / 1e3).toFixed(0)} kB): ok=${res.ok} ${res.ms.toFixed(0)}ms meshes=${res.meshes} faces=${res.faces} tris=${res.tris} bb=${fmtBB(res.bb)}` +
        (corr ? ` | stepFaces=${corr.stepFaces} faceOrderAgree=${corr.agree}/${corr.checked} scale=${corr.scale}` : ''));
      rows.push({ file: base, variant: name, root, ents: ids.size, bytes: sub.length, ...strip(res), corr });
    }
  }
}
const m1 = process.memoryUsage();
console.log(`\nfinal rss ${(m1.rss / 2 ** 20).toFixed(0)} MiB, wasm heap ${(occt.HEAP8.length / 2 ** 20).toFixed(0)} MiB`);
fs.writeFileSync('occt_results.json', JSON.stringify({ tInit, rssInit: mem0.rss, rssFinal: m1.rss, heapFinal: occt.HEAP8.length, rows }, null, 1));
function strip(r) { const { r: _, ...rest } = r; return rest; }
