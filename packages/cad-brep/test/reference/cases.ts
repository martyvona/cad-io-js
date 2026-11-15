// The catalogue of degenerate and ambiguous cases (docs/own-tessellator.md, "The cases"): a model each, with records
// of what each query on it must answer, in cad-geom's result terms (packages/cad-geom/native/include/cad_geom/
// result.h, curve.h, surface.h, geom2d.h). A record: { id, description, entities (rows by table), query, input,
// expected }. Queries are cad-geom's functions (intersect2, selfIntersect2, classify2, nest2, invertCurve,
// invertSurface, singularities, singular) or, where cad-geom has none yet, a measure named for what it states
// (edgeUses, edgeLength, vertexGap, faceWidth, normal). Expected answers come from the construction, in closed form.
//
// In 2D queries a loop is its coedges' p-curves in order, each over its coedge's range, reversed where the coedge is;
// a loop's parameter in selfIntersect2 is the piece's index plus the fraction along it.

import type { BrepData } from '../../src/data.ts';
import type { Curve } from '../../src/types.ts';
import { extrusionEv, frame, parabolaEv, torusEv } from './forms.ts';
import { type LocalCoedge, Maker, type SurfaceRef } from './maker.ts';
import { lin, type V } from './vec.ts';

export interface CaseRecord {
  id: string;
  description: string;
  entities: Record<string, number[]>;
  query: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface CaseShape {
  name: string;
  size: number;
  uncertainty: number;
  /** Writes the model; the records are made from the finished buffer (for coedge and loop rows). */
  make(m: Maker): (d: BrepData) => CaseRecord[];
}

const PI = Math.PI, TAU = 2 * Math.PI;
const X: V = [1, 0, 0], Z: V = [0, 0, 1], O: V = [0, 0, 0];
const XY = { origin: O, axis: Z, xDir: X };
const line2 = (point: V, direction: V, magnitude = 1): Curve => ({ kind: 'line', point, direction, magnitude });

/** The row of coedge k of loop j of face f, as written. */
const coedgeRow = (d: BrepData, f: number, j: number, k: number) => d.loop.first[d.face.firstLoop[f]! + j]! + k;
const loopRow = (d: BrepData, f: number, j: number) => d.face.firstLoop[f]! + j;

/**
 * A face on the plane z = 0 (u = x, v = y) bounded by polygons in (x, y), each side a line edge from corner to corner
 * (t in [0, 1]) with its p-curve, loops as given (the outer counter-clockwise, holes clockwise). Returns the face and
 * per loop its sides' p-curve and edge rows.
 */
function polygonFace(m: Maker, plane: SurfaceRef, loops: { pts: V[]; bound: 'outer' | 'inner' | 'unknown' }[]) {
  const sides: { pcurve: number; edge: number }[][] = [];
  const out = loops.map(({ pts, bound }) => {
    const vs = pts.map((p) => m.vertex([p[0]!, p[1]!, 0]));
    const cs: LocalCoedge[] = [], mine: { pcurve: number; edge: number }[] = [];
    pts.forEach((a, k) => {
      const b = pts[(k + 1) % pts.length]!, dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, L = Math.hypot(dx, dy);
      const curve = m.curve({ kind: 'line', point: [a[0]!, a[1]!, 0], direction: [dx / L, dy / L, 0], magnitude: L });
      const edge = m.edge({ curve, start: vs[k]!, end: vs[(k + 1) % pts.length]!, sameSense: true, range: [0, 1] });
      const pcurve = m.pcurve(line2([a[0]!, a[1]!], [dx / L, dy / L], L), plane);
      cs.push({ edge, orientation: 'forward', pcurve, range: [0, 1] });
      mine.push({ pcurve, edge });
    });
    sides.push(mine);
    return { kind: 'edge' as const, bound, coedges: cs };
  });
  return { face: m.face(plane, true, out), sides };
}

const xyPlane = (m: Maker) => m.surface({ kind: 'plane', position: XY });

/** A face's loops as sheets' one face each, in an open shell. */
const sheet = (m: Maker, faces: number[]) => m.body({ kind: 'sheet', members: [{ ref: m.shell({ kind: 'open',
  faces: faces.map((face) => ({ face })) }) }] });

/** Overlapping p-curves: a cylinder's seam used twice, two faces sharing part of a boundary, a hole on a side. */
const overlaps: CaseShape = {
  name: 'case-overlap', size: 5, uncertainty: 1e-6,
  make(m) {
    // Two rectangles on one plane, side by side along y = 0, the first [0, 2] x [-1, 0], the second [1, 3] x [0, 1]:
    // the first's top runs (2, 0) to (0, 0), the second's bottom (1, 0) to (3, 0); they overlap over x in [1, 2].
    const plane = xyPlane(m);
    const a = polygonFace(m, plane, [{ pts: [[0, -1], [2, -1], [2, 0], [0, 0]], bound: 'outer' }]);
    const b = polygonFace(m, plane, [{ pts: [[1, 0], [3, 0], [3, 1], [1, 1]], bound: 'outer' }]);
    // A square [0, 4] x [4, 8] with a hole [0, 1] x [5, 6] on its left side: the outer's left side runs (0, 8) to
    // (0, 4), the hole's (clockwise) from (0, 5) to (0, 6).
    const c = polygonFace(m, plane, [{ pts: [[0, 4], [4, 4], [4, 8], [0, 8]], bound: 'outer' },
      { pts: [[0, 5], [0, 6], [1, 6], [1, 5]], bound: 'inner' }]);
    sheet(m, [a.face, b.face, c.face]);
    // The seam cylinder: radius 1, height 2, its seam's p-curves u = 0 and u = 2 pi.
    const cyl = m.surface({ kind: 'cylinder', position: XY, radius: 1 }, { u: TAU });
    const bot = m.curve({ kind: 'circle', position: XY, radius: 1 });
    const top = m.curve({ kind: 'circle', position: { ...XY, origin: [0, 0, 2] }, radius: 1 });
    const seam = m.curve({ kind: 'line', point: [1, 0, 0], direction: Z, magnitude: 2 });
    const v0 = m.vertex([1, 0, 0]), v1 = m.vertex([1, 0, 2]);
    const eB = m.edge({ curve: bot, start: v0, end: v0, sameSense: true, range: [0, TAU] });
    const eT = m.edge({ curve: top, start: v1, end: v1, sameSense: true, range: [0, TAU] });
    const eS = m.edge({ curve: seam, start: v0, end: v1, sameSense: true, range: [0, 1] });
    const pS1 = m.pcurve(line2([TAU, 0], [0, 1], 2), cyl), pS0 = m.pcurve(line2([0, 0], [0, 1], 2), cyl);
    const side = m.face(cyl, true, [{ kind: 'edge', bound: 'outer', coedges: [
      { edge: eB, orientation: 'forward', pcurve: m.pcurve(line2([0, 0], [1, 0]), cyl), range: [0, TAU] },
      { edge: eS, orientation: 'forward', pcurve: pS1, range: [0, 1] },
      { edge: eT, orientation: 'reversed', pcurve: m.pcurve(line2([0, 2], [1, 0]), cyl), range: [0, TAU] },
      { edge: eS, orientation: 'reversed', pcurve: pS0, range: [0, 1] }] }]);
    sheet(m, [side]);
    return (d) => [
      { id: 'overlap-shared-boundary', description: 'Two faces on one plane whose boundaries coincide over part of '
        + 'their length: the first\'s top side (2, 0) to (0, 0) and the second\'s bottom (1, 0) to (3, 0) overlap '
        + 'over x in [1, 2], running opposite ways.',
        entities: { face: [a.face, b.face], curve: [a.sides[0]![2]!.pcurve, b.sides[0]![0]!.pcurve] },
        query: 'intersect2', input: { a: { curve: a.sides[0]![2]!.pcurve, range: [0, 1] },
          b: { curve: b.sides[0]![0]!.pcurve, range: [0, 1] }, tol: 1e-9 },
        expected: { crossings: [], overlaps: [{ a: [0, 0.5], b: [0, 0.5], sameDirection: false }] } },
      { id: 'overlap-hole-on-side', description: 'A hole touching its face\'s outer loop along a side: the outer\'s '
        + 'left side (0, 8) to (0, 4) and the hole\'s left side (0, 5) to (0, 6) coincide over y in [5, 6].',
        entities: { face: [c.face], coedge: [coedgeRow(d, c.face, 0, 3), coedgeRow(d, c.face, 1, 0)] },
        query: 'intersect2', input: { a: { curve: c.sides[0]![3]!.pcurve, range: [0, 1] },
          b: { curve: c.sides[1]![0]!.pcurve, range: [0, 1] }, tol: 1e-9 },
        expected: { crossings: [], overlaps: [{ a: [0.5, 0.75], b: [0, 1], sameDirection: false }] } },
      { id: 'overlap-hole-on-side-nesting', description: 'The same face\'s loops: the hole is inside the outer loop '
        + 'though they share a stretch of boundary.', entities: { face: [c.face], loop: [loopRow(d, c.face, 0),
        loopRow(d, c.face, 1)] }, query: 'nest2', input: { face: c.face, periods: { u: 0, v: 0 }, tol: 1e-9 },
        expected: { parents: [-1, 0] } },
      ...([[[0, 5.5], 'on'], [[0.5, 5.5], 'out'], [[2, 6], 'in'], [[0, 4.5], 'on']] as [V, string][]).map(
        ([p, side]): CaseRecord => ({ id: `overlap-hole-classify-${p.join('-')}`, description: 'A point against the '
          + `face with a hole on its side: (${p.join(', ')}) is ${side}.`, entities: { face: [c.face] },
        query: 'classify2', input: { face: c.face, p, periods: { u: 0, v: 0 }, tol: 1e-9 }, expected: { side } })),
      { id: 'overlap-seam', description: 'A cylinder\'s seam used twice by one face: in 3D its two uses are one edge '
        + 'run both ways; in (u, v) its p-curves are u = 0 and u = 2 pi, a period apart, so they neither cross nor '
        + 'overlap there, and a point on either is on the face\'s boundary.', entities: { face: [side],
        coedge: [coedgeRow(d, side, 0, 1), coedgeRow(d, side, 0, 3)], edge: [eS] }, query: 'intersect2',
      input: { a: { curve: pS1, range: [0, 1] }, b: { curve: pS0, range: [0, 1] }, tol: 1e-9 },
      expected: { crossings: [], overlaps: [] } },
      ...([[[0, 1], 'on'], [[TAU, 1], 'on'], [[1, 1], 'in'], [[1, 3], 'out']] as [V, string][]).map(
        ([p, s]): CaseRecord => ({ id: `overlap-seam-classify-${p[0] === TAU ? '2pi' : p[0]}-${p[1]}`,
          description: `A point against the seamed side, u periodic: (${p[0] === TAU ? '2 pi' : p[0]}, ${p[1]}) is `
            + `${s}.`, entities: { face: [side] }, query: 'classify2', input: { face: side, p,
            periods: { u: TAU, v: 0 }, tol: 1e-9 }, expected: { side: s } })),
    ];
  },
};

/** Tangent loops: a hole tangent to the outer loop at a point; a pinched loop touching itself at a vertex. */
const tangents: CaseShape = {
  name: 'case-tangent', size: 8, uncertainty: 1e-6,
  make(m) {
    const plane = xyPlane(m);
    // The square [0, 4]^2, its sides (0, 0) to (4, 0), (4, 0) to (4, 4), (4, 4) to (0, 4), (0, 4) to (0, 0); a hole
    // of radius 1 about (1, 2), touching the left side at (0, 2): the circle (counter-clockwise, t its angle) used
    // reversed, so the hole runs clockwise.
    const circle = m.curve({ kind: 'circle', position: { origin: [1, 2, 0], axis: Z, xDir: X }, radius: 1 });
    const vc = m.vertex([0, 2, 0]);
    // The vertex at the touching point, at angle pi.
    const ec = m.edge({ curve: circle, start: vc, end: vc, sameSense: true, range: [PI, PI + TAU] });
    const pc = m.pcurve({ kind: 'circle', position: { origin: [1, 2], xDir: [1, 0] }, radius: 1 }, plane);
    const vs = [[0, 0], [4, 0], [4, 4], [0, 4]].map((p) => m.vertex([p[0]!, p[1]!, 0]));
    const sides = [[0, 0], [4, 0], [4, 4], [0, 4]].map((a, k, all) => {
      const b = all[(k + 1) % 4]!, dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, L = Math.hypot(dx, dy);
      const curve = m.curve({ kind: 'line', point: [a[0]!, a[1]!, 0], direction: [dx / L, dy / L, 0], magnitude: L });
      return { edge: m.edge({ curve, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true, range: [0, 1] }),
        pcurve: m.pcurve(line2(a, [dx / L, dy / L], L), plane) };
    });
    const holed = m.face(plane, true, [
      { kind: 'edge', bound: 'outer', coedges: sides.map((s) => ({ edge: s.edge, orientation: 'forward' as const,
        pcurve: s.pcurve, range: [0, 1] as [number, number] })) },
      { kind: 'edge', bound: 'inner', coedges: [{ edge: ec, orientation: 'reversed', pcurve: pc,
        range: [PI, PI + TAU] }] }]);
    // A pinched loop: two squares [0, 2]^2 and [2, 4]^2 about (10, 0), one loop through their shared corner twice.
    const pin = polygonFace(m, plane, [{ pts: [[10, 0], [12, 0], [12, 2], [14, 2], [14, 4], [12, 4], [12, 2],
      [10, 2]], bound: 'outer' }]);
    sheet(m, [holed, pin.face]);
    return (d) => [
      { id: 'tangent-hole', description: 'A hole tangent to its face\'s outer loop: the circle of radius 1 about '
        + '(1, 2) touches the left side (0, 4) to (0, 0) at (0, 2), the side at t 1/2, the circle at angle pi.',
        entities: { face: [holed], coedge: [coedgeRow(d, holed, 0, 3), coedgeRow(d, holed, 1, 0)] },
        query: 'intersect2', input: { a: { curve: sides[3]!.pcurve, range: [0, 1] }, b: { curve: pc,
          range: [0, TAU] }, tol: 1e-9 }, expected: { crossings: [{ ta: 0.5, tb: PI, p: [0, 2], tangent: true }],
          overlaps: [] } },
      { id: 'tangent-hole-nesting', description: 'The tangent hole is inside the outer loop.', entities: {
        face: [holed], loop: [loopRow(d, holed, 0), loopRow(d, holed, 1)] }, query: 'nest2', input: { face: holed,
        periods: { u: 0, v: 0 }, tol: 1e-9 }, expected: { parents: [-1, 0] } },
      ...([[[0, 2], 'on'], [[1, 2], 'out'], [[0.1, 1], 'in'], [[3, 3], 'in']] as [V, string][]).map(
        ([p, side]): CaseRecord => ({ id: `tangent-hole-classify-${p.join('-')}`, description: 'A point against the '
          + `face with a tangent hole: (${p.join(', ')}) is ${side}.`, entities: { face: [holed] },
        query: 'classify2', input: { face: holed, p, periods: { u: 0, v: 0 }, tol: 1e-9 }, expected: { side } })),
      { id: 'tangent-pinched', description: 'A pinched face: one loop through the corner (12, 2) twice, the end of '
        + 'its piece 1 (the start of piece 2) and the end of piece 5 (the start of piece 6); it touches itself '
        + 'there without crossing.', entities: { face: [pin.face], loop: [loopRow(d, pin.face, 0)] },
      query: 'selfIntersect2', input: { face: pin.face, loop: 0, tol: 1e-9 },
      expected: { crossings: [{ ta: 2, tb: 6, p: [12, 2], tangent: true }], overlaps: [] } },
    ];
  },
};

/**
 * Ambiguous projections: the extrusion along z of the parabola C(t) = (t^2, 2 t, 0) (focal distance 1), and the
 * line x = 3, y = 0 on its plane of symmetry, off the surface: each of its points is nearest the surface at t = -1
 * and t = 1 equally, at distance sqrt 8 (the squared distance (t^2 - 3)^2 + 4 t^2 has its minima at t^2 = 1; t = 0 is
 * a maximum, since 3 is past the vertex's centre of curvature at 2).
 */
const parabolic: CaseShape = {
  name: 'case-parabolic', size: 4, uncertainty: 1e-6,
  make(m) {
    const F = frame(O, Z, X), par = m.curve({ kind: 'parabola', position: XY, focalDist: 1 });
    const S = m.surface({ kind: 'extrusion', curve: par, direction: Z, magnitude: 2 });
    const ev = extrusionEv(parabolaEv(F.o, F.x, F.y, 1), Z, 2);
    m.surfacePoints(S, ev, [[1, 0.5], [-1, 0.5]]);
    const line = m.curve({ kind: 'line', point: [3, 0, 0], direction: Z, magnitude: 1 });
    m.b.addItem({ kind: 'surface', ref: S.row });
    m.b.addItem({ kind: 'curve', ref: line });
    return () => [
      ...[0, 1, -2].map((z): CaseRecord => ({ id: `parabolic-symmetry-${z}`, description: 'A point on the parabolic '
        + `cylinder's plane of symmetry, off it: (3, 0, ${z}) is nearest at u = -1 and u = 1 alike (v = z / 2), at `
        + 'distance sqrt 8.', entities: { surface: [S.row], curve: [line] }, query: 'invertSurface',
      input: { surface: S.row, p: [3, 0, z], tol: 1e-9 }, expected: { uv: [-1, z / 2], distance: Math.sqrt(8),
        certainty: 'ambiguous', alternatives: [[1, z / 2]], onSeamU: false, onSeamV: false, atSingularity: false } })),
      { id: 'parabolic-symmetry-curve', description: 'The parabola itself from (3, 0, 0): nearest at t = -1 and t = 1 '
        + 'alike.', entities: { curve: [par] }, query: 'invertCurve', input: { curve: par, p: [3, 0, 0],
        range: [-3, 3], tol: 1e-9 }, expected: { t: -1, distance: Math.sqrt(8), certainty: 'ambiguous',
        alternatives: [1] } },
      { id: 'parabolic-inside', description: 'A point nearer the vertex than its centre of curvature: (1.5, 0, 0) is '
        + 'nearest the vertex alone (t = 0, distance 1.5).', entities: { curve: [par] }, query: 'invertCurve',
      input: { curve: par, p: [1.5, 0, 0], range: [-3, 3], tol: 1e-9 }, expected: { t: 0, distance: 1.5,
        certainty: 'unique', alternatives: [] } },
    ];
  },
};

/**
 * Parameter singularities: a sphere's poles, a cone's apex reached with no degenerate edge (the loop jumps along the
 * apex line), a B-spline sphere's collapsed rows, a cubic B-spline with a cusp.
 */
const singular: CaseShape = {
  name: 'case-singular', size: 4, uncertainty: 1e-6,
  make(m) {
    const sphere = m.surface({ kind: 'sphere', position: XY, radius: 2 }, { u: TAU });
    m.b.addItem({ kind: 'surface', ref: sphere.row });
    // The cone of semi-angle pi / 4, radius 1 at v = 0, its apex at v = -1, (0, 0, -1); its face from the apex to
    // v = 0 bounded by the base circle and the seam alone (the apex's degenerate edge left out).
    const cone = m.surface({ kind: 'cone', position: XY, radius: 1, semiAngle: PI / 4 }, { u: TAU });
    const base = m.curve({ kind: 'circle', position: XY, radius: 1 });
    const seam = m.curve({ kind: 'line', point: [0, 0, -1], direction: [Math.SQRT1_2, 0, Math.SQRT1_2],
      magnitude: Math.SQRT2 });
    const va = m.vertex([0, 0, -1]), vb = m.vertex([1, 0, 0]);
    const eBase = m.edge({ curve: base, start: vb, end: vb, sameSense: true, range: [0, TAU] });
    const eSeam = m.edge({ curve: seam, start: va, end: vb, sameSense: true, range: [0, 1] });
    const eApex = m.edge({ start: va, end: va, sameSense: true, degenerate: true });
    const pApex = m.pcurve(line2([0, -1], [1, 0]), cone);
    const coneFace = m.face(cone, true, [{ kind: 'edge', bound: 'outer', coedges: [
      { edge: eApex, orientation: 'forward', pcurve: pApex, range: [0, TAU] },
      { edge: eSeam, orientation: 'forward', pcurve: m.pcurve(line2([TAU, -1], [0, 1], 1), cone), range: [0, 1] },
      { edge: eBase, orientation: 'reversed', pcurve: m.pcurve(line2([0, 0], [1, 0]), cone), range: [0, TAU] },
      { edge: eSeam, orientation: 'reversed', pcurve: m.pcurve(line2([0, -1], [0, 1], 1), cone), range: [0, 1] },
    ] }]);
    sheet(m, [coneFace]);
    // A cubic Bezier (as a B-spline) whose speed vanishes at t = 1/2: poles (0, 0), (1, 1), (0, 1), (1, 0), so
    // C'(t) / 3 = ((1 - 2 t)^2, 1 - 2 t).
    const cusp = m.curve({ kind: 'bspline', degree: 3, knots: [0, 1], multiplicities: [4, 4], poles: [[4, 0, 0],
      [5, 1, 0], [4, 1, 0], [5, 0, 0]], closed: false, selfIntersect: false, form: 'unspecified' });
    m.b.addItem({ kind: 'curve', ref: cusp });
    return (d) => [
      { id: 'singular-sphere-poles', description: 'A sphere of radius 2: poles at v = -pi / 2 and pi / 2, u free.',
        entities: { surface: [sphere.row] }, query: 'singularities', input: { surface: sphere.row },
        expected: { singularities: [{ kind: 'pole', isoU: false, at: -PI / 2, point: [0, 0, -2] },
          { kind: 'pole', isoU: false, at: PI / 2, point: [0, 0, 2] }] } },
      { id: 'singular-sphere-pole-inverse', description: 'The pole (0, 0, 2) inverted: at the singularity, any u.',
        entities: { surface: [sphere.row] }, query: 'invertSurface', input: { surface: sphere.row, p: [0, 0, 2],
          tol: 1e-9 }, expected: { uv: [0, PI / 2], distance: 0, certainty: 'unique', alternatives: [],
          onSeamU: false, onSeamV: false, atSingularity: true } },
      { id: 'singular-cone-apex', description: 'A cone of semi-angle pi / 4 and radius 1 at v = 0: its apex at '
        + 'v = -1, (0, 0, -1), u free.', entities: { surface: [cone.row] }, query: 'singularities',
      input: { surface: cone.row }, expected: { singularities: [{ kind: 'apex', isoU: false, at: -1,
        point: [0, 0, -1] }] } },
      { id: 'singular-cone-face', description: 'The cone\'s face from its apex to v = 0, given a degenerate edge at '
        + 'the apex, which the model leaves out: its loop has the seam (twice) and the base only, jumping along '
        + 'v = -1 from u = 0 to 2 pi; (1, -1) is on its boundary, (1, -0.5) inside.', entities: { face: [coneFace],
        edge: [eApex] }, query: 'loopCoedges', input: { face: coneFace }, expected: { coedges: 3, jump: { from:
        [0, -1], to: [TAU, -1] } } },
      ...([[[1, -1], 'on'], [[1, -0.5], 'in'], [[1, 0.5], 'out']] as [V, string][]).map(([p, side]): CaseRecord => ({
        id: `singular-cone-classify-${p.join('-')}`, description: `A point against the cone face: (${p.join(', ')}) `
          + `is ${side}; the apex line closes the loop.`, entities: { face: [coneFace] }, query: 'classify2',
        input: { face: coneFace, p, periods: { u: TAU, v: 0 }, tol: 1e-9 }, expected: { side } })),
      { id: 'singular-cusp', description: 'A cubic B-spline with poles (4, 0, 0), (5, 1, 0), (4, 1, 0), (5, 0, 0): '
        + 'its speed vanishes at t = 1/2 (C\'(t) = 3 ((1 - 2 t)^2, 1 - 2 t, 0)), a cusp at (4.5, 0.75, 0).',
      entities: { curve: [cusp] }, query: 'singular', input: { curve: cusp, range: [0, 1] },
      expected: { params: [0.5], point: [4.5, 0.75, 0] } },
    ];
  },
};

/**
 * Periodic loops: a cylinder's band between two circles (no seam edge: two loops, each round the period, both
 * marked outer), and a torus's band between two minor circles at u = 1 and u = 2 (each round v's period).
 */
const periodic: CaseShape = {
  name: 'case-periodic', size: 8, uncertainty: 1e-6,
  make(m) {
    const cyl = m.surface({ kind: 'cylinder', position: XY, radius: 1 }, { u: TAU });
    const c0 = m.curve({ kind: 'circle', position: XY, radius: 1 });
    const c1 = m.curve({ kind: 'circle', position: { ...XY, origin: [0, 0, 2] }, radius: 1 });
    const v0 = m.vertex([1, 0, 0]), v1 = m.vertex([1, 0, 2]);
    const e0 = m.edge({ curve: c0, start: v0, end: v0, sameSense: true, range: [0, TAU] });
    const e1 = m.edge({ curve: c1, start: v1, end: v1, sameSense: true, range: [0, TAU] });
    const band = m.face(cyl, true, [
      { kind: 'edge', bound: 'outer', coedges: [{ edge: e0, orientation: 'forward',
        pcurve: m.pcurve(line2([0, 0], [1, 0]), cyl), range: [0, TAU] }] },
      { kind: 'edge', bound: 'outer', coedges: [{ edge: e1, orientation: 'reversed',
        pcurve: m.pcurve(line2([0, 2], [1, 0]), cyl), range: [0, TAU] }] }]);
    // The torus R 3, r 1; minor circles at u = 1 and u = 2, each C(t) = torus(u, t), t in [0, 2 pi].
    const R = 3, r = 1, tor = m.surface({ kind: 'torus', position: { ...XY, origin: [10, 0, 0] }, majorRadius: R,
      minorRadius: r }, { u: TAU, v: TAU });
    const tev = torusEv(frame([10, 0, 0], Z, X), R, r);
    const minor = (u: number) => {
      const c = [Math.cos(u), Math.sin(u), 0];
      // In the plane of u: centre (10, 0, 0) + R e(u), x along e(u), y along z: the axis e(u) x z... chosen so that
      // the circle's y is z: axis = x x y reversed, -(e x z) = z x e.
      const ax = [-c[1]!, c[0]!, 0].map((x) => -x);
      return m.curve({ kind: 'circle', position: { origin: lin([1, [10, 0, 0]], [R, c]), axis: ax, xDir: c },
        radius: r });
    };
    const m1 = minor(1), m2 = minor(2);
    const w1 = m.vertex(tev(1, 0).p), w2 = m.vertex(tev(2, 0).p);
    const f1 = m.edge({ curve: m1, start: w1, end: w1, sameSense: true, range: [0, TAU] });
    const f2 = m.edge({ curve: m2, start: w2, end: w2, sameSense: true, range: [0, TAU] });
    // Between u = 1 and u = 2: the region to the left of each going round v: at u = 1 v decreasing (the left of -v
    // is +u), at u = 2 v increasing.
    const tband = m.face(tor, true, [
      { kind: 'edge', bound: 'unknown', coedges: [{ edge: f1, orientation: 'reversed',
        pcurve: m.pcurve(line2([1, 0], [0, 1]), tor), range: [0, TAU] }] },
      { kind: 'edge', bound: 'unknown', coedges: [{ edge: f2, orientation: 'forward',
        pcurve: m.pcurve(line2([2, 0], [0, 1]), tor), range: [0, TAU] }] }]);
    sheet(m, [band]);
    sheet(m, [tband]);
    return (d) => [
      { id: 'periodic-band-nesting', description: 'A cylinder band (radius 1, z in [0, 2]) bounded by two circles, '
        + 'each winding once round u: neither contains the other.', entities: { face: [band], loop: [
        loopRow(d, band, 0), loopRow(d, band, 1)] }, query: 'nest2', input: { face: band, periods: { u: TAU, v: 0 },
        tol: 1e-9 }, expected: { parents: [-1, -1] } },
      ...([[[1, 1], 'in'], [[5, 0], 'on'], [[1, 3], 'out'], [[0, 1], 'in']] as [V, string][]).map(
        ([p, side]): CaseRecord => ({ id: `periodic-band-classify-${p.join('-')}`, description: 'A point against the '
          + `band: (${p.join(', ')}) is ${side}.`, entities: { face: [band] }, query: 'classify2',
        input: { face: band, p, periods: { u: TAU, v: 0 }, tol: 1e-9 }, expected: { side } })),
      { id: 'periodic-torus-band-nesting', description: 'A torus band between the minor circles at u = 1 and u = 2, '
        + 'each winding once round v: neither contains the other.', entities: { face: [tband], loop: [
        loopRow(d, tband, 0), loopRow(d, tband, 1)] }, query: 'nest2', input: { face: tband,
        periods: { u: TAU, v: TAU }, tol: 1e-9 }, expected: { parents: [-1, -1] } },
      ...([[[1.5, 3], 'in'], [[3, 3], 'out'], [[1, 5], 'on'], [[1.5, 0], 'in']] as [V, string][]).map(
        ([p, side]): CaseRecord => ({ id: `periodic-torus-classify-${p.join('-')}`, description: 'A point against the '
          + `torus band: (${p.join(', ')}) is ${side}.`, entities: { face: [tband] }, query: 'classify2',
        input: { face: tband, p, periods: { u: TAU, v: TAU }, tol: 1e-9 }, expected: { side } })),
    ];
  },
};

/**
 * Non-injective surfaces: a spindle torus (major radius 1 under minor 2: the tube crosses the axis where 1 + 2 cos v =
 * 0, v = 2 pi / 3 and 4 pi / 3, at z = +/-sqrt 3), and the offset by -1.5 of a cylinder of radius 1 (past its radius:
 * the cylinder of radius 0.5 turned inside out, its normal against its basis's).
 */
const noninjective: CaseShape = {
  name: 'case-noninjective', size: 4, uncertainty: 1e-6,
  make(m) {
    const R = 1, r = 2, spindle = m.surface({ kind: 'torus', position: XY, majorRadius: R, minorRadius: r,
      selectOuter: true }, { u: TAU, v: TAU });
    const tev = torusEv(frame(O, Z, X), R, r), q = tev(0, 2.5).p, s3 = Math.sqrt(3);
    m.surfacePoints(spindle, tev, [[0, 2.5], [1, 1]]);
    const basis = m.surface({ kind: 'cylinder', position: { ...XY, origin: [10, 0, 0] }, radius: 1 }, { u: TAU });
    const off = m.surface({ kind: 'offset', basis: basis.row, distance: -1.5, selfIntersect: true }, { u: TAU });
    for (const sf of [spindle, off]) m.b.addItem({ kind: 'surface', ref: sf.row });
    return () => [
      { id: 'noninjective-spindle-singular', description: 'A spindle torus (major radius 1, minor 2): it crosses its '
        + 'axis where 1 + 2 cos v = 0, at v = 2 pi / 3 (0, 0, sqrt 3) and 4 pi / 3 (0, 0, -sqrt 3), u free there.',
      entities: { surface: [spindle.row] }, query: 'singularities', input: { surface: spindle.row },
      expected: { singularities: [{ kind: 'apex', isoU: false, at: 2 * PI / 3, point: [0, 0, s3] },
        { kind: 'apex', isoU: false, at: 4 * PI / 3, point: [0, 0, -s3] }] } },
      { id: 'noninjective-spindle-centre', description: 'The spindle torus\'s centre: every point of the circle '
        + 'v = pi (radius 1 about the axis, on the inner part) is nearest, at distance 1 (mm). A continuum of feet: '
        + 'family u in [0, 2 pi] at v = pi; alternatives sample it.', entities: { surface: [spindle.row] },
      query: 'invertSurface', input: { surface: spindle.row, p: [0, 0, 0], tol: 1e-9 },
      expected: { uv: [0, PI], distance: 1, certainty: 'ambiguous', alternatives: [[PI / 2, PI], [PI, PI],
        [3 * PI / 2, PI]], onSeamU: true, onSeamV: false, atSingularity: false, family: { u: [0, TAU], v: PI } } },
      { id: 'noninjective-spindle-inner', description: 'A point of the spindle\'s inner part (1 + 2 cos v < 0 at v = '
        + '2.5): reached at (0, 2.5) alone.', entities: { surface: [spindle.row] }, query: 'invertSurface',
      input: { surface: spindle.row, p: q, tol: 1e-9 }, expected: { uv: [0, 2.5], distance: 0, certainty: 'unique',
        alternatives: [], onSeamU: true, onSeamV: false, atSingularity: false } },
      { id: 'noninjective-offset-normal', description: 'The offset by -1.5 (mm) of a cylinder of radius 1: radius '
        + '-0.5, the surface on the far side of the axis, so at (0, 0) its normal S_u x S_v (a unit vector) is '
        + '(-1, 0, 0) where its basis\'s is (1, 0, 0): a triangle right in (u, v) is inside out in 3D.',
      entities: { surface: [off.row, basis.row] }, query: 'normal', input: { surface: off.row, u: 0, v: 0 },
      expected: { n: [-1, 0, 0], basisN: [1, 0, 0] } },
      { id: 'noninjective-offset-inverse', description: 'The offset\'s point nearest (12, 0, 0): the offset surface '
        + 'is the circle of radius 0.5 reached from across the axis, so u = pi, at (10.5, 0, 0), distance 1.5 (mm).',
      entities: { surface: [off.row] }, query: 'invertSurface', input: { surface: off.row, p: [12, 0, 0], tol: 1e-9 },
      expected: { uv: [PI, 0], distance: 1.5, certainty: 'unique', alternatives: [], onSeamU: false, onSeamV: false,
        atSingularity: false } },
    ];
  },
};

/**
 * Sizes against tolerances (uncertainty 1e-6 mm): a sliver 10 by 1e-7, a face with an edge 1e-8 long, an edge whose
 * curve ends 1e-4 from its end vertex, and a square of side 1e-3 at (1e7, 1e7) on a plane through the origin.
 */
const sizes: CaseShape = {
  name: 'case-sizes', size: 2e7, uncertainty: 1e-6,
  make(m) {
    const plane = xyPlane(m);
    const sliver = polygonFace(m, plane, [{ pts: [[0, 0], [10, 0], [10, 1e-7], [0, 1e-7]], bound: 'outer' }]);
    const short = polygonFace(m, plane, [{ pts: [[20, 0], [22, 0], [22, 2], [20 + 1e-8, 2], [20, 2]],
      bound: 'outer' }]);
    // A square whose first side's line runs 1e-4 past its end vertex (the curve's t = 1 at (42.0001, 0)).
    const g = [[40, 0], [42, 0], [42, 2], [40, 2]].map((p) => m.vertex([p[0]!, p[1]!, 0]));
    const gapLine = m.curve({ kind: 'line', point: [40, 0, 0], direction: X, magnitude: 2 + 1e-4 });
    const gapEdge = m.edge({ curve: gapLine, start: g[0]!, end: g[1]!, sameSense: true, range: [0, 1] });
    const rest = [[42, 0], [42, 2], [40, 2]].map((a, k, all) => {
      const b = k < 2 ? all[k + 1]! : [40, 0], dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, L = Math.hypot(dx, dy);
      const curve = m.curve({ kind: 'line', point: [a[0]!, a[1]!, 0], direction: [dx / L, dy / L, 0], magnitude: L });
      return { edge: m.edge({ curve, start: g[k + 1]!, end: g[(k + 2) % 4]!, sameSense: true, range: [0, 1] }),
        orientation: 'forward' as const, pcurve: m.pcurve(line2(a, [dx / L, dy / L], L), plane),
        range: [0, 1] as [number, number] };
    });
    const gap = m.face(plane, true, [{ kind: 'edge', bound: 'outer', coedges: [{ edge: gapEdge,
      orientation: 'forward', pcurve: m.pcurve(line2([40, 0], [1, 0], 2 + 1e-4), plane), range: [0, 1] },
    ...rest] }]);
    const F = 1e7, a = 1e-3;
    const far = polygonFace(m, plane, [{ pts: [[F, F], [F + a, F], [F + a, F + a], [F, F + a]], bound: 'outer' }]);
    sheet(m, [sliver.face, short.face, gap, far.face]);
    return () => [
      { id: 'sizes-sliver', description: 'A face 10 (mm) by 1e-7 (mm), narrower than the uncertainty 1e-6: area '
        + '1e-6 (mm^2), width 1e-7 (mm).', entities: { face: [sliver.face] }, query: 'faceWidth',
      input: { face: sliver.face }, expected: { area: 1e-6, width: 1e-7 } },
      { id: 'sizes-short-edge', description: 'An edge of length 1e-8 (mm), under the uncertainty 1e-6 (mm), from '
        + '(20 + 1e-8, 2) to (20, 2).', entities: { face: [short.face], edge: [short.sides[0]![3]!.edge] },
      query: 'edgeLength', input: { edge: short.sides[0]![3]!.edge }, expected: { length: 1e-8,
        belowTolerance: true } },
      { id: 'sizes-vertex-gap', description: 'An edge whose line ends at (42.0001, 0) while its end vertex is at '
        + '(42, 0): a gap of 1e-4 (mm), wider than the uncertainty 1e-6.', entities: { face: [gap], edge: [gapEdge],
        vertex: [g[1]!] }, query: 'vertexGap', input: { edge: gapEdge, vertex: g[1]! }, expected: { gap: 1e-4 } },
      { id: 'sizes-far', description: 'A square of side 1e-3 (mm) at (1e7, 1e7) on a plane through the origin, so '
        + 'its (u, v) are 1e7 and their rounding 2e-9: area 1e-6 (mm^2), width 1e-3 (mm).', entities: {
        face: [far.face] }, query: 'faceWidth', input: { face: far.face }, expected: { area: 1e-6, width: 1e-3 } },
      ...([[[F + a / 2, F + a / 2], 'in'], [[F + a / 2, F], 'on'], [[F - 1e-6, F + a / 2], 'out']] as [V, string][])
        .map(([p, side], k): CaseRecord => ({ id: `sizes-far-classify-${k}`, description: 'A point against the far '
          + `square: (${p.join(', ')}) is ${side}.`, entities: { face: [far.face] }, query: 'classify2',
        input: { face: far.face, p, periods: { u: 0, v: 0 }, tol: 1e-8 }, expected: { side } })),
    ];
  },
};

/**
 * Topology on the edge of validity: three unit fins about the z axis sharing its edge (a non-manifold edge), and a
 * square with points exactly on its loop.
 */
const topology: CaseShape = {
  name: 'case-topology', size: 4, uncertainty: 1e-6,
  make(m) {
    const z0 = m.vertex(O), z1 = m.vertex(Z);
    const axis = m.curve({ kind: 'line', point: O, direction: Z, magnitude: 1 });
    const shared = m.edge({ curve: axis, start: z0, end: z1, sameSense: true, range: [0, 1] });
    const fins = [0, 1, 2].map((k) => {
      const a = k * TAU / 3, e: V = [Math.cos(a), Math.sin(a), 0].map((x) => x + 0);
      // The fin's plane: u along e, v along z (its axis (sin a, -cos a, 0), so that y = axis x e = z).
      const pl = m.surface({ kind: 'plane', position: { origin: O, axis: [e[1]!, -e[0]!, 0].map((x) => x + 0),
        xDir: e } });
      const c1 = m.vertex(e), c2 = m.vertex([e[0]!, e[1]!, 1]);
      const side = (p: V, q: V, s: number, t: number) => {
        const d: V = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
        return m.edge({ curve: m.curve({ kind: 'line', point: p, direction: d, magnitude: 1 }), start: s, end: t,
          sameSense: true, range: [0, 1] });
      };
      const bottom = side(O, e, z0, c1), outer = side(e, [e[0]!, e[1]!, 1], c1, c2);
      const top = side([e[0]!, e[1]!, 1], Z, c2, z1);
      return m.face(pl, true, [{ kind: 'edge', bound: 'outer', coedges: [
        { edge: bottom, orientation: 'forward' }, { edge: outer, orientation: 'forward' },
        { edge: top, orientation: 'forward' }, { edge: shared, orientation: 'reversed' }] }]);
    });
    sheet(m, fins);
    const sq = polygonFace(m, xyPlane(m), [{ pts: [[10, 0], [12, 0], [12, 2], [10, 2]], bound: 'outer' }]);
    sheet(m, [sq.face]);
    return () => [
      { id: 'topology-nonmanifold', description: 'An edge (the z axis from 0 to 1) used by three faces, each the '
        + 'other way from its start: uses 3 (a count), all reversed.', entities: { edge: [shared], face: fins },
      query: 'edgeUses', input: { edge: shared }, expected: { uses: 3, faces: fins } },
      ...([[[11, 0], 'on'], [[12, 2], 'on'], [[11, 1e-12], 'on'], [[11, 1e-6], 'in'], [[11, -1e-6], 'out']] as
        [V, string][]).map(([p, side], k): CaseRecord => ({ id: `topology-on-loop-${k}`, description: 'A point '
          + `against the square [10, 12] x [0, 2] within 1e-9 (in (u, v), mm): (${p.join(', ')}) is ${side}.`,
        entities: { face: [sq.face] }, query: 'classify2', input: { face: sq.face, p, periods: { u: 0, v: 0 },
          tol: 1e-9 }, expected: { side } })),
    ];
  },
};

export const CASES: CaseShape[] = [overlaps, tangents, parabolic, singular, periodic, noninjective, sizes, topology];
