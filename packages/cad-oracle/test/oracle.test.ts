// cad-oracle through its TypeScript layer and module: built faces with areas in closed form for what the reference
// shapes leave out (edge loops through a sphere's poles and a cone's apex, a torus face across v = +/-pi, bounded
// faces of revolution with and without a pole on their side), and the same areas as today's area oracle
// (cad-scene's area-oracle.ts, an independent implementation) wherever that one trusts a face. Skipped where the
// module isn't built (build.sh module).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { type BrepData, BrepBuilder, curveEvaluator, decode, edgeParams, type Loop, openBrep, rowCount } from 'cad-brep';
import { modelFaceArea, trustedArea } from '../../cad-scene/src/area-oracle.ts';
import { MODELS } from '../../cad-brep/test/models.ts';
import { bsplineCylinder, line2 } from '../../cad-heal/test/models.ts';
import { type Estimate, type FaceMeasure, init, MAX_MOMENT_DEGREE, Oracle, trusted } from '../src/index.ts';

const pkg = path.join(import.meta.dirname, '..');
const built = fs.existsSync(path.join(pkg, 'dist/cad_oracle.wasm'));
const skip = built ? false : 'cad-oracle\'s module not built (run packages/cad-oracle/build.sh module)';

type V = [number, number, number];
const O: V = [0, 0, 0], X: V = [1, 0, 0], Z: V = [0, 0, 1];
const PI = Math.PI;

async function measure(d: BrepData, face = 0): Promise<FaceMeasure> {
  using o = new Oracle(await init(), d.buffer);
  return o.face(face);
}

/**
 * The area within 1e-9; an elementary sphere's flagged where it's past a hemisphere (`whole` the sphere's), a
 * revolution's as projected (these faces have no p-curves), else no flags.
 */
function near(m: FaceMeasure, expected: number, what: string, whole = 0) {
  const flags = [...whole > 0 && expected > whole / 2 ? ['sphereSide'] : [],
    ...m.method === 'revolution' ? ['projectedBoundary'] : []];
  assert.deepEqual(m.flags, flags, `${what}: ${JSON.stringify(m)}`);
  assert.ok(m.area.status === 'ok' && m.area.error <= 1e-9 * expected, `${what}: not converged: ${JSON.stringify(m)}`);
  assert.ok(Math.abs(m.area.value - expected) <= 1e-9 * expected, `${what}: ${m.area.value} vs ${expected}`);
}

/**
 * How far a face's perimeter by its edges' curves (the oracle's) may be from one between its vertices
 * (area-oracle.ts's, its lines from vertex to vertex): each edge's curve's ends' distances from its vertices.
 */
/**
 * FaceMeasure.boundary's vertex-gap part, independently: per use of an edge with a curve, the larger of its vertices'
 * distances from the curve at its edgeParams, times its length (the oracle's, with its error).
 */
function gapBound(d: BrepData, f: number, o: Oracle): number {
  let sum = 0;
  for (const l of decode.face(d, f).loops) {
    if (l.kind !== 'edge') continue;
    for (const c of l.coedges) {
      const e = decode.edge(d, c.edge), ev = e.curve === undefined ? undefined : curveEvaluator(d, e.curve);
      const r = ev && edgeParams(d, c.edge, ev);
      if (!ev || !r) continue;
      let gap = 0;
      for (const [t, v] of [[r[0], e.start], [r[1], e.end]] as const) {
        if (v === undefined) continue;
        const p = ev.point(t);
        gap = Math.max(gap, Math.hypot(p[0]! - d.vertex.point[3 * v]!, p[1]! - d.vertex.point[3 * v + 1]!,
          p[2]! - d.vertex.point[3 * v + 2]!));
      }
      const len = o.edgeLength(c.edge);
      sum += gap * (len.value + len.error);
    }
  }
  return sum;
}

function vertexGaps(d: BrepData, f: number): number {
  let sum = 0;
  for (const l of decode.face(d, f).loops) {
    if (l.kind !== 'edge') continue;
    for (const c of l.coedges) {
      const e = decode.edge(d, c.edge), ev = e.curve === undefined ? undefined : curveEvaluator(d, e.curve);
      const r = ev && edgeParams(d, c.edge, ev);
      if (!ev || !r || e.start === undefined || e.end === undefined) continue;
      for (const [t, v] of [[r[0], e.start], [r[1], e.end]] as const) {
        const p = ev.point(t);
        sum += Math.hypot(p[0]! - d.vertex.point[3 * v]!, p[1]! - d.vertex.point[3 * v + 1]!,
          p[2]! - d.vertex.point[3 * v + 2]!);
      }
    }
  }
  return sum;
}

/** A meridian of a sphere of radius R about z through the origin at angle phi: t from -pi/2 (south) to pi/2. */
function meridian(b: BrepBuilder, R: number, phi: number) {
  return b.addCurve({ kind: 'circle', radius: R, position: { origin: O, axis: [Math.sin(phi), -Math.cos(phi), 0],
    xDir: [Math.cos(phi), Math.sin(phi), 0] } });
}
/** A circle about z at height z of radius r. */
const parallel = (b: BrepBuilder, r: number, z: number) =>
  b.addCurve({ kind: 'circle', radius: r, position: { origin: [0, 0, z], axis: Z, xDir: X } });

/** The surface rows: an elementary sphere, or the same sphere as a revolution of a half circle. */
function sphereSurface(b: BrepBuilder, R: number, revolution: boolean) {
  if (!revolution) return b.addSurface({ kind: 'sphere', radius: R, position: { origin: O, axis: Z, xDir: X } });
  const circle = b.addCurve({ kind: 'circle', radius: R, position: { origin: O, axis: [0, -1, 0], xDir: X } });
  const half = b.addCurve({ kind: 'trimmed', basis: circle, trim1: { parameter: -PI / 2 },
    trim2: { parameter: PI / 2 }, sense: true, preference: 'parameter' });
  return b.addSurface({ kind: 'revolution', curve: half, axisOrigin: O, axisDirection: Z });
}

/**
 * A meridian as above, parameterized from the south pole at t = 0 to the north at pi, so its point at the south pole
 * is exactly on the axis (no angle to read off its rounding there).
 */
function meridianFromPole(b: BrepBuilder, R: number, phi: number) {
  return b.addCurve({ kind: 'circle', radius: R, position: { origin: O, axis: [Math.sin(phi), -Math.cos(phi), 0],
    xDir: [0, 0, -1] } });
}

/**
 * A lune between the meridians at 0 and alpha, pole to pole: area 2 R^2 alpha. `extra` adds rows given the builder
 * and the face's row.
 */
function lune(R: number, alpha: number, revolution: boolean, fromPole = false,
  extra?: (b: BrepBuilder, face: number) => void): BrepData {
  const b = new BrepBuilder();
  const s = sphereSurface(b, R, revolution);
  const S = b.addVertex({ point: [0, 0, -R] }), N = b.addVertex({ point: [0, 0, R] });
  const curve = (phi: number) => fromPole ? meridianFromPole(b, R, phi) : meridian(b, R, phi);
  const range: [number, number] = fromPole ? [0, PI] : [-PI / 2, PI / 2];
  const m0 = b.addEdge({ curve: curve(0), start: S, end: N, sameSense: true, range });
  const ma = b.addEdge({ curve: curve(alpha), start: S, end: N, sameSense: true, range });
  const face = b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: ma, orientation: 'forward' }, { edge: m0, orientation: 'reversed' }] }] });
  extra?.(b, face);
  return b.finish();
}

/** A zone between latitudes v1 < v2 (both loops), or a cap above v1 (`north`) or below v2 (`south`). */
function band(R: number, v1: number, v2: number, which: 'zone' | 'north' | 'south', revolution: boolean): BrepData {
  const b = new BrepBuilder();
  const s = sphereSurface(b, R, revolution);
  const ring = (v: number) => {
    const p = b.addVertex({ point: [R * Math.cos(v), 0, R * Math.sin(v)] });
    return b.addEdge({ curve: parallel(b, R * Math.cos(v), R * Math.sin(v)), start: p, end: p, sameSense: true,
      range: [0, 2 * PI] });
  };
  const loops = [];
  if (which !== 'south') loops.push({ kind: 'edge' as const, bound: 'outer' as const, coedges: [
    { edge: ring(v1), orientation: 'forward' as const }] });
  if (which !== 'north') loops.push({ kind: 'edge' as const, bound: 'outer' as const, coedges: [
    { edge: ring(v2), orientation: 'reversed' as const }] });
  b.addFace({ surface: s, sameSense: true, loops });
  return b.finish();
}

/** A cone's sector from its apex to the circle at v = 0, over u in [0, beta]: area beta r^2 / (2 sin a). */
function coneSector(r: number, a: number, beta: number): BrepData {
  const b = new BrepBuilder();
  const s = b.addSurface({ kind: 'cone', radius: r, semiAngle: a, position: { origin: O, axis: Z, xDir: X } });
  const za = -r / Math.tan(a), apex: V = [0, 0, za];
  const A = b.addVertex({ point: apex });
  const rim = (u: number): V => [r * Math.cos(u), r * Math.sin(u), 0];
  const P0 = b.addVertex({ point: rim(0) }), Pb = b.addVertex({ point: rim(beta) });
  const generator = (to: V, end: number) => {
    const d: V = [to[0] - apex[0], to[1] - apex[1], to[2] - apex[2]], L = Math.hypot(...d);
    const line = b.addCurve({ kind: 'line', point: apex, direction: [d[0] / L, d[1] / L, d[2] / L], magnitude: L });
    return b.addEdge({ curve: line, start: A, end, sameSense: true, range: [0, 1] });
  };
  const g0 = generator(rim(0), P0), gb = generator(rim(beta), Pb);
  const arc = b.addEdge({ curve: parallel(b, r, 0), start: P0, end: Pb, sameSense: true, range: [0, beta] });
  b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: gb, orientation: 'forward' }, { edge: arc, orientation: 'reversed' }, { edge: g0, orientation: 'reversed' }] }] });
  return b.finish();
}

/** A torus patch over u in [0, gamma], v in [v1, v2] (across pi): area r gamma (R (v2 - v1) + r (sin v2 - sin v1)). */
function torusPatch(R: number, r: number, gamma: number, v1: number, v2: number): BrepData {
  const b = new BrepBuilder();
  const s = b.addSurface({ kind: 'torus', majorRadius: R, minorRadius: r, position: { origin: O, axis: Z, xDir: X } });
  const P = (u: number, v: number): V => [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u),
    r * Math.sin(v)];
  const vx = [[0, v1], [gamma, v1], [gamma, v2], [0, v2]].map(([u, v]) => b.addVertex({ point: P(u!, v!) }));
  const major = (v: number, start: number, end: number) => b.addEdge({ curve: parallel(b, R + r * Math.cos(v),
    r * Math.sin(v)), start, end, sameSense: true, range: [0, gamma] });
  const minor = (u: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'circle', radius: r,
    position: { origin: [R * Math.cos(u), R * Math.sin(u), 0], axis: [Math.sin(u), -Math.cos(u), 0],
      xDir: [Math.cos(u), Math.sin(u), 0] } }), start, end, sameSense: true, range: [v1, v2] });
  const e0 = major(v1, vx[0]!, vx[1]!), e1 = minor(gamma, vx[1]!, vx[2]!), e2 = major(v2, vx[3]!, vx[2]!);
  const e3 = minor(0, vx[0]!, vx[3]!);
  b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: e0, orientation: 'forward' }, { edge: e1, orientation: 'forward' }, { edge: e2, orientation: 'reversed' },
    { edge: e3, orientation: 'reversed' }] }] });
  return b.finish();
}

/**
 * A cone as a revolution of a segment: from (r0, 0, 0) to (r1, 0, h) about z (r0 = 0: from the axis, one pole), the
 * face between its two circles, or only the far one where r0 = 0: area pi (r0 + r1) s, s the slant.
 */
function revolvedSegment(r0: number, r1: number, h: number): BrepData {
  const b = new BrepBuilder();
  const d: V = [r1 - r0, 0, h], s = Math.hypot(...d);
  const line = b.addCurve({ kind: 'line', point: [r0, 0, 0], direction: [d[0] / s, 0, d[2] / s], magnitude: s });
  const surface = b.addSurface({ kind: 'revolution', curve: line, axisOrigin: O, axisDirection: Z });
  const ring = (r: number, z: number) => {
    const p = b.addVertex({ point: [r, 0, z] });
    return b.addEdge({ curve: parallel(b, r, z), start: p, end: p, sameSense: true, range: [0, 2 * PI] });
  };
  const loops: Loop[] = [{ kind: 'edge', bound: 'outer', coedges: [{ edge: ring(r1, h), orientation: 'reversed' }] }];
  if (r0 > 0) loops.push({ kind: 'edge', bound: 'outer', coedges: [{ edge: ring(r0, 0), orientation: 'forward' }] });
  b.addFace({ surface, sameSense: true, loops });
  return b.finish();
}

test('a revolved segment: from the axis (one pole, on the face\'s side), and a frustum (no pole)', { skip },
  async () => {
    for (const [r0, r1, h] of [[0, 2, 3], [0, 1, -0.5], [1, 2.5, 2], [3, 1, 4]] as const) {
      near(await measure(revolvedSegment(r0, r1, h)), PI * (r0 + r1) * Math.hypot(r1 - r0, h), `segment ${r0} ${r1} ${h}`);
    }
  });

/** The cone's sector beyond its apex (the other nappe, rho < 0), between the apex and v = vb: beta rho^2 / (2 sin a). */
function coneBeyondApex(r: number, a: number, beta: number, vb: number): BrepData {
  const b = new BrepBuilder();
  const s = b.addSurface({ kind: 'cone', radius: r, semiAngle: a, position: { origin: O, axis: Z, xDir: X } });
  const apex: V = [0, 0, -r / Math.tan(a)], rho = r + vb * Math.tan(a);
  // Its points at angle u + pi: rho is negative.
  const rim = (u: number): V => [rho * Math.cos(u), rho * Math.sin(u), vb];
  const A = b.addVertex({ point: apex }), P0 = b.addVertex({ point: rim(0) }), Pb = b.addVertex({ point: rim(beta) });
  const generator = (to: V, end: number) => {
    const d: V = [to[0] - apex[0], to[1] - apex[1], to[2] - apex[2]], L = Math.hypot(...d);
    const line = b.addCurve({ kind: 'line', point: apex, direction: [d[0] / L, d[1] / L, d[2] / L], magnitude: L });
    return b.addEdge({ curve: line, start: A, end, sameSense: true, range: [0, 1] });
  };
  const g0 = generator(rim(0), P0), gb = generator(rim(beta), Pb);
  const arc = b.addEdge({ curve: parallel(b, -rho, vb), start: P0, end: Pb, sameSense: true, range: [PI, PI + beta] });
  b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: arc, orientation: 'forward' }, { edge: gb, orientation: 'reversed' }, { edge: g0, orientation: 'forward' }] }] });
  return b.finish();
}

/**
 * Half a cylinder of radius r between z = z0 and z0 + h, u in [0, pi], its generator at u = pi through y = -1e-17
 * (the seam's other side by rounding, as real files have it): area pi r h.
 */
function halfCylinder(r: number, z0: number, h: number): BrepData {
  const b = new BrepBuilder();
  const s = b.addSurface({ kind: 'cylinder', radius: r, position: { origin: O, axis: Z, xDir: X } });
  const y = -1e-17;
  const v = [[r, 0, z0], [-r, y, z0], [-r, y, z0 + h], [r, 0, z0 + h]].map((p) => b.addVertex({ point: p as V }));
  const up = (x: number, yy: number, start: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'line',
    point: [x, yy, z0], direction: Z, magnitude: h }), start, end, sameSense: true, range: [0, 1] });
  const arc = (z: number, start: number, end: number) => b.addEdge({ curve: parallel(b, r, z), start, end,
    sameSense: true, range: [0, PI] });
  const e0 = arc(z0, v[0]!, v[1]!), e1 = up(-r, y, v[1]!, v[2]!), e2 = arc(z0 + h, v[3]!, v[2]!);
  const e3 = up(r, 0, v[0]!, v[3]!);
  b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: e0, orientation: 'forward' }, { edge: e1, orientation: 'forward' }, { edge: e2, orientation: 'reversed' },
    { edge: e3, orientation: 'reversed' }] }] });
  return b.finish();
}

/**
 * A quadrilateral on the plane z = 0 whose edges' lines miss their vertices (their ranges given): the loop runs each
 * line, then straight to the next one's start. Area: the polygon of the lines' ends, by the shoelace formula.
 */
function planeWithGaps(): { d: BrepData; area: number } {
  const b = new BrepBuilder();
  const s = b.addSurface({ kind: 'plane', position: { origin: [5, -3, 0], axis: Z, xDir: X } });
  const corners: V[] = [[0, 0, 0], [4, 0.5, 0], [3.5, 3, 0], [-0.5, 2.5, 0]];
  const off: V[] = [[0.01, -0.02, 0], [-0.015, 0.01, 0], [0.02, 0.012, 0], [-0.01, -0.018, 0]];
  const vs = corners.map((p) => b.addVertex({ point: p }));
  const ends: V[] = [];
  const coedges = corners.map((p, i) => {
    const q = corners[(i + 1) % 4]!, o = off[i]!, o2 = off[(i + 1) % 4]!;
    const a: V = [p[0] + o[0], p[1] + o[1], 0], c: V = [q[0] - o2[1], q[1] + o2[0], 0];
    ends.push(a, c);
    const d: V = [c[0] - a[0], c[1] - a[1], 0], L = Math.hypot(...d);
    const line = b.addCurve({ kind: 'line', point: a, direction: [d[0] / L, d[1] / L, 0], magnitude: L });
    return { edge: b.addEdge({ curve: line, start: vs[i]!, end: vs[(i + 1) % 4]!, sameSense: true, range: [0, 1] }),
      orientation: 'forward' as const };
  });
  b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges }] });
  let area = 0;
  for (let i = 0; i < ends.length; i++) {
    const p = ends[i]!, q = ends[(i + 1) % ends.length]!;
    area += (p[0] * q[1] - q[0] * p[1]) / 2;
  }
  return { d: b.finish(), area };
}

/** A torus band over u in [0, gamma], all of v: bounded by two minor circles, each winding v. */
function torusBand(R: number, r: number, gamma: number): BrepData {
  const b = new BrepBuilder();
  const s = b.addSurface({ kind: 'torus', majorRadius: R, minorRadius: r, position: { origin: O, axis: Z, xDir: X } });
  const ring = (u: number) => {
    const p = b.addVertex({ point: [(R + r) * Math.cos(u), (R + r) * Math.sin(u), 0] });
    return b.addEdge({ curve: b.addCurve({ kind: 'circle', radius: r, position: { origin: [R * Math.cos(u),
      R * Math.sin(u), 0], axis: [Math.sin(u), -Math.cos(u), 0], xDir: [Math.cos(u), Math.sin(u), 0] } }), start: p,
      end: p, sameSense: true, range: [0, 2 * PI] });
  };
  b.addFace({ surface: s, sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', coedges: [{ edge: ring(gamma), orientation: 'forward' }] },
    { kind: 'edge', bound: 'outer', coedges: [{ edge: ring(0), orientation: 'reversed' }] }] });
  return b.finish();
}

/**
 * A hemisphere of radius R as a revolution of a quarter circle from the equator (v = 0) up to the pole (v = pi/2):
 * one pole, at the profile's end, not its start; the cap above latitude v1: area 2 pi R^2 (1 - sin v1).
 */
function quarterCap(R: number, v1: number): BrepData {
  const b = new BrepBuilder();
  const circle = b.addCurve({ kind: 'circle', radius: R, position: { origin: O, axis: [0, -1, 0], xDir: X } });
  const quarter = b.addCurve({ kind: 'trimmed', basis: circle, trim1: { parameter: 0 }, trim2: { parameter: PI / 2 },
    sense: true, preference: 'parameter' });
  const s = b.addSurface({ kind: 'revolution', curve: quarter, axisOrigin: O, axisDirection: Z });
  const p = b.addVertex({ point: [R * Math.cos(v1), 0, R * Math.sin(v1)] });
  const e = b.addEdge({ curve: parallel(b, R * Math.cos(v1), R * Math.sin(v1)), start: p, end: p, sameSense: true,
    range: [0, 2 * PI] });
  b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: e, orientation: 'forward' }] }] });
  return b.finish();
}

test('a cone\'s sector beyond its apex (the other nappe)', { skip }, async () => {
  // Past a semi-angle of 45 degrees too, where a point on the other nappe has its foot on the near nappe's generator
  // on that generator's own side of the apex.
  for (const [r, a, beta, vb] of [[1, PI / 6, 1, -4], [2, 0.3, 4, -10], [1, 1.2, 1, -2], [2, PI / 3, 2, -3]] as const) {
    const rho = r + vb * Math.tan(a);
    near(await measure(coneBeyondApex(r, a, beta, vb)), beta * rho * rho / (2 * Math.sin(a)), `cone ${r} ${a} ${vb}`);
  }
});

test('a vertex on the seam\'s other side by rounding', { skip }, async () => {
  near(await measure(halfCylinder(2, 1, 3)), PI * 2 * 3, 'half cylinder');
});

test('a plane face whose edges\' curves miss their vertices: the polygon of the curves\' ends, its error the gaps times '
  + 'the edges\' lengths', { skip }, async () => {
  const { d, area } = planeWithGaps();
  using o = new Oracle(await init(), d.buffer);
  const m = o.face(0), bound = gapBound(d, 0, o);
  assert.ok(m.area.status === 'ok' && Math.abs(m.area.value - area) <= 1e-9 * area, JSON.stringify(m));
  assert.ok(bound > 0 && Math.abs(m.boundary - bound) <= 1e-9 * bound, `${m.boundary} vs ${bound}`);
  assert.ok(m.area.error >= m.boundary && m.area.error - m.boundary <= 1e-9 * area, JSON.stringify(m));
  assert.equal(trusted(m, 1e-3), m.area.error <= 1e-3 * area);
  assert.ok(!trusted(m, 1e-6));
});

/**
 * A face flagged winds: no area, flux or moments (unsupported, with the reason), since the term the method leaves out
 * is in no error; its perimeter still measured.
 */
async function refusedWinds(d: BrepData, what: string): Promise<void> {
  using o = new Oracle(await init(), d.buffer);
  const m = o.face(0);
  assert.ok(m.flags.includes('winds'), `${what}: ${JSON.stringify(m)}`);
  assert.equal(trusted(m, 1e-6), false);
  assert.ok(m.area.status === 'unsupported' && Number.isNaN(m.area.value) && m.area.error === Infinity
    && Number.isNaN(m.boundary) && /winds a period/.test(m.why), `${what}: ${JSON.stringify(m)}`);
  assert.ok(m.perimeter.status === 'ok' && m.perimeter.value > 0, `${what}: ${JSON.stringify(m)}`);
  const c: [number, number, number] = [1, 2, 3];
  for (const e of [...o.faceMoments(0, { center: c, degree: 1 }).map((x) => x.n).flat(), ...o.faceFlux(0, c),
    ...o.faceAndFlux(0, c).flux ?? []]) {
    assert.ok(e.status === 'unsupported' && Number.isNaN(e.value), `${what}: ${JSON.stringify(e)}`);
  }
}

/**
 * A face whose loops wind a period and whose area takes the seam's term: flagged winds, the area `expected` within
 * 1e-9, its error under 1e-8 and covering the difference, trusted; flux and moments still refused (their seam's term
 * isn't taken).
 */
async function seamArea(d: BrepData, expected: number, what: string): Promise<void> {
  using o = new Oracle(await init(), d.buffer);
  const m = o.face(0);
  assert.ok(m.flags.includes('winds') && m.flags.every((f) => f === 'winds' || f === 'projectedBoundary'),
    `${what}: ${JSON.stringify(m)}`);
  assert.ok(m.area.status === 'ok' && m.area.error <= 1e-8 * expected, `${what}: ${JSON.stringify(m)}`);
  const off = Math.abs(m.area.value - expected);
  assert.ok(off <= 1e-9 * expected && off <= m.area.error + 4e-16 * expected,
    `${what}: ${m.area.value} vs ${expected} (+/- ${m.area.error})`);
  assert.ok(trusted(m, 1e-6), what);
  const c: [number, number, number] = [1, 2, 3];
  for (const e of [...o.faceMoments(0, { center: c, degree: 1 }).map((x) => x.n).flat(), ...o.faceFlux(0, c)]) {
    assert.ok(e.status === 'unsupported' && Number.isNaN(e.value), `${what}: ${JSON.stringify(e)}`);
  }
}

test('a torus face whose loops wind its minor circle: the seam\'s term, its area the band\'s (Pappus), or the '
  + 'complement\'s against its sense', { skip }, async () => {
  // Between the meridians at u = 0 and u = gamma, 2 pi r R gamma: a narrow band, one past half the torus.
  for (const gamma of [1.2, 4.5]) {
    const d = torusBand(3, 1, gamma);
    await seamArea(d, 2 * PI * 3 * gamma, `gamma ${gamma}`);
    d.face.sameSense[0] = 0;
    await seamArea(d, 2 * PI * 3 * (2 * PI - gamma), `gamma ${gamma} against its sense`);
  }
});

test('a torus face with one loop round its minor circle (its windings not cancelling): flagged winds, its area '
  + 'refused', { skip }, async () => {
  const d = torusBand(3, 1, 1.2);
  // (Its first loop alone: the region it bounds on the torus is no face.)
  d.face.loopCount[0] = 1;
  await refusedWinds(d, 'one loop');
});

test('a revolution with one pole at its bounded profile\'s end', { skip }, async () => {
  for (const v1 of [0.2, 1.1]) near(await measure(quarterCap(2, v1)), 2 * PI * 4 * (1 - Math.sin(v1)), `cap ${v1}`);
});

test('faces bounded by nothing on open surfaces of revolution and extrusion', { skip }, async () => {
  const b = new BrepBuilder();
  // Revolutions of an unbounded profile (a line) and of a bounded one off the axis (a quarter of a circle).
  const line = b.addCurve({ kind: 'line', point: [1, 0, 0], direction: [0.6, 0, 0.8], magnitude: 2 });
  b.addFace({ surface: b.addSurface({ kind: 'revolution', curve: line, axisOrigin: O, axisDirection: Z }),
    sameSense: true, loops: [] });
  const circle = b.addCurve({ kind: 'circle', radius: 1, position: { origin: [3, 0, 0], axis: [0, -1, 0], xDir: X } });
  const arc = b.addCurve({ kind: 'trimmed', basis: circle, trim1: { parameter: 0 }, trim2: { parameter: PI / 2 },
    sense: true, preference: 'parameter' });
  b.addFace({ surface: b.addSurface({ kind: 'revolution', curve: arc, axisOrigin: O, axisDirection: Z }),
    sameSense: true, loops: [] });
  b.addFace({ surface: b.addSurface({ kind: 'extrusion', curve: parallel(b, 1, 0), direction: Z, magnitude: 2 }),
    sameSense: true, loops: [] });
  const d = b.finish();
  for (const f of [0, 1, 2]) {
    const m = await measure(d, f);
    assert.deepEqual([m.flags, m.area.value], [['noLoops'], 0], JSON.stringify(m));
  }
});

test('an edge run against its curve has its length', { skip }, async () => {
  const b = new BrepBuilder();
  const p = b.addVertex({ point: [0, 0, 0] }), q = b.addVertex({ point: [3, 0, 0] });
  const line = b.addCurve({ kind: 'line', point: [0, 0, 0], direction: X, magnitude: 3 });
  b.addEdge({ curve: line, start: q, end: p, sameSense: false, range: [1, 0] });
  using o = new Oracle(await init(), b.finish().buffer);
  const L = o.edgeLength(0);
  assert.equal(L.status, 'ok');
  assert.ok(Math.abs(L.value - 3) <= 1e-12, JSON.stringify(L));
});

test('a face item in no shell is loose; one a shell uses too isn\'t', { skip }, async () => {
  const loose = await measure(lune(2, 1, false, false, (b, face) => b.addItem({ kind: 'face', ref: face })));
  assert.deepEqual(loose.flags, ['loose']);
  const used = await measure(lune(2, 1, false, false, (b, face) => {
    b.addItem({ kind: 'face', ref: face });
    // (The builder keeps a shell only where a body uses it.)
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  }));
  assert.deepEqual(used.flags, []);
});

/**
 * A hemisphere bounded by one great circle through both poles (the circle's crossings of the axis inside its one
 * edge, where u jumps by pi): area 2 pi R^2. The circle in the plane at angle phi through the axis, from (and to) a
 * vertex at height z0.
 */
function greatCircleHemisphere(R: number, phi: number, start: number): BrepData {
  const b = new BrepBuilder();
  const s = sphereSurface(b, R, false);
  const x: V = [Math.cos(phi), Math.sin(phi), 0];
  const circle = b.addCurve({ kind: 'circle', radius: R, position: { origin: O, axis: [Math.sin(phi), -Math.cos(phi), 0],
    xDir: x } });
  const p = b.addVertex({ point: [R * Math.cos(start) * x[0], R * Math.cos(start) * x[1], R * Math.sin(start)] });
  const e = b.addEdge({ curve: circle, start: p, end: p, sameSense: true, range: [start, start + 2 * PI] });
  b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: e, orientation: 'forward' }] }] });
  return b.finish();
}

test('a hemisphere bounded by a great circle through both poles', { skip }, async () => {
  for (const [phi, start] of [[0, 0], [1, 0.4], [2.5, PI / 2], [4, -2]] as const) {
    near(await measure(greatCircleHemisphere(3, phi, start)), 2 * PI * 9, `hemisphere ${phi} ${start}`, 4 * PI * 9);
  }
});

test('a sphere\'s lune, pole to pole, elementary and as a revolution', { skip }, async () => {
  for (const revolution of [false, true]) {
    for (const fromPole of [false, true]) {
      for (const alpha of [0.7, 2, 4]) {
        const m = await measure(lune(2, alpha, revolution, fromPole));
        assert.equal(m.method, revolution ? 'revolution' : 'closedForm');
        near(m, 2 * 4 * alpha, `lune ${alpha}${revolution ? ' (revolution)' : ''}${fromPole ? ' from the pole' : ''}`,
          16 * PI);
      }
    }
  }
});

test('a sphere\'s zone and caps, with the pole on either side, elementary and as a revolution', { skip }, async () => {
  const R = 2, v1 = -0.5, v2 = 0.8, s1 = Math.sin(v1), s2 = Math.sin(v2);
  for (const revolution of [false, true]) {
    const at = revolution ? ' (revolution)' : '';
    const whole = 4 * PI * R * R;
    near(await measure(band(R, v1, v2, 'zone', revolution)), 2 * PI * R * R * (s2 - s1), `zone${at}`, whole);
    near(await measure(band(R, v1, v2, 'north', revolution)), 2 * PI * R * R * (1 - s1), `north cap${at}`, whole);
    near(await measure(band(R, v1, v2, 'south', revolution)), 2 * PI * R * R * (1 + s2), `south cap${at}`, whole);
  }
});

test('a cone\'s sector from its apex', { skip }, async () => {
  for (const [r, a, beta] of [[1, PI / 6, 1], [2, 0.3, 5], [0.5, 1.2, 2.5]] as const) {
    near(await measure(coneSector(r, a, beta)), beta * r * r / (2 * Math.sin(a)), `cone ${r} ${a} ${beta}`);
  }
});

test('a torus patch across v = pi, and one not across it', { skip }, async () => {
  for (const [v1, v2] of [[2.5, 3.8], [-3.6, -2.2], [0.2, 1.4]] as const) {
    const R = 3, r = 1, gamma = 1.3;
    near(await measure(torusPatch(R, r, gamma, v1, v2)), r * gamma * (R * (v2 - v1) + r * (Math.sin(v2) - Math.sin(v1))),
      `torus ${v1}..${v2}`);
  }
});

/**
 * A torus face between two whole parallels at v1 and v2 (each winding u): the band v in [v1, v2] with `up` (v1's
 * forward, v2's reversed), else the rest, v in [v2, v1 + 2 pi]; its sense `sameSense`.
 */
function torusParallels(R: number, r: number, v1: number, v2: number, up: boolean, sameSense = true): BrepData {
  const b = new BrepBuilder();
  const s = b.addSurface({ kind: 'torus', majorRadius: R, minorRadius: r, position: { origin: O, axis: Z, xDir: X } });
  const ring = (v: number) => {
    const p = b.addVertex({ point: [R + r * Math.cos(v), 0, r * Math.sin(v)] });
    return b.addEdge({ curve: parallel(b, R + r * Math.cos(v), r * Math.sin(v)), start: p, end: p, sameSense: true,
      range: [0, 2 * PI] });
  };
  const e1 = ring(v1), e2 = ring(v2);
  b.addFace({ surface: s, sameSense, loops: [
    { kind: 'edge', bound: 'outer', coedges: [{ edge: e1, orientation: up ? 'forward' : 'reversed' }] },
    { kind: 'edge', bound: 'outer', coedges: [{ edge: e2, orientation: up ? 'reversed' : 'forward' }] }] });
  return b.finish();
}

test('a torus band between two parallels, bounded both ways (each loop\'s v a turn off the other\'s or not)', { skip },
  async () => {
    // Over v in [a, b], all of u, n outward (sense true): dA = r (R + r cos v) du dv, n_z = sin v, z = r sin v. Area
    // 2 pi r [R v + r sin v]; int n_z 2 pi r [-R cos v - r cos^2 v / 2]; int z n_z 2 pi r^2 [R (v/2 - sin 2v / 4) + r
    // sin^3 v / 3]; the others 0 by symmetry. With sense false, the region is the other one, n turned.
    const R = 3, r = 1.25;
    const at = (f: (v: number) => number, a: number, b: number) => 2 * PI * (f(b) - f(a));
    const area = (v: number) => r * (R * v + r * Math.sin(v));
    const nz = (v: number) => r * (-R * Math.cos(v) - r * Math.cos(v) ** 2 / 2);
    const znz = (v: number) => r * r * (R * (v / 2 - Math.sin(2 * v) / 4) + r * Math.sin(v) ** 3 / 3);
    for (const [v1, v2] of [[0, PI], [PI, 2 * PI], [PI / 3, 2 * PI / 3], [-2, 2.5], [-PI / 2, PI / 2], [2, 3.5]]) {
      for (const up of [true, false]) {
        for (const sameSense of [true, false]) {
          const [a, b] = up === sameSense ? [v1!, v2!] : [v2!, v1! + 2 * PI], sign = sameSense ? 1 : -1;
          const d = torusParallels(R, r, v1!, v2!, up, sameSense), what = `torus ${v1}..${v2} ${up} ${sameSense}`;
          near(await measure(d), at(area, a, b), what);
          nearAll(await moments(d, O, 1), { '000': [0, 0, at(nz, a, b)], '001': [0, 0, at(znz, a, b)] }, sign,
            R * R * r * r * 2 * PI, what);
        }
      }
    }
  });

test('a torus patch against its sense (a loop not winding u) is flagged, measured as its loop runs',
  { skip }, async () => {
    // Over u in [0, g], v in [a, b], n as the loop runs (outward): n = (cos v cos u, cos v sin u, sin v), dA = r (R + r
    // cos v) du dv.
    const R = 3, r = 1, g = 1.3, a = 0.2, b = 1.4, w = (f: (v: number) => number) => f(b) - f(a);
    const d = torusPatch(R, r, g, a, b);
    const face = d.face.sameSense as unknown as Uint8Array;
    face[0] = 0;
    const m = await measure(d), A = r * g * w((v) => R * v + r * Math.sin(v));
    assert.deepEqual(m.flags, ['orientation']);
    assert.ok(Math.abs(m.area.value - A) <= 1e-9 * A, `${m.area.value} vs ${A}`);
    const c = r * w((v) => R * Math.sin(v) + r * (v / 2 + Math.sin(2 * v) / 4));
    // (z n too: the whole torus's int n is 0, its int z n_z isn't.)
    const cz = r * r * w((v) => R * Math.sin(v) ** 2 / 2 - r * Math.cos(v) ** 3 / 3);
    nearAll(await moments(d, O, 1), { '000': [Math.sin(g) * c, (1 - Math.cos(g)) * c,
      g * r * w((v) => -R * Math.cos(v) - r * Math.cos(v) ** 2 / 2)], '001': [Math.sin(g) * cz, (1 - Math.cos(g)) * cz,
      g * r * r * w((v) => R * (v / 2 - Math.sin(2 * v) / 4) + r * Math.sin(v) ** 3 / 3)] }, 1, R * R * r,
    'reversed patch');
  });

test('the same areas as today\'s area oracle wherever it trusts a face', { skip }, async () => {
  const module = await init();
  const models: [string, BrepData][] = Object.entries(MODELS).map(([k, f]) => [k, (f as () => BrepBuilder)().finish()]);
  const dir = path.join(import.meta.dirname, '../../cad-brep/test/reference/fixtures');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.cbr')).sort()) {
    models.push([f, openBrep(new Uint8Array(fs.readFileSync(path.join(dir, f))))]);
  }
  let compared = 0;
  for (const [name, d] of models) {
    using o = new Oracle(module, d.buffer);
    for (let f = 0; f < rowCount(d, 'face'); f++) {
      const t = modelFaceArea(d, f);
      if (!trustedArea(t)) continue;
      const m = o.face(f);
      // (Not where its edges' curves miss their vertices: those gaps are in our error, not in area-oracle.ts's.)
      assert.ok(trusted(m) || vertexGaps(d, f) > 0, `${name} face ${f}: trusted by area-oracle.ts, not here: `
        + JSON.stringify(m));
      assert.ok(Math.abs(m.area.value - t.area) <= t.error + m.area.error + 1e-12 * t.area,
        `${name} face ${f}: ${m.area.value} vs ${t.area} (+/- ${t.error})`);
      assert.ok(Math.abs(m.perimeter.value - t.perimeter) <= 1e-6 * t.perimeter + vertexGaps(d, f),
        `${name} face ${f}: perimeter ${m.perimeter.value} vs ${t.perimeter}`);
      compared++;
    }
  }
  assert.ok(compared >= 180, `only ${compared} faces compared`);
});

test('a buffer that isn\'t a model, and a disposed oracle', { skip }, async () => {
  const module = await init();
  assert.throws(() => new Oracle(module, new Uint8Array(16)), /not a B-rep model/);
  const o = new Oracle(module, lune(1, 1, false).buffer);
  o.dispose();
  assert.throws(() => o.face(0), /disposed/);
});

/** Face `face`'s moments of degree at most `degree` about `center`, by exponent ("abc") then axis. */
async function moments(d: BrepData, center: V, degree: number, face = 0): Promise<Map<string, Estimate[]>> {
  using o = new Oracle(await init(), d.buffer);
  return new Map(o.faceMoments(face, { center, degree }).map((m) => [m.exponent.join(''), m.n]));
}

/**
 * Each estimate converged and within 1e-9 of scale of the value expected (sign times `expected`), its error estimate
 * within 1e-7 (the inner rule's is its last change, the coarser rule's error, so it overstates).
 */
function nearAll(got: Map<string, Estimate[]>, expected: Record<string, [number, number, number]>, sign: number,
  scale: number, what: string) {
  for (const [k, e] of Object.entries(expected)) {
    for (let j = 0; j < 3; j++) {
      const g = got.get(k)![j]!;
      assert.equal(g.status, 'ok', `${what} ${k}[${j}]: ${JSON.stringify(g)}`);
      assert.ok(Math.abs(g.value - sign * e[j]!) <= 1e-9 * scale && g.error <= 1e-7 * scale,
        `${what} ${k}[${j}]: ${g.value} vs ${sign * e[j]!} (+/- ${g.error})`);
    }
  }
}

test('moments of a sphere\'s zone and caps, elementary and as a revolution (both poles\' bases)', { skip },
  async () => {
    // Outward n = p / R dA, dA = R^2 cos v du dv, over v in [a, b]: int n_z = pi R^2 (sin^2 b - sin^2 a), int x n_x
    // = pi R^3 [sin v - sin^3 v / 3], int z n_z = 2 pi R^3 [sin^3 v / 3]; the others 0 by symmetry.
    const R = 2, v1 = -0.5, v2 = 0.8, c: V = [0.3, -0.2, 0.5];
    for (const revolution of [false, true]) {
      for (const [which, a, b] of [['zone', v1, v2], ['north', v1, PI / 2], ['south', -PI / 2, v2]] as const) {
        const s = (f: (x: number) => number) => f(Math.sin(b)) - f(Math.sin(a));
        const Nz = PI * R * R * s((x) => x * x), Mxx = PI * R ** 3 * s((x) => x - x ** 3 / 3);
        const Mzz = 2 * PI * R ** 3 * s((x) => x ** 3 / 3);
        const got = await moments(band(R, v1, v2, which, revolution), c, 1);
        const sign = Math.sign(got.get('100')![0]!.value);
        if (!revolution) assert.equal(sign, 1, `${which}: the sphere's n outward`);
        nearAll(got, { '000': [0, 0, Nz], '100': [Mxx, 0, -c[0] * Nz], '010': [0, Mxx, -c[1] * Nz],
          '001': [0, 0, Mzz - c[2] * Nz] }, sign, R ** 3, `${which}${revolution ? ' (revolution)' : ''}`);
      }
    }
  });

/** A double cone: the revolution of a degree-1 B-spline from (0, 0, 0) through (1, 0, 1) to (0, 0, 2), kinked. */
function doubleCone(ring?: { z: number; orientation: 'forward' | 'reversed' }): BrepData {
  const b = new BrepBuilder();
  const profile = b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1, 2], multiplicities: [2, 1, 2],
    poles: [[0, 0, 0], [1, 0, 1], [0, 0, 2]], closed: false, selfIntersect: null, form: 'unspecified' });
  const s = b.addSurface({ kind: 'revolution', curve: profile, axisOrigin: O, axisDirection: Z });
  const loops: Loop[] = [];
  if (ring) {
    const r = ring.z <= 1 ? ring.z : 2 - ring.z, p = b.addVertex({ point: [r, 0, ring.z] });
    const e = b.addEdge({ curve: parallel(b, r, ring.z), start: p, end: p, sameSense: true, range: [0, 2 * PI] });
    loops.push({ kind: 'edge', bound: 'outer', coedges: [{ edge: e, orientation: ring.orientation }] });
  }
  b.addFace({ surface: s, sameSense: true, loops });
  return b.finish();
}

test('moments across a profile\'s kink: a double cone, whole and either side of a ring', { skip }, async () => {
  // int p . n = 3 V = 2 pi over the whole; over the lower cone 0 (its apex at the origin: p . n = 0), over the upper
  // 2 pi (p . n / |n| = 2 n_z / |n| = sqrt 2, its area pi sqrt 2).
  const pn = (m: Map<string, Estimate[]>) => {
    for (const k of ['100', '010', '001']) {
      for (const e of m.get(k)!) assert.equal(e.status, 'ok', JSON.stringify(m.get(k)));
    }
    return m.get('100')![0]!.value + m.get('010')![1]!.value + m.get('001')![2]!.value;
  };
  assert.ok(Math.abs(Math.abs(pn(await moments(doubleCone(), O, 1))) - 2 * PI) <= 1e-9, 'the whole');
  for (const z of [0.5, 1.5]) {
    const sides = [];
    for (const orientation of ['forward', 'reversed'] as const) {
      sides.push(Math.abs(pn(await moments(doubleCone({ z, orientation }), O, 1))));
    }
    sides.sort((x, y) => x - y);
    // The ring's lower side holds the lower cone (and the upper's part below z, for z > 1).
    const upper = z <= 1 ? 2 * PI : 2 * PI * ((2 - z) ** 2);
    const expected = [2 * PI - upper, upper].sort((x, y) => x - y);
    for (let i = 0; i < 2; i++) {
      assert.ok(Math.abs(sides[i]! - expected[i]!) <= 1e-9, `ring ${z}: ${sides} vs ${expected}`);
    }
  }
});

/** A unit square on z = 0 at (x0, y0), its plane's origin there or at the model's. */
function square(x0: number, y0: number, planeAtOrigin = false): BrepData {
  const b = new BrepBuilder();
  const s = b.addSurface({ kind: 'plane', position: { origin: planeAtOrigin ? O : [x0, y0, 0], axis: Z, xDir: X } });
  const corners: V[] = [[x0, y0, 0], [x0 + 1, y0, 0], [x0 + 1, y0 + 1, 0], [x0, y0 + 1, 0]];
  const vs = corners.map((p) => b.addVertex({ point: p }));
  const coedges = corners.map((p, i) => {
    const q = corners[(i + 1) % 4]!, d: V = [q[0] - p[0], q[1] - p[1], 0];
    const line = b.addCurve({ kind: 'line', point: p, direction: d, magnitude: 1 });
    return { edge: b.addEdge({ curve: line, start: vs[i]!, end: vs[(i + 1) % 4]!, sameSense: true, range: [0, 1] }),
      orientation: 'forward' as const };
  });
  b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges }] });
  return b.finish();
}

test('moments of a face far from the origin, about a point of it: within its points\' rounding', { skip }, async () => {
  // About its corner: int n_z = 1, int x n_z = int y n_z = 1/2, int x^2 n_z = 1/3, int x y n_z = 1/4; z n_z and x z
  // n_z are 0 on the face whatever n, so their tolerances come from near it, not their values.
  for (const [far, planeAtOrigin] of [[0, false], [1e6, false], [1e8, false], [1e6, true], [1e8, true]] as const) {
    const got = await moments(square(far, -far, planeAtOrigin), [far, -far, 0], 2);
    const allowed = Math.max(1e-9, 1e3 * Number.EPSILON * far);
    const expected = [['000', 1], ['100', 0.5], ['010', 0.5], ['200', 1 / 3], ['110', 0.25], ['020', 1 / 3],
      ['001', 0], ['101', 0]] as const;
    for (const [k, v] of expected) {
      const e = got.get(k)![2]!;
      const what = `${far}${planeAtOrigin ? ' (its plane at the origin)' : ''} ${k}`;
      assert.equal(e.status, 'ok', `${what}: ${JSON.stringify(e)}`);
      assert.ok(Math.abs(e.value - v) <= allowed, `${what}: ${e.value} vs ${v}`);
    }
  }
});

test('faceFlux: faceMoments\' degree-1 x n_x, y n_y, z n_z, the same bits (each component integrated alone)',
  { skip }, async () => {
    const c: V = [0.3, -0.2, 0.5];
    const models: [string, BrepData][] = [['a zone', band(2, -0.5, 0.8, 'zone', false)],
      ['a cap as a revolution', band(2, -0.5, 0.8, 'north', true)], ['a double cone', doubleCone()],
      ['a square', square(0, 0)]];
    for (const [what, d] of models) {
      using o = new Oracle(await init(), d.buffer);
      const m = o.faceMoments(0, { center: c, degree: 1 }).slice(1), x = o.faceFlux(0, c);
      assert.deepEqual(x, [m[0]!.n[0], m[1]!.n[1], m[2]!.n[2]], what);
      assert.ok(x.every((e) => e.status === 'ok'), what);
    }
    // The default centre is the origin.
    using o = new Oracle(await init(), square(0, 0).buffer);
    assert.deepEqual(o.faceFlux(0), o.faceFlux(0, [0, 0, 0]));
    assert.notDeepEqual(o.faceFlux(0, [0, 0, 1]), o.faceFlux(0));
  });

test('faceMoments takes degrees 0 to MAX_MOMENT_DEGREE', { skip }, async () => {
  using o = new Oracle(await init(), square(0, 0).buffer);
  assert.equal(o.faceMoments(0, { degree: MAX_MOMENT_DEGREE }).length, 35);
  assert.throws(() => o.faceMoments(0, { degree: MAX_MOMENT_DEGREE + 1 }), /degree/);
  assert.throws(() => o.faceMoments(0, { degree: 1.5 }), /degree/);
});

test('the vector area of a cone\'s sector beyond its apex: int n dA = 1/2 oint p x dp', { skip }, async () => {
  const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  for (const [r, a, beta, vb] of [[1, PI / 6, 1, -4], [2, 0.3, 4, -10]] as const) {
    const rho = r + vb * Math.tan(a), apex: V = [0, 0, -r / Math.tan(a)], R = -rho;
    const rim = (u: number): V => [rho * Math.cos(u), rho * Math.sin(u), vb];
    // The loop: the arc (radius -rho, angles pi to pi + beta), its generator back to the apex, the other out to P0.
    const arc: V = [-vb * R * (Math.sin(PI + beta) - Math.sin(PI)), vb * R * (Math.cos(PI + beta) - Math.cos(PI)),
      R * R * beta];
    const sum = [arc, cross(rim(beta), apex), cross(apex, rim(0))].reduce((x, y) => [x[0] + y[0], x[1] + y[1],
      x[2] + y[2]] as V);
    const half = sum.map((x) => x / 2) as V;
    const n = (await moments(coneBeyondApex(r, a, beta, vb), O, 0)).get('000')!;
    const sign = Math.sign(n[2]!.value) * Math.sign(half[2]);
    const scale = Math.hypot(...half);
    for (let j = 0; j < 3; j++) {
      assert.equal(n[j]!.status, 'ok');
      assert.ok(Math.abs(n[j]!.value - sign * half[j]!) <= 1e-9 * scale,
        `cone ${r} ${a} ${vb} [${j}]: ${n[j]!.value} vs ${sign * half[j]!}`);
    }
  }
});

/** A patch of a sphere over u in [0, alpha], v in [a, b]: two parallels and two meridians, none winding the axis. */
function spherePatch(R: number, alpha: number, a: number, b: number, revolution: boolean): BrepData {
  const bb = new BrepBuilder();
  const s = sphereSurface(bb, R, revolution);
  const P = (u: number, v: number): V => [R * Math.cos(v) * Math.cos(u), R * Math.cos(v) * Math.sin(u),
    R * Math.sin(v)];
  const vx = [[0, a], [alpha, a], [alpha, b], [0, b]].map(([u, v]) => bb.addVertex({ point: P(u!, v!) }));
  const par = (v: number, start: number, end: number) => bb.addEdge({ curve: parallel(bb, R * Math.cos(v),
    R * Math.sin(v)), start, end, sameSense: true, range: [0, alpha] });
  const mer = (u: number, start: number, end: number) => bb.addEdge({ curve: meridian(bb, R, u), start, end,
    sameSense: true, range: [a, b] });
  const e0 = par(a, vx[0]!, vx[1]!), e1 = mer(alpha, vx[1]!, vx[2]!), e2 = par(b, vx[3]!, vx[2]!);
  const e3 = mer(0, vx[0]!, vx[3]!);
  bb.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: e0, orientation: 'forward' }, { edge: e1, orientation: 'forward' }, { edge: e2, orientation: 'reversed' },
    { edge: e3, orientation: 'reversed' }] }] });
  return bb.finish();
}

test('the vector area of sphere patches not winding the axis, south, across and north of the equator', { skip },
  async () => {
    // int n dA, n = (cos v cos u, cos v sin u, sin v) R^2 cos v: x R^2 sin alpha [v / 2 + sin 2v / 4], y R^2 (1 - cos
    // alpha) [...], z R^2 alpha [sin^2 v / 2].
    const R = 1.5;
    for (const revolution of [false, true]) {
      for (const [alpha, a, b] of [[1.2, -1.3, -0.4], [2.5, -0.6, 0.9], [4, 0.2, 1.4]] as const) {
        const w = (v: number) => v / 2 + Math.sin(2 * v) / 4, c2 = w(b) - w(a);
        const s2 = (Math.sin(b) ** 2 - Math.sin(a) ** 2) / 2;
        const got = await moments(spherePatch(R, alpha, a, b, revolution), O, 0);
        const expected: [number, number, number] = [R * R * Math.sin(alpha) * c2, R * R * (1 - Math.cos(alpha)) * c2,
          R * R * alpha * s2];
        const sign = Math.sign(got.get('000')![1]!.value);
        nearAll(got, { '000': expected }, sign, R * R, `patch ${alpha} ${a}..${b}${revolution ? ' (revolution)' : ''}`);
      }
    }
  });

test('faceAndFlux: on a free-form face faceFlux\'s bits and face\'s measure from one pass (its area within rounding), '
  + 'the area unsigned and flagged where the loops run against the face\'s sense', { skip }, async () => {
  const c: V = [0.3, -0.2, 0.5];
  const same = (a: FaceMeasure, b: FaceMeasure, what: string) => {
    const { area: aa, ...ra } = a, { area: ab, ...rb } = b;
    assert.deepEqual(ra, rb, what);
    assert.equal(aa.status, ab.status, what);
    assert.ok(Math.abs(aa.value - ab.value) <= 1e-12 * ab.value, `${what}: ${aa.value} against ${ab.value}`);
    assert.ok(Math.abs(aa.error - ab.error) <= 1e-6 * ab.error + 1e-15, `${what}: ${aa.error} against ${ab.error}`);
  };
  for (const flip of [false, true]) {
    const d = bsplineCylinder(line2([1, 0], [0, 1])).finish();
    // (Its loops then run against its sense: face reports the area's size with the orientation flag, as the healing
    // faces step reads it.)
    if (flip) d.face.sameSense[0] = 0;
    using o = new Oracle(await init(), d.buffer);
    const m = o.face(0), x = o.faceFlux(0, c), both = o.faceAndFlux(0, c), what = flip ? 'flipped' : 'as built';
    assert.equal(m.method, 'freeForm');
    assert.deepEqual(both.flux, x, what);
    assert.ok(x.every((e) => e.status === 'ok'), what);
    same(both.measure, m, what);
    assert.ok(both.measure.area.value > 0, what);
    assert.equal(both.measure.flags.includes('orientation'), flip, what);
  }
  // Elsewhere the measure alone, its bits face's, and no flux (the shells step takes it where it needs it).
  for (const [what, d] of [['a square', square(0, 0)], ['a double cone', doubleCone()]] as const) {
    using o = new Oracle(await init(), d.buffer);
    assert.deepEqual(o.faceAndFlux(0, c), { measure: o.face(0) }, what);
  }
});

/**
 * A band round a tube between two of its profile's circles: the revolution about z of a circle of radius r centred
 * R from the axis (in the xz plane), between the angles u0 and u0 + gamma; each loop a closed profile circle, the two
 * winding the profile's period opposite ways (their sum none). Area r gamma 2 pi R. As a torus too (`torus`).
 */
function tubeBand(R: number, r: number, gamma: number, torus = false, u0 = 0): BrepData {
  const b = new BrepBuilder();
  const surface = torus
    ? b.addSurface({ kind: 'torus', majorRadius: R, minorRadius: r, position: { origin: O, axis: Z, xDir: X } })
    : b.addSurface({ kind: 'revolution', axisOrigin: O, axisDirection: Z,
      curve: b.addCurve({ kind: 'circle', radius: r, position: { origin: [R, 0, 0], axis: [0, -1, 0], xDir: X } }) });
  const ring = (u: number) => {
    const c: V = [R * Math.cos(u), R * Math.sin(u), 0], x: V = [Math.cos(u), Math.sin(u), 0];
    const p = b.addVertex({ point: [c[0] + r * x[0], c[1] + r * x[1], 0] });
    return b.addEdge({ curve: b.addCurve({ kind: 'circle', radius: r, position: { origin: c,
      axis: [Math.sin(u), -Math.cos(u), 0], xDir: x } }), start: p, end: p, sameSense: true, range: [0, 2 * PI] });
  };
  b.addFace({ surface, sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', coedges: [{ edge: ring(u0), orientation: 'reversed' }] },
    { kind: 'edge', bound: 'outer', coedges: [{ edge: ring(u0 + gamma), orientation: 'forward' }] }] });
  return b.finish();
}

test('a band round a tube between two profile circles (loops winding the profile opposite ways): flagged winds, its '
  + 'area the seam\'s term (Pappus), as a revolution and as a torus', { skip }, async () => {
  // (The method's H du is nothing along a loop winding v, u constant there: all of the band's area is the seam's
  // term. Narrow and far from the axis as bug30790's bands, about 0.38 mm^2; across u's seam; past half a turn.)
  for (const torus of [false, true]) {
    for (const [R, r, gamma, u0] of [[10, 0.2, 0.3, 0], [400, 0.15, 1e-3, 0], [10, 0.2, 0.3, -0.1],
      [10, 0.2, 5, 1]] as const) {
      const what = `${torus ? 'torus' : 'revolution'} R ${R} r ${r} gamma ${gamma} from ${u0}`;
      const d = tubeBand(R, r, gamma, torus, u0);
      await seamArea(d, 2 * PI * r * R * gamma, what);
      d.face.sameSense[0] = 0;
      await seamArea(d, 2 * PI * r * R * (2 * PI - gamma), `${what}, against its sense`);
    }
  }
});

/**
 * A band round a tube as tubeBand's (a revolution, or a torus), its first loop stepped: from u = a, along the inner
 * parallel (v = pi) to a + delta, the profile's lower half there down to v = 0, back along the outer parallel (v = 0)
 * and up the profile's upper half at a; the other loop the profile circle at a + gamma. The loop starts on the inner
 * parallel, so its start's u isn't its first piece's end's. Area: each half of the profile pi R r of J (the sines
 * cancel), so pi R r (2 gamma - delta).
 */
function steppedBand(R: number, r: number, a: number, gamma: number, delta: number, torus: boolean): BrepData {
  const b = new BrepBuilder();
  const surface = torus
    ? b.addSurface({ kind: 'torus', majorRadius: R, minorRadius: r, position: { origin: O, axis: Z, xDir: X } })
    : b.addSurface({ kind: 'revolution', axisOrigin: O, axisDirection: Z,
      curve: b.addCurve({ kind: 'circle', radius: r, position: { origin: [R, 0, 0], axis: [0, -1, 0], xDir: X } }) });
  const at = (u: number, t: number): V => [(R + r * Math.cos(t)) * Math.cos(u), (R + r * Math.cos(t)) * Math.sin(u),
    r * Math.sin(t)];
  const meridian = (u: number) => b.addCurve({ kind: 'circle', radius: r, position: { origin: [R * Math.cos(u),
    R * Math.sin(u), 0], axis: [Math.sin(u), -Math.cos(u), 0], xDir: [Math.cos(u), Math.sin(u), 0] } });
  const parallel = (rho: number) => b.addCurve({ kind: 'circle', radius: rho, position: { origin: O, axis: Z,
    xDir: X } });
  const p0 = b.addVertex({ point: at(a, 0) }), p1 = b.addVertex({ point: at(a + delta, 0) });
  const p2 = b.addVertex({ point: at(a + delta, PI) }), p3 = b.addVertex({ point: at(a, PI) });
  const p4 = b.addVertex({ point: at(a + gamma, 0) });
  const edge = (curve: number, start: number, end: number, range: [number, number]) =>
    b.addEdge({ curve, start, end, sameSense: true, range });
  b.addFace({ surface, sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', coedges: [
      { edge: edge(parallel(R - r), p3, p2, [a, a + delta]), orientation: 'forward' },
      { edge: edge(meridian(a + delta), p1, p2, [0, PI]), orientation: 'reversed' },
      { edge: edge(parallel(R + r), p0, p1, [a, a + delta]), orientation: 'reversed' },
      { edge: edge(meridian(a), p3, p0, [PI, 2 * PI]), orientation: 'reversed' }] },
    { kind: 'edge', bound: 'outer', coedges: [{ edge: edge(meridian(a + gamma), p4, p4, [0, 2 * PI]),
      orientation: 'forward' }] }] });
  return b.finish();
}

test('a band round a tube with a stepped loop (its start\'s u not its first piece\'s end\'s): the seam\'s term at the '
  + 'loop\'s start, as a revolution and as a torus', { skip }, async () => {
  for (const torus of [false, true]) {
    const [R, r, a, gamma, delta] = [10, 0.2, 0.5, 1, 0.3];
    await seamArea(steppedBand(R, r, a, gamma, delta, torus), PI * R * r * (2 * gamma - delta),
      torus ? 'torus' : 'revolution');
  }
});

test('a band round a tube with one loop (its windings not cancelling): flagged winds, its area refused', { skip },
  async () => {
    for (const torus of [false, true]) {
      const d = tubeBand(10, 0.2, 0.3, torus);
      d.face.loopCount[0] = 1;
      await refusedWinds(d, torus ? 'torus' : 'revolution');
    }
  });

test('a B-spline cylinder face with one loop, once round it: flagged winds, its area refused', { skip }, async () => {
  // (A rational quadratic ring swept along z; the loop the circle at z = 1, no pole to close the face by.)
  const b = new BrepBuilder();
  const h = Math.SQRT1_2, ring = [[2, 0], [2, 2], [0, 2], [-2, 2], [-2, 0], [-2, -2], [0, -2], [2, -2], [2, 0]];
  const w = [1, h, 1, h, 1, h, 1, h, 1];
  const surface = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 0.25, 0.5, 0.75, 1],
    vKnots: [0, 5], uMultiplicities: [3, 2, 2, 2, 3], vMultiplicities: [2, 2],
    poles: ring.map(([x, y]) => [[x!, y!, 0], [x!, y!, 5]]), weights: w.map((x) => [x, x]), uClosed: true,
    vClosed: false, selfIntersect: false, form: 'unspecified' });
  const p = b.addVertex({ point: [2, 0, 1] });
  const e = b.addEdge({ curve: b.addCurve({ kind: 'circle', radius: 2, position: { origin: [0, 0, 1], axis: Z,
    xDir: X } }), start: p, end: p, sameSense: true, range: [0, 2 * PI] });
  b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [{ edge: e,
    orientation: 'forward' }] }] });
  await refusedWinds(b.finish(), 'B-spline');
});
