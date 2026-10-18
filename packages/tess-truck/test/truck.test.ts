// Needs the built module (./build.sh) and the corpus (test_corpus/third_party/pull.sh); skipped without them. The
// comparison with OCCT also needs tess-occt built.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { TessellationRequest, TessellationResult } from 'cad-scene';
import { importStep } from 'step-import';
import { TruckTessellator, WBINDGEN_IMPORTS } from '../src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const corpus = path.join(root, 'test_corpus/third_party');
const cube = path.join(corpus, 'occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp');
const asm = path.join(corpus, 'gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
const k1 = path.join(corpus, 'gkv311-opencascade-dataset/step/trj7_k1-ct-214.stp');
const wasm = path.join(import.meta.dirname, '../dist/tess_truck.wasm');
const skip = !fs.existsSync(wasm) ? 'tess-truck not built (run packages/tess-truck/build.sh)' : !fs.existsSync(cube) ? 'corpus not fetched' : false;
const occtBuilt = fs.existsSync(path.join(root, 'packages/tess-occt/dist/occt_tess.wasm'));

async function requests(file: string, linear = 0.05, edges = true): Promise<TessellationRequest[]> {
  const { scene } = await importStep(fs.readFileSync(file));
  return scene.parts.flatMap((p) => (p.kind === 'brep' ? [{ format: p.format, data: p.payload(), rootId: p.rootId, origin: p.origin, linearDeflection: linear / p.unit, angularDeflection: 0.5, edges }] : []));
}

const area = (r: TessellationResult) => {
  const p = r.positions;
  let a = 0;
  for (let i = 0; i < r.indices.length; i += 3) {
    const [A, B, C] = [r.indices[i]!, r.indices[i + 1]!, r.indices[i + 2]!].map((k) => 3 * k);
    const u = [p[B!]! - p[A!]!, p[B! + 1]! - p[A! + 1]!, p[B! + 2]! - p[A! + 2]!], v = [p[C!]! - p[A!]!, p[C! + 1]! - p[A! + 1]!, p[C! + 2]! - p[A! + 2]!];
    a += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
  }
  return a;
};

/** Edge points that are not exactly a mesh vertex. */
function offMesh(r: TessellationResult): number {
  const verts = new Set<string>();
  for (let i = 0; i < r.positions.length; i += 3) verts.add(`${r.positions[i]},${r.positions[i + 1]},${r.positions[i + 2]}`);
  let n = 0;
  const e = r.edgePositions!;
  for (let i = 0; i < e.length; i += 3) if (!verts.has(`${e[i]},${e[i + 1]},${e[i + 2]}`)) n++;
  return n;
}

test('the module imports only the panic hook and the wasm-bindgen leftovers it has stubs for', { skip: !fs.existsSync(wasm) && 'not built' }, () => {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(fs.readFileSync(wasm))).map((i) => `${i.module}.${i.name}`).sort();
  const expected = ['env.tess_panic', ...Object.entries(WBINDGEN_IMPORTS).flatMap(([m, ns]) => ns.map((n) => `${m}.${n}`))].sort();
  assert.deepEqual(imports, expected);
});

test('a 10 mm cube: faces and edges with entity ids, normals, the origin subtracted in double precision', { skip }, async () => {
  const tess = new TruckTessellator();
  await tess.init();
  const [req] = await requests(cube, 0.01);
  const plain = await tess.tessellate({ ...req!, origin: undefined });
  assert.deepEqual(plain.diagnostics, []);
  assert.equal(plain.faces.length, 6);
  assert.ok(plain.faces.every((f) => f.entityId !== null && f.count === 6));
  assert.equal(new Set(plain.faces.map((f) => f.entityId)).size, 6);
  assert.equal(plain.positions.length, 24 * 3);
  assert.equal(plain.normals!.length, plain.positions.length);
  assert.equal(area(plain), 600);
  // Each face's normals are unit and point away from the cube's centre.
  const centre = [0, 1, 2].map((c) => { const xs = plain.positions.filter((_, i) => i % 3 === c); return (Math.min(...xs) + Math.max(...xs)) / 2; });
  for (const f of plain.faces) {
    for (let k = f.start; k < f.start + f.count; k++) {
      const v = plain.indices[k]!;
      const n = [0, 1, 2].map((c) => plain.normals![3 * v + c]!), p = [0, 1, 2].map((c) => plain.positions[3 * v + c]! - centre[c]!);
      assert.equal(Math.hypot(...n), 1);
      assert.ok(n[0]! * p[0]! + n[1]! * p[1]! + n[2]! * p[2]! > 0);
    }
  }
  assert.deepEqual(plain.edges!.map((e) => e.kind), Array(12).fill('shared'));
  assert.ok(plain.edges!.every((e) => e.entityId !== null && e.count === 2 && Math.abs(e.dihedral! - Math.PI / 2) < 1e-6));
  assert.equal(offMesh(plain), 0);
  const origin: [number, number, number] = [1e7 + 0.1, -2e7 + 0.3, 0.7];
  const shifted = await tess.tessellate({ ...req!, origin });
  assert.deepEqual(shifted.origin, origin);
  for (let i = 0; i < plain.positions.length; i++) assert.equal(shifted.positions[i], Math.fround(plain.positions[i]! - origin[i % 3]!));
  for (let i = 0; i < plain.edgePositions!.length; i++) assert.equal(shifted.edgePositions![i], Math.fround(plain.edgePositions![i]! - origin[i % 3]!));
  const noEdges = await tess.tessellate({ ...req!, edges: false });
  assert.equal(noEdges.edges, undefined);
  assert.deepEqual(noEdges.indices, plain.indices);
});

/** Per face, how many faces have most sampled triangles facing opposite to the nearest OCCT triangle of that face. */
function flippedFaces(a: TessellationResult, b: TessellationResult): number {
  const tris = (r: TessellationResult, f: TessellationResult['faces'][number]) => {
    const out: { c: number[]; n: number[] }[] = [];
    for (let k = f.start; k < f.start + f.count; k += 3) {
      const P = [0, 1, 2].map((j) => [0, 1, 2].map((c) => r.positions[3 * r.indices[k + j]! + c]!));
      const u = P[1]!.map((x, i) => x - P[0]![i]!), v = P[2]!.map((x, i) => x - P[0]![i]!);
      out.push({ c: [0, 1, 2].map((i) => (P[0]![i]! + P[1]![i]! + P[2]![i]!) / 3), n: [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!] });
    }
    return out;
  };
  const dot = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  let flipped = 0;
  for (const fb of b.faces) {
    const fa = a.faces.find((f) => f.entityId === fb.entityId);
    if (!fa) continue;
    const ta = tris(a, fa), tb = tris(b, fb);
    if (!tb.length) continue;
    let bad = 0, n = 0;
    for (let i = 0; i < ta.length; i += Math.max(1, Math.floor(ta.length / 20))) {
      const t = ta[i]!;
      let best = tb[0]!, bd = Infinity;
      for (const q of tb) { const d = (q.c[0]! - t.c[0]!) ** 2 + (q.c[1]! - t.c[1]!) ** 2 + (q.c[2]! - t.c[2]!) ** 2; if (d < bd) { bd = d; best = q; } }
      n++;
      if (dot(t.n, best.n) < 0) bad++;
    }
    if (bad > n / 2) flipped++;
  }
  return flipped;
}

/** Triangles whose vertex normals point away from the triangle's own (winding) normal. */
function windingMismatches(r: TessellationResult): number {
  let n = 0;
  for (let k = 0; k < r.indices.length; k += 3) {
    const P = [0, 1, 2].map((j) => [0, 1, 2].map((c) => r.positions[3 * r.indices[k + j]! + c]!));
    const u = P[1]!.map((x, i) => x - P[0]![i]!), v = P[2]!.map((x, i) => x - P[0]![i]!);
    const g = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const s = [0, 1, 2].reduce((acc, j) => acc + [0, 1, 2].reduce((d, c) => d + g[c]! * r.normals![3 * r.indices[k + j]! + c]!, 0), 0);
    if (s < 0) n++;
  }
  return n;
}

const gkv = (f: string) => path.join(corpus, 'gkv311-opencascade-dataset/step', f);
// An assembly; a solid with two voids (oriented shells); seams; an open shell beside a curve set; a cone.
const fixtures = [asm, gkv('tr9_bv1-tc.stp'), gkv('trj9_io1-oc-214.stp'), gkv('trj7_c2-ug-214.stp'), path.join(corpus, 'occt-import-js/test/testfiles/conical-surface/conical-surface.step')];

test('against OCCT: face and edge ids, edge kinds, face orientation, area, edge points on the mesh', { skip: skip || (!occtBuilt && 'tess-occt not built') || (!fixtures.every((f) => fs.existsSync(f)) && 'corpus files missing') }, async () => {
  const { OcctTessellator } = await import('tess-occt');
  const truck = new TruckTessellator();
  const occt = new OcctTessellator();
  await truck.init();
  await occt.init();
  const seen = new Set<string>();
  for (const file of fixtures) {
    for (const req of await requests(file)) {
      const a = await truck.tessellate(req), b = await occt.tessellate(req);
      const where = `${path.basename(file)} #${req.rootId}`;
      assert.deepEqual(a.diagnostics.filter((d) => !d.message.startsWith("representation items truck doesn't mesh: GEOMETRIC_CURVE_SET")), [], where);
      assert.deepEqual(a.faces.map((f) => f.entityId).sort(), b.faces.map((f) => f.entityId).sort(), where);
      const kinds = (r: TessellationResult) => r.edges!.filter((e) => e.entityId !== null).map((e) => `${e.entityId}:${e.kind}`).sort();
      assert.deepEqual(kinds(a), kinds(b), where);
      for (const e of a.edges!) seen.add(e.kind);
      assert.equal(flippedFaces(a, b), 0, where);
      assert.equal(windingMismatches(a), 0, where);
      // truck's known cone trouble (phase 0): the cone file comes out too large.
      const ratio = area(a) / area(b);
      if (file.includes('conical')) assert.ok(ratio > 1.3 && ratio < 1.4, `${where}: area ratio ${ratio}`);
      else assert.ok(Math.abs(ratio - 1) < 0.005, `${where}: area ratio ${ratio}`);
      assert.equal(offMesh(a), 0, where);
    }
  }
  assert.deepEqual([...seen].sort(), ['free', 'seam', 'shared']);
});

test("an ORIENTED_FACE reports its face's id, with the face reversed", { skip }, async () => {
  const tess = new TruckTessellator();
  await tess.init();
  const [req] = await requests(cube, 0.01);
  const plain = await tess.tessellate(req!);
  const text = new TextDecoder().decode(req!.data);
  const shell = /CLOSED_SHELL\('[^']*',\(#(\d+)/.exec(text)!;
  const face = Number(shell[1]);
  const wrapped = text.replace(shell[0], shell[0].replace(`#${face}`, '#999990')).replace(/ENDSEC;(\s*END-ISO)/, `#999990=ORIENTED_FACE('',*,#${face},.F.);\nENDSEC;$1`);
  const r = await tess.tessellate({ ...req!, data: new TextEncoder().encode(wrapped) });
  assert.deepEqual(r.faces.map((f) => f.entityId), plain.faces.map((f) => f.entityId));
  const normal = (t: TessellationResult) => { const f = t.faces.find((x) => x.entityId === face)!; const v = t.indices[f.start]!; return [0, 1, 2].map((c) => t.normals![3 * v + c]!); };
  assert.deepEqual(normal(r), normal(plain).map((x) => -x));
  assert.equal(windingMismatches(r), 0);
});

test('entity ids above 2^31 - 1 come back as null', { skip }, async () => {
  const tess = new TruckTessellator();
  await tess.init();
  const [req] = await requests(cube, 0.01);
  const big = new TextDecoder().decode(req!.data).replace(/#(\d+)/g, (_, n) => `#${Number(n) + 3e9}`);
  const r = await tess.tessellate({ ...req!, rootId: req!.rootId! + 3e9, data: new TextEncoder().encode(big) });
  assert.equal(r.faces.length, 6);
  assert.ok(r.faces.every((f) => f.entityId === null) && r.edges!.every((e) => e.entityId === null));
});

const stc07 = path.join(corpus, 'nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files/nist_stc_07_asme1_ap242-e3.stp');

test('faces truck fails to mesh are left out and reported', { skip: skip || (!fs.existsSync(stc07) && 'corpus file missing') }, async () => {
  const tess = new TruckTessellator();
  await tess.init();
  const req = (await requests(stc07)).find((r) => r.rootId === 11020)!;
  const r = await tess.tessellate(req);
  assert.equal(r.faces.length, 288);
  assert.deepEqual(r.diagnostics.map((d) => d.message.replace(/:.*/s, '')), ['16 faces failed to mesh', '72 AXIS2_PLACEMENT_3Ds along x without a ref_direction given the standard\'s default (0, 1, 0), which truck lacks']);
  assert.ok(!r.faces.some((f) => f.entityId === 2277));
  assert.match(r.diagnostics[0]!.message, /#2277, #2288,/);
});

const k1Skip = skip || (!fs.existsSync(k1) && 'corpus file missing');

test('placements along x without a ref_direction get the standard default instead of panicking', { skip: k1Skip }, async () => {
  const tess = new TruckTessellator();
  await tess.init();
  const req = (await requests(k1)).find((r) => r.rootId === 1926)!;
  const r = await tess.tessellate(req);
  assert.equal(r.faces.length, 58);
  assert.deepEqual(r.diagnostics.map((d) => d.severity), ['info']);
  assert.match(r.diagnostics[0]!.message, /^26 AXIS2_PLACEMENT_3Ds along x/);
});

test('a panic returns an error diagnostic, and the next request runs on a fresh instance', { skip: k1Skip }, async () => {
  const tess = new TruckTessellator();
  await tess.init();
  const req = (await requests(k1)).find((r) => r.rootId === 1926)!;
  // Spell the bad default out (ref_direction = axis), which the workaround leaves alone: truck panics.
  const text = new TextDecoder().decode(req.data).replace(/(AXIS2_PLACEMENT_3D\('[^']*',#\d+,)(#\d+),\$\)/g, '$1$2,$2)');
  const bad = await tess.tessellate({ ...req, data: new TextEncoder().encode(text) });
  assert.equal(bad.indices.length, 0);
  assert.equal(bad.diagnostics.length, 1);
  assert.match(bad.diagnostics[0]!.message, /^truck panicked: panicked at .*circle\.rs:\d+:\d+:\ntolerance must be no less than 1e-6$/s);
  // The instance was replaced: its memory is back to a fresh instance's, although meshing had grown it.
  const fresh = new TruckTessellator();
  await fresh.init();
  assert.equal(tess.memoryBytes(), fresh.memoryBytes());
  const good = await tess.tessellate(req);
  assert.equal(good.faces.length, 58);
  assert.ok(tess.memoryBytes() > fresh.memoryBytes());
});

test('unreadable input and a missing root give error diagnostics', { skip }, async () => {
  const tess = new TruckTessellator();
  await tess.init();
  const junk = await tess.tessellate({ format: 'step', data: new TextEncoder().encode('not a STEP file'), rootId: 1, linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.equal(junk.indices.length, 0);
  assert.match(junk.diagnostics[0]!.message, /^truck: STEP parse error/);
  const [req] = await requests(cube);
  const missing = await tess.tessellate({ ...req!, rootId: 999999 });
  assert.deepEqual(missing.diagnostics.map((d) => d.message), ['truck: root #999999 not in the payload']);
  await assert.rejects(tess.tessellate({ ...req!, format: 'iges' }), /format 'iges' isn't supported/);
});

test('in the worker pool, results equal the direct ones', { skip }, async () => {
  const { WorkerTessellator } = await import('tess-workers');
  const direct = new TruckTessellator();
  await direct.init();
  const pool = new WorkerTessellator({ backend: { module: import.meta.resolve('tess-truck'), export: 'TruckTessellator' }, workers: 2 });
  await pool.init();
  try {
    assert.deepEqual(pool.info, direct.info);
    const reqs = await requests(fs.existsSync(asm) ? asm : cube);
    const got = await Promise.all(reqs.map((r) => pool.tessellate(r)));
    for (const [i, r] of reqs.entries()) assert.deepEqual(got[i], await direct.tessellate(r));
  } finally {
    pool.dispose();
  }
});
