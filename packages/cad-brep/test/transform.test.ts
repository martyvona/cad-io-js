// The builder's baking of transforms and instances (docs/brep-reference.md), checked through the evaluators, not
// transform.ts's per-kind rules: every baked curve at t is T of the original at t, every surface point T of one on the
// original, every p-curve through its surface T of the original's, every face's normal Q times the original's, every
// coedge's side of its face the same; ids kept where a row is drawn once, fresh with a table of copies where several
// draws reach it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder } from '../src/builder.ts';
import type { BrepData } from '../src/data.ts';
import { rowCount } from '../src/data.ts';
import * as dec from '../src/decode.ts';
import { curveEvaluator, nearestParams, normalAt, surfaceEvaluator } from '../src/geometry.ts';
import { ITEM_KIND } from '../src/layout.ts';
import { curve2 } from '../src/transform.ts';
import { transformBrep } from '../src/bake.ts';

const copiesOf = (d: BrepData) => Array.from({ length: rowCount(d, 'copy') }, (_, k) => dec.copy(d, k));
import type { Curve, Item, Surface, Transform } from '../src/types.ts';
import { box, cube, everyKind, facetedAndWire, reversedUses, seamCylinder, spheres, withVoid } from './models.ts';

type V = number[];
const rot = (a: number, ax: 0 | 1 | 2): V => {
  const c = Math.cos(a), s = Math.sin(a), [i, j] = [[1, 2], [2, 0], [0, 1]][ax]!;
  const m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  m[3 * i! + i!] = c; m[3 * j! + j!] = c; m[3 * i! + j!] = s; m[3 * j! + i!] = -s;
  return m;
};
const mul = (A: V, B: V): V => Array.from({ length: 9 }, (_, k) => {
  const i = k % 3, j = (k - i) / 3;
  return A[i]! * B[3 * j]! + A[3 + i]! * B[3 * j + 1]! + A[6 + i]! * B[3 * j + 2]!;
});
const MIRROR = [1, 0, 0, 0, -1, 0, 0, 0, 1];
/** The transforms: a mirror, a rotation with an even scale and a move, and all of them. */
const TRANSFORMS: [string, Transform][] = [
  ['mirror', [...MIRROR, 0, 0, 0]],
  ['rotation, scale, move', [...mul(rot(0.7, 2), rot(-0.4, 0)).map((x) => 2.5 * x), 30, -12, 7]],
  ['mirror, rotation, scale', [...mul(rot(1.1, 0), mul(MIRROR, rot(0.3, 1))).map((x) => 0.3 * x), -5, 4, 100]],
];
const apply = (t: Transform, p: V) => [0, 1, 2].map((i) => t[i]! * p[0]! + t[3 + i]! * p[1]! + t[6 + i]! * p[2]!
  + t[9 + i]!);
const linear = (t: Transform, p: V) => [0, 1, 2].map((i) => t[i]! * p[0]! + t[3 + i]! * p[1]! + t[6 + i]! * p[2]!);
const cross = (a: V, b: V) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!];
const unit = (a: V) => { const n = Math.hypot(...a); return a.map((x) => x / n); };
const near = (a: V, b: V, tol: number) => a.every((x, i) => Math.abs(x - b[i]!) <= tol);

/** The model's rows added to `b` again, each with an id of its own (so the baked rows can be found by id), its items
 * at `transform`. */
function retagged(d: BrepData, b: BrepBuilder, transform?: Transform): BrepData {
  let id = 1;
  const tag = <T extends object>(x: T): T => ({ ...x, id: id++ });
  for (let k = 0; k < rowCount(d, 'curve'); k++) b.addCurve(tag(dec.curve(d, k)));
  for (let k = 0; k < rowCount(d, 'surface'); k++) b.addSurface(tag(dec.surface(d, k)));
  for (let k = 0; k < rowCount(d, 'vertex'); k++) b.addVertex(tag(dec.vertex(d, k)));
  for (let k = 0; k < rowCount(d, 'edge'); k++) b.addEdge(tag(dec.edge(d, k)));
  for (let k = 0; k < rowCount(d, 'face'); k++) {
    const f = dec.face(d, k);
    b.addFace(tag({ ...f, loops: f.loops.map((l) => l.kind === 'edge' ? tag({ ...l, coedges: l.coedges.map(tag) })
      : tag(l)) }));
  }
  for (let k = 0; k < rowCount(d, 'shell'); k++) b.addShell(tag(dec.shell(d, k)));
  for (let k = 0; k < rowCount(d, 'body'); k++) b.addBody(tag(dec.body(d, k)));
  for (let k = 0; k < rowCount(d, 'item'); k++) {
    b.addItem({ ...dec.item(d, k), id: id++, ...(transform ? { transform } : {}) } as Item);
  }
  return b.finish();
}

/** Rows by id (the first of each; a 2D curve split per map has several). */
function byId(d: BrepData, table: 'curve' | 'surface' | 'vertex' | 'edge' | 'face' | 'coedge'): Map<number, number[]> {
  const m = new Map<number, number[]>();
  const ids = d[table].id;
  for (let k = 0; k < rowCount(d, table); k++) m.set(ids[k]!, [...(m.get(ids[k]!) ?? []), k]);
  return m;
}

/** Samples of a range, infinite ends clamped. */
const samples = (r: [number, number]) => {
  const a = Number.isFinite(r[0]) ? r[0] : -2, b = Number.isFinite(r[1]) ? r[1] : 2;
  return [0.13, 0.5, 0.81].map((x) => a + x * (b - a));
};

/** A coedge's direction of travel: its edge's curve's derivative, signed by its uses. */
function travel(d: BrepData, loop: number, co: number, t: number): V | undefined {
  const e = d.coedge.edge[co]!, c = d.edge.curve[e]!;
  if (c < 0) return undefined;
  const sign = (d.edge.sameSense[e] ? 1 : -1) * (d.coedge.orientation[co] === 0 ? 1 : -1)
    * (d.loop.sense[loop] ? 1 : -1);
  return curveEvaluator(d, c)!.d1(t).map((x) => x * sign);
}

/** Checks a baked model against its original, through the evaluators; the number of identities checked. */
function checkBaked(a: BrepData, b: BrepData, t: Transform, where: string): number {
  const s = Math.hypot(t[0]!, t[1]!, t[2]!), tol = 1e-9 * Math.max(1, s) * 1e3;
  let n = 0;
  const bc = byId(b, 'curve'), bs = byId(b, 'surface'), bv = byId(b, 'vertex'), bf = byId(b, 'face');
  const bco = byId(b, 'coedge');
  const be = byId(b, 'edge');
  const tolerances = (x: Float64Array, y: Float64Array, ra: number, rb: number, what: string) => {
    if (Number.isNaN(x[ra]!)) assert.ok(Number.isNaN(y[rb]!), what);
    else assert.ok(Math.abs(x[ra]! * s - y[rb]!) <= 1e-12 * s * x[ra]!, `${what}: ${y[rb]} for ${x[ra]! * s}`);
  };
  assert.ok(Object.is(a.part.uncertainty[0], b.part.uncertainty[0]) || a.part.uncertainty[0] === b.part.uncertainty[0],
    `${where}: the uncertainty`);
  for (let k = 0; k < rowCount(a, 'edge'); k++) {
    const r = be.get(a.edge.id[k]!)?.[0];
    if (r !== undefined) tolerances(a.edge.tolerance, b.edge.tolerance, k, r, `${where}: edge ${k}'s tolerance`);
  }
  for (let k = 0; k < rowCount(a, 'face'); k++) {
    const r = bf.get(a.face.id[k]!)?.[0];
    if (r !== undefined) tolerances(a.face.tolerance, b.face.tolerance, k, r, `${where}: face ${k}'s tolerance`);
  }
  for (let k = 0; k < rowCount(a, 'vertex'); k++) {
    const r = bv.get(a.vertex.id[k]!)?.[0];
    if (r === undefined) continue;
    tolerances(a.vertex.tolerance, b.vertex.tolerance, k, r, `${where}: vertex ${k}'s tolerance`);
    assert.ok(near(apply(t, [...a.vertex.point.subarray(3 * k, 3 * k + 3)]), [...b.vertex.point.subarray(3 * r,
      3 * r + 3)], tol), `${where}: vertex ${k}`);
    n++;
  }
  // 3D curves: the same parameter, T of the point.
  for (let k = 0; k < rowCount(a, 'curve'); k++) {
    if (a.curve.dim[k] !== 3) continue;
    const r = bc.get(a.curve.id[k]!)?.[0];
    const ca = curveEvaluator(a, k);
    if (r === undefined || !ca) continue;
    const cb = curveEvaluator(b, r)!;
    for (const x of samples(ca.range)) {
      assert.ok(near(apply(t, ca.point(x)), cb.point(x), tol),
        `${where}: curve ${k} (${dec.curve(a, k).kind}) at ${x}`);
      n++;
    }
  }
  // Surfaces: T of a point on the original lies on the baked one (by its closed-form parameters, else at the same).
  for (let k = 0; k < rowCount(a, 'surface'); k++) {
    const r = bs.get(a.surface.id[k]!)?.[0];
    const sa = surfaceEvaluator(a, k);
    if (r === undefined || !sa) continue;
    const sb = surfaceEvaluator(b, r)!;
    for (const u of samples(sa.u)) {
      for (const v of samples(sa.v)) {
        // (No closed form, an offset's say: the nearest point, in a window holding every sample's image.)
        const q = apply(t, sa.point(u, v)), w = (r: [number, number]): [number, number] =>
          [Math.max(r[0], -20), Math.min(r[1], 20)];
        const on = (uv: [number, number] | undefined) => !!uv && near(sb.point(uv[0], uv[1]), q, tol);
        assert.ok(on(sb.params?.(q)) || on([u, v]) || on(nearestParams({ ...sb, u: w(sb.u), v: w(sb.v) }, q)),
          `${where}: surface ${k} (${dec.surface(a, k).kind}) at ${u}, ${v}`);
        n++;
      }
    }
  }
  // Faces: through each p-curve, the point T of the original's, the face's normal Q times it, the coedge's left
  // (into the face) the same.
  for (let f = 0; f < rowCount(a, 'face'); f++) {
    const g = bf.get(a.face.id[f]!)?.[0];
    if (g === undefined) continue;
    const sa = surfaceEvaluator(a, a.face.surface[f]!), sb = surfaceEvaluator(b, b.face.surface[g]!);
    if (!sa || !sb) continue;
    const na = a.face.sameSense[f] ? 1 : -1, nb = b.face.sameSense[g] ? 1 : -1;
    for (let l = a.face.firstLoop[f]!; l < a.face.firstLoop[f]! + a.face.loopCount[f]!; l++) {
      if (a.loop.kind[l] !== 1) continue;
      for (let co = a.loop.first[l]!; co < a.loop.first[l]! + a.loop.count[l]!; co++) {
        const cob = bco.get(a.coedge.id[co]!)?.[0];
        const pa = a.coedge.pcurve[co]!;
        if (cob === undefined || pa < 0) continue;
        const pb = b.coedge.pcurve[cob]!;
        if (pb < 0) continue;
        const lb = b.face.firstLoop[g]! + (l - a.face.firstLoop[f]!);
        const ea = curveEvaluator(a, pa)!, eb = curveEvaluator(b, pb)!;
        for (const x of samples(ea.range)) {
          const [u, v] = ea.point(x) as [number, number], [u2, v2] = eb.point(x) as [number, number];
          assert.ok(near(apply(t, sa.point(u, v)), sb.point(u2, v2), tol), `${where}: face ${f}'s p-curve at ${x}`);
          const n0 = normalAt(sa, u, v), n1 = normalAt(sb, u2, v2);
          if (!n0 || !n1) continue;
          const want = unit(linear(t, n0.map((y) => y * na))), got = unit(n1.map((y) => y * nb));
          assert.ok(near(want, got, 1e-5), `${where}: face ${f}'s normal at ${x}: ${got} for ${want}`);
          const ta = travel(a, l, co, x), tb = travel(b, lb, cob, x);
          if (ta && tb && Math.hypot(...cross(n0, ta)) > 1e-9) {
            const left0 = unit(linear(t, cross(n0.map((y) => y * na), ta))), left1 = unit(cross(got, tb));
            assert.ok(near(left0, left1, 1e-5), `${where}: face ${f}'s side of coedge ${co} at ${x}`);
          }
          n += 2;
        }
      }
    }
  }
  return n;
}

/** A face on each surface kind, each loop one coedge on a line edge with a p-curve of each 2D kind that bakes. */
function facesOnEveryKind(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const P = { origin: [1, 2, 3], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const line3 = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  const prof = b.addCurve({ kind: 'circle', position: { origin: [3, 0, 0], axis: [0, 1, 0], xDir: [1, 0, 0] },
    radius: 1 });
  const surfaces: Surface[] = [
    { kind: 'plane', position: P }, { kind: 'cylinder', position: P, radius: 2 },
    { kind: 'cone', position: P, radius: 1, semiAngle: 0.4 }, { kind: 'sphere', position: P, radius: 3 },
    { kind: 'torus', position: P, majorRadius: 5, minorRadius: 1 },
    { kind: 'bspline', uDegree: 1, vDegree: 2, uKnots: [0, 1], vKnots: [0, 1], uMultiplicities: [2, 2],
      vMultiplicities: [3, 3], poles: [[[0, 0, 0], [0, 1, 1], [0, 2, 0]], [[1, 0, 0], [1, 1, 1], [1, 2, 0]]],
      uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' },
    { kind: 'extrusion', curve: prof, direction: [0, 0, 1], magnitude: 2 },
    { kind: 'revolution', curve: prof, axisOrigin: [0, 0, 0], axisDirection: [0, 0, 1] },
  ];
  const rows = surfaces.map((s) => b.addSurface(s));
  rows.push(b.addSurface({ kind: 'offset', basis: rows[1]!, distance: 0.5, selfIntersect: false }));
  rows.push(b.addSurface({ kind: 'offset', basis: rows[5]!, distance: 0.25, selfIntersect: false }));
  rows.push(b.addSurface({ kind: 'rectangularTrimmed', basis: rows[2]!, u1: 0, u2: 2, v1: -1, v2: 1, uSense: true,
    vSense: true }));
  const p2: Curve[] = [
    { kind: 'line', point: [0.1, 0.2], direction: [0.6, 0.8], magnitude: 0.5 },
    { kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3], poles: [[0.1, 0.1], [0.5, 0.9], [0.9, 0.2]],
      closed: false, selfIntersect: false, form: 'unspecified' },
    { kind: 'polyline', points: [[0.2, 0.3], [0.4, 0.1], [0.8, 0.6]] },
  ];
  // A 2D offset (of the line): kept where the map is uniform, its side turned where the map reflects.
  const offsetBasis = b.addCurve(p2[0]!);
  p2.push({ kind: 'offset', basis: offsetBasis, distance: 0.05, selfIntersect: false });
  const e = b.addEdge({ curve: line3, start: b.addVertex({ point: [0, 0, 0], tolerance: 1e-4 }),
    end: b.addVertex({ point: [1, 0, 0] }), sameSense: true, range: [0, 1], tolerance: 2e-4 });
  let id = 1;
  for (const s of rows) {
    for (const c of p2) {
      const pc = b.addCurve(c);
      const f = b.addFace({ surface: s, sameSense: id % 2 === 0, tolerance: 3e-4 * id, loops: [{ kind: 'edge',
        bound: 'outer', sense: id % 3 !== 0, coedges: [{ edge: e, orientation: id % 4 === 0 ? 'reversed' : 'forward',
          pcurve: pc }] }] });
      b.addItem({ kind: 'face', ref: f });
      id++;
    }
  }
  // On the plane, the kinds only a uniform map keeps: a circle and an offset.
  for (const c of [{ kind: 'circle', position: { origin: [0.5, 0.5], xDir: [0.6, 0.8] }, radius: 0.3 },
    { kind: 'offset', basis: b.addCurve(p2[1]!), distance: 0.05, selfIntersect: false }] as Curve[]) {
    const f = b.addFace({ surface: rows[0]!, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: e, orientation: 'forward', pcurve: b.addCurve(c) }] }] });
    b.addItem({ kind: 'face', ref: f });
  }
  return b;
}

const MODELS: [string, () => BrepBuilder][] = [['faces on every kind', facesOnEveryKind], ['every kind', everyKind],
  ['cube', cube], ['void', withVoid], ['seam', seamCylinder], ['spheres', spheres],
  ['faceted and wire', facetedAndWire],
  ['reversed uses', reversedUses]];

test('a baked transform is T of the original: points, curves, surfaces, p-curves, normals, sides', () => {
  for (const [name, make] of MODELS) {
    const original = retagged(make().finish(), new BrepBuilder());
    for (const [tn, t] of TRANSFORMS) {
      const b = new BrepBuilder();
      const baked = retagged(original, b, t);
      const where = `${name}, ${tn}`;
      const n = checkBaked(retagged(original, new BrepBuilder()), baked, t, where);
      assert.ok(n > 0, `${where}: nothing checked`);
      // Under a mirror the swept surfaces are left out, errors; nothing else is said.
      const swept = rowCount(original, 'surface') && name === 'every kind' && Math.sign(
        t[0]! * (t[4]! * t[8]! - t[5]! * t[7]!) - t[3]! * (t[1]! * t[8]! - t[2]! * t[7]!) + t[6]! * (t[1]! * t[5]!
          - t[2]! * t[4]!)) < 0;
      const errors = b.diagnostics.filter((x) => x.severity === 'error');
      assert.equal(errors.length, swept ? 2 : 0, `${where}: ${JSON.stringify(b.diagnostics)}`);
      // Every item drawn once: ids kept, no copies, items as many (less the swept surfaces left out).
      assert.equal(rowCount(baked, 'copy'), 0, where);
      assert.equal(rowCount(baked, 'item'), rowCount(original, 'item') - (swept ? 2 : 0), where);
    }
  }
});

test('under a mirror: loops turn, faces where the surface keeps (u, v), p-curves with no exact form left out', () => {
  const original = retagged(facesOnEveryKind().finish(), new BrepBuilder());
  const b = new BrepBuilder();
  const baked = retagged(original, b, TRANSFORMS[0]![1]);
  const kinds = new Map<number, string>();
  for (let f = 0; f < rowCount(original, 'face'); f++) {
    kinds.set(original.face.id[f]!, dec.surface(original, original.face.surface[f]!).kind);
  }
  const turned = new Map<string, boolean>();
  for (let g = 0; g < rowCount(baked, 'face'); g++) {
    const f = [...Array(rowCount(original, 'face')).keys()].find((x) => original.face.id[x] === baked.face.id[g])!;
    const kind = dec.surface(original, original.face.surface[f]!).kind;
    turned.set(kind, original.face.sameSense[f] !== baked.face.sameSense[g]);
    assert.notEqual(original.loop.sense[original.face.firstLoop[f]!], baked.loop.sense[baked.face.firstLoop[g]!]);
  }
  // (Of the offsets, the cylinder's isn't turned, the B-spline's is; `turned` keeps the last of each kind.)
  assert.deepEqual(Object.fromEntries(turned), { plane: true, cylinder: false, cone: false, sphere: false,
    torus: false, bspline: true, extrusion: true, revolution: true, offset: true, rectangularTrimmed: false });
  // A pure mirror keeps the plane's (u, v): its circle and offset p-curves kept, nothing said.
  assert.deepEqual(b.diagnostics, []);
  // A conic on a cylinder: run the other way round, left out with a warning.
  const c = new BrepBuilder();
  const cyl = c.addSurface({ kind: 'cylinder', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const e = c.addEdge({ curve: c.addCurve({ kind: 'line', point: [0, 0, 0], direction: [0, 0, 1], magnitude: 1 }),
    sameSense: true });
  const pc = c.addCurve({ kind: 'circle', position: { origin: [1, 1], xDir: [1, 0] }, radius: 0.5, id: 77 });
  c.addItem({ kind: 'face', ref: c.addFace({ surface: cyl, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: [{ edge: e, orientation: 'forward', pcurve: pc }] }] }), transform: TRANSFORMS[0]![1] });
  const d = c.finish();
  assert.deepEqual(c.diagnostics.map((x) => x.severity), ['warning']);
  assert.match(c.diagnostics[0]!.message, /curve #77: a conic in \(u, v\) that a mirror would run the other way/);
  assert.equal(d.coedge.pcurve[0], -1);
  // Under a mirror and a scale the cylinder's map is unequal: the offset left out too.
  const o = new BrepBuilder();
  const cyl2 = o.addSurface({ kind: 'cylinder', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const e2 = o.addEdge({ curve: o.addCurve({ kind: 'line', point: [0, 0, 0], direction: [0, 0, 1], magnitude: 1 }),
    sameSense: true });
  const basis = o.addCurve({ kind: 'line', point: [0, 0], direction: [1, 0], magnitude: 1 });
  const off = o.addCurve({ kind: 'offset', basis, distance: 0.1, selfIntersect: false });
  o.addItem({ kind: 'face', ref: o.addFace({ surface: cyl2, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: [{ edge: e2, orientation: 'forward', pcurve: off }] }] }), transform: TRANSFORMS[2]![1] });
  o.finish();
  assert.match(o.diagnostics.map((x) => x.message).join(), /a 2D offset curve under an unequal scale/);
});

test('a transform that isn\'t a similarity: an error, the item left out', () => {
  for (const t of [[2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], [1, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1, NaN, 0, 0]]) {
    const b = cube();
    b.addItem({ kind: 'point', point: [1, 2, 3], transform: t, id: 9 });
    const d = b.finish();
    assert.deepEqual(b.diagnostics.map((x) => x.severity), ['error'], String(t));
    assert.match(b.diagnostics[0]!.message, /item #9 \(point\): a transform that isn't a similarity/);
    assert.equal(rowCount(d, 'item'), 1);
  }
});

test('instances: every copy of a row several draws reach a fresh id, with its source and path; the rest keep theirs',
  () => {
  const b = new BrepBuilder({}, { firstFreshId: 1000 });
  const shell = box(b, [1, 1, 1], [0, 0, 0], 100);
  const body = b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }], id: 90 });
  const plain = b.addItem({ kind: 'body', ref: body, id: 91 });
  const once = b.addItem({ kind: 'point', point: [1, 1, 1], id: 92 });
  const inst = b.addItem({ kind: 'instance', ref: plain, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0], id: 93 });
  b.addItem({ kind: 'instance', ref: inst, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0], id: 94 });
  b.addItem({ kind: 'instance', ref: once, transform: [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], id: 95 });
  const d = b.finish();
  assert.deepEqual(b.diagnostics, []);
  // Three draws of the box: every row with an id copied three times, every copy fresh; the point's item kept.
  const copies = copiesOf(d);
  const faces = rowCount(d, 'face');
  assert.equal(faces, 18);
  assert.equal(new Set([...d.face.id]).size, 18);
  assert.ok([...d.face.id].every((x) => x >= 1000), 'every face a fresh id');
  // (27 rows with ids a draw: 8 vertices, 12 edges, 6 faces and the body, whose id comes after its members'.)
  assert.equal(copies.length, 81);
  assert.deepEqual([...d.body.id], [1026, 1053, 1080]);
  assert.ok(copies.every((c, k) => c.id === 1000 + k), 'fresh ids in order');
  const paths = new Set(copies.map((c) => c.path.join('/')));
  assert.deepEqual([...paths], ['', '93', '94/93']);
  const bySource = new Map<number, number>();
  for (const c of copies) bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
  assert.ok([...bySource.values()].every((n) => n === 3), 'each source copied three times');
  assert.ok(bySource.has(90) && !bySource.has(91), 'the body\'s id copied; items keep theirs');
  assert.deepEqual([...d.item.id], [91, 92, 93, 94, 95]);
  assert.deepEqual([...d.item.kind], [ITEM_KIND.body, ITEM_KIND.point, ITEM_KIND.body, ITEM_KIND.body,
    ITEM_KIND.point]);
  // The second instance composes: moved by (5, 5, 0); the point's instance mirrored.
  const lo = (k: number) => { const f = d.body.first[k]!, s = d.member.ref[f]!; let x = Infinity, y = Infinity;
    for (let u = d.shell.first[s]!; u < d.shell.first[s]! + d.shell.count[s]!; u++) {
      const fc = d.faceUse.face[u]!, l = d.face.firstLoop[fc]!;
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        const e = d.coedge.edge[c]!, v = d.edge.start[e]!;
        x = Math.min(x, d.vertex.point[3 * v]!); y = Math.min(y, d.vertex.point[3 * v + 1]!);
      }
    }
    return [x, y]; };
  assert.deepEqual([lo(0), lo(1), lo(2)], [[0, 0], [5, 0], [5, 5]]);
  assert.deepEqual([...d.pool.itemReal], [1, 1, 1, -1, 1, 1]);
  // Rows without ids get none; a single draw keeps every id.
  const one = new BrepBuilder();
  one.addItem({ kind: 'body', ref: one.addBody({ kind: 'solid', members: [{ ref: box(one, [1, 1, 1], [0, 0, 0], 300),
    sense: true }] }), transform: [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0] });
  const od = one.finish();
  assert.equal(copiesOf(od).length, 0);
  assert.ok([...od.face.id].every((x) => x > 300 && x < 400));
  // The default first fresh id: one above the largest the builder was given.
  const def = new BrepBuilder();
  const it = def.addItem({ kind: 'body', ref: def.addBody({ kind: 'solid', members: [{ ref: box(def, [1, 1, 1],
    [0, 0, 0], 500), sense: true }] }) });
  def.addItem({ kind: 'instance', ref: it, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0] });
  const defd = def.finish();
  const largest = Math.max(...copiesOf(defd).map((c) => c.source));
  assert.equal(copiesOf(defd)[0]!.id, largest + 1);
});

test('fresh ids past 2^32 - 1: none, said once', () => {
  const b = new BrepBuilder({}, { firstFreshId: 0xffffffff });
  const it = b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1], [0, 0, 0],
    10), sense: true }] }) });
  b.addItem({ kind: 'instance', ref: it, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0] });
  const d = b.finish();
  assert.deepEqual(b.diagnostics.map((x) => x.message), ['copies past id 2^32 - 1 left without ids']);
  assert.equal(copiesOf(d).length, 1);
  assert.equal(copiesOf(d)[0]!.id, 0xffffffff);
  assert.ok([...d.face.id].filter((x) => x === 0).length > 0);
});

test('an instance of an item left out is left out', () => {
  const b = cube();
  const bad = b.addItem({ kind: 'point', point: [0, 0, 0], transform: [3, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], id: 5 });
  b.addItem({ kind: 'instance', ref: bad, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], id: 6 });
  b.finish();
  assert.deepEqual(b.diagnostics.map((x) => x.message.replace(/:.*/, '')), ['item #5 (point)', 'item #6 (instance)']);
});

test('a rectangular trim\'s bounds map with its basis: its corners T of the original\'s', () => {
  const b = new BrepBuilder();
  const P = { origin: [1, 2, 3], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const basis = [b.addSurface({ kind: 'plane', position: P }), b.addSurface({ kind: 'cylinder', position: P,
    radius: 2 }), b.addSurface({ kind: 'sphere', position: P, radius: 3 })];
  for (const s of basis) {
    b.addItem({ kind: 'surface', ref: b.addSurface({ kind: 'rectangularTrimmed', basis: s, u1: 0.2, u2: 1.4, v1: -0.7,
      v2: 0.9, uSense: true, vSense: false, id: 50 + s }) });
  }
  const a = b.finish();
  for (const [tn, t] of TRANSFORMS) {
    const d = retagged(a, new BrepBuilder(), t), o = retagged(a, new BrepBuilder());
    for (let k = 0; k < rowCount(o, 'surface'); k++) {
      if (dec.surface(o, k).kind !== 'rectangularTrimmed') continue;
      const r = [...Array(rowCount(d, 'surface')).keys()].find((x) => d.surface.id[x] === o.surface.id[k])!;
      const sa = surfaceEvaluator(o, k)!, sb = surfaceEvaluator(d, r)!;
      const corners = (s: typeof sa) => [s.u[0], s.u[1]].flatMap((u) => [s.v[0], s.v[1]].map((v) => s.point(u, v)));
      const want = corners(sa).map((p) => apply(t, p)), got = corners(sb);
      for (const p of want) {
        assert.ok(got.some((q) => near(p, q, 1e-9 * 100)),
          `${tn}: trim ${k}'s corner ${p} among ${JSON.stringify(got)}`);
      }
    }
  }
});

test('nested instances compose: the inner transform first, then the outer', () => {
  const b = new BrepBuilder();
  const plain = b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 2, 3], [1, 0, 0],
    10), sense: true }] }) });
  const [, inner] = TRANSFORMS[1]!, [, outer] = TRANSFORMS[2]!;
  const i1 = b.addItem({ kind: 'instance', ref: plain, transform: inner });
  b.addItem({ kind: 'instance', ref: i1, transform: outer });
  const d = b.finish();
  const p0 = [1, 0, 0], v = (k: number) => [...d.vertex.point.subarray(3 * k, 3 * k + 3)];
  // Each draw's first vertex is the box's first corner, (1, 0, 0), at its transform.
  const firsts = [0, 8, 16].map(v);
  assert.ok(near(firsts[0]!, p0, 1e-12));
  assert.ok(near(firsts[1]!, apply(inner, p0), 1e-9));
  assert.ok(near(firsts[2]!, apply(outer, apply(inner, p0)), 1e-9),
    `${firsts[2]} for ${apply(outer, apply(inner, p0))}`);
});

test('a 2D conic under a point reflection (both coordinates negated) keeps its parameter', () => {
  const c: Curve = { kind: 'ellipse', position: { origin: [0.5, 0.25], xDir: [0.6, 0.8] }, semiAxis1: 2, semiAxis2: 1 };
  const m = curve2([-3, -3], c);
  assert.ok(typeof m !== 'string');
  const b = new BrepBuilder(), k0 = b.addCurve(c), k1 = b.addCurve(m), d = b.finish();
  const e0 = curveEvaluator(d, k0)!, e1 = curveEvaluator(d, k1)!;
  for (const t of [0, 1, 2.5, 4]) assert.ok(near(e0.point(t).map((x) => -3 * x), e1.point(t), 1e-12), `${t}`);
  // A reflection of one coordinate has no conic form; an unequal scale neither.
  assert.match(curve2([1, -1], c) as string, /run the other way round/);
  assert.match(curve2([1, 2], c) as string, /unequal scale/);
});

test('swept surfaces: the profile scaled about its frame\'s origin, the directrix at T; under a mirror, nothing',
  () => {
  const make = () => {
    const b = new BrepBuilder();
    const profile = b.addCurve({ kind: 'circle', position: { origin: [1, 2, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
      radius: 0.5, id: 1 });
    const directrix = b.addCurve({ kind: 'line', point: [3, 1, 2], direction: [0, 0, 1], magnitude: 1, id: 2 });
    b.addItem({ kind: 'surface', ref: b.addSurface({ kind: 'fixedReferenceSwept', curve: profile, directrix,
      fixedReference: [1, 0, 0], id: 3 }) });
    return b;
  };
  for (const [tn, t] of TRANSFORMS) {
    const b = make();
    b.addItem({ kind: 'point', point: [0, 0, 0] });
    const a = make().finish();
    const nb = new BrepBuilder();
    const d = retagged(a, nb, t);
    const det = Math.sign(t[0]! * (t[4]! * t[8]! - t[5]! * t[7]!) - t[3]! * (t[1]! * t[8]! - t[2]! * t[7]!)
      + t[6]! * (t[1]! * t[5]! - t[2]! * t[4]!));
    if (det < 0) {
      assert.equal(rowCount(d, 'surface'), 0, tn);
      assert.equal(rowCount(d, 'curve'), 0, `${tn}: nothing copied for a surface left out`);
      assert.deepEqual(nb.diagnostics.map((x) => x.severity), ['error']);
      continue;
    }
    const s = Math.hypot(t[0]!, t[1]!, t[2]!), x = dec.surface(d, 0);
    assert.ok(x.kind === 'fixedReferenceSwept');
    const pa = curveEvaluator(a, 0)!, pb = curveEvaluator(d, x.curve)!;
    const da = curveEvaluator(a, 1)!, db = curveEvaluator(d, x.directrix)!;
    for (const u of [0, 1, 2]) {
      assert.ok(near(pa.point(u).map((y) => y * s), pb.point(u), 1e-9), `${tn}: profile at ${u}`);
      assert.ok(near(apply(t, da.point(u)), db.point(u), 1e-9), `${tn}: directrix at ${u}`);
    }
    assert.ok(near(x.fixedReference, linear(t, [1, 0, 0]).map((y) => y / s), 1e-12), tn);
  }
});

test('a model baked again (transformBrep): its copies kept, every row at the transform', () => {
  const b = new BrepBuilder({}, { firstFreshId: 500 });
  const it = b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1], [0, 0, 0],
    10), sense: true }] }) });
  b.addItem({ kind: 'instance', ref: it, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 0, 0], id: 40 });
  const d = b.finish();
  const t = TRANSFORMS[2]![1];
  const { data, diagnostics } = transformBrep(d, t);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(copiesOf(data), copiesOf(d));
  assert.deepEqual([...data.face.id], [...d.face.id]);
  for (let k = 0; k < rowCount(d, 'vertex'); k++) {
    assert.ok(near(apply(t, [...d.vertex.point.subarray(3 * k, 3 * k + 3)]), [...data.vertex.point.subarray(3 * k,
      3 * k + 3)], 1e-9));
  }
  // A shear: every item left out, an error each.
  const sheared = transformBrep(d, [1, 0, 0, 0.5, 1, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(rowCount(sheared.data, 'item'), 0);
  assert.deepEqual(sheared.diagnostics.map((x) => x.severity), ['error', 'error']);
});
