// Test models for healing: a cylinder's side (radius 2, z from 0 to 5) as one face bounded by two circles and a seam
// line used twice, whose p-curves each test gives as it needs (right, parameterized otherwise, off, missing).

import { BrepBuilder, type Curve } from 'cad-brep';

/** A p-curve as a test wants it, with the use's range (NaN: none), or none at all. */
export interface Use {
  pcurve?: Curve;
  range?: [number, number];
}

const line2 = (point: number[], direction: number[], magnitude = 1): Curve => ({ kind: 'line', point, direction,
  magnitude });

/** The right p-curves: the circles' the lines v = 0 and v = 5 by angle, the seam's u = 2 pi and u = 0 by z. */
export const RIGHT: Record<'bottom' | 'seamUp' | 'top' | 'seamDown', Use> = {
  bottom: { pcurve: line2([0, 0], [1, 0]), range: [0, 2 * Math.PI] },
  seamUp: { pcurve: line2([2 * Math.PI, 0], [0, 1]), range: [0, 5] },
  top: { pcurve: line2([0, 5], [1, 0]) },
  seamDown: { pcurve: line2([0, 0], [0, 1]), range: [0, 5] },
};

/**
 * The cylinder's side with RIGHT's p-curves but where `uses` says otherwise. Coedges in order: bottom (forward), the
 * seam up at u = 2 pi (forward), top (reversed), the seam down at u = 0 (reversed). `uncertainty` the part's;
 * `seamStart` the seam line's parameter at z = 0 (its point at z = -seamStart), which RIGHT's seam p-curves assume 0;
 * `vertexTolerance` the bottom vertex's.
 */
export function cylinderSide(uses: Partial<typeof RIGHT> = {}, uncertainty = 1e-6, seamStart = 0,
  vertexTolerance?: number): BrepBuilder {
  const b = new BrepBuilder({ uncertainty });
  const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const bottom = b.addCurve({ kind: 'circle', position: axis, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...axis, origin: [0, 0, 5] }, radius: 2 });
  const seam = b.addCurve({ kind: 'line', point: [2, 0, -seamStart], direction: [0, 0, 1], magnitude: 1 });
  const all = { ...RIGHT, ...uses };
  const pc = (u: Use) => u.pcurve ? b.addCurve(u.pcurve) : undefined;
  const p = { bottom: pc(all.bottom), seamUp: pc(all.seamUp), top: pc(all.top), seamDown: pc(all.seamDown) };
  const v0 = b.addVertex({ point: [2, 0, 0], tolerance: vertexTolerance }), v1 = b.addVertex({ point: [2, 0, 5] });
  const eBottom = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true, range: [0, 2 * Math.PI], id: 11 });
  const eTop = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true, id: 12 });
  const eSeam = b.addEdge({ curve: seam, start: v0, end: v1, sameSense: true, id: 13 });
  const cylinder = b.addSurface({ kind: 'cylinder', position: axis, radius: 2 });
  const face = b.addFace({ surface: cylinder, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [
      { edge: eBottom, orientation: 'forward', pcurve: p.bottom, range: all.bottom.range, id: 21 },
      { edge: eSeam, orientation: 'forward', pcurve: p.seamUp, range: all.seamUp.range, id: 22 },
      { edge: eTop, orientation: 'reversed', pcurve: p.top, range: all.top.range, id: 23 },
      { edge: eSeam, orientation: 'reversed', pcurve: p.seamDown, range: all.seamDown.range, id: 24 },
    ] }], id: 9 });
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b;
}

export { line2 };

/**
 * A face on the plane z = 0 (u = x, v = y) bounded by a rational quadratic B-spline from (0, 0) to (2, 0) through
 * the pole (1, 1) (weights 1, 0.5, 2: not symmetric) and the line back; `arc` the arc's coedge's p-curve (default the
 * arc itself in (u, v), the same parameter), `range` its use's; `lift` the arc's middle pole's z (its curve then off
 * the plane by up to about lift / 2).
 */
export function planeArc(arc?: Curve, range?: [number, number], lift = 0): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const curve3 = b.addCurve(rationalArc([[0, 0, 0], [1, 1, lift], [2, 0, 0]], [1, 0.5, 2]));
  const back = b.addCurve({ kind: 'line', point: [2, 0, 0], direction: [-1, 0, 0], magnitude: 1 });
  const p = b.addCurve(arc ?? rationalArc([[0, 0], [1, 1], [2, 0]], [1, 0.5, 2]));
  const v0 = b.addVertex({ point: [0, 0, 0] }), v1 = b.addVertex({ point: [2, 0, 0] });
  const eArc = b.addEdge({ curve: curve3, start: v0, end: v1, sameSense: true, id: 31 });
  const eBack = b.addEdge({ curve: back, start: v1, end: v0, sameSense: true, id: 32 });
  const face = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: eArc, orientation: 'forward', pcurve: p, range, id: 41 },
      { edge: eBack, orientation: 'forward', id: 42 }] }], id: 8 });
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b;
}

/** A rational quadratic B-spline (one span over knots [0, 1] unless given). */
export function rationalArc(poles: number[][], weights: number[], knots: [number, number] = [0, 1]): Curve {
  return { kind: 'bspline', degree: 2, knots, multiplicities: [3, 3], poles, weights, closed: false,
    selfIntersect: false, form: 'unspecified' };
}

/** A disk on the plane z = 0: one circle of radius 1 about the origin, its p-curve `pcurve` (default the circle in
 * (u, v), the same parameter). */
export function planeDisk(pcurve?: Curve): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const plane = b.addSurface({ kind: 'plane', position });
  const circle = b.addCurve({ kind: 'circle', position, radius: 1 });
  const p = b.addCurve(pcurve ?? { kind: 'circle', position: { origin: [0, 0], xDir: [1, 0] }, radius: 1 });
  const v = b.addVertex({ point: [1, 0, 0] });
  const e = b.addEdge({ curve: circle, start: v, end: v, sameSense: true, id: 51 });
  const face = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e, orientation: 'forward', pcurve: p, id: 61 }] }], id: 7 });
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b;
}

/**
 * A quarter of the unit sphere's upper half and more: bounded by a meridian from (1, 0, 0) over the north pole to
 * (-1, 0, 0) and the equator's half back through (0, -1, 0). The meridian's p-curve `meridian` (default none) with its
 * use's `range`, its projection three pieces (u jumps by pi at the pole).
 */
export function sphereOverPole(meridian?: Curve, range?: [number, number]): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const sphere = b.addSurface({ kind: 'sphere', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  // (cos t, 0, sin t): axis -y, so y' = axis x xDir = +z.
  const arc = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [0, -1, 0], xDir: [1, 0, 0] },
    radius: 1 });
  const equator = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const p = meridian ? b.addCurve(meridian) : undefined;
  const va = b.addVertex({ point: [1, 0, 0] }), vb = b.addVertex({ point: [-1, 0, 0] });
  const e1 = b.addEdge({ curve: arc, start: va, end: vb, sameSense: true, id: 71 });
  const e2 = b.addEdge({ curve: equator, start: vb, end: va, sameSense: true, id: 72 });
  const face = b.addFace({ surface: sphere, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e1, orientation: 'forward', pcurve: p, range, id: 81 },
      { edge: e2, orientation: 'forward', id: 82 }] }],
  id: 6 });
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b;
}

/**
 * A cylinder of radius 2 from z = 0 to 5 as a B-spline surface: u a rational quadratic full circle over [0, 1] (nine
 * poles; closed in fact, so the face API finds period 1, which the surface's row doesn't have), v = z, degree 1. One
 * face round its side like cylinderSide's; the circles' p-curves left out, the seam's up use's `seamUp` with its use's
 * `range`, the down use's u = 0, v = t.
 */
export function bsplineCylinder(seamUp: Curve, range?: [number, number]): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const h = Math.SQRT1_2, ring = [[2, 0], [2, 2], [0, 2], [-2, 2], [-2, 0], [-2, -2], [0, -2], [2, -2], [2, 0]];
  const w = [1, h, 1, h, 1, h, 1, h, 1];
  const surface = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 0.25, 0.5, 0.75, 1],
    vKnots: [0, 5], uMultiplicities: [3, 2, 2, 2, 3], vMultiplicities: [2, 2],
    poles: ring.map(([x, y]) => [[x!, y!, 0], [x!, y!, 5]]), weights: w.map((x) => [x, x]), uClosed: false,
    vClosed: false, selfIntersect: false, form: 'unspecified' });
  const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const bottom = b.addCurve({ kind: 'circle', position: axis, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...axis, origin: [0, 0, 5] }, radius: 2 });
  const seam = b.addCurve({ kind: 'line', point: [2, 0, 0], direction: [0, 0, 1], magnitude: 1 });
  const pUp = b.addCurve(seamUp), pDown = b.addCurve(line2([0, 0], [0, 1]));
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [2, 0, 5] });
  const eBottom = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true, id: 11 });
  const eTop = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true, id: 12 });
  const eSeam = b.addEdge({ curve: seam, start: v0, end: v1, sameSense: true, id: 13 });
  const face = b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: eBottom, orientation: 'forward', id: 21 },
    { edge: eSeam, orientation: 'forward', pcurve: pUp, range, id: 22 },
    { edge: eTop, orientation: 'reversed', id: 23 },
    { edge: eSeam, orientation: 'reversed', pcurve: pDown, id: 24 },
  ] }], id: 9 });
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b;
}
