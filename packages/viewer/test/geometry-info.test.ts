import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder, writeAnalysis, type BrepData } from 'cad-brep';
import type { Mesh } from 'cad-scene';
import { faceEdges, geometryKind, geometryOf, geometryText, meshVolume, oracleVolume, rowOf, vertexPoint } from '../src/geometry-info.ts';

const XY = { origin: [1, 2, 3], axis: [0, 0, 1], xDir: [1, 0, 0] };

/**
 * A solid of two shells of a face each (the builder makes a shell of each connected piece, and these faces have no
 * edges): an outer one (face 11) and a void (15), each a tetrahedron's triangles in the mesh below; faces of other
 * surfaces beside it (21 to 26), and edges of several curves (31 to 36), a vertex (41).
 */
function model(): BrepData {
  const b = new BrepBuilder();
  const plane = b.addSurface({ kind: 'plane', position: XY });
  const face = (id: number) => b.addFace({ id, surface: plane, sameSense: true, loops: [] });
  const outer = b.addShell({ kind: 'closed', faces: [{ face: face(11) }] });
  const inner = b.addShell({ kind: 'closed', faces: [{ face: face(15) }] });
  b.addBody({ kind: 'solid', members: [{ ref: outer }, { ref: inner }] });
  const surface = (id: number, s: Parameters<BrepBuilder['addSurface']>[0]) => b.addFace({ id,
    surface: b.addSurface(s), sameSense: true, loops: [] });
  surface(21, { kind: 'cylinder', position: XY, radius: 5 });
  surface(22, { kind: 'cone', position: XY, radius: 2, semiAngle: Math.PI / 6 });
  surface(23, { kind: 'torus', position: XY, majorRadius: 10, minorRadius: 2 });
  surface(24, { kind: 'sphere', position: XY, radius: 4 });
  surface(25, { kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 0.5, 1], vKnots: [0, 1],
    uMultiplicities: [3, 1, 3], vMultiplicities: [2, 2],
    poles: Array.from({ length: 4 }, (_, i) => [[i, 0, 0], [i, 1, 0]]), uClosed: false, vClosed: false,
    selfIntersect: false, form: 'unspecified' });
  const cyl = b.addSurface({ kind: 'cylinder', position: XY, radius: 3 });
  surface(26, { kind: 'rectangularTrimmed', basis: cyl, u1: 0, u2: 1, v1: 0, v2: 1, uSense: true, vSense: true });
  const circle = b.addCurve({ kind: 'circle', position: XY, radius: 7 });
  const edge = (id: number, curve?: number) => b.addEdge({ id, ...(curve === undefined ? {} : { curve }),
    sameSense: true });
  edge(31, circle);
  edge(32, b.addCurve({ kind: 'trimmed', basis: circle, trim1: { parameter: 0 }, trim2: { parameter: 1 },
    sense: true, preference: 'parameter' }));
  edge(33, b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [0, 1, 0], magnitude: 1 }));
  edge(34, b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1, 2, 3], multiplicities: [4, 1, 1, 4],
    poles: Array.from({ length: 6 }, (_, i) => [i, 0, 0]), weights: [1, 2, 1, 1, 2, 1], closed: false,
    selfIntersect: false, form: 'unspecified' }));
  edge(35, b.addCurve({ kind: 'ellipse', position: XY, semiAxis1: 3, semiAxis2: 2 }));
  edge(36);
  b.addVertex({ id: 41, point: [1.5, -2, 7.25] });
  return b.finish();
}

test('geometry: kinds for icons (a trimmed or offset one by its basis), rows by id', () => {
  const d = model();
  assert.deepEqual([21, 22, 23, 24, 25, 26, 11].map((id) => geometryKind(d, 'face', id)),
    ['cylinder', 'cone', 'torus', 'sphere', 'bspline', 'cylinder', 'plane']);
  assert.deepEqual([31, 32, 33, 34, 35, 36].map((id) => geometryKind(d, 'edge', id)),
    ['curve:circle', 'curve:circle', 'curve:line', 'curve:bspline', 'curve:ellipse', undefined]);
  assert.equal(geometryKind(d, 'face', 99), undefined);
  assert.equal(rowOf(d, 'vertex', 41), 0);
});

test('geometry: names with their wrappers, outermost first, a word repeated once; deeper than 16, the wrapper', () => {
  const b = new BrepBuilder();
  const face = (id: number, surface: number) => b.addFace({ id, surface, sameSense: true, loops: [] });
  const cyl = b.addSurface({ kind: 'cylinder', position: XY, radius: 3 });
  const trimmed = (basis: number) => b.addSurface({ kind: 'rectangularTrimmed', basis, u1: 0, u2: 1, v1: 0, v2: 1,
    uSense: true, vSense: true });
  const offset = (basis: number) => b.addSurface({ kind: 'offset', basis, distance: 1, selfIntersect: false });
  face(1, cyl);
  face(2, trimmed(cyl));
  face(3, offset(trimmed(cyl)));
  face(4, trimmed(offset(cyl)));
  face(5, trimmed(trimmed(offset(offset(cyl)))));
  let deep = cyl;
  for (let i = 0; i < 16; i++) deep = trimmed(deep);
  face(6, deep);
  face(7, b.addSurface({ kind: 'curveSwept', curve: b.addCurve({ kind: 'circle', position: XY, radius: 1 }),
    directrix: b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [0, 0, 1], magnitude: 1 }),
    referenceSurface: cyl }));
  const bsp = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]]],
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  face(8, offset(bsp));
  const circle = b.addCurve({ kind: 'circle', position: XY, radius: 7 });
  const tc = (basis: number) => b.addCurve({ kind: 'trimmed', basis, trim1: { parameter: 0 },
    trim2: { parameter: 1 }, sense: true, preference: 'parameter' });
  const oc = (basis: number) => b.addCurve({ kind: 'offset', basis, distance: 1, selfIntersect: false,
    refDirection: [0, 0, 1] });
  const edge = (id: number, curve: number) => b.addEdge({ id, curve, sameSense: true });
  edge(11, circle);
  edge(12, tc(circle));
  edge(13, oc(tc(circle)));
  edge(14, tc(tc(circle)));
  let deepC = circle;
  for (let i = 0; i < 16; i++) deepC = oc(deepC);
  edge(15, deepC);
  const d = b.finish();
  const named = (kind: 'face' | 'edge', ids: number[]) => ids.map((id) => {
    const g = geometryOf(d, kind, id);
    return g && `${g.kind}: ${g.name}`;
  });
  assert.deepEqual(named('face', [1, 2, 3, 4, 5, 6, 7, 8]), ['cylinder: cylinder', 'cylinder: trimmed cylinder',
    'cylinder: offset trimmed cylinder', 'cylinder: trimmed offset cylinder', 'cylinder: trimmed offset cylinder',
    'rectangularTrimmed: trimmed surface', 'curveSwept: swept surface', 'bspline: offset B-spline surface']);
  assert.deepEqual(named('edge', [11, 12, 13, 14, 15]), ['curve:circle: circle', 'curve:circle: trimmed circle',
    'curve:circle: offset trimmed circle', 'curve:circle: trimmed circle', 'curve:offset: offset curve']);
  assert.equal(geometryOf(d, 'face', 99), undefined);
});

test("geometry: a face's edges by id: each once (a seam used twice), its edge loops', a vertex loop's none", () => {
  const b = new BrepBuilder();
  const plane = b.addSurface({ kind: 'plane', position: XY });
  const v = [0, 1, 2].map((i) => b.addVertex({ point: [i, i * i, 0] }));
  const line = () => b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  const e = [[51, 0, 1], [52, 1, 2], [53, 2, 0], [0, 0, 2]].map(([id, a, z]) => b.addEdge({ ...(id ? { id } : {}),
    curve: line(), start: v[a!]!, end: v[z!]!, sameSense: true }));
  const use = (edge: number) => ({ edge, orientation: 'forward' as const });
  b.addFace({ id: 60, surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [use(e[0]!), use(e[1]!), use(e[2]!), use(e[1]!)] }, { kind: 'edge', bound: 'inner', sense: true,
    coedges: [use(e[3]!)] }] });
  b.addFace({ id: 61, surface: plane, sameSense: true, loops: [{ kind: 'vertex', bound: 'outer', sense: true,
    vertex: v[0]! }] });
  const d = b.finish();
  assert.deepEqual(faceEdges(d, 60), [51, 52, 53]);
  assert.deepEqual(faceEdges(d, 61), []);
  assert.deepEqual(faceEdges(d, 99), []);
});

test("geometry: Details' words, parameters in millimetres and degrees, B-splines summarized", () => {
  const d = model();
  const face = (id: number) => geometryText(d, 'face', id);
  assert.equal(face(21), 'Surface: cylinder, radius 5 mm, axis (0, 0, 1) through (1, 2, 3)');
  assert.equal(face(22), 'Surface: cone, half-angle 30 degrees, radius 2 mm at its placement, axis (0, 0, 1) ' +
    'through (1, 2, 3)');
  assert.equal(face(23), 'Surface: torus, major radius 10 mm, minor radius 2 mm, axis (0, 0, 1) through (1, 2, 3)');
  assert.equal(face(24), 'Surface: sphere, radius 4 mm, centre (1, 2, 3)');
  // (Knots 0, 0.5, 1: two spans in u; 0, 1 one in v.)
  assert.equal(face(25), 'Surface: B-spline, degree 2 x 1, 4 x 2 control points, 2 x 1 knot spans');
  assert.equal(face(26), 'Surface: trimmed cylinder, radius 3 mm, axis (0, 0, 1) through (1, 2, 3)');
  assert.equal(face(11), 'Surface: plane, normal (0, 0, 1) through (1, 2, 3)');
  const edge = (id: number) => geometryText(d, 'edge', id);
  assert.equal(edge(31), 'Curve: circle, radius 7 mm, centre (1, 2, 3), axis (0, 0, 1)');
  assert.equal(edge(32), 'Curve: trimmed circle, radius 7 mm, centre (1, 2, 3), axis (0, 0, 1)');
  assert.equal(edge(33), 'Curve: line, direction (0, 1, 0)');
  assert.equal(edge(34), 'Curve: rational B-spline, degree 3, 6 control points, 3 knot spans');
  assert.equal(edge(35), 'Curve: ellipse, semi-axes 3 mm and 2 mm, centre (1, 2, 3)');
  assert.equal(edge(36), 'Curve: none in 3D (trimmed in parameter space only)');
  assert.equal(geometryText(d, 'edge', 99), undefined);
  assert.deepEqual(vertexPoint(d, 41), [1.5, -2, 7.25]);
  assert.equal(vertexPoint(d, 99), undefined);
});

/** A tetrahedron's four triangles, its corner at `at`, its legs `s` long; a range each, all of face `id`. */
function tetrahedron(at: number[], s: number, id: number, base: number) {
  const p = [[0, 0, 0], [s, 0, 0], [0, s, 0], [0, 0, s]].map((q) => q.map((x, i) => x + at[i]!));
  const tri = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  return { positions: p.flat(), indices: tri.flat().map((i) => i + base),
    faces: tri.map((_, k) => ({ source: id, start: 3 * k, count: 3 })) };
}

test("volume: each solid's outer shell less its voids, by the analysis's shell volumes and by the mesh", () => {
  const d = model();
  // The oracle's signed volumes (a void's sign whichever way it was given) and errors.
  const analysis = (v: number[]) => writeAnalysis({ analysis: { model: new Uint32Array(8), uncertainty: [NaN],
    measureRelTol: [NaN], measureProject: [0] },
    shell: { volume: v, facing: [0, 0], facingFrom: [0, 0], turned: [0, 0] } });
  assert.deepEqual(oracleVolume(d, analysis([60, 0.01, 7.5, 0.002])), { volume: 52.5, error: 0.012 });
  assert.deepEqual(oracleVolume(d, analysis([-60, 0.01, -7.5, 0.002])), { volume: 52.5, error: 0.012 });
  assert.equal(oracleVolume(d, analysis([60, 0.01, NaN, NaN])), undefined);
  assert.equal(oracleVolume(d, undefined), undefined);
  // The mesh: tetrahedra of legs 6 and 3 (volumes 36 and 4.5), away from the origin, which mustn't matter.
  const a = tetrahedron([10, 20, 30], 6, 11, 0), b = tetrahedron([11, 21, 31], 3, 15, 4);
  const mesh: Mesh = { origin: [100, 0, 0], positions: Float32Array.from([...a.positions, ...b.positions]),
    indices: Uint32Array.from([...a.indices, ...b.indices]),
    faces: [...a.faces, ...b.faces.map((f) => ({ ...f, start: f.start + 12 }))] };
  assert.ok(Math.abs(meshVolume(d, mesh)! - 31.5) < 1e-9, `${meshVolume(d, mesh)}`);
  // A shell's face with no triangles: none.
  assert.equal(meshVolume(d, { ...mesh, faces: mesh.faces.slice(0, 4) }), undefined);
});
