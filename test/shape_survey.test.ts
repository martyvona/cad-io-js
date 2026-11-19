// corpus_checks/shape_survey.ts: triangle shapes against closed forms and the law of cosines, the bins, a face's
// triangles over several ranges, the sampled deviation against a sphere's exact distance, quantiles.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TessellationResult } from '../packages/cad-scene/src/index.ts';
import {
  ANGLE_BINS, ASPECT_BINS, DEVIATION_TRIANGLES, RATIO_BINS, addShapes, angleBin, angleEdge, aspectBin, aspectEdge,
  deviationBin, faceDeviation, faceTriangles, freshShapes, quantile, ratioBin, triangleShape, type Inverter,
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

/** A sphere of radius R about the origin as cad-geom's inverter would see it; statuses `bad` at those points. */
const sphere = (R: number, bad = new Set<number>()): Inverter & { calls: number[][] } => {
  const calls: number[][] = [];
  return {
    calls,
    surfaceInfo: () => ({ status: 'ok', u: [0, 2 * Math.PI], v: [-Math.PI / 2, Math.PI / 2] }),
    invertSurface(_row, pts) {
      calls.push(Array.from(pts));
      const n = pts.length / 3, distance = new Float64Array(n), statuses = new Uint8Array(n);
      for (let q = 0; q < n; q++) {
        distance[q] = Math.abs(Math.hypot(pts[3 * q]!, pts[3 * q + 1]!, pts[3 * q + 2]!) - R);
        if (bad.has(q)) statuses[q] = 4, distance[q] = 1e9;
      }
      return { status: 'ok', distance, statuses };
    },
  };
};

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
