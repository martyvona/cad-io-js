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
import { type FaceMeasure, init, Oracle, trusted } from '../src/index.ts';

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
  for (const [r, a, beta, vb] of [[1, PI / 6, 1, -4], [2, 0.3, 4, -10]] as const) {
    const rho = r + vb * Math.tan(a);
    near(await measure(coneBeyondApex(r, a, beta, vb)), beta * rho * rho / (2 * Math.sin(a)), `cone ${r} ${a} ${vb}`);
  }
});

test('a vertex on the seam\'s other side by rounding', { skip }, async () => {
  near(await measure(halfCylinder(2, 1, 3)), PI * 2 * 3, 'half cylinder');
});

test('a plane face whose edges\' curves miss their vertices: the polygon of the curves\' ends', { skip }, async () => {
  const { d, area } = planeWithGaps();
  near(await measure(d), area, 'plane with gaps');
});

test('a torus face whose loops wind its minor circle is flagged', { skip }, async () => {
  const m = await measure(torusBand(3, 1, 1.2));
  assert.ok(m.flags.includes('winds'), JSON.stringify(m));
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
      assert.ok(trusted(m), `${name} face ${f}: trusted by area-oracle.ts, not here: ${JSON.stringify(m)}`);
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
