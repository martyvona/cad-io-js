// B-reps for the edge sampler's tests (edges_test.cpp), beside cad-brep's (packages/cad-brep/test/models.ts): each
// the smallest with the case named. `fixtures.ts` writes them, and cad-brep's, as a header.
import { BrepBuilder } from '../../../cad-brep/src/builder.ts';
import type { Curve } from '../../../cad-brep/src/types.ts';

const AXIS = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
const line2 = (point: number[], direction: number[]): Curve => ({ kind: 'line', point, direction, magnitude: 1 });

function sheet(b: BrepBuilder, face: number): void {
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
}

/**
 * A cylinder's band (radius 2, z 0 to 5) bounded by its two circles alone, no seam edge: the bottom forward, the top
 * reversed, with p-curves (the lines v = 0 and v = 5) or without.
 */
function band(pcurves: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const bottom = b.addCurve({ kind: 'circle', position: AXIS, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, 5] }, radius: 2 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [2, 0, 5] });
  const eb = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true });
  const et = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true });
  const pb = b.addCurve(line2([0, 0], [1, 0])), pt = b.addCurve(line2([0, 5], [1, 0]));
  const face = b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: true,
    loops: [
      { kind: 'edge', bound: 'outer', sense: true,
        coedges: [{ edge: eb, orientation: 'forward', ...(pcurves ? { pcurve: pb } : {}) }] },
      { kind: 'edge', bound: 'inner', sense: true,
        coedges: [{ edge: et, orientation: 'reversed', ...(pcurves ? { pcurve: pt } : {}) }] },
    ] });
  sheet(b, face);
  return b;
}
export const band_ = (): BrepBuilder => band(true);
export const bandByInversion = (): BrepBuilder => band(false);

/**
 * cad-brep's seam cylinder with no p-curves: every use by inversion, the seam's two sides from their neighbours.
 * With `sense` false the face is turned and its loop isn't: the sides its neighbours give break the rule.
 */
function seam(sense: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const bottom = b.addCurve({ kind: 'circle', position: AXIS, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, 5] }, radius: 2 });
  const line = b.addCurve({ kind: 'line', point: [2, 0, 0], direction: [0, 0, 1], magnitude: 1 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [2, 0, 5] });
  const eb = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true });
  const et = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true });
  const es = b.addEdge({ curve: line, start: v0, end: v1, sameSense: true });
  const face = b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: sense,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: eb, orientation: 'forward' }, { edge: es, orientation: 'forward' },
      { edge: et, orientation: 'reversed' }, { edge: es, orientation: 'reversed' }] }] });
  sheet(b, face);
  return b;
}

/**
 * A unit square on z = 0 whose corner (1, 1) vertex is 1e-3 above its two lines (the lines through (1, 1, 0)), and
 * a second square sharing nothing, its vertices exact.
 */
export function offVertex(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-2 });
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 1e-3], [0, 1, 0]];
  const exact = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = corners.map((point) => b.addVertex({ point, tolerance: 2e-3 }));
  const edges = exact.map((a, j) => {
    const c = exact[(j + 1) % 4]!, direction = [c[0]! - a[0]!, c[1]! - a[1]!, 0];
    const line = b.addCurve({ kind: 'line', point: a, direction, magnitude: 1 });
    return b.addEdge({ curve: line, start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true, range: [0, 1] });
  });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: edges.map((edge) => ({ edge, orientation: 'forward' as const })) }] });
  sheet(b, face);
  return b;
}

/**
 * A triangle on a cylinder of radius 2 in (u, v): the bottom arc from u = 0 to pi / 2, a line up to v = 2, and back
 * down a helix that has no 3D curve, only its p-curve (the line from (pi / 2, 2) to (0, 0), its use's range given).
 */
export function pcurveOnly(): BrepBuilder {
  const b = new BrepBuilder();
  const arc = b.addCurve({ kind: 'circle', position: AXIS, radius: 2 });
  const up = b.addCurve({ kind: 'line', point: [0, 2, 0], direction: [0, 0, 1], magnitude: 1 });
  const va = b.addVertex({ point: [2, 0, 0] }), vb = b.addVertex({ point: [0, 2, 0] });
  const vc = b.addVertex({ point: [0, 2, 2] });
  const ea = b.addEdge({ curve: arc, start: va, end: vb, sameSense: true, range: [0, Math.PI / 2] });
  const eu = b.addEdge({ curve: up, start: vb, end: vc, sameSense: true, range: [0, 2] });
  const len = Math.hypot(Math.PI / 2, 2);
  const helix = b.addCurve(line2([Math.PI / 2, 2], [-Math.PI / 2 / len, -2 / len]));
  const eh = b.addEdge({ start: vc, end: va, sameSense: true });
  const face = b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: ea, orientation: 'forward', pcurve: b.addCurve(line2([0, 0], [1, 0])) },
      { edge: eu, orientation: 'forward', pcurve: b.addCurve(line2([Math.PI / 2, 0], [0, 1])) },
      { edge: eh, orientation: 'forward', pcurve: helix, range: [0, len] }] }] });
  sheet(b, face);
  return b;
}

/** A meridian of the unit sphere at longitude u, from the south pole to the north (parameter v, latitude). */
function meridian(b: BrepBuilder, u: number): number {
  const x = [Math.cos(u), Math.sin(u), 0];
  // y = axis x xDir must be +z: axis = xDir x z turned, (sin u, -cos u, 0).
  return b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [Math.sin(u), -Math.cos(u), 0],
    xDir: x }, radius: 1 });
}

/**
 * A lune of the unit sphere between longitudes a and c, pole to pole: up the meridian at c, along the north pole
 * line, down the meridian at a, along the south pole line (the loop jumps along both); no p-curves.
 */
function lune(a: number, c: number): BrepBuilder {
  const b = new BrepBuilder();
  const s = b.addVertex({ point: [0, 0, -1] }), n = b.addVertex({ point: [0, 0, 1] });
  const half: [number, number] = [-Math.PI / 2, Math.PI / 2];
  const ma = b.addEdge({ curve: meridian(b, a), start: s, end: n, sameSense: true, range: half });
  const mc = b.addEdge({ curve: meridian(b, c), start: s, end: n, sameSense: true, range: half });
  const face = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: mc, orientation: 'forward' }, { edge: ma, orientation: 'reversed' }] }] });
  sheet(b, face);
  return b;
}
export const luneQuarter = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4);
/** The lune's west meridian on the sphere's seam (u = 0): its side, by inversion, decided by no neighbour. */
export const luneOnSeam = (): BrepBuilder => lune(0, Math.PI / 2);

/** The unit sphere's cap above latitude pi / 4, bounded by its circle alone (no vertex loop at the pole). */
export function cap(): BrepBuilder {
  const b = new BrepBuilder();
  const r = Math.SQRT1_2;
  const circle = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, r] }, radius: r });
  const v = b.addVertex({ point: [r, 0, r] });
  const e = b.addEdge({ curve: circle, start: v, end: v, sameSense: true });
  const face = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'forward' }] }] });
  sheet(b, face);
  return b;
}

/** A B-spline edge (a quarter-circle-like cubic) on a plane, and a straight edge closing it: curvature varying. */
export function splineEdge(): BrepBuilder {
  const b = new BrepBuilder();
  const poles = [[1, 0, 0], [1, 0.55, 0], [0.55, 1, 0], [0, 1, 0]];
  const spline = b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1], multiplicities: [4, 4], poles,
    closed: false, selfIntersect: false, form: 'unspecified' });
  const chord = b.addCurve({ kind: 'line', point: [0, 1, 0], direction: [Math.SQRT1_2, -Math.SQRT1_2, 0],
    magnitude: 1 });
  const va = b.addVertex({ point: [1, 0, 0] }), vb = b.addVertex({ point: [0, 1, 0] });
  const es = b.addEdge({ curve: spline, start: va, end: vb, sameSense: true, range: [0, 1] });
  const ec = b.addEdge({ curve: chord, start: vb, end: va, sameSense: true, range: [0, Math.SQRT2] });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: es, orientation: 'forward' }, { edge: ec, orientation: 'forward' }] }] });
  sheet(b, face);
  return b;
}

export const seamByInversion = (): BrepBuilder => seam(true);
export const seamFlipped = (): BrepBuilder => seam(false);

/**
 * A triangle on z = 0: a polyline edge with a corner, (0, 0) to (1, 0) to (1, 1) (parameter 0 to 2), and a line
 * back to (0, 0) run against its curve (the line from the origin, its range decreasing).
 */
export function polylineEdge(): BrepBuilder {
  const b = new BrepBuilder();
  const poly = b.addCurve({ kind: 'polyline', points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] });
  const diag = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [Math.SQRT1_2, Math.SQRT1_2, 0],
    magnitude: 1 });
  const v0 = b.addVertex({ point: [0, 0, 0] }), v1 = b.addVertex({ point: [1, 1, 0] });
  const ep = b.addEdge({ curve: poly, start: v0, end: v1, sameSense: true, range: [0, 2] });
  const ed = b.addEdge({ curve: diag, start: v1, end: v0, sameSense: false, range: [Math.SQRT2, 0] });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: ep, orientation: 'forward' }, { edge: ed, orientation: 'forward' }] }] });
  sheet(b, face);
  return b;
}

/**
 * A unit disc on z = 0 bounded by a closed edge with no 3D curve (its p-curve the circle, its use's range 0 to
 * 2 pi), and inside it an internal use of an edge with no curve and no vertices: the p-curve line from (-0.5, 0),
 * its use's range 0.2 to 0.8.
 */
export function pcurveCircle(): BrepBuilder {
  const b = new BrepBuilder();
  const circle = b.addCurve({ kind: 'circle', position: { origin: [0, 0], xDir: [1, 0] }, radius: 1 });
  const slit = b.addCurve(line2([-0.5, 0], [1, 0]));
  const v = b.addVertex({ point: [1, 0, 0] });
  const ec = b.addEdge({ start: v, end: v, sameSense: true });
  const es = b.addEdge({ sameSense: true });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: ec, orientation: 'forward', pcurve: circle, range: [0, 2 * Math.PI] },
      { edge: es, orientation: 'internal', pcurve: slit, range: [0.2, 0.8] }] }] });
  sheet(b, face);
  return b;
}

/**
 * The unit circle's arc from angle -pi / 4 to pi / 4 (through 0, no range given: from its vertices) and its chord
 * back, on z = 0: a segment of area (pi / 2 - 1) / 2.
 */
export function arcSegment(): BrepBuilder {
  const b = new BrepBuilder();
  const r = Math.SQRT1_2;
  const arc = b.addCurve({ kind: 'circle', position: AXIS, radius: 1 });
  const chord = b.addCurve({ kind: 'line', point: [r, r, 0], direction: [0, -1, 0], magnitude: 1 });
  const va = b.addVertex({ point: [r, -r, 0] }), vb = b.addVertex({ point: [r, r, 0] });
  const ea = b.addEdge({ curve: arc, start: va, end: vb, sameSense: true });
  const ec = b.addEdge({ curve: chord, start: vb, end: va, sameSense: true, range: [0, 2 * r] });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: ea, orientation: 'forward' }, { edge: ec, orientation: 'forward' }] }] });
  sheet(b, face);
  return b;
}

export const MODELS = { band: band_, bandByInversion, seamByInversion, offVertex, pcurveOnly, luneQuarter,
  luneOnSeam, cap, splineEdge, seamFlipped, polylineEdge, pcurveCircle, arcSegment };
