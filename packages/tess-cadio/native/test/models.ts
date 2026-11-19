// B-reps for the edge sampler's tests (edges_test.cpp), beside cad-brep's (packages/cad-brep/test/models.ts): each
// the smallest with the case named. `fixtures.ts` writes them, and cad-brep's, as a header.
import { BrepBuilder } from '../../../cad-brep/src/builder.ts';
import type { Coedge, Curve } from '../../../cad-brep/src/types.ts';

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
function cornerFoldAt(faceTolerance: number): BrepBuilder {
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
    coedges.push(k === 2 || k === 3
      ? { edge, orientation: 'forward', pcurve: b.addCurve(line2(a!, [(c![0]! - a![0]!) / l, (c![1]! - a![1]!) / l])) }
      : { edge, orientation: 'forward' });
  }
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    tolerance: faceTolerance,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
export const cornerFold = (): BrepBuilder => cornerFoldAt(0.01);
/** The same with the face's tolerance 0.001: the chord 0.0014 from the corner's point, past it. */
export const cornerFoldTight = (): BrepBuilder => cornerFoldAt(0.001);

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

/**
 * Half a cylinder (radius 2, z 0 to 4) from longitude u0 to u0 + pi: two semicircles and two lines. Its arcs
 * sampled at their ends alone are a step of half a period in u, which way it runs a tie for the samples alone.
 * P-curves `none` (by projection or inversion), `same` (u = t on both arcs), `apart` (the bottom arc's u = t + 2 pi,
 * a period from the top's and the lines').
 */
function halfCylinder(u0: number, pcurves: 'none' | 'same' | 'apart'): BrepBuilder {
  const b = new BrepBuilder();
  const at = (u: number, z: number) => [2 * Math.cos(u), 2 * Math.sin(u), z];
  const u1 = u0 + Math.PI, h = 4;
  const va0 = b.addVertex({ point: at(u0, 0) }), vc0 = b.addVertex({ point: at(u1, 0) });
  const va1 = b.addVertex({ point: at(u0, h) }), vc1 = b.addVertex({ point: at(u1, h) });
  const arc = (z: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle',
    position: { ...AXIS, origin: [0, 0, z] }, radius: 2 }), start, end, sameSense: true, range: [u0, u1] });
  const up = (u: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'line',
    point: at(u, 0), direction: [0, 0, 1], magnitude: 1 }), start, end, sameSense: true, range: [0, h] });
  const bottom = arc(0, va0, vc0), top = arc(h, va1, vc1), right = up(u1, vc0, vc1), left = up(u0, va0, va1);
  const pc = (point: number[], direction: number[]) => pcurves === 'none' ? {} : { pcurve: b.addCurve(line2(point,
    direction)) };
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: bottom, orientation: 'forward', ...pc([pcurves === 'apart' ? 2 * Math.PI : 0, 0], [1, 0]) },
      { edge: right, orientation: 'forward', ...pc([u1, 0], [0, 1]) },
      { edge: top, orientation: 'reversed', ...pc([0, h], [1, 0]) },
      { edge: left, orientation: 'reversed', ...pc([u0, 0], [0, 1]) }] }] }));
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
 * The unit sphere's side of a great circle that passes 5e-4 from its north pole, its vertex on the far side (no
 * sample near the pole), the model's uncertainty 1e-3: the circle is incident to the pole without ending there.
 */
export function passBy(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-3 });
  const delta = 5e-4;
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
  kinkStripQuadratic: () => kinkStrip(false, true), affineFeetOff, plateHoles,
  bsplineApexHole, offPoleArcLoose, loopless, bsplineBall, wholeTorus, wholeSphereVertex,
  bsplineApex: () => bsplineApex(), poleHole, smallHole, sBend, cuspEdge: () => cuspEdge(), nearCusp6,
  bumpPatch: () => bumpPatch(), halfBump: () => bumpPatch(true), thinBand, tubeGapFaceTolerance, tubeGapUncertainty,
  tubeGapBySize, tubeGapOpen, torusOuterHalf, meridianHemisphereLoose, offPoleRest: () => offPoleRest(),
  seamHemisphere: () => seamHemisphere(true), seamHemisphereBare: () => seamHemisphere(false),
  seamCone: () => seamCone(true), seamConeBare: () => seamCone(false),
  offPoleRestLoose: () => offPoleRest(1e-3), wigglyBand, notchBand, bsplineTube, tubeQuarterPeriodUp, coarseProjection,
  fineProjection, knotAtEnd, cornerFold,
  cornerFoldTight, pcurveShortHair, pcurveShortFar, pcurveShortStart, bsplineTubeTinyArc, bsplineDome,
  offPoleArc: () => offPoleArc(), offPcurves, bandHoleAtVertex, bandHoleOnCut, halfCap, meridianHemisphere, band: band_,
  bandByInversion, bore, nistBore, seamByInversion, offVertex, pcurveOnly, luneQuarter, luneOnSeam, cap, splineEdge,
  seamFlipped, polylineEdge, pcurveCircle, arcSegment, fold, twisted, wrongSense, zeroEdge, halfCylinderPcurves,
  halfCylinderApart, halfCylinderBare, halfCylinderWest, arcBand, cuspPocket: cuspPocket_,
  cuspPocketMirrored, flowerHole, lobes,
  slitFromCorner, lunePinch, spindleApex: () => spindleCorner(0.005),
  tinyCap: () => capWithin(0.01), poleLunes, poleLens, curlBack, passBy,
  wrongEndPcurve: () => wrongEndPcurve(), wigglePcurve: () => wrongEndPcurve(true) };
