// B-reps for the edge sampler's tests (edges_test.cpp), beside cad-brep's (packages/cad-brep/test/models.ts): each
// the smallest with the case named. `fixtures.ts` writes them, and cad-brep's, as a header.
import { BrepBuilder } from '../../../cad-brep/src/builder.ts';
import type { Coedge, Curve } from '../../../cad-brep/src/types.ts';
import { ANALYSIS_TABLES } from '../../../cad-brep/src/analysis-layout.ts';
import { type AnalysisRows, writeAnalysis } from '../../../cad-brep/src/analysis.ts';

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
function band(pcurves: boolean, sense = true): BrepBuilder {
  const b = new BrepBuilder();
  const bottom = b.addCurve({ kind: 'circle', position: AXIS, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, 5] }, radius: 2 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [2, 0, 5] });
  const eb = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true });
  const et = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true });
  const pb = b.addCurve(line2([0, 0], [1, 0])), pt = b.addCurve(line2([0, 5], [1, 0]));
  // (With `sense` false, a bore: the face's normal inward, its loops run the other way, the face still on their left.)
  const face = b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: sense,
    loops: [
      { kind: 'edge', bound: 'outer', sense: true,
        coedges: [{ edge: eb, orientation: sense ? 'forward' : 'reversed', ...(pcurves ? { pcurve: pb } : {}) }] },
      { kind: 'edge', bound: 'inner', sense: true,
        coedges: [{ edge: et, orientation: sense ? 'reversed' : 'forward', ...(pcurves ? { pcurve: pt } : {}) }] },
    ] });
  sheet(b, face);
  return b;
}
export const band_ = (): BrepBuilder => band(true);
export const bandByInversion = (): BrepBuilder => band(false);
export const bore = (): BrepBuilder => band(false, false);

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
 * pcurveOnlyWest: its mirror across the seam, the arc from 3 pi / 2 to 2 pi and the helix's p-curve from
 * (3 pi / 2, 2) to (2 pi, 0), no range given: its parameters at its vertices by inversion, the seam vertex's foot
 * the copy at u = 2 pi.
 */
export function pcurveOnly(west = false): BrepBuilder {
  const b = new BrepBuilder();
  const arc = b.addCurve({ kind: 'circle', position: AXIS, radius: 2 });
  const s = west ? -1 : 1, u0 = west ? 2 * Math.PI : 0, u1 = u0 + s * Math.PI / 2;
  const up = b.addCurve({ kind: 'line', point: [0, 2 * s, 0], direction: [0, 0, 1], magnitude: 1 });
  const va = b.addVertex({ point: [2, 0, 0] }), vb = b.addVertex({ point: [0, 2 * s, 0] });
  const vc = b.addVertex({ point: [0, 2 * s, 2] });
  const ea = west ? b.addEdge({ curve: arc, start: vb, end: va, sameSense: true, range: [u1, u0] })
    : b.addEdge({ curve: arc, start: va, end: vb, sameSense: true, range: [0, Math.PI / 2] });
  const eu = b.addEdge({ curve: up, start: vb, end: vc, sameSense: true, range: [0, 2] });
  const len = Math.hypot(Math.PI / 2, 2);
  const helix = b.addCurve(line2([u1, 2], [-s * Math.PI / 2 / len, -2 / len]));
  const eh = b.addEdge({ start: vc, end: va, sameSense: true });
  const coedges: Coedge[] = west ? [
    { edge: ea, orientation: 'forward', pcurve: b.addCurve(line2([0, 0], [1, 0])) },
    { edge: eh, orientation: 'reversed', pcurve: helix },
    { edge: eu, orientation: 'reversed', pcurve: b.addCurve(line2([u1, 0], [0, 1])) }] : [
    { edge: ea, orientation: 'forward', pcurve: b.addCurve(line2([0, 0], [1, 0])) },
    { edge: eu, orientation: 'forward', pcurve: b.addCurve(line2([Math.PI / 2, 0], [0, 1])) },
    { edge: eh, orientation: 'forward', pcurve: helix, range: [0, len] }];
  const face = b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] });
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
 * line, down the meridian at a, along the south pole line (the loop jumps along both); no p-curves. `off` and
 * `offC` move the south vertex off the pole across the meridians at a and at c, a rounding's worth.
 */
function lune(a: number, c: number, off = 0, offC = 0): BrepBuilder {
  const b = new BrepBuilder();
  const s = b.addVertex({ point: [-off * Math.sin(a) - offC * Math.sin(c), off * Math.cos(a) + offC * Math.cos(c),
    -1] });
  const n = b.addVertex({ point: [0, 0, 1] });
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
/**
 * luneQuarter with its south vertex 1e-11 off the pole either way across the meridian at pi / 4 (its last sample
 * then the pole line's first point but for that) or at 3 pi / 4 (its first sample the pole line's last): the 3D turn
 * between them that rounding's sign.
 */
export const luneOffPole = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4, 1e-11);
export const luneOffPoleBack = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4, -1e-11);
export const luneOffPoleC = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4, 0, 1e-11);
export const luneOffPoleCBack = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4, 0, -1e-11);

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

/**
 * A cap of radius 0.2 about the north pole of a sphere of radius 10 under an uncertainty of 1: its one edge loop all
 * within the tolerance of the pole, so nothing to mesh (trj3_s1-al-214's caps).
 */
export function capWithinPole(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1 });
  const z = Math.sqrt(100 - 0.04);
  const circle = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] }, radius: 0.2 });
  const v = b.addVertex({ point: [0.2, 0, z] });
  const e = b.addEdge({ curve: circle, start: v, end: v, sameSense: true });
  const face = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 10 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'forward' }] }] });
  sheet(b, face);
  return b;
}

/**
 * A band 0.003 wide on a sphere of radius 4.5, between its equator and the parallel 0.003 above (bug27894's strips'
 * shape, about their own axis): at 0.1 mm its circles' chords bow further than the band is wide, so the triangles
 * across it, every corner on the boundary, are turned off the surface until the circles are sampled finer. Area
 * 2 pi R 0.003.
 */
export function thinBand(): BrepBuilder {
  const b = new BrepBuilder();
  const R = 4.5, h = 0.003, r = Math.sqrt(R * R - h * h);
  const circle = (z: number, radius: number) => b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] },
    radius });
  const v0 = b.addVertex({ point: [R, 0, 0] }), v1 = b.addVertex({ point: [r, 0, h] });
  const e0 = b.addEdge({ curve: circle(0, R), start: v0, end: v0, sameSense: true });
  const e1 = b.addEdge({ curve: circle(h, r), start: v1, end: v1, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: R }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e0, orientation: 'forward' }] },
      { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: e1, orientation: 'reversed' }] }] }));
  return b;
}

/**
 * A flat ring 0.002 wide (circles of radius 1.002 and 1 about one centre), the inner circle's vertex half a turn from
 * the outer's: at a deflection far over the width, each circle's chords cross the other's many times in (u, v).
 */
export function thinRing(): BrepBuilder {
  const b = new BrepBuilder();
  const circle = (radius: number, xDir: number[]) => b.addCurve({ kind: 'circle',
    position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir }, radius });
  const v0 = b.addVertex({ point: [1.002, 0, 0] }), v1 = b.addVertex({ point: [-1, 0, 0] });
  const e0 = b.addEdge({ curve: circle(1.002, [1, 0, 0]), start: v0, end: v0, sameSense: true });
  const e1 = b.addEdge({ curve: circle(1, [-1, 0, 0]), start: v1, end: v1, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e0, orientation: 'forward' }] },
      { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: e1, orientation: 'reversed' }] }] }));
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

/**
 * A plane face under a cubic Bezier with a cusp: poles (1, 0), (0, 1), (1, 1), (0, 0), its speed 0 at t = 0.5, the
 * point (0.5, 0.75) (not a singularity the curve reports), and the line back along the x axis.
 */
export function cuspEdge(near = 0): BrepBuilder {
  const b = new BrepBuilder();
  const spline = b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1], multiplicities: [4, 4],
    poles: [[1, 0, 0], [0, 1, 0], [1 + near, 1, 0], [0, 0, 0]], closed: false, selfIntersect: false,
    form: 'unspecified' });
  const line = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  const va = b.addVertex({ point: [1, 0, 0] }), vb = b.addVertex({ point: [0, 0, 0] });
  const es = b.addEdge({ curve: spline, start: va, end: vb, sameSense: true, range: [0, 1] });
  const el = b.addEdge({ curve: line, start: vb, end: va, sameSense: true, range: [0, 1] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: es, orientation: 'forward' }, { edge: el, orientation: 'forward' }] }] }));
  return b;
}

export const nearCusp6 = (): BrepBuilder => cuspEdge(1e-6);
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
 * A flat bilinear B-spline patch over [0, 1]^2 on z = 0 under an uncertainty of 0.1, a loop whose corner (1.05, 0.01)
 * and the polyline's sample before it (1.03, 0.011, 0.02 away: within min(0.1, d / 10) at d = 0.5) lie past its
 * u = 1 side: both feet clamped onto it, the side then run up to (1.05, 0.5), so the loop would reverse there in
 * (u, v) though it turns in 3D (LMP1 #1044101's corner). clampedCornerTight: the same under an uncertainty of 0.01,
 * the sample past it.
 */
export function clampedCorner(uncertainty = 0.1): BrepBuilder {
  const b = new BrepBuilder({ uncertainty });
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]]],
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const A = [0.5, 0.02, 0], P = [1.03, 0.011, 0], B = [1.05, 0.01, 0], C = [1.05, 0.5, 0];
  const va = b.addVertex({ point: A }), vb = b.addVertex({ point: B }), vc = b.addVertex({ point: C });
  const poly = b.addEdge({ curve: b.addCurve({ kind: 'polyline', points: [A, P, B] }), start: va, end: vb,
    sameSense: true, range: [0, 2] });
  const line = (p: number[], q: number[], start: number, end: number) => b.addEdge({ curve: b.addCurve({
    kind: 'line', point: p, direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0], magnitude: 1 }), start, end,
    sameSense: true, range: [0, 1] });
  const up = line(B, C, vb, vc), back = line(C, A, vc, va);
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [poly, up, back].map((edge) => ({ edge, orientation: 'forward' as const })) }] }));
  return b;
}

/**
 * A flat bilinear B-spline patch over [0, 1]^2 on z = 0 under an uncertainty of 0.01, a square loop from u = 0.2 to
 * 0.8 whose top edge, a polyline 0.001 past v = 1 (its feet clamped onto that side), steps back along it: 0.8, 0.52,
 * 0.53 (0.0005 further out), 0.54, 0.5, 0.2 in u (LMP1 #1054461's edge #543108, its curve wandering along it).
 * lineWobble: the same at
 * y = 0.9, inside the patch, its loop reversing on a line nothing clamps it to.
 */
export function sideWobble(y = 1.001): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.01 });
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]]],
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const c = [[0.2, 0.2, 0], [0.8, 0.2, 0], [0.8, y, 0], [0.2, y, 0]];
  const vs = c.map((point) => b.addVertex({ point }));
  const line = (j: number) => {
    const p = c[j]!, q = c[(j + 1) % 4]!;
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0],
      magnitude: 1 }), start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true, range: [0, 1] });
  };
  // (The sample stepping back 0.0005 further out past the side: off the bridging chord in 3D, its foot still on it.)
  const back = [0.53, y > 1 ? y + 5e-4 : y, 0];
  const top = b.addEdge({ curve: b.addCurve({ kind: 'polyline', points: [c[2]!, [0.52, y, 0], back, [0.54, y, 0],
    [0.5, y, 0], c[3]!] }), start: vs[2]!, end: vs[3]!, sameSense: true, range: [0, 5] });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [line(0), line(1), top, line(3)].map((edge) => ({ edge, orientation: 'forward' as const })) }] }));
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
 * A disc of radius 3 on z = 0 under an uncertainty of 0.005, its edge the circle about the origin, its given p-curve
 * the same circle shifted by 0.3 in u: within 100 x the tolerance of the edge's points (so used), past the tolerance
 * (so its inside samples polished onto their points), as tr9_r1001-ec #11's planes have theirs.
 */
export function pcurveShifted(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.005 });
  const v = b.addVertex({ point: [3, 0, 0] });
  const e = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 3 }), start: v, end: v,
    sameSense: true, range: [0, 2 * Math.PI] });
  const pc = b.addCurve({ kind: 'circle', position: { origin: [0.3, 0], xDir: [1, 0] }, radius: 3 });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: e, orientation: 'forward', pcurve: pc }] }] }));
  return b;
}

/**
 * pcurveShifted's disc with its p-curve 0.003 off in u, within the tolerance (0.005): kept as given, unless healing
 * made it (pcurveNearHealed's analysis), when it's placed as a projection is, its samples at their points' feet.
 */
export function pcurveNear(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.005 });
  const v = b.addVertex({ point: [3, 0, 0] });
  const e = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 3 }), start: v, end: v,
    sameSense: true, range: [0, 2 * Math.PI] });
  const pc = b.addCurve({ kind: 'circle', position: { origin: [0.003, 0], xDir: [1, 0] }, radius: 3 });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: e, orientation: 'forward', pcurve: pc }] }] }));
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

/**
 * Two unit squares folded 45 degrees along x = 1: the first on z = 0, the second rising from that edge, its plane
 * built facing down and used with sense false (so both face up and out): their normals 45 degrees apart along it.
 */
export function fold(): BrepBuilder {
  const b = new BrepBuilder();
  const c = Math.SQRT1_2;
  const p = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [1 + c, 0, c], [1 + c, 1, c]];
  const v = p.map((point) => b.addVertex({ point }));
  const edge = (i: number, j: number) => {
    const d = [p[j]![0]! - p[i]![0]!, p[j]![1]! - p[i]![1]!, p[j]![2]! - p[i]![2]!];
    const line = b.addCurve({ kind: 'line', point: p[i]!, direction: d, magnitude: 1 });
    return b.addEdge({ curve: line, start: v[i]!, end: v[j]!, sameSense: true, range: [0, 1] });
  };
  const e01 = edge(0, 1), e12 = edge(1, 2), e23 = edge(2, 3), e30 = edge(3, 0);
  const e14 = edge(1, 4), e45 = edge(4, 5), e52 = edge(5, 2);
  const flat = b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: [e01, e12, e23, e30].map((edge) =>
      ({ edge, orientation: 'forward' as const })) }] });
  const up = b.addFace({ surface: b.addSurface({ kind: 'plane', position: { origin: [1, 0, 0], axis: [c, 0, -c],
    xDir: [0, 1, 0] } }), sameSense: false, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: e14, orientation: 'forward' }, { edge: e45, orientation: 'forward' },
    { edge: e52, orientation: 'forward' }, { edge: e12, orientation: 'reversed' }] }] });
  const shell = b.addShell({ kind: 'open', faces: [{ face: flat, sense: true }, { face: up, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b;
}

/** A twisted bilinear B-spline patch, (0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 1): curved by S_uv alone. */
/**
 * A bump: a bicubic B-spline over [0, 10]^2 (7 x 7 poles on a grid 10 / 6 apart), flat but for two inner poles raised
 * by 3, so its curvature runs from 0 at the sides to sharp at the bump. Bounded by its four sides (lines). With
 * `half`, the poles raised are row i = 1's middle three, whose support ends at the knot u = 2: curved below it, a
 * plane above.
 */
export function bumpPatch(half = false): BrepBuilder {
  const b = new BrepBuilder();
  const raised = (i: number, j: number) => (half ? i === 1 && j >= 2 && j <= 4 : i === 3 && (j === 3 || j === 4));
  const poles = [0, 1, 2, 3, 4, 5, 6].map((i) => [0, 1, 2, 3, 4, 5, 6].map((j) =>
    [i * 10 / 6, j * 10 / 6, raised(i, j) ? 3 : 0]));
  const s = b.addSurface({ kind: 'bspline', uDegree: 3, vDegree: 3, uKnots: [0, 1, 2, 3, 4],
    vKnots: [0, 1, 2, 3, 4], uMultiplicities: [4, 1, 1, 1, 4], vMultiplicities: [4, 1, 1, 1, 4], poles, uClosed: false,
    vClosed: false, selfIntersect: false, form: 'unspecified' });
  const corners = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], uv = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const coedges = [0, 1, 2, 3].map((k) => {
    const p = corners[k]!, q = corners[(k + 1) % 4]!;
    const line = b.addCurve({ kind: 'line', point: p, direction: q.map((x, i) => (x - p[i]!) / 10), magnitude: 1 });
    const edge = b.addEdge({ curve: line, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, range: [0, 10] });
    const [a, c] = [uv[k]!, uv[(k + 1) % 4]!];
    const pcurve = b.addCurve({ kind: 'line', point: a, direction: [(c[0]! - a[0]!) / 4, (c[1]! - a[1]!) / 4],
      magnitude: 0.4 });
    return { edge, orientation: 'forward' as const, pcurve };
  });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A sine sheet: a bicubic B-spline on uniform clamped knots over [0, l]^2, its poles a grid a quarter of the
 * wavelength w apart at height a sin(2 pi x / w) sin(2 pi y / w) (a smoothed egg crate, its boundary at z = 0 where l
 * is a multiple of w), bounded by its four sides as lines with p-curves. Delaunay refinement over so regular a grid
 * puts a refused triangle's circumcentre on a vertex already there.
 */
export function sineSheet(l = 20, w = 5, a = 0.5): BrepBuilder {
  const b = new BrepBuilder();
  const n = Math.round(4 * l / w) + 1, spans = n - 3;
  const poles = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    const x = i * w / 4, y = j * w / 4;
    return [x, y, a * Math.sin(2 * Math.PI * x / w) * Math.sin(2 * Math.PI * y / w)];
  }));
  const knots = Array.from({ length: spans + 1 }, (_, k) => k);
  const mults = knots.map((k) => (k === 0 || k === spans ? 4 : 1));
  const s = b.addSurface({ kind: 'bspline', uDegree: 3, vDegree: 3, uKnots: knots, vKnots: knots,
    uMultiplicities: mults, vMultiplicities: mults, poles, uClosed: false, vClosed: false, selfIntersect: false,
    form: 'unspecified' });
  const corners = [[0, 0, 0], [l, 0, 0], [l, l, 0], [0, l, 0]], uv = [[0, 0], [spans, 0], [spans, spans], [0, spans]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const coedges = [0, 1, 2, 3].map((k) => {
    const p = corners[k]!, q = corners[(k + 1) % 4]!;
    const line = b.addCurve({ kind: 'line', point: p, direction: q.map((x, i) => (x - p[i]!) / l), magnitude: 1 });
    const edge = b.addEdge({ curve: line, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, range: [0, l] });
    const [c0, c1] = [uv[k]!, uv[(k + 1) % 4]!];
    const pcurve = b.addCurve({ kind: 'line', point: c0, direction: [(c1[0]! - c0[0]!) / spans,
      (c1[1]! - c0[1]!) / spans], magnitude: spans / l });
    return { edge, orientation: 'forward' as const, pcurve };
  });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A roof: a ruled B-spline (degree 1 both ways, a simple knot at u = 1/2: C0 there) over x = 10 u, y = 4 v, its ridge
 * z = h at u = 1/2 between two planes (h 2: 21.8 degrees up and down, normals 43.6 apart): one crease along v. The
 * face is u in [u0, u1], v in [0, 1]; its sides along u are each one edge (a polyline through the ridge, degree 1
 * with its knot there) or, with `junction`, two lines meeting at a vertex on the ridge.
 */
export function roof(u0 = 0, u1 = 1, junction = false, h = 2, rotate = 0, bend = 0): BrepBuilder {
  const b = new BrepBuilder();
  const P = (u: number, v: number) => [10 * u, 4 * v, u <= 0.5 ? 2 * h * u : 2 * h * (1 - u)];
  const poles = [0, 0.5, 1].map((u) => [0, 1].map((v) => P(u, v)));
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 0.5, 1], vKnots: [0, 1],
    uMultiplicities: [2, 1, 2], vMultiplicities: [2, 2], poles, uClosed: false, vClosed: false, selfIntersect: false,
    form: 'unspecified' });
  const corner = (u: number, v: number) => b.addVertex({ point: P(u, v) });
  const v00 = corner(u0, 0), v10 = corner(u1, 0), v11 = corner(u1, 1), v01 = corner(u0, 1);
  const crosses = u0 < 0.5 && u1 > 0.5;
  // A side along u at v from ua to ub: its coedges (forward along the loop).
  const along = (v: number, ua: number, ub: number, va: number, vb: number) => {
    const piece = (pa: number, pb: number, start: number, end: number) => {
      // (At a junction the edges end at its vertex, off the surface: their samples there not the surface's point.)
      const at = (q: number) => (junction && q === 0.5 ? [P(q, v)[0]!, P(q, v)[1]!, P(q, v)[2]! + 1e-7] : P(q, v));
      const A = at(pa), B = at(pb), d = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!];
      const line = b.addCurve({ kind: 'line', point: A, direction: d, magnitude: 1 });
      const pcurve = b.addCurve(line2([pa, v], [pb - pa, 0]));
      return { edge: b.addEdge({ curve: line, start, end, sameSense: true, range: [0, 1] }),
        orientation: 'forward' as const, pcurve };
    };
    if (!crosses) return [piece(ua, ub, va, vb)];
    if (junction) {
      // (The vertex 1e-7 off the surface, as real data's are within their tolerance: its point not the surface's.)
      const ridge = P(0.5, v), mid = b.addVertex({ point: [ridge[0]!, ridge[1]!, ridge[2]! + 1e-7] });
      return [piece(ua, 0.5, va, mid), piece(0.5, ub, mid, vb)];
    }
    // One edge through the ridge: a polyline, its parameter the fraction of the way from ua to ub.
    const curve = b.addCurve({ kind: 'bspline', degree: 1, knots: [0, (0.5 - ua) / (ub - ua), 1],
      multiplicities: [2, 1, 2], poles: [P(ua, v), P(0.5, v), P(ub, v)], closed: false, selfIntersect: false,
      form: 'unspecified' });
    // (`bend`: the p-curve a quadratic bowed by bend / 2 in u at its middle, the ridge's sample there in (u, v) off
    // the crease's line by that, its 3D point on it: an inexact p-curve within the tolerance.)
    const pcurve = bend === 0 ? b.addCurve(line2([ua, v], [ub - ua, 0])) : b.addCurve({ kind: 'bspline', degree: 2,
      knots: [0, 1], multiplicities: [3, 3], poles: [[ua, v], [0.5 * (ua + ub) + bend, v], [ub, v]], closed: false,
      selfIntersect: false, form: 'unspecified' });
    return [{ edge: b.addEdge({ curve, start: va, end: vb, sameSense: true, range: [0, 1] }),
      orientation: 'forward' as const, pcurve }];
  };
  const across = (u: number, va: number, vb: number, from: number, to: number) => {
    const A = P(u, from), B = P(u, to);
    const line = b.addCurve({ kind: 'line', point: A, direction: [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!],
      magnitude: 1 });
    return { edge: b.addEdge({ curve: line, start: va, end: vb, sameSense: true, range: [0, 1] }),
      orientation: 'forward' as const, pcurve: b.addCurve(line2([u, from], [0, to - from])) };
  };
  const all = [...along(0, u0, u1, v00, v10), across(u1, v10, v11, 0, 1), ...along(1, u1, u0, v11, v01),
    across(u0, v01, v00, 1, 0)];
  // (`rotate`: the loop starting that many coedges on: at the junction's vertex, the crossing on the edge after it.)
  const coedges = [...all.slice(rotate), ...all.slice(0, rotate)];
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * The roof with its top left corner cut out, u in [0, 1/2] x v in [0.6, 1]: the cut's side u = 1/2 lies along the
 * ridge, so the crease (the ridge below v = 0.6) ends at the cut's corner, which the loop reaches along the ridge.
 * The crease's crossing there is on the edge after the corner (the one along the ridge has none), whose first sample
 * the loop labels with the edge before. The corner's vertex is 1e-7 off the surface, the edges ending at it.
 */
export function roofNotch(): BrepBuilder {
  const b = new BrepBuilder();
  const P = (u: number, v: number) => [10 * u, 4 * v, u <= 0.5 ? 4 * u : 4 * (1 - u)];
  const poles = [0, 0.5, 1].map((u) => [0, 1].map((v) => P(u, v)));
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 0.5, 1], vKnots: [0, 1],
    uMultiplicities: [2, 1, 2], vMultiplicities: [2, 2], poles, uClosed: false, vClosed: false, selfIntersect: false,
    form: 'unspecified' });
  const corner = P(0.5, 0.6), off = [corner[0]!, corner[1]!, corner[2]! + 1e-7];
  const uv = [[0, 0], [1, 0], [1, 1], [0.5, 1], [0.5, 0.6], [0, 0.6]];
  const xyz = uv.map(([u, v], k) => (k === 4 ? off : P(u!, v!)));
  const vs = xyz.map((point) => b.addVertex({ point }));
  const coedges = uv.map((a, k) => {
    const c = uv[(k + 1) % uv.length]!, A = xyz[k]!, C = xyz[(k + 1) % uv.length]!;
    // (The bottom side through the ridge: a polyline, its knot at the ridge.)
    const curve = k === 0 ? b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 0.5, 1], multiplicities: [2, 1, 2],
      poles: [A, P(0.5, 0), C], closed: false, selfIntersect: false, form: 'unspecified' })
      : b.addCurve({ kind: 'line', point: A, direction: [C[0]! - A[0]!, C[1]! - A[1]!, C[2]! - A[2]!], magnitude: 1 });
    return { edge: b.addEdge({ curve, start: vs[k]!, end: vs[(k + 1) % uv.length]!, sameSense: true, range: [0, 1] }),
      orientation: 'forward' as const, pcurve: b.addCurve(line2(a, [c[0]! - a[0]!, c[1]! - a[1]!])) };
  });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * Two creases crossing (`cross`, a hip roof: degree 1 both ways, knots at u = 1/2, v = 0.4, the middle pole raised
 * by 2: four bilinear patches) or one curved in 3D (`arched`: the roof's ridge along v on a quadratic in v, its middle
 * row raised by 3). Over x = 10 u, y = 10 v; bounded by its four sides (polylines through the knots, p-curves
 * straight).
 */
export function creasedPatch(kind: 'cross' | 'arched'): BrepBuilder {
  const b = new BrepBuilder();
  const cross = kind === 'cross';
  // (The hip's v knot at 0.4: the u-ridge's samples by halving never land on the v-ridge.)
  const vs = cross ? [0, 0.4, 1] : [0, 0.5, 1];
  const z = (i: number, j: number) => cross ? (i === 1 && j === 1 ? 2 : 0) : (i === 1 ? 2 : 0) + (j === 1 ? 3 : 0);
  const poles = [0, 1, 2].map((i) => [0, 1, 2].map((j) => [10 * [0, 0.5, 1][i]!, 10 * vs[j]!, z(i, j)]));
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: cross ? 1 : 2, uKnots: [0, 0.5, 1],
    vKnots: cross ? [0, 0.4, 1] : [0, 1], uMultiplicities: [2, 1, 2], vMultiplicities: cross ? [2, 1, 2] : [3, 3],
    poles, uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  // Each side: the surface's boundary curve there, as a B-spline of its own, its p-curve the side.
  const side = (fixedU: boolean, at: number, from: number, to: number, start: number, end: number) => {
    const k = fixedU ? (at === 0 ? 0 : 2) : (at === 0 ? 0 : 2);
    const row = [0, 1, 2].map((m) => (fixedU ? poles[k]![m]! : poles[m]![k]!));
    const ordered = from < to ? row : [...row].reverse();
    const deg = fixedU && !cross ? 2 : 1;
    const knot = fixedU ? (cross ? (from < to ? 0.4 : 0.6) : 0.5) : 0.5;
    const curve = b.addCurve({ kind: 'bspline', degree: deg, knots: deg === 2 ? [0, 1] : [0, knot, 1],
      multiplicities: deg === 2 ? [3, 3] : [2, 1, 2], poles: ordered, closed: false, selfIntersect: false,
      form: 'unspecified' });
    const a = fixedU ? [at, from] : [from, at], d = fixedU ? [0, to - from] : [to - from, 0];
    return { edge: b.addEdge({ curve, start, end, sameSense: true, range: [0, 1] }), orientation: 'forward' as const,
      pcurve: b.addCurve(line2(a, d)) };
  };
  const P = (i: number, j: number) => b.addVertex({ point: poles[i]![j]! });
  const v00 = P(0, 0), v10 = P(2, 0), v11 = P(2, 2), v01 = P(0, 2);
  const coedges = [side(false, 0, 0, 1, v00, v10), side(true, 1, 0, 1, v10, v11), side(false, 1, 1, 0, v11, v01),
    side(true, 0, 1, 0, v01, v00)];
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A 10 mm square on z = 0, no p-curves, its top side an arc through its corners bowing 50 mm up out of the plane
 * (a circle in y = 10, centre z = 24.75, radius 25.25): an edge far off its face's surface, which the projection
 * finds so.
 */
export function edgeFarOff(pcurve = false): BrepBuilder {
  const b = new BrepBuilder();
  const c = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
  const vs = c.map((point) => b.addVertex({ point }));
  const line = (j: number) => {
    const p = c[j]!, q = c[(j + 1) % 4]!;
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0],
      magnitude: 1 }), start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true, range: [0, 1] });
  };
  const a0 = -Math.atan2(24.75, 5), a1 = Math.PI + Math.atan2(24.75, 5);
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: [5, 10, 24.75], axis: [0, -1, 0],
    xDir: [1, 0, 0] }, radius: 25.25 }), start: vs[2]!, end: vs[3]!, sameSense: true, range: [a0, a1] });
  const edges = [line(0), line(1), arc, line(3)];
  // (With `pcurve`, the arc's use given the line under it in the plane, (10, 10) to (0, 10) over the arc's range.)
  const under = pcurve ? b.addCurve({ kind: 'line', point: [10 + 10 * a0 / (a1 - a0), 10], direction: [-1, 0],
    magnitude: 10 / (a1 - a0) }) : undefined;
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: edges.map((edge) => ({ edge,
      orientation: 'forward' as const, ...(edge === arc && under !== undefined ? { pcurve: under } : {}) })) }] }));
  return b;
}

export function twisted(): BrepBuilder {
  const b = new BrepBuilder();
  const p = [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 1]];
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[p[0]!, p[1]!], [p[2]!, p[3]!]], uClosed: false,
    vClosed: false, selfIntersect: false, form: 'unspecified' });
  const corners = [p[0]!, p[2]!, p[3]!, p[1]!], uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const coedges = corners.map((a, j) => {
    const c = corners[(j + 1) % 4]!, d = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const line = b.addCurve({ kind: 'line', point: a, direction: d, magnitude: 1 });
    const q = uv[j]!, r = uv[(j + 1) % 4]!;
    const pcurve = b.addCurve(line2(q, [r[0]! - q[0]!, r[1]! - q[1]!]));
    return { edge: b.addEdge({ curve: line, start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true, range: [0, 1] }),
      orientation: 'forward' as const, pcurve };
  });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A unit square on z = 0 whose edges have no ranges, the last one's line running from (0, 0) up to (0, 1) while the
 * edge, said sameSense, runs down it: the vertices' order stands (as cad-brep's edgeParams has it); and with
 * `zero`, a loop with an edge between two vertices at one point (no length: no samples, the face failing, not the
 * part).
 */
function square(zero: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = c.map((point) => b.addVertex({ point }));
  const lines = [[c[0]!, [1, 0, 0]], [c[1]!, [0, 1, 0]], [c[2]!, [-1, 0, 0]], [c[0]!, [0, 1, 0]]];
  const edges = lines.map(([point, direction], j) => b.addEdge({ curve: b.addCurve({ kind: 'line', point: point!,
    direction: direction!, magnitude: 1 }), start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true }));
  const coedges = edges.map((edge) => ({ edge, orientation: 'forward' as const }));
  if (zero) {
    const extra = b.addVertex({ point: [1, 0, 0] });
    const e = b.addEdge({ curve: b.addCurve({ kind: 'line', point: [1, 0, 0], direction: [1, 0, 0], magnitude: 1 }),
      start: vs[1]!, end: extra, sameSense: true });
    coedges.splice(1, 0, { edge: e, orientation: 'forward' as const });
  }
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
/**
 * A lens on the plane z = 0 between two arcs of radius 25.01 through (-1, 0, 0) and (1, 0, 0), bulging 0.02 up and
 * down: at d 0.1 each arc is one chord, the two the same segment, a loop of two points unless split.
 */
export const lensPlane = (): BrepBuilder => {
  const b = new BrepBuilder();
  const v0 = b.addVertex({ point: [-1, 0, 0] }), v1 = b.addVertex({ point: [1, 0, 0] });
  const arc = (cy: number) => b.addCurve({ kind: 'circle', position: { origin: [0, cy, 0], axis: [0, 0, 1],
    xDir: [1, 0, 0] }, radius: 25.01 });
  const upper = b.addEdge({ curve: arc(-24.99), start: v1, end: v0, sameSense: true });
  const lower = b.addEdge({ curve: arc(24.99), start: v0, end: v1, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: upper, orientation: 'forward' },
      { edge: lower, orientation: 'forward' }] }] }));
  return b;
};
export const wrongSense = (): BrepBuilder => square(false);
export const zeroEdge = (): BrepBuilder => square(true);

/**
 * A bore as nist_ftc_10's has it: a cylinder of radius 5 (axis -z, xDir -x) with sense false between two circles
 * whose axes are opposite, both used reversed, no p-curves; its cut falls in the span through the circles' vertex.
 */
export function nistBore(): BrepBuilder {
  const b = new BrepBuilder();
  // (Its numbers as the file has them: the cut's place depends on the samples' rounding.)
  const x = [-1, 0, 0], cx = 14.000000000000004;
  const c0 = b.addCurve({ kind: 'circle', position: { origin: [cx, 23, -37.49999999999999], axis: [0, 0, 1], xDir: x },
    radius: 5 });
  const c1 = b.addCurve({ kind: 'circle', position: { origin: [cx, 23, -27.499999999999996], axis: [0, 0, -1],
    xDir: x }, radius: 5 });
  const v0 = b.addVertex({ point: [9.000000000000004, 23, -37.49999999999999] });
  const v1 = b.addVertex({ point: [9.000000000000004, 23, -27.499999999999996] });
  const e0 = b.addEdge({ curve: c0, start: v0, end: v0, sameSense: true });
  const e1 = b.addEdge({ curve: c1, start: v1, end: v1, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: { origin: [cx, 23, -32.49999999999999],
    axis: [0, 0, -1], xDir: x }, radius: 5 }), sameSense: false, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e0, orientation: 'reversed' }] },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: e1, orientation: 'reversed' }] }] }));
  return b;
}

/**
 * The unit sphere's half cap above latitude asin(0.4) on the side x > 0, as trj5_k1-ug's has it: bounded by a great
 * circle's arc in x = 0 over the north pole and the latitude circle's half back; no p-curves (the pole inside a
 * coedge). Area pi (1 - 0.4).
 */
export function halfCap(): BrepBuilder {
  const b = new BrepBuilder();
  const lat = Math.asin(0.4), c = Math.cos(lat), s = 0.4;
  const va = b.addVertex({ point: [0, c, s] }), vb = b.addVertex({ point: [0, -c, s] });
  const great = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [1, 0, 0], xDir: [0, 1, 0] },
    radius: 1 });
  const latitude = b.addCurve({ kind: 'circle', position: { origin: [0, 0, s], axis: [0, 0, 1], xDir: [0, 1, 0] },
    radius: c });
  const eg = b.addEdge({ curve: great, start: va, end: vb, sameSense: true, range: [lat, Math.PI - lat] });
  const el = b.addEdge({ curve: latitude, start: vb, end: va, sameSense: true, range: [Math.PI, 2 * Math.PI] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: eg, orientation: 'forward' }, { edge: el, orientation: 'forward' }] }] }));
  return b;
}

/**
 * halfCap with a hole near its pole: a circle of angular radius 0.03 about the direction 0.075 from the north pole
 * at u = 1.1, beside the great circle's meridian u = pi / 2 (u 0.69 to 1.51 at its widest), its vertex on the side
 * away from the pole. A pole's ring must stay under the hole, and its reach to the meridian's last sample beside it.
 */
export function poleHole(): BrepBuilder {
  const b = new BrepBuilder();
  const lat = Math.asin(0.4), c = Math.cos(lat), s = 0.4;
  const va = b.addVertex({ point: [0, c, s] }), vb = b.addVertex({ point: [0, -c, s] });
  const great = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [1, 0, 0], xDir: [0, 1, 0] },
    radius: 1 });
  const latitude = b.addCurve({ kind: 'circle', position: { origin: [0, 0, s], axis: [0, 0, 1], xDir: [0, 1, 0] },
    radius: c });
  const eg = b.addEdge({ curve: great, start: va, end: vb, sameSense: true, range: [lat, Math.PI - lat] });
  const el = b.addEdge({ curve: latitude, start: vb, end: va, sameSense: true, range: [Math.PI, 2 * Math.PI] });
  const a = 0.075, rr = 0.03, u = 1.1;
  const n = [Math.sin(a) * Math.cos(u), Math.sin(a) * Math.sin(u), Math.cos(a)];
  const x = [Math.cos(a) * Math.cos(u), Math.cos(a) * Math.sin(u), -Math.sin(a)];  // away from the pole
  const centre = n.map((q) => Math.cos(rr) * q);
  const vh = b.addVertex({ point: [0, 1, 2].map((k) => centre[k]! + Math.sin(rr) * x[k]!) });
  const hole = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: centre, axis: n, xDir: x },
    radius: Math.sin(rr) }), start: vh, end: vh, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: eg, orientation: 'forward' }, { edge: el, orientation: 'forward' }] },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: hole, orientation: 'reversed' }] }] }));
  return b;
}

/**
 * A B-spline cone: degree 2 in u, 1 in v, its row v = 0 collapsed to the apex (0, 0, 0), v = 1 the quadratic arc
 * through poles (1, 0, 1), (1, 1, 1), (0, 1, 1); bounded by that arc and the lines from the apex to its ends. Its
 * normal's limit at the apex depends on u (about 70 degrees across): an apex-like row, unlike a sphere's pole.
 */
export function bsplineApex(hole = 0): BrepBuilder {
  const b = new BrepBuilder();
  const apex = [0, 0, 0], arcPoles = [[1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const s = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [3, 3], vMultiplicities: [2, 2], poles: arcPoles.map((q) => [apex, q]), uClosed: false,
    vClosed: false, selfIntersect: false, form: 'unspecified' });
  const v0 = b.addVertex({ point: apex }), v1 = b.addVertex({ point: [1, 0, 1] });
  const v2 = b.addVertex({ point: [0, 1, 1] });
  const arc = b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3], poles: arcPoles,
    closed: false, selfIntersect: false, form: 'unspecified' });
  const line = (p: number[], q: number[]) => b.addCurve({ kind: 'line', point: p,
    direction: q.map((x, i) => (x - p[i]!) / Math.SQRT2), magnitude: 1 });
  const ea = b.addEdge({ curve: arc, start: v1, end: v2, sameSense: true, range: [0, 1] });
  const e1 = b.addEdge({ curve: line(apex, [0, 1, 1]), start: v0, end: v2, sameSense: true, range: [0, Math.SQRT2] });
  const e2 = b.addEdge({ curve: line([1, 0, 1], apex), start: v1, end: v0, sameSense: true, range: [0, Math.SQRT2] });
  const loops: Parameters<BrepBuilder['addFace']>[0]['loops'] = [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e1, orientation: 'forward' }, { edge: ea, orientation: 'reversed' },
      { edge: e2, orientation: 'forward' }] }];
  if (hole > 0) {
    // A hole between the cone's arcs at v = hole and 2 hole (the arc scaled: S(u, v) = v C(u)) over u 0.3 to 0.7,
    // its sides rulings: every edge on the surface, its near side `hole` from the apex in v.
    const at = (k: number) => b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3],
      poles: arcPoles.map((q) => q.map((x) => k * x)), closed: false, selfIntersect: false, form: 'unspecified' });
    const arcAt = (k: number, u: number) => {
      const w = [(1 - u) ** 2, 2 * u * (1 - u), u ** 2];
      return [0, 1, 2].map((i) => k * (w[0]! * arcPoles[0]![i]! + w[1]! * arcPoles[1]![i]! + w[2]! * arcPoles[2]![i]!));
    };
    const p = [arcAt(hole, 0.3), arcAt(hole, 0.7), arcAt(2 * hole, 0.7), arcAt(2 * hole, 0.3)];
    const v = p.map((point) => b.addVertex({ point }));
    const ruling = (a: number[], c: number[]) => {
      const len = Math.hypot(c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!);
      return { curve: b.addCurve({ kind: 'line', point: a, direction: c.map((x, i) => (x - a[i]!) / len),
        magnitude: 1 }), len };
    };
    const near = b.addEdge({ curve: at(hole), start: v[0]!, end: v[1]!, sameSense: true, range: [0.3, 0.7] });
    const r1 = ruling(p[1]!, p[2]!), r2 = ruling(p[3]!, p[0]!);
    const side1 = b.addEdge({ curve: r1.curve, start: v[1]!, end: v[2]!, sameSense: true, range: [0, r1.len] });
    const far = b.addEdge({ curve: at(2 * hole), start: v[3]!, end: v[2]!, sameSense: true, range: [0.3, 0.7] });
    const side2 = b.addEdge({ curve: r2.curve, start: v[3]!, end: v[0]!, sameSense: true, range: [0, r2.len] });
    loops.push({ kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: side2, orientation: 'reversed' },
      { edge: far, orientation: 'forward' }, { edge: side1, orientation: 'reversed' },
      { edge: near, orientation: 'reversed' }] });
  }
  sheet(b, b.addFace({ surface: s, sameSense: true, loops }));
  return b;
}

/** bsplineApex with a hole 1e-4 from its apex (in v): a ring held within 1e-4 of the pole, under d / 100 at 0.1. */
export const bsplineApexHole = (): BrepBuilder => bsplineApex(1e-4);

/**
 * A whole unit sphere as a rational B-spline periodic in v: its meridian (u, 0 to 2) from the south pole to the north
 * degree 2, both ends collapsed, its circle (v) CIRCLE9's; no loops. Its natural extent with the roles of u and v
 * swapped from a sphere's; area 4 pi. With `noise`, each collapsed row's poles moved off its pole by up to that (a
 * fitting's, as t4mec #472's), the rows still the surface's singularities; with `transposed`, u and v swapped (the
 * meridian v, the pole rows v = 0 and 2).
 */
export function bsplineBall(noise = 0, transposed = false): BrepBuilder {
  const b = new BrepBuilder();
  const meridian = [[0, -1, 1], [1, -1, Math.SQRT1_2], [1, 0, 1], [1, 1, Math.SQRT1_2], [0, 1, 1]];  // (r, z, w)
  const poles = meridian.map(([r, z], i) => CIRCLE9.xy.map(([x, y], k) => {
    const off = r === 0 ? noise : 0;
    const j = k % 8;
    return [r! * x! + off * Math.sin(3 * j + i), r! * y! + off * Math.cos(5 * j + i), z! + off * Math.sin(7 * j + i)];
  }));
  const weights = meridian.map((m) => CIRCLE9.w.map((w) => w * m[2]!));
  const flip = <T>(g: T[][]) => g[0]!.map((_, j) => g.map((row) => row[j]!));
  const meridianKnots = { knots: [0, 1, 2], multiplicities: [3, 2, 3] };
  const circleKnots = { knots: [0, 1, 2, 3, 4], multiplicities: [3, 2, 2, 2, 3] };
  const [u, v] = transposed ? [circleKnots, meridianKnots] : [meridianKnots, circleKnots];
  const surface = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 2, uKnots: u.knots, vKnots: v.knots,
    uMultiplicities: u.multiplicities, vMultiplicities: v.multiplicities, poles: transposed ? flip(poles) : poles,
    weights: transposed ? flip(weights) : weights, uClosed: transposed, vClosed: !transposed, selfIntersect: false,
    form: 'unspecified' });
  sheet(b, b.addFace({ surface, sameSense: true, loops: [] }));
  return b;
}

/** A plane with no loops beside a whole sphere with none: the sphere its natural extent, the plane none (unbounded). */
export function loopless(): BrepBuilder {
  const b = new BrepBuilder();
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true, loops: [] }));
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [] }));
  return b;
}

/**
 * B-spline faces with no loops, each its surface's whole knot rectangle: a bicubic plane patch 2 by 1 on z = 0 (open
 * both ways; area 2), bsplineTube's surface (closed in u in fact, radius 2, z 0 to 5; area 20 pi), a rational quarter
 * cone, its row v = 0 collapsed to the apex (0, 0, 0) and v = 1 the quarter circle of radius 1 at z = 1 (one side a
 * pole; area pi sqrt 2 / 4), and that cone with its u reversed (u running the other way round).
 */
export function looplessBsplines(): BrepBuilder {
  const b = new BrepBuilder();
  const grid = (nu: number, nv: number, at: (i: number, j: number) => number[]) =>
    Array.from({ length: nu }, (_, i) => Array.from({ length: nv }, (__, j) => at(i, j)));
  const plane = b.addSurface({ kind: 'bspline', uDegree: 3, vDegree: 3, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [4, 4], vMultiplicities: [4, 4], poles: grid(4, 4, (i, j) => [2 * i / 3, j / 3, 0]),
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const tubePoles = CIRCLE9.xy.map(([x, y]) => [[2 * x!, 2 * y!, 0], [2 * x!, 2 * y!, 5]]);
  const tube = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1, 2, 3, 4], vKnots: [0, 1],
    uMultiplicities: [3, 2, 2, 2, 3], vMultiplicities: [2, 2], poles: tubePoles,
    weights: CIRCLE9.w.map((w) => [w, w]), uClosed: true, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const cone = (reversed: boolean) => {
    const arc = [[1, 0, 1], [1, 1, 1], [0, 1, 1]], w = [1, Math.SQRT1_2, 1];
    const order = reversed ? [2, 1, 0] : [0, 1, 2];
    return b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
      uMultiplicities: [3, 3], vMultiplicities: [2, 2], poles: order.map((i) => [[0, 0, 0], arc[i]!]),
      weights: order.map((i) => [w[i]!, w[i]!]), uClosed: false, vClosed: false, selfIntersect: false,
      form: 'unspecified' });
  };
  for (const surface of [plane, tube, cone(false), cone(true)])
    sheet(b, b.addFace({ surface, sameSense: true, loops: [] }));
  return b;
}

/**
 * A plate like ohmm-ap203's (38 by 50.8 on z = 0, its corner (-19, 0)) with 14 holes of radius 1.4682 in two
 * columns (x 15.626 and -15.616, every 6.35 from y 7.9756): its rectangle's sides long and fixed, which refinement
 * for angle alone drove points into a corner of without end.
 */
export function plateHoles(): BrepBuilder {
  const b = new BrepBuilder();
  const c = [[-19, 0, 0], [19, 0, 0], [19, 50.8, 0], [-19, 50.8, 0]];
  const vs = c.map((point) => b.addVertex({ point }));
  const side = (k: number) => {
    const p = c[k]!, q = c[(k + 1) % 4]!, len = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!);
    const curve = b.addCurve({ kind: 'line', point: p, direction: [(q[0]! - p[0]!) / len, (q[1]! - p[1]!) / len, 0],
      magnitude: 1 });
    return { edge: b.addEdge({ curve, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, range: [0, len] }),
      orientation: 'forward' as const };
  };
  const loops: Parameters<BrepBuilder['addFace']>[0]['loops'] = [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [0, 1, 2, 3].map(side) }];
  for (const x of [-15.616, 15.626])
    for (let k = 0; k < 7; k++) {
      const o = [x, 7.9756 + 6.35 * k, 0], r = 1.4682;
      const v = b.addVertex({ point: [o[0]! + r, o[1]!, 0] });
      const e = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { ...AXIS, origin: o }, radius: r }),
        start: v, end: v, sameSense: true });
      loops.push({ kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: e, orientation: 'reversed' }] });
    }
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true, loops }));
  return b;
}

/** A whole torus (R 3, r 1, axis z) bounded by a vertex loop at (4, 0, 0): its natural extent, area 12 pi^2. */
export function wholeTorus(): BrepBuilder {
  const b = new BrepBuilder();
  const v = b.addVertex({ point: [4, 0, 0] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'torus', position: AXIS, majorRadius: 3, minorRadius: 1 }),
    sameSense: true, loops: [{ kind: 'vertex', bound: 'outer', sense: true, vertex: v }] }));
  return b;
}

/** A whole unit sphere bounded by a vertex loop on its equator, at (0, 1, 0): its natural extent, area 4 pi. */
export function wholeSphereVertex(): BrepBuilder {
  const b = new BrepBuilder();
  const v = b.addVertex({ point: [0, 1, 0] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'vertex', bound: 'outer', sense: true, vertex: v }] }));
  return b;
}

/** The unit sphere's half x > 0, bounded by one great circle through both poles (its vertex at the south pole). */
function greatCircleHalf(r: number, uncertainty?: number): BrepBuilder {
  const b = new BrepBuilder(uncertainty ? { uncertainty } : {});
  const v = b.addVertex({ point: [0, 0, -r] });
  const great = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [1, 0, 0], xDir: [0, 0, -1] },
    radius: r });
  const e = b.addEdge({ curve: great, start: v, end: v, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: r }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'forward' }] }] }));
  return b;
}
export const meridianHemisphere = (): BrepBuilder => greatCircleHalf(1);

/**
 * The unit sphere's upper half bounded by its equator and a seam meridian from (1, 0, 0) to the north pole used both
 * ways, as OCCT and BREP files have a hemisphere; with `degenerate`, a degenerate edge at the pole between the seam's
 * uses (no curve, its p-curve the row v = pi / 2, as the cone's apex). The seam's p-curves given, at u = 2 pi going up
 * and u = 0 coming down: the loop's equator and pole row each span the period, the jump across the pole a whole one.
 * Area 2 pi.
 */
function seamHemisphere(degenerate: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const v0 = b.addVertex({ point: [1, 0, 0] }), vp = b.addVertex({ point: [0, 0, 1] });
  const equator = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 1 }), start: v0, end: v0,
    sameSense: true });
  // (In the xz plane: its axis -y, so from x up to z over [0, pi / 2].)
  const seam = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [0, -1, 0],
    xDir: [1, 0, 0] }, radius: 1 }), start: v0, end: vp, sameSense: true, range: [0, Math.PI / 2] });
  const coedges: Coedge[] = [
    { edge: equator, orientation: 'forward' },
    { edge: seam, orientation: 'forward', pcurve: b.addCurve(line2([2 * Math.PI, 0], [0, 1])) }];
  if (degenerate)
    coedges.push({ edge: b.addEdge({ start: vp, end: vp, sameSense: true, degenerate: true, tolerance: 1e-7 }),
      orientation: 'forward', pcurve: b.addCurve(line2([2 * Math.PI, Math.PI / 2], [-1, 0])),
      range: [0, 2 * Math.PI] });
  coedges.push({ edge: seam, orientation: 'reversed', pcurve: b.addCurve(line2([0, 0], [0, 1])) });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A cone's side (radius 1 at z = 0, semi-angle 45 degrees, its apex (0, 0, -1) at v = -1) bounded by its base
 * circle and a seam line from the apex used both ways; with `degenerate`, a degenerate edge at the apex as the
 * cad-brep cone's (its p-curve the row v = -1). The seam's p-curves given, at u = 2 pi going up and u = 0 coming down.
 * Area pi sqrt 2.
 */
function seamCone(degenerate: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const va = b.addVertex({ point: [0, 0, -1] }), vb = b.addVertex({ point: [1, 0, 0] });
  const base = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 1 }), start: vb, end: vb,
    sameSense: true });
  const seam = b.addEdge({ curve: b.addCurve({ kind: 'line', point: [0, 0, -1], direction: [Math.SQRT1_2, 0,
    Math.SQRT1_2], magnitude: 1 }), start: va, end: vb, sameSense: true, range: [0, Math.SQRT2] });
  const coedges: Coedge[] = [];
  if (degenerate)
    coedges.push({ edge: b.addEdge({ start: va, end: va, sameSense: true, degenerate: true, tolerance: 1e-7 }),
      orientation: 'forward', pcurve: b.addCurve(line2([0, -1], [1, 0])), range: [0, 2 * Math.PI] });
  coedges.push({ edge: seam, orientation: 'forward', pcurve: b.addCurve(line2([2 * Math.PI, -1], [0, Math.SQRT1_2])) },
    { edge: base, orientation: 'reversed' },
    { edge: seam, orientation: 'reversed', pcurve: b.addCurve(line2([0, -1], [0, Math.SQRT1_2])) });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cone', position: AXIS, radius: 1, semiAngle: Math.PI / 4 }),
    sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
/**
 * The same at trj5_k1-ug's face 129's radius and uncertainty (3.81, 0.02): samples within 10 x the tolerance of a pole
 * aren't at it. Area 2 pi 3.81^2.
 */
export const meridianHemisphereLoose = (): BrepBuilder => greatCircleHalf(3.81, 0.02);

/**
 * A band (cylinder radius 2, z 0 to 5, its circles' vertices at u = 0, no seam) with a hole after its two circles
 * in the face's loop order, as trj5_k1-ug's face 115 has: the rectangle u in [-0.4137, 0.5863], v in [2, 3],
 * straddling u = 0 (across the cut's line at the period's start, no sample on it); no p-curves. Area 20 pi - 2.
 */
function bandWithHole(away: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const at = (u: number, z: number) => [2 * Math.cos(u), 2 * Math.sin(u), z];
  const circle = (z: number) => b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] }, radius: 2 });
  // (The circles' parameter from u = 0, their vertex at u = 0, or with `away` at u = pi: the cut at the period's
  // start then, but for the hole across it.)
  const round = (z: number) => away ? b.addCurve({ kind: 'circle', position: { origin: [0, 0, z], axis: [0, 0, 1],
    xDir: [-1, 0, 0] }, radius: 2 }) : circle(z);
  const v0 = b.addVertex({ point: at(away ? Math.PI : 0, 0) }), v1 = b.addVertex({ point: at(away ? Math.PI : 0, 5) });
  const eb = b.addEdge({ curve: round(0), start: v0, end: v0, sameSense: true });
  const et = b.addEdge({ curve: round(5), start: v1, end: v1, sameSense: true });
  const h = [at(-0.4137, 2), at(-0.4137, 3), at(0.5863, 3), at(0.5863, 2)].map((point) => b.addVertex({ point }));
  const up = (u: number) => b.addCurve({ kind: 'line', point: at(u, 0), direction: [0, 0, 1], magnitude: 1 });
  const left = b.addEdge({ curve: up(-0.4137), start: h[0]!, end: h[1]!, sameSense: true, range: [2, 3] });
  const top = b.addEdge({ curve: circle(3), start: h[1]!, end: h[2]!, sameSense: true, range: [-0.4137, 0.5863] });
  const right = b.addEdge({ curve: up(0.5863), start: h[2]!, end: h[3]!, sameSense: false, range: [3, 2] });
  const bottom = b.addEdge({ curve: circle(2), start: h[3]!, end: h[0]!, sameSense: false, range: [0.5863, -0.4137] });
  const fwd = (edge: number) => ({ edge, orientation: 'forward' as const });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: true,
    loops: [
      { kind: 'edge', bound: 'outer', sense: true, coedges: [fwd(eb)] },
      { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: et, orientation: 'reversed' }] },
      { kind: 'edge', bound: 'inner', sense: true, coedges: [fwd(left), fwd(top), fwd(right), fwd(bottom)] },
    ] }));
  return b;
}
/**
 * A band of a unit cylinder, v 0 to 3, its circles of arcs with vertices at u = 0, 1, 2.9 and 4.6 (unsplit at d = 0.5
 * with no angle), and two slots, v 1 to 2: A across u = 0 (-0.3 to 0.3), so the period's start won't do as the cut,
 * and B from 1.05 to 2.85, whose inside is the widest gap between the loops' points' u (1.8: the next 1.7), its
 * middle crossing each circle once: the cut must miss B too (lightarm-ap203 #92840's slot).
 */
export function bandTwoSlots(): BrepBuilder {
  const b = new BrepBuilder();
  const at = (u: number, z: number) => [Math.cos(u), Math.sin(u), z];
  const circle = (z: number) => b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] }, radius: 1 });
  const fwd = (edge: number) => ({ edge, orientation: 'forward' as const });
  const ring = (z: number) => {
    const us = [0, 1, 2.9, 4.6], vs = us.map((u) => b.addVertex({ point: at(u, z) })), c = circle(z);
    return us.map((u, i) => b.addEdge({ curve: c, start: vs[i]!, end: vs[(i + 1) % 4]!, sameSense: true,
      range: [u, i + 1 < 4 ? us[i + 1]! : 2 * Math.PI] }));
  };
  const slot = (ua: number, ub: number) => {
    const h = [at(ua, 1), at(ua, 2), at(ub, 2), at(ub, 1)].map((point) => b.addVertex({ point }));
    const up = (u: number) => b.addCurve({ kind: 'line', point: at(u, 0), direction: [0, 0, 1], magnitude: 1 });
    return [b.addEdge({ curve: up(ua), start: h[0]!, end: h[1]!, sameSense: true, range: [1, 2] }),
      b.addEdge({ curve: circle(2), start: h[1]!, end: h[2]!, sameSense: true, range: [ua, ub] }),
      b.addEdge({ curve: up(ub), start: h[2]!, end: h[3]!, sameSense: false, range: [2, 1] }),
      b.addEdge({ curve: circle(1), start: h[3]!, end: h[0]!, sameSense: false, range: [ub, ua] })].map(fwd);
  };
  const bottom = ring(0), top = ring(3);
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 1 }), sameSense: true,
    loops: [
      { kind: 'edge', bound: 'outer', sense: true, coedges: bottom.map(fwd) },
      { kind: 'edge', bound: 'inner', sense: true,
        coedges: [...top].reverse().map((edge) => ({ edge, orientation: 'reversed' as const })) },
      { kind: 'edge', bound: 'inner', sense: true, coedges: slot(-0.3, 0.3) },
      { kind: 'edge', bound: 'inner', sense: true, coedges: slot(1.05, 2.85) },
    ] }));
  return b;
}
/**
 * A unit sphere's lune at its south pole between the meridians u = 0 and pi / 2, closed by a circle on the sphere from
 * (0, -1.2) to (pi / 2, -1.2) through (pi / 4, -1.3): one span at d = 0.1 (no sample of its own), its curve nearer the
 * pole than the ring the meridians and its ends alone would allow (LMP1 #1072177's arc).
 */
export function poleDip(): BrepBuilder {
  const b = new BrepBuilder();
  const at = (u: number, v: number) => [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)];
  const sub = (x: number[], y: number[]) => x.map((xi, i) => xi - y[i]!);
  const crossP = (x: number[], y: number[]) => [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!,
    x[0]! * y[1]! - x[1]! * y[0]!];
  const dotP = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const unit = (x: number[]) => x.map((xi) => xi / Math.hypot(...x));
  const A = at(0, -1.2), B = at(Math.PI / 2, -1.2), C = at(Math.PI / 4, -1.3), S = [0, 0, -1];
  // (The circle: the sphere's section by the plane through A, B and C, from A through C to B.)
  let n = unit(crossP(sub(B, A), sub(C, A)));
  const k = dotP(n, A), centre = n.map((x) => k * x), radius = Math.sqrt(1 - k * k);
  const xDir = unit(sub(A, centre));
  let yDir = crossP(n, xDir);
  const angle = (p: number[]) => {
    const w = sub(p, centre);
    return Math.atan2(dotP(w, yDir), dotP(w, xDir));
  };
  if (angle(C) < 0) n = n.map((x) => -x), yDir = crossP(n, xDir);
  let tb = angle(B);
  if (tb < 0) tb += 2 * Math.PI;
  const vs = b.addVertex({ point: S }), va = b.addVertex({ point: A }), vb = b.addVertex({ point: B });
  const meridian = (u: number) => b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0],
    axis: [Math.sin(u), -Math.cos(u), 0], xDir: [Math.cos(u), Math.sin(u), 0] }, radius: 1 });
  // (A meridian u, its parameter v: axis x xDir is +z, so the point (cos v cos u, cos v sin u, sin v).)
  const m0 = b.addEdge({ curve: meridian(0), start: vs, end: va, sameSense: true, range: [-Math.PI / 2, -1.2] });
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: centre, axis: n, xDir }, radius }),
    start: va, end: vb, sameSense: true, range: [0, tb] });
  const m1 = b.addEdge({ curve: meridian(Math.PI / 2), start: vs, end: vb, sameSense: true,
    range: [-Math.PI / 2, -1.2] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: m0, orientation: 'forward' },
      { edge: arc, orientation: 'forward' }, { edge: m1, orientation: 'reversed' }] }] }));
  return b;
}

/**
 * poleDip with its vertex at the pole moved `delta` past it, to u = 5 pi / 4 (LMP1 #172878 edge #563481's end on
 * face #1063482's sphere, 0.149 from the pole at a tolerance of 0.2): each meridian runs down through the pole and
 * stops delta beyond it on the far side, within the vertex's tolerance (0.01) of it. Projected (no p-curves), with
 * delta within the part's tolerance each use's end is at the pole by its point: its free coordinate a neighbour's,
 * the meridian it came down by.
 */
export function poleDipFar(delta = 1e-7, uncertainty?: number): BrepBuilder {
  const b = new BrepBuilder(uncertainty === undefined ? {} : { uncertainty });
  const at = (u: number, v: number) => [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)];
  const sub = (x: number[], y: number[]) => x.map((xi, i) => xi - y[i]!);
  const crossP = (x: number[], y: number[]) => [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!,
    x[0]! * y[1]! - x[1]! * y[0]!];
  const dotP = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const unit = (x: number[]) => x.map((xi) => xi / Math.hypot(...x));
  const A = at(0, -1.2), B = at(Math.PI / 2, -1.2), C = at(Math.PI / 4, -1.3);
  let n = unit(crossP(sub(B, A), sub(C, A)));
  const k = dotP(n, A), centre = n.map((x) => k * x), radius = Math.sqrt(1 - k * k);
  const xDir = unit(sub(A, centre));
  let yDir = crossP(n, xDir);
  const angle = (p: number[]) => {
    const w = sub(p, centre);
    return Math.atan2(dotP(w, yDir), dotP(w, xDir));
  };
  if (angle(C) < 0) n = n.map((x) => -x), yDir = crossP(n, xDir);
  let tb = angle(B);
  if (tb < 0) tb += 2 * Math.PI;
  const tol = 0.01;
  const vs = b.addVertex({ point: at(5 * Math.PI / 4, -Math.PI / 2 + delta), tolerance: tol });
  const va = b.addVertex({ point: A, tolerance: tol }), vb = b.addVertex({ point: B, tolerance: tol });
  const meridian = (u: number) => b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0],
    axis: [Math.sin(u), -Math.cos(u), 0], xDir: [Math.cos(u), Math.sin(u), 0] }, radius: 1 });
  // (Past -pi / 2 a meridian's parameter is on the far side: (cos v cos u, ...) with cos v < 0.)
  const m0 = b.addEdge({ curve: meridian(0), start: vs, end: va, sameSense: true, range: [-Math.PI / 2 - delta, -1.2],
    tolerance: tol });
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: centre, axis: n, xDir }, radius }),
    start: va, end: vb, sameSense: true, range: [0, tb], tolerance: tol });
  const m1 = b.addEdge({ curve: meridian(Math.PI / 2), start: vs, end: vb, sameSense: true,
    range: [-Math.PI / 2 - delta, -1.2], tolerance: tol });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    tolerance: tol, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: m0, orientation: 'forward' },
      { edge: arc, orientation: 'forward' }, { edge: m1, orientation: 'reversed' }] }] }));
  return b;
}

export const bandHoleAtVertex = (): BrepBuilder => bandWithHole(false);
export const bandHoleOnCut = (): BrepBuilder => bandWithHole(true);

/**
 * A unit square on z = 0 whose edges' p-curves are parameterized against Part 42, as r103ec's are: the bottom's a
 * B-spline line over [0, 1] while its edge's line runs over [0, 2] (half its samples outside the p-curve's domain),
 * the right's over [0, 1] with its parameter squared (in its domain, its points off the edge's), the others right.
 */
export function offPcurves(): BrepBuilder {
  const b = new BrepBuilder();
  const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = c.map((point) => b.addVertex({ point }));
  const bs = (poles: number[][]): Curve => ({ kind: 'bspline', degree: poles.length - 1, knots: [0, 1],
    multiplicities: [poles.length, poles.length], poles, closed: false, selfIntersect: false, form: 'unspecified' });
  const pcurves = [bs([[0, 0], [1, 0]]), bs([[1, 0], [1, 0], [1, 1]]), line2([1, 1], [-1, 0]), line2([0, 1], [0, -1])];
  const coedges = c.map((a, j) => {
    const e = c[(j + 1) % 4]!, d = [e[0]! - a[0]!, e[1]! - a[1]!, 0];
    const line = b.addCurve({ kind: 'line', point: a, direction: d, magnitude: j === 0 ? 0.5 : 1 });
    const edge = b.addEdge({ curve: line, start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true,
      range: [0, j === 0 ? 2 : 1] });
    return { edge, orientation: 'forward' as const, pcurve: b.addCurve(pcurves[j]!) };
  });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A quarter of the unit sphere (z > 0, y < 0), as bug27894's faces have it: bounded by a semicircle from (1, 0, 0) up
 * to (-1, 0, 0) that passes 7e-4 below the north pole (its centre (0, 0, -7e-4), off the sphere by up to that, the
 * part's uncertainty 1e-5, so no p-curve can be projected for it) and the equator's half back through y < 0; no
 * p-curves. Its loop crosses the whole pole line there, so the cut must not; area about pi. `uncertainty` 1e-3
 * (offPoleArcLoose): the arc within it, projected, through the pole.
 */
export function offPoleArc(uncertainty = 1e-5): BrepBuilder {
  const b = new BrepBuilder({ uncertainty });
  const dz = 7e-4, r = Math.hypot(1, dz), t0 = Math.atan2(dz, 1);
  const va = b.addVertex({ point: [1, 0, 0] }), vb = b.addVertex({ point: [-1, 0, 0] });
  const arc = b.addCurve({ kind: 'circle', position: { origin: [0, 0, -dz], axis: [0, -1, 0], xDir: [1, 0, 0] },
    radius: r });
  const eq = b.addCurve({ kind: 'circle', position: AXIS, radius: 1 });
  const ea = b.addEdge({ curve: arc, start: va, end: vb, sameSense: true, range: [t0, Math.PI - t0] });
  const ee = b.addEdge({ curve: eq, start: vb, end: va, sameSense: true, range: [Math.PI, 2 * Math.PI] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: ea, orientation: 'forward' }, { edge: ee, orientation: 'forward' }] }] }));
  return b;
}

/** A rational quadratic B-spline circle's (x, y) poles and weights, radius 1, from (1, 0) round counterclockwise. */
const CIRCLE9 = { xy: [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]],
  w: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1] };

/**
 * A tube as a rational B-spline closed in u (its first and last rows one: no period, as Part 42 allows), radius 2
 * from z = 0 to 5, bounded by its two end circles (no seam edge): its closure found in fact, the band cut there.
 * Area 20 pi. `gap` moves its last row that far along y (open by that much at the seam), the part's uncertainty and
 * the face's tolerance as given.
 */
function tube(tinyArc: boolean, gap = 0, uncertainty?: number, faceTolerance?: number): BrepBuilder {
  const u = tinyArc ? 1e-3 : uncertainty;
  const b = new BrepBuilder(u === undefined ? {} : { uncertainty: u });
  const poles = CIRCLE9.xy.map(([x, y], i) => [[2 * x!, 2 * y! + (i === 8 ? gap : 0), 0],
    [2 * x!, 2 * y! + (i === 8 ? gap : 0), 5]]);
  const weights = CIRCLE9.w.map((w) => [w, w]);
  const surface = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1, 2, 3, 4], vKnots: [0, 1],
    uMultiplicities: [3, 2, 2, 2, 3], vMultiplicities: [2, 2], poles, weights, uClosed: true, vClosed: false,
    selfIntersect: false, form: 'unspecified' });
  const circle = (z: number) => b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] }, radius: 2 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [2, 0, 5] });
  const e1 = b.addEdge({ curve: circle(5), start: v1, end: v1, sameSense: true });
  // (With `tinyArc`, the bottom circle as an arc 4e-4 long, under the tolerance, and the rest: no collapsed row.)
  const a = 2e-4, va = b.addVertex({ point: [2 * Math.cos(a), 2 * Math.sin(a), 0] }), bottom = circle(0);
  const bottomUses = tinyArc
    ? [b.addEdge({ curve: bottom, start: v0, end: va, sameSense: true, range: [0, a] }),
      b.addEdge({ curve: bottom, start: va, end: v0, sameSense: true, range: [a, 2 * Math.PI] })]
    : [b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true })];
  sheet(b, b.addFace({ surface, sameSense: true, ...(faceTolerance === undefined ? {} : { tolerance: faceTolerance }),
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: bottomUses.map((edge) => ({ edge, orientation: 'forward' as const })) },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: e1, orientation: 'reversed' }] }] }));
  return b;
}
export const bsplineTube = (): BrepBuilder => tube(false);

/**
 * The unit square (z = 0) whose bottom edge's p-curve is a degree 1 B-spline along y = 0 whose knots end `gap` short
 * of the edge's range [0, 1] (with `atStart`, begin `gap` past its start; bug32314 #392624's, 1.6e-9): the use's end
 * that far past the p-curve's domain.
 * The other sides without p-curves.
 */
function pcurveShort(gap: number, atStart = false): BrepBuilder {
  const b = new BrepBuilder();
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const coedges: Coedge[] = corners.map((c, k) => {
    const q = corners[(k + 1) % 4]!, d = [q[0]! - c[0]!, q[1]! - c[1]!, 0];
    const edge = b.addEdge({ curve: b.addCurve({ kind: 'line', point: c, direction: d, magnitude: 1 }), start: vs[k]!,
      end: vs[(k + 1) % 4]!, sameSense: true, range: [0, 1] });
    if (k) return { edge, orientation: 'forward' };
    const lo = atStart ? gap : 0, hi = atStart ? 1 : 1 - gap;
    const pcurve = b.addCurve({ kind: 'bspline', degree: 1, knots: [lo, hi], multiplicities: [2, 2],
      poles: [[lo, 0], [hi, 0]], closed: false, selfIntersect: false, form: 'unspecified' });
    return { edge, orientation: 'forward', pcurve };
  });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
/** Within the rule's slack (1e-9 of the range's width): used. */
export const pcurveShortHair = (): BrepBuilder => pcurveShort(5e-10);
/** Past it (1e-6): refused, by inversion. */
export const pcurveShortFar = (): BrepBuilder => pcurveShort(1e-6);
/** pcurveShortHair at its start. */
export const pcurveShortStart = (): BrepBuilder => pcurveShort(5e-10, true);

/**
 * The unit square (z = 0) whose top right corner is two short line edges, (1, 0.99) to (0.994, 0.994) to (0.99, 1),
 * their tolerance and the face's 0.01, their p-curves through (1, 1) instead (as feet clamped to a range's edge are, the vertex
 * past it): the corner convex in (u, v) and concave in 3D, its point 0.0085 off its (u, v)'s, within the tolerance.
 * The other sides lines without p-curves.
 */
function cornerFoldAt(faceTolerance: number, sense = true): BrepBuilder {
  const b = new BrepBuilder();
  const pts = [[0, 0, 0], [1, 0, 0], [1, 0.99, 0], [0.994, 0.994, 0], [0.99, 1, 0], [0, 1, 0]];
  const uvs: Array<number[] | undefined> = [undefined, undefined, [1, 0.99], [1, 1], [0.99, 1], undefined];
  const vs = pts.map((point) => b.addVertex({ point, tolerance: 0.01 }));
  const coedges: Coedge[] = [];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k]!, q = pts[(k + 1) % pts.length]!, d = [q[0]! - p[0]!, q[1]! - p[1]!, 0];
    const l = Math.hypot(d[0]!, d[1]!);
    const edge = b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: d.map((x) => x / l),
      magnitude: 1 }), start: vs[k]!, end: vs[(k + 1) % pts.length]!, sameSense: true, range: [0, l],
      tolerance: 0.01 });
    // (The corner's two edges with p-curves from (u, v) to (u, v) over their own lengths.)
    const a = uvs[k], c = uvs[(k + 1) % pts.length];
    const orientation = sense ? 'forward' as const : 'reversed' as const;
    coedges.push(k === 2 || k === 3
      ? { edge, orientation, pcurve: b.addCurve(line2(a!, [(c![0]! - a![0]!) / l, (c![1]! - a![1]!) / l])) }
      : { edge, orientation });
  }
  if (!sense) coedges.reverse();
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: sense,
    tolerance: faceTolerance,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
export const cornerFold = (): BrepBuilder => cornerFoldAt(0.01);
/** The same with the face's tolerance 0.001: the chord 0.0014 from the corner's point, past it. */
export const cornerFoldTight = (): BrepBuilder => cornerFoldAt(0.001);
/** cornerFoldTight with the face's sense against its plane's (its normal -z), its loop reversed. */
export const cornerFoldTightAgainst = (): BrepBuilder => cornerFoldAt(0.001, false);

/**
 * The unit square (z = 0) whose bottom edge is a cubic B-spline along it with interior knots 1e-13 from each end of
 * its range (LMP1 #505096's, 1.2e-13 from where its vertex inverts): breaks at the ends' points within rounding.
 * The other sides lines. No p-curves.
 */
export function knotAtEnd(): BrepBuilder {
  const b = new BrepBuilder();
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const curve = b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1e-13, 0.5, 1 - 1e-13, 1],
    multiplicities: [4, 1, 1, 1, 4], poles: [0, 1e-13 / 3, 0.25, 0.5, 0.75, 1 - 1e-13 / 3, 1].map((x) =>
      [x, 0.1 * Math.sin(Math.PI * x), 0]),
    closed: false, selfIntersect: false, form: 'unspecified' });
  // (Its range 2e-14 inside the curve's at each end, as a vertex's inverted parameter is, not on a knot.)
  const edges = [b.addEdge({ curve, start: vs[0]!, end: vs[1]!, sameSense: true, range: [2e-14, 1 - 2e-14] })];
  for (let k = 1; k < 4; k++) {
    const p = corners[k]!, q = corners[(k + 1) % 4]!, d = [q[0]! - p[0]!, q[1]! - p[1]!, 0];
    edges.push(b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: d, magnitude: 1 }), start: vs[k]!,
      end: vs[(k + 1) % 4]!, sameSense: true, range: [0, 1] }));
  }
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: edges.map((edge) => ({ edge, orientation: 'forward' as const })) }] }));
  return b;
}

/**
 * A ball of radius 2 (axis z) with a flat at x = 1.2 (the bicycle's #1486 kind), its sphere face and its plane face
 * sharing the circle there (radius 1.6, about x: a loop that doesn't wind round the sphere's period), no p-curves, a
 * closed shell: the sphere face the ball less its cap (its loop a hole, clockwise about its normal in (u, v)), or
 * with `cap` the cap beyond the flat, the solid the cap. `flatUse` 'same' has the flat use the circle the sphere's
 * way (the two faces not oriented alike), 'none' leaves the flat out (the sphere a sheet alone): either way the
 * sphere's loop direction isn't to be trusted; so too with 'flippedCap', the flat replaced by the cap as a face of
 * the same sphere using the circle the other way but its sense reversed.
 */
export function ballWithFlat(cap = false, flatUse: 'other' | 'same' | 'none' | 'flippedCap' = 'other'): BrepBuilder {
  const b = new BrepBuilder();
  const h = 1.2, r = Math.sqrt(4 - h * h);
  const X = { origin: [h, 0, 0], axis: [1, 0, 0], xDir: [0, 1, 0] };
  const circle = b.addCurve({ kind: 'circle', position: X, radius: r });
  const v = b.addVertex({ point: [h, r, 0] });
  const edge = b.addEdge({ curve: circle, start: v, end: v, sameSense: true, range: [0, 2 * Math.PI] });
  // (The circle counterclockwise about +x: the flat's outer loop where its normal is +x (the ball behind it), the
  // sphere's cap's where the solid is the cap; reversed in the other face.)
  const sphere = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 2 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'unknown', sense: true,
      coedges: [{ edge, orientation: cap ? 'forward' as const : 'reversed' as const }] }] });
  if (flatUse === 'none') {
    sheet(b, sphere);
    return b;
  }
  if (flatUse === 'flippedCap') {
    // (The cap a face of the same sphere, the circle its loop the other way, but its sense against the surface's:
    // across the circle, where the two meet smoothly, their normals opposite.)
    const capFace = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 2 }), sameSense: false,
      loops: [{ kind: 'edge', bound: 'unknown', sense: true, coedges: [{ edge, orientation: 'forward' as const }] }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face: sphere, sense: true }, { face: capFace, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    return b;
  }
  const other = (flatUse === 'other') !== cap;
  const flat = b.addFace({ surface: b.addSurface({ kind: 'plane', position: X }),
    sameSense: !cap, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge, orientation: other ? 'forward' as const : 'reversed' as const }] }] });
  const shell = b.addShell({ kind: 'closed', faces: [{ face: sphere, sense: true }, { face: flat, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  return b;
}

/** The plane z = 0 bounded by two circles (radius 1, about x = -2 and 2) as holes: clockwise, no outer loop. */
export function planeHoleOnly(): BrepBuilder {
  const b = new BrepBuilder();
  const hole = (x: number) => {
    const curve = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [x, 0, 0] }, radius: 1 });
    const v = b.addVertex({ point: [x + 1, 0, 0] });
    const edge = b.addEdge({ curve, start: v, end: v, sameSense: true, range: [0, 2 * Math.PI] });
    return { kind: 'edge' as const, bound: 'unknown' as const, sense: true,
      coedges: [{ edge, orientation: 'reversed' as const }] };
  };
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [hole(-2), hole(2)] }));
  return b;
}

/**
 * The sphere of radius 5 about the origin (axis z) between the planes x = a and x = -c: a belt bounded by two circles
 * about x, each a loop of one edge, holes in (u, v) that don't wind round its period (VW #2446's pocket walls). No
 * p-curves. With `sense` false the face's normal inward and its coedges reversed (the same belt).
 * sphereBelt: a = 3, c = 1 (the belt 2 pi 5 x 4, its caps' 2 pi 5 x 6); sphereBeltEven: c = 2, belt and caps both
 * 2 pi 5 x 5, an area check blind to the difference.
 */
function sphereBelt(a: number, c: number, sense: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const R = 5;
  // (Each circle about x from its point on +y: the belt left of travel about the outward normal, reversed at x = a.)
  const loop = (x: number, forward: boolean) => {
    const r = Math.sqrt(R * R - x * x);
    const curve = b.addCurve({ kind: 'circle', position: { origin: [x, 0, 0], axis: [1, 0, 0], xDir: [0, 1, 0] },
      radius: r });
    const v = b.addVertex({ point: [x, r, 0] });
    const edge = b.addEdge({ curve, start: v, end: v, sameSense: true, range: [0, 2 * Math.PI] });
    const orientation = forward === sense ? 'forward' as const : 'reversed' as const;
    return { kind: 'edge' as const, bound: 'unknown' as const, sense: true, coedges: [{ edge, orientation }] };
  };
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: R }), sameSense: sense,
    loops: [loop(a, false), loop(-c, true)] }));
  return b;
}

/**
 * A quarter of a cylinder of radius 2 about z, 4 high, as a B-spline: cubic in u (the Bezier arc), cubic in v over
 * [0, 1] with, given `w`, a last knot span [1, 1 + w] (a triple knot at 1: C0 there) going on up the cylinder with
 * Q2's ring moved out by `bend`, |S_vv| about 6 bend R / w^2 in it (r0901_ec part #11's face 32955: 2742 over 8.5e-7).
 * Each edge the surface's iso-line (B-splines of its rows and columns), the p-curves lines on the domain's sides.
 */
export function kinkAtEnd(w = 1e-6, bend = 2e-10): BrepBuilder {
  const b = new BrepBuilder();
  const R = 2, h = 4, k = 4 / 3 * Math.tan(Math.PI / 8);
  const arc = [[1, 0], [1, k], [k, 1], [0, 1]];
  const heights = [0, h / 3, 2 * h / 3, h, ...(w > 0 ? [h + h * w / 3, h + 2 * h * w / 3, h + h * w] : [])];
  const out = (j: number) => (w > 0 && j === 5 ? 1 + bend : 1);
  const poles = arc.map(([x, y]) => heights.map((z, j) => [R * out(j) * x!, R * out(j) * y!, z]));
  const vKnots = w > 0 ? [0, 1, 1 + w] : [0, 1], vMultiplicities = w > 0 ? [4, 3, 4] : [4, 4];
  const top = vKnots[vKnots.length - 1]!;
  const s = b.addSurface({ kind: 'bspline', uDegree: 3, vDegree: 3, uKnots: [0, 1], vKnots, uMultiplicities: [4, 4],
    vMultiplicities, poles, uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const row = (j: number) => b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1], multiplicities: [4, 4],
    poles: poles.map((c) => c[j]!), closed: false, selfIntersect: false, form: 'unspecified' });
  const column = (i: number) => b.addCurve({ kind: 'bspline', degree: 3, knots: vKnots, multiplicities: vMultiplicities,
    poles: poles[i]!, closed: false, selfIntersect: false, form: 'unspecified' });
  const last = heights.length - 1;
  const corner = (i: number, j: number) => b.addVertex({ point: poles[i]![j]! });
  const v00 = corner(0, 0), v10 = corner(3, 0), v11 = corner(3, last), v01 = corner(0, last);
  const pline = (a: number[], c: number[]) => b.addCurve({ kind: 'line', point: a,
    direction: [c[0]! - a[0]!, c[1]! - a[1]!], magnitude: 1 });
  const bottom = b.addEdge({ curve: row(0), start: v00, end: v10, sameSense: true, range: [0, 1] });
  const right = b.addEdge({ curve: column(3), start: v10, end: v11, sameSense: true, range: [0, top] });
  const upper = b.addEdge({ curve: row(last), start: v01, end: v11, sameSense: true, range: [0, 1] });
  const left = b.addEdge({ curve: column(0), start: v00, end: v01, sameSense: true, range: [0, top] });
  // (Each p-curve a line over the edge's own parameter: u along a row, v along a column.)
  const coedges = [
    { edge: bottom, orientation: 'forward' as const, pcurve: pline([0, 0], [1, 0]) },
    { edge: right, orientation: 'forward' as const, pcurve: pline([1, 0], [1, 1]) },
    { edge: upper, orientation: 'reversed' as const, pcurve: pline([0, top], [1, top]) },
    { edge: left, orientation: 'reversed' as const, pcurve: pline([0, 0], [0, 1]) },
  ];
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A flat parallelogram as a bilinear B-spline, u along (10, 0, 0) and v along (5, 8.66, 0) (60 degrees apart, so its
 * metric in (u, v) has a cross term), bounded by its four sides (lines, p-curves on the domain's sides).
 */
export function skewPatch(): BrepBuilder {
  const b = new BrepBuilder();
  const U = [10, 0, 0], V = [5, 10 * Math.sin(Math.PI / 3), 0];
  const P = (u: number, v: number) => [u * U[0]! + v * V[0]!, u * U[1]! + v * V[1]!, 0];
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [0, 1].map((u) => [0, 1].map((v) => P(u, v))),
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const vs = uv.map(([u, v]) => b.addVertex({ point: P(u!, v!) }));
  const coedges = [0, 1, 2, 3].map((k) => {
    const a = uv[k]!, c = uv[(k + 1) % 4]!, p = P(a[0]!, a[1]!), q = P(c[0]!, c[1]!);
    const d = [q[0]! - p[0]!, q[1]! - p[1]!, 0], l = Math.hypot(d[0]!, d[1]!);
    const line = b.addCurve({ kind: 'line', point: p, direction: d.map((x) => x / l), magnitude: 1 });
    const edge = b.addEdge({ curve: line, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, range: [0, l] });
    const pcurve = b.addCurve({ kind: 'line', point: a, direction: [(c[0]! - a[0]!) / l, (c[1]! - a[1]!) / l],
      magnitude: 1 });
    return { edge, orientation: 'forward' as const, pcurve };
  });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A patch of the cylinder of radius 5 about z (u from 0 to 1, z from 0 to 10) whose bottom edge is a cubic B-spline
 * along the arc at radius 5 + `off` (the Bezier arc's poles), z wiggling by +/-0.5 at its inner poles, its tolerance
 * 0.01; the top the circle's arc at z = 10, the sides lines down to the bottom's ends. No p-curves. coarseProjection:
 * 0.004 off, farther off the surface than the mesh's projection tolerance (0.05 x a deflection of 0.01) but within
 * its own, so its use is projected at the edge's tolerance, the p-curve within 0.01 of its points' feet.
 */
function offCylinder(off: number): BrepBuilder {
  const b = new BrepBuilder();
  const R = 5 + off, k = 4 / 3 * Math.tan(0.25), c = Math.cos(1), s1 = Math.sin(1);
  const poles = [[R, 0, 0], [R, k * R, 0.5], [R * (c + k * s1), R * (s1 - k * c), -0.5], [R * c, R * s1, 0]];
  const corners = [poles[0]!, poles[3]!, [5 * c, 5 * s1, 10], [5, 0, 10]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const curve = b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1], multiplicities: [4, 4], poles, closed: false,
    selfIntersect: false, form: 'unspecified' });
  const line = (k0: number, k1: number) => {
    const p = corners[k0]!, q = corners[k1]!, d = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: d.map((x) => x / l), magnitude: 1 }),
      start: vs[k0]!, end: vs[k1]!, sameSense: true, range: [0, l], tolerance: 0.01 });
  };
  const top = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, 10] }, radius: 5 }),
    start: vs[3]!, end: vs[2]!, sameSense: true, range: [0, 1], tolerance: 0.01 });
  const coedges: Coedge[] = [
    { edge: b.addEdge({ curve, start: vs[0]!, end: vs[1]!, sameSense: true, range: [0, 1], tolerance: 0.01 }),
      orientation: 'forward' },
    { edge: line(1, 2), orientation: 'forward' }, { edge: top, orientation: 'reversed' },
    { edge: line(3, 0), orientation: 'forward' }];
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 5 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
export const coarseProjection = (): BrepBuilder => offCylinder(0.004);
/**
 * The same with the bottom edge 1e-4 off: within the mesh's projection tolerance (5e-4 at a deflection of 0.01), its
 * p-curve within that of its points' feet.
 */
export const fineProjection = (): BrepBuilder => offCylinder(1e-4);

/**
 * A quarter of bsplineTube's surface, u from 1 to 2 (its knots: (0, 2) to (-2, 0) round the axis), bounded by its two
 * quarter arcs (no p-curves) and its rulings at u = 1 and 2, whose p-curves are given a period up (u = 5 and 6: the
 * surface closes in fact with period 4, its own range [0, 4]): right p-curves, each a whole period off the range.
 * Area 5 pi.
 */
export function tubeQuarterPeriodUp(): BrepBuilder {
  const b = new BrepBuilder();
  const poles = CIRCLE9.xy.map(([x, y]) => [[2 * x!, 2 * y!, 0], [2 * x!, 2 * y!, 5]]);
  const weights = CIRCLE9.w.map((w) => [w, w]);
  const surface = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1, 2, 3, 4], vKnots: [0, 1],
    uMultiplicities: [3, 2, 2, 2, 3], vMultiplicities: [2, 2], poles, weights, uClosed: true, vClosed: false,
    selfIntersect: false, form: 'unspecified' });
  const p = [[0, 2], [-2, 0]].map(([x, y]) => [b.addVertex({ point: [x!, y!, 0] }), b.addVertex({ point: [x!, y!, 5] })]);
  const arc = (z: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle',
    position: { ...AXIS, origin: [0, 0, z] }, radius: 2 }), start, end, sameSense: true, range: [Math.PI / 2, Math.PI] });
  const ruling = (k: number) => b.addEdge({ curve: b.addCurve({ kind: 'line', point: [p[k] === p[0] ? 0 : -2,
    k === 0 ? 2 : 0, 0], direction: [0, 0, 1], magnitude: 1 }), start: p[k]![0]!, end: p[k]![1]!, sameSense: true,
    range: [0, 5] });
  const pcurve = (u: number) => b.addCurve(line2([u, 0], [0, 0.2]));
  sheet(b, b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: arc(0, p[0]![0]!, p[1]![0]!), orientation: 'forward' },
    { edge: ruling(1), orientation: 'forward', pcurve: pcurve(6) },
    { edge: arc(5, p[0]![1]!, p[1]![1]!), orientation: 'reversed' },
    { edge: ruling(0), orientation: 'reversed', pcurve: pcurve(5) }] }] }));
  return b;
}
/** The tube with its bottom circle in two arcs, one shorter than the tolerance: not an edge of no length. */
export const bsplineTubeTinyArc = (): BrepBuilder => tube(true);
/**
 * The tube open at its seam by 5e-4, closed in fact within the face's tolerance 1e-3 (no uncertainty given), or
 * within the part's uncertainty 1e-3 (no face tolerance); by 5e-9 with neither, closed in fact within 1e-9 of its size
 * (10: its domain's diagonals); by 3e-5 with neither, open (over the 1e-5 a part with no uncertainty is judged by).
 */
export const tubeGapFaceTolerance = (): BrepBuilder => tube(false, 5e-4, undefined, 1e-3);
export const tubeGapUncertainty = (): BrepBuilder => tube(false, 5e-4, 1e-3);
export const tubeGapBySize = (): BrepBuilder => tube(false, 5e-9);
export const tubeGapOpen = (): BrepBuilder => tube(false, 3e-5);

/**
 * The unit sphere's upper half as a rational B-spline (u round, closed; v a quarter circle up to the pole, its top
 * row collapsed there), bounded by its equator and an unflagged edge of no length at the pole
 * (a B-spline of one point, from the pole to itself), as trj7_k1-id's faces have: the edge along the pole line.
 * Area 2 pi.
 */
export function bsplineDome(): BrepBuilder {
  const b = new BrepBuilder();
  const meridian = [[1, 0, 1], [1, 1, Math.SQRT1_2], [0, 1, 1]];  // (r, z, weight)
  const poles = CIRCLE9.xy.map(([x, y]) => meridian.map(([r, z]) => [r! * x!, r! * y!, z!]));
  const weights = CIRCLE9.w.map((w) => meridian.map((m) => w * m[2]!));
  const surface = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 2, uKnots: [0, 1, 2, 3, 4], vKnots: [0, 1],
    uMultiplicities: [3, 2, 2, 2, 3], vMultiplicities: [3, 3], poles, weights, uClosed: true, vClosed: false,
    selfIntersect: false, form: 'unspecified' });
  const v0 = b.addVertex({ point: [1, 0, 0] }), vp = b.addVertex({ point: [0, 0, 1] });
  const eq = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 1 }), start: v0, end: v0,
    sameSense: true });
  const point = b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1], multiplicities: [2, 2],
    poles: [[0, 0, 1], [0, 0, 1]], closed: false, selfIntersect: false, form: 'unspecified' });
  const ep = b.addEdge({ curve: point, start: vp, end: vp, sameSense: true, range: [0, 1] });
  sheet(b, b.addFace({ surface, sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: eq, orientation: 'forward' }] },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: ep, orientation: 'forward' }] }] }));
  return b;
}

/**
 * offPoleArc at uncertainty 1e-3: its arc, 7e-4 under the pole, then passes through it by the part's own tolerance,
 * its sample there at the pole in (u, v) but 7e-4 off it in 3D (projected: through the pole).
 */
export const offPoleArcLoose = (): BrepBuilder => offPoleArc(1e-3);

/**
 * offPoleArc's loop the other way round: the rest of the sphere, its loop winding round to the south pole;
 * offPoleRestLoose at uncertainty 1e-3, its arc projected.
 */
export function offPoleRest(uncertainty = 1e-5): BrepBuilder {
  const b = new BrepBuilder({ uncertainty });
  const dz = 7e-4, r = Math.hypot(1, dz), t0 = Math.atan2(dz, 1);
  const va = b.addVertex({ point: [1, 0, 0] }), vb = b.addVertex({ point: [-1, 0, 0] });
  const arc = b.addCurve({ kind: 'circle', position: { origin: [0, 0, -dz], axis: [0, -1, 0], xDir: [1, 0, 0] },
    radius: r });
  const eq = b.addCurve({ kind: 'circle', position: AXIS, radius: 1 });
  const ea = b.addEdge({ curve: arc, start: va, end: vb, sameSense: true, range: [t0, Math.PI - t0] });
  const ee = b.addEdge({ curve: eq, start: vb, end: va, sameSense: true, range: [Math.PI, 2 * Math.PI] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: ee, orientation: 'reversed' }, { edge: ea, orientation: 'reversed' }] }] }));
  return b;
}

/**
 * A band (radius 2, z 0 to 5) whose bottom boundary, a rectilinear loop of arcs and vertical lines in (u, v),
 * winds once but crosses u = 0 three times (`wiggle`), or (else) only in a one-span arc of 0.2 rad (0.4 mm, under
 * the medium profile's spacing on it) starting at a junction (a notch); the top its circle. Areas 20 pi - 0.9 and
 * 20 pi - 0.2.
 */
function rectilinearBand(wiggle: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const at = (u: number, z: number) => [2 * Math.cos(u), 2 * Math.sin(u), z];
  const tw = 2 * Math.PI;
  // The bottom loop's corners in (u, v), its first arc the long way round from u0 to u1 + 2 pi.
  const pts = wiggle
    ? [[0.29, 0], [tw - 0.31, 0], [tw - 0.31, 1], [tw + 0.29, 1], [tw + 0.29, 0.6], [tw - 0.21, 0.6],
      [tw - 0.21, 0.3], [tw + 0.29, 0.3]]
    : [[0.095, 0], [tw - 0.105, 0], [tw - 0.105, 0.5], [tw + 0.095, 0.5]];
  const vs = pts.map(([u, z]) => b.addVertex({ point: at(u!, z!) }));
  const coedges = pts.map(([u0, z0], k) => {
    const [u1, z1] = pts[(k + 1) % pts.length]!;
    const end = (k + 1) % pts.length;
    if (z0 === z1) {
      // An arc at z0 from u0 to u1 (the closing side from the last corner back to the first, a period on).
      const to = k + 1 === pts.length ? u1! + tw : u1!;
      const circle = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z0!] }, radius: 2 });
      const up = to > u0!;
      return { edge: b.addEdge({ curve: circle, start: vs[k]!, end: vs[end]!, sameSense: up,
        range: [u0!, to] }), orientation: 'forward' as const };
    }
    const line = b.addCurve({ kind: 'line', point: at(u0!, 0), direction: [0, 0, 1], magnitude: 1 });
    return { edge: b.addEdge({ curve: line, start: vs[k]!, end: vs[end]!, sameSense: z1! > z0!, range: [z0!, z1!] }),
      orientation: 'forward' as const };
  });
  // (The top circle from u = 1.7, so none of its samples falls at the period's start: the cut is tried there first.)
  const top = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 5], axis: [0, 0, 1],
    xDir: [Math.cos(1.7), Math.sin(1.7), 0] }, radius: 2 });
  const vt = b.addVertex({ point: at(1.7, 5) });
  const et = b.addEdge({ curve: top, start: vt, end: vt, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges },
      { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: et, orientation: 'reversed' }] }] }));
  return b;
}
export const wigglyBand = (): BrepBuilder => rectilinearBand(true);
export const notchBand = (): BrepBuilder => rectilinearBand(false);

/**
 * A torus's outer half (major radius 3, minor 1, axis z: v from -pi / 2 to pi / 2 through 0), between its bottom
 * and top circles: the cut between them in v must run through v = 0, the face's way, not the direct difference
 * (from 3 pi / 2 back to pi / 2, through the inner half). Area 2 pi r (pi R + 2 r).
 */
export function torusOuterHalf(): BrepBuilder {
  const b = new BrepBuilder();
  const circle = (z: number) => b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] }, radius: 3 });
  const v0 = b.addVertex({ point: [3, 0, -1] }), v1 = b.addVertex({ point: [3, 0, 1] });
  const eb = b.addEdge({ curve: circle(-1), start: v0, end: v0, sameSense: true });
  const et = b.addEdge({ curve: circle(1), start: v1, end: v1, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'torus', position: AXIS, majorRadius: 3, minorRadius: 1 }),
    sameSense: true, loops: [
      { kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: eb, orientation: 'forward' }] },
      { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: et, orientation: 'reversed' }] }] }));
  return b;
}

/** A 0.5 mm hole's edge: a plane disc of radius 0.25 bounded by one closed circle. */
export function smallHole(): BrepBuilder {
  const b = new BrepBuilder();
  const v = b.addVertex({ point: [0.25, 0, 0] });
  const e = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 0.25 }), start: v, end: v,
    sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'forward' }] }] }));
  return b;
}

/**
 * An S-bend: the quintic Bezier with poles (0, 0), (1, 0), (2, 0.5), (3, -0.5), (4, 0), (5, 0), its tangents at
 * both ends along its chord (the x axis), turning one way then the other between; a polyline below closes it.
 */
export function sBend(): BrepBuilder {
  const b = new BrepBuilder();
  const spline = b.addCurve({ kind: 'bspline', degree: 5, knots: [0, 1], multiplicities: [6, 6],
    poles: [[0, 0, 0], [1, 0, 0], [2, 0.5, 0], [3, -0.5, 0], [4, 0, 0], [5, 0, 0]], closed: false,
    selfIntersect: false, form: 'unspecified' });
  const poly = b.addCurve({ kind: 'polyline', points: [[5, 0, 0], [5, -2, 0], [0, -2, 0], [0, 0, 0]] });
  const va = b.addVertex({ point: [0, 0, 0] }), vb = b.addVertex({ point: [5, 0, 0] });
  const es = b.addEdge({ curve: spline, start: va, end: vb, sameSense: true, range: [0, 1] });
  const ep = b.addEdge({ curve: poly, start: vb, end: va, sameSense: true, range: [0, 3] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: es, orientation: 'forward' }, { edge: ep, orientation: 'forward' }] }] }));
  return b;
}

/**
 * A 10 x 10 arch, a quadratic B-spline 2 high in its middle row whose u isn't quite its edges' parameter (that row's
 * poles 8e-3 farther along x than its curves'), bounded by its curved sides v = 0 and v = 10 and its straight ends;
 * the side v = 0 1.5e-3 above it, the part's uncertainty 0.02 (Iron.step #47's face 3398's kind): at the edge's
 * tolerance that side's feet are taken as affine in t, about 4e-3 off the true ones, which the mesh then chases;
 * within 0.05 x the deflection they're traced.
 */
export function affineFeetOff(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.02 });
  const poles = [[0, 0], [5.008, 2], [10, 0]].map(([x, z]) => [0, 10].map((y) => [x!, y, z!]));
  const surface = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [3, 3], vMultiplicities: [2, 2], poles, uClosed: false, vClosed: false, selfIntersect: false,
    form: 'unspecified' });
  const side = (y: number, dz: number) => b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1],
    multiplicities: [3, 3], poles: [[0, y, dz], [5, y, 2 + dz], [10, y, dz]], closed: false, selfIntersect: false,
    form: 'unspecified' });
  const end = (x: number, y0: number, y1: number) => b.addCurve({ kind: 'line', point: [x, y0, 0],
    direction: [0, Math.sign(y1 - y0), 0], magnitude: 1 });
  const v = [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => b.addVertex({ point: [x!, y!, 0] }));
  const edges = [
    b.addEdge({ curve: side(0, 1.5e-3), start: v[0]!, end: v[1]!, sameSense: true, range: [0, 1] }),
    b.addEdge({ curve: end(10, 0, 10), start: v[1]!, end: v[2]!, sameSense: true, range: [0, 10] }),
    b.addEdge({ curve: side(10, 0), start: v[3]!, end: v[2]!, sameSense: true, range: [0, 1] }),
    b.addEdge({ curve: end(0, 10, 0), start: v[3]!, end: v[0]!, sameSense: true, range: [0, 10] })];
  const coedges = edges.map((edge, k) => ({ edge, orientation: k === 2 ? 'reversed' as const : 'forward' as const }));
  sheet(b, b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A 10 x 10 bicubic B-spline creased like Iron.step #47's face 3396: a V along u (or with `inV` along v),
 * z = 0.5 |u - 0.5| (a slope of 0.05 either side), rounded between knots 0.5 -/+ h of multiplicity 2 (C1 there, its
 * second partial up to about 1 / h between them); its other parameter linear, x = 10 u, y = 10 v. With `quadratic`,
 * of degree 2 across the crease and its knots simple, its second partial between them exactly 1 / (2 h). With `run`,
 * cubic with simple knots 0.5 + h x (-2, -1, 0, 1, 2): rounded over a run of four spans h wide. Bounded by its four
 * sides, the creased ones B-splines of its own knots.
 */
export function kinkStrip(inV = false, quadratic = false, h = 5e-5, run = false): BrepBuilder {
  const b = new BrepBuilder();
  const deg = quadratic ? 2 : 3, inner = quadratic || run ? 1 : 2;
  const knots = run ? [0, 0.5 - 2 * h, 0.5 - h, 0.5, 0.5 + h, 0.5 + 2 * h, 1] : [0, 0.5 - h, 0.5 + h, 1];
  const mults = knots.map((_, i) => (i === 0 || i === knots.length - 1 ? deg + 1 : inner));
  const ks = knots.flatMap((k, i) => Array<number>(mults[i]!).fill(k));
  // (Poles at the Greville abscissae, so that the parameter is linear in x and the V exact outside the knots.)
  const g = ks.slice(0, ks.length - deg - 1).map((_, i) => ks.slice(i + 1, i + 1 + deg).reduce((a, x) => a + x) / deg);
  const z = (t: number) => 0.5 * Math.abs(t - 0.5);
  const lin = [0, 1 / 3, 2 / 3, 1];
  const at = (u: number, v: number) => [10 * u, 10 * v, z(inV ? v : u)];
  const poles = (inV ? lin : g).map((u) => (inV ? g : lin).map((v) => at(u, v)));
  const s = b.addSurface({ kind: 'bspline', uDegree: inV ? 3 : deg, vDegree: inV ? deg : 3,
    uKnots: inV ? [0, 1] : knots, vKnots: inV ? knots : [0, 1], uMultiplicities: inV ? [4, 4] : mults,
    vMultiplicities: inV ? mults : [4, 4], poles,
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const vs = uv.map(([u, v]) => b.addVertex({ point: at(u!, v!) }));
  const coedges = [0, 1, 2, 3].map((k) => {
    const a = uv[k]!, c = uv[(k + 1) % 4]!, du = c[0]! - a[0]!, dv = c[1]! - a[1]!;
    // (A side across the crease: its poles the surface's along it from a to c, backwards where the side runs back;
    // the knots symmetric, so the same knots either way.)
    const creased = inV ? du === 0 : dv === 0;
    const curve = creased
      ? b.addCurve({ kind: 'bspline', degree: deg, knots, multiplicities: mults, closed: false, selfIntersect: false,
        form: 'unspecified', poles: g.map((t) => at(a[0]! + du * t, a[1]! + dv * t)) })
      : b.addCurve({ kind: 'line', point: at(a[0]!, a[1]!), direction: [du, dv, 0], magnitude: 1 });
    const edge = b.addEdge({ curve, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true,
      range: creased ? [0, 1] : [0, 10] });
    const pcurve = b.addCurve({ kind: 'line', point: a, direction: [du, dv], magnitude: creased ? 1 : 0.1 });
    return { edge, orientation: 'forward' as const, pcurve };
  });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * Half a cylinder (radius 2, z 0 to 4) from longitude u0 to u0 + pi: two semicircles and two lines. Its arcs
 * sampled at their ends alone are a step of half a period in u, which way it runs a tie for the samples alone.
 * P-curves `none` (by projection or inversion), `same` (u = t on both arcs), `apart` (the bottom arc's u = t + 2 pi,
 * a period from the top's and the lines').
 */
function halfCylinder(u0: number, pcurves: 'none' | 'same' | 'apart', r = 2, h = 4): BrepBuilder {
  const b = new BrepBuilder();
  const at = (u: number, z: number) => [r * Math.cos(u), r * Math.sin(u), z];
  const u1 = u0 + Math.PI;
  const va0 = b.addVertex({ point: at(u0, 0) }), vc0 = b.addVertex({ point: at(u1, 0) });
  const va1 = b.addVertex({ point: at(u0, h) }), vc1 = b.addVertex({ point: at(u1, h) });
  const arc = (z: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle',
    position: { ...AXIS, origin: [0, 0, z] }, radius: r }), start, end, sameSense: true, range: [u0, u1] });
  const up = (u: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'line',
    point: at(u, 0), direction: [0, 0, 1], magnitude: 1 }), start, end, sameSense: true, range: [0, h] });
  const bottom = arc(0, va0, vc0), top = arc(h, va1, vc1), right = up(u1, vc0, vc1), left = up(u0, va0, va1);
  const pc = (point: number[], direction: number[]) => pcurves === 'none' ? {} : { pcurve: b.addCurve(line2(point,
    direction)) };
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: r }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: bottom, orientation: 'forward', ...pc([pcurves === 'apart' ? 2 * Math.PI : 0, 0], [1, 0]) },
      { edge: right, orientation: 'forward', ...pc([u1, 0], [0, 1]) },
      { edge: top, orientation: 'reversed', ...pc([0, h], [1, 0]) },
      { edge: left, orientation: 'reversed', ...pc([u0, 0], [0, 1]) }] }] }));
  return b;
}
/**
 * A strip of a cylinder of radius 1.5, 25 along its axis and 0.85 round it, under an uncertainty of 1 (trj7_b1-ec-214's
 * face #11336's proportions, its normals turning about 33 degrees across): its ends, arcs 0.85 long, within the
 * tolerance, so never split. narrowStripSmall: the same at a twentieth of the size under an uncertainty of 0.001, its
 * ends 0.0425 long: over the tolerance, within the refinement floor at a deflection of 0.5 (0.05).
 */
export function narrowStrip(scale = 1, uncertainty = 1): BrepBuilder {
  const b = new BrepBuilder({ uncertainty });
  const r = 1.5 * scale, L = 25 * scale, u0 = 0, u1 = 0.85 / 1.5;
  const at = (u: number, z: number) => [r * Math.cos(u), r * Math.sin(u), z];
  const va0 = b.addVertex({ point: at(u0, 0) }), vc0 = b.addVertex({ point: at(u1, 0) });
  const va1 = b.addVertex({ point: at(u0, L) }), vc1 = b.addVertex({ point: at(u1, L) });
  const arc = (z: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle',
    position: { ...AXIS, origin: [0, 0, z] }, radius: r }), start, end, sameSense: true, range: [u0, u1] });
  const up = (u: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'line',
    point: at(u, 0), direction: [0, 0, 1], magnitude: 1 }), start, end, sameSense: true, range: [0, L] });
  const bottom = arc(0, va0, vc0), top = arc(L, va1, vc1), right = up(u1, vc0, vc1), left = up(u0, va0, va1);
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: r }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: bottom, orientation: 'forward' }, { edge: right, orientation: 'forward' },
      { edge: top, orientation: 'reversed' }, { edge: left, orientation: 'reversed' }] }] }));
  return b;
}

/**
 * A thin U: a degree-1 B-spline whose u runs along one arm (y = 0, x 0 to 10), across the bridge (x = 10, y 0 to 0.1)
 * and back along the other (y = 0.1), z its v (0 to 10); uncertainty 0.1. A face on the first arm bounded by one
 * closed cubic edge about (5, 5) of radius about 3 in x and z, no p-curve: its vertex on the arm (y = 0), its middle
 * 0.07 off it towards the other arm, nearer that one (0.03). Each sample's global foot there is on the other arm; a
 * foot continued from the sample before stays on its own. uFoldAway: its middle 0.3 off the arm on the far side, past
 * the tolerance but within the samples' spacing: continued too. uFoldFar: 3 off, past both: the global search there.
 * uFoldVertex: the arms 0.25 apart, the edge on the first arm, its vertex (tolerance 0.2) 0.13 off it and 0.12 from
 * the other: two feet, the nearer on the other arm, the edge's next samples on its own.
 */
export function uFold(middle = 0.07, g = 0.1, vertexY?: number): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.1 });
  const profile = [[0, 0], [10, 0], [10, g], [0, g]];
  const poles = profile.map(([x, y]) => [0, 10].map((z) => [x!, y!, z]));
  const surface = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1, 2, 3], vKnots: [0, 1],
    uMultiplicities: [2, 1, 1, 2], vMultiplicities: [2, 2], poles, uClosed: false, vClosed: false,
    selfIntersect: false, form: 'unspecified' });
  const off = [0, 0.5, 1, 1, 1, 1, 1, 0.5, 0].map((f) => f * middle);
  const loop = off.map((y, k) => [5 + 3 * Math.cos(2 * Math.PI * k / 8), y, 5 + 3 * Math.sin(2 * Math.PI * k / 8)]);
  const curve = b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1, 2, 3, 4, 5, 6], multiplicities: [4, 1, 1, 1, 1,
    1, 4], poles: loop, closed: true, selfIntersect: false, form: 'unspecified' });
  const v = vertexY === undefined ? b.addVertex({ point: loop[0]! })
    : b.addVertex({ point: [loop[0]![0]!, vertexY, loop[0]![2]!], tolerance: 0.2 });
  const e = b.addEdge({ curve, start: v, end: v, sameSense: true, range: [0, 6] });
  sheet(b, b.addFace({ surface, sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'forward' }] }] }));
  return b;
}

/**
 * A cone over a curved base: a degree (1, 2) B-spline whose u = 0 row is its apex at the origin (a pole line, v
 * free), its u = 1 row an arc in x = 10 (bulging 8 in z). The face between two edges from the apex that have only
 * p-curves, bending (quadratics in (u, v)): they leave the apex at v 0.6 and 0.4 and turn to 0.95 and 0.05 by
 * u 0.15, then run out to the base, which closes the loop at u = 1. So the boundary's run on the pole row is v 0.6 to
 * 0.4, while the curves cross a ring round the apex far along the row from it (v about 0.95 and 0.05).
 */
export function bentApex(): BrepBuilder {
  const b = new BrepBuilder();
  const base = [[10, -6, 0], [10, 0, 8], [10, 6, 0]];
  const surface = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 2, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [2, 2], vMultiplicities: [3, 3], poles: [[[0, 0, 0], [0, 0, 0], [0, 0, 0]], base],
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const quad2 = (p: number[][]) => b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3],
    poles: p, closed: false, selfIntersect: false, form: 'unspecified' });
  // The surface's point at (u, v): u times the base's arc at v (a quadratic Bezier).
  const at = (u: number, v: number) => [0, 1, 2].map((k) => u * ((1 - v) ** 2 * base[0]![k]! +
    2 * v * (1 - v) * base[1]![k]! + v ** 2 * base[2]![k]!));
  const apex = b.addVertex({ point: [0, 0, 0] });
  const q0 = b.addVertex({ point: at(1, 0.05) }), q1 = b.addVertex({ point: at(1, 0.95) });
  const eBase = b.addEdge({ start: q0, end: q1, sameSense: true });
  const eUp = b.addEdge({ start: apex, end: q1, sameSense: true });
  const eDown = b.addEdge({ start: apex, end: q0, sameSense: true });
  sheet(b, b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: eBase, orientation: 'forward', pcurve: b.addCurve(line2([1, 0.05], [0, 1])), range: [0, 0.9] },
    { edge: eUp, orientation: 'reversed', pcurve: quad2([[0, 0.6], [0.15, 0.95], [1, 0.95]]), range: [0, 1] },
    { edge: eDown, orientation: 'forward', pcurve: quad2([[0, 0.4], [0.15, 0.05], [1, 0.05]]), range: [0, 1] }] }] }));
  return b;
}

/**
 * A plane's sliver between an arc and its chord: the circle of radius 4 about the origin from -0.125 to 0.125 rad
 * (1 long, 0.9974 across), closed by the line back down. No p-curves.
 */
export function arcChord(): BrepBuilder {
  const b = new BrepBuilder();
  const h = 0.125, x = 4 * Math.cos(h), y = 4 * Math.sin(h);
  const lo = b.addVertex({ point: [x, -y, 0] }), hi = b.addVertex({ point: [x, y, 0] });
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 4 }), start: lo, end: hi,
    sameSense: true, range: [-h, h] });
  const line = b.addEdge({ curve: b.addCurve({ kind: 'line', point: [x, y, 0], direction: [0, -1, 0], magnitude: 1 }),
    start: hi, end: lo, sameSense: true, range: [0, 2 * y] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: arc, orientation: 'forward' }, { edge: line, orientation: 'forward' }] }] }));
  return b;
}

/**
 * A piece of a torus (major radius 5, minor 1) between u 0 and pi + 0.4 and v 0 and pi, both periodic: its sides the
 * tube circles at u = 0 (on the u seam) and at the far u, and the outer and inner equators' arcs (v = 0 on the v seam,
 * and v = pi). No p-curves; the loop starts at the u seam's use. Over half a period wide in u, so the far tube's
 * nearest copy to the seam's is the wrong one: only a recognized seam use leaves the regular uses to place it.
 */
export function torusWide(): BrepBuilder {
  const b = new BrepBuilder();
  const u1 = Math.PI + 0.4, c = Math.cos(u1), s = Math.sin(u1);
  const v00 = b.addVertex({ point: [6, 0, 0] }), v10 = b.addVertex({ point: [6 * c, 6 * s, 0] });
  const v11 = b.addVertex({ point: [4 * c, 4 * s, 0] }), v0p = b.addVertex({ point: [4, 0, 0] });
  const tube = (cu: number, su: number) => b.addCurve({ kind: 'circle',
    position: { origin: [5 * cu, 5 * su, 0], axis: [su, -cu, 0], xDir: [cu, su, 0] }, radius: 1 });
  const at0 = b.addEdge({ curve: tube(1, 0), start: v00, end: v0p, sameSense: true, range: [0, Math.PI] });
  const atFar = b.addEdge({ curve: tube(c, s), start: v10, end: v11, sameSense: true, range: [0, Math.PI] });
  const outer = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 6 }), start: v00, end: v10,
    sameSense: true, range: [0, u1] });
  const inner = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 4 }), start: v0p, end: v11,
    sameSense: true, range: [0, u1] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'torus', position: AXIS, majorRadius: 5, minorRadius: 1 }),
    sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: at0, orientation: 'reversed' }, { edge: outer, orientation: 'forward' },
      { edge: atFar, orientation: 'forward' }, { edge: inner, orientation: 'reversed' }] }] }));
  return b;
}

/**
 * A double cone: the line from (2, 0, 0) towards (0, 0, 2) revolved about z, an unbounded profile (v over all reals,
 * its apex (0, 0, 2) inside that range, at v = 2 sqrt 2). The face from the circle at z = 1 (radius 1, its vertex at
 * (1, 0, 1)) up to the apex: area pi sqrt 2.
 */
export function revolvedLineCone(): BrepBuilder {
  const b = new BrepBuilder();
  const s = Math.SQRT1_2;
  const profile = b.addCurve({ kind: 'line', point: [2, 0, 0], direction: [-s, 0, s], magnitude: 1 });
  const surface = b.addSurface({ kind: 'revolution', curve: profile, axisOrigin: [0, 0, 0], axisDirection: [0, 0, 1] });
  const v = b.addVertex({ point: [1, 0, 1] });
  const circle = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 1], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const e = b.addEdge({ curve: circle, start: v, end: v, sameSense: true });
  sheet(b, b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e, orientation: 'forward' }] }] }));
  return b;
}

/** Across the seam (u from -pi / 2 to pi / 2), by its p-curves, by p-curves a period apart, without any. */
export const halfCylinderPcurves = (): BrepBuilder => halfCylinder(-Math.PI / 2, 'same');
export const halfCylinderApart = (): BrepBuilder => halfCylinder(-Math.PI / 2, 'apart');
export const halfCylinderBare = (): BrepBuilder => halfCylinder(-Math.PI / 2, 'none');
/** Away from the seam (u from pi / 2 to 3 pi / 2), without p-curves. */
export const halfCylinderWest = (): BrepBuilder => halfCylinder(Math.PI / 2, 'none');

/**
 * A band (cylinder radius 2, z 0 to 5) whose circles are arcs: the bottom's [0, pi], [pi, 1.4 pi], [1.4 pi, 2 pi],
 * the top's [0, 1.4 pi], [1.4 pi, 2 pi], each loop ending on its arc to 2 pi. Sampled with spans up to 3.8 that arc
 * is one span, the widest gap in u, so the cut (at its middle) crosses each loop in its closing span: an edge whose
 * two samples are both junctions, given in the loop as the edges before and after it (the bottom's two edges, the
 * top's one).
 */
export function arcBand(): BrepBuilder {
  const b = new BrepBuilder();
  const at = (u: number, z: number) => [2 * Math.cos(u), 2 * Math.sin(u), z];
  const loop = (z: number, cuts: number[]) => {
    const circle = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] }, radius: 2 });
    const vs = cuts.map((u) => b.addVertex({ point: at(u, z) }));
    return cuts.map((u, k) => b.addEdge({ curve: circle, start: vs[k]!, end: vs[(k + 1) % cuts.length]!,
      sameSense: true, range: [u, k + 1 < cuts.length ? cuts[k + 1]! : 2 * Math.PI] }));
  };
  const bottom = loop(0, [0, Math.PI, 1.4 * Math.PI]), top = loop(5, [0, 1.4 * Math.PI]);
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: true,
    loops: [
      { kind: 'edge', bound: 'outer', sense: true,
        coedges: bottom.map((edge) => ({ edge, orientation: 'forward' as const })) },
      { kind: 'edge', bound: 'inner', sense: true,
        coedges: top.map((edge) => ({ edge, orientation: 'reversed' as const })) }] }));
  return b;
}

/**
 * A pocket on z = 0 with a cusp at the origin: its bottom an arc of radius 200 over 0.1 rad (centre (0, 200)), its
 * left a polyline of 24 spans on the arc of radius 2 over 0.7 rad (centre (0, 2)), both leaving the origin along +x
 * (the polyline's first span within a degree), then lines round its top. With angle 0.12 rad the bottom arc is one
 * span, its chord rising at 0.05 from the cusp, over the polyline's first points (rising at x / 4): the chord
 * crosses them until its span at the cusp is a quarter of the arc (a chord of h clears points beyond h / 100).
 * Mirrored (x to -x), its loop from the polyline: the mesher meets the chord after the polyline's spans, not before.
 */
function cuspPocket(mirrored: boolean): BrepBuilder {
  const b = new BrepBuilder();
  const sx = mirrored ? -1 : 1;
  const at = (r: number, t: number) => [sx * r * Math.sin(t), r - r * Math.cos(t), 0];
  const end = at(200, 0.1), pts = Array.from({ length: 25 }, (_, k) => at(2, 0.7 * k / 24)), last = pts[24]!;
  const bottom = b.addCurve({ kind: 'circle', position: { origin: [0, 200, 0], axis: [0, 0, sx], xDir: [0, -1, 0] },
    radius: 200 });
  const v0 = b.addVertex({ point: [0, 0, 0] }), va = b.addVertex({ point: end }), vb = b.addVertex({ point: last });
  const c = [end[0]!, 3, 0], d = [last[0]!, 3, 0];
  const vc = b.addVertex({ point: c }), vd = b.addVertex({ point: d });
  const eBottom = b.addEdge({ curve: bottom, start: v0, end: va, sameSense: true, range: [0, 0.1] });
  const eLeft = b.addEdge({ curve: b.addCurve({ kind: 'polyline', points: pts }), start: v0, end: vb,
    sameSense: true, range: [0, 24] });
  const line = (p: number[], q: number[], start: number, end: number) => {
    const l = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!);
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p,
      direction: [(q[0]! - p[0]!) / l, (q[1]! - p[1]!) / l, 0], magnitude: 1 }), start, end, sameSense: true,
      range: [0, l] });
  };
  const up = line(end, c, va, vc), top = line(c, d, vc, vd), down = line(d, last, vd, vb);
  const ccw = [{ edge: eBottom, orientation: 'forward' as const }, { edge: up, orientation: 'forward' as const },
    { edge: top, orientation: 'forward' as const }, { edge: down, orientation: 'forward' as const },
    { edge: eLeft, orientation: 'reversed' as const }];
  // (Mirrored, the same loop runs clockwise: reversed to keep the face on its left.)
  const coedges = mirrored ? ccw.reverse().map((c) => ({ edge: c.edge,
    orientation: c.orientation === 'forward' ? 'reversed' as const : 'forward' as const })) : ccw;
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
export const cuspPocket_ = (): BrepBuilder => cuspPocket(false);
export const cuspPocketMirrored = (): BrepBuilder => cuspPocket(true);

/**
 * A triangle on z = 0 whose curved side leaves its corner at the origin beside its straight one and crosses it: L the
 * line (0, 0) to (10, 0), C a cubic Bezier (0, 0), (1, -0.1), (2, 0.6), (3, 3) to the third corner, a line between.
 * C itself runs below L to 0.0099 at x 0.2, back over it at x 0.43 (LMP1 #172995's #1073191's corner, in the
 * open). Under an uncertainty of 0.05 that dip is on L; under 1e-3 it isn't. Mirrored (y to -y), C leaves the
 * corner after L in the loop instead of arriving before it. Turned: the face's sense false, its loop the other way.
 */
function cuspCrossing(mirrored: boolean, uncertainty: number, turned = false): BrepBuilder {
  const b = new BrepBuilder({ uncertainty });
  const sy = mirrored ? -1 : 1;
  const v0 = b.addVertex({ point: [0, 0, 0] }), v1 = b.addVertex({ point: [10, 0, 0] });
  const v2 = b.addVertex({ point: [3, 3 * sy, 0] });
  const L = b.addEdge({ curve: b.addCurve(line2([0, 0, 0], [1, 0, 0])), start: v0, end: v1, sameSense: true,
    range: [0, 10] });
  const l = Math.hypot(7, 3);
  const M = b.addEdge({ curve: b.addCurve(line2([10, 0, 0], [-7 / l, 3 * sy / l, 0])), start: v1, end: v2,
    sameSense: true, range: [0, l] });
  const C = b.addEdge({ curve: b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1], multiplicities: [4, 4],
    poles: [[0, 0, 0], [1, -0.1 * sy, 0], [2, 0.6 * sy, 0], [3, 3 * sy, 0]], closed: false, selfIntersect: false,
    form: 'unspecified' }), start: v0, end: v2, sameSense: true,
    range: [0, 1] });
  const ccw = mirrored
    ? [{ edge: C, orientation: 'forward' as const }, { edge: M, orientation: 'reversed' as const },
      { edge: L, orientation: 'reversed' as const }]
    : [{ edge: L, orientation: 'forward' as const }, { edge: M, orientation: 'forward' as const },
      { edge: C, orientation: 'reversed' as const }];
  const coedges = turned ? ccw.reverse().map((c) => ({ edge: c.edge,
    orientation: c.orientation === 'forward' ? 'reversed' as const : 'forward' as const })) : ccw;
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: !turned,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * cuspCrossing's corner on a cylinder of radius 10 at its seam: L the arc z = 0 from u = 2 pi - 1 to the seam vertex
 * (10, 0, 0), its p-curve ending at u = 2 pi; C, with no 3D curve, leaving that vertex by its p-curve from (0, 0),
 * the plane's Bezier with u = -x / 10 (a millimetre an x of 1): (0, 0), (-0.1, -0.1), (-0.2, 0.6), (-0.3, 3), below
 * z = 0 to 0.0099 over its first 0.043 rad; M back from its end to L's start. The two uses meet a period apart in
 * (u, v). Under an uncertainty of 0.05.
 */
function cuspSeam(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.05 });
  const R = 10, P2 = 2 * Math.PI;
  const at = (u: number, z: number) => [R * Math.cos(u), R * Math.sin(u), z];
  const v = b.addVertex({ point: at(0, 0) }), vl = b.addVertex({ point: at(P2 - 1, 0) });
  const vc = b.addVertex({ point: at(-0.3, 3) });
  const L = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: R }), start: vl, end: v,
    sameSense: true, range: [P2 - 1, P2] });
  const C = b.addEdge({ start: v, end: vc, sameSense: true });
  const M = b.addEdge({ start: vc, end: vl, sameSense: true });
  const lm = Math.hypot(0.7, 3);
  const coedges: Coedge[] = [
    { edge: L, orientation: 'forward', pcurve: b.addCurve(line2([0, 0], [1, 0])) },
    { edge: C, orientation: 'forward', range: [0, 1], pcurve: b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1],
      multiplicities: [4, 4], poles: [[0, 0], [-0.1, -0.1], [-0.2, 0.6], [-0.3, 3]], closed: false,
      selfIntersect: false, form: 'unspecified' }) },
    { edge: M, orientation: 'forward', range: [0, lm],
      pcurve: b.addCurve(line2([P2 - 0.3, 3], [-0.7 / lm, -3 / lm])) }];
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: R }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
export const cuspCrossing_ = (): BrepBuilder => cuspCrossing(false, 0.05);
export const cuspCrossingMirrored = (): BrepBuilder => cuspCrossing(true, 0.05);
export const cuspCrossingTight = (): BrepBuilder => cuspCrossing(false, 1e-3);
export const cuspCrossingTurned = (): BrepBuilder => cuspCrossing(false, 0.05, true);
export const cuspSeam_ = (): BrepBuilder => cuspSeam();

/** A circle on z = 0 (axis +z: counterclockwise as t grows) about (cx, cy), t = 0 along xDir. */
function planeCircle(b: BrepBuilder, cx: number, cy: number, r: number, xDir: number[]): number {
  return b.addCurve({ kind: 'circle', position: { origin: [cx, cy, 0], axis: [0, 0, 1], xDir }, radius: r });
}

/**
 * A plane annulus inside a circle of radius 9.5 whose hole is a flower: a circle of radius 3 in four quarter arcs,
 * a circle of radius 3 tangent outside it at each quarter vertex, each a closed edge from and to that vertex (as
 * lightarm's #93530). Its hole's loop passes each of those vertices twice. Area pi (9.5^2 - 5 x 3^2) = 45.25 pi.
 */
export function flowerHole(): BrepBuilder {
  const b = new BrepBuilder();
  const vo = b.addVertex({ point: [9.5, 0, 0] });
  const outer = b.addEdge({ curve: planeCircle(b, 0, 0, 9.5, [1, 0, 0]), start: vo, end: vo, sameSense: true });
  const centre = planeCircle(b, 0, 0, 3, [1, 0, 0]);
  const phi = (k: number) => -k * Math.PI / 2;
  const vs = [0, 1, 2, 3].map((k) => b.addVertex({ point: [3 * Math.cos(phi(k)), 3 * Math.sin(phi(k)), 0] }));
  const hole: { edge: number; orientation: 'reversed' }[] = [];
  for (let k = 0; k < 4; k++) {
    const c = [Math.cos(phi(k)), Math.sin(phi(k))];
    const petal = b.addEdge({ curve: planeCircle(b, 6 * c[0]!, 6 * c[1]!, 3, [-c[0]!, -c[1]!, 0]), start: vs[k]!,
      end: vs[k]!, sameSense: true });
    const arc = b.addEdge({ curve: centre, start: vs[(k + 1) % 4]!, end: vs[k]!, sameSense: true,
      range: [phi(k + 1), phi(k)] });
    hole.push({ edge: petal, orientation: 'reversed' }, { edge: arc, orientation: 'reversed' });
  }
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: outer, orientation: 'forward' }] },
    { kind: 'edge', bound: 'inner', sense: true, coedges: hole }] }));
  return b;
}

/**
 * A plane disc of radius 5 (two semicircles between (5, 0) and (-5, 0)) with two lobes its loop leaves and returns
 * to at one vertex (as LMP1's #1080908): at (5, 0) a circle of radius 1 in three arcs, at (-5, 0) one of radius 1
 * as a closed edge, both outside the disc. Area 27 pi.
 */
export function lobes(): BrepBuilder {
  const b = new BrepBuilder();
  const v = b.addVertex({ point: [5, 0, 0] }), w = b.addVertex({ point: [-5, 0, 0] });
  const main = planeCircle(b, 0, 0, 5, [1, 0, 0]);
  const top = b.addEdge({ curve: main, start: v, end: w, sameSense: true, range: [0, Math.PI] });
  const bottom = b.addEdge({ curve: main, start: w, end: v, sameSense: true, range: [Math.PI, 2 * Math.PI] });
  const east = planeCircle(b, 6, 0, 1, [-1, 0, 0]);
  const at = (t: number) => b.addVertex({ point: [6 - Math.cos(t), -Math.sin(t), 0] });
  const ea = at(2 * Math.PI / 3), eb = at(4 * Math.PI / 3);
  const lobe = [[v, ea, 0, 2 * Math.PI / 3], [ea, eb, 2 * Math.PI / 3, 4 * Math.PI / 3],
    [eb, v, 4 * Math.PI / 3, 2 * Math.PI]].map(([s, e, lo, hi]) => b.addEdge({ curve: east, start: s!, end: e!,
    sameSense: true, range: [lo!, hi!] }));
  const west = b.addEdge({ curve: planeCircle(b, -6, 0, 1, [1, 0, 0]), start: w, end: w, sameSense: true });
  const fwd = (edge: number) => ({ edge, orientation: 'forward' as const });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true,
      coedges: [fwd(top), fwd(west), fwd(bottom), ...lobe.map(fwd)] }] }));
  return b;
}

/** The unit square on z = 0 with an internal edge from its corner (0, 0) to its middle: a loop's vertex shared. */
export function slitFromCorner(): BrepBuilder {
  const b = new BrepBuilder();
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const line = (p: number[], q: number[], start: number, end: number) => {
    const l = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!);
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p,
      direction: [(q[0]! - p[0]!) / l, (q[1]! - p[1]!) / l, 0], magnitude: 1 }), start, end, sameSense: true,
      range: [0, l] });
  };
  const sides = corners.map((c, k) => line(c, corners[(k + 1) % 4]!, vs[k]!, vs[(k + 1) % 4]!));
  const slit = line([0, 0, 0], [0.5, 0.5, 0], vs[0]!, b.addVertex({ point: [0.5, 0.5, 0] }));
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: [...sides.map((edge) => ({ edge,
      orientation: 'forward' as const })), { edge: slit, orientation: 'internal' as const }] }] }));
  return b;
}

/**
 * The unit sphere's lune between longitudes 0.5 and 1.5, pole to pole, and a cap of angular radius 0.2 west of it
 * touching its west meridian at the equator: the loop down that meridian leaves and returns to that vertex round the
 * cap, before the south pole's fan. Area 2 + 2 pi (1 - cos 0.2).
 */
export function lunePinch(): BrepBuilder {
  const b = new BrepBuilder();
  const a = 0.5, c = 1.5, rho = 0.2;
  const s = b.addVertex({ point: [0, 0, -1] }), n = b.addVertex({ point: [0, 0, 1] });
  const mid = [Math.cos(a), Math.sin(a), 0], vm = b.addVertex({ point: mid });
  const west = meridian(b, a);
  const upper = b.addEdge({ curve: west, start: vm, end: n, sameSense: true, range: [0, Math.PI / 2] });
  const lower = b.addEdge({ curve: west, start: s, end: vm, sameSense: true, range: [-Math.PI / 2, 0] });
  const east = b.addEdge({ curve: meridian(b, c), start: s, end: n, sameSense: true,
    range: [-Math.PI / 2, Math.PI / 2] });
  const C = [Math.cos(a - rho), Math.sin(a - rho), 0], k = Math.cos(rho), r = Math.sin(rho);
  const centre = C.map((x) => k * x);
  const cap = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: centre, axis: C,
    xDir: mid.map((x, i) => (x - centre[i]!) / r) }, radius: r }), start: vm, end: vm, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: upper, orientation: 'reversed' }, { edge: cap, orientation: 'forward' },
      { edge: lower, orientation: 'reversed' }, { edge: east, orientation: 'forward' }] }] }));
  return b;
}

/**
 * A face of a spindle torus (minor radius twice the major: the tube through its axis at the apex v = 2 pi / 3) with
 * a corner at the apex: u from 0.2 to 1.2, v from 2 pi / 3 - 0.2 to the apex, bounded by the parallel there and two
 * lines up near its meridians' chords (within 0.1 of them), no p-curves. Each line ends `past` from the apex across
 * the axis (off the surface, as LMP1's spindle tori's edges do), where its foot is across the apex, half a turn round
 * in u; its uncertainty 0.2 (LMP1's), so those points are at the apex within the tolerance. Major radius R.
 */
export function spindleCorner(past: number, R = 10): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.2 });
  const r = 2 * R, va = 2 * Math.PI / 3, v0 = va - 0.2, u1 = 0.2, u2 = 1.2;
  const at = (u: number, v: number) => [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u),
    r * Math.sin(v)];
  const p1 = b.addVertex({ point: at(u1, v0) }), p2 = b.addVertex({ point: at(u2, v0) });
  const top = [0, 0, r * Math.sin(va)];
  const apex = b.addVertex({ point: top, tolerance: 2 * past });
  const parallel = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, r * Math.sin(v0)] },
    radius: R + r * Math.cos(v0) });
  // From the parallel at u to `past` across the axis from the apex, opposite u.
  const line = (u: number, start: number) => {
    const p = at(u, v0), q = [-past * Math.cos(u), -past * Math.sin(u), top[2]!];
    const d = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!], l = Math.hypot(d[0]!, d[1]!, d[2]!);
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: d.map((x) => x / l), magnitude: 1 }),
      start, end: apex, sameSense: true, range: [0, l] });
  };
  const bottom = b.addEdge({ curve: parallel, start: p1, end: p2, sameSense: true, range: [u1, u2] });
  const right = line(u2, p2), left = line(u1, p1);
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'torus', position: AXIS, majorRadius: R, minorRadius: r }),
    sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: bottom, orientation: 'forward' }, { edge: right, orientation: 'forward' },
      { edge: left, orientation: 'reversed' }] }] }));
  return b;
}

/** The unit sphere's cap within `colatitude` of its north pole, bounded by its circle alone. */
export function capWithin(colatitude: number): BrepBuilder {
  const b = new BrepBuilder();
  const r = Math.sin(colatitude), z = Math.cos(colatitude);
  const circle = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] }, radius: r });
  const v = b.addVertex({ point: [r, 0, z] });
  const e = b.addEdge({ curve: circle, start: v, end: v, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'forward' }] }] }));
  return b;
}

/**
 * Two lunes between longitudes pi / 4 and 3 pi / 4 meeting at one north pole (0, 0, 1): the unit sphere's, and a
 * sphere of radius 3 about (0, 0, -2)'s (flatter there: its fans pass farther out). Two sheets; the pole one point.
 */
export function poleLunes(): BrepBuilder {
  const b = new BrepBuilder();
  const n = b.addVertex({ point: [0, 0, 1] });
  for (const [R, cz] of [[1, 0], [3, -2]] as const) {
    const s = b.addVertex({ point: [0, 0, cz - R] });
    const merid = (u: number) => b.addCurve({ kind: 'circle', position: { origin: [0, 0, cz],
      axis: [Math.sin(u), -Math.cos(u), 0], xDir: [Math.cos(u), Math.sin(u), 0] }, radius: R });
    const half: [number, number] = [-Math.PI / 2, Math.PI / 2];
    const ma = b.addEdge({ curve: merid(Math.PI / 4), start: s, end: n, sameSense: true, range: half });
    const mc = b.addEdge({ curve: merid(3 * Math.PI / 4), start: s, end: n, sameSense: true, range: half });
    const surface = b.addSurface({ kind: 'sphere', position: { ...AXIS, origin: [0, 0, cz] }, radius: R });
    sheet(b, b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
        coedges: [{ edge: mc, orientation: 'forward' }, { edge: ma, orientation: 'reversed' }] }] }));
  }
  return b;
}

/**
 * A lens on a sphere of radius 10 between two small circles of radius 1 through its north pole (0, 0, 10), their
 * planes tilted 0.1 (in sine) towards +x and +y: its corner at the pole between two arcs far more curved than the
 * sphere, so they stay straight within d over a shorter reach than the fans need.
 */
export function poleLens(): BrepBuilder {
  const b = new BrepBuilder();
  const R = 10, h = Math.sqrt(R * R - 1), nz = h / R, s = Math.sqrt(1 - nz * nz);
  const normals = [[s, 0, nz], [0, s, nz]];
  // The planes' line meets the sphere at the pole and at p: x = y by symmetry, n . p = h, |p| = R.
  // With p = (a, a, c): s a + nz c = h, 2 a^2 + c^2 = R^2; the root other than (0, 0, R).
  const A = 2 + (s * s) / (nz * nz), B = -2 * s * h / (nz * nz), C = (h * h) / (nz * nz) - R * R;
  const a = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A) > 1e-9 ? (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A)
    : (-B - Math.sqrt(B * B - 4 * A * C)) / (2 * A);
  const p = [a, a, (h - s * a) / nz], pole = [0, 0, R];
  const vn = b.addVertex({ point: pole }), vp = b.addVertex({ point: p });
  const arc = (n: number[]) => {
    const c = n.map((x) => h * x);
    const xd = [pole[0]! - c[0]!, pole[1]! - c[1]!, pole[2]! - c[2]!];
    const yd = [n[1]! * xd[2]! - n[2]! * xd[1]!, n[2]! * xd[0]! - n[0]! * xd[2]!, n[0]! * xd[1]! - n[1]! * xd[0]!];
    const q = [p[0]! - c[0]!, p[1]! - c[1]!, p[2]! - c[2]!];
    const dot = (u: number[], w: number[]) => u[0]! * w[0]! + u[1]! * w[1]! + u[2]! * w[2]!;
    let t = Math.atan2(dot(q, yd), dot(q, xd));
    if (t < 0) t += 2 * Math.PI;
    // From the pole (t = 0) the short way to p.
    const curve = b.addCurve({ kind: 'circle', position: { origin: c, axis: n, xDir: xd }, radius: 1 });
    return t <= Math.PI ? b.addEdge({ curve, start: vn, end: vp, sameSense: true, range: [0, t] })
      : b.addEdge({ curve, start: vp, end: vn, sameSense: true, range: [t, 2 * Math.PI] });
  };
  const ex = arc(normals[0]!), ey = arc(normals[1]!);
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: R }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: ex, orientation: 'forward' },
      { edge: ey, orientation: 'forward' }] }] }));
  return b;
}

const cross3 = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!];
const unit3 = (a: number[]) => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return a.map((x) => x / l);
};

/**
 * The unit sphere's region inside a small circle (angular radius 0.3) through its north pole: the circle's arc from
 * the pole round 330 degrees to q, which comes back towards the pole (q 2 sin 0.3 sin(pi / 12) from it), and the
 * meridian from q up to the pole. The arc's later part, once it turns back, is boundary near the pole away from it.
 */
export function curlBack(): BrepBuilder {
  const b = new BrepBuilder();
  const alpha = 0.3, n = [Math.sin(alpha), 0, Math.cos(alpha)], c = n.map((x) => Math.cos(alpha) * x);
  const pole = [0, 0, 1], r = Math.sin(alpha);
  const xd = unit3(pole.map((x, i) => x - c[i]!)), yd = cross3(n, xd), t = 11 * Math.PI / 6;
  const q = c.map((x, i) => x + r * (Math.cos(t) * xd[i]! + Math.sin(t) * yd[i]!));
  const vn = b.addVertex({ point: pole }), vq = b.addVertex({ point: q });
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: c, axis: n, xDir: xd }, radius: r }),
    start: vn, end: vq, sameSense: true, range: [0, t] });
  // The great circle through q and the pole, from q (its xDir) up.
  const axis = unit3(cross3(q, pole)), up = Math.acos(Math.min(1, q[2]!));
  const merid = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis, xDir: q },
    radius: 1 }), start: vq, end: vn, sameSense: true, range: [0, up] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: arc, orientation: 'forward' },
      { edge: merid, orientation: 'forward' }] }] }));
  return b;
}

/**
 * The unit sphere's side of a great circle that passes `delta` (5e-4) from its north pole, its vertex on the far side
 * (no sample near the pole), the model's uncertainty 1e-3: the circle is incident to the pole without ending there.
 */
export function passBy(delta = 5e-4): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-3 });
  // The circle's plane: normal (0, -cos delta, sin delta), so its nearest point to the pole is (0, sin delta,
  // cos delta); its vertex the far point, (0, -sin delta, -cos delta).
  const axis = [0, -Math.cos(delta), Math.sin(delta)], far = [0, -Math.sin(delta), -Math.cos(delta)];
  const v = b.addVertex({ point: far });
  const e = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis, xDir: far },
    radius: 1 }), start: v, end: v, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: e, orientation: 'forward' }] }] }));
  return b;
}

/**
 * The unit square on z = 0 whose bottom edge, a line (one span: its ends its only samples), has a p-curve wrong
 * between its ends and at one of them: from (0, 0) to (0.5, 0.3), not (1, 0) (as pr1db #1317's p-curves along a
 * collapsed row, one 3D point, against their semicircles). The other sides' p-curves are right. With `wiggle`, the
 * bottom edge's parameter runs 0 to 8 and its p-curve is a polyline right at each eighth but the fifth, 0.3 below:
 * right at the samples and at each span's middle where the edge is two spans, wrong at the second's first quarter.
 */
export function wrongEndPcurve(wiggle = false): BrepBuilder {
  const b = new BrepBuilder();
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = corners.map((point) => b.addVertex({ point }));
  const coedges = corners.map((c, k) => {
    const q = corners[(k + 1) % 4]!, d = [q[0]! - c[0]!, q[1]! - c[1]!, 0];
    const w = wiggle && k === 0 ? 8 : 1;
    const curve = b.addCurve({ kind: 'line', point: c, direction: d.map((x) => x / w), magnitude: 1 });
    const edge = b.addEdge({ curve, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, range: [0, w] });
    const pcurve = b.addCurve(k !== 0 ? line2([c[0]!, c[1]!], [d[0]!, d[1]!])
      : wiggle ? { kind: 'polyline', points: Array.from({ length: 9 }, (_, i) => [i / 8, i === 5 ? -0.3 : 0]) }
        : line2([0, 0], [0.5, 0.3]));
    return { edge, orientation: 'forward' as const, pcurve };
  });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

export const MODELS = { kinkStrip: () => kinkStrip(), kinkStripV: () => kinkStrip(true),
  cuspCrossing: cuspCrossing_, cuspCrossingMirrored, cuspCrossingTight, cuspCrossingTurned, cuspSeam: cuspSeam_,
  kinkStripQuadratic: () => kinkStrip(false, true), kinkStripRun: () => kinkStrip(false, false, 0.004, true),
  affineFeetOff, plateHoles,
  bsplineApexHole, offPoleArcLoose, loopless, looplessBsplines, bsplineBall: () => bsplineBall(),
  bsplineBallNoisy: () => bsplineBall(3e-6), bsplineBallV: () => bsplineBall(0, true),
  bsplineBallNoisyV: () => bsplineBall(3e-6, true), wholeTorus, wholeSphereVertex,
  bsplineApex: () => bsplineApex(), poleHole, smallHole, sBend, cuspEdge: () => cuspEdge(), nearCusp6,
  bumpPatch: () => bumpPatch(), halfBump: () => bumpPatch(true),
  sineSheet40: () => sineSheet(40), thinBand, tubeGapFaceTolerance, tubeGapUncertainty,
  tubeGapBySize, tubeGapOpen, torusOuterHalf, meridianHemisphereLoose, offPoleRest: () => offPoleRest(),
  seamHemisphere: () => seamHemisphere(true), seamHemisphereBare: () => seamHemisphere(false),
  seamCone: () => seamCone(true), seamConeBare: () => seamCone(false),
  offPoleRestLoose: () => offPoleRest(1e-3), wigglyBand, notchBand, bsplineTube, tubeQuarterPeriodUp, coarseProjection,
  fineProjection, knotAtEnd, kinkAtEnd: () => kinkAtEnd(), kinkAtEndPlain: () => kinkAtEnd(0), cornerFold,
  sphereBelt: () => sphereBelt(3, 1, true), sphereBeltInward: () => sphereBelt(3, 1, false),
  sphereBeltEven: () => sphereBelt(3, 2, true), sphereBeltEvenInward: () => sphereBelt(3, 2, false),
  planeHoleOnly, cornerFoldTightAgainst, skewPatch, ballWithFlat: () => ballWithFlat(),
  ballWithFlatCap: () => ballWithFlat(true), ballAlone: () => ballWithFlat(false, 'none'),
  ballFlatSameWay: () => ballWithFlat(false, 'same'),
  ballFlippedCap: () => ballWithFlat(false, 'flippedCap'), roof: () => roof(), roofJunction: () => roof(0, 1, true),
  roofNear: () => roof(0, 0.52), roofBeyond: () => roof(0, 0.5),
  roofShallow: () => roof(0, 1, false, 5 * Math.tan(0.105)), roofJunctionAt: () => roof(0, 1, true, 2, 1),
  roofCross: () => creasedPatch('cross'), roofArched: () => creasedPatch('arched'),
  edgeFarOff: () => edgeFarOff(), edgeFarOffPcurve: () => edgeFarOff(true),
  roofBent: () => roof(0, 1, false, 2, 0, 0.004), roofNotch, thinRing, pcurveNear,
  clampedCorner: () => clampedCorner(),
  clampedCornerTight: () => clampedCorner(0.01), sideWobble: () => sideWobble(), lineWobble: () => sideWobble(0.9),
  bandTwoSlots, poleDip, poleDipFar: () => poleDipFar(), poleDipFarLoose: () => poleDipFar(2e-3, 0.01), lensPlane,
  cylinderVast: () => halfCylinder(0, 'none', 8000, 22600), cylinderLong: () => halfCylinder(0, 'none', 2, 4000),
  cornerFoldTight, pcurveShortHair, pcurveShortFar, pcurveShortStart, bsplineTubeTinyArc, bsplineDome,
  offPoleArc: () => offPoleArc(), offPcurves, bandHoleAtVertex, bandHoleOnCut, halfCap, meridianHemisphere, band: band_,
  bandByInversion, bore, nistBore, seamByInversion, torusWide, offVertex, pcurveOnly: () => pcurveOnly(),
  pcurveOnlyWest: () => pcurveOnly(true), luneQuarter, luneOnSeam, luneOffPole, luneOffPoleBack,
  luneOffPoleC, luneOffPoleCBack, cap, splineEdge,
  seamFlipped, polylineEdge, pcurveCircle, arcSegment, fold, twisted, wrongSense, zeroEdge, halfCylinderPcurves,
  halfCylinderApart, halfCylinderBare, halfCylinderWest, arcBand, cuspPocket: cuspPocket_,
  cuspPocketMirrored, flowerHole, lobes,
  slitFromCorner, lunePinch, spindleApex: () => spindleCorner(0.005),
  tinyCap: () => capWithin(0.01), capWithinPole, narrowStrip: () => narrowStrip(),
  narrowStripSmall: () => narrowStrip(0.05, 1e-3), uFold: () => uFold(), uFoldFlat: () => uFold(0),
  uFoldVertex: () => uFold(0, 0.25, 0.13),
  uFoldAway: () => uFold(-0.3), uFoldFar: () => uFold(-3), pcurveShifted, poleLunes, poleLens, curlBack, passBy,
  revolvedLineCone,
  arcChord,
  bentApex, wrongEndPcurve: () => wrongEndPcurve(), wigglePcurve: () => wrongEndPcurve(true) };

/**
 * An analysis buffer (cad-brep's analysis-layout.ts) of a model's rows: every column of the vertex, edge and coedge
 * tables at its default (0, f64 NaN), the values given in their place, and the trace rows given; the model's hash
 * zero (tess-cadio doesn't check it).
 */
function analysisOf(model: BrepBuilder, given: { vertex?: Record<string, number[]>; edge?: Record<string, number[]>;
  coedge?: Record<string, number[]>; trace?: Record<string, number[]> }): Uint8Array {
  const d = model.finish();
  const rows = { vertex: d.vertex.point.length / 3, edge: d.edge.start.length, coedge: d.coedge.edge.length };
  const tables: Record<string, Record<string, ArrayLike<number>>> = {
    analysis: { model: new Uint32Array(8), uncertainty: [d.part.uncertainty?.[0] ?? NaN] } as never };
  for (const t of ['vertex', 'edge', 'coedge'] as const) {
    const cols: Record<string, ArrayLike<number>> = {};
    for (const [name, type, width] of ANALYSIS_TABLES[t] as readonly (readonly [string, string, number])[])
      cols[name] = given[t]?.[name] ?? new Array(rows[t] * width).fill(type === 'f64' ? NaN : 0);
    tables[t] = cols;
  }
  if (given.trace) {
    const n = given.trace.coedge!.length, cols: Record<string, ArrayLike<number>> = {};
    for (const [name, type] of ANALYSIS_TABLES.trace as readonly (readonly [string, string, number])[])
      cols[name] = given.trace[name] ?? new Array(n).fill(type === 'f64' ? NaN : 0);
    tables.trace = cols;
  }
  return new Uint8Array(writeAnalysis(tables as AnalysisRows).buffer);
}

/**
 * Analysis buffers for the C++ tests, by name, each of one of MODELS (its `model`): pcurveNearHealed its coedge's
 * p-curve healing's (a trace at 0.005); lunesEdgePast poleLunes's first edge's tolerance grown past repair (from
 * 1e-5), lunesVertexPast its first vertex's, sphereVertexPast wholeSphereVertex's vertex (its face's loop).
 */
export const ANALYSES: Record<string, { model: keyof typeof MODELS; data: () => Uint8Array }> = {
  pcurveNearHealed: { model: 'pcurveNear', data: () => analysisOf(pcurveNear(),
    { coedge: { pcurveFrom: [3] }, trace: { coedge: [0], status: [0], tol: [0.005] } }) },
  lunesEdgePast: { model: 'poleLunes', data: () => {
    const n = MODELS.poleLunes().finish().edge.start.length;
    return analysisOf(MODELS.poleLunes(), { edge: { toleranceError: [1, ...new Array(n - 1).fill(0)],
      givenTolerance: new Array(n).fill(1e-5) } });
  } },
  sphereVertexPast: { model: 'wholeSphereVertex', data: () => analysisOf(MODELS.wholeSphereVertex(),
    { vertex: { toleranceError: [1], givenTolerance: [1e-5] } }) },
  lunesVertexPast: { model: 'poleLunes', data: () => {
    const n = MODELS.poleLunes().finish().vertex.point.length / 3;
    return analysisOf(MODELS.poleLunes(), { vertex: { toleranceError: [1, ...new Array(n - 1).fill(0)],
      givenTolerance: new Array(n).fill(1e-5) } });
  } },
};
