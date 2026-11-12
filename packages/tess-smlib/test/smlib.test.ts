// The SMLib backend on cad-brep's test models and small built ones: faces by id, areas and exact measures, each
// triangle facing along its model face's normal, edges (ids, kinds, dihedral angles, points on mesh vertices), the
// deflection honoured, determinism, and the builder's warnings for what it leaves out. Needs the built module
// (./build-smlib.sh, then ./build.sh); skipped without it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, curveEvaluatorOf, decode, rowCount, surfaceEvaluator } from 'cad-brep';
import { importStep } from 'step-import';
import type { BrepData } from 'cad-brep';
import type { TessellationRequest, TessellationResult } from 'cad-scene';
import { box, MODELS } from '../../cad-brep/test/models.ts';
import { SmlibTessellator } from '../src/index.ts';

const built = fs.existsSync(path.join(import.meta.dirname, '../dist/smlib_tess.wasm'));
const corpus = path.resolve(import.meta.dirname, '../../../test_corpus/third_party/gkv311-opencascade-dataset/step');
const skip = built ? false : 'tess-smlib not built (run packages/tess-smlib/build-smlib.sh, then build.sh)';
const XY = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };

let shared: Promise<SmlibTessellator> | undefined;
const backend = () => shared ??= (async () => {
  const t = new SmlibTessellator();
  await t.init();
  return t;
})();
const request = (d: BrepData, lin = 0.01, edges = true): TessellationRequest => ({ format: 'cad-brep',
  data: new Uint8Array(d.buffer), origin: [0, 0, 0], linearDeflection: lin, angularDeflection: 0.26, measures: true,
  edges });
const mesh = async (d: BrepData, lin = 0.01) => (await backend()).tessellate(request(d, lin));

type V = [number, number, number];
const vtx = (r: TessellationResult, i: number): V => [r.positions[3 * i]!, r.positions[3 * i + 1]!,
  r.positions[3 * i + 2]!];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Each face id's (or n0, n1, ... for faces without one) triangle count and area. */
function areas(r: TessellationResult): Map<number | string, { tris: number; area: number }> {
  const out = new Map<number | string, { tris: number; area: number }>();
  let unnamed = 0;
  for (const f of r.faces) {
    const key = f.entityId ?? `n${unnamed++}`;
    const e = out.get(key) ?? { tris: 0, area: 0 };
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const a = vtx(r, r.indices[t]!), b = vtx(r, r.indices[t + 1]!), c = vtx(r, r.indices[t + 2]!);
      e.area += Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
    }
    e.tris += f.count / 3;
    out.set(key, e);
  }
  return out;
}

/**
 * Triangles facing against their model face's normal (the surface's S_u x S_v at the centroid, times the face's
 * sameSense; faces by id, elementary surfaces), and the distance of centroids and edge midpoints from the surface
 * (the farthest), over a model's faces.
 */
function sides(d: BrepData, r: TessellationResult): { against: number; checked: number; far: number } {
  const byId = new Map<number, number>();
  for (let f = 0; f < rowCount(d, 'face'); f++) byId.set(decode.face(d, f).id as number, f);
  let against = 0, checked = 0, far = 0;
  for (const fr of r.faces) {
    if (fr.entityId === null) continue;
    const face = decode.face(d, byId.get(fr.entityId)!);
    const ev = surfaceEvaluator(d, face.surface)!;
    for (let t = fr.start; t < fr.start + fr.count; t += 3) {
      const a = vtx(r, r.indices[t]!), b = vtx(r, r.indices[t + 1]!), c = vtx(r, r.indices[t + 2]!);
      const n = cross(sub(b, a), sub(c, a));
      for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
        const q: V = [0, 1, 2].map((k) => w[0]! * a[k]! + w[1]! * b[k]! + w[2]! * c[k]!) as V;
        const uv = ev.params?.(q);
        if (!uv) continue;
        const x = ev.point(uv[0], uv[1]) as V;
        far = Math.max(far, Math.hypot(...sub(x, q)));
        if (w[0] !== 1 / 3) continue;
        const [su, sv] = ev.d1(uv[0], uv[1]) as [V, V];
        const s = dot(n, cross(su, sv)) * (face.sameSense ? 1 : -1);
        checked++;
        if (s < 0) against++;
      }
    }
  }
  return { against, checked, far };
}

test('the test models: faces by id, with their areas, exact measures and sides', { skip }, async () => {
  const cube = MODELS.cube().finish(), r = await mesh(cube);
  const a = areas(r);
  assert.deepEqual([...a.keys()].sort(), [21, 22, 23, 24, 25, 26]);
  for (const [id, f] of a) assert.ok(Math.abs(f.area - 1) < 1e-9 && f.tris === 2, `cube face #${id}`);
  assert.deepEqual(r.measures!.map((m) => [m.entityId, +m.area.toFixed(9), +m.perimeter.toFixed(9), m.valid]).sort(),
    [21, 22, 23, 24, 25, 26].map((id) => [id, 1, 4, true]));
  assert.deepEqual(r.diagnostics, []);
  const s = sides(cube, r);
  assert.ok(s.checked === 12 && s.against === 0, JSON.stringify(s));
  // The normals with the triangles: each vertex's on its triangles' side, on faces built inside out too.
  for (const m of [r, await mesh(MODELS.reversedUses().finish()), await mesh(MODELS.spheres().finish())]) {
    for (let t = 0; t < m.indices.length; t += 3) {
      const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
      const n = cross(sub(vtx(m, j), vtx(m, i)), sub(vtx(m, k), vtx(m, i)));
      for (const v of [i, j, k]) assert.ok(dot(n, [m.normals![3 * v]!, m.normals![3 * v + 1]!,
        m.normals![3 * v + 2]!]) > 0, `triangle ${t / 3}'s normals`);
    }
  }

  // The box with a void: its void's faces face into the void (along their faces' normals as the model has them).
  const withVoid = MODELS.withVoid().finish(), rv = await mesh(withVoid);
  assert.equal(areas(rv).size, 12);
  assert.equal(sides(withVoid, rv).against, 0);
  // Faces built inside out and used reversed: triangles along the faces' own normals (the host turns over shells).
  const rev = MODELS.reversedUses().finish(), rr = await mesh(rev);
  assert.equal(areas(rr).size, 12);
  assert.equal(sides(rev, rr).against, 0);

  // The seam cylinder (r 2, h 5) and the spheres (a whole one of natural bounds, a hemisphere to a vertex loop).
  const cyl = MODELS.seamCylinder().finish(), rc = await mesh(cyl);
  const c = areas(rc).get(9)!;
  assert.ok(Math.abs(c.area - 20 * Math.PI) < 0.01 * 20 * Math.PI, `cylinder ${c.area}`);
  // (SMLib's area near the relative accuracy the wrapper asks, 1e-6, a target rather than a bound; the perimeter
  // counts the seam twice.)
  assert.ok(Math.abs(rc.measures![0]!.area - 20 * Math.PI) < 20 * Math.PI * 1e-5);
  assert.ok(Math.abs(rc.measures![0]!.perimeter - (8 * Math.PI + 10)) < 1e-6);
  assert.equal(sides(cyl, rc).against, 0);
  const sph = MODELS.spheres().finish(), rs = await mesh(sph);
  const sa = [...areas(rs).values()].map((x) => x.area).sort((x, y) => x - y);
  assert.equal(sa.length, 2);
  // (A mesh within 0.01 of a unit sphere is short of its area by up to about 2 x 0.01 of it.)
  assert.ok(Math.abs(sa[0]! - 2 * Math.PI) < 0.02 * 2 * Math.PI && Math.abs(sa[1]! - 4 * Math.PI) < 0.02 * 4 * Math.PI,
    `spheres ${sa}`);
  // The hemisphere is the upper one (its pole's), facing out.
  const upper = rs.faces.find((f) => f.count && vtx(rs, rs.indices[f.start]!)[0] > 5)!;
  for (let t = upper.start; t < upper.start + upper.count; t++) assert.ok(vtx(rs, rs.indices[t]!)[2] >= -1e-6);
});

test('faces against their surfaces (sameSense false) on every elementary surface face along their own normals',
  { skip }, async () => {
    // A square on z = 0 facing down (its plane's normal up), a cylinder band facing in, a sphere cap facing in.
    for (const same of [true, false]) {
      const b = new BrepBuilder({ unit: 1 });
      const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
      const v = P.map((point) => b.addVertex({ point }));
      // Counter-clockwise about the face's normal: about +z when the face is the plane's way round.
      const order = same ? [0, 1, 2, 3] : [0, 3, 2, 1];
      const coedges = order.map((k, i) => {
        const j = order[(i + 1) % 4]!, d = P[j]!.map((x, c) => x - P[k]![c]!);
        const curve = b.addCurve({ kind: 'line', point: P[k]!, direction: d, magnitude: 1 });
        const edge = b.addEdge({ curve, start: v[k]!, end: v[j]!, sameSense: true });
        return { edge, orientation: 'forward' as const };
      });
      b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: same, id: 1,
        loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] });
      const shell = b.addShell({ kind: 'open', faces: [{ face: 0, sense: true }] });
      b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
      const d = b.finish(), r = await mesh(d);
      const s = sides(d, r);
      assert.ok(s.checked === 2 && s.against === 0, `plane, sameSense ${same}: ${JSON.stringify(s)}`);
    }
    // A closed box built inside out (every face facing in, used as built): healing makes it a solid, and the
    // tessellator turns over the faces whose upper side bounds it; each still faces along its face's normal.
    const b = new BrepBuilder({ unit: 1 });
    const shell = box(b, [1, 1, 1], [0, 0, 0], 0, () => true, true);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
    const d = b.finish(), r = await mesh(d);
    const s = sides(d, r);
    assert.ok(s.checked === 12 && s.against === 0, JSON.stringify(s));
  });

/** A planar face (z = 0, facing +z) bounded by loops given as corner lists (lines) or circles, the first its outer
 * boundary (counter-clockwise about +z), the rest holes (clockwise); the loop `marked` marked outer and listed
 * first, the others inner. */
function plate(loops: ({ corners: number[][] } | { centre: number[]; radius: number })[], scale = 1, marked = 0):
  BrepData {
  const b = new BrepBuilder({ unit: 1 });
  const built = loops.map((l, i) => {
    const inner = i > 0;
    if ('corners' in l) {
      const P = inner ? [...l.corners].reverse() : l.corners;
      const v = P.map((point) => b.addVertex({ point }));
      const coedges = P.map((a, k) => {
        const c = P[(k + 1) % P.length]!, d = c.map((x, j) => (x - a[j]!) * scale);
        const curve = b.addCurve({ kind: 'line', point: a, direction: d, magnitude: 1 / scale });
        const edge = b.addEdge({ curve, start: v[k]!, end: v[(k + 1) % P.length]!, sameSense: true });
        return { edge, orientation: 'forward' as const };
      });
      return coedges;
    }
    const hv = b.addVertex({ point: [l.centre[0]! + l.radius, l.centre[1]!, 0] });
    const circle = b.addCurve({ kind: 'circle', position: { ...XY, origin: l.centre }, radius: l.radius });
    const edge = b.addEdge({ curve: circle, start: hv, end: hv, sameSense: true });
    return [{ edge, orientation: inner ? 'reversed' as const : 'forward' as const }];
  });
  const order = [marked, ...built.keys()].filter((k, i, a) => a.indexOf(k) === i);
  b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 1,
    loops: order.map((k) => ({ kind: 'edge' as const, bound: k === marked ? 'outer' as const : 'inner' as const,
      sense: true, coedges: built[k]! })) });
  const shell = b.addShell({ kind: 'open', faces: [{ face: 0, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b.finish();
}

test('planar faces with holes: square and round, a hole marked as the outer bound, lines of any magnitude', { skip },
  async () => {
    const square = { corners: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]] };
    const hole = { corners: [[1, 1, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0]] }, round = { centre: [3, 3, 0], radius: 0.5 };
    const cases: [string, BrepData, number][] = [
      ['a square hole', plate([square, hole]), 15],
      ['a round hole', plate([square, round]), 16 - Math.PI / 4],
      ['both holes', plate([square, hole, round]), 15 - Math.PI / 4],
      // (Directions of length 3 with magnitude 1/3: SMLib takes a line's vector as a unit one.)
      ['lines of direction length 3', plate([square, hole], 3), 15],
    ];
    for (const [what, d, area] of cases) {
      const r = await mesh(d);
      const a = areas(r).get(1)!;
      assert.ok(Math.abs(a.area - area) < 0.01 * area, `${what}: ${a.area} for ${area}`);
      assert.equal(sides(d, r).against, 0, what);
    }
    // The file marks the hole outer (as some do): the face is still the square less the hole.
    const marked = plate([square, round], 1, 1);
    const r = await mesh(marked);
    const a = areas(r).get(1)!;
    assert.ok(Math.abs(a.area - (16 - Math.PI / 4)) < 0.16, `hole marked outer: ${a.area}`);
  });

test('a curve-bounded face of trimmed arcs, one trimmed against its circle and used reversed: the disc', { skip },
  async () => {
    // A disc of radius 2 on z = 0 facing +z: the upper half of its circle (0 to pi, with it), then the lower half,
    // trimmed from 2 pi to pi against the circle (so from (2, 0) to (-2, 0) clockwise) and used reversed.
    const b = new BrepBuilder({ unit: 1 });
    const circle = b.addCurve({ kind: 'circle', position: XY, radius: 2 });
    const upper = b.addCurve({ kind: 'trimmed', basis: circle, trim1: { parameter: 0 }, trim2: { parameter: Math.PI },
      sense: true, preference: 'parameter' });
    const lower = b.addCurve({ kind: 'trimmed', basis: circle, trim1: { parameter: 2 * Math.PI },
      trim2: { parameter: Math.PI }, sense: false, preference: 'parameter' });
    const e1 = b.addEdge({ curve: upper, sameSense: true }), e2 = b.addEdge({ curve: lower, sameSense: true });
    const coedges = [{ edge: e1, orientation: 'forward' as const }, { edge: e2, orientation: 'reversed' as const }];
    b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 1,
      loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face: 0, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const d = b.finish(), r = await mesh(d);
    const a = areas(r).get(1);
    assert.ok(a && Math.abs(a.area - 4 * Math.PI) < 0.01 * 4 * Math.PI, `disc ${a?.area}`);
    assert.equal(sides(d, r).against, 0);
    assert.deepEqual(r.diagnostics, []);
  });

test('extrusions of a closed periodic B-spline: a face reaching its seam, a face across it (edges across it)',
  { skip }, async () => {
    // A periodic cubic (a rounded square of 8 poles, 3 repeated; range [3, 11], period 8), extruded along -z by 2; the
    // faces (one each way round) its half from `from` to `to`: 7 to 11 reaches the curve's seam, 9 to 13 (5 past it)
    // crosses it, its top and bottom edges too.
    const ring = [[2, 0], [2, 2], [0, 2], [-2, 2], [-2, 0], [-2, -2], [0, -2], [2, -2]];
    const poles = [...ring, ...ring.slice(0, 3)].map(([x, y]) => [x!, y!, 1]);
    const knots = Array.from({ length: 15 }, (_, i) => i);
    const spline = (z: number) => ({ kind: 'bspline' as const, degree: 3, knots, multiplicities: knots.map(() => 1),
      poles: poles.map(([x, y]) => [x!, y!, z]), closed: true, selfIntersect: false, form: 'unspecified' as const });
    const ev = curveEvaluatorOf(spline(1), () => undefined)!;
    const point = (t: number) => ev.point(t > 11 ? t - 8 : t);
    for (const [from, to] of [[7, 11], [9, 13]] as const) {
      const b = new BrepBuilder({ unit: 1 });
      const curveAt = (z: number) => b.addCurve(spline(z));
      const generator = curveAt(1), top = curveAt(1), bottom = curveAt(-1);
      const surface = b.addSurface({ kind: 'extrusion', curve: generator, direction: [0, 0, -1], magnitude: 1 });
      const at = (t: number, z: number) => [...point(t).slice(0, 2), z];
      const A = [at(from, 1), at(to, 1), at(to, -1), at(from, -1)];
      const v = A.map((p) => b.addVertex({ point: p }));
      const line = (i: number) => b.addCurve({ kind: 'line', point: A[i]!, direction: [0, 0, -1], magnitude: 1 });
      const eTop = b.addEdge({ curve: top, start: v[0]!, end: v[1]!, sameSense: true });
      const eBottom = b.addEdge({ curve: bottom, start: v[3]!, end: v[2]!, sameSense: true });
      const eRight = b.addEdge({ curve: line(1), start: v[1]!, end: v[2]!, sameSense: true });
      const eLeft = b.addEdge({ curve: line(0), start: v[0]!, end: v[3]!, sameSense: true });
      for (const sameSense of [true, false]) {
        const f = b.addFace({ surface, sameSense, id: sameSense ? 1 : 2, loops: [{ kind: 'edge', bound: 'outer',
          sense: sameSense, coedges: [{ edge: eTop, orientation: 'forward' }, { edge: eRight, orientation: 'forward' },
            { edge: eBottom, orientation: 'reversed' }, { edge: eLeft, orientation: 'reversed' }] }] });
        const shell = b.addShell({ kind: 'open', faces: [{ face: f, sense: true }] });
        b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
      }
      const r = await mesh(b.finish(), 0.001);
      // The face's area: the curve's length over its span (summed over fine chords) times the extrusion's 2; the rest
      // of the tube as much again.
      let length = 0;
      for (let k = 0; k < 4000; k++) {
        const p = point(from + k / 1000), q = point(from + (k + 1) / 1000);
        length += Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!);
      }
      const a = areas(r);
      assert.equal(a.size, 2, `${from} to ${to}: ${r.diagnostics.map((d) => d.message).join("; ")}`);
      for (const [id, f] of a) {
        assert.ok(Math.abs(f.area - 2 * length) < 0.01 * f.area,
          `${from} to ${to}, face #${id}: ${f.area}, ${2 * length}`);
      }
      assert.deepEqual(r.diagnostics.filter((d) => d.severity !== 'info'), [], `${from} to ${to}`);
    }
  });

test('edges: ids, kinds, dihedral angles, and points on mesh vertices', { skip }, async () => {
  const r = await mesh(MODELS.cube().finish());
  const ids = r.edges!.map((e) => e.entityId).sort((a, b) => a! - b!);
  assert.deepEqual(ids, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  for (const e of r.edges!) {
    assert.equal(e.kind, 'shared');
    assert.ok(Math.abs(e.dihedral! - Math.PI / 2) < 1e-6, `edge #${e.entityId}: ${e.dihedral}`);
  }
  const verts = new Set<string>();
  const p = r.positions;
  for (let i = 0; i < p.length; i += 3) verts.add(`${p[i]},${p[i + 1]},${p[i + 2]}`);
  for (let i = 0; i < r.edgePositions!.length; i += 3) assert.ok(verts.has(
    `${r.edgePositions![i]},${r.edgePositions![i + 1]},${r.edgePositions![i + 2]}`));
  // The cylinder's: a seam and two free circles.
  const rc = await mesh(MODELS.seamCylinder().finish());
  assert.deepEqual(rc.edges!.map((e) => e.kind).sort(), ['free', 'free', 'seam']);
  // Without edges asked for, none.
  const t = await backend();
  const none = await t.tessellate(request(MODELS.cube().finish(), 0.01, false));
  assert.equal(none.edges, undefined);
});

test('the deflection: honoured, and finer meshes finer; the same bytes the same mesh', { skip }, async () => {
  const cyl = MODELS.seamCylinder().finish(), sph = MODELS.spheres().finish();
  for (const d of [cyl, sph]) {
    let last = 0;
    for (const lin of [0.1, 0.01, 0.001]) {
      const r = await mesh(d, lin);
      const s = sides(d, r);
      assert.ok(s.far <= lin * 1.01, `deflection ${lin}: ${s.far}`);
      assert.ok(r.indices.length > last, `deflection ${lin}: finer`);
      last = r.indices.length;
    }
  }
  const a = await mesh(cyl), b = await mesh(cyl);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.indices, b.indices);
  assert.deepEqual(a.faces, b.faces);
});

test('what the builder leaves out is warned of, the rest meshed; other formats are caller bugs', { skip }, async () => {
  // The faceted tetrahedron meshes (poly loops); the wire body's two edges come back as curves, from vertex to vertex.
  const r = await mesh(MODELS.facetedAndWire().finish());
  assert.equal(areas(r).size, 5);
  assert.equal(r.curves!.length, 2);
  const ends = r.curves!.map((c) => [c.start, c.start + c.count - 1].map((k) =>
    [0, 1, 2].map((j) => Math.round(r.curvePositions![3 * k + j]! * 1e6) / 1e6).join()));
  assert.deepEqual(ends.flat().sort(), ['5,0,0', '6,0,0', '6,0,0', '6,1,0']);
  // The cone model's apex edge has no 3D curve: its face is left out, with a warning.
  const rc = await mesh(MODELS.cone().finish());
  assert.ok(rc.diagnostics.some((d) => /edges without a 3D curve/.test(d.message)));
  const t = await backend();
  await assert.rejects(t.tessellate({ ...request(MODELS.cube().finish()), format: 'step' }), /format 'step'/);
  // Bytes that aren't a model: an error, nothing meshed.
  const bad = await t.tessellate({ ...request(MODELS.cube().finish()), data: new Uint8Array(64) });
  assert.ok(bad.diagnostics.some((d) => d.severity === 'error'));
  assert.equal(bad.indices.length, 0);
});

test('loose geometry and instances: curve items drawn, the point placed, an instance mirrored', { skip }, async () => {
  const d = MODELS.everyKind().finish(), r = await mesh(d);
  // The bounded curve items as polylines (the line, 501, unbounded: left out with a warning), the point with its id.
  assert.ok(r.curves!.length >= 5, `${r.curves!.length} curves`);
  assert.ok(!r.curves!.some((c) => c.entityId === 501));
  assert.ok(r.diagnostics.some((x) => /line curve items/.test(x.message)));
  assert.deepEqual(r.pointIds, [701]);
  // The curve-bounded face (one boundary segment without vertices, the circle of radius 2; its id the item's, the face
  // row having none): the disc, among the faces without ids.
  const unnamed = [...areas(r)].filter(([k]) => typeof k === 'string').map(([, f]) => f.area);
  assert.ok(unnamed.some((x) => Math.abs(x - 4 * Math.PI) < 0.01 * 4 * Math.PI), `disc among ${unnamed}`);
  assert.deepEqual([...r.points!].map((x) => Math.round(x)), [9, 8, 7]);
  // The unit box at x 20..21 and its mirrored instance (x -> 10 - x, at -11..-10): each face's triangles in both
  // places under its one id, each copy enclosing its unit volume facing out (the mirror's winding turned back).
  const box = r.faces.filter((f) => f.entityId !== null && f.entityId >= 2021 && f.entityId <= 2026);
  assert.equal(box.length, 6);
  const volume = [0, 0];
  for (const f of box) for (let t = f.start; t < f.start + f.count; t += 3) {
    const a = vtx(r, r.indices[t]!), b = vtx(r, r.indices[t + 1]!), c = vtx(r, r.indices[t + 2]!);
    volume[a[0] > 0 ? 0 : 1]! += dot(a, cross(b, c)) / 6;
  }
  assert.ok(Math.abs(volume[0]! - 1) < 1e-9 && Math.abs(volume[1]! - 1) < 1e-9, `volumes ${volume}`);
});

test('transforms composed: an item\'s own, then its instance\'s; curves sampled within the deflection', { skip },
  async () => {
    // A unit cube moved by (5, 0, 0) as its item, placed again by an instance turning it a quarter about z.
    const b = new BrepBuilder({ unit: 1 });
    const body = b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1]),
      sense: true }] }), transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0] });
    b.addItem({ kind: 'instance', ref: body, transform: [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0] });
    // A circle of radius 2 as a loose curve.
    b.addItem({ kind: 'curve', ref: b.addCurve({ kind: 'circle', position: XY, radius: 2, id: 900 }) });
    const r = await mesh(b.finish(), 0.001);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < r.positions.length; i += 3) { xs.push(r.positions[i]!); ys.push(r.positions[i + 1]!); }
    // The item at x 5..6, y 0..1; the instance (x, y) -> (-y, x): x -1..0, y 5..6.
    const near = (a: number[], v: number) => a.some((x) => Math.abs(x - v) < 1e-6);
    for (const v of [5, 6, -1, 0]) assert.ok(near(xs, v), `x ${v}`);
    for (const v of [0, 1, 5, 6]) assert.ok(near(ys, v), `y ${v}`);
    assert.ok(!near(xs, -6) && !near(ys, -5), 'the transforms composed the other way');
    // The circle: on it, its chords within the deflection, and not oversampled.
    const c = r.curves!.find((x) => x.entityId === 900)!;
    const P = (k: number) => [0, 1, 2].map((j) => r.curvePositions![3 * (c.start + k) + j]!);
    for (let k = 0; k + 1 < c.count; k++) {
      const a = P(k), q = P(k + 1), m = [0, 1].map((j) => (a[j]! + q[j]!) / 2);
      assert.ok(Math.abs(Math.hypot(a[0]!, a[1]!) - 2) < 1e-6);
      assert.ok(2 - Math.hypot(m[0]!, m[1]!) <= 0.001 * 1.01, `chord ${k}`);
    }
    // (A chord of sagitta 0.001 on radius 2 spans 2 acos(1 - 0.0005) = 0.063 rad: about 100 round.)
    assert.ok(c.count > 90 && c.count < 260, `${c.count} points`);
  });

test('a real part (trj7_k1-sd-214.stp): tori, spheres, cylinders, and extrusions of periodic curves, with measures',
  { skip: skip || (fs.existsSync(corpus) ? false : 'no corpus (test_corpus/third_party/pull.sh)') }, async () => {
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(path.join(corpus, 'trj7_k1-sd-214.stp'))));
    const part = scene.parts.find((p) => p.sources[0]!.id === 30730)!;
    const t = await backend();
    const r = await t.tessellate({ ...request(part.brep!.model, 0.1 / part.unit), origin: part.origin });
    const a = areas(r);
    // OCCT's measured areas, which the area oracle confirms for the elementary faces.
    const expected: [number, number][] = [[8550, 11.94], [13080, 11.94], [13260, 48.64], [29690, 201.29],
      [14450, 76.11], [30200, 76.11]];
    for (const [id, area] of expected) {
      const f = a.get(id);
      assert.ok(f && Math.abs(f.area - area) < 0.03 * area, `face #${id}: ${f?.area} for ${area}`);
    }
    // SMLib's exact areas of the extrusions too (they're its measures).
    const m = new Map(r.measures!.map((x) => [x.entityId, x.area]));
    for (const [id, area] of expected) assert.ok(Math.abs(m.get(id)! - area) < 0.01 * area, `face #${id}'s measure`);
  });

test('a real part (trj3_s1-id-203.stp): a face healing spoils, meshed again alone and unhealed, the better kept',
  { skip: skip || (fs.existsSync(corpus) ? false : 'no corpus (test_corpus/third_party/pull.sh)') }, async () => {
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(path.join(corpus, 'trj3_s1-id-203.stp'))));
    const part = scene.parts.find((p) => p.sources[0]!.id === 569)!;
    const t = await backend();
    const r = await t.tessellate({ ...request(part.brep!.model, 0.1 / part.unit), origin: part.origin });
    assert.ok(r.diagnostics.some((d) => /meshed again alone and unhealed \([1-9]\d* better so\)/.test(d.message)));
    // Every face's mesh then within what faceFailures allows of its exact area (3% short, 10% over, or the
    // deflection times the perimeter).
    const a = areas(r), d = 0.1 / part.unit;
    for (const m of r.measures!) {
      const f = a.get(m.entityId), diff = (f?.area ?? 0) - m.area, slack = d * m.perimeter;
      assert.ok(f && -diff <= Math.max(0.03 * m.area, slack) && diff <= Math.max(0.1 * m.area, slack),
        `face #${m.entityId}: ${f?.area} for ${m.area}`);
    }
  });

test('the module: its version names the build; init without a version for a compiled module is a caller bug',
  { skip }, async () => {
    const t = await backend();
    assert.match(t.info.version, /^SMLib \(usd-brep 1\.0\.1, 3fd5b95\), wasm [0-9a-f]{12}, adapter \d+$/);
    const unhealed = new SmlibTessellator({ heal: false });
    await unhealed.init();
    assert.match(unhealed.info.version, /, unhealed$/);
    const r = await unhealed.tessellate(request(MODELS.cube().finish()));
    assert.equal(areas(r).size, 6);
    const wasm = await WebAssembly.compile(fs.readFileSync(path.join(import.meta.dirname, '../dist/smlib_tess.wasm')));
    await assert.rejects(new SmlibTessellator().init({ wasm }), /needs a version/);
  });
