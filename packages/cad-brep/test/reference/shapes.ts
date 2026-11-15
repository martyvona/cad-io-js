// The reference shapes: for each curve and surface kind a model with facts in closed form (points and derivatives,
// lengths, inversions, areas, volumes), each written in its own frame and built at every variant's similarity by the
// Maker. Volumes are signed: positive where the faces' normals point out of the material. B-spline versions of the
// circle, cylinder, sphere and torus are exact (rational quadratic arcs), so the free-form kinds have closed-form
// answers too. The swept surfaces (curveSwept, fixedReferenceSwept) aren't here: geometry.ts doesn't evaluate them,
// and their frames need Part 42's text to be stated exactly.

import { type Curve, type Surface } from '../../src/types.ts';
import {
  circleAngle, curveAt, multiplicities, type PatchPieces, type Pieces, surfaceAt, unitCircle, unitHalfCircle,
} from './bezier.ts';
import {
  compositeEv, coneEv, ellipseEv, extrusionEv, type Frame, frame, hyperbolaEv, lineEv, parabolaEv, parabolaLength,
  planeEv, polylineEv, revolutionEv, sphereEv, torusEv,
} from './forms.ts';
import { type CurveEval, type LocalCoedge, Maker, type SurfaceEval, type SurfaceRef } from './maker.ts';
import { cross, lin, mul, norm, sub, unit, type V } from './vec.ts';

export interface Shape {
  name: string;
  /** The shape's size in its own frame (its largest extent), for the absolute floors. */
  size: number;
  /** The part's uncertainty in the shape's frame. */
  uncertainty: number;
  make(m: Maker): void;
}

const PI = Math.PI, TAU = 2 * Math.PI;
const X: V = [1, 0, 0], Y: V = [0, 1, 0], Z: V = [0, 0, 1], O: V = [0, 0, 0];
const line2 = (point: V, direction: V, magnitude = 1): Curve => ({ kind: 'line', point, direction, magnitude });
const circle2 = (origin: V, radius: number): Curve => ({ kind: 'circle', position: { origin, xDir: [1, 0] },
  radius });

/** A tilted frame for loose curves: origin (1, 2, 3), axis (1, 2, 2) / 3, x (2, -1, 0) / sqrt 5. */
const TILT = frame([1, 2, 3], [1 / 3, 2 / 3, 2 / 3], unit([2, -1, 0]));
const placement = (F: Frame) => ({ origin: F.o, axis: F.z, xDir: F.x });

/** Throws where a closed form disagrees with a second one: the generator's own check of its facts. */
function same(a: V | number, b: V | number, what: string, tol = 1e-13) {
  const d = typeof a === 'number' ? Math.abs(a - (b as number)) : norm(sub(a, b as V));
  if (!(d <= tol * Math.max(1, typeof b === 'number' ? Math.abs(b) : norm(b)))) {
    throw new Error(`${what}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`);
  }
}

/** A piecewise Bezier B-spline as a curve row. */
const bsplineCurve = (b: Pieces, closed: boolean): Curve => ({ kind: 'bspline', degree: b.degree, knots: b.knots,
  multiplicities: multiplicities(b), poles: b.poles, weights: b.weights, closed, selfIntersect: false,
  form: 'unspecified' });

/** A circle of radius r about z through the origin, at height z, as rational Bezier pieces in 3D. */
const nurbsCircle = (r: number, z = 0): Pieces => {
  const c = unitCircle();
  return { ...c, poles: c.poles.map((p) => [r * p[0]!, r * p[1]!, z]) };
};

const bsplineSurface = (b: PatchPieces, uClosed: boolean, vClosed: boolean): Surface => ({ kind: 'bspline',
  uDegree: b.uDegree, vDegree: b.vDegree, uKnots: b.uKnots, vKnots: b.vKnots,
  uMultiplicities: multiplicities({ degree: b.uDegree, knots: b.uKnots, poles: [], weights: [] }),
  vMultiplicities: multiplicities({ degree: b.vDegree, knots: b.vKnots, poles: [], weights: [] }),
  poles: b.poles, weights: b.weights, uClosed, vClosed, selfIntersect: false, form: 'unspecified' });

/** A line row from a to b, t in [0, 1], with its facts (points at 0, 1/2, 1, its length). */
function segment(m: Maker, a: V, b: V): number {
  const d = sub(b, a), L = norm(d), u = unit(d);
  const row = m.curve({ kind: 'line', point: a, direction: u, magnitude: L });
  m.curvePoints(row, lineEv(a, u, L), [0, 0.5, 1]);
  m.curveLength(row, 0, 1, L);
  return row;
}

/** A face on its own (natural bounds) as a solid's one closed shell. */
function naturalSolid(m: Maker, on: SurfaceRef, area: number, volume: number) {
  const f = m.face(on, true, []);
  m.faceArea(f, area);
  m.volume(m.body({ kind: 'solid', members: [{ ref: m.shell({ kind: 'closed', faces: [{ face: f }] }) }] }), volume);
}

/** A box from the origin to (1, 2, 3): 6 planes, 12 line edges with ranges, loops counter-clockwise from outside. */
const box: Shape = {
  name: 'box', size: 3, uncertainty: 1e-6,
  make(m) {
    const size = [1, 2, 3];
    const corner = (k: number): V => [k & 1 ? size[0]! : 0, k & 2 ? size[1]! : 0, k & 4 ? size[2]! : 0];
    const vs = Array.from({ length: 8 }, (_, k) => m.vertex(corner(k)));
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    const edges = new Map<string, { edge: number; from: number }>();
    for (const q of quads) for (let j = 0; j < 4; j++) {
      const a = q[j]!, c = q[(j + 1) % 4]!, key = `${Math.min(a, c)},${Math.max(a, c)}`;
      if (edges.has(key)) continue;
      const curve = segment(m, corner(a), corner(c));
      edges.set(key, { edge: m.edge({ curve, start: vs[a]!, end: vs[c]!, sameSense: true, range: [0, 1] }),
        from: a });
      if (edges.size === 1) {
        // A point off the first edge's line, beside its middle: t 1/2, at distance 0.25.
        const p = lin([0.5, corner(a)], [0.5, corner(c)], [0.25, Z]);
        m.curveInverse(curve, p, 0.5, 0.25, 'unique');
      }
    }
    const faces = quads.map((q) => {
      const p0 = corner(q[0]!), x = unit(sub(corner(q[1]!), p0)), n = unit(cross(x, sub(corner(q[3]!), p0)));
      const F = frame(p0, n, x), plane = m.surface({ kind: 'plane', position: { origin: p0, axis: n, xDir: x } });
      const ev = planeEv(F);
      m.surfacePoints(plane, ev, [[0, 0], [0.25, 0.5], [1, 1]]);
      // A point 0.5 outside the face, over (0.25, 0.5).
      m.surfaceInverse(plane, lin([1, ev(0.25, 0.5).p], [0.5, n]), [0.25, 0.5], 0.5, 'unique');
      const coedges: LocalCoedge[] = q.map((a, j) => {
        const c = q[(j + 1) % 4]!, e = edges.get(`${Math.min(a, c)},${Math.max(a, c)}`)!;
        return { edge: e.edge, orientation: e.from === a ? 'forward' : 'reversed' };
      });
      const f = m.face(plane, true, [{ kind: 'edge', bound: 'outer', coedges }]);
      const side = (k: number) => norm(sub(corner(q[k]!), p0));
      m.faceArea(f, side(1) * side(3));
      return f;
    });
    const shell = m.shell({ kind: 'closed', faces: faces.map((face) => ({ face })) });
    m.volume(m.body({ kind: 'solid', members: [{ ref: shell }] }), size[0]! * size[1]! * size[2]!);
  },
};

/**
 * A solid of a side on a surface closed in u and two planar disks: the side's seam line from (r1, 0, 0) to (r2, 0,
 * h) used forward at u = uEnd and reversed at u = 0, the circles' p-curves on the side the lines v = 0 and v = vTop
 * (u = t), the seam's v = vTop t; on the disks the p-curves `disk` gives (in the planes' (x, y)). The bottom disk is on
 * a plane facing +z used with its sense false (the face's normal -z), the top one with it true.
 */
function seamedSolid(m: Maker, o: { side: SurfaceRef; bottom: number; top: number; r1: number; r2: number;
  h: number; vTop: number; uEnd: number; disk: (on: SurfaceRef, r: number) => { row: number; ev: CurveEval } }) {
  const { side, bottom, top, r1, r2, h, vTop, uEnd } = o;
  const v0 = m.vertex([r1, 0, 0]), v1 = m.vertex([r2, 0, h]);
  const seam = segment(m, [r1, 0, 0], [r2, 0, h]);
  const eB = m.edge({ curve: bottom, start: v0, end: v0, sameSense: true, range: [0, uEnd] });
  const eT = m.edge({ curve: top, start: v1, end: v1, sameSense: true, range: [0, uEnd] });
  const eS = m.edge({ curve: seam, start: v0, end: v1, sameSense: true, range: [0, 1] });
  const pB = m.pcurve(line2([0, 0], [1, 0]), side), pT = m.pcurve(line2([0, vTop], [1, 0]), side);
  const pS1 = m.pcurve(line2([uEnd, 0], [0, 1], vTop), side), pS0 = m.pcurve(line2([0, 0], [0, 1], vTop), side);
  m.pcurvePoints(pB, lineEv([0, 0], [1, 0], 1), [0, 1]);
  m.pcurvePoints(pS1, lineEv([uEnd, 0], [0, 1], vTop), [0, 0.5, 1]);
  // Around the side as an outer bound runs in (u, v): along the bottom, up the seam at uEnd, back along the top,
  // down the seam at 0.
  const sideFace = m.face(side, true, [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: eB, orientation: 'forward', pcurve: pB, range: [0, uEnd] },
    { edge: eS, orientation: 'forward', pcurve: pS1, range: [0, 1] },
    { edge: eT, orientation: 'reversed', pcurve: pT, range: [0, uEnd] },
    { edge: eS, orientation: 'reversed', pcurve: pS0, range: [0, 1] },
  ] }]);
  const planeB = m.surface({ kind: 'plane', position: { origin: O, axis: Z, xDir: X } });
  const planeT = m.surface({ kind: 'plane', position: { origin: [0, 0, h], axis: Z, xDir: X } });
  m.surfacePoints(planeT, planeEv(frame([0, 0, h], Z, X)), [[0.5, -0.25]]);
  const cB = o.disk(planeB, r1), cT = o.disk(planeT, r2);
  m.pcurvePoints(cB.row, cB.ev, [0, 0.3 * uEnd]);
  const fB = m.face(planeB, false, [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: eB, orientation: 'reversed', pcurve: cB.row, range: [0, uEnd] }] }]);
  const fT = m.face(planeT, true, [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: eT, orientation: 'forward', pcurve: cT.row, range: [0, uEnd] }] }]);
  m.faceArea(fB, PI * r1 * r1);
  m.faceArea(fT, PI * r2 * r2);
  const shell = m.shell({ kind: 'closed', faces: [sideFace, fB, fT].map((face) => ({ face })) });
  return { sideFace, body: m.body({ kind: 'solid', members: [{ ref: shell }] }) };
}

/** 2D circles of radius r about the plane's origin, as the disks' p-curves. */
const circleDisk = (m: Maker) => (on: SurfaceRef, r: number) => ({ row: m.pcurve(circle2([0, 0], r), on),
  ev: ellipseEv([0, 0], [1, 0], [0, 1], r, r) });

/** The circle of radius r about z at height z, as a row, with its facts. */
function zCircle(m: Maker, r: number, z: number, facts: boolean): number {
  const F = frame([0, 0, z], Z, X), row = m.curve({ kind: 'circle', position: placement(F), radius: r });
  if (facts) {
    const ev = ellipseEv(F.o, F.x, F.y, r, r);
    m.curvePoints(row, ev, [0, 1, PI, 5]);
    m.curveLength(row, 0, TAU, TAU * r);
    m.curveLength(row, 0, 1, r);
    // On the circle at angle 2; at its seam (one foot, at both ends of the period); outside it by 0.5 at angle 4.
    m.curveInverse(row, ev(2).p, 2, 0, 'unique');
    m.curveInverse(row, ev(0).p, 0, 0, 'unique', [], true);
    m.curveInverse(row, lin([1, F.o], [(r + 0.5) / r, sub(ev(4).p, F.o)]), 4, 0.5, 'unique');
  }
  return row;
}

/** A cylinder r 2, h 5, as a solid: the side with its seam and two disks. */
const cylinder: Shape = {
  name: 'cylinder', size: 5, uncertainty: 1e-6,
  make(m) {
    const r = 2, h = 5, F = frame(O, Z, X);
    const bottom = zCircle(m, r, 0, true), top = zCircle(m, r, h, false);
    const side = m.surface({ kind: 'cylinder', position: placement(F), radius: r }, { u: TAU });
    const ev = coneEv(F, r, 0);
    m.surfacePoints(side, ev, [[0, 0], [1, 2.5], [PI, h], [5.5, 0.3]]);
    m.surfaceInverse(side, ev(2, 1).p, [2, 1], 0, 'unique');
    m.surfaceInverse(side, ev(0, 3).p, [0, 3], 0, 'unique', { onSeamU: true });
    m.surfaceInverse(side, lin([1, ev(4, 2).p], [0.75, unit(sub(ev(4, 2).p, [0, 0, 2]))]), [4, 2], 0.75, 'unique');
    const s = seamedSolid(m, { side, bottom, top, r1: r, r2: r, h, vTop: h, uEnd: TAU, disk: circleDisk(m) });
    m.faceArea(s.sideFace, TAU * r * h);
    m.volume(s.body, PI * r * r * h);
  },
};

/** A cone frustum: radius 1 at z = 0, semi-angle pi / 6, height 3, its apex below at v = -1 / tan(pi / 6). */
const cone: Shape = {
  name: 'cone', size: 3, uncertainty: 1e-6,
  make(m) {
    const r1 = 1, a = PI / 6, k = Math.tan(a), h = 3, r2 = r1 + h * k, F = frame(O, Z, X);
    const bottom = zCircle(m, r1, 0, false), top = zCircle(m, r2, h, true);
    const side = m.surface({ kind: 'cone', position: placement(F), radius: r1, semiAngle: a }, { u: TAU });
    const ev = coneEv(F, r1, k);
    m.surfacePoints(side, ev, [[0, 0], [1, 1.5], [PI, h], [4, -0.5]]);
    m.surfaceInverse(side, ev(2, 1).p, [2, 1], 0, 'unique');
    m.surfaceInverse(side, ev(0, 2).p, [0, 2], 0, 'unique', { onSeamU: true });
    const q = ev(3, 1), n = unit(cross(q.du, q.dv));
    m.surfaceInverse(side, lin([1, q.p], [0.25, n]), [3, 1], 0.25, 'unique');
    const s = seamedSolid(m, { side, bottom, top, r1, r2, h, vTop: h, uEnd: TAU, disk: circleDisk(m) });
    // The lateral area pi (r1 + r2) times the slant height; the frustum's volume.
    m.faceArea(s.sideFace, PI * (r1 + r2) * Math.hypot(h, r2 - r1));
    m.volume(s.body, PI * h * (r1 * r1 + r1 * r2 + r2 * r2) / 3);
  },
};

/**
 * A sphere of radius 2 as a solid of two hemispheres sharing the equator, each bounded by it and a vertex loop at its
 * pole; and a whole sphere of radius 1 about (6, 0, 0), a face bounded by nothing, as a second solid.
 */
const sphere: Shape = {
  name: 'sphere', size: 8, uncertainty: 1e-6,
  make(m) {
    const R = 2, F = frame(O, Z, X), ev = sphereEv(F, R);
    const eq = zCircle(m, R, 0, false);
    const v = m.vertex([R, 0, 0]), north = m.vertex([0, 0, R]), south = m.vertex([0, 0, -R]);
    const e = m.edge({ curve: eq, start: v, end: v, sameSense: true, range: [0, TAU] });
    const S = m.surface({ kind: 'sphere', position: placement(F), radius: R }, { u: TAU });
    m.surfacePoints(S, ev, [[0, 0], [1, 0.5], [2, -1], [3, PI / 2], [0.5, -PI / 2]]);
    m.surfaceInverse(S, ev(1, 0.5).p, [1, 0.5], 0, 'unique');
    m.surfaceInverse(S, ev(0, -0.7).p, [0, -0.7], 0, 'unique', { onSeamU: true });
    m.surfaceInverse(S, [0, 0, R], [0, PI / 2], 0, 'unique', { atSingularity: true });
    m.surfaceInverse(S, mul(ev(4, 0.3).p, 1.5), [4, 0.3], R / 2, 'unique');
    // The equator's p-curve on both: the line v = 0, u = t.
    const pc = m.pcurve(line2([0, 0], [1, 0]), S);
    const up = m.face(S, true, [
      { kind: 'edge', bound: 'outer', coedges: [{ edge: e, orientation: 'forward', pcurve: pc, range: [0, TAU] }] },
      { kind: 'vertex', bound: 'inner', vertex: north }]);
    const down = m.face(S, true, [
      { kind: 'edge', bound: 'outer', coedges: [{ edge: e, orientation: 'reversed', pcurve: pc, range: [0, TAU] }] },
      { kind: 'vertex', bound: 'inner', vertex: south }]);
    m.faceArea(up, TAU * R * R);
    m.faceArea(down, TAU * R * R);
    const shell = m.shell({ kind: 'closed', faces: [{ face: up }, { face: down }] });
    m.volume(m.body({ kind: 'solid', members: [{ ref: shell }] }), 4 / 3 * PI * R ** 3);
    const F1 = frame([6, 0, 0], Z, X), whole = m.surface({ kind: 'sphere', position: placement(F1), radius: 1 },
      { u: TAU });
    m.surfacePoints(whole, sphereEv(F1, 1), [[2.5, 0.25]]);
    naturalSolid(m, whole, 4 * PI, 4 / 3 * PI);
  },
};

/** A torus, major radius 3, minor 1, bounded by nothing, as a solid. */
const torus: Shape = {
  name: 'torus', size: 8, uncertainty: 1e-6,
  make(m) {
    const R = 3, r = 1, F = frame(O, Z, X), ev = torusEv(F, R, r);
    const S = m.surface({ kind: 'torus', position: placement(F), majorRadius: R, minorRadius: r }, { u: TAU, v: TAU });
    m.surfacePoints(S, ev, [[0, 0], [1, 2], [PI, PI], [5, 4.5]]);
    m.surfaceInverse(S, ev(1, 2).p, [1, 2], 0, 'unique');
    m.surfaceInverse(S, ev(0, 0).p, [0, 0], 0, 'unique', { onSeamU: true, onSeamV: true });
    m.surfaceInverse(S, ev(2, 0).p, [2, 0], 0, 'unique', { onSeamV: true });
    const q = ev(4, 1), n = unit(cross(q.du, q.dv));
    m.surfaceInverse(S, lin([1, q.p], [0.5, n]), [4, 1], 0.5, 'unique');
    naturalSolid(m, S, 4 * PI * PI * R * r, 2 * PI * PI * R * r * r);
  },
};

/**
 * Loose curves in a tilted frame: an ellipse, a hyperbola, two parabolas (f > 0 and f < 0), a polyline, a circle
 * trimmed both ways, a composite of a trimmed line and a reversed trimmed arc, and a 3D offset of a circle (its
 * reference direction the circle's axis: the circle of radius r + d).
 */
const curves: Shape = {
  name: 'curves', size: 6, uncertainty: 1e-6,
  make(m) {
    const F = TILT, P = placement(F), item = (row: number) => m.b.addItem({ kind: 'curve', ref: row });
    const el = m.curve({ kind: 'ellipse', position: P, semiAxis1: 3, semiAxis2: 1.5 });
    const elEv = ellipseEv(F.o, F.x, F.y, 3, 1.5);
    m.curvePoints(el, elEv, [0, 0.7, 2, 4]);
    m.curveInverse(el, elEv(0.7).p, 0.7, 0, 'unique');
    const hy = m.curve({ kind: 'hyperbola', position: P, semiAxis: 1, semiImagAxis: 2 });
    const hyEv = hyperbolaEv(F.o, F.x, F.y, 1, 2);
    m.curvePoints(hy, hyEv, [-1, 0, 0.5]);
    m.curveInverse(hy, hyEv(0.5).p, 0.5, 0, 'unique');
    for (const f of [0.75, -0.5]) {
      const pa = m.curve({ kind: 'parabola', position: P, focalDist: f }), paEv = parabolaEv(F.o, F.x, F.y, f);
      m.curvePoints(pa, paEv, [-1, 0, 2]);
      m.curveLength(pa, -1, 2, parabolaLength(f, -1, 2));
      m.curveInverse(pa, paEv(2).p, 2, 0, 'unique');
      item(pa);
    }
    const pts: V[] = [[0, 0, 0], [1, 0, 0], [1, 2, 0], [1, 2, 3]];
    const pl = m.curve({ kind: 'polyline', points: pts });
    m.curvePoints(pl, polylineEv(pts), [0, 0.5, 1.5, 2.25, 3]);
    m.curveLength(pl, 0, 3, 6);
    m.curveLength(pl, 0.5, 2.5, 4);
    // Beside the middle segment, nearer it than any other: t 1.5, distance 0.5.
    m.curveInverse(pl, [1.5, 1, 0], 1.5, 0.5, 'unique');
    const ci = m.curve({ kind: 'circle', position: P, radius: 2 }), ciEv = ellipseEv(F.o, F.x, F.y, 2, 2);
    const tr = m.curve({ kind: 'trimmed', basis: ci, trim1: { parameter: 1 }, trim2: { parameter: 2.5 },
      sense: true, preference: 'parameter' });
    m.curvePoints(tr, ciEv, [1, 1.75, 2.5]);
    m.curveLength(tr, 1, 2.5, 3);
    // Against the circle: from 1 back round to 2.5, the range [2.5 - 2 pi, 1].
    const tb = m.curve({ kind: 'trimmed', basis: ci, trim1: { parameter: 1 }, trim2: { parameter: 2.5 },
      sense: false, preference: 'parameter' });
    m.curvePoints(tb, ciEv, [0, -1, 1]);
    m.curveLength(tb, 2.5 - TAU, 1, 2 * (TAU - 1.5));
    const ln = m.curve({ kind: 'line', point: F.o, direction: F.z, magnitude: 1 });
    const tl = m.curve({ kind: 'trimmed', basis: ln, trim1: { parameter: 0 }, trim2: { parameter: 2 }, sense: true,
      preference: 'parameter' });
    const co = m.curve({ kind: 'composite', segments: [{ curve: tl, sameSense: true, transition: 'discontinuous' },
      { curve: tr, sameSense: false, transition: 'discontinuous' }], selfIntersect: false });
    m.curvePoints(co, compositeEv([{ ev: lineEv(F.o, F.z, 1), a: 0, b: 2, sameSense: true },
      { ev: ciEv, a: 1, b: 2.5, sameSense: false }]), [0.5, 1.25, 1.9]);
    m.curveLength(co, 0, 2, 5);
    const of = m.curve({ kind: 'offset', basis: ci, distance: 0.5, selfIntersect: false, refDirection: F.z });
    const ofEv = ellipseEv(F.o, F.x, F.y, 2.5, 2.5);
    m.curvePoints(of, ofEv, [0, 1]);
    m.curveLength(of, 0, TAU, 5 * PI);
    for (const row of [el, hy, pl, tr, tb, co, of]) item(row);
  },
};

/**
 * The exact rational B-spline circle (four quarter arcs, knots 0, 1/4, 1/2, 3/4, 1) of radius 3 in the tilted frame,
 * a loose curve: at knot k / 4 at angle k pi / 2, at a span's middle at the middle angle.
 */
const bsplineCircle: Shape = {
  name: 'bsplineCircle', size: 6, uncertainty: 1e-6,
  make(m) {
    const r = 3, F = TILT, c = unitCircle();
    const b: Pieces = { ...c, poles: c.poles.map((p) => lin([1, F.o], [r * p[0]!, F.x], [r * p[1]!, F.y])) };
    const row = m.curve(bsplineCurve(b, true));
    const ev: CurveEval = (t) => curveAt(b, t);
    for (const t of [0, 0.125, 0.25, 0.3, 0.5, 0.9, 1]) {
      const a = circleAngle(t);
      same(ev(t).p, lin([1, F.o], [r * Math.cos(a), F.x], [r * Math.sin(a), F.y]), `circle at ${t}`);
    }
    same(circleAngle(0.125), PI / 4, 'middle angle');
    m.curvePoints(row, ev, [0, 0.125, 0.25, 0.3, 0.5, 0.9, 1]);
    m.curveLength(row, 0, 0.25, PI * r / 2);
    m.curveLength(row, 0, 1, TAU * r);
    m.curveLength(row, 0.25, 0.625, PI * r * 3 / 4);
    m.curveInverse(row, ev(0.25).p, 0.25, 0, 'unique');
    // Where it closes: one foot at t 0 and 1 (closed in fact, not periodic: its range is [0, 1]).
    m.curveInverse(row, ev(0).p, 0, 0, 'unique', [], true);
    // Outside, on the ray through the point at 0.3: the same t, distance 1.
    m.curveInverse(row, lin([1, F.o], [(r + 1) / r, sub(ev(0.3).p, F.o)]), 0.3, 1, 'unique');
    m.b.addItem({ kind: 'curve', ref: row });
  },
};

/**
 * The cylinder r 2, h 5 with its side a rational B-spline (the circle's poles at z = 0 and h, degree 1 in v over
 * [0, 1]), its circles B-splines too, the disks' p-curves the circle as a 2D B-spline.
 */
const bsplineCylinder: Shape = {
  name: 'bsplineCylinder', size: 5, uncertainty: 1e-6,
  make(m) {
    const r = 2, h = 5, c0 = nurbsCircle(r), c1 = nurbsCircle(r, h);
    const side: PatchPieces = { uDegree: 2, vDegree: 1, uKnots: c0.knots, vKnots: [0, 1],
      poles: c0.poles.map((p, i) => [p, c1.poles[i]!]), weights: c0.weights.map((w) => [w, w]) };
    const bottom = m.curve(bsplineCurve(c0, true)), top = m.curve(bsplineCurve(c1, true));
    m.curvePoints(bottom, (t) => curveAt(c0, t), [0, 0.125, 0.6]);
    m.curveLength(bottom, 0, 1, TAU * r);
    const S = m.surface(bsplineSurface(side, true, false));
    const ev: SurfaceEval = (u, v) => surfaceAt(side, u, v);
    for (const [u, v] of [[0.3, 0.4], [0.125, 1]] as [number, number][]) {
      const a = circleAngle(u);
      same(ev(u, v).p, [r * Math.cos(a), r * Math.sin(a), h * v], `cylinder at ${u}, ${v}`);
    }
    m.surfacePoints(S, ev, [[0, 0], [0.125, 0.5], [0.3, 0.4], [0.75, 1], [1, 0.2]]);
    m.surfaceInverse(S, ev(0.3, 0.4).p, [0.3, 0.4], 0, 'unique');
    const unitC = unitCircle();
    const disk = (on: SurfaceRef, rr: number) => {
      const b: Pieces = { ...unitC, poles: unitC.poles.map((p) => [rr * p[0]!, rr * p[1]!]) };
      return { row: m.pcurve(bsplineCurve(b, true), on), ev: (t: number) => curveAt(b, t) };
    };
    const s = seamedSolid(m, { side: S, bottom, top, r1: r, r2: r, h, vTop: 1, uEnd: 1, disk });
    m.faceArea(s.sideFace, TAU * r * h);
    m.volume(s.body, PI * r * r * h);
  },
};

/** The exact rational B-spline sphere of radius 2 (circle by half circle, poles collapsed at v = 0 and 1), whole. */
const bsplineSphere: Shape = {
  name: 'bsplineSphere', size: 4, uncertainty: 1e-6,
  make(m) {
    const R = 2, c = unitCircle(), hc = unitHalfCircle();
    const b: PatchPieces = { uDegree: 2, vDegree: 2, uKnots: c.knots, vKnots: hc.knots,
      poles: c.poles.map((p) => hc.poles.map((q) => [R * q[0]! * p[0]!, R * q[0]! * p[1]!, R * q[1]!])),
      weights: c.weights.map((w) => hc.weights.map((x) => w * x)) };
    const S = m.surface(bsplineSurface(b, true, false));
    const ev: SurfaceEval = (u, v) => surfaceAt(b, u, v);
    for (const [u, v] of [[0.3, 0.6], [0.125, 0.25]] as [number, number][]) {
      const a = circleAngle(u), l = circleAngle(v, 2) - PI / 2;
      same(ev(u, v).p, [R * Math.cos(l) * Math.cos(a), R * Math.cos(l) * Math.sin(a), R * Math.sin(l)],
        `sphere at ${u}, ${v}`);
    }
    m.surfacePoints(S, ev, [[0, 0.5], [0.125, 0.25], [0.3, 0.6], [0.6, 0], [0.2, 1]]);
    m.surfaceInverse(S, ev(0.3, 0.6).p, [0.3, 0.6], 0, 'unique');
    m.surfaceInverse(S, [0, 0, R], [0, 1], 0, 'unique', { atSingularity: true });
    naturalSolid(m, S, 4 * PI * R * R, 4 / 3 * PI * R ** 3);
  },
};

/** The exact rational B-spline torus, major radius 3, minor 1 (circle by circle), whole. */
const bsplineTorus: Shape = {
  name: 'bsplineTorus', size: 8, uncertainty: 1e-6,
  make(m) {
    const R = 3, r = 1, c = unitCircle();
    const b: PatchPieces = { uDegree: 2, vDegree: 2, uKnots: c.knots, vKnots: c.knots,
      poles: c.poles.map((p) => c.poles.map((q) => [(R + r * q[0]!) * p[0]!, (R + r * q[0]!) * p[1]!, r * q[1]!])),
      weights: c.weights.map((w) => c.weights.map((x) => w * x)) };
    const S = m.surface(bsplineSurface(b, true, true));
    const ev: SurfaceEval = (u, v) => surfaceAt(b, u, v);
    for (const [u, v] of [[0.3, 0.6], [0.125, 0.875]] as [number, number][]) {
      const a = circleAngle(u), l = circleAngle(v);
      same(ev(u, v).p, [(R + r * Math.cos(l)) * Math.cos(a), (R + r * Math.cos(l)) * Math.sin(a), r * Math.sin(l)],
        `torus at ${u}, ${v}`);
    }
    m.surfacePoints(S, ev, [[0, 0], [0.125, 0.875], [0.3, 0.6], [0.5, 0.5], [1, 1]]);
    m.surfaceInverse(S, ev(0.3, 0.6).p, [0.3, 0.6], 0, 'unique');
    naturalSolid(m, S, 4 * PI * PI * R * r, 2 * PI * PI * R * r * r);
  },
};

/** The cylinder r 2, h 5 with its side the extrusion of its bottom circle along z, magnitude 5 (v in [0, 1]). */
const extrusion: Shape = {
  name: 'extrusion', size: 5, uncertainty: 1e-6,
  make(m) {
    const r = 2, h = 5, F = frame(O, Z, X);
    const bottom = zCircle(m, r, 0, false), top = zCircle(m, r, h, false);
    const S = m.surface({ kind: 'extrusion', curve: bottom, direction: Z, magnitude: h }, { u: TAU });
    const ev = extrusionEv(ellipseEv(F.o, F.x, F.y, r, r), Z, h);
    m.surfacePoints(S, ev, [[0, 0], [1, 0.5], [4, 1], [6, -0.25]]);
    m.surfaceInverse(S, ev(1, 0.5).p, [1, 0.5], 0, 'unique');
    const s = seamedSolid(m, { side: S, bottom, top, r1: r, r2: r, h, vTop: 1, uEnd: TAU, disk: circleDisk(m) });
    m.faceArea(s.sideFace, TAU * r * h);
    m.volume(s.body, PI * r * r * h);
  },
};

/**
 * A torus as a revolution: the circle of radius 1 about (3, 0, 0) in the xz plane, C(t) = (3 + cos t, 0, sin t),
 * turned about z through the origin (u the angle, v the circle's parameter), bounded by nothing, as a solid.
 */
const revolution: Shape = {
  name: 'revolution', size: 8, uncertainty: 1e-6,
  make(m) {
    const R = 3, r = 1, F = frame([R, 0, 0], [0, -1, 0], X);
    const profile = m.curve({ kind: 'circle', position: placement(F), radius: r });
    const pEv = ellipseEv(F.o, F.x, F.y, r, r);
    same(F.y, Z, 'the profile\'s y');
    const S = m.surface({ kind: 'revolution', curve: profile, axisOrigin: O, axisDirection: Z }, { u: TAU });
    const ev = revolutionEv(pEv, O, Z);
    same(ev(1, 2).p, torusEv(frame(O, Z, X), R, r)(1, 2).p, 'revolution as torus');
    m.surfacePoints(S, ev, [[0, 0], [1, 2], [PI, PI], [5, 4.5]]);
    m.surfaceInverse(S, ev(1, 2).p, [1, 2], 0, 'unique');
    naturalSolid(m, S, 4 * PI * PI * R * r, 2 * PI * PI * R * r * r);
  },
};

/** The offset by 0.5 of a sphere of radius 2 (the sphere of radius 2.5), bounded by nothing, as a solid. */
const offset: Shape = {
  name: 'offset', size: 5, uncertainty: 1e-6,
  make(m) {
    const R = 2, d = 0.5, F = frame(O, Z, X);
    const basis = m.surface({ kind: 'sphere', position: placement(F), radius: R }, { u: TAU });
    const S = m.surface({ kind: 'offset', basis: basis.row, distance: d, selfIntersect: false }, { u: TAU });
    const ev = sphereEv(F, R + d);
    m.surfacePoints(S, ev, [[0, 0], [1, 0.5], [4, -1]]);
    m.surfaceInverse(S, ev(1, 0.5).p, [1, 0.5], 0, 'unique');
    naturalSolid(m, S, 4 * PI * (R + d) ** 2, 4 / 3 * PI * (R + d) ** 3);
  },
};

/** A rectangular trim of a cylinder r 2: u in [0.5, 2], v in [-1, 3], a face bounded by its rectangle, a sheet. */
const trimmedSurface: Shape = {
  name: 'trimmedSurface', size: 4, uncertainty: 1e-6,
  make(m) {
    const r = 2, F = frame(O, Z, X);
    const basis = m.surface({ kind: 'cylinder', position: placement(F), radius: r }, { u: TAU });
    const S = m.surface({ kind: 'rectangularTrimmed', basis: basis.row, u1: 0.5, u2: 2, v1: -1, v2: 3, uSense: true,
      vSense: true });
    m.surfacePoints(S, coneEv(F, r, 0), [[0.5, -1], [1, 0], [2, 3]]);
    const f = m.face(S, true, []);
    m.faceArea(f, r * 1.5 * 4);
    m.body({ kind: 'sheet', members: [{ ref: m.shell({ kind: 'open', faces: [{ face: f }] }) }] });
  },
};

export const SHAPES: Shape[] = [box, cylinder, cone, sphere, torus, curves, bsplineCircle, bsplineCylinder,
  bsplineSphere, bsplineTorus, extrusion, revolution, offset, trimmedSurface];
