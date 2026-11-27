// B-reps for the edge sampler's tests (edges_test.cpp), beside cad-brep's (packages/cad-brep/test/models.ts): each
// the smallest with the case named. `fixtures.ts` writes them, and cad-brep's, as a header.
import { BrepBuilder } from '../../../cad-brep/src/builder.ts';
import type { Coedge, Curve, Loop } from '../../../cad-brep/src/types.ts';
import { ANALYSIS_TABLES } from '../../../cad-brep/src/analysis-layout.ts';
import { type AnalysisRows, writeAnalysis } from '../../../cad-brep/src/analysis.ts';

const AXIS = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
const line2 = (point: number[], direction: number[]): Curve => ({ kind: 'line', point, direction, magnitude: 1 });

function sheet(b: BrepBuilder, face: number): void {
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
}

/**
 * A cylinder's band (radius 2, z 0 to h) bounded by its two circles alone, no seam edge: the bottom forward, the top
 * reversed, with p-curves (the lines v = 0 and v = h) or without.
 */
function band(pcurves: boolean, sense = true, h = 5): BrepBuilder {
  const b = new BrepBuilder();
  const bottom = b.addCurve({ kind: 'circle', position: AXIS, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, h] }, radius: 2 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [2, 0, h] });
  const eb = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true });
  const et = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true });
  const pb = b.addCurve(line2([0, 0], [1, 0])), pt = b.addCurve(line2([0, h], [1, 0]));
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
/** band's cylinder 100 long (radius 2, z 0 to 100), with p-curves. */
export const longBand = (): BrepBuilder => band(true, true, 100);
/**
 * longBand's tube as an extrusion of its circle at z = 0 down along -z (z 0 to -100, v 0 to 100): the surface's
 * normal inward, its principal curvatures the other way round from the cylinder's; with p-curves.
 */
export function longSweep(): BrepBuilder {
  const b = new BrepBuilder();
  const bottom = b.addCurve({ kind: 'circle', position: AXIS, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, -100] }, radius: 2 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [2, 0, -100] });
  const eb = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true });
  const et = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true });
  const pb = b.addCurve(line2([0, 0], [1, 0])), pt = b.addCurve(line2([0, 100], [1, 0]));
  const surface = b.addSurface({ kind: 'extrusion', curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 2 }),
    direction: [0, 0, -1], magnitude: 1 });
  sheet(b, b.addFace({ surface, sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: eb, orientation: 'forward', pcurve: pb }] },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: et, orientation: 'reversed', pcurve: pt }] },
  ] }));
  return b;
}
/** A rectangle 100 by 4 on z = 0, its corners (0, 0, 0) and (100, 4, 0), four line edges. */
export function longPlate(): BrepBuilder {
  const b = new BrepBuilder();
  const c = [[0, 0, 0], [100, 0, 0], [100, 4, 0], [0, 4, 0]];
  const vs = c.map((point) => b.addVertex({ point }));
  const edges = c.map((point, j) => {
    const q = c[(j + 1) % 4]!, d = [q[0]! - point[0]!, q[1]! - point[1]!, 0], l = Math.hypot(d[0]!, d[1]!);
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point, direction: [d[0]! / l, d[1]! / l, 0], magnitude: 1 }),
      start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true, range: [0, l] });
  });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: edges.map((edge) => ({ edge,
      orientation: 'forward' as const })) }] }));
  return b;
}

/**
 * cad-brep's seam cylinder with no p-curves: every use by inversion, the seam's two sides from their neighbours.
 * With `sense` false the face is turned and its loop isn't: the sides its neighbours give break the rule.
 */
function seam(sense: boolean, pcurves = false, shift = 0): BrepBuilder {
  const b = new BrepBuilder();
  // (With `pcurves`, each use's: u = t + shift round the circles, the seam's at u = 2 pi + shift going up and shift
  // coming down, v = z.)
  const p = (u: number, v: number, du: number, dv: number) =>
    pcurves ? { pcurve: b.addCurve(line2([u + shift, v], [du, dv])) } : {};
  const bottom = b.addCurve({ kind: 'circle', position: AXIS, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, 5] }, radius: 2 });
  const line = b.addCurve({ kind: 'line', point: [2, 0, 0], direction: [0, 0, 1], magnitude: 1 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [2, 0, 5] });
  const eb = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true });
  const et = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true });
  const es = b.addEdge({ curve: line, start: v0, end: v1, sameSense: true });
  const face = b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: AXIS, radius: 2 }), sameSense: sense,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: eb, orientation: 'forward', ...p(0, 0, 1, 0) },
      { edge: es, orientation: 'forward', ...p(2 * Math.PI, 0, 0, 1) },
      { edge: et, orientation: 'reversed', ...p(0, 5, 1, 0) },
      { edge: es, orientation: 'reversed', ...p(0, 0, 0, 1) }] }] });
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
function lune(a: number, c: number, off = 0, offC = 0, pcurves?: [number, number],
  inner?: (b: BrepBuilder) => Loop): BrepBuilder {
  const b = new BrepBuilder();
  const s = b.addVertex({ point: [-off * Math.sin(a) - offC * Math.sin(c), off * Math.cos(a) + offC * Math.cos(c),
    -1] });
  const n = b.addVertex({ point: [0, 0, 1] });
  const half: [number, number] = [-Math.PI / 2, Math.PI / 2];
  const ma = b.addEdge({ curve: meridian(b, a), start: s, end: n, sameSense: true, range: half });
  const mc = b.addEdge({ curve: meridian(b, c), start: s, end: n, sameSense: true, range: half });
  // (Given p-curves parameterized otherwise, as STEP files have them: a meridian's line in (u, v) trimmed to 0 to 1.)
  const pc = (u: number) => b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'line', point: [u, -Math.PI / 2],
    direction: [0, 1], magnitude: Math.PI }), trim1: { parameter: 0 }, trim2: { parameter: 1 }, sense: true,
    preference: 'unspecified' });
  const face = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: mc, orientation: 'forward', ...(pcurves ? { pcurve: pc(pcurves[1]) } : {}) },
        { edge: ma, orientation: 'reversed', ...(pcurves ? { pcurve: pc(pcurves[0]) } : {}) }] },
      ...(inner ? [inner(b)] : [])] });
  sheet(b, face);
  return b;
}
export const luneQuarter = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4);
/**
 * A lune across the sphere's seam, from u = -pi / 8 to pi / 8; with `hole`, a hole in it about (cos u, sin u, 0) at
 * u = -pi / 16, a circle 0.05 radians round, its feet past the seam from the outer loop's first.
 */
function luneAcrossSeam(hole = false): BrepBuilder {
  return lune(-Math.PI / 8, Math.PI / 8, 0, 0, undefined, hole ? (b) => {
    const u = -Math.PI / 16, a = 0.05, n = [Math.cos(u), Math.sin(u), 0];
    const position = { origin: n.map((x) => Math.cos(a) * x), axis: n, xDir: [0, 0, 1] };
    const v = b.addVertex({ point: [position.origin[0]!, position.origin[1]!, Math.sin(a)] });
    const e = b.addEdge({ curve: b.addCurve({ kind: 'circle', position, radius: Math.sin(a) }), start: v, end: v,
      sameSense: true });
    return { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: e, orientation: 'reversed' }] };
  } : undefined);
}
/**
 * The unit disc's quarter x >= 0, y <= 0 on z = 0: its arc an edge of the unit circle from (0, -1, 0) to (1, 0, 0),
 * at 3 pi / 2 and 0 on it, with no range given; lines through the centre back.
 */
export function quarterDisc(): BrepBuilder {
  const b = new BrepBuilder();
  const s = b.addVertex({ point: [0, -1, 0] }), e = b.addVertex({ point: [1, 0, 0] });
  const o = b.addVertex({ point: [0, 0, 0] });
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 1 }), start: s, end: e,
    sameSense: true });
  const line = (from: number, to: number, point: number[], direction: number[]) => b.addEdge({
    curve: b.addCurve({ kind: 'line', point, direction, magnitude: 1 }), start: from, end: to, sameSense: true });
  const a = line(e, o, [1, 0, 0], [-1, 0, 0]), c = line(o, s, [0, 0, 0], [0, -1, 0]);
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [arc, a, c].map((edge) => ({ edge,
      orientation: 'forward' as const })) }] }));
  return b;
}
/**
 * The unit disc's half y >= 0 on z = 0: its arc an edge of the unit circle from (1, 0, 0) to (-1, 0, 0) with no range
 * given, its diameter a line back.
 */
export function halfDisc(): BrepBuilder {
  const b = new BrepBuilder();
  const e = b.addVertex({ point: [1, 0, 0] }), w = b.addVertex({ point: [-1, 0, 0] });
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 1 }), start: e, end: w,
    sameSense: true });
  const across = b.addEdge({ curve: b.addCurve({ kind: 'line', point: [-1, 0, 0], direction: [1, 0, 0],
    magnitude: 1 }), start: w, end: e, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: arc, orientation: 'forward' }, { edge: across, orientation: 'forward' }] }] }));
  return b;
}
/**
 * luneQuarter under an uncertainty of 1e-3, its meridians stopping 2e-4 short of the north pole, joined there by a
 * line 2.8e-4 long: an edge given as a curve that lies wholly within the tolerance of the pole (LMP1 #172427's
 * #1039657's ends), projected anywhere along the pole line.
 */
export function luneTinyPoleEdge(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-3 });
  const a = Math.PI / 4, c = 3 * Math.PI / 4, top = Math.PI / 2 - 2e-4;
  const at = (u: number) => [Math.cos(u) * Math.cos(top), Math.sin(u) * Math.cos(top), Math.sin(top)];
  const s = b.addVertex({ point: [0, 0, -1] }), na = b.addVertex({ point: at(a) }), nc = b.addVertex({ point: at(c) });
  const ma = b.addEdge({ curve: meridian(b, a), start: s, end: na, sameSense: true, range: [-Math.PI / 2, top] });
  const mc = b.addEdge({ curve: meridian(b, c), start: s, end: nc, sameSense: true, range: [-Math.PI / 2, top] });
  const pa = at(a), pc = at(c), len = Math.hypot(pa[0]! - pc[0]!, pa[1]! - pc[1]!);
  const tiny = b.addEdge({ curve: b.addCurve({ kind: 'line', point: pc, direction: [(pa[0]! - pc[0]!) / len,
    (pa[1]! - pc[1]!) / len, 0], magnitude: 1 }), start: nc, end: na, sameSense: true, range: [0, len] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: mc, orientation: 'forward' },
      { edge: tiny, orientation: 'forward' }, { edge: ma, orientation: 'reversed' }] }] }));
  return b;
}
/** The lune's west meridian on the sphere's seam (u = 0): its side, by inversion, decided by no neighbour. */
export const luneOnSeam = (): BrepBuilder => lune(0, Math.PI / 2);
/**
 * luneOnSeam with given p-curves parameterized otherwise (over 0 to 1, the edges' meridians -pi / 2 to pi / 2), its
 * seam meridian's at u = 0 and the other's at pi / 2 (trj4_k1_top-pe #4779's #3088); Far: the seam's at 2 pi, which
 * puts the lune the other way round, against the face's sense.
 */
export const luneOnSeamPcurves = (): BrepBuilder => lune(0, Math.PI / 2, 0, 0, [0, Math.PI / 2]);
export const luneOnSeamPcurvesFar = (): BrepBuilder => lune(0, Math.PI / 2, 0, 0, [2 * Math.PI, Math.PI / 2]);
/** luneOnSeamPcurves with both p-curves a period down: the other meridian's placed a period off its own. */
export const luneOnSeamPcurvesShifted = (): BrepBuilder =>
  lune(0, Math.PI / 2, 0, 0, [-2 * Math.PI, Math.PI / 2 - 2 * Math.PI]);

/**
 * luneOnSeamPcurves with its east meridian (u = pi / 2) in two edges split at the equator, so the seam meridian's
 * two neighbours are different uses, each meeting it at a pole; given p-curves over 0 to 1 at u = `seam` for the
 * seam's, `low` and `high` for the halves'. Disagree: the north half's a period off the south half's.
 */
function luneSplit(seam: number, low: number, high: number): BrepBuilder {
  const b = new BrepBuilder();
  const s = b.addVertex({ point: [0, 0, -1] }), n = b.addVertex({ point: [0, 0, 1] });
  const e = b.addVertex({ point: [0, 1, 0] });
  const ma = b.addEdge({ curve: meridian(b, 0), start: s, end: n, sameSense: true,
    range: [-Math.PI / 2, Math.PI / 2] });
  const east = meridian(b, Math.PI / 2);
  const lo = b.addEdge({ curve: east, start: s, end: e, sameSense: true, range: [-Math.PI / 2, 0] });
  const hi = b.addEdge({ curve: east, start: e, end: n, sameSense: true, range: [0, Math.PI / 2] });
  const pc = (u: number, v0: number, dv: number) => b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'line',
    point: [u, v0], direction: [0, 1], magnitude: dv }), trim1: { parameter: 0 }, trim2: { parameter: 1 }, sense: true,
    preference: 'unspecified' });
  const face = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: lo, orientation: 'forward', pcurve: pc(low, -Math.PI / 2, Math.PI / 2) },
      { edge: hi, orientation: 'forward', pcurve: pc(high, 0, Math.PI / 2) },
      { edge: ma, orientation: 'reversed', pcurve: pc(seam, -Math.PI / 2, Math.PI) }] }] });
  sheet(b, face);
  return b;
}
export const luneSplitPcurves = (): BrepBuilder => luneSplit(0, Math.PI / 2, Math.PI / 2);
export const luneSplitPcurvesDisagree = (): BrepBuilder => luneSplit(0, Math.PI / 2, Math.PI / 2 + 2 * Math.PI);
/**
 * luneQuarter with its south vertex 1e-11 off the pole either way across the meridian at pi / 4 (its last sample
 * then the pole line's first point but for that) or at 3 pi / 4 (its first sample the pole line's last): the 3D turn
 * between them that rounding's sign.
 */
export const luneOffPole = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4, 1e-11);
export const luneOffPoleBack = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4, -1e-11);
export const luneOffPoleC = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4, 0, 1e-11);
export const luneOffPoleCBack = (): BrepBuilder => lune(Math.PI / 4, 3 * Math.PI / 4, 0, -1e-11);

/**
 * The unit sphere's cap above latitude pi / 4, bounded by its circle alone (no vertex loop at the pole); with
 * `pcurve`, the use's p-curve the line v = pi / 4 over [0, 2 pi]; with `rest`, the face against its sphere, the rest
 * of it below the circle; with `below`, the same rest with the face along its sphere, its use reversed.
 */
export function cap(pcurve = false, rest = false, below = false): BrepBuilder {
  const b = new BrepBuilder();
  const r = Math.SQRT1_2;
  const circle = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, r] }, radius: r });
  const v = b.addVertex({ point: [r, 0, r] });
  const e = b.addEdge({ curve: circle, start: v, end: v, sameSense: true });
  const pc = pcurve
    ? { pcurve: b.addCurve(line2([0, Math.PI / 4], [1, 0])), range: [0, 2 * Math.PI] as [number, number] } : {};
  const face = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: AXIS, radius: 1 }), sameSense: !rest,
    loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: e, orientation: below ? 'reversed' : 'forward', ...pc }] }] });
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
/** seam with p-curves; Shifted, a period over (u from 2 pi). */
export const seamPcurves = (): BrepBuilder => seam(true, true);
export const seamPcurvesShifted = (): BrepBuilder => seam(true, true, 2 * Math.PI);

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
 * Two bicubic B-spline patches side by side, sharing the edge x = 10: over [0, 10]^2 a gentle bump (its two middle
 * poles raised by `rise`), and over [10, 20] x [0, 10] a sharp one (the poles of row i = 1, next to the shared edge,
 * raised by 3), curved up to that edge but not on it (a clamped cubic's second pole has no weight at its end), so
 * refinement splits the shared edge for the sharp face far past what the gentle one asks. Both on z = 0 along their
 * edges, faces up.
 */
export function bumpPair(rise = 0.1): BrepBuilder {
  const b = new BrepBuilder();
  const patch = (x0: number, raised: (i: number, j: number) => number) => b.addSurface({ kind: 'bspline',
    uDegree: 3, vDegree: 3, uKnots: [0, 1, 2, 3, 4], vKnots: [0, 1, 2, 3, 4], uMultiplicities: [4, 1, 1, 1, 4],
    vMultiplicities: [4, 1, 1, 1, 4], poles: [0, 1, 2, 3, 4, 5, 6].map((i) => [0, 1, 2, 3, 4, 5, 6].map((j) =>
      [x0 + i * 10 / 6, j * 10 / 6, raised(i, j)])), uClosed: false, vClosed: false, selfIntersect: false,
    form: 'unspecified' });
  const sa = patch(0, (i, j) => (i === 3 && (j === 3 || j === 4) ? rise : 0));
  const sb = patch(10, (i, j) => (i === 1 && j >= 2 && j <= 4 ? 3 : 0));
  const p = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [20, 0, 0], [20, 10, 0]];
  const v = p.map((point) => b.addVertex({ point }));
  const edge = (i: number, j: number) => {
    const d = p[j]!.map((x, k) => (x - p[i]![k]!) / 10);
    const line = b.addCurve({ kind: 'line', point: p[i]!, direction: d, magnitude: 1 });
    return b.addEdge({ curve: line, start: v[i]!, end: v[j]!, sameSense: true, range: [0, 10] });
  };
  const pc = (a: number[], c: number[]) => b.addCurve({ kind: 'line', point: a,
    direction: [(c[0]! - a[0]!) / 4, (c[1]! - a[1]!) / 4], magnitude: 0.4 });
  const e01 = edge(0, 1), e12 = edge(1, 2), e23 = edge(2, 3), e30 = edge(3, 0);
  const e14 = edge(1, 4), e45 = edge(4, 5), e52 = edge(5, 2);
  const fa = b.addFace({ surface: sa, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: e01, orientation: 'forward', pcurve: pc([0, 0], [4, 0]) },
    { edge: e12, orientation: 'forward', pcurve: pc([4, 0], [4, 4]) },
    { edge: e23, orientation: 'forward', pcurve: pc([4, 4], [0, 4]) },
    { edge: e30, orientation: 'forward', pcurve: pc([0, 4], [0, 0]) }] }] });
  const fb = b.addFace({ surface: sb, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: e14, orientation: 'forward', pcurve: pc([0, 0], [4, 0]) },
    { edge: e45, orientation: 'forward', pcurve: pc([4, 0], [4, 4]) },
    { edge: e52, orientation: 'forward', pcurve: pc([4, 4], [0, 4]) },
    { edge: e12, orientation: 'reversed', pcurve: pc([0, 4], [0, 0]) }] }] });
  const shell = b.addShell({ kind: 'open', faces: [{ face: fa, sense: true }, { face: fb, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
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
export function edgeFarOff(pcurve = false, bulge = false, grown = 0): BrepBuilder {
  const b = new BrepBuilder();
  const c = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
  const vs = c.map((point) => b.addVertex({ point }));
  const line = (j: number) => {
    const p = c[j]!, q = c[(j + 1) % 4]!;
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0],
      magnitude: 1 }), start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true, range: [0, 1] });
  };
  // (With `bulge`, the arc over the side instead, its centre 24.75 below: rising 0.5 at its middle, its feet the
  // side itself. With `grown`, the arc's and the face's tolerances that, as healing grows them to cover it.)
  const a0 = bulge ? Math.atan2(24.75, 5) : -Math.atan2(24.75, 5);
  const a1 = bulge ? Math.PI - Math.atan2(24.75, 5) : Math.PI + Math.atan2(24.75, 5);
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: [5, 10, bulge ? -24.75 : 24.75],
    axis: [0, -1, 0], xDir: [1, 0, 0] }, radius: 25.25 }), start: vs[2]!, end: vs[3]!, sameSense: true,
    range: [a0, a1], ...(grown ? { tolerance: grown } : {}) });
  const edges = [line(0), line(1), arc, line(3)];
  // (With `pcurve`, the arc's use given the line under it in the plane, (10, 10) to (0, 10) over the arc's range.)
  const under = pcurve ? b.addCurve({ kind: 'line', point: [10 + 10 * a0 / (a1 - a0), 10], direction: [-1, 0],
    magnitude: 10 / (a1 - a0) }) : undefined;
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    ...(grown ? { tolerance: grown } : {}), loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: edges.map((edge) => ({ edge, orientation: 'forward' as const,
        ...(edge === arc && under !== undefined ? { pcurve: under } : {}) })) }] }));
  return b;
}

/**
 * A quarter of an annulus on z = 0 between radii 1 and 1 + `width` (0.001), under an uncertainty of 0.2: a strip
 * narrower than its tolerance, its outer side two arcs meeting at 0.3 rad so the sides' samples don't match. Their
 * chords at the deflection (0.1) sag past its width and cross until split far under the refinement floor (0.2).
 */
export function narrowArcStrip(width = 0.001): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.2 });
  const r = [1, 1 + width], k = 0.3;
  const at = [[r[1]!, 0, 0], [r[1]! * Math.cos(k), r[1]! * Math.sin(k), 0], [0, r[1]!, 0], [0, r[0]!, 0],
    [r[0]!, 0, 0]];
  const v = at.map((point) => b.addVertex({ point }));
  const arc = (radius: number, start: number, end: number, range: [number, number]) => b.addEdge({
    curve: b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] }, radius }),
    start: v[start]!, end: v[end]!, sameSense: true, range });
  const line = (start: number, end: number) => {
    const p = at[start]!, q = at[end]!;
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0],
      magnitude: 1 }), start: v[start]!, end: v[end]!, sameSense: true, range: [0, 1] });
  };
  // (Counter-clockwise: the outer arcs forward, the inner one back.)
  const edges: [number, 'forward' | 'reversed'][] = [[arc(r[1]!, 0, 1, [0, k]), 'forward'],
    [arc(r[1]!, 1, 2, [k, Math.PI / 2]), 'forward'], [line(2, 3), 'forward'],
    [arc(r[0]!, 4, 3, [0, Math.PI / 2]), 'reversed'], [line(4, 0), 'reversed']];
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true, loops: [{
    kind: 'edge', bound: 'outer', sense: true,
    coedges: edges.map(([edge, orientation]) => ({ edge, orientation })) }] }));
  return b;
}

/**
 * A pentagram on z = 0 (a star polygon's loop of five line edges, radius 1), under an uncertainty of 0.2: its edges
 * cross each other five times in (u, v), which no split mends.
 */
export function pentagramLoop(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.2 });
  const at = [0, 2, 4, 1, 3].map((k) => [Math.cos(Math.PI / 2 + 2 * Math.PI * k / 5),
    Math.sin(Math.PI / 2 + 2 * Math.PI * k / 5), 0]);
  const v = at.map((point) => b.addVertex({ point }));
  const coedges = at.map((p, j) => {
    const q = at[(j + 1) % 5]!;
    return { edge: b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: [q[0]! - p[0]!,
      q[1]! - p[1]!, 0], magnitude: 1 }), start: v[j]!, end: v[(j + 1) % 5]!, sameSense: true, range: [0, 1] }),
      orientation: 'forward' as const };
  });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A plane strip 40 long and `width` wide (on z = 0, from the origin along x) whose corners at each end are one vertex
 * (a source's merge: the end's two corners within the vertex's tolerance, its curve's ends `width` apart), under an
 * uncertainty of 1: each end a line from its vertex back to it, each side a line between the two vertices, its ends
 * at their corners up to `width` off. The vertices at the bottom corners, or with `atTop` the top ones (the mirror:
 * each use's end far from its vertex where the other's is at it). trj3_s1-al-214 #6704's #1342 and #1362 (1.0001
 * wide, ends 1 mm arcs).
 */
export function mergedCornerStrip(width = 1.5, atTop = false): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1 });
  const y = atTop ? width : 0;
  const A = b.addVertex({ point: [0, y, 0], tolerance: 1.1 * width });
  const B = b.addVertex({ point: [40, y, 0], tolerance: 1.1 * width });
  const line = (p: number[], q: number[], start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'line',
    point: [p[0]!, p[1]!, 0], direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0], magnitude: 1 }), start, end,
    sameSense: true, range: [0, 1] });
  // (Counter-clockwise: the bottom side A to B, B's end up, the top side back B to A, A's end down.)
  const coedges = [line([0, 0], [40, 0], A, B), line([40, 0], [40, width], B, B), line([40, width], [0, width], B, A),
    line([0, width], [0, 0], A, A)].map((edge) => ({ edge, orientation: 'forward' as const }));
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A plane square 10 x 10 (on z = 0) whose corner at the origin is a vertex its two sides' curves miss, under an
 * uncertainty of 0.2: the bottom side's line starts at `bottom`, the left side's ends at `left` (each [x, y]), the
 * other corners at their vertices.
 */
export function offCornerSquare(bottom: number[], left: number[]): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.2 });
  const O = b.addVertex({ point: [0, 0, 0], tolerance: 1 });
  const V = [[10, 0], [10, 10], [0, 10]].map((p) => b.addVertex({ point: [p[0]!, p[1]!, 0] }));
  const line = (p: number[], q: number[], start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'line',
    point: [p[0]!, p[1]!, 0], direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0], magnitude: 1 }), start, end,
    sameSense: true, range: [0, 1] });
  const coedges = [line(bottom, [10, 0], O, V[0]!), line([10, 0], [10, 10], V[0]!, V[1]!),
    line([10, 10], [0, 10], V[1]!, V[2]!), line([0, 10], left, V[2]!, O)]
    .map((edge) => ({ edge, orientation: 'forward' as const }));
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}

/**
 * A plane face (z = 0) bounded by a circle of radius 22 about (0, 4) with a hole, a circle of radius 16 about (0, 10)
 * touching it from inside at (0, 26), the hole's vertex: the outer circle one closed edge (its vertex at the bottom)
 * or, `split`, two arcs meeting at the hole's vertex; the hole with its p-curve (exact, `shift` up in v) or without,
 * the arcs with theirs (`outerPcurves`) or without. ec_turbine-A #11's #384 (a B-spline hole touching its circle).
 */
export function tangentHole(split: boolean, pcurve: boolean, shift = 0, outerPcurves = false): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 1e-5 });
  const outer = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 4, 0] }, radius: 22 });
  const hole = b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 10, 0], xDir: [0, 1, 0] }, radius: 16 });
  const top = b.addVertex({ point: [0, 26, 0] }), bottom = b.addVertex({ point: [0, -18, 0] });
  const eh = b.addEdge({ curve: hole, start: top, end: top, sameSense: true });
  const outerEdges = split
    ? [b.addEdge({ curve: outer, start: bottom, end: top, sameSense: true, range: [1.5 * Math.PI, 2.5 * Math.PI] }),
      b.addEdge({ curve: outer, start: top, end: bottom, sameSense: true, range: [0.5 * Math.PI, 1.5 * Math.PI] })]
    : [b.addEdge({ curve: outer, start: bottom, end: bottom, sameSense: true })];
  const p = pcurve ? { pcurve: b.addCurve({ kind: 'circle', position: { origin: [0, 10 + shift], xDir: [0, 1] },
    radius: 16 }) } : {};
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'plane', position: AXIS }), sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true,
      coedges: outerEdges.map((edge) => ({ edge, orientation: 'forward' as const, ...(outerPcurves ? { pcurve:
        b.addCurve({ kind: 'circle', position: { origin: [0, 4], xDir: [1, 0] }, radius: 22 }) } : {}) })) },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: eh, orientation: 'reversed' as const, ...p }] }] }));
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
 * A flat B-spline sector with a pole beside an elementary face that has none: bsplineApex's construction in z = 0
 * (the arc's poles (1, 0, 0), (1, 1, 0), (0, 1, 0), its row v = 0 the pole at the origin), faced up, bounded by the
 * x axis from the origin to P, the line up from P to Q and the arc K back to the origin, K on the circle of radius
 * sqrt 1/2 about (0.5, -0.5, 0) (from 70 to 135 degrees); and that circle's cylinder below K down to z = -h, faced
 * out. The sector's fans are flat, so its ring at the pole is wide, while K bends: the cylinder wants K finer inside
 * the sector's ring than the ring lets it be. With `spline`, the wall the same cylinder as a rational B-spline (u the
 * arc as one rational quadratic, v down the axis), a free-form face too.
 */
export function sectorWall(h = 0.3, spline = false): BrepBuilder {
  const b = new BrepBuilder();
  const arcPoles = [[1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const sector = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [3, 3], vMultiplicities: [2, 2], poles: arcPoles.map((q) => [[0, 0, 0], q]), uClosed: false,
    vClosed: false, selfIntersect: false, form: 'unspecified' });
  const r = Math.SQRT1_2, c = [0.5, -0.5], t0 = 70 * Math.PI / 180, t1 = 0.75 * Math.PI;
  const onCircle = (t: number, z: number) => [c[0]! + r * Math.cos(t), c[1]! + r * Math.sin(t), z];
  const O = b.addVertex({ point: [0, 0, 0] }), q = onCircle(t0, 0), Q = b.addVertex({ point: q });
  const P = b.addVertex({ point: [q[0]!, 0, 0] });
  const Ob = b.addVertex({ point: onCircle(t1, -h) }), Qb = b.addVertex({ point: onCircle(t0, -h) });
  const line = (p: number[], d: number[], len: number, start: number, end: number) => b.addEdge({
    curve: b.addCurve({ kind: 'line', point: p, direction: d, magnitude: 1 }), start, end, sameSense: true,
    range: [0, len] });
  const circle = (z: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle',
    position: { origin: [c[0]!, c[1]!, z], axis: [0, 0, 1], xDir: [1, 0, 0] }, radius: r }), start, end,
    sameSense: true, range: [t0, t1] });
  const eOP = line([0, 0, 0], [1, 0, 0], q[0]!, O, P), ePQ = line([q[0]!, 0, 0], [0, 1, 0], q[1]!, P, Q);
  const K = circle(0, Q, O), Kb = circle(-h, Qb, Ob);
  const eOb = line(onCircle(t1, -h), [0, 0, 1], h, Ob, O), eQ = line(q, [0, 0, -1], h, Q, Qb);
  // (The sector's own normal is down, S_u x S_v with u along the arc and v out from the pole: faced up against it.)
  const top = b.addFace({ surface: sector, sameSense: false, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: eOP, orientation: 'forward' }, { edge: ePQ, orientation: 'forward' },
      { edge: K, orientation: 'forward' }] }] });
  // (The B-spline's own normal is in, S_u x S_v with u along the arc counterclockwise and v down: faced out against
  // it.)
  const half = (t1 - t0) / 2, tm = (t0 + t1) / 2, rm = r / Math.cos(half);
  const arc = [onCircle(t0, 0), [c[0]! + rm * Math.cos(tm), c[1]! + rm * Math.sin(tm), 0], onCircle(t1, 0)];
  const cylinder = spline ? b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [3, 3], vMultiplicities: [2, 2], poles: arc.map((q) => [q, [q[0]!, q[1]!, -h]]),
    weights: [1, Math.cos(half), 1].map((w) => [w, w]), uClosed: false, vClosed: false, selfIntersect: false,
    form: 'unspecified' }) : b.addSurface({ kind: 'cylinder', position: { origin: [c[0]!, c[1]!, 0], axis: [0, 0, 1],
    xDir: [1, 0, 0] }, radius: r });
  const wall = b.addFace({ surface: cylinder, sameSense: !spline, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: [{ edge: Kb, orientation: 'forward' }, { edge: eOb, orientation: 'forward' },
      { edge: K, orientation: 'reversed' }, { edge: eQ, orientation: 'forward' }] }] });
  const shell = b.addShell({ kind: 'open', faces: [{ face: top, sense: true }, { face: wall, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  return b;
}

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

/**
 * The torus R 3, r 1 (axis z) between its parallels at v = -2 pi / 3 and 2 pi / 3, round its outside (the wider way
 * between them: its outer equator, radius 4, and its top and bottom), bounded by those circles alone, without
 * p-curves.
 */
export function torusOuterBand(): BrepBuilder {
  const b = new BrepBuilder();
  const c = Math.cos(2 * Math.PI / 3), s = Math.sin(2 * Math.PI / 3), r = 3 + c;
  const circle = (z: number) => b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, z] }, radius: r });
  const lo = b.addVertex({ point: [r, 0, -s] }), hi = b.addVertex({ point: [r, 0, s] });
  const bottom = b.addEdge({ curve: circle(-s), start: lo, end: lo, sameSense: true });
  const top = b.addEdge({ curve: circle(s), start: hi, end: hi, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'torus', position: AXIS, majorRadius: 3, minorRadius: 1 }),
    sameSense: true, loops: [
      { kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: bottom, orientation: 'forward' }] },
      { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: top, orientation: 'reversed' }] }] }));
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
function seamCone(degenerate: boolean, turned = false): BrepBuilder {
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
    sameSense: !turned, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] }));
  return b;
}
/** seamCone on a face turned in the source: its sense false, its loop as seamCone's (trj6_b1-ec #10's #18689). */
export const seamConeTurned = (): BrepBuilder => seamCone(false, true);

/**
 * seamCone's cone (radius 1 at z = 0, semi-angle 45 degrees, its apex (0, 0, -1) at v = -1) between the rulings at
 * u = -`half` and `half`, from the apex up to its base circle: a face that reaches the apex and crosses u's seam. Area
 * half sqrt 2 (its sector of the development, radius sqrt 2, angle 2 half sin 45 degrees).
 */
export function apexSector(half = 0.6): BrepBuilder {
  const b = new BrepBuilder();
  const at = (u: number) => [Math.cos(u), Math.sin(u), 0];
  const va = b.addVertex({ point: [0, 0, -1] }), vm = b.addVertex({ point: at(-half) }),
    vp = b.addVertex({ point: at(half) });
  const ruling = (u: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'line', point: [0, 0, -1],
    direction: [Math.cos(u) * Math.SQRT1_2, Math.sin(u) * Math.SQRT1_2, Math.SQRT1_2], magnitude: 1 }), start: va,
    end, sameSense: true, range: [0, Math.SQRT2] });
  const rm = ruling(-half, vm), rp = ruling(half, vp);
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 1 }), start: vm, end: vp,
    sameSense: true, range: [2 * Math.PI - half, 2 * Math.PI + half] });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cone', position: AXIS, radius: 1, semiAngle: Math.PI / 4 }),
    sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: rp, orientation: 'forward' }, { edge: arc, orientation: 'reversed' },
      { edge: rm, orientation: 'reversed' }] }] }));
  return b;
}

/**
 * seamCone's side bounded by its base circle and, in a loop of its own, an edge with no curve whose vertices are both
 * the apex (bug26451's drill points: the source's degenerate edge, not flagged so). Area pi sqrt 2. Turned: its sense
 * false, its loops as they are (a face turned in the source).
 */
export function coneApexLoop(turned = false): BrepBuilder {
  const b = new BrepBuilder();
  const va = b.addVertex({ point: [0, 0, -1] }), vb = b.addVertex({ point: [1, 0, 0] });
  const base = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: AXIS, radius: 1 }), start: vb, end: vb,
    sameSense: true });
  const apex = b.addEdge({ start: va, end: va, sameSense: true });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'cone', position: AXIS, radius: 1, semiAngle: Math.PI / 4 }),
    sameSense: !turned, loops: [
      { kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: base, orientation: 'reversed' }] },
      { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: apex, orientation: 'forward' }] }] }));
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

/**
 * A lantern: a band round a thin torus (major radius 29, minor 0.1) from v = -0.8 to 0.8, 0.16 mm across, bounded by
 * its two circles (radius 29 + 0.1 cos 0.8, at z = +-0.1 sin 0.8). At d = 0.1 the circles are sampled about 4.7 mm
 * apart, their chords sagging about as far as the tube's radius, and triangles laid along the band stand across the
 * tube (LMP1 #172690's #1056598). Its area 2 pi 0.1 (1.6 x 29 + 0.2 sin 0.8). With `off`, both circles that far
 * outside the tube (radius rho + off), within their edges' and vertices' tolerance (2 off): a sliver, its boundary
 * farther from its surface than the band is wide. With `R`, that major radius instead.
 */
export function lanternBand(off = 0, R = 29): BrepBuilder {
  const b = new BrepBuilder();
  const r = 0.1, v = 0.8, rho = R + r * Math.cos(v) + off, z = r * Math.sin(v);
  const tolerance = off > 0 ? 2 * off : undefined;
  const circle = (h: number) => b.addCurve({ kind: 'circle', position: { ...AXIS, origin: [0, 0, h] }, radius: rho });
  const v0 = b.addVertex({ point: [rho, 0, -z], tolerance }), v1 = b.addVertex({ point: [rho, 0, z], tolerance });
  const eb = b.addEdge({ curve: circle(-z), start: v0, end: v0, sameSense: true, tolerance });
  const et = b.addEdge({ curve: circle(z), start: v1, end: v1, sameSense: true, tolerance });
  sheet(b, b.addFace({ surface: b.addSurface({ kind: 'torus', position: AXIS, majorRadius: R, minorRadius: r }),
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
 * cubic with simple knots 0.5 + h x (-2, -1, 0, 1, 2): rounded over a run of four spans h wide. With `bump` (and
 * `run`), flat instead but for its middle pole raised by `bump`: a ripple over the run, sharply curved inside it and
 * level either side. `shape` stretches it along the crease (`along` x 10 long), shears it (the crease's position
 * moving `shear` x 10 across over its length) and with `vary` scales its z by 0.25 to 1 along the crease, so the bend
 * differs line by line. Bounded by its four sides, the creased ones B-splines of its own knots.
 */
export function kinkStrip(inV = false, quadratic = false, h = 5e-5, run = false, bump = 0,
  shape: { along?: number; shear?: number; vary?: boolean } = {}): BrepBuilder {
  const { along = 1, shear = 0, vary = false } = shape;
  const b = new BrepBuilder();
  const deg = quadratic ? 2 : 3, inner = quadratic || run ? 1 : 2;
  const knots = run ? [0, 0.5 - 2 * h, 0.5 - h, 0.5, 0.5 + h, 0.5 + 2 * h, 1] : [0, 0.5 - h, 0.5 + h, 1];
  const mults = knots.map((_, i) => (i === 0 || i === knots.length - 1 ? deg + 1 : inner));
  const ks = knots.flatMap((k, i) => Array<number>(mults[i]!).fill(k));
  // (Poles at the Greville abscissae, so that the parameter is linear in x and the V exact outside the knots.)
  const g = ks.slice(0, ks.length - deg - 1).map((_, i) => ks.slice(i + 1, i + 1 + deg).reduce((a, x) => a + x) / deg);
  const z = (t: number) => (bump ? 0 : 0.5 * Math.abs(t - 0.5));
  const lin = [0, 1 / 3, 2 / 3, 1];
  const at = (u: number, v: number) => {
    const t = inV ? v : u, w = inV ? u : v, X = 10 * t + 10 * shear * w, Y = 10 * along * w;
    const Z = z(t) * (vary ? 0.25 + 0.75 * w : 1);
    return inV ? [Y, X, Z] : [X, Y, Z];
  };
  // (The ripple's pole: the middle one across the run, its Greville abscissa 0.5.)
  const up = (t: number, p: number[]) => (bump && Math.abs(t - 0.5) < 1e-12 ? [p[0]!, p[1]!, p[2]! + bump] : p);
  const poles = (inV ? lin : g).map((u) => (inV ? g : lin).map((v) => up(inV ? v : u, at(u, v))));
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
    // (A side along it: straight, the surface linear along the crease.)
    const p0 = at(a[0]!, a[1]!), p1 = at(c[0]!, c[1]!), len = Math.hypot(...p1.map((x, i) => x - p0[i]!));
    const curve = creased
      ? b.addCurve({ kind: 'bspline', degree: deg, knots, multiplicities: mults, closed: false, selfIntersect: false,
        form: 'unspecified', poles: g.map((t) => up(t, at(a[0]! + du * t, a[1]! + dv * t))) })
      : b.addCurve({ kind: 'line', point: p0, direction: p1.map((x, i) => (x - p0[i]!) / len), magnitude: 1 });
    const edge = b.addEdge({ curve, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true,
      range: creased ? [0, 1] : [0, len] });
    const pcurve = b.addCurve({ kind: 'line', point: a, direction: [du, dv], magnitude: creased ? 1 : 1 / len });
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
 * slitFromCorner under an uncertainty of 0.2, its slit's line from (0.3, 0.1) (0.32 off the corner's vertex, whose
 * tolerance is 0.5) to the middle: an internal use, no other use at its junction.
 */
export function slitOffCorner(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.2 });
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const vs = corners.map((point, k) => b.addVertex({ point, ...(k === 0 ? { tolerance: 0.5 } : {}) }));
  const line = (p: number[], q: number[], start: number, end: number) => {
    const l = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!);
    return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p,
      direction: [(q[0]! - p[0]!) / l, (q[1]! - p[1]!) / l, 0], magnitude: 1 }), start, end, sameSense: true,
      range: [0, l] });
  };
  const sides = corners.map((c, k) => line(c, corners[(k + 1) % 4]!, vs[k]!, vs[(k + 1) % 4]!));
  const slit = line([0.3, 0.1, 0], [0.5, 0.5, 0], vs[0]!, b.addVertex({ point: [0.5, 0.5, 0] }));
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

/**
 * A strip 190 long and 0.6 wide under an uncertainty of 0.2 (LMP1 #172427's #1039663's, in the open): a loopless
 * B-spline face, linear along y, a cubic Bezier across x whose x poles 0, 0.612, -0.012, 0.6 run it forward, back and
 * forward again as z rises 0.0005: a pleat across its middle, its normal reversed over v 0.45 to 0.55 while the surface
 * runs back 1.2e-3, far under the tolerance.
 */
export function pleatStrip(): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.2 });
  const sec = [[0, 0], [1.02, 0], [-0.02, 0.0005], [1, 0.0005]].map(([x, z]) => [0.6 * x!, z!]);
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 3, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [2, 2], vMultiplicities: [4, 4], poles: [0, 190].map((y) => sec.map(([x, z]) => [x!, y, z!])),
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [] }));
  return b;
}
/** A half cylinder of radius 0.005 (a fillet tighter than a tolerance of 0.1 would be): its sides face apart. */
export const thinTube = (): BrepBuilder => halfCylinder(0, 'none', 0.005, 1);

/**
 * A strip 1 long (in y) whose section in x and z is a polyline (a degree-1 B-spline, its legs `legs`: each a direction
 * in degrees from +x towards +z and a length, at equal steps of v), under an uncertainty of 0.2: its normal constant
 * along each leg.
 */
function polylineStrip(legs: [number, number][]): BrepBuilder {
  const b = new BrepBuilder({ uncertainty: 0.2 });
  const sec: number[][] = [[0, 0]];
  for (const [deg, len] of legs) {
    const [x, z] = sec[sec.length - 1]!, a = deg * Math.PI / 180;
    sec.push([x! + len * Math.cos(a), z! + len * Math.sin(a)]);
  }
  const n = legs.length;
  const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1],
    vKnots: Array.from({ length: n + 1 }, (_, k) => k / n), uMultiplicities: [2, 2],
    vMultiplicities: Array.from({ length: n + 1 }, (_, k) => k === 0 || k === n ? 2 : 1),
    poles: [0, 1].map((y) => sec.map(([x, z]) => [x!, y, z!])), uClosed: false, vClosed: false, selfIntersect: false,
    form: 'unspecified' });
  sheet(b, b.addFace({ surface: s, sameSense: true, loops: [] }));
  return b;
}
/** A short leg back between legs 120 degrees apart: reversed against both sides, which face apart. No fold. */
export const foldSidesApart = (): BrepBuilder => polylineStrip([[60, 1], [180, 0.01], [-60, 1]]);
/** A short leg reversed against the side before it, not the one after (they agree). No fold. */
export const foldOneSide = (): BrepBuilder => polylineStrip([[0, 1], [130, 0.01], [80, 1]]);
/**
 * A short leg back between legs forward 0.3 long, those between long legs back: a fold, its sides the forward legs,
 * which a first step of the tolerance over the short leg's speed overshoots to the long legs' ends.
 */
export const foldStepFar = (): BrepBuilder => polylineStrip([[180, 5], [0, 0.3], [180, 0.01], [0, 0.3], [180, 5]]);

/**
 * LMP1 #172427's #1039663 alone, its source's numbers to 12 digits: a B-spline pleated at its edge v = 0, its normal
 * reversed over v 0.026 to 0.059 where it runs back 3.2e-3 (the uncertainty 0.2): its slivers in the fold accepted.
 */
const PLEAT_AT_EDGE = `
{"uncertainty": 0.2,
"vertices": [[-945.446548897,-364.084845169,84.794336702],[-945.41369137,-364.058352507,84.9598348094],[-945.294332534,-175.000001076,94.4026984289],[-945.455940485,-175.000000095,93.6631949665]],
"edges": [
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.5,0.75,0.875,1],"multiplicities":[4,2,2,2,4],"poles":[[-945.446548859,-364.084849048,84.7943370966],[-945.443725684,-364.080799553,84.8338732067],[-945.438135704,-364.076618922,84.8704142722],[-945.428779356,-364.069992701,84.9128515251],[-945.425533558,-364.067725357,84.9249523123],[-945.421172946,-364.06422594,84.9393019253],[-945.419806121,-364.063043153,84.9434538054],[-945.417384323,-364.060644479,84.9504056815],[-945.428410026,-364.05838959,84.9229951355],[-945.41369137,-364.058352507,84.9598348094]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":0,"end":1,"sameSense":true},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.5,1],"multiplicities":[4,2,4],"poles":[[-945.294332742,-175.000001075,94.4026977832],[-945.298020691,-206.527737963,94.3913342098],[-945.309001696,-238.033408961,92.614363493],[-945.356332836,-300.997913173,88.4599968504],[-945.392105494,-332.483149387,86.1008263008],[-945.41020883,-364.048565494,84.9665814112]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":2,"end":1,"sameSense":true},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.125,0.25,0.5,1],"multiplicities":[4,1,1,1,4],"poles":[[-945.294332534,-175.000001076,94.402698429],[-945.31066503,-174.999987942,94.3521995923],[-945.320839261,-175.000005599,94.3182027925],[-945.360579809,-174.999994877,94.1801345359],[-945.410783855,-174.999998948,93.9719045352],[-945.442384898,-174.999999002,93.7841346562],[-945.455950737,-175.000000094,93.6631035541]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":2,"end":3,"sameSense":true},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.5,0.75,1],"multiplicities":[4,1,1,4],"poles":[[-945.443920409,-364.086358622,84.8367240259],[-945.445020997,-332.552005219,85.9031076294],[-945.44910032,-285.310519333,89.2058848345],[-945.454382289,-222.314825953,92.8257914409],[-945.457430891,-190.771970669,93.6497440233],[-945.456853886,-175.000000099,93.6549768423]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":0,"end":3,"sameSense":true}
],
"surface": {"kind":"bspline","uDegree":3,"vDegree":3,"uKnots":[0,0.25,0.5,1],"vKnots":[0,0.0625,0.125,0.25,0.5,1,5],"uMultiplicities":[4,3,3,4],"vMultiplicities":[4,3,3,3,3,3,4],"poles":[[[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282],[-945.410880345,-365.189882787,84.9255406282]],[[-945.401536531,-349.327353907,85.4959421823],[-945.41376721,-349.327396786,85.4729133983],[-945.40442965,-349.328834961,85.4903790226],[-945.405322679,-349.329615144,85.4885718343],[-945.406215708,-349.330395327,85.486764646],[-945.406629338,-349.331211416,85.4858795836],[-945.407067002,-349.332029262,85.484920294],[-945.40794233,-349.333664952,85.4830017149],[-945.409327803,-349.335274086,85.4798204838],[-945.41104236,-349.336855302,85.4754325895],[-945.414471475,-349.340017732,85.4666568009],[-945.419193704,-349.343067237,85.453022575],[-945.423978198,-349.346012357,85.4354651814],[-945.433547188,-349.351902599,85.4003503941],[-945.442945272,-349.357368691,85.3493560436],[-945.447008917,-349.362646728,85.2943312932],[-945.479518073,-349.404871022,84.8541332903],[-945.51202723,-349.447095315,84.4139352874],[-945.544536386,-349.489319609,83.9737372845]],[[-945.388221478,-333.451648802,86.3510865498],[-945.400039994,-333.451723761,86.327895314],[-945.392122086,-333.453924302,86.3433040431],[-945.393566393,-333.455119014,86.340280216],[-945.395010699,-333.456313725,86.3372563889],[-945.396021458,-333.457560079,86.3350554794],[-945.397035591,-333.458808242,86.3327721372],[-945.399063857,-333.461304569,86.3282054528],[-945.401465552,-333.463759603,86.3224402062],[-945.404079042,-333.466173092,86.3155562134],[-945.409306021,-333.47100007,86.3017882276],[-945.415358533,-333.475659522,86.2835216351],[-945.42116942,-333.480170938,86.2617601037],[-945.432791195,-333.489193771,86.2182370408],[-945.443084937,-333.497617933,86.160590681],[-945.447725459,-333.505777475,86.1001272129],[-945.484849638,-333.57105381,85.6164194681],[-945.521973816,-333.636330145,85.1327117233],[-945.559097995,-333.70160648,84.6490039784]],[[-945.373941029,-317.604354538,87.3440303524],[-945.385285742,-317.604437663,87.3206228357],[-945.378881384,-317.606687779,87.3335357879],[-945.380896229,-317.607907404,87.3290374145],[-945.382911073,-317.609127028,87.3245390412],[-945.384541052,-317.610394783,87.320752746],[-945.38615269,-317.611663571,87.3168844815],[-945.389375966,-317.614201147,87.3091479524],[-945.392829166,-317.616697342,87.3003266785],[-945.396375882,-317.619153199,87.2905099723],[-945.403469314,-317.624064913,87.27087656],[-945.410918186,-317.628814267,87.2472440346],[-945.417835643,-317.633425865,87.2205957633],[-945.431670559,-317.642649061,87.1672992207],[-945.443079785,-317.651316684,87.101830504],[-945.448537098,-317.659757005,87.0344899537],[-945.492195602,-317.727279577,86.4957655515],[-945.535854105,-317.794802149,85.9570411493],[-945.579512609,-317.862324721,85.4183167471]],[[-945.359660581,-301.757060273,88.336974155],[-945.370531491,-301.757151564,88.3133503573],[-945.365640682,-301.759451256,88.3237675327],[-945.368226065,-301.760695793,88.3177946131],[-945.370811447,-301.76194033,88.3118216935],[-945.373060647,-301.763229487,88.3064500126],[-945.37526979,-301.7645189,88.3009968257],[-945.379688076,-301.767097725,88.290090452],[-945.38419278,-301.769635082,88.2782131508],[-945.388672722,-301.772133306,88.2654637313],[-945.397632607,-301.777129756,88.2399648924],[-945.406477839,-301.781969012,88.2109664341],[-945.414501867,-301.786680791,88.179431423],[-945.430549922,-301.79610435,88.1163614006],[-945.443074633,-301.805015435,88.043070327],[-945.449348737,-301.813736536,87.9688526945],[-945.499541565,-301.883505344,87.3751116349],[-945.549734394,-301.953274153,86.7813705753],[-945.599927222,-302.023042962,86.1876295157]],[[-945.34505843,-285.921433796,89.4530119755],[-945.355400336,-285.921527409,89.4291225037],[-945.352060445,-285.923672875,89.4366282275],[-945.355209385,-285.924831204,89.4289391603],[-945.358358325,-285.925989533,89.4212500932],[-945.361221357,-285.927183236,89.4140419378],[-945.364022966,-285.928376523,89.4067615364],[-945.369626183,-285.930763097,89.3922007335],[-945.375172927,-285.933114021,89.3768312464],[-945.380581207,-285.93543224,89.3607469883],[-945.391397767,-285.940068678,89.328578472],[-945.401648989,-285.944573966,89.2935439276],[-945.410815905,-285.948977317,89.2564999989],[-945.429149735,-285.957784021,89.1824121416],[-945.442969463,-285.966182372,89.1002369033],[-945.450285243,-285.974444724,89.0178359118],[-945.508811477,-286.040543542,88.3586279799],[-945.567337711,-286.10664236,87.699420048],[-945.625863946,-286.172741177,87.0402121161]],[[-945.333096314,-270.085367905,90.4995611879],[-945.342949493,-270.085457675,90.4754099231],[-945.34086966,-270.087360119,90.4801311499],[-945.34444992,-270.088385142,90.4708054364],[-945.348030179,-270.089410165,90.4614797228],[-945.351367497,-270.090461602,90.4525270727],[-945.354629298,-270.091512339,90.4435147919],[-945.361152899,-270.093613811,90.4254902304],[-945.367516822,-270.095686916,90.4068220468],[-945.373660984,-270.097734459,90.387592549],[-945.385949309,-270.101829545,90.3491335533],[-945.397350174,-270.105822228,90.3084248538],[-945.407483966,-270.109737784,90.2661916777],[-945.427751551,-270.117568898,90.1817253253],[-945.442819635,-270.12509207,90.091129239],[-945.451245524,-270.132522908,90.0008513101],[-945.518652631,-270.19196961,89.2786278793],[-945.586059738,-270.251416313,88.5564044485],[-945.653466845,-270.310863016,87.8341810177]],[[-945.30917208,-238.413236122,92.5926596125],[-945.318047806,-238.413318209,92.5679847619],[-945.31848809,-238.414734609,92.5671369949],[-945.322930989,-238.415493019,92.5545379885],[-945.327373889,-238.416251429,92.5419389821],[-945.331659777,-238.417018335,92.5294973425],[-945.335841962,-238.417783969,92.5170213031],[-945.344206331,-238.419315238,92.4920692242],[-945.352204611,-238.420832707,92.4668036476],[-945.359820539,-238.422338897,92.4412836704],[-945.375052394,-238.425351279,92.390243716],[-945.388752542,-238.428318752,92.3381867063],[-945.400820089,-238.431258719,92.2855750351],[-945.424955184,-238.437138652,92.1803516927],[-945.44251998,-238.442911465,92.0729139104],[-945.453166086,-238.448679274,91.9668821068],[-945.538334938,-238.494821747,91.1186276781],[-945.623503791,-238.54096422,90.2703732494],[-945.708672643,-238.587106693,89.4221188208]],[[-945.29804273,-206.717914679,94.3912663083],[-945.306102218,-206.71796399,94.3660825868],[-945.307845245,-206.718644607,94.3603168377],[-945.312596065,-206.719008692,94.3448350016],[-945.317346885,-206.719372777,94.3293531655],[-945.321997915,-206.719736191,94.3138650882],[-945.326548254,-206.72009876,94.2983741242],[-945.335648933,-206.720823898,94.267392196],[-945.344345116,-206.721545831,94.2364042748],[-945.352632079,-206.722265364,94.2054308307],[-945.369206006,-206.723704431,94.1434839425],[-945.384142069,-206.725134014,94.0815957089],[-945.397414503,-206.726559315,94.0199222429],[-945.423959372,-206.729409917,93.896575311],[-945.443835971,-206.732245618,93.7741065256],[-945.457017717,-206.735084318,93.6535842113],[-945.562471682,-206.757793916,92.6894056965],[-945.667925646,-206.780503514,91.7252271817],[-945.773379611,-206.803213112,90.7610486669]],[[-945.294332534,-175.000001076,94.402698429],[-945.302498782,-174.999994509,94.3774490106],[-945.304283691,-175.000000697,94.371612884],[-945.309105612,-175.000000487,94.356069776],[-945.313927533,-175.000000278,94.3405266681],[-945.318646867,-175.000000059,94.3249839903],[-945.323263272,-174.999999844,94.3094434603],[-945.332496082,-174.999999415,94.2783624005],[-945.341317187,-174.999999001,94.2472897717],[-945.349723629,-174.999998645,94.2162415737],[-945.366536511,-174.999997933,94.1541451778],[-945.381689983,-174.999997473,94.0921473748],[-945.395169731,-174.999997403,94.0303669299],[-945.422129227,-174.999997264,93.90680604],[-945.442384898,-174.999999002,93.7841346562],[-945.455950737,-175.000000094,93.6631035541],[-945.564477445,-175.000008834,92.6948547374],[-945.673004154,-175.000017574,91.7266059207],[-945.781530863,-175.000026315,90.758357104]]],"weights":[[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]],"uClosed":false,"vClosed":false,"selfIntersect":false,"form":"unspecified"},
"sameSense": true,
"coedges": [{"edge":0,"orientation":"forward"},{"edge":1,"orientation":"reversed"},{"edge":2,"orientation":"forward"},{"edge":3,"orientation":"reversed"}]}`;
export const pleatAtEdge = (): BrepBuilder => oneFace(PLEAT_AT_EDGE);

/**
 * VW #2452's #298974 alone, its source's numbers to 12 digits: a bicubic B-spline whose first row (u = 0.008) collapses
 * only to within the tolerance, a row 0.12 long at an uncertainty of 0.123, the face's corner on it. Its fan's ring
 * at medium (0.1 mm), at the deflection's floor, reaches no farther than the row is long, so the fan and the mesher's
 * triangles lie on one side of the ring's segments and the fan folds (3 edges used twice the same way), with or
 * without consistentFans and apexCorners.
 */
const POLE_ROW_FAN = `
{"uncertainty": 0.123061906869,
"vertices": [[14.4861819385,56.0422212961,22.9098444385],[13.5895488509,55.3458099056,23.2720295592],[20.6709311148,53.4072296708,28.3563616838],[20.7134799404,53.5767864747,28.3477690301]],
"edges": [
{"curve":{"kind":"bspline","degree":3,"knots":[0,1],"multiplicities":[4,4],"poles":[[14.4861819385,56.0422212961,22.9098444385],[14.1239559263,55.9539015795,23.0767589079],[13.7914535257,55.6956482734,23.2110696129],[13.5895488509,55.3458099056,23.2720295592]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":0,"end":1,"sameSense":true},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.03125,0.046875,0.0625,0.0703125,0.078125,0.09375,0.125,0.140625,0.15625,0.1875,0.21875,0.25,0.3125,0.375,0.4375,0.5,0.5625,0.625,0.75,1],"multiplicities":[4,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,4],"poles":[[20.6712207846,53.4070341527,28.3535454669],[20.6130835547,53.3719316166,28.3500018607],[20.5098353615,53.3363800478,28.3417777843],[20.3315783008,53.3244510041,28.3213286347],[20.2179728414,53.3292968265,28.3062707493],[20.0907651396,53.3462881592,28.2865782282],[20.0592550315,53.3522240091,28.2812922133],[19.9452067628,53.3758479358,28.2616580817],[19.7568652275,53.4214303995,28.2266693841],[19.4420732094,53.5006329673,28.1545636079],[19.2263838058,53.5556285269,28.0994107244],[18.9773022157,53.620473219,28.0292378522],[18.7109027446,53.69254607,27.9436457878],[18.4220837217,53.7750586965,27.8415265134],[18.0054406153,53.9014257582,27.6734789924],[17.5125664338,54.0567397824,27.4338652605],[17.0158108521,54.2182657908,27.1523536469],[16.4840831385,54.3951150644,26.7951584736],[16.0766116963,54.5321897564,26.4797646891],[15.512936662,54.7228111992,25.9903546681],[14.6020160697,55.0314603344,25.0338128939],[13.9413196531,55.2466593817,24.0212251605],[13.5895488494,55.3458099066,23.2720295601]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":1,"end":2,"sameSense":false},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.999995873217],"multiplicities":[4,4],"poles":[[20.7134790187,53.5767871046,28.3477745784],[20.7229199795,53.5209613529,28.3556346426],[20.7086557973,53.4644976595,28.3593736243],[20.6706119987,53.4074462572,28.3594437627]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":3,"end":2,"sameSense":true},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.25,0.5,0.75,1],"multiplicities":[4,1,1,1,4],"poles":[[14.4861819385,56.0422212961,22.9098444385],[14.9983076947,55.8549852607,24.3690770175],[16.5322585416,55.1591178127,26.5197507948],[18.7673480149,54.1443254971,27.8842962864],[20.2700627997,53.5573526244,28.2979780404],[20.6687179956,53.5119506425,28.3476029642],[20.7134790178,53.5767871053,28.3477745782]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":3,"end":0,"sameSense":false}
],
"surface": {"kind":"bspline","uDegree":3,"vDegree":3,"uKnots":[0.00800894050238,0.00809578806991,0.00941754938745,0.010739310705,0.0140437139988,0.0161089660575],"vKnots":[-0.00768976554486,0,0.5,1],"uMultiplicities":[4,2,2,2,2,4],"vMultiplicities":[4,3,2,4],"poles":[[[20.7240377955,53.601046605,28.3469037318],[20.7243131092,53.6009225536,28.3469643807],[20.7245884229,53.6007985023,28.3470250295],[20.7248637367,53.6006744509,28.3470856784],[20.7427650454,53.5926084482,28.3510291568],[20.760736163,53.5845043852,28.3545812185],[20.7967880187,53.5682312309,28.3608968198],[20.8148687552,53.5600621403,28.3636603592],[20.8329892204,53.5518661332,28.3660274279]],[[20.7196451982,53.5855408655,28.3477714477],[20.7199038421,53.5853924596,28.3478311132],[20.720162486,53.5852440538,28.3478907786],[20.7204211299,53.5850956479,28.347950444],[20.737238541,53.575446078,28.3518299788],[20.7541208145,53.5657563576,28.3553305294],[20.7879884771,53.5463108499,28.3615682677],[20.804973865,53.5365550634,28.3643054552],[20.8219974288,53.5267734113,28.3666588503]],[[20.7112754905,53.5721118817,28.3478733196],[20.7115170576,53.5719382086,28.347932878],[20.7117586247,53.5717645355,28.3479924363],[20.7120001917,53.5715908624,28.3480519947],[20.7277072418,53.5602983782,28.3519245675],[20.7434767236,53.5489627065,28.3554196018],[20.7751162166,53.5262223628,28.3616492142],[20.7909862264,53.5148176916,28.364383792],[20.8068942549,53.5033872613,28.3667360367]],[[20.5002678053,53.395098624,28.3354377683],[20.500226329,53.3944997521,28.3355121345],[20.5001848528,53.3939008803,28.3355865007],[20.5001433765,53.3933020084,28.3356608669],[20.4974465276,53.3543624682,28.3404962689],[20.4948156649,53.3153111543,28.344769324],[20.4896796621,53.2370562284,28.3521814375],[20.487174521,53.1978526205,28.3553204953],[20.4847289793,53.1586086393,28.3578890812]],[[19.8807845548,53.7064707993,28.2009009308],[19.8806675192,53.705724384,28.2011178707],[19.8805504836,53.7049779688,28.2013348107],[19.880433448,53.7042315535,28.2015517506],[19.8728236184,53.6556985214,28.2156575098],[19.8655271845,53.6065269087,28.2274320749],[19.8515846999,53.5073172921,28.2462449392],[19.8449386138,53.4572793015,28.2532832551],[19.8386290528,53.4070136262,28.2579301701]],[[18.9872194508,54.0680884955,27.8937956749],[18.9868672591,54.0670630699,27.8942449163],[18.9865150675,54.0660376444,27.8946941578],[18.9861628758,54.0650122188,27.8951433992],[18.9632628499,53.998337523,27.9243537447],[18.9413134663,53.9292126602,27.9485688818],[18.8997615314,53.7875494559,27.9865052961],[18.8801592546,53.7150121383,28.0002263125],[18.861929828,53.6415467392,28.0085569196]],[[18.552842238,54.2600488416,27.6945621681],[18.5523705708,54.2589295712,27.6951385204],[18.5518989037,54.2578103009,27.6957148727],[18.5514272365,54.2566910305,27.696291225],[18.5207587357,54.1839144063,27.7337665106],[18.4914937401,54.1073728478,27.7648721479],[18.43657508,53.9489932337,27.8134731817],[18.410922016,53.8671572101,27.8309680211],[18.3874306408,53.7838600185,27.8414122236]],[[17.1007101946,54.9079476919,26.8486842792],[17.0997618029,54.9066082552,26.8496954849],[17.0988134113,54.9052688184,26.8507066907],[17.0978650196,54.9039293817,26.8517178964],[17.0361991821,54.8168372103,26.9174679966],[16.9778815313,54.7199007941,26.9725806244],[16.87092358,54.5117012798,27.0586634946],[16.8222877029,54.400447756,27.0896300944],[16.7797470535,54.2850735064,27.1077161568]],[[16.202834868,55.323638065,25.984536632],[16.2014406465,55.3223508249,25.985827489],[16.2000464251,55.3210635847,25.9871183461],[16.1986522036,55.3197763445,25.9884092032],[16.1079978489,55.2360780728,26.0723426507],[16.0227462055,55.1354923573,26.1438277307],[15.8693432756,54.9090330407,26.2560915905],[15.8012027202,54.7831825469,26.2968596348],[15.7441711532,54.6498200488,26.3206258388]],[[15.0920179763,55.8090263354,24.3274204572],[15.0898356385,55.8080219462,24.3288409077],[15.0876533008,55.8070175569,24.3302613582],[15.085470963,55.8060131676,24.3316818087],[14.9435721149,55.7407062821,24.4240416156],[14.8086848866,55.6452252164,24.5052383531],[14.5698072148,55.4061204559,24.635017356],[14.4658802316,55.2625621041,24.6835644214],[14.3839733937,55.1040910802,24.7126997957]],[[14.7466170488,55.9521943148,23.6269071147],[14.7441197416,55.951345792,23.6283008044],[14.7416224345,55.9504972691,23.6296944942],[14.7391251273,55.9496487463,23.6310881839],[14.5767464969,55.8944765277,23.7217079662],[14.4215493588,55.8036008446,23.8026149946],[14.1477154719,55.5637381956,23.9331659173],[14.0291735945,55.4148374283,23.9827623094],[13.9374891223,55.2477390202,24.0130666905]],[[14.4945382379,56.0442587698,22.9059938391],[14.4917528048,56.0435796119,22.9072773722],[14.4889673716,56.042900454,22.9085609054],[14.4861819385,56.0422212961,22.9098444385],[14.3050689324,55.9980614378,22.9933016732],[14.1305719982,55.9128325324,23.0691555694],[13.8232173716,55.6741114035,23.1933081064],[13.6905011883,55.5207290895,23.2415495861],[13.5895488509,55.3458099056,23.2720295592]]],"uClosed":false,"vClosed":false,"selfIntersect":false,"form":"unspecified"},
"sameSense": true,
"coedges": [{"edge":0,"orientation":"forward"},{"edge":1,"orientation":"forward"},{"edge":2,"orientation":"reversed"},{"edge":3,"orientation":"forward"}]}`;
export const poleRowFan = (): BrepBuilder => oneFace(POLE_ROW_FAN);

/**
 * LMP1 #172880's #1065578 alone, its source's numbers to 12 digits: a B-spline whose pole is a row 2.2e-5 long (a
 * reach of 0.1 at medium): a pole in all but rounding, its fan kept.
 */
const POLE_ROW_SHORT = `
{"uncertainty": 0.150519803108,
"vertices": [[-57.791603222,184,76.8676173498],[-60.4402368222,169.181849167,69.9676909214],[-56.632506912,169.181849167,75.0250568867]],
"edges": [
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.0625,0.125,0.25,0.5,1],"multiplicities":[4,2,2,2,2,4],"poles":[[-57.791603222,184,76.8676173498],[-57.9222934389,183.980967179,76.5271576948],[-58.0513960655,183.833448473,76.1908338541],[-58.2913512672,183.512230338,75.565729182],[-58.405137619,183.315971308,75.2693056013],[-58.7276099465,182.664788824,74.4292364672],[-58.919273962,182.14391577,73.9299346365],[-59.4300216557,180.458916818,72.5993914047],[-59.6912971013,179.152934253,71.9187455986],[-60.2857934602,175.077506506,70.370029635],[-60.4402368222,172.131170754,69.9676909214],[-60.4402368222,169.181849167,69.9676909214]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":0,"end":1,"sameSense":true},
{"curve":{"kind":"circle","position":{"origin":[-49.7040619175,169.181849167,65.8464595017],"axis":[0,-1,0],"xDir":[0,0,-1]},"radius":11.5},"start":2,"end":1,"sameSense":true},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.03125,0.0625,0.09375,0.109375,0.1171875,0.125,0.1328125,0.140625,0.15625,0.1875,0.21875,0.234375,0.25,0.28125,0.3125,0.375,0.4375,0.46875,0.484375,0.5,0.515625,0.53125,0.5625,0.625,0.75,1],"multiplicities":[4,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,4],"poles":[[-57.7915846696,183.999989092,76.8676102282],[-57.7919932403,183.884769675,76.8664199456],[-57.7988044049,183.64667747,76.8384342874],[-57.8233424576,183.242178852,76.7241539537],[-57.8525238341,182.851534873,76.5744738147],[-57.8773415705,182.52706602,76.4366770071],[-57.8914379541,182.342256904,76.3560549348],[-57.9055120391,182.156290379,76.2735268654],[-57.9085424075,182.116029545,76.2554488427],[-57.9169230923,182.003992543,76.2053721608],[-57.9305279505,181.815881863,76.1215408286],[-57.9520213795,181.486144693,75.9778669842],[-57.971506921,181.081361298,75.8141488725],[-57.9841662908,180.710342522,75.674589809],[-57.9950794558,180.277051396,75.5200358293],[-57.998735529,179.835780213,75.3784482822],[-57.9915515847,179.094271329,75.1685447503],[-57.9636747664,178.240095299,74.970676656],[-57.9241568746,177.488660357,74.8332053914],[-57.8948844165,177.044675617,74.7654875326],[-57.877074986,176.805212991,74.7329634286],[-57.8656649171,176.662406412,74.7149688246],[-57.8462320455,176.437277072,74.6892525603],[-57.8209324193,176.16226746,74.66107928],[-57.771003559,175.660793765,74.617371228],[-57.653596964,174.639479604,74.5601812225],[-57.3444401464,172.490252558,74.5641924047],[-56.9522894266,170.517508769,74.7826183992],[-56.6322468155,169.18184908,75.0247125658]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":2,"end":0,"sameSense":false}
],
"surface": {"kind":"bspline","uDegree":3,"vDegree":2,"uKnots":[0,0.5,0.75,0.875,0.9375,0.96875,0.984375,0.9921875,0.99609375,0.998046875,0.9990234375,0.99951171875,0.999755859375,0.999877929688,0.999938964844,0.999969482422,0.999984741211,1],"vKnots":[0,1],"uMultiplicities":[4,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,4],"vMultiplicities":[3,3],"poles":[[[-56.6325069121,169.181849167,75.0250568867],[-59.2603316991,169.181849167,73.0414488551],[-60.4402368222,169.181849167,69.9676909214]],[[-57.1866453762,171.492706262,74.6067666287],[-59.3935560688,171.746599894,72.6943875063],[-60.4402368226,172.095491121,69.9676909205]],[[-57.6086786576,173.889674848,74.4362310135],[-59.3970880923,174.436444092,72.6851862706],[-60.2857934449,175.077506822,70.3700296748]],[[-57.9394489769,177.433258689,74.7875392617],[-59.083782585,178.26508498,73.5013750215],[-59.691297016,179.152934732,71.9187458206]],[[-58.0000045008,178.613000591,75.0081041111],[-58.9261575983,179.513587649,73.9120021507],[-59.4300215396,180.458917348,72.5993917071]],[[-57.9978111016,180.351188981,75.5365383587],[-58.5875524177,181.235568759,74.794098804],[-58.9192737806,182.143916294,73.9299351088]],[[-57.9815451495,180.928087897,75.7473012182],[-58.4569257134,181.787445778,75.134393003],[-58.7276097404,182.664789345,74.4292370041]],[[-57.9309282682,181.8158013,76.121015579],[-58.2312588535,182.56126426,75.7222752719],[-58.4051373694,183.31597176,75.2693062514]],[[-57.9096150082,182.115030649,76.2557210466],[-58.1508411208,182.810254463,75.9317706278],[-58.2913510033,183.512230768,75.5657298697]],[[-57.870717776,182.604625932,76.4730774798],[-58.0223356135,183.177182458,76.2665389199],[-58.1113845762,183.753144289,76.0345584407]],[[-57.8565498772,182.774054199,76.5483423744],[-57.9780529952,183.298199747,76.3818990844],[-58.0496305897,183.824801537,76.1954330756]],[[-57.8335651781,183.06776702,76.6649509237],[-57.909735934,183.489194082,76.5598711134],[-57.9547935736,183.911849022,76.4424919493]],[[-57.8256129553,183.171410103,76.7044541817],[-57.8866440566,183.554013169,76.6200275106],[-57.9228002423,183.937497963,76.5258374267]],[[-57.813179947,183.360515888,76.7649750117],[-57.8513366619,183.664392502,76.7120064188],[-57.8739882308,183.968707113,76.6529970641]],[[-57.8089601681,183.428443931,76.7853165918],[-57.8394823792,183.703001763,76.7428878809],[-57.8576153514,183.977872705,76.6956498733]],[[-57.8025163562,183.555346272,76.8160847068],[-57.8215692173,183.772071555,76.7895532631],[-57.8329000254,183.988951845,76.7600354988]],[[-57.8003472875,183.601422146,76.8263930384],[-57.8155708923,183.796757517,76.8051794338],[-57.8246277987,183.992203398,76.7815853861]],[[-57.797064974,183.688977711,76.8419205285],[-57.8065399109,183.842524129,76.8287059449],[-57.8121797192,183.996124984,76.8140137418]],[[-57.7960797242,183.724519728,76.8470182644],[-57.8035413421,183.860898153,76.8365174836],[-57.8080138887,183.997314004,76.8248661014]],[[-57.7942533057,183.780464193,76.8549490383],[-57.7989826297,183.88953945,76.8483933355],[-57.8017837756,183.99863416,76.8410961008]],[[-57.7929847451,183.778180342,76.8581141406],[-57.7973655114,183.888484877,76.8526060727],[-57.7997713458,183.998809639,76.8463386597]],[[-57.791790599,183.799353424,76.8622765761],[-57.7950610906,183.899297176,76.8586092941],[-57.7967082994,183.999256025,76.8543181684]],[[-57.7914241265,183.807609401,76.863634428],[-57.7942999361,183.903500491,76.8605921692],[-57.7956872839,183.99940482,76.8569780047]],[[-57.7910420158,183.828433133,76.865526831],[-57.7931931099,183.914025843,76.8634755501],[-57.7941557607,183.999628012,76.8609677591]],[[-57.7909340717,183.836296032,76.8661372736],[-57.7928288214,183.917995142,76.8644245542],[-57.7936452529,183.99970241,76.8622976772]],[[-57.7908949206,183.855802304,76.8669508655],[-57.7923073434,183.927805343,76.8657830508],[-57.7928794913,183.999814006,76.8642925544]],[[-57.7908858811,183.862471899,76.8672122231],[-57.792135421,183.931159141,76.866230924],[-57.7926242375,183.999851205,76.8649575135]],[[-57.7909764686,183.880580245,76.8675268807],[-57.791897168,183.940242024,76.8668515942],[-57.7922413567,183.999907003,76.8659549521]],[[-57.7909621786,183.882558673,76.8676395103],[-57.7918135978,183.94124067,76.8670693019],[-57.7921137297,183.999925602,76.8662874316]],[[-57.7911341556,183.903739124,76.8677222272],[-57.7917150874,183.951845473,76.8673259304],[-57.7919222893,183.999953502,76.8667861509]],[[-57.7911703684,183.909077529,76.8677477032],[-57.7916812451,183.954519451,76.8674140925],[-57.7918584759,183.999962801,76.8669523907]],[[-57.7912360869,183.918874204,76.8677770476],[-57.7916326974,183.95942498,76.8675405635],[-57.7917627557,183.999976751,76.8672017503]],[[-57.7913005291,183.927012149,76.8677622358],[-57.7916233603,183.963496399,76.8675648876],[-57.7917308489,183.999981401,76.8672848702]],[[-57.7913574279,183.935999636,76.8677633542],[-57.7915949209,183.967994933,76.8676389748],[-57.7916670355,183.9999907,76.86745111]],[[-57.7915108194,183.926203582,76.8678576733],[-57.7916506532,183.963099819,76.8674937872],[-57.7916351287,183.99999535,76.8675342299]],[[-57.7916032219,183.999978024,76.8676173498],[-57.791603222,183.999989012,76.8676173498],[-57.791603222,184,76.8676173498]]],"weights":[[1,0.961375277528,1],[1,0.96970093935,1],[1,0.977103928483,1],[1,0.98671233896,1],[1,0.989693442366,1],[1,0.993796817244,1],[1,0.995115838268,1],[1,0.997006871213,1],[1,0.997625394841,1],[1,0.998530908914,1],[1,0.998830120317,1],[1,0.999272478989,1],[1,0.999418937117,1],[1,0.999638195455,1],[1,0.99971105159,1],[1,0.999819998165,1],[1,0.999856291616,1],[1,0.999910649353,1],[1,0.999930333128,1],[1,0.999955107642,1],[1,0.999954005577,1],[1,0.999962192242,1],[1,0.999965359016,1],[1,0.999972311516,1],[1,0.999974922345,1],[1,0.999980415404,1],[1,0.999982366579,1],[1,0.999986534245,1],[1,0.999987660955,1],[1,0.999991047959,1],[1,0.999992113413,1],[1,0.999993851647,1],[1,0.999994863775,1],[1,0.999996270752,1],[1,0.999997201847,1],[1,1,1]],"uClosed":false,"vClosed":false,"selfIntersect":false,"form":"unspecified"},
"sameSense": true,
"coedges": [{"edge":0,"orientation":"forward"},{"edge":1,"orientation":"reversed"},{"edge":2,"orientation":"forward"}]}`;
export const poleRowShort = (): BrepBuilder => oneFace(POLE_ROW_SHORT);

/**
 * LMP1 #172535's #1050721 alone, its source's numbers to 12 digits: a B-spline with a pole at each end of u, rows
 * 0.195 and 0.182 long at reaches of 0.1954 and 0.1845, their rings standing 1.1e-3 and 1.3e-3 off in u: fans kept.
 */
const POLE_ROW_NEAR = `
{"uncertainty": 0.2,
"vertices": [[2866.67757604,630.448933538,345.645669369],[2866.66543264,630.268292776,345.688534565],[2878.2704842,630.661033053,333.270678412],[2878.21719821,630.849758694,333.292379522]],
"edges": [
{"curve":{"kind":"bspline","degree":3,"knots":[0,1],"multiplicities":[4,4],"poles":[[2866.66556211,630.268277283,345.688500171],[2866.66899428,630.328554394,345.67426452],[2866.67249365,630.388779018,345.659964844],[2866.67606027,630.448950816,345.64560233]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":0,"end":1,"sameSense":false},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.015625,0.03125,0.0390625,0.046875,0.0625,0.0703125,0.078125,0.09375,0.109375,0.125,0.1328125,0.140625,0.14453125,0.1484375,0.15625,0.171875,0.1875,0.203125,0.2109375,0.21484375,0.21875,0.2265625,0.234375,0.25,0.265625,0.28125,0.2890625,0.296875,0.3125,0.34375,0.375,0.40625,0.4375,0.46875,0.484375,0.5,0.515625,0.53125,0.5625,0.5703125,0.578125,0.59375,0.625,0.65625,0.671875,0.6875,0.71875,0.75,0.765625,0.78125,0.796875,0.8125,0.828125,0.84375,0.875,0.890625,0.90625,0.9375,0.953125,0.96875,1],"multiplicities":[4,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,4],"poles":[[2878.27047253,630.661024104,333.270732926],[2878.4468093,630.664994118,333.309132513],[2878.82968571,630.656510791,333.39890385],[2879.38778533,630.602756332,333.562144173],[2879.84680306,630.536185478,333.722519372],[2880.25759098,630.471547475,333.88257177],[2880.64090004,630.405444354,334.051275923],[2881.07166334,630.319285737,334.270469128],[2881.31106845,630.269221378,334.401618219],[2881.68825497,630.196215282,334.622253518],[2882.19521086,630.099921007,334.961528194],[2882.67313979,630.008481239,335.330712622],[2883.07202922,629.930206977,335.678713987],[2883.34163016,629.876046291,335.935358984],[2883.53122631,629.837165067,336.128668307],[2883.66870531,629.80843867,336.273660843],[2883.92719329,629.753097404,336.558827498],[2884.26777759,629.676041354,336.974978301],[2884.65108252,629.583033984,337.509523929],[2884.94330152,629.50640813,337.98209633],[2885.12827816,629.454944973,338.316208939],[2885.23526451,629.424239504,338.522832495],[2885.2706818,629.413458981,338.593522481],[2885.35000342,629.388125562,338.754615723],[2885.47834925,629.343063036,339.0326289],[2885.66833325,629.269234359,339.484738093],[2885.90587646,629.159710411,340.177980034],[2886.09001288,629.052292409,340.906525073],[2886.19971546,628.966201271,341.541505489],[2886.26992095,628.894001042,342.100508924],[2886.33061319,628.77659746,343.073768012],[2886.25018534,628.646640822,344.32802046],[2885.9877835,628.535152232,345.610911938],[2885.62498207,628.454272029,346.678163388],[2885.26228699,628.390726583,347.492300553],[2884.74314038,628.321574782,348.402659584],[2884.1595376,628.275011173,349.202822446],[2883.59524385,628.248306285,349.85801333],[2883.00863824,628.238144117,350.430361706],[2882.25318382,628.240879159,351.061742048],[2881.66025462,628.256180382,351.457371414],[2881.21345159,628.26930366,351.717293708],[2880.97259502,628.276117593,351.850001325],[2880.46150613,628.289377436,352.111012662],[2879.54229293,628.316979745,352.49714994],[2878.33097443,628.377509676,352.823696717],[2877.21185033,628.45633416,352.979671423],[2875.97535617,628.561658054,353.038468766],[2874.64745034,628.704461165,352.913709473],[2873.60077004,628.834329769,352.663239279],[2872.914153,628.922709213,352.43715727],[2872.4902539,628.977611307,352.273709737],[2872.06339894,629.030701303,352.088626289],[2871.52209772,629.101069991,351.818342239],[2870.91755856,629.186619769,351.467693564],[2869.98200907,629.333741769,350.817218847],[2869.28104753,629.474184402,350.173150983],[2868.80428952,629.586463544,349.659115163],[2868.40673163,629.691945276,349.189458786],[2867.86523499,629.855371389,348.457881697],[2867.31569597,630.070691256,347.436857757],[2866.92518519,630.218981877,346.535540655],[2866.7508522,630.265391387,345.984256164],[2866.66556121,630.268276661,345.688497329]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":1,"end":2,"sameSense":false},
{"curve":{"kind":"bspline","degree":3,"knots":[0,1],"multiplicities":[4,4],"poles":[[2878.21696344,630.849814302,333.29059234],[2878.23490562,630.786937901,333.283897125],[2878.25274875,630.724009236,333.277279269],[2878.27049155,630.661028981,333.270737798]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":2,"end":3,"sameSense":false},
{"curve":{"kind":"bspline","degree":3,"knots":[0,0.015625,0.03125,0.0390625,0.046875,0.0625,0.078125,0.09375,0.1015625,0.10546875,0.107421875,0.109375,0.11328125,0.1171875,0.125,0.140625,0.15625,0.1640625,0.16796875,0.171875,0.173828125,0.17578125,0.177734375,0.1796875,0.18359375,0.1875,0.203125,0.21875,0.234375,0.25,0.265625,0.2734375,0.27734375,0.279296875,0.28125,0.2890625,0.296875,0.3125,0.328125,0.34375,0.375,0.390625,0.3984375,0.40625,0.4375,0.46875,0.484375,0.5,0.5078125,0.515625,0.51953125,0.5234375,0.53125,0.546875,0.5625,0.578125,0.59375,0.625,0.65625,0.6875,0.71875,0.734375,0.75,0.7578125,0.76171875,0.765625,0.7734375,0.78125,0.796875,0.8125,0.8203125,0.828125,0.84375,0.859375,0.875,0.87890625,0.8828125,0.890625,0.90625,0.9375,0.953125,0.96875,1],"multiplicities":[4,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,4],"poles":[[2878.21715519,630.84759055,333.293833083],[2878.39598446,630.871820768,333.335267683],[2878.78449843,630.908393959,333.43278302],[2879.32723914,630.925223949,333.598334835],[2879.81928103,630.917981174,333.777982533],[2880.21064596,630.907675245,333.936724324],[2880.72203499,630.892249223,334.172371058],[2881.3023045,630.868910429,334.488669902],[2881.77275207,630.845752442,334.785386304],[2882.08914113,630.827798536,335.006906182],[2882.24784744,630.818210181,335.123746407],[2882.33279335,630.812861711,335.188004704],[2882.33348536,630.812947031,335.188626776],[2882.37229216,630.811038269,335.218341818],[2882.43373095,630.808750727,335.266243873],[2882.59107839,630.803493816,335.391242512],[2882.92728193,630.793942622,335.672942501],[2883.39725925,630.780909992,336.119947781],[2883.77729436,630.769978186,336.536465195],[2884.00412025,630.763285878,336.805068708],[2884.15189231,630.758843796,336.990237313],[2884.2660879,630.755360684,337.139225783],[2884.36766208,630.752233371,337.27676891],[2884.39336412,630.751404457,337.312616303],[2884.4539159,630.749394767,337.397029456],[2884.52021164,630.747013972,337.491972305],[2884.68547491,630.740592413,337.735206307],[2884.92478348,630.729292352,338.115962976],[2885.22827359,630.71059993,338.670611698],[2885.50719866,630.688623805,339.270263217],[2885.75476926,630.663628719,339.916295439],[2885.92916383,630.640719161,340.488577824],[2886.03323633,630.623449558,340.913716476],[2886.07833081,630.614932936,341.122777417],[2886.10537676,630.60946017,341.25645265],[2886.16006321,630.597727214,341.546689209],[2886.21793571,630.582734608,341.932048168],[2886.2861361,630.557672654,342.611125527],[2886.30432872,630.531698316,343.379990471],[2886.25520434,630.507257818,344.185231931],[2886.13055762,630.482350169,345.092100147],[2885.97180362,630.466746319,345.741585523],[2885.85931201,630.456874847,346.116821277],[2885.81860794,630.453061419,346.245198075],[2885.72393795,630.442961447,346.532871572],[2885.50563801,630.417696236,347.128996426],[2885.04058245,630.377012113,348.066516774],[2884.47104583,630.342648871,348.935201876],[2884.02133073,630.32203296,349.511229841],[2883.5904147,630.30701926,349.986852921],[2883.30437315,630.298769338,350.275107608],[2883.02910792,630.292380662,350.528789081],[2882.91424692,630.289902659,350.630070469],[2882.63067044,630.283789118,350.87328629],[2882.24633518,630.276179721,351.170802923],[2881.73814673,630.267120806,351.51941124],[2881.20513119,630.25886408,351.83632946],[2880.45392418,630.249028694,352.219266679],[2879.44834434,630.239666072,352.609819274],[2878.15447108,630.233842544,352.922932442],[2876.79072599,630.234073339,353.065231201],[2875.62088299,630.239716699,353.030001282],[2874.66902469,630.24787972,352.898467932],[2874.09299381,630.254239745,352.778064029],[2873.65441755,630.260018031,352.658768759],[2873.46319545,630.2627527,352.601068326],[2873.3107318,630.264538473,352.553122685],[2873.09204674,630.266589855,352.479898513],[2872.72522528,630.26901345,352.344683324],[2872.21849777,630.270978908,352.132687921],[2871.6569044,630.272488306,351.849263625],[2871.18686002,630.273468088,351.576925996],[2870.65276175,630.276058074,351.234299474],[2870.13072012,630.282378843,350.844561511],[2869.6404698,630.292280852,350.425973407],[2869.3658291,630.30108469,350.161969423],[2869.23699873,630.306261044,350.033120862],[2869.11959344,630.311556432,349.913228125],[2868.90003047,630.323007074,349.680087555],[2868.43799116,630.352889704,349.146215311],[2867.87801388,630.406202425,348.377090034],[2867.32489793,630.47231057,347.352437381],[2866.93923708,630.495845998,346.469637517],[2866.76439135,630.477062026,345.931771061],[2866.67893733,630.447173444,345.645446819]],"closed":false,"selfIntersect":false,"form":"unspecified"},"start":3,"end":0,"sameSense":true}
],
"surface": {"kind":"bspline","uDegree":3,"vDegree":2,"uKnots":[0,0.0625,0.125,0.1875,0.25,0.375,0.4375,0.5,0.5625,0.625,0.75,0.78125,0.8125,0.875,0.9375,1],"vKnots":[0,1],"uMultiplicities":[4,2,2,2,2,2,2,2,2,2,2,2,2,2,2,4],"vMultiplicities":[3,3],"poles":[[[2878.2704842,630.661033053,333.270678412],[2878.24400188,630.754622794,333.280368334],[2878.21674974,630.847535602,333.293739147]],[[2879.10603736,630.679827524,333.452742597],[2879.09230109,630.822703024,333.469407332],[2879.07657879,630.964091401,333.492934285]],[[2879.95565375,630.523838988,333.722838629],[2879.96172707,630.721061164,333.751795435],[2879.9623425,630.915942617,333.794201045]],[[2881.54935028,630.231303087,334.496628057],[2881.55848384,630.540707283,334.530721752],[2881.54780721,630.844968996,334.596377686]],[[2882.27766921,630.088269058,334.9832379],[2882.28135074,630.454179519,335.012083427],[2882.25359752,630.813432332,335.082682561]],[[2883.5889884,629.827506297,336.134142862],[2883.59349914,630.305481203,336.146103785],[2883.53293733,630.774202782,336.219733767]],[[2884.17153177,629.706766593,336.801405862],[2884.18249968,630.240338409,336.802671085],[2884.10586712,630.76365816,336.873927277]],[[2885.13432534,629.466629707,338.249594263],[2885.17577249,630.104685543,338.246529875],[2885.07593213,630.731815873,338.321377144]],[[2885.52736145,629.338549429,339.052495599],[2885.59625146,630.026752851,339.068444957],[2885.49179186,630.704456332,339.160183181]],[[2886.3529966,628.942880907,341.55074319],[2886.48016932,629.76739923,341.591383127],[2886.33470552,630.585793693,341.673470423]],[[2886.45593147,628.728040468,343.37305792],[2886.62133836,629.627479329,343.388612034],[2886.45387369,630.526241952,343.397900162]],[[2885.89342021,628.508561898,345.993147832],[2886.09561941,629.48121745,346.07450668],[2885.92317888,630.462408457,346.044541319]],[[2885.58171391,628.44064646,346.854087267],[2885.77912039,629.431033683,346.987425339],[2885.59881826,630.433189628,346.966520717]],[[2884.74110745,628.317326587,348.444237753],[2884.9274108,629.331208067,348.627511781],[2884.75200436,630.362040477,348.577521493]],[[2884.22134623,628.271251613,349.171608459],[2884.40412669,629.29091599,349.361849301],[2884.24325152,630.329336935,349.284533607]],[[2882.98437815,628.231592378,350.49268828],[2883.15521394,629.249937342,350.695221468],[2883.03646756,630.288784567,350.573623606]],[[2882.28667272,628.238992299,351.063480992],[2882.44964533,629.250192586,351.270681281],[2882.35690296,630.281747767,351.133975297]],[[2880.75813107,628.281936614,352.004281842],[2880.86684216,629.265799098,352.226995744],[2880.79834965,630.267929881,352.08607094]],[[2879.92276362,628.307674694,352.370162728],[2879.98154468,629.271195044,352.59857206],[2879.9057643,630.251102482,352.464265267]],[[2877.35918729,628.419638608,353.105949678],[2877.36134064,629.307597617,353.296314168],[2877.33462649,630.205010605,353.15986433]],[[2875.50779809,628.59300307,353.137334959],[2875.54254987,629.406394413,353.290484318],[2875.59982771,630.223494736,353.173685301]],[[2873.36951516,628.86716085,352.593809794],[2873.36213046,629.56684038,352.689183683],[2873.41421145,630.264890353,352.596264417]],[[2872.95385699,628.919274182,352.457324351],[2872.93182223,629.595387574,352.5378479],[2872.97314772,630.269087755,352.445799101]],[[2872.14507038,629.020583672,352.131511999],[2872.11749489,629.648088784,352.189864539],[2872.15693671,630.271943493,352.105393457]],[[2871.75166187,629.071125407,351.942251746],[2871.72499699,629.673530815,351.990900698],[2871.76553189,630.27182201,351.910917283]],[[2870.60372739,629.230083353,351.293780816],[2870.58730999,629.754392999,351.319568108],[2870.63314181,630.273759783,351.255996868]],[[2869.90769317,629.342744133,350.770057496],[2869.90559176,629.813155097,350.78933592],[2869.95904832,630.278661008,350.741380794]],[[2868.66182107,629.610136939,349.548340084],[2868.68215894,629.969506573,349.565141332],[2868.74069157,630.324816499,349.548807057]],[[2868.11436093,629.769357089,348.846219873],[2868.14177655,630.071471013,348.867218652],[2868.19806886,630.370319677,348.867229096]],[[2867.23795685,630.093194288,347.337476102],[2867.26101451,630.285190742,347.34944269],[2867.29641939,630.475590765,347.355355523]],[[2866.90137677,630.260305704,346.506482786],[2866.91144016,630.397986806,346.493812048],[2866.92767334,630.534217757,346.478943685]],[[2866.66543264,630.268292776,345.688534565],[2866.67051691,630.357950918,345.667298784],[2866.67884482,630.44714108,345.645136838]]],"weights":[[1,0.999808969803,1],[1,0.999642529164,1],[1,0.999267935782,1],[1,0.998128173722,1],[1,0.997378206994,1],[1,0.99551975109,1],[1,0.994406439217,1],[1,0.991976557393,1],[1,0.99060691992,1],[1,0.986511646529,1],[1,0.983757027811,1],[1,0.980723923932,1],[1,0.979886049169,1],[1,0.97878542516,1],[1,0.978527141752,1],[1,0.97856619762,1],[1,0.978868456234,1],[1,0.980043982983,1],[1,0.980902700455,1],[1,0.983977658291,1],[1,0.986758839858,1],[1,0.990185326683,1],[1,0.990858366544,1],[1,0.992148212257,1],[1,0.992773694231,1],[1,0.99458371233,1],[1,0.995657173195,1],[1,0.997475478931,1],[1,0.998216059181,1],[1,0.999310611929,1],[1,0.999676004061,1],[1,0.99982973568,1]],"uClosed":false,"vClosed":false,"selfIntersect":false,"form":"unspecified"},
"sameSense": false,
"coedges": [{"edge":0,"orientation":"forward"},{"edge":1,"orientation":"forward"},{"edge":2,"orientation":"forward"},{"edge":3,"orientation":"forward"}]}`;
export const poleRowNear = (): BrepBuilder => oneFace(POLE_ROW_NEAR);

/** A face of one edge loop from JSON (as PLEAT_AT_EDGE, POLE_ROW_FAN): its part's uncertainty, vertices, edges,
 * surface, coedges.
 */
function oneFace(text: string): BrepBuilder {
  const j = JSON.parse(text);
  const b = new BrepBuilder({ uncertainty: j.uncertainty });
  const v = (j.vertices as number[][]).map((point) => b.addVertex({ point }));
  const e = (j.edges as { curve: Curve; start: number; end: number; sameSense: boolean; range?: [number, number] }[])
    .map((x) => b.addEdge({ curve: b.addCurve(x.curve), start: v[x.start]!, end: v[x.end]!, sameSense: x.sameSense,
      ...(x.range ? { range: x.range } : {}) }));
  sheet(b, b.addFace({ surface: b.addSurface(j.surface), sameSense: j.sameSense, loops: [{ kind: 'edge',
    bound: 'outer', sense: true, coedges: (j.coedges as { edge: number; orientation: 'forward' | 'reversed' }[])
      .map((c) => ({ edge: e[c.edge]!, orientation: c.orientation })) }] }));
  return b;
}

export const MODELS = { longBand, longSweep, torusOuterBand, longPlate, luneAcrossSeam: () => luneAcrossSeam(),
  luneHoleAcrossSeam: () => luneAcrossSeam(true), halfDisc, quarterDisc, capPcurve: () => cap(true), capRest: () => cap(false, true),
  capBelow: () => cap(false, false, true),
  kinkStrip: () => kinkStrip(), kinkStripV: () => kinkStrip(true), pleatStrip, thinTube,
  foldSidesApart, foldOneSide, foldStepFar, pleatAtEdge, poleRowFan, poleRowShort, poleRowNear,
  sectorWall: () => sectorWall(), sectorWallSpline: () => sectorWall(0.3, true), narrowArcStrip: () => narrowArcStrip(),
  pentagramLoop, mergedCornerStrip: () => mergedCornerStrip(),
  lanternBand5: () => lanternBand(0, 5), apexSector: () => apexSector(2.5),
  mergedCornerStripTop: () => mergedCornerStrip(1.5, true),
  offCornerApart: () => offCornerSquare([0.5, 0], [0.3, 0.3]),
  offCornerNear: () => offCornerSquare([0.1, 0.1], [0.1, 0.1]),
  offCornerMet: () => offCornerSquare([0.5, 0.5], [0.5, 0.5]),
  offCornerUneven: () => offCornerSquare([1, 0], [0.905, 0.03]), slitOffCorner,
  tangentHole: () => tangentHole(false, false), tangentHoleSplit: () => tangentHole(true, false),
  tangentHoleSplitPcurve: () => tangentHole(true, true), tangentHolePcurve: () => tangentHole(false, true),
  tangentHoleSplitPcurveOff: () => tangentHole(true, true, 5e-5),
  tangentHoleSplitPcurves: () => tangentHole(true, true, 0, true),
  luneTinyPoleEdge,
  cuspCrossing: cuspCrossing_, cuspCrossingMirrored, cuspCrossingTight, cuspCrossingTurned, cuspSeam: cuspSeam_,
  luneOnSeamPcurves, luneOnSeamPcurvesFar, luneOnSeamPcurvesShifted, luneSplitPcurves, luneSplitPcurvesDisagree,
  seamConeTurned, coneApexLoop: () => coneApexLoop(), coneApexLoopTurned: () => coneApexLoop(true),
  kinkStripQuadratic: () => kinkStrip(false, true), kinkStripRun: () => kinkStrip(false, false, 0.004, true),
  kinkStripRunShaped: () => kinkStrip(false, false, 0.004, true, 0, { along: 2, shear: 0.3, vary: true }),
  kinkStripRunShapedV: () => kinkStrip(true, false, 0.004, true, 0, { along: 2, shear: 0.3, vary: true }),
  rippleRun: () => kinkStrip(false, false, 0.004, true, 0.002), rippleRunV: () => kinkStrip(true, false, 0.004, true,
    0.002),
  affineFeetOff, plateHoles,
  bsplineApexHole, offPoleArcLoose, loopless, looplessBsplines, bsplineBall: () => bsplineBall(),
  bsplineBallNoisy: () => bsplineBall(3e-6), bsplineBallV: () => bsplineBall(0, true),
  bsplineBallNoisyV: () => bsplineBall(3e-6, true), wholeTorus, wholeSphereVertex,
  bsplineApex: () => bsplineApex(), poleHole, smallHole, sBend, cuspEdge: () => cuspEdge(), nearCusp6,
  bumpPatch: () => bumpPatch(), halfBump: () => bumpPatch(true),
  bumpPair: () => bumpPair(),
  sineSheet40: () => sineSheet(40), thinBand, tubeGapFaceTolerance, tubeGapUncertainty,
  tubeGapBySize, tubeGapOpen, torusOuterHalf, lanternBand: () => lanternBand(),
  lanternSliver: () => lanternBand(0.3), meridianHemisphereLoose, offPoleRest: () => offPoleRest(),
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
  edgeBulge: () => edgeFarOff(false, true), edgeBulgePcurve: () => edgeFarOff(true, true),
  edgeBulgeGrown: () => edgeFarOff(false, true, 0.6),
  roofBent: () => roof(0, 1, false, 2, 0, 0.004), roofNotch, thinRing, pcurveNear,
  clampedCorner: () => clampedCorner(),
  clampedCornerTight: () => clampedCorner(0.01), sideWobble: () => sideWobble(), lineWobble: () => sideWobble(0.9),
  bandTwoSlots, poleDip, poleDipFar: () => poleDipFar(), poleDipFarLoose: () => poleDipFar(2e-3, 0.01), lensPlane,
  cylinderVast: () => halfCylinder(0, 'none', 8000, 22600), cylinderLong: () => halfCylinder(0, 'none', 2, 4000),
  cornerFoldTight, pcurveShortHair, pcurveShortFar, pcurveShortStart, bsplineTubeTinyArc, bsplineDome,
  offPoleArc: () => offPoleArc(), offPcurves, bandHoleAtVertex, bandHoleOnCut, halfCap, meridianHemisphere, band: band_,
  bandByInversion, bore, nistBore, seamByInversion, seamPcurves, seamPcurvesShifted,
  torusWide, offVertex, pcurveOnly: () => pcurveOnly(),
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
    analysis: { model: new Uint32Array(8), uncertainty: [d.part.uncertainty?.[0] ?? NaN], measureRelTol: [NaN],
      measureProject: [0] } as never };
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
  // edgeBulgeGrown's arc (edge 0) grown past repair from 1e-5 to 0.6, the face with it.
  bulgeEdgePast: { model: 'edgeBulgeGrown', data: () => {
    const n = MODELS.edgeBulgeGrown().finish().edge.start.length;
    return analysisOf(MODELS.edgeBulgeGrown(), { edge: { toleranceError: [1, ...new Array(n - 1).fill(0)],
      givenTolerance: new Array(n).fill(1e-5) } });
  } },
  lunesVertexPast: { model: 'poleLunes', data: () => {
    const n = MODELS.poleLunes().finish().vertex.point.length / 3;
    return analysisOf(MODELS.poleLunes(), { vertex: { toleranceError: [1, ...new Array(n - 1).fill(0)],
      givenTolerance: new Array(n).fill(1e-5) } });
  } },
};
