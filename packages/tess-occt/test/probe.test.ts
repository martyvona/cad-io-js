// The OCCT probe (native/occt_probe.cpp, built by build-probe.sh; skipped unbuilt) on the corpus's 10 mm cube: its
// faces' boxes and edges' ranges by STEP id, and OCCT's points at parameters within them on the cube's planes and
// lines, read without shape processing; a box's model built by the native builder, unhealed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openBrep } from 'cad-brep';
import { buildSubset, parseStep } from 'step-parser';

const root = path.resolve(import.meta.dirname, '../../..');
const cube = path.join(root, 'test_corpus/third_party/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp');
const probePath = path.join(import.meta.dirname, '../dist/occt_probe.mjs');
const skip = !fs.existsSync(probePath) ? 'the probe not built (build-probe.sh)' : !fs.existsSync(cube)
  ? 'corpus not fetched' : false;

interface Probe { HEAPU8: Uint8Array; HEAPF64: Float64Array; _malloc(n: number): number; _free(p: number): void;
  _occt_probe_read(p: number, n: number, root: number): number; _occt_probe_faces(): number;
  _occt_probe_num_faces(): number; _occt_probe_edges(): number; _occt_probe_num_edges(): number;
  _occt_probe_eval(q: number, n: number, out: number): void; _occt_probe_build(p: number, n: number): number;
  _occt_probe_diag(): number; UTF8ToString(p: number): string }

test('the probe: faces and edges by id, their boxes and ranges, OCCT\'s points on them', { skip }, async () => {
  const m = await ((await import(probePath)) as { default: () => Promise<Probe> }).default();
  const file = parseStep(new Uint8Array(fs.readFileSync(cube)));
  // The cube's one shape representation, as a bare subset.
  const rep = [...Array(file.count).keys()].find((p) =>
    file.index.typeName(p) === 'ADVANCED_BREP_SHAPE_REPRESENTATION')!;
  const repId = file.index.ids[rep]!;
  const bytes = buildSubset(file, [rep]).bytes;
  const ptr = m._malloc(bytes.length);
  m.HEAPU8.set(bytes, ptr);
  assert.equal(m._occt_probe_read(ptr, bytes.length, repId), 0);
  m._free(ptr);
  const faces = Array.from(m.HEAPF64.subarray(m._occt_probe_faces() >> 3,
    (m._occt_probe_faces() >> 3) + 5 * m._occt_probe_num_faces()));
  const edges = Array.from(m.HEAPF64.subarray(m._occt_probe_edges() >> 3,
    (m._occt_probe_edges() >> 3) + 3 * m._occt_probe_num_edges()));
  assert.equal(faces.length / 5, 6);
  assert.equal(edges.length / 3, 12);
  // Each face's id an ADVANCED_FACE's, each edge's an EDGE_CURVE's.
  const typeOf = (id: number) => file.index.typeName(file.index.position(id));
  for (let k = 0; k < faces.length; k += 5) assert.equal(typeOf(faces[k]!), 'ADVANCED_FACE');
  for (let k = 0; k < edges.length; k += 3) assert.equal(typeOf(edges[k]!), 'EDGE_CURVE');
  // OCCT's points (the cube spans x and z -5 to 5, y 0 to 10): at each face's box's corners and centre, on one of its
  // planes (a coordinate at its low or high end, the others within); at each edge's range's ends, corners, and its
  // middle, an edge's midpoint (one coordinate at its middle, the others at an end).
  const qs: number[] = [];
  for (let k = 0; k < faces.length; k += 5) {
    const [id, u0, u1, v0, v1] = faces.slice(k, k + 5) as number[];
    for (const [u, v] of [[u0, v0], [u1, v1], [(u0! + u1!) / 2, (v0! + v1!) / 2]]) qs.push(0, id!, u!, v!);
  }
  for (let k = 0; k < edges.length; k += 3) {
    const [id, t0, t1] = edges.slice(k, k + 3) as number[];
    for (const t of [t0!, t1!, (t0! + t1!) / 2]) qs.push(1, id!, t, 0);
  }
  const n = qs.length / 4, q = m._malloc(qs.length * 8), o = m._malloc(n * 24);
  m.HEAPF64.set(qs, q >> 3);
  m._occt_probe_eval(q, n, o);
  const pts = Array.from(m.HEAPF64.subarray(o >> 3, (o >> 3) + 3 * n));
  m._free(q);
  m._free(o);
  const lo = [-5, 0, -5], hi = [5, 10, 5];
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  const end = (c: number, i: number) => near(c, lo[i]!) || near(c, hi[i]!);
  for (let k = 0; k < n; k++) {
    const p = pts.slice(3 * k, 3 * k + 3);
    assert.ok(p.every((c, i) => c >= lo[i]! - 1e-9 && c <= hi[i]! + 1e-9), `point ${k} in the cube: ${p}`);
    if (qs[4 * k] === 0) assert.ok(p.some(end), `point ${k} on a face: ${p}`);
    else if (k % 3 === 2) {
      assert.equal(p.filter((c, i) => near(c, (lo[i]! + hi[i]!) / 2)).length, 1, `point ${k} an edge's middle: ${p}`);
      assert.equal(p.filter(end).length, 2, `point ${k} an edge's middle: ${p}`);
    } else assert.ok(p.every(end), `point ${k} a corner: ${p}`);
  }
  // An id it didn't read: NaN.
  const q2 = m._malloc(32), o2 = m._malloc(24);
  m.HEAPF64.set([0, 999999, 0, 0], q2 >> 3);
  m._occt_probe_eval(q2, 1, o2);
  assert.ok(Number.isNaN(m.HEAPF64[o2 >> 3]!));
});

test('the probe on a box 1 x 2 x 3: each face\'s box corners its corners (u and v not swapped on unequal sides)',
  { skip }, async () => {
    const { BrepBuilder } = await import('cad-brep');
    const { box } = await import('../../cad-brep/test/models.ts');
    const { stepPartBytes } = await import('step-export');
    const b = new BrepBuilder();
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 2, 3]), sense: true }] }) });
    const w = stepPartBytes(b.finish());
    const m = await ((await import(probePath)) as { default: () => Promise<Probe> }).default();
    const ptr = m._malloc(w.data.length);
    m.HEAPU8.set(w.data, ptr);
    assert.equal(m._occt_probe_read(ptr, w.data.length, w.rootId), 0);
    m._free(ptr);
    const faces = Array.from(m.HEAPF64.subarray(m._occt_probe_faces() >> 3,
      (m._occt_probe_faces() >> 3) + 5 * m._occt_probe_num_faces()));
    assert.equal(faces.length / 5, 6);
    const qs: number[] = [];
    for (let k = 0; k < faces.length; k += 5) {
      const [id, u0, u1, v0, v1] = faces.slice(k, k + 5) as number[];
      for (const [u, v] of [[u0, v0], [u1, v0], [u0, v1], [u1, v1]]) qs.push(0, id!, u!, v!);
    }
    const n = qs.length / 4, q = m._malloc(qs.length * 8), o = m._malloc(n * 24);
    m.HEAPF64.set(qs, q >> 3);
    m._occt_probe_eval(q, n, o);
    const pts = Array.from(m.HEAPF64.subarray(o >> 3, (o >> 3) + 3 * n));
    m._free(q);
    m._free(o);
    // Every box corner a corner of the box (each coordinate 0 or its side), the four of a face distinct.
    const hi = [1, 2, 3];
    for (let f = 0; f < 6; f++) {
      const corners = new Set<string>();
      for (let c = 0; c < 4; c++) {
        const p = pts.slice(3 * (4 * f + c), 3 * (4 * f + c) + 3);
        assert.ok(p.every((x, i) => Math.abs(x) < 1e-9 || Math.abs(x - hi[i]!) < 1e-9), `face ${f} corner ${c}: ${p}`);
        corners.add(p.map((x) => x.toFixed(6)).join());
      }
      assert.equal(corners.size, 4, `face ${f}'s corners`);
    }
  });

test('the probe on a box\'s model and a curve item built natively: its faces and edges by the model\'s ids, the '
  + 'read\'s points at the read\'s parameters; a part the builder can\'t build fails with its reason', { skip }, async () => {
  const { BrepBuilder } = await import('cad-brep');
  const { box } = await import('../../cad-brep/test/models.ts');
  const { stepPartBytes } = await import('step-export');
  const b = new BrepBuilder();
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 2, 3]), sense: true }] }) });
  // And a curve item (a wireframe's; the item and its curve one STEP entity): read and built as an edge with its id.
  b.addItem({ kind: 'curve', ref: b.addCurve({ kind: 'line', point: [0, 0, 5], direction: [1, 0, 0], magnitude: 1,
    id: 7 }), id: 7 });
  const model = b.finish();
  const m = await ((await import(probePath)) as { default: () => Promise<Probe> }).default();
  const load = (bytes: Uint8Array, root?: number) => {
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);
    const rc = root === undefined ? m._occt_probe_build(ptr, bytes.length)
      : m._occt_probe_read(ptr, bytes.length, root);
    m._free(ptr);
    const at = (p: number, k: number, n: number) => Array.from(m.HEAPF64.subarray(p >> 3, (p >> 3) + k * n));
    return { rc, diag: m.UTF8ToString(m._occt_probe_diag()),
      faces: at(m._occt_probe_faces(), 5, m._occt_probe_num_faces()),
      edges: at(m._occt_probe_edges(), 3, m._occt_probe_num_edges()) };
  };
  const evalAt = (qs: number[]) => {
    const n = qs.length / 4, q = m._malloc(qs.length * 8), o = m._malloc(n * 24);
    m.HEAPF64.set(qs, q >> 3);
    m._occt_probe_eval(q, n, o);
    const pts = Array.from(m.HEAPF64.subarray(o >> 3, (o >> 3) + 3 * n));
    m._free(q);
    m._free(o);
    return pts;
  };
  const w = stepPartBytes(model);
  const read = load(w.data, w.rootId);
  assert.equal(read.rc, 0);
  const qs: number[] = [];
  for (let k = 0; k < read.faces.length; k += 5) {
    const [id, u0, u1, v0, v1] = read.faces.slice(k, k + 5) as number[];
    for (const [u, v] of [[u0, v0], [u1, v0], [u0, v1], [u1, v1]]) qs.push(0, id!, u!, v!);
  }
  for (let k = 0; k < read.edges.length; k += 3) {
    const [id, t0, t1] = read.edges.slice(k, k + 3) as number[];
    for (const t of [t0!, t1!]) qs.push(1, id!, t, 0);
  }
  const fromRead = evalAt(qs);
  const built = load(new Uint8Array(model.buffer));
  assert.equal(built.rc, 0, built.diag);
  const ids = (xs: number[], k: number) => xs.filter((_, i) => i % k === 0).sort((x, y) => x - y);
  const model_ = openBrep(new Uint8Array(model.buffer));
  assert.deepEqual(ids(built.faces, 5), [...model_.face.id].sort((x, y) => x - y));
  const lineId = 7;
  assert.deepEqual(ids(built.edges, 3), [...model_.edge.id, lineId].sort((x, y) => x - y));
  assert.deepEqual(ids(read.edges, 3), ids(built.edges, 3));
  // At the read's parameters, the read's points (each a corner of the box, or on the line at z 5) and the same from
  // the built shape: the same geometry and parameterization.
  const pts = evalAt(qs), hi = [1, 2, 3];
  assert.equal(pts.length, qs.length / 4 * 3);
  for (let k = 0; k < pts.length; k += 3) {
    const p = fromRead.slice(k, k + 3);
    if (qs[(k / 3) * 4 + 1] === lineId) assert.ok(Math.abs(p[1]!) < 1e-12 && Math.abs(p[2]! - 5) < 1e-12, `${p}`);
    else assert.ok(p.every((x, i) => Math.abs(x) < 1e-9 || Math.abs(x - hi[i]!) < 1e-9), `point ${k / 3}: ${p}`);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(pts[k + i]! - p[i]!) < 1e-12, `point ${k / 3}: ${pts.slice(k, k + 3)}`);
    }
  }
  // A kind the builder doesn't build: a composite curve as an edge's curve.
  const c = new BrepBuilder();
  const v0 = c.addVertex({ point: [0, 0, 0] }), v1 = c.addVertex({ point: [1, 0, 0] });
  const line = c.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  const half = (t1: number, t2: number) => ({ curve: c.addCurve({ kind: 'trimmed', basis: line,
    trim1: { parameter: t1 }, trim2: { parameter: t2 }, sense: true, preference: 'parameter' }), sameSense: true,
  transition: 'continuous' as const });
  const comp = c.addCurve({ kind: 'composite', segments: [half(0, 0.5), half(0.5, 1)], selfIntersect: false });
  const edge = c.addEdge({ curve: comp, start: v0, end: v1, sameSense: true });
  c.addItem({ kind: 'body', ref: c.addBody({ kind: 'wire', members: [{ ref: edge, sense: true }] }) });
  const failed = load(new Uint8Array(c.finish().buffer));
  assert.equal(failed.rc, -1);
  assert.match(failed.diag, /composite/);
});
