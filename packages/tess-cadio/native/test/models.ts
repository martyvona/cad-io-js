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
 * swapped from a sphere's; area 4 pi.
 */
export function bsplineBall(): BrepBuilder {
  const b = new BrepBuilder();
  const meridian = [[0, -1, 1], [1, -1, Math.SQRT1_2], [1, 0, 1], [1, 1, Math.SQRT1_2], [0, 1, 1]];  // (r, z, w)
  const poles = meridian.map(([r, z]) => CIRCLE9.xy.map(([x, y]) => [r! * x!, r! * y!, z!]));
  const weights = meridian.map((m) => CIRCLE9.w.map((w) => w * m[2]!));
  const surface = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 2, uKnots: [0, 1, 2], vKnots: [0, 1, 2, 3, 4],
    uMultiplicities: [3, 2, 3], vMultiplicities: [3, 2, 2, 2, 3], poles, weights, uClosed: false, vClosed: true,
    selfIntersect: false, form: 'unspecified' });
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
 * of degree 2 across the crease and its knots simple, its second partial between them exactly 1 / (2 h). Bounded by
 * its four sides, the creased ones B-splines of its own knots.
 */
export function kinkStrip(inV = false, quadratic = false, h = 5e-5): BrepBuilder {
  const b = new BrepBuilder();
  const deg = quadratic ? 2 : 3, inner = quadratic ? 1 : 2;
  const knots = [0, 0.5 - h, 0.5 + h, 1], mults = [deg + 1, inner, inner, deg + 1];
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
    // (A side across the crease: its poles the surface's along it, backwards where the side runs back.)
    const creased = inV ? du === 0 : dv === 0;
    const curve = creased
      ? b.addCurve({ kind: 'bspline', degree: deg, knots, multiplicities: mults, closed: false, selfIntersect: false,
        form: 'unspecified', poles: g.map((t) => (du + dv > 0 ? t : 1 - t)).map((t) => at(a[0]! + du * t,
          a[1]! + dv * t)) })
      : b.addCurve({ kind: 'line', point: at(a[0]!, a[1]!), direction: [du, dv, 0], magnitude: 1 });
    const edge = b.addEdge({ curve, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true,
      range: creased ? [0, 1] : [0, 10] });
    const pcurve = b.addCurve({ kind: 'line', point: a, direction: [du, dv], magnitude: creased ? 1 : 0.1 });
    return { edge, orientation: 'forward' as const, pcurve };
  });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

export const MODELS = { kinkStrip: () => kinkStrip(), kinkStripV: () => kinkStrip(true),
  kinkStripQuadratic: () => kinkStrip(false, true), affineFeetOff, plateHoles,
  bsplineApexHole, offPoleArcLoose, loopless, bsplineBall, wholeTorus, wholeSphereVertex,
  bsplineApex: () => bsplineApex(), poleHole, smallHole, sBend, cuspEdge: () => cuspEdge(), nearCusp6,
  bumpPatch: () => bumpPatch(), halfBump: () => bumpPatch(true), thinBand, tubeGapFaceTolerance, tubeGapUncertainty,
  tubeGapBySize, tubeGapOpen, torusOuterHalf, meridianHemisphereLoose, offPoleRest: () => offPoleRest(),
  offPoleRestLoose: () => offPoleRest(1e-3), wigglyBand, notchBand, bsplineTube, bsplineTubeTinyArc, bsplineDome,
  offPoleArc: () => offPoleArc(), offPcurves, bandHoleAtVertex, bandHoleOnCut, halfCap, meridianHemisphere, band: band_,
  bandByInversion, bore, nistBore, seamByInversion, offVertex, pcurveOnly, luneQuarter, luneOnSeam, cap, splineEdge,
  seamFlipped, polylineEdge, pcurveCircle, arcSegment, fold, twisted, wrongSense, zeroEdge };
