// Hand-built B-reps for the tests: each the smallest that has the feature named (a solid's shared edges, a seam with
// its two p-curves, natural bounds, a vertex loop at a pole, a void, poly loops, wires, geometric sets, instances,
// every curve and surface kind).

import { BrepBuilder } from '../src/builder.ts';
import type { Curve, Surface } from '../src/types.ts';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * A box from (0, 0, 0) to `size`, as a closed shell of 6 planes, its 12 edges each shared by two faces (the first use
 * forward, the second reversed), loops counter-clockwise seen from outside. With `void`, a smaller box inside, its
 * shell used reversed (a solid with a void). Source ids after `idBase`: vertices 1-8, edges 9-20, faces 21-26. Faces
 * for which `inside` is true are built inside out (their plane's normal and their loop turned) and used reversed, so
 * the shell still faces out, unless `asBuilt` (the shell then faces in where they are).
 */
export function box(b: BrepBuilder, size: V3 = [1, 2, 3], offset: V3 = [0, 0, 0], idBase = 0,
  inside: (face: number) => boolean = () => false, asBuilt = false): number {
  const corner = (k: number): V3 => [offset[0] + (k & 1 ? size[0] : 0), offset[1] + (k & 2 ? size[1] : 0),
    offset[2] + (k & 4 ? size[2] : 0)];
  const vs = Array.from({ length: 8 }, (_, k) => b.addVertex({ point: corner(k), id: idBase + 1 + k }));
  // Each face's corners counter-clockwise seen from outside.
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const edges = new Map<string, number>(), starts = new Map<string, number>();
  for (const q of quads) for (let j = 0; j < 4; j++) {
    const a = q[j]!, c = q[(j + 1) % 4]!, key = `${Math.min(a, c)},${Math.max(a, c)}`;
    if (edges.has(key)) continue;
    const p = corner(a), d = sub(corner(c), p);
    const line = b.addCurve({ kind: 'line', point: p, direction: unit(d), magnitude: Math.hypot(...d) });
    edges.set(key, b.addEdge({ curve: line, start: vs[a]!, end: vs[c]!, sameSense: true, range: [0, 1],
      id: idBase + 9 + edges.size }));
    starts.set(key, a);
  }
  const faces = quads.map((q0, j) => {
    const q = inside(j) ? [...q0].reverse() : q0;
    const p0 = corner(q[0]!), x = unit(sub(corner(q[1]!), p0)), n = unit(cross(x, sub(corner(q[3]!), p0)));
    // (No -0: JSON, which the round-trip tests go through, has none.)
    const plane = b.addSurface({ kind: 'plane', position: { origin: p0, axis: n.map((c) => c + 0),
      xDir: x.map((c) => c + 0) } });
    const coedges = q.map((a, j) => {
      const c = q[(j + 1) % 4]!, key = `${Math.min(a, c)},${Math.max(a, c)}`;
      return { edge: edges.get(key)!, orientation: starts.get(key) === a ? 'forward' as const : 'reversed' as const };
    });
    return b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }],
      id: idBase + 21 + j });
  });
  return b.addShell({ kind: 'closed', faces: faces.map((face, j) => ({ face, sense: asBuilt || !inside(j) })) });
}

/**
 * Reversed uses: a unit cube whose bottom face is built inside out and used reversed, and a second cube (ids from 100)
 * whose faces are all built inside out, its shell then facing in and used reversed by its solid.
 */
export function reversedUses(): BrepBuilder {
  const b = new BrepBuilder({ unit: 1 });
  const one = box(b, [1, 1, 1], [0, 0, 0], 0, (j) => j === 0);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: one, sense: true }], id: 50 }) });
  const two = box(b, [1, 1, 1], [3, 0, 0], 100, () => true, true);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: two, sense: false }], id: 150 }) });
  return b;
}

/**
 * Faces used both ways and entities without source ids: two unit squares, each used forward by one sheet and reversed
 * by another, the first with no ids at all, the second with ids (vertices 1-4, edges 5-8, face 10); a point without an
 * id and one with id 30.
 */
export function withoutIds(): BrepBuilder {
  const b = new BrepBuilder({ unit: 1 });
  for (const named of [false, true]) {
    const z = named ? 1 : 0;
    const corners: V3[] = [[0, 0, z], [1, 0, z], [1, 1, z], [0, 1, z]];
    const id = (x: number) => (named ? { id: x } : {});
    const vs = corners.map((point, k) => b.addVertex({ point, ...id(1 + k) }));
    const coedges = corners.map((p, k) => {
      const d = sub(corners[(k + 1) % 4]!, p);
      const line = b.addCurve({ kind: 'line', point: p, direction: d, magnitude: 1 });
      return { edge: b.addEdge({ curve: line, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, ...id(5 + k) }),
        orientation: 'forward' as const };
    });
    const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: { origin: [0, 0, z], axis: [0, 0, 1],
      xDir: [1, 0, 0] } }), sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }],
      ...id(10) });
    for (const sense of [true, false]) {
      const shell = b.addShell({ kind: 'open', faces: [{ face, sense }] });
      b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    }
  }
  b.addItem({ kind: 'point', point: [5, 5, 5] });
  b.addItem({ kind: 'point', point: [6, 6, 6], id: 30 });
  return b;
}

/** A unit cube as a solid (one closed shell of 6 faces), the part's one item. */
export function cube(): BrepBuilder {
  const b = new BrepBuilder({ unit: 1, uncertainty: 1e-6 });
  const shell = box(b, [1, 1, 1]);
  const solid = b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }], id: 100 });
  b.addItem({ kind: 'body', ref: solid, id: 101 });
  return b;
}

/** A box with a box-shaped void: the void's shell used reversed. */
export function withVoid(): BrepBuilder {
  const b = new BrepBuilder({ unit: 25.4 });
  const outer = box(b, [4, 4, 4]);
  const inner = box(b, [1, 1, 1], [1, 1, 1], 1000);
  const solid = b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true }, { ref: inner, sense: false }] });
  b.addItem({ kind: 'body', ref: solid });
  return b;
}

/**
 * A cylinder's side, radius 2 from z = 0 to 5, as one face: two circles and a seam line used twice, forward and
 * reversed, each use with its own p-curve (u = 0 and u = 2 pi), the circles' p-curves the lines v = 0 and v = 5.
 */
export function seamCylinder(): BrepBuilder {
  const b = new BrepBuilder({ unit: 1 });
  const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const bottom = b.addCurve({ kind: 'circle', position: axis, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...axis, origin: [0, 0, 5] }, radius: 2 });
  const seam = b.addCurve({ kind: 'line', point: [2, 0, 0], direction: [0, 0, 1], magnitude: 1 });
  const line2 = (point: number[], direction: number[]): Curve => ({ kind: 'line', point, direction, magnitude: 1 });
  const pBottom = b.addCurve(line2([0, 0], [1, 0])), pTop = b.addCurve(line2([0, 5], [1, 0]));
  const pSeam0 = b.addCurve(line2([0, 0], [0, 1])), pSeam1 = b.addCurve(line2([2 * Math.PI, 0], [0, 1]));
  const v0 = b.addVertex({ point: [2, 0, 0], tolerance: 1e-7 }), v1 = b.addVertex({ point: [2, 0, 5] });
  const eBottom = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true, range: [0, 2 * Math.PI] });
  const eTop = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true });
  const eSeam = b.addEdge({ curve: seam, start: v0, end: v1, sameSense: true, tolerance: 1e-7 });
  const cylinder = b.addSurface({ kind: 'cylinder', position: axis, radius: 2 });
  // Around the side: along the bottom, up the seam at u = 2 pi, back along the top, down the seam at u = 0.
  const face = b.addFace({ surface: cylinder, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [
      { edge: eBottom, orientation: 'forward', pcurve: pBottom, range: [0, 2 * Math.PI] },
      { edge: eSeam, orientation: 'forward', pcurve: pSeam1, range: [0, 5] },
      { edge: eTop, orientation: 'reversed', pcurve: pTop },
      { edge: eSeam, orientation: 'reversed', pcurve: pSeam0, range: [0, 5], id: 77 },
    ] }], id: 9 });
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b;
}

/** A whole sphere with no loops (natural bounds), and a hemisphere bounded by its equator and a vertex loop at its
 * pole; a sheet each. */
export function spheres(): BrepBuilder {
  const b = new BrepBuilder({ unit: 1 });
  const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const whole = b.addFace({ surface: b.addSurface({ kind: 'sphere', position, radius: 1 }), sameSense: true,
    loops: [] });
  const equator = b.addCurve({ kind: 'circle', position: { ...position, origin: [10, 0, 0] }, radius: 1 });
  const v = b.addVertex({ point: [11, 0, 0] }), pole = b.addVertex({ point: [10, 0, 1] });
  const e = b.addEdge({ curve: equator, start: v, end: v, sameSense: true });
  const half = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: { ...position, origin: [10, 0, 0] },
    radius: 1 }), sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'forward' }] },
    { kind: 'vertex', bound: 'inner', sense: true, vertex: pole },
  ] });
  for (const face of [whole, half]) {
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  }
  return b;
}

/** A tetrahedron of poly loops (a faceted solid), a wire of two edges, and a face set of a face with no shared
 * topology (an unsewn trimmed surface). */
export function facetedAndWire(): BrepBuilder {
  const b = new BrepBuilder({ unit: 1 });
  const p = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const tris = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];
  const faces = tris.map((t) => b.addFace({ surface: b.addSurface({ kind: 'plane',
    position: { origin: p[t[0]!]!, axis: [0, 0, 1], xDir: [1, 0, 0] } }), sameSense: true,
    loops: [{ kind: 'poly', bound: 'outer', sense: true, points: t.map((k) => p[k]!) }] }));
  const shell = b.addShell({ kind: 'closed', faces: faces.map((face) => ({ face, sense: true })) });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });

  const v = [[5, 0, 0], [6, 0, 0], [6, 1, 0]].map((point) => b.addVertex({ point }));
  const l1 = b.addCurve({ kind: 'line', point: [5, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  const l2 = b.addCurve({ kind: 'line', point: [6, 0, 0], direction: [0, 1, 0], magnitude: 1 });
  const e1 = b.addEdge({ curve: l1, start: v[0]!, end: v[1]!, sameSense: true });
  const e2 = b.addEdge({ curve: l2, start: v[1]!, end: v[2]!, sameSense: true });
  const wire = b.addBody({ kind: 'wire', members: [{ ref: e1, sense: true }, { ref: e2, sense: true }] });
  b.addItem({ kind: 'body', ref: wire });

  const corners = [[10, 0, 0], [11, 0, 0], [11, 1, 0], [10, 1, 0]];
  const sq = corners.map((point) => b.addVertex({ point }));
  const sides = corners.map((a, j) => {
    const c = corners[(j + 1) % 4]!, direction = [c[0]! - a[0]!, c[1]! - a[1]!, 0];
    const line = b.addCurve({ kind: 'line', point: a, direction, magnitude: 1 });
    return b.addEdge({ curve: line, start: sq[j]!, end: sq[(j + 1) % 4]!, sameSense: true });
  });
  const flat = b.addFace({ surface: b.addSurface({ kind: 'plane', position: { origin: [10, 0, 0], axis: [0, 0, 1],
    xDir: [1, 0, 0] } }), sameSense: false, loops: [{ kind: 'edge', bound: 'unknown', sense: true,
    coedges: sides.map((edge) => ({ edge, orientation: 'forward' as const })) }] });
  const set = b.addShell({ kind: 'faceSet', faces: [{ face: flat, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: set, sense: true }] }) });
  return b;
}

/** Every curve and surface kind once (2D curves too), as loose geometry items, with a curve-bounded face (edges
 * without vertices), a point, and an instance placing the cube mirrored. */
export function everyKind(): BrepBuilder {
  const b = new BrepBuilder({ unit: 1, uncertainty: 1e-5 });
  const P = { origin: [1, 2, 3], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const P2 = { origin: [1, 2], xDir: [0, 1] };
  const bs = (dim: 2 | 3, rational: boolean): Curve => ({ kind: 'bspline', degree: 2, knots: [0, 0.5, 1],
    multiplicities: [3, 1, 3], poles: [[0, 0, 0], [1, 1, 0], [2, 0, 1], [3, 1, 1]].map((q) => q.slice(0, dim)),
    ...(rational ? { weights: [1, 0.5, 2, 1] } : {}), closed: false, selfIntersect: null, form: 'unspecified' });
  const curves: Curve[] = [
    { kind: 'line', point: [0, 0, 0], direction: [0, 0.6, 0.8], magnitude: 2.5, id: 501 },
    { kind: 'circle', position: P, radius: 2 },
    { kind: 'ellipse', position: P, semiAxis1: 3, semiAxis2: 1 },
    { kind: 'hyperbola', position: P, semiAxis: 1, semiImagAxis: 2 },
    { kind: 'parabola', position: P, focalDist: -0.5 },
    bs(3, false), bs(3, true),
    { kind: 'polyline', points: [[0, 0, 0], [1, 0, 0], [1, 1, 1]] },
    { kind: 'trimmed', basis: 1, trim1: { parameter: 0, point: [3, 2, 3] }, trim2: { parameter: 1.5 }, sense: true,
      preference: 'parameter' },
    { kind: 'composite', segments: [{ curve: 0, sameSense: true, transition: 'continuous' },
      { curve: 7, sameSense: false, transition: 'discontinuous' }], selfIntersect: false },
    { kind: 'offset', basis: 5, distance: 0.25, selfIntersect: null, refDirection: [0, 1, 0] },
    { kind: 'line', point: [0, 0], direction: [1, 0], magnitude: 1 },
    { kind: 'circle', position: P2, radius: 1 },
    { kind: 'ellipse', position: P2, semiAxis1: 2, semiAxis2: 1 },
    { kind: 'hyperbola', position: P2, semiAxis: 1, semiImagAxis: 1 },
    { kind: 'parabola', position: P2, focalDist: 1 },
    bs(2, false), bs(2, true),
    { kind: 'polyline', points: [[0, 0], [1, 1]] },
    { kind: 'trimmed', basis: 12, trim1: { point: [2, 2] }, trim2: { point: [1, 3] }, sense: false,
      preference: 'cartesian' },
    { kind: 'composite', segments: [{ curve: 11, sameSense: true, transition: 'cont_same_gradient' }],
      selfIntersect: null },
    { kind: 'offset', basis: 16, distance: -0.1, selfIntersect: false },
  ];
  for (const c of curves) b.addCurve(c);
  const surfaces: Surface[] = [
    { kind: 'plane', position: P, id: 601 },
    { kind: 'cylinder', position: P, radius: 1 },
    { kind: 'cone', position: P, radius: 0.5, semiAngle: Math.PI / 6 },
    { kind: 'sphere', position: P, radius: 4 },
    { kind: 'torus', position: P, majorRadius: 5, minorRadius: 1 },
    { kind: 'torus', position: P, majorRadius: 1, minorRadius: 2, selectOuter: true },
    { kind: 'bspline', uDegree: 1, vDegree: 2, uKnots: [0, 1], vKnots: [0, 1], uMultiplicities: [2, 2],
      vMultiplicities: [3, 3], poles: [[[0, 0, 0], [0, 1, 1], [0, 2, 0]], [[1, 0, 0], [1, 1, 1], [1, 2, 0]]],
      uClosed: false, vClosed: null, selfIntersect: false, form: 'unspecified' },
    { kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 2], vKnots: [-1, 1], uMultiplicities: [2, 2],
      vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]]],
      weights: [[1, 2], [0.5, 1]], uClosed: false, vClosed: false, selfIntersect: null, form: 'plane_surf' },
    { kind: 'extrusion', curve: 5, direction: [0, 0, 1], magnitude: 3 },
    { kind: 'revolution', curve: 0, axisOrigin: [0, 0, 0], axisDirection: [1, 0, 0] },
    { kind: 'offset', basis: 6, distance: 0.5, selfIntersect: null },
    { kind: 'rectangularTrimmed', basis: 1, u1: 0, u2: Math.PI, v1: -1, v2: 2, uSense: true, vSense: false },
    { kind: 'curveSwept', curve: 2, directrix: 0, referenceSurface: 0 },
    { kind: 'fixedReferenceSwept', curve: 1, directrix: 0, fixedReference: [0, 1, 0] },
  ];
  for (const s of surfaces) b.addSurface(s);
  // The 3D curves (the first 11) as loose curves.
  for (let k = 0; k < 11; k++) b.addItem({ kind: 'curve', ref: k });
  for (let k = 0; k < surfaces.length; k++) b.addItem({ kind: 'surface', ref: k });
  // A curve-bounded face: one boundary edge with no vertices, a full circle, with a p-curve.
  const e = b.addEdge({ curve: 1, sameSense: true, range: [0, 2 * Math.PI] });
  const f = b.addFace({ surface: 0, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e, orientation: 'forward', pcurve: 12 }] }] });
  b.addItem({ kind: 'face', ref: f, id: 700 });
  b.addItem({ kind: 'point', point: [9, 8, 7], id: 701 });
  const body = b.addItem({ kind: 'body', ref: box2(b) });
  b.addItem({ kind: 'instance', ref: body, transform: [-1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0] });
  return b;
}

function box2(b: BrepBuilder): number {
  const shell = box(b, [1, 1, 1], [20, 0, 0], 2000);
  return b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] });
}

/**
 * A cone's side, as OCCT and BREP files have it: the base circle, a seam line from the apex used twice, and a
 * degenerate edge at the apex (no curve, its p-curve the line v = -1); and a degenerate torus with `selectOuter` false.
 */
export function cone(): BrepBuilder {
  const b = new BrepBuilder({ unit: 1 });
  const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const surface = b.addSurface({ kind: 'cone', position, radius: 1, semiAngle: Math.PI / 4 });
  const base = b.addCurve({ kind: 'circle', position, radius: 1 });
  const seam = b.addCurve({ kind: 'line', point: [0, 0, -1], direction: [Math.SQRT1_2, 0, Math.SQRT1_2],
    magnitude: Math.SQRT2 });
  const line2 = (point: number[], direction: number[]): Curve => ({ kind: 'line', point, direction, magnitude: 1 });
  const pApex = b.addCurve(line2([0, -1], [1, 0]));
  const vb = b.addVertex({ point: [1, 0, 0] }), va = b.addVertex({ point: [0, 0, -1] });
  const eBase = b.addEdge({ curve: base, start: vb, end: vb, sameSense: true });
  const eSeam = b.addEdge({ curve: seam, start: va, end: vb, sameSense: true });
  const eApex = b.addEdge({ start: va, end: va, sameSense: true, degenerate: true, tolerance: 1e-7 });
  const face = b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: eBase, orientation: 'forward' }, { edge: eSeam, orientation: 'reversed' },
    { edge: eApex, orientation: 'forward', pcurve: pApex, range: [2 * Math.PI, 0] },
    { edge: eSeam, orientation: 'forward' }] }] });
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  b.addItem({ kind: 'surface', ref: b.addSurface({ kind: 'torus', position, majorRadius: 1, minorRadius: 3,
    selectOuter: false }) });
  return b;
}

export const MODELS = { cube, withVoid, seamCylinder, spheres, facetedAndWire, everyKind, cone, reversedUses,
  withoutIds };
