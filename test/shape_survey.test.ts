// corpus_checks/shape_survey.ts: triangle shapes against closed forms and the law of cosines, the bins, a face's
// triangles over several ranges, the sampled deviation against a sphere's exact distance, quantiles.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TessellationResult } from '../packages/cad-scene/src/index.ts';
import {
  ANGLE_BINS, ASPECT_BINS, DEVIATION_TRIANGLES, RATIO_BINS, addAngles, addShapes, angleBetween, angleBin, angleEdge,
  areaBin, aspectBin, aspectEdge, deviationBin, excessBin, faceAngles, faceDeviation, faceTriangles, freshAngles,
  freshShapes, quantile, ratioBin, triangleShape, type Inverter,
} from '../corpus_checks/shape_survey.ts';

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('triangleShape: closed forms (equilateral, right isosceles, 3-4-5, a needle, no area)', () => {
  const eq = triangleShape([0, 0, 0, 1, 0, 0, 0.5, Math.sqrt(3) / 2, 0], 0, 1, 2);
  near(eq.angle, 60, 1e-6), near(eq.aspect, 2 / Math.sqrt(3));
  const ri = triangleShape([0, 0, 0, 1, 0, 0, 0, 0, 1], 0, 1, 2);
  near(ri.angle, 45, 1e-9), near(ri.aspect, 2);
  const t345 = triangleShape([0, 0, 0, 4, 0, 0, 0, 3, 0], 2, 0, 1);
  near(t345.angle, Math.asin(3 / 5) * 180 / Math.PI), near(t345.aspect, 25 / 12);
  const needle = triangleShape([0, 0, 0, 100, 0, 0, 50, 0.01, 0], 0, 1, 2);
  near(needle.aspect, 1e4 / 1, 1e-6);
  assert.ok(needle.angle < 0.02);
  assert.deepEqual(triangleShape([0, 0, 0, 1, 1, 1, 2, 2, 2], 0, 1, 2), { angle: 0, aspect: Infinity });
  assert.deepEqual(triangleShape([1, 2, 3, 1, 2, 3, 1, 2, 3], 0, 1, 2), { angle: 0, aspect: Infinity });
});

test('triangleShape: the smallest angle by the law of cosines, the aspect by Heron, over random triangles', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let n = 0; n < 2000; n++) {
    const s = 10 ** (4 * rnd());
    const p = Array.from({ length: 9 }, () => s * rnd());
    const L = (i: number, j: number) => Math.hypot(p[3 * i]! - p[3 * j]!, p[3 * i + 1]! - p[3 * j + 1]!,
      p[3 * i + 2]! - p[3 * j + 2]!);
    const a = L(1, 2), b = L(2, 0), c = L(0, 1);
    const ang = (x: number, y: number, z: number) => Math.acos((y * y + z * z - x * x) / (2 * y * z)) * 180 / Math.PI;
    const min = Math.min(ang(a, b, c), ang(b, c, a), ang(c, a, b));
    const h = (a + b + c) / 2, area = Math.sqrt(Math.max(0, h * (h - a) * (h - b) * (h - c)));
    const r = triangleShape(p, 0, 1, 2);
    near(r.angle, min, 1e-6 * Math.max(1, 60 / Math.max(min, 1e-3)));
    near(r.aspect, Math.max(a, b, c) ** 2 / (2 * area), 1e-6 * r.aspect);
  }
});

test('bins: ends, an equilateral, a right isosceles, ratios and deviations by their bounds', () => {
  assert.equal(angleBin(0), 0), assert.equal(angleBin(60), ANGLE_BINS - 1), assert.equal(angleBin(0.49), 0);
  assert.equal(angleBin(0.5), 1);
  assert.equal(aspectBin(2 / Math.sqrt(3)), 1), assert.equal(aspectBin(2), 6), assert.equal(aspectBin(1e6),
    ASPECT_BINS - 1);
  assert.equal(aspectBin(Infinity), ASPECT_BINS - 1), assert.equal(aspectBin(NaN), ASPECT_BINS - 1);
  assert.equal(ratioBin(10, 10), 12), assert.equal(ratioBin(20, 10), 14), assert.equal(ratioBin(5, 10), 10);
  assert.equal(ratioBin(1, 1e6), 0), assert.equal(ratioBin(1e6, 1), RATIO_BINS - 1);
  assert.equal(ratioBin(0, 5), 0), assert.equal(ratioBin(5, 0), RATIO_BINS - 1);
  assert.equal(deviationBin(1), 3), assert.equal(deviationBin(1.0001), 4), assert.equal(deviationBin(1e9), 10);
});

/** A result over `p` with `faces` ranges [id, first triangle, triangles] on triangles `tri`. */
function result(p: number[], tri: number[], faces: [number | null, number, number][], origin = [0, 0, 0]) {
  return { origin, positions: new Float32Array(p), indices: new Uint32Array(tri),
    faces: faces.map(([entityId, t, n]) => ({ entityId, start: 3 * t, count: 3 * n })), diagnostics: [] } as
    unknown as TessellationResult;
}

test('faceTriangles and addShapes: a face of two ranges joined, empty and unnamed ranges left out, faces not asked',
  () => {
  const p = [0, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, Math.sqrt(3) / 2, 0];
  const r = result(p, [0, 1, 2, 0, 1, 3, 0, 1, 2, 0, 1, 3], [[5, 0, 1], [7, 1, 1], [5, 2, 0], [null, 2, 1], [5, 3, 1]]);
  const tris = faceTriangles(r);
  assert.deepEqual([...tris.keys()].sort(), [5, 7]);
  assert.deepEqual(tris.get(5), [0, 9]);
  const s = freshShapes();
  addShapes(r, tris, [5, 99], s);
  assert.equal(s.faces, 1), assert.equal(s.triangles, 2);
  // (In Float32 positions 45 and 60 degrees come out a rounding under, so either bin at each edge.)
  const at = (h: number[], k: number) => h[k - 1]! + h[k]!;
  assert.equal(at(s.angle, angleBin(45)), 1), assert.equal(at(s.angle, ANGLE_BINS - 1), 1);
  // (The face's worst: the right isosceles.)
  assert.equal(at(s.faceAngle, angleBin(45)), 1), assert.equal(at(s.faceAspect, aspectBin(2)), 1);
  assert.equal(s.faceAngle.reduce((a, b) => a + b), 1);
});

/**
 * A sphere of radius R about the origin as cad-geom's inverter would see it: (u, v) longitude and latitude, the
 * poles flagged; statuses `bad` at those points. Its normals are the outward unit vectors at (u, v).
 */
const sphere = (R: number, bad = new Set<number>()): Inverter & { calls: number[][] } => {
  const calls: number[][] = [];
  return {
    calls,
    surfaceInfo: () => ({ status: 'ok', u: [0, 2 * Math.PI], v: [-Math.PI / 2, Math.PI / 2] }),
    invertSurface(_row, pts) {
      calls.push(Array.from(pts));
      const n = pts.length / 3, distance = new Float64Array(n), statuses = new Uint8Array(n);
      const params = new Float64Array(2 * n), flags = new Uint8Array(n);
      for (let q = 0; q < n; q++) {
        const x = pts[3 * q]!, y = pts[3 * q + 1]!, z = pts[3 * q + 2]!, h = Math.hypot(x, y);
        distance[q] = Math.abs(Math.hypot(x, y, z) - R);
        params[2 * q] = Math.atan2(y, x), params[2 * q + 1] = Math.atan2(z, h);
        if (h < 1e-9 * R) flags[q] = 4;
        if (bad.has(q)) statuses[q] = 4, distance[q] = 1e9, params[2 * q] = params[2 * q + 1] = NaN;
      }
      return { status: 'ok', distance, statuses, params, flags };
    },
    surfaceNormal(_row, uv) {
      const n = uv.length / 2, values = new Float64Array(3 * n), statuses = new Uint8Array(n);
      for (let q = 0; q < n; q++) {
        const u = uv[2 * q]!, v = uv[2 * q + 1]!;
        values.set([Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)], 3 * q);
        if (!Number.isFinite(u + v)) statuses[q] = 4;
      }
      return { status: 'ok', values, statuses };
    },
  };
};

/**
 * The plane z = 0 as the inverter would see it: (u, v) = (x, y), the normal +z; flags `pole` at those points, no
 * normal (a status, a zero vector) at `noNormal`.
 */
const plane = (pole = new Set<number>(), noNormal = new Set<number>()): Inverter => ({
  surfaceInfo: () => ({ status: 'ok', u: [-1e3, 1e3], v: [-1e3, 1e3] }),
  invertSurface(_row, pts) {
    const n = pts.length / 3, params = new Float64Array(2 * n), flags = new Uint8Array(n);
    for (let q = 0; q < n; q++) params[2 * q] = pts[3 * q]!, params[2 * q + 1] = pts[3 * q + 1]!;
    for (const q of pole) flags[q] = 4;
    return { status: 'ok', distance: new Float64Array(n), statuses: new Uint8Array(n), params, flags };
  },
  surfaceNormal: (_row, uv) => ({ status: 'ok', values: new Float64Array(Array.from({ length: uv.length / 2 },
    (_, q) => (noNormal.has(q) ? [0, 0, 0] : [0, 0, 1])).flat()),
  statuses: new Uint8Array(Array.from({ length: uv.length / 2 }, (_, q) => (noNormal.has(q) ? 3 : 0))) }),
});

test('faceDeviation: the worst over centroids and sides\' middles against a sphere\'s distance, with the origin',
  () => {
  // An octant of a sphere of radius 10 in 4 triangles (one corner split), positions minus an origin.
  const R = 10, o = [3, -2, 5];
  const v = [[R, 0, 0], [0, R, 0], [0, 0, R], [R / Math.SQRT2, R / Math.SQRT2, 0]];
  const p = v.flatMap((x) => x.map((c, k) => c - o[k]!));
  const r = result(p, [0, 3, 2, 3, 1, 2], [[1, 0, 2]], o);
  const g = sphere(R);
  const d = faceDeviation(g, 0, r, faceTriangles(r).get(1)!, 1e-9);
  // Independently: each triangle's centroid and sides' middles in model space, |x| against R.
  let want = 0;
  for (const [a, b, c] of [[0, 3, 2], [3, 1, 2]]) {
    for (const [w0, w1, w2] of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
      const x = [0, 1, 2].map((k) => w0! * v[a!]![k]! + w1! * v[b!]![k]! + w2! * v[c!]![k]!);
      want = Math.max(want, R - Math.hypot(...x));
    }
  }
  near(d.worst, want, 1e-5), assert.equal(d.points, 8);
  // Points not inverted left out; none inverted gives NaN.
  assert.equal(faceDeviation(sphere(R, new Set([0, 1, 2, 3, 4, 5, 6, 7])), 0, r, [0, 3], 1e-9).points, 0);
  assert.ok(Number.isNaN(faceDeviation(sphere(R, new Set([0, 1, 2, 3, 4, 5, 6, 7])), 0, r, [0, 3], 1e-9).worst));
  const some = faceDeviation(sphere(R, new Set([0])), 0, r, [0, 3], 1e-9);
  assert.equal(some.points, 7);
  // A surface that can't be made: nothing asked.
  const none = { ...g, surfaceInfo: () => ({ status: 'unsupported', u: [0, 0], v: [0, 0] }) } as Inverter;
  assert.ok(Number.isNaN(faceDeviation(none, 0, r, [0, 3], 1e-9).worst));
});

test('faceDeviation: past DEVIATION_TRIANGLES, the largest triangles sampled', () => {
  // A fan of thin triangles on a plane z = 0 about the origin, one larger and off the sphere by its size.
  const n = DEVIATION_TRIANGLES + 30, p: number[] = [0, 0, 0], tri: number[] = [];
  for (let k = 0; k <= n; k++) p.push(Math.cos(k / n), Math.sin(k / n), 0);
  for (let k = 0; k < n; k++) tri.push(0, k + 1, k + 2);
  p.push(50, 0, 0, 0, 50, 0);
  tri.push(0, n + 2, n + 3);
  const r = result(p, tri, [[1, 0, n + 1]]);
  const g = sphere(1);
  faceDeviation(g, 0, r, faceTriangles(r).get(1)!, 1e-9);
  assert.equal(g.calls[0]!.length, DEVIATION_TRIANGLES * 4 * 3);
  // (The large triangle's centroid is among the points.)
  const c = [50 / 3, 50 / 3, 0], pts = g.calls[0]!;
  assert.ok(Array.from({ length: pts.length / 3 }, (_, q) => q).some((q) =>
    Math.abs(pts[3 * q]! - c[0]!) < 1e-4 && Math.abs(pts[3 * q + 1]! - c[1]!) < 1e-4));
});

test('quantile: by bin edges, empty NaN', () => {
  assert.ok(Number.isNaN(quantile([0, 0], 0.5, angleEdge)));
  assert.equal(quantile([1, 1, 2], 0.5, angleEdge), 1), assert.equal(quantile([1, 1, 2], 0.25, angleEdge), 0.5);
  assert.equal(quantile([1, 1, 2], 1, angleEdge), 1.5), assert.equal(quantile([0, 0, 3], 0, angleEdge), 1.5);
  assert.equal(aspectEdge(ASPECT_BINS - 1), Infinity), near(aspectEdge(19), 10);
});

test('angleBetween and the bins: right angles, near 0 and 180, zero vectors; excess and area by their bounds', () => {
  near(angleBetween([1, 0, 0], [0, 2, 0]), 90), near(angleBetween([1, 0, 0], [-3, 0, 0]), 180);
  near(angleBetween([1, 0, 0], [1, 1e-9, 0]), 1e-9 * 180 / Math.PI, 1e-20);
  near(angleBetween([1, 0, 0], [-1, 1e-9, 0]), 180 - 1e-9 * 180 / Math.PI, 1e-12);
  assert.ok(Number.isNaN(angleBetween([0, 0, 0], [1, 0, 0])));
  assert.equal(excessBin(0.5), 0), assert.equal(excessBin(1), 0), assert.equal(excessBin(1.01), 1);
  assert.equal(excessBin(179), 8), assert.equal(areaBin(0.001), 0), assert.equal(areaBin(0.002), 1);
  assert.equal(areaBin(1), 6);
});

test('faceAngles: a sphere octant against its exact normals, by the law of cosines, through the origin', () => {
  // The octant of radius 10 in 4 triangles, one corner split, as faceDeviation's test; positions minus an origin.
  const R = 10, o = [3, -2, 5];
  const v = [[R, 0, 0], [0, R, 0], [0, 0.6 * R, 0.8 * R], [R / Math.SQRT2, R / Math.SQRT2, 0], [0.8 * R, 0, 0.6 * R]];
  const p = v.flatMap((x) => x.map((c, k) => c - o[k]!));
  const tri = [0, 3, 4, 3, 2, 4, 3, 1, 2];
  const r = result(p, tri, [[1, 0, 3]], o);
  // Independently: the corners' normals are v / R; the facet's from float64 corners, outward.
  const deg = (x: number) => Math.acos(Math.max(-1, Math.min(1, x))) * 180 / Math.PI;
  const dot = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const want: number[] = [], spreads: number[] = [];
  for (let k = 0; k < tri.length; k += 3) {
    const n = [0, 1, 2].map((c) => v[tri[k + c]!]!.map((x) => x / R));
    const [A, B, C] = [0, 1, 2].map((c) => v[tri[k + c]!]!) as [number[], number[], number[]];
    const u = B.map((x, q) => x - A[q]!), w = C.map((x, q) => x - A[q]!);
    const f = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const L = Math.hypot(...f), fn = f.map((x) => x / L);
    assert.ok(dot(fn, A) > 0, 'outward');
    const sp = Math.max(deg(dot(n[0]!, n[1]!)), deg(dot(n[1]!, n[2]!)), deg(dot(n[2]!, n[0]!)));
    spreads.push(sp);
    want.push(Math.max(sp, ...n.map((m) => deg(dot(fn, m)))));
  }
  // (A limit between the triangles' angles, so some miss and some don't.)
  const lim = (Math.min(...want) + Math.max(...want)) / 2;
  const got = new Map<number, number>();
  const a = faceAngles(sphere(R), 0, r, faceTriangles(r).get(1)!, 1e-9, lim, (k, d) => got.set(k, d));
  assert.deepEqual([...got.keys()], [0, 3, 6]);
  want.forEach((w, i) => near(got.get(3 * i)!, w, 1e-4));
  near(a.worst, Math.max(...want), 1e-4);
  const over = want.filter((w) => w > lim).length;
  assert.ok(over > 0 && over < 3, `${want}`);
  assert.equal(a.missed, over), assert.equal(a.triangles, 3), assert.equal(a.excluded + a.unmeasured, 0);
  assert.equal(a.spread, spreads.filter((w) => w > lim).length);
  // The same face wound the other way: the same angles (the facet's normal taken on the side the face faces).
  const flipped = result(p, [0, 4, 3, 3, 4, 2, 3, 2, 1], [[1, 0, 3]], o);
  const back = faceAngles(sphere(R), 0, flipped, faceTriangles(flipped).get(1)!, 1e-9, lim);
  near(back.worst, a.worst, 1e-4), assert.equal(back.missed, a.missed);
  near(back.missedArea, a.missedArea, 1e-6 * a.area);
  // Areas: the missed ones', and the whole face's.
  const area = (k: number) => {
    const [A, B, C] = [0, 1, 2].map((c) => v[tri[k + c]!]!) as [number[], number[], number[]];
    const u = B.map((x, q) => x - A[q]!), w = C.map((x, q) => x - A[q]!);
    return Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2;
  };
  near(a.area, area(0) + area(3) + area(6), 1e-4);
  near(a.missedArea, want.reduce((s, w, i) => s + (w > lim ? area(3 * i) : 0), 0), 1e-4);
  // (Here each triangle's spread is its angle: the corners' normals of a coarse octant spread more than any facet
  // turns from them; the plane's case below misses by its facet alone.)
  assert.deepEqual(spreads.map((x, i) => Math.abs(x - want[i]!) < 1e-9), [true, true, true]);
  near(a.spreadArea, a.missedArea, 1e-12);
  // At a limit past the worst, nothing misses; just under it, the worst one does.
  assert.equal(faceAngles(sphere(R), 0, r, [0, 3, 6], 1e-9, a.worst + 1e-3).missed, 0);
  assert.ok(faceAngles(sphere(R), 0, r, [0, 3, 6], 1e-9, a.worst - 1e-3).missed >= 1);
  // At the worst exactly: past it, not at it.
  assert.equal(faceAngles(sphere(R), 0, r, [0, 3, 6], 1e-9, a.worst).missed, 0);
});

test('faceAngles: a facet tilted off its plane, a fold, a triangle of no area, a pole, corners not inverted', () => {
  // On z = 0: a triangle tilted 30 degrees about its side on the x axis (its third corner raised), one flat, one
  // flat but wound against the rest (a fold), one of no area.
  const t = Math.tan(Math.PI / 6);
  const p = [0, 0, 0, 1, 0, 0, 0, 1, t, 2, 0, 0, 2, 1, 0, 3, 0, 0, 4, 0, 0, 3, 1, 0];
  const tri = [0, 1, 2, 1, 3, 4, 3, 4, 7, 5, 3, 6];
  const r = result(p, tri, [[1, 0, 4]]);
  const got = new Map<number, number>();
  const a = faceAngles(plane(), 0, r, [0, 3, 6, 9], 1e-9, 15, (k, d) => got.set(k, d));
  near(got.get(0)!, 30, 1e-5), near(got.get(3)!, 0, 1e-9), near(got.get(6)!, 180, 1e-9), near(got.get(9)!, 0, 1e-9);
  assert.equal(a.missed, 2), near(a.worst, 180, 1e-9), assert.equal(a.spread, 0), assert.equal(a.spreadArea, 0);
  near(a.missedArea, 0.5 / Math.cos(Math.PI / 6) + 0.5, 1e-6);
  // Every corner at a pole: the triangles touching it left out, their area counted apart.
  const polar = faceAngles(plane(new Set([0])), 0, r, [0, 3, 6, 9], 1e-9, 15);
  assert.equal(polar.excluded, 1), assert.equal(polar.missed, 1);
  near(polar.excludedArea, 0.5 / Math.cos(Math.PI / 6), 1e-6);
  // A corner without a normal: left out as at a pole.
  const nn = faceAngles(plane(new Set(), new Set([0])), 0, r, [0, 3, 6, 9], 1e-9, 15);
  assert.equal(nn.excluded, 1), assert.equal(nn.missed, 1), assert.equal(nn.unmeasured, 0);
  // A corner not inverted: its triangles unmeasured (a pole beside it wins).
  const sph = sphere(10, new Set([1]));
  const s = result([10, 0, 0, 0, 10, 0, 0, 0, 10, 0, -10, 0], [0, 1, 2, 0, 2, 3], [[1, 0, 2]]);
  const b = faceAngles(sph, 0, s, [0, 3], 1e-9, 15);
  assert.equal(b.unmeasured, 0), assert.equal(b.excluded, 2);
  const c = faceAngles(sphere(10, new Set([1])), 0, result([10, 0, 0, 0, 10, 0, 0, 0.6, 0.8, 0, -10, 0].map((x, k) =>
    k === 7 || k === 8 ? 10 * x : x), [0, 1, 2, 0, 2, 3], [[1, 0, 2]]), [0, 3], 1e-9, 15);
  assert.equal(c.unmeasured, 1), assert.equal(c.excluded, 0), assert.equal(c.triangles, 2);
  assert.ok(c.unmeasuredArea > 0 && c.unmeasuredArea < c.area);
  // A surface that can't be made: every triangle unmeasured.
  const none = { ...plane(), surfaceInfo: () => ({ status: 'unsupported', u: [0, 0], v: [0, 0] }) } as Inverter;
  const d = faceAngles(none, 0, r, [0, 3, 6, 9], 1e-9, 15);
  assert.equal(d.unmeasured, 4), near(d.unmeasuredArea, d.area, 0), assert.equal(d.worst, 0);
});

test('addAngles: the sums, faces by worst excess and by area share, a face past it of no area', () => {
  const A = freshAngles();
  const f = (o: Partial<ReturnType<typeof faceAngles>>) => ({ triangles: 10, missed: 0, excluded: 0, unmeasured: 0,
    spread: 0, worst: 10, area: 4, missedArea: 0, spreadArea: 0, excludedArea: 0, unmeasuredArea: 0, ...o });
  addAngles(A, f({}), 15);
  addAngles(A, f({ missed: 2, spread: 1, worst: 17.5, missedArea: 0.2, spreadArea: 0.1, excluded: 1,
    excludedArea: 0.5, unmeasured: 3, unmeasuredArea: 0.25 }), 15);
  addAngles(A, f({ missed: 1, worst: 100, area: 0, missedArea: 0 }), 15);
  assert.equal(A.faces, 3), assert.equal(A.facesMissed, 2), assert.equal(A.facesSpread, 1);
  assert.equal(A.facesExcluded, 1), assert.equal(A.triangles, 30), assert.equal(A.missed, 3), assert.equal(A.spread, 1);
  assert.equal(A.excluded, 1), assert.equal(A.unmeasured, 3), assert.equal(A.area, 8);
  near(A.missedArea, 0.2), near(A.spreadArea, 0.1), near(A.excludedArea, 0.5), near(A.unmeasuredArea, 0.25);
  // (Excess 2.5 in the bin to 5, 85 in the bin to 90; shares 5% and, of no area, 100%.)
  assert.deepEqual(A.excess, [0, 0, 1, 0, 0, 0, 0, 1, 0]), assert.deepEqual(A.share, [0, 0, 1, 0, 0, 0, 1]);
  assert.equal(A.within, 0), assert.equal(A.withinMissed, 0);
});
