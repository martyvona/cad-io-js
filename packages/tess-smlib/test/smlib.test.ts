// The SMLib backend on cad-brep's test models and small built ones: faces by id, areas and exact measures, each
// triangle facing along its model face's normal, edges (ids, kinds, dihedral angles, points on mesh vertices), the
// deflection honoured, determinism, and the builder's warnings for what it leaves out. Needs the built module
// (./build-smlib.sh, then ./build.sh); skipped without it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, brepFromJson, brepToJson, curveEvaluatorOf, decode, rowCount, surfaceEvaluator } from 'cad-brep';
import { importStep } from 'step-import';
import type { BrepData, BrepJson } from 'cad-brep';
import { failedPart } from 'cad-scene';
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
  // With the measures, the area oracle's (cad-scene's oracleMeasures).
  assert.deepEqual(r.oracle!.map((m) => [m.entityId, +m.area.toFixed(9), +m.perimeter.toFixed(9)]).sort(),
    [21, 22, 23, 24, 25, 26].map((id) => [id, 1, 4]));
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
      const b = new BrepBuilder();
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
    const b = new BrepBuilder();
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
  const b = new BrepBuilder();
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
      await sameScaled(what, d);
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
    const b = new BrepBuilder();
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
    await sameScaled('the disc', d);
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
      const b = new BrepBuilder();
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
      await sameScaled(`the extrusion ${from} to ${to}`, b.finish(), 0.001);
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
  // The cone model's apex edge is degenerate (no 3D curve, from the apex to itself): left out of its loop, the face
  // meshed whole (pi r times the slant, from the apex to the base). Its loose spindle torus has no bounds to say
  // which part is meant: left out, with a warning.
  const rc = await mesh(MODELS.cone().finish());
  const side = [...areas(rc).values()];
  assert.equal(side.length, 1);
  assert.ok(Math.abs(side[0]!.area - Math.PI * Math.SQRT2) < 0.02 * Math.PI * Math.SQRT2, `cone ${side[0]!.area}`);
  assert.ok(rc.diagnostics.some((d) => /spindle tori without bounds/.test(d.message)));
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
    const b = new BrepBuilder();
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
    const r = await t.tessellate({ ...request(part.brep!.model, 0.1), origin: part.origin });
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

test('a real part (trj3_s1-id-203.stp): a face healing spoils, meshed again alone, the better kept',
  { skip: skip || (fs.existsSync(corpus) ? false : 'no corpus (test_corpus/third_party/pull.sh)') }, async () => {
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(path.join(corpus, 'trj3_s1-id-203.stp'))));
    const part = scene.parts.find((p) => p.sources[0]!.id === 569)!;
    const t = await backend();
    const r = await t.tessellate({ ...request(part.brep!.model, 0.1), origin: part.origin });
    assert.ok(r.diagnostics.some((d) => /meshed again alone, .* or larger \([1-9]\d* better so\)/
      .test(d.message)));
    // Joined to its neighbours but along two edges, #4742 and #4792, where SMLib puts a corner of their other face
    // (#5003, a B-spline) 1.7 mm off the model's vertex however it is built: those an error, counted alike.
    // (There SMLib folds #5003 back on itself, two triangles on the same three points wound opposite ways: removed.)
    assert.deepEqual(soundness(part.brep!.model, r),
      { open: [4742, 4792], said: 2, repeated: 0, stray: 0, unjudged: 0, folded: 2 });
    assert.ok(r.diagnostics.some((d) => d.severity === 'error' && /^2 edges along which/.test(d.message)));
    // Every face's mesh then within what faceFailures allows of its exact area (3% short, 10% over, or the
    // deflection times the perimeter).
    const a = areas(r), d = 0.1;
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

// One face (id 1) of loops of coedges as a sheet's only face; `sameSense` true.
type Coedge = { edge: number; orientation: 'forward' | 'reversed' };
function oneFace(b: BrepBuilder, surface: number, loops: (Coedge[] | { vertex: number })[]): BrepData {
  b.addFace({ surface, sameSense: true, id: 1, loops: loops.map((l) => ('vertex' in l
    ? { kind: 'vertex' as const, vertex: l.vertex, bound: 'unknown' as const, sense: true }
    : { kind: 'edge' as const, bound: 'unknown' as const, sense: true, coedges: l })) });
  const shell = b.addShell({ kind: 'open', faces: [{ face: 0, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b.finish();
}
// A circle about +z at height z as a closed edge (from its point at angle 0 to itself), counter-clockwise from above.
function ring(b: BrepBuilder, z: number, radius: number): number {
  const v = b.addVertex({ point: [radius, 0, z] });
  return b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { ...XY, origin: [0, 0, z] }, radius }), start: v,
    end: v, sameSense: true });
}
const fwd = (edge: number): Coedge => ({ edge, orientation: 'forward' });
const rev = (edge: number): Coedge => ({ edge, orientation: 'reversed' });
const within = (x: number | undefined, want: number, rel: number) => x !== undefined
  && Math.abs(x - want) <= rel * want;
// The face's mesh area and measure against an area known in closed form, and no diagnostics.
async function faceIs(what: string, d: BrepData, area: number, lin = 0.01): Promise<TessellationResult> {
  const r = await mesh(d, lin);
  assert.deepEqual(r.diagnostics.filter((x) => x.severity !== 'info'), [], what);
  assert.ok(within(areas(r).get(1)?.area, area, 0.02), `${what}: mesh ${areas(r).get(1)?.area} for ${area}`);
  const m = r.measures!.find((x) => x.entityId === 1);
  assert.ok(m?.valid && within(m.area, area, 1e-4), `${what}: measure ${m?.area} for ${area}`);
  return r;
}

test('curve-bounded faces whose boundaries run the wrong way round: wound by the surface, facing the model\'s way',
  { skip }, async () => {
    // A disc of radius 2 whose circle (a segment: no vertices) runs clockwise about the face's normal, and the disc
    // with a hole of radius 1 whose circle runs counter-clockwise, as the outer one does.
    for (const [what, outer, hole, area] of [['clockwise', 'reversed', undefined, 4 * Math.PI],
      ['a hole counter-clockwise', 'forward', 'forward', 3 * Math.PI],
      ['both the wrong way', 'reversed', 'forward', 3 * Math.PI]] as const) {
      const b = new BrepBuilder();
      const seg = (radius: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle', position: XY, radius }),
        sameSense: true });
      const loops: Coedge[][] = [[{ edge: seg(2), orientation: outer }]];
      if (hole) loops.push([{ edge: seg(1), orientation: hole }]);
      const d = oneFace(b, b.addSurface({ kind: 'plane', position: XY }), loops);
      const r = await faceIs(what, d, area);
      assert.equal(sides(d, r).against, 0, what);
    }
  });

test('spindle tori (major radius below the minor): faces on the outer and the inner part, as revolved arcs',
  { skip }, async () => {
    // R 1, r 3: the tube's circle crosses the axis at cos v = -1/3. A band of the outer part between v = -1 and 1,
    // and of the inner part between v = pi - 0.5 and pi + 0.5 (its points across the axis from their u): areas
    // 2 pi r |R v + r sin v| over the band. Part 42's normal S_u x S_v is (R + r cos v) r times the tube's outward
    // normal: away from the tube's centre on the outer part, towards it on the inner.
    const R = 1, r = 3;
    for (const [what, v0, v1, selectOuter] of [['outer', -1, 1, true],
      ['inner', Math.PI - 0.5, Math.PI + 0.5, false]] as const) {
      const b = new BrepBuilder();
      const at = (v: number) => ring(b, r * Math.sin(v), Math.abs(R + r * Math.cos(v)));
      const lo = at(selectOuter ? v0 : v1), hi = at(selectOuter ? v1 : v0);
      // (Counter-clockwise about the normal: the lower ring with its circle where the normal points away from the
      // axis, against it where it points towards the axis.)
      const d = oneFace(b, b.addSurface({ kind: 'torus', position: XY, majorRadius: R, minorRadius: r, selectOuter }),
        selectOuter ? [[fwd(lo)], [rev(hi)]] : [[rev(lo)], [fwd(hi)]]);
      const area = 2 * Math.PI * r * Math.abs(R * (v1 - v0) + r * (Math.sin(v1) - Math.sin(v0)));
      const res = await faceIs(what, d, area, 0.005);
      let against = 0;
      for (let t = 0; t < res.indices.length; t += 3) {
        const a = vtx(res, res.indices[t]!), p = vtx(res, res.indices[t + 1]!), c = vtx(res, res.indices[t + 2]!);
        const q = [0, 1, 2].map((k) => (a[k]! + p[k]! + c[k]!) / 3) as V, rho = Math.hypot(q[0], q[1]);
        // The tube's centre: at R along the point's radial direction on the outer part, across the axis on the inner.
        const s = selectOuter ? R / rho : -R / rho, fromCentre: V = [q[0] - s * q[0], q[1] - s * q[1], q[2]];
        if (dot(cross(sub(p, a), sub(c, a)), fromCentre) * (selectOuter ? 1 : -1) < 0) against++;
      }
      assert.equal(against, 0, `${what}: triangles against the normal`);
    }
  });

test('edges on parabolas and hyperbolas, and edges whose vertices lie backwards along their line or B-spline',
  { skip }, async () => {
    // The segment between a conic's arc over t in [-1, 1] and its chord, on z = 0: the chord up, the arc back down.
    for (const [what, curve, p, area] of [
      ['parabola', { kind: 'parabola', position: XY, focalDist: 1.5 }, (t: number) => [1.5 * t * t, 3 * t, 0],
        8 * 1.5 * 1.5 / 3],
      ['hyperbola', { kind: 'hyperbola', position: XY, semiAxis: 1, semiImagAxis: 2 },
        (t: number) => [Math.cosh(t), 2 * Math.sinh(t), 0], 2 * (Math.sinh(1) * Math.cosh(1) - 1)]] as const) {
      const b = new BrepBuilder();
      const lo = b.addVertex({ point: p(-1) }), hi = b.addVertex({ point: p(1) });
      const arc = b.addEdge({ curve: b.addCurve(curve), start: lo, end: hi, sameSense: true });
      const chord = b.addEdge({ curve: b.addCurve({ kind: 'line', point: p(-1), direction: [0, 1, 0], magnitude: 1 }),
        start: lo, end: hi, sameSense: true });
      const d = oneFace(b, b.addSurface({ kind: 'plane', position: XY }), [[fwd(chord), rev(arc)]]);
      const r = await faceIs(what, d, area, 0.002);
      assert.equal(sides(d, r).against, 0, what);
    }
    // A square of side 4 whose bottom edge runs from (4, 0) to (0, 0) though its curve runs the other way and
    // sameSense says along it: on a line, then on a B-spline.
    for (const [what, curve] of [['line', { kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 }],
      ['B-spline', { kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3],
        poles: [[0, 0, 0], [2, 0, 0], [4, 0, 0]] }]] as const) {
      const b = new BrepBuilder();
      const P = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]], v = P.map((point) => b.addVertex({ point }));
      const side = (k: number) => b.addEdge({ curve: b.addCurve({ kind: 'line', point: P[k]!,
        direction: P[(k + 1) % 4]!.map((x, j) => x - P[k]![j]!), magnitude: 1 }), start: v[k]!, end: v[(k + 1) % 4]!,
        sameSense: true });
      const bottom = b.addEdge({ curve: b.addCurve(curve as never), start: v[1]!, end: v[0]!, sameSense: true });
      const d = oneFace(b, b.addSurface({ kind: 'plane', position: XY }), [[rev(bottom), fwd(side(1)), fwd(side(2)),
        fwd(side(3))]]);
      const r = await faceIs(`a backwards ${what}`, d, 16);
      assert.equal(sides(d, r).against, 0, what);
      // Unhealed too (the healer mends an edge used the wrong way round).
      const unhealed = new SmlibTessellator({ heal: false });
      await unhealed.init();
      const ru = await unhealed.tessellate(request(d));
      assert.ok(within(areas(ru).get(1)?.area, 16, 1e-9), `a backwards ${what}, unhealed: ${areas(ru).get(1)?.area}`);
      assert.equal(sides(d, ru).against, 0, `${what}, unhealed`);
      unhealed.dispose();
    }
  });

test('whole closed surfaces by a vertex loop, and cones: past the apex, closed by the apex, a seam to the apex',
  { skip }, async () => {
    // A ball and a ring: one vertex loop each, the whole surface.
    for (const [what, surface, point, area] of [
      ['sphere', { kind: 'sphere', position: XY, radius: 2 }, [2, 0, 0], 16 * Math.PI],
      ['torus', { kind: 'torus', position: XY, majorRadius: 3, minorRadius: 1 }, [4, 0, 0], 12 * Math.PI ** 2],
    ] as const) {
      const b = new BrepBuilder();
      const d = oneFace(b, b.addSurface(surface as never), [{ vertex: b.addVertex({ point: [...point] }) }]);
      await faceIs(what, d, area, 0.005);
    }
    {
      // Half a sphere about z, the half x < 0, bounded by the great circle about x: its boundary passes both poles,
      // so the sphere is built about another axis.
      const b = new BrepBuilder();
      const v = b.addVertex({ point: [0, 2, 0] });
      const great = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [1, 0, 0],
        xDir: [0, 1, 0] }, radius: 2 }), start: v, end: v, sameSense: true });
      const d = oneFace(b, b.addSurface({ kind: 'sphere', position: XY, radius: 2 }), [[rev(great)]]);
      const r = await faceIs('a hemisphere through the poles', d, 8 * Math.PI, 0.005);
      assert.equal(sides(d, r).against, 0, 'a hemisphere through the poles');
      for (let k = 0; k < r.positions.length; k += 3) assert.ok(r.positions[k]! < 1e-6, 'the half x < 0');
    }
    // A cone of radius 1 at z = 0, widening upward at 45 degrees: its apex at z = -1.
    const cone = (b: BrepBuilder) => b.addSurface({ kind: 'cone', position: XY, radius: 1, semiAngle: Math.PI / 4 });
    {
      // Past the apex, between z = -3 (radius 2) and z = -2 (radius 1), where Part 42's radius is negative and its
      // normal points away from the axis and upward: pi (r1 + r2) times the slant.
      const b = new BrepBuilder();
      const d = oneFace(b, cone(b), [[fwd(ring(b, -3, 2))], [rev(ring(b, -2, 1))]]);
      const r = await faceIs('past the apex', d, 3 * Math.PI * Math.SQRT2);
      assert.equal(sides(d, r).against, 0, 'past the apex');
    }
    {
      // From the apex to the ring at z = 0, bounded by the ring alone (the apex closes it): pi r times the slant.
      const b = new BrepBuilder();
      const d = oneFace(b, cone(b), [[rev(ring(b, 0, 1))]]);
      const r = await faceIs('closed by the apex', d, Math.PI * Math.SQRT2);
      assert.equal(sides(d, r).against, 0, 'closed by the apex');
    }
    {
      // The same face with a seam from the apex, used both ways (healing splits such a face in two: measured whole).
      const b = new BrepBuilder();
      const va = b.addVertex({ point: [0, 0, -1] }), vb = b.addVertex({ point: [1, 0, 0] });
      const base = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: XY, radius: 1 }), start: vb, end: vb,
        sameSense: true });
      const seam = b.addEdge({ curve: b.addCurve({ kind: 'line', point: [0, 0, -1], direction: [1, 0, 1],
        magnitude: 1 }), start: va, end: vb, sameSense: true });
      const d = oneFace(b, cone(b), [[fwd(seam), rev(base), rev(seam)]]);
      const r = await faceIs('a seam to the apex', d, Math.PI * Math.SQRT2);
      assert.equal(sides(d, r).against, 0, 'a seam to the apex');
    }
  });

// A patch of a torus over u0..u1 and v0..v1 (its four arcs as edges), facing along the torus's normal.
function torusPatch(R: number, r: number, u0: number, u1: number, v0: number, v1: number): BrepData {
  const b = new BrepBuilder();
  const P = (u: number, v: number) => [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u),
    r * Math.sin(v)];
  const corner = (u: number, v: number) => b.addVertex({ point: P(u, v) });
  const c00 = corner(u0, v0), c10 = corner(u1, v0), c11 = corner(u1, v1), c01 = corner(u0, v1);
  const latitude = (v: number, a: number, z: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle',
    position: { ...XY, origin: [0, 0, r * Math.sin(v)] }, radius: R + r * Math.cos(v) }), start: a, end: z,
  sameSense: true });
  // (The tube's circle at u: in the plane of the radial direction and z, its angle v.)
  const meridian = (u: number, a: number, z: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle',
    position: { origin: [R * Math.cos(u), R * Math.sin(u), 0], axis: [Math.sin(u), -Math.cos(u), 0],
      xDir: [Math.cos(u), Math.sin(u), 0] }, radius: r }), start: a, end: z, sameSense: true });
  return oneFace(b, b.addSurface({ kind: 'torus', position: XY, majorRadius: R, minorRadius: r }),
    [[fwd(latitude(v0, c00, c10)), fwd(meridian(u1, c10, c11)), rev(latitude(v1, c01, c11)),
      rev(meridian(u0, c00, c01))]]);
}
const torusArea = (R: number, r: number, u0: number, u1: number, v0: number, v1: number) =>
  r * (u1 - u0) * (R * (v1 - v0) + r * (Math.sin(v1) - Math.sin(v0)));

test('a small face on a huge torus (its turns fitted to the face), and a strip thin in space but not in (u, v)',
  { skip }, async () => {
    // 4 cm by 3 cm of a torus of 296 m and 295.97 m at 0.1 mm: SMLib given the whole torus runs out of memory.
    const big = [296000, 295969, 0, 1e-4 * 0.7, 0, 1e-4] as const;
    await faceIs('on a huge torus', torusPatch(...big), torusArea(...big), 0.1);
    // 29 mm by 0.5 mm on the inside of a torus of 56 and 2 at 0.1 mm: about as wide as long in (u, v), where SMLib
    // triangulates, so its first mesh joins the ends by edges that leave the surface (half again the area); the
    // face is meshed again with shorter edges.
    const strip = [56, 2, 0, 0.54, Math.PI - 0.125, Math.PI + 0.125] as const;
    const r = await mesh(torusPatch(...strip), 0.1);
    const a = areas(r).get(1)!.area, want = torusArea(...strip);
    assert.ok(a > 0.97 * want && a < 1.1 * want, `the strip: ${a} for ${want}`);
    assert.ok(r.diagnostics.some((x) => /or larger \(1 better so\)/.test(x.message)));
    await sameScaled('the strip', torusPatch(...strip), 0.1);
  });

test('real parts: faces the healer removes or splits, spheres bounded through their poles, a whole turn just off',
  { skip: skip || (fs.existsSync(corpus) ? false : 'no corpus (test_corpus/third_party/pull.sh)') }, async () => {
  const part = async (file: string, id: number) => {
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(path.join(corpus, file))));
    const p = scene.parts.find((x) => x.sources[0]!.id === id)!;
    return { p, r: await (await backend()).tessellate({ ...request(p.brep!.model, 0.1), origin: p.origin }) };
  };
  // Two slivers the healer removes from their shell: meshed alone.
  const slivers = await part('bug25415_part_of_hdrv8w64p254_4x2_1016x502h838p.stp', 418);
  for (const id of [125, 250]) assert.ok((areas(slivers.r).get(id)?.tris ?? 0) > 0, `face #${id}`);
  // Cones from a ring to the apex with a seam, which the healer splits in two: measured whole (pi r times the slant:
  // r 4.19, the semi-angle 1.0297442575).
  const cones = await part('bug31685_1.stp', 17);
  const whole = Math.PI * 4.19 * 4.19 / Math.sin(1.0297442575);
  const m = cones.r.measures!.find((x) => x.entityId === 3692);
  assert.ok(within(m?.area, whole, 1e-4), `the cone's measure ${m?.area} for ${whole}`);
  assert.ok(within(areas(cones.r).get(3692)?.area, whole, 0.02));
  // Half-spheres about z bounded by a circle about x just off the centre (so it passes within 3e-6 of the poles) and
  // a small one: built about x.
  const halves = await part('trj4_s1-ai-214.stp', 3140);
  for (const id of [1931, 1933]) assert.ok((areas(halves.r).get(id)?.tris ?? 0) > 0, `face #${id}`);
  // Tori whose tube's turn starts a rounding error above -360 degrees, which SMLib refuses: every face built.
  const tori = await part('trj7_k1-ac-203.stp', 2710);
  assert.deepEqual(tori.r.diagnostics.filter((x) => x.severity !== 'info'), []);
  const d = tori.p.brep!.model, got = areas(tori.r);
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    const id = decode.face(d, f).id as number;
    assert.ok((got.get(id)?.tris ?? 0) > 0, `face #${id}`);
  }
});

/** A result's extent: the least and greatest of each coordinate over some positions. */
function extent(p: Float32Array | undefined): number[] {
  const e = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; p && i < p.length; i++) {
    e[i % 3] = Math.min(e[i % 3]!, p[i]!);
    e[3 + i % 3] = Math.max(e[3 + i % 3]!, p[i]!);
  }
  return e;
}

const scaledBackends = new Map<number, Promise<SmlibTessellator>>();
const scaledBackend = (scale: number) => scaledBackends.get(scale) ?? scaledBackends.set(scale, (async () => {
  const t = new SmlibTessellator({ scale });
  await t.init();
  return t;
})()).get(scale)!;

/**
 * A model meshed with the scale option, 32 and 1024, against its mesh without: the same diagnostics, faces (those
 * without ids matched by area), measures, and extents of the mesh, edges, curves and points.
 */
async function sameScaled(name: string, d: BrepData, lin = 0.01): Promise<void> {
  const want = await (await backend()).tessellate(request(d, lin));
  for (const scale of [32, 1024]) {
    const what = `${name} x ${scale}`, got = await (await scaledBackend(scale)).tessellate(request(d, lin));
    assert.deepEqual(got.diagnostics.map((x) => x.message.replace(/\d+ faces meshed badly.*/, '')),
      want.diagnostics.map((x) => x.message.replace(/\d+ faces meshed badly.*/, '')), what);
    const byArea = (r: TessellationResult): (readonly [number | string, number])[] => {
      const all = [...areas(r)].map(([id, f]) => [id, f.area] as const);
      return [...all.filter((x) => typeof x[0] === 'number').sort((x, y) => (x[0] as number) - (y[0] as number)),
        ...all.filter((x) => typeof x[0] !== 'number').map((x) => ['none', x[1]] as const)
          .sort((x, y) => x[1] - y[1])];
    };
    const wa = byArea(want), ga = byArea(got);
    assert.deepEqual(ga.map((x) => x[0]), wa.map((x) => x[0]), what);
    for (const [i, [id, area]] of wa.entries()) assert.ok(within(ga[i]![1], area, 0.02)
      || Math.abs(ga[i]![1] - area) < 1e-9, `${what}: face ${id}'s mesh ${ga[i]![1]} for ${area}`);
    // (None where no face has an id.)
    assert.equal(got.measures?.length, want.measures?.length, what);
    for (const m of want.measures ?? []) {
      const g = got.measures!.find((x) => x.entityId === m.entityId)!;
      assert.ok(g.valid === m.valid && (!m.valid || (within(g.area, m.area, 1e-4)
        && within(g.perimeter, m.perimeter, 1e-6))), `${what}: face ${m.entityId}'s measure ${g.area}, `
        + `${g.perimeter} for ${m.area}, ${m.perimeter}`);
    }
    for (const k of ['positions', 'edgePositions', 'curvePositions', 'points'] as const) {
      const ge = extent(got[k]), we = extent(want[k]);
      for (let i = 0; i < 6; i++) assert.ok(ge[i] === we[i] || Math.abs(ge[i]! - we[i]!) < 1.1 * lin,
        `${what}: the ${k}' extent ${ge} for ${we}`);
    }
    assert.deepEqual(got.curves?.map((c) => c.entityId), want.curves?.map((c) => c.entityId), what);
    // Each curve's own extent (wire bodies' edges are curves too: together they could hide one).
    for (const [i, c] of (want.curves ?? []).entries()) {
      const w = extent(want.curvePositions!.subarray(3 * c.start, 3 * (c.start + c.count)));
      const gc = got.curves![i]!, ge = extent(got.curvePositions!.subarray(3 * gc.start, 3 * (gc.start + gc.count)));
      for (let k = 0; k < 6; k++) assert.ok(Math.abs(ge[k]! - w[k]!) < 1.1 * lin, `${what}: curve ${i}'s extent ${ge} `
        + `for ${w}`);
    }
    assert.deepEqual(got.pointIds, want.pointIds, what);
  }
}

test('the scale option: models built 32 and 1024 times larger give the same results at their own size',
  { skip }, async () => {
    // (Not the faceted model: its faces' planes aren't their vertices', and what SMLib makes of that varies.)
    for (const [name, make] of Object.entries(MODELS)) if (name !== 'facetedAndWire') {
      await sameScaled(name, make().finish());
    }
    await sameScaled('a torus patch', torusPatch(10, 2, 0.2, 1.4, -0.5, 0.9));
    // A moved cube with a turned instance, and a loose circle.
    const b = new BrepBuilder({ uncertainty: 1e-4 });
    const body = b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 2, 3]),
      sense: true }] }), transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0] });
    b.addItem({ kind: 'instance', ref: body, transform: [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 7, 0] });
    b.addItem({ kind: 'curve', ref: b.addCurve({ kind: 'circle', position: XY, radius: 2, id: 900 }) });
    // A wire of two lines, moved.
    const v = [[5, 0, 0], [6, 0, 0], [6, 1, 0]].map((point) => b.addVertex({ point }));
    const wire = [[1, 0, 0], [0, 1, 0]].map((direction, i) => ({ sense: true, ref: b.addEdge({ start: v[i]!,
      end: v[i + 1]!, sameSense: true, curve: b.addCurve({ kind: 'line', point: [5 + i, 0, 0], direction,
        magnitude: 3 }) }) }));
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'wire', members: wire }),
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 40] });
    // A 2 by 3 piece of a plane off the origin as a loose surface, by its rectangular trim.
    b.addItem({ kind: 'surface', ref: b.addSurface({ kind: 'rectangularTrimmed', u1: 0, u2: 2, v1: 0, v2: 3,
      uSense: true, vSense: true, basis: b.addSurface({ kind: 'plane', position: { ...XY, origin: [0, 0, 60] } }) }) });
    // Trimmed lines as loose curves: by parameter (on a line of magnitude 2) and by points.
    const basis = b.addCurve({ kind: 'line', point: [0, 0, 80], direction: [1, 0, 0], magnitude: 2 });
    b.addItem({ kind: 'curve', ref: b.addCurve({ kind: 'trimmed', basis, trim1: { parameter: 0 },
      trim2: { parameter: 3 }, sense: true, preference: 'parameter' }) });
    b.addItem({ kind: 'curve', ref: b.addCurve({ kind: 'trimmed', sense: true, preference: 'cartesian',
      basis: b.addCurve({ kind: 'line', point: [0, 0, 90], direction: [0, 1, 0], magnitude: 1 }),
      trim1: { point: [0, -4, 90] }, trim2: { point: [0, 9, 90] } }) });
    await sameScaled('transforms', b.finish());
    // A cylinder of radius 2 about an axis through (10, 0, 0), as the revolution of a line, between two rings.
    const c = new BrepBuilder();
    const at = (z: number) => {
      const p = c.addVertex({ point: [12, 0, z] });
      return c.addEdge({ start: p, end: p, sameSense: true, curve: c.addCurve({ kind: 'circle', radius: 2,
        position: { ...XY, origin: [10, 0, z] } }) });
    };
    const turned = c.addSurface({ kind: 'revolution', axisOrigin: [10, 0, 3], axisDirection: [0, 0, 1],
      curve: c.addCurve({ kind: 'line', point: [12, 0, 0], direction: [0, 0, 1], magnitude: 1 }) });
    const tube = oneFace(c, turned, [[fwd(at(0))], [rev(at(5))]]);
    assert.ok(within(areas(await mesh(tube)).get(1)?.area, 20 * Math.PI, 0.01));
    await sameScaled('a revolution off the origin', tube);
    assert.match((await scaledBackend(1024)).info.version, /, scale 1024$/);
    for (const scale of [0, 0.5, 3, Infinity]) assert.throws(() => new SmlibTessellator({ scale }), RangeError);
  });

test('real faces that mesh only another way: alone unhealed, alone healed, 1024 times larger',
  { skip: skip || (fs.existsSync(corpus) ? false : 'no corpus (test_corpus/third_party/pull.sh)') }, async () => {
    // One face of a part as a sheet of its own (the part's geometry whole), meshed: its triangles, mesh area and
    // measure, and how many faces were meshed again and how many of those better.
    const parts = new Map<string, BrepJson>();
    const face = async (file: string, part: number, id: number, heal = true, scale = 1, transform?: number[]) => {
      const key = `${file} ${part}`;
      if (!parts.has(key)) {
        const { scene } = await importStep(new Uint8Array(fs.readFileSync(path.join(corpus, file))));
        parts.set(key, brepToJson(scene.parts.find((x) => x.sources[0]!.id === part)!.brep!.model));
      }
      const j = parts.get(key)!;
      const d = brepFromJson({ ...j, faces: [j.faces.find((f) => f.id === id)!],
        shells: [{ kind: 'open', faces: [{ face: 0, sense: true }] }],
        bodies: [{ kind: 'sheet', members: [{ ref: 0, sense: true }] }],
        items: [{ kind: 'body', ref: 0, ...(transform ? { transform } : {}) }] });
      const t = heal && scale === 1 ? await backend() : new SmlibTessellator({ heal, scale });
      await t.init();
      const r = await t.tessellate(request(d, 0.1));
      const again = /^(\d+) faces meshed badly.*\((\d+) better so\)$/.exec(r.diagnostics.find((x) =>
        x.severity === 'info')?.message ?? '');
      return { tris: r.indices.length / 3, area: areas(r).get(id)?.area, exact: r.measures![0]?.area,
        box: extent(r.positions),
        again: again ? [Number(again[1]), Number(again[2])] : [0, 0], lin: 0.1,
        failed: r.diagnostics.some((x) => /failed to mesh/.test(x.message)) };
    };
    // A face smaller than the deflection squared that its healed sheet leaves without a mesh: meshed alone, unhealed.
    const tiny = await face('bug24383_224013.stp', 11, 12066);
    assert.ok(tiny.exact! > 0 && tiny.exact! < tiny.lin * tiny.lin, `exact ${tiny.exact}`);
    assert.ok(tiny.tris > 0 && !tiny.failed && within(tiny.area, tiny.exact!, 0.5), JSON.stringify(tiny));
    assert.deepEqual(tiny.again, [1, 1]);
    // A face that meshes only healed: from an unhealed build, healed alone.
    const healed = await face('bug24383_224013.stp', 11, 12053, false);
    assert.ok(healed.tris > 0 && !healed.failed, JSON.stringify(healed));
    assert.deepEqual(healed.again, [1, 1]);
    // A face on a torus that meshes only larger and unhealed; with the part built so by the options, at once.
    const torus = await face('OCC5099.stp', 14343, 4306);
    assert.ok(torus.tris > 0 && !torus.failed && within(torus.area, torus.exact!, 0.03), JSON.stringify(torus));
    assert.deepEqual(torus.again, [1, 1]);
    // Moved by its item: the retry larger brought back to the part's size and then moved.
    const moved = await face('OCC5099.stp', 14343, 4306, true, 1, [1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 200, 300]);
    assert.deepEqual(moved.again, [1, 1]);
    for (let i = 0; i < 6; i++) assert.ok(Math.abs(moved.box[i]! - torus.box[i]! - [100, 200, 300][i % 3]!) < 1e-3,
      `moved ${moved.box} for ${torus.box}`);
    const large = await face('OCC5099.stp', 14343, 4306, false, 1024);
    assert.ok(large.tris > 0 && !large.failed && within(large.area, large.exact!, 0.03), JSON.stringify(large));
    assert.deepEqual(large.again, [0, 0]);
  });

/**
 * The model edges (ids) a mesh is open along: edges two or more faces use (by the model) that all have triangles, with
 * a mesh edge on them that only one triangle has; vertices one where their positions are the same numbers, mesh edges
 * placed on model edges by the result's edge polylines.
 */
function openEdges(d: BrepData, r: TessellationResult): number[] {
  const users = new Map<number, Set<number>>();
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    const face = decode.face(d, f);
    for (const l of face.loops) if (l.kind === 'edge') for (const c of l.coedges) {
      const id = decode.edge(d, c.edge).id!;
      (users.get(id) ?? users.set(id, new Set()).get(id)!).add(face.id!);
    }
  }
  const weld = new Map<string, number>();
  const at = (p: Float32Array, i: number) => {
    const k = `${p[3 * i]},${p[3 * i + 1]},${p[3 * i + 2]}`;
    return weld.get(k) ?? (weld.set(k, weld.size), weld.size - 1);
  };
  const key = (a: number, b: number) => `${Math.min(a, b)} ${Math.max(a, b)}`;
  const uses = new Map<string, number>();
  for (let k = 0; k < r.indices.length; k += 3) for (let j = 0; j < 3; j++) {
    const e = key(at(r.positions, r.indices[k + j]!), at(r.positions, r.indices[k + (j + 1) % 3]!));
    uses.set(e, (uses.get(e) ?? 0) + 1);
  }
  const meshed = new Set(r.faces.filter((f) => f.count > 0).map((f) => f.entityId));
  const open = new Set<number>();
  for (const e of r.edges!) {
    const us = e.entityId === null ? undefined : users.get(e.entityId);
    if (!us || us.size < 2 || ![...us].every((f) => meshed.has(f))) continue;
    for (let k = e.start; k + 1 < e.start + e.count; k++) {
      // (A segment from a point to itself, as single precision has some, is no gap.)
      const a = at(r.edgePositions!, k), z = at(r.edgePositions!, k + 1);
      if (a !== z && uses.get(key(a, z)) === 1) open.add(e.entityId!);
    }
  }
  return [...open].sort((a, b) => a - b);
}

/**
 * A mesh's soundness beside its model, each part independent of the backend's own account: the model edges it is
 * open along (openEdges), the count of such edges the backend's error gives, triangles repeated within a face (the
 * same three positions), edge polyline segments that aren't an edge of any triangle, edges two meshed faces use
 * without an edge polyline (which openEdges can't judge), and the triangles the backend says it removed as folded or
 * repeated (which would hide a face emitted twice).
 */
function soundness(d: BrepData, r: TessellationResult) {
  const said = Number(/^(\d+) edges along/.exec(r.diagnostics.find((x) => x.severity === 'error')?.message ?? '')?.[1]
    ?? 0);
  const P = (p: Float32Array, i: number) => `${p[3 * i]},${p[3 * i + 1]},${p[3 * i + 2]}`;
  let repeated = 0;
  const sides = new Set<string>();
  for (const f of r.faces) {
    const seen = new Set<string>();
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const v = [0, 1, 2].map((j) => P(r.positions, r.indices[t + j]!));
      const k = [...v].sort().join(' ');
      if (seen.has(k)) repeated++;
      seen.add(k);
      for (let j = 0; j < 3; j++) sides.add([v[j]!, v[(j + 1) % 3]!].sort().join(' '));
    }
  }
  let stray = 0;
  for (const e of r.edges ?? []) for (let k = e.start; k + 1 < e.start + e.count; k++)
    if (!sides.has([P(r.edgePositions!, k), P(r.edgePositions!, k + 1)].sort().join(' '))) stray++;
  const drawn = new Set((r.edges ?? []).map((e) => e.entityId)), meshed = new Set(r.faces.filter((f) => f.count)
    .map((f) => f.entityId)), users = new Map<number, Set<number>>();
  for (let f = 0; f < rowCount(d, 'face'); f++) {
    const face = decode.face(d, f);
    for (const l of face.loops) if (l.kind === 'edge') for (const c of l.coedges) {
      const id = decode.edge(d, c.edge).id!;
      (users.get(id) ?? users.set(id, new Set()).get(id)!).add(face.id!);
    }
  }
  const unjudged = [...users].filter(([id, us]) => us.size >= 2 && [...us].every((f) => meshed.has(f))
    && !drawn.has(id)).length;
  const folded = Number(/^(\d+) triangles SMLib made twice/.exec(r.diagnostics.find((x) => /made twice/
    .test(x.message))?.message ?? '')?.[1] ?? 0);
  return { open: openEdges(d, r), said, repeated, stray, unjudged, folded };
}

/**
 * Faces of a torus side by side in one open shell (or each in a shell of its own, of one body): between consecutive
 * tube angles vs, over u0 to u1, each sharing its latitude edges (ids 100 + i at vs[i]) and their ends with its
 * neighbours; face ids 1, 2, ... With `instance`, the body placed again by it; with `twice`, the first face in another
 * shell of the body too.
 */
function torusBands(R: number, r: number, u0: number, u1: number, vs: readonly number[], transform?: number[],
  apart = false, instance?: number[], twice = false): BrepData {
  const b = new BrepBuilder();
  const P = (u: number, v: number) => [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u),
    r * Math.sin(v)];
  const torus = b.addSurface({ kind: 'torus', position: XY, majorRadius: R, minorRadius: r });
  const ends = vs.map((v) => [b.addVertex({ point: P(u0, v) }), b.addVertex({ point: P(u1, v) })] as const);
  const latitudes = vs.map((v, i) => b.addEdge({ id: 100 + i, curve: b.addCurve({ kind: 'circle',
    position: { ...XY, origin: [0, 0, r * Math.sin(v)] }, radius: R + r * Math.cos(v) }), start: ends[i]![0],
  end: ends[i]![1], sameSense: true }));
  const meridian = (u: number, a: number, z: number, id: number) => b.addEdge({ id, curve: b.addCurve({
    kind: 'circle', position: { origin: [R * Math.cos(u), R * Math.sin(u), 0], axis: [Math.sin(u), -Math.cos(u), 0],
      xDir: [Math.cos(u), Math.sin(u), 0] }, radius: r }), start: a, end: z, sameSense: true });
  const faces = vs.slice(1).map((_, i) => ({ sense: true, face: b.addFace({ id: i + 1, surface: torus,
    sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [fwd(latitudes[i]!),
      fwd(meridian(u1, ends[i]![1], ends[i + 1]![1], 200 + i)), rev(latitudes[i + 1]!),
      rev(meridian(u0, ends[i]![0], ends[i + 1]![0], 300 + i))] }] }) }));
  const shells = apart ? faces.map((f) => b.addShell({ kind: 'open', faces: [f] })) : [b.addShell({ kind: 'open',
    faces })];
  if (twice) shells.push(b.addShell({ kind: 'open', faces: [faces[0]!] }));
  const item = b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: shells.map((ref) => ({ sense: true,
    ref })) }), ...(transform ? { transform } : {}) });
  if (instance) b.addItem({ kind: 'instance', ref: item, transform: instance });
  return b.finish();
}

test('a face meshed again alone meets its neighbours exactly: shared edges with the same points on both sides',
  { skip }, async () => {
    // The thin strip (29 mm by 0.5 mm inside a torus of 56 and 2, meshed again with shorter edges) between two wider
    // faces: its latitude edges' points and theirs made one set, so no mesh edge along them is one triangle's alone.
    const args = [56, 2, 0, 0.54, [Math.PI - 1, Math.PI - 0.125, Math.PI + 0.125, Math.PI + 1]] as const;
    const d = torusBands(...args), r = await mesh(d, 0.1);
    assert.ok(r.diagnostics.some((x) => /^[1-3] faces meshed badly .*\([1-3] better so\)$/.test(x.message)),
      JSON.stringify(r.diagnostics));
    assert.ok(!r.diagnostics.some((x) => x.severity !== 'info'), JSON.stringify(r.diagnostics));
    assert.deepEqual(soundness(d, r), { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0, folded: 0 });
    // Mirrored (x to -x) by the item's transform: the triangles wound the other way round, the same joins.
    const m = torusBands(...args, [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), rm = await mesh(m, 0.1);
    assert.ok(rm.diagnostics.some((x) => /^[1-3] faces meshed badly/.test(x.message)));
    assert.deepEqual(soundness(m, rm), { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0, folded: 0 });
    assert.equal(sides(m, rm).against, 0);
    // Each face in a shell of its own (one SMLib B-rep each): joined along the edges the shells share, with the strip
    // meshed again and without any face meshed again.
    for (const vs of [args[4], [Math.PI - 1, Math.PI - 0.5, Math.PI, Math.PI + 1]]) {
      const apart = torusBands(56, 2, 0, 0.54, vs, undefined, true), ra = await mesh(apart, 0.1);
      assert.deepEqual(soundness(apart, ra), { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0, folded: 0 },
        `bands ${vs}`);
      for (const id of [101, 102]) assert.deepEqual(ra.edges!.filter((e) => e.entityId === id).map((e) => e.kind),
        ['shared'], `bands ${vs}: edge ${id}`);
    }
    // Placed again by an instance (8 up): each placement joined in itself, not to the other.
    const once = await mesh(torusBands(...args, undefined, true), 0.1);
    const placed = torusBands(...args, undefined, true, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 8]);
    const rp = await mesh(placed, 0.1);
    assert.deepEqual(soundness(placed, rp), { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0, folded: 0 });
    assert.equal(rp.indices.length, 2 * once.indices.length);
    // The first face in a second shell too: measured once.
    const twice = torusBands(...args, undefined, true, undefined, true), rt = await mesh(twice, 0.1);
    assert.deepEqual(rt.measures!.map((m) => [m.entityId, +m.area.toFixed(9)]),
      once.measures!.map((m) => [m.entityId, +m.area.toFixed(9)]));
    const got = areas(r);
    for (const [i, id] of [1, 2, 3].entries()) {
      const want = torusArea(56, 2, 0, 0.54, args[4][i]!, args[4][i + 1]!), a = got.get(id)!.area;
      assert.ok(a > 0.97 * want && a < 1.1 * want, `face ${id}: ${a} for ${want}`);
    }
    // The shared edges once each, as shared ones, their points mesh vertices.
    const at = new Set<string>();
    for (let i = 0; i < r.positions.length; i += 3) at.add(`${r.positions[i]},${r.positions[i + 1]},`
      + `${r.positions[i + 2]}`);
    for (const id of [101, 102]) {
      const es = r.edges!.filter((e) => e.entityId === id);
      assert.deepEqual(es.map((e) => e.kind), ['shared'], `edge ${id}`);
      for (let k = es[0]!.start; k < es[0]!.start + es[0]!.count; k++) assert.ok(at.has(`${r.edgePositions![3 * k]},`
        + `${r.edgePositions![3 * k + 1]},${r.edgePositions![3 * k + 2]}`), `edge ${id} point ${k}`);
    }
    // Triangles still wound along the faces' normals after the splits (outward from the tube's centre line).
    assert.equal(sides(d, r).against, 0);
  });

test('real parts joined exactly: corners moved and triangles split along shared edges, folds and repeats removed',
  { skip: skip || (fs.existsSync(corpus) ? false : 'no corpus (test_corpus/third_party/pull.sh)') }, async () => {
    const part = async (file: string, id: number) => {
      const { scene } = await importStep(new Uint8Array(fs.readFileSync(path.join(corpus, file))));
      const p = scene.parts.find((x) => x.sources[0]!.id === id)!;
      const r = await (await backend()).tessellate({ ...request(p.brep!.model, 0.1), origin: p.origin });
      return { d: p.brep!.model, r, lin: 0.1 };
    };
    // A face meshed again alone whose corners SMLib puts elsewhere than its neighbours' (moved to theirs), on edges
    // where both sides' triangles are split, among them triangles with two sides on the edge: watertight.
    const joined = await part('trj3_s1-tc-214.stp', 2536);
    assert.ok(joined.r.diagnostics.some((x) => /^1 faces meshed badly .*\(1 better so\)$/.test(x.message)));
    assert.deepEqual(soundness(joined.d, joined.r), { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0,
      folded: 0 });
    assert.equal(sides(joined.d, joined.r).against, 0);
    // Corners SMLib puts 0.018 apart in a face's shell and alone, moved to one: watertight.
    const corners = await part('trj3_s1-db-214.stp', 2117);
    assert.deepEqual(soundness(corners.d, corners.r), { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0,
      folded: 0 });
    // One sheet body of 58 open shells of a face each, sharing 14 edges: joined along them.
    const shells = await part('trj4_k1_top-ct-203.stp', 121);
    assert.equal(rowCount(shells.d, 'shell'), 58);
    assert.deepEqual(soundness(shells.d, shells.r), { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0,
      folded: 0 });
    // SMLib's mesh with triangles on the same three points, both wound alike: one of each kept, none repeated.
    const repeats = await part('trj9_ap209-mp.stp', 462);
    const s = soundness(repeats.d, repeats.r);
    assert.ok(s.folded > 0 && s.repeated === 0, JSON.stringify(s));
    assert.equal(areas(repeats.r).size, rowCount(repeats.d, 'face'));
  });

/**
 * A closed cylinder (radius 2, height 5: its side, id 1, and two discs, 2 and 3) in a sheet body, and with `fin` an
 * annulus (id 4, radius 2 to 4) on its top circle (edge 11) in an open shell of the same body.
 */
function finned(fin: boolean): BrepData {
  const b = new BrepBuilder();
  const ring = (z: number, r: number, id: number) => {
    const v = b.addVertex({ point: [r, 0, z] });
    return b.addEdge({ id, start: v, end: v, sameSense: true, curve: b.addCurve({ kind: 'circle', radius: r,
      position: { ...XY, origin: [0, 0, z] } }) });
  };
  const bottom = ring(0, 2, 10), top = ring(5, 2, 11);
  const plane = (z: number, up: boolean) => b.addSurface({ kind: 'plane', position: { origin: [0, 0, z],
    axis: [0, 0, up ? 1 : -1], xDir: [1, 0, 0] } });
  const loop = (...coedges: Coedge[]) => ({ kind: 'edge' as const, bound: 'unknown' as const, sense: true, coedges });
  const side = b.addFace({ id: 1, surface: b.addSurface({ kind: 'cylinder', position: XY, radius: 2 }),
    sameSense: true, loops: [loop(fwd(bottom)), loop(rev(top))] });
  const cap = b.addFace({ id: 2, surface: plane(5, true), sameSense: true, loops: [loop(fwd(top))] });
  const base = b.addFace({ id: 3, surface: plane(0, false), sameSense: true, loops: [loop(rev(bottom))] });
  const shells = [b.addShell({ kind: 'closed', faces: [side, cap, base].map((face) => ({ face, sense: true })) })];
  if (fin) {
    const f = b.addFace({ id: 4, surface: plane(5, true), sameSense: true,
      loops: [loop(fwd(ring(5, 4, 12))), loop(rev(top))] });
    shells.push(b.addShell({ kind: 'open', faces: [{ face: f, sense: true }] }));
  }
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: shells.map((ref) => ({ ref, sense: true })) }) });
  return b.finish();
}

test('a closed shell is never joined to another shell: its mesh the same with an open shell on one of its edges',
  { skip }, async () => {
    // Each face's triangles as their points, in order.
    const points = (r: TessellationResult, ids: number[]) => r.faces.filter((f) => ids.includes(f.entityId!))
      .map((f) => Array.from(r.indices.subarray(f.start, f.start + f.count), (v) => `${r.positions[3 * v]},`
        + `${r.positions[3 * v + 1]},${r.positions[3 * v + 2]}`).join(';'));
    for (const lin of [0.1, 0.01, 0.003]) {
      const alone = await mesh(finned(false), lin), d = finned(true), r = await mesh(d, lin);
      assert.deepEqual(points(r, [1, 2, 3]), points(alone, [1, 2, 3]), `at ${lin}`);
      assert.deepEqual(soundness(finned(false), alone),
        { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0, folded: 0 }, `alone at ${lin}`);
      // (The fin meets the cylinder all the same: SMLib puts the same points on the circle from both shells.)
      assert.deepEqual(soundness(d, r), { open: [], said: 0, repeated: 0, stray: 0, unjudged: 0, folded: 0 },
        `with the fin at ${lin}`);
    }
  });

test('ids as the model has them, up to 2^32 - 1, and none: entity ids null, faces without one unmeasured',
  { skip }, async () => {
    // A unit cube with ids from 2^32 - 100 (vertices + 1 to 8, edges + 9 to 20, faces + 21 to 26), a loose circle
    // and point with ids above 2^31, and a second cube whose ids are all none.
    const b = new BrepBuilder(), base = 2 ** 32 - 100;
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1], [0, 0, 0], base),
      sense: true }] }) });
    b.addItem({ kind: 'curve', ref: b.addCurve({ kind: 'circle', position: XY, radius: 2, id: 2 ** 31 + 5 }) });
    b.addItem({ kind: 'point', point: [9, 8, 7], id: 2 ** 32 - 1 });
    const strip = <T extends object>(rows: T[]) => rows.map((x) => Object.fromEntries(Object.entries(x)
      .filter(([k]) => k !== 'id')) as T);
    const j = brepToJson(MODELS.cube().finish());
    const nameless = brepFromJson({ ...j, vertices: strip(j.vertices), edges: strip(j.edges), faces: strip(j.faces),
      shells: strip(j.shells), bodies: strip(j.bodies), items: strip(j.items) });
    const r = await mesh(b.finish());
    const faces = Array.from({ length: 6 }, (_, j) => base + 21 + j);
    assert.deepEqual(r.faces.map((f) => f.entityId).sort(), faces);
    assert.deepEqual(r.measures!.map((m) => m.entityId).sort(), faces);
    assert.deepEqual([...new Set(r.edges!.map((e) => e.entityId))].sort(), Array.from({ length: 12 },
      (_, j) => base + 9 + j));
    assert.deepEqual(r.curves!.map((c) => c.entityId), [2 ** 31 + 5]);
    assert.deepEqual(r.pointIds, [2 ** 32 - 1]);
    // Ids of 0 (none): faces and edges without one, and no measures.
    const rn = await mesh(nameless);
    assert.equal(rn.faces.length, 6);
    assert.ok(rn.faces.every((f) => f.entityId === null) && rn.edges!.every((e) => e.entityId === null));
    assert.equal(rn.measures, undefined);
  });

test('faces the builder leaves out are counted among the faces that failed to mesh, beside the warning why',
  { skip: skip || (fs.existsSync(corpus) ? false : 'no corpus (test_corpus/third_party/pull.sh)') }, async () => {
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(path.join(corpus,
      'bug22871_null-swept-curve.stp'))));
    const p = scene.parts.find((x) => x.sources[0]!.id === 10)!;
    const r = await (await backend()).tessellate({ ...request(p.brep!.model, 0.1), origin: p.origin });
    // Four of its seven faces left out (edges without a 3D curve), none of the others failing.
    const ids = [...p.brep!.model.face.id].filter((x) => x);
    const meshed = new Set(r.faces.filter((f) => f.count > 0).map((f) => f.entityId));
    assert.equal(ids.filter((id) => !meshed.has(id)).length, 4);
    assert.deepEqual(r.diagnostics.filter((d) => d.severity !== 'info').map((d) => [d.severity, d.message]),
      [['warning', 'SMLib builder: edges without a 3D curve (faces left out)'], ['error', '4 faces failed to mesh']]);
  });

test('a face that fails to mesh is an error; the part, meshed but for it, not failed',
  { skip: skip || (fs.existsSync(corpus) ? false : 'no corpus (test_corpus/third_party/pull.sh)') }, async () => {
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(path.join(corpus, 'bug24383_224013.stp'))));
    const p = scene.parts.find((x) => x.sources[0]!.id === 11)!;
    const r = await (await backend()).tessellate({ ...request(p.brep!.model, 0.1), origin: p.origin });
    const failed = r.diagnostics.find((d) => /^\d+ faces failed to mesh$/.test(d.message));
    assert.equal(failed?.severity, 'error', JSON.stringify(r.diagnostics));
    assert.ok(r.indices.length > 0 && !failedPart(r));
  });
