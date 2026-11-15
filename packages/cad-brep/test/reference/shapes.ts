// The reference shapes: for each curve and surface kind a model with facts in closed form (points and derivatives,
// lengths, inversions, areas, volumes), each written in its own frame and built at every variant's similarity by the
// Maker. Volumes are signed: positive where the faces' normals point out of the material.

import { type Curve } from '../../src/types.ts';
import { curveAt, multiplicities, surfaceAt, unitCircle, type Pieces } from './bezier.ts';
import {
  coneEv, ellipseEv, frame, lineEv, planeEv, sphereEv, torusEv,
} from './forms.ts';
import { type CurveEval, type LocalCoedge, Maker, type SurfaceRef } from './maker.ts';
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

/** A line row from a to b, t in [0, 1], with its facts (points at 0, 1/2, 1, its length). */
function segment(m: Maker, a: V, b: V): number {
  const d = sub(b, a), L = norm(d), u = unit(d);
  const row = m.curve({ kind: 'line', point: a, direction: u, magnitude: L });
  m.curvePoints(row, lineEv(a, u, L), [0, 0.5, 1]);
  m.curveLength(row, 0, 1, L);
  return row;
}

/** A box from the origin to (a, b, c): 6 planes, 12 line edges with ranges, loops counter-clockwise from outside. */
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
 * A solid with a side on a seamed surface and two planar disks: the side's seam line from (r1, 0, 0) to (r2, 0, h)
 * used forward at u = 2 pi and reversed at u = 0, the circles' p-curves on the side the lines v = 0 and v = h, on the
 * disks 2D circles. The bottom disk on a plane facing +z used with its sense false, the top one with it true.
 */
function seamedSolid(m: Maker, side: SurfaceRef, sideSense: boolean, bottom: number, top: number, r1: number,
  r2: number, h: number, pu: (t: number) => number, uPeriod: number) {
  const v0 = m.vertex([r1, 0, 0]), v1 = m.vertex([r2, 0, h]);
  const seam = segment(m, [r1, 0, 0], [r2, 0, h]);
  const eB = m.edge({ curve: bottom, start: v0, end: v0, sameSense: true, range: [0, uPeriod] });
  const eT = m.edge({ curve: top, start: v1, end: v1, sameSense: true, range: [0, uPeriod] });
  const eS = m.edge({ curve: seam, start: v0, end: v1, sameSense: true, range: [0, 1] });
  // P-curves on the side, in its local (u, v): the circles at v = 0 and v = h along u = pu(t), the seam's two uses.
  void pu;
  const pB = m.pcurve(line2([0, 0], [1, 0]), side), pT = m.pcurve(line2([0, h], [1, 0]), side);
  const pS1 = m.pcurve(line2([uPeriod, 0], [0, 1], h), side), pS0 = m.pcurve(line2([0, 0], [0, 1], h), side);
  m.pcurvePoints(pB, lineEv([0, 0], [1, 0], 1), [0, 1]);
  m.pcurvePoints(pS1, lineEv([uPeriod, 0], [0, 1], h), [0, 0.5, 1]);
  const sideFace = m.face(side, sideSense, [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: eB, orientation: 'forward', pcurve: pB, range: [0, uPeriod] },
    { edge: eS, orientation: 'forward', pcurve: pS1, range: [0, 1] },
    { edge: eT, orientation: 'reversed', pcurve: pT, range: [0, uPeriod] },
    { edge: eS, orientation: 'reversed', pcurve: pS0, range: [0, 1] },
  ] }]);
  const planeB = m.surface({ kind: 'plane', position: { origin: O, axis: Z, xDir: X } });
  const planeT = m.surface({ kind: 'plane', position: { origin: [0, 0, h], axis: Z, xDir: X } });
  m.surfacePoints(planeT, planeEv(frame([0, 0, h], Z, X)), [[0.5, -0.25]]);
  return { eB, eT, sideFace, planeB, planeT };
}

/** A cylinder r 2, h 5, as a solid: the side with its seam and two disks. */
const cylinder: Shape = {
  name: 'cylinder', size: 5, uncertainty: 1e-6,
  make(m) {
    const r = 2, h = 5;
    const F0 = frame(O, Z, X), Fh = frame([0, 0, h], Z, X);
    const bottom = m.curve({ kind: 'circle', position: { origin: O, axis: Z, xDir: X }, radius: r });
    const top = m.curve({ kind: 'circle', position: { origin: [0, 0, h], axis: Z, xDir: X }, radius: r });
    const evB = ellipseEv(F0.o, F0.x, F0.y, r, r);
    m.curvePoints(bottom, evB, [0, 1, PI, 5]);
    m.curvePoints(top, ellipseEv(Fh.o, Fh.x, Fh.y, r, r), [0.5]);
    m.curveLength(bottom, 0, TAU, TAU * r);
    m.curveLength(bottom, 0, 1, r);
    // On the circle at angle 2 (unique); at its seam (both ends of the period); outside it by 0.5 at angle 4.
    m.curveInverse(bottom, evB(2).p, 2, 0, 'unique');
    m.curveInverse(bottom, evB(0).p, 0, 0, 'ambiguous', [TAU]);
    m.curveInverse(bottom, mul(evB(4).p, (r + 0.5) / r), 4, 0.5, 'unique');
    const side = m.surface({ kind: 'cylinder', position: { origin: O, axis: Z, xDir: X }, radius: r }, { u: TAU });
    const ev = coneEv(F0, r, 0);
    m.surfacePoints(side, ev, [[0, 0], [1, 2.5], [PI, h], [5.5, 0.3]]);
    m.surfaceInverse(side, ev(2, 1).p, [2, 1], 0, 'unique');
    m.surfaceInverse(side, ev(0, 3).p, [0, 3], 0, 'unique', { onSeamU: true });
    m.surfaceInverse(side, lin([1, ev(4, 2).p], [0.75, unit(sub(ev(4, 2).p, [0, 0, 2]))]), [4, 2], 0.75, 'unique');
    const s = seamedSolid(m, side, true, bottom, top, r, r, h, (t) => t, TAU);
    // The disks' outer loops: the bottom circle run clockwise about +z (the face's normal is -z), the top's forward.
    const cB = m.pcurve(circle2([0, 0], r), s.planeB), cT = m.pcurve(circle2([0, 0], r), s.planeT);
    m.pcurvePoints(cB, ellipseEv([0, 0], [1, 0], [0, 1], r, r), [0, 2]);
    const fB = m.face(s.planeB, false, [{ kind: 'edge', bound: 'outer', coedges: [
      { edge: s.eB, orientation: 'reversed', pcurve: cB, range: [0, TAU] }] }]);
    const fT = m.face(s.planeT, true, [{ kind: 'edge', bound: 'outer', coedges: [
      { edge: s.eT, orientation: 'forward', pcurve: cT, range: [0, TAU] }] }]);
    m.faceArea(s.sideFace, TAU * r * h);
    m.faceArea(fB, PI * r * r);
    m.faceArea(fT, PI * r * r);
    const shell = m.shell({ kind: 'closed', faces: [s.sideFace, fB, fT].map((face) => ({ face })) });
    m.volume(m.body({ kind: 'solid', members: [{ ref: shell }] }), PI * r * r * h);
  },
};

void curveAt; void multiplicities; void surfaceAt; void unitCircle; void sphereEv; void torusEv;
export type { Pieces, CurveEval };

export const SHAPES: Shape[] = [box, cylinder];
