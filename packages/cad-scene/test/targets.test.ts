import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AREA, CHECK, chooseFace, classify, classifyAll, compareFaces, CRITERIA, describeTarget, EXPECTED,
  type FaceClass, type FaceRecords, H_FLOOR, ORIENTATION, resolveTarget, TARGET_NAMES, TARGETS, type TargetName,
  wantsFallback } from '../src/index.ts';

const D = 0.1, ANGLE = 0.26;
const ctx = { linearDeflection: D, angularDeflection: ANGLE };
const deg = (d: number) => (d * Math.PI) / 180;

/** One face's record, sound unless `x` says otherwise (a backend measuring c and d, passing both). */
function one(x: Partial<Record<keyof FaceRecords, number>> = {}): FaceRecords {
  const v = { triangles: 100, degenerate: 0, nonManifoldEdges: 0, openEdges: 4, holeEdges: 0, tolerance: 1e-5,
    area: 1, oracleArea: 1, areaClass: AREA.pass, deviation: NaN, deviationCheck: CHECK.passed, normalAngle: NaN,
    normalCheck: CHECK.passed, turned: 0, minAngle: deg(30), belowMinAngle: 0, longestEdge: 1, expected: 50,
    expectedSource: EXPECTED.firstMeshing, unsewnEdges: 0, orientation: ORIENTATION.asShipped, filled: 0, ...x };
  const { partSize = 100, ...cols } = v as Record<string, number>;
  return { entityId: Float64Array.of(7), partSize,
    ...Object.fromEntries(Object.entries(cols).map(([k, n]) => [k, Float64Array.of(n)])) } as unknown as FaceRecords;
}

/** The criterion's class under each target, in TARGET_NAMES' order. */
const classes = (r: FaceRecords, c: (typeof CRITERIA)[number]) => TARGET_NAMES.map((t) =>
  classify(r, 0, TARGETS[t], ctx).criteria[c].class);
const all = (x: FaceClass) => [x, x, x];

test('a sound face passes every criterion under every target, (i) unchecked', () => {
  for (const t of TARGET_NAMES) {
    const f = classify(one(), 0, TARGETS[t], ctx);
    assert.equal(f.overall, 'pass', t);
    for (const c of CRITERIA) assert.equal(f.criteria[c].class, c === 'i' ? 'unchecked' : 'pass', `${t} ${c}`);
  }
});

test('(k), (a), (j), (e), (l): past or not, each target\'s level', () => {
  assert.deepEqual(classes(one({ triangles: 0 }), 'k'), all('error'));
  // (Only the sliver fill meshed it: a warning under every target.)
  assert.deepEqual(classes(one({ filled: 1 }), 'k'), all('warn'));
  assert.deepEqual(classes(one({ nonManifoldEdges: 1 }), 'a'), ['warn', 'error', 'error']);
  assert.deepEqual(classes(one({ holeEdges: 2 }), 'a'), ['warn', 'error', 'error']);
  assert.deepEqual(classes(one({ unsewnEdges: 1 }), 'a'), ['warn', 'error', 'error']);
  // (Holes unknown: not counted; not joined: unverified.)
  assert.deepEqual(classes(one({ holeEdges: -1 }), 'a'), all('pass'));
  assert.deepEqual(classes(one({ unsewnEdges: -1 }), 'a'), all('unverified'));
  assert.deepEqual(classes(one({ orientation: ORIENTATION.turned }), 'j'), all('warn'));
  assert.deepEqual(classes(one({ turned: 3 }), 'e'), all('warn'));
  assert.deepEqual(classes(one({ turned: -1 }), 'e'), all('unchecked'));
  assert.deepEqual(classes(one({ degenerate: 1 }), 'l'), all('warn'));
  // A target warning of a criterion and failing it too: the error.
  const both = { ...TARGETS.rendering, levels: { ...TARGETS.rendering.levels, a: { warn: 1, error: 1 } } };
  assert.equal(classify(one({ nonManifoldEdges: 1 }), 0, both, ctx).criteria.a.class, 'error');
});

test('(b): off its area, a warning, an error past the target\'s fraction (analysis: past the true limit)', () => {
  assert.deepEqual(classes(one({ areaClass: AREA.short, area: 0.9 }), 'b'), ['warn', 'warn', 'error']);
  assert.deepEqual(classes(one({ areaClass: AREA.short, area: 0.8 }), 'b'), ['warn', 'error', 'error']);
  assert.deepEqual(classes(one({ areaClass: AREA.over, area: 1.3 }), 'b'), ['error', 'error', 'error']);
  assert.deepEqual(classes(one({ areaClass: AREA.over, area: 1.2 }), 'b'), ['warn', 'error', 'error']);
  assert.deepEqual(classes(one({ areaClass: AREA.unverified }), 'b'), all('unverified'));
  const b = classify(one({ areaClass: AREA.short, area: 0.8 }), 0, TARGETS.manufacturing, ctx).criteria.b;
  assert.ok(Math.abs(b.ratio! - 0.2) < 1e-12);
});

test('(c) and (d): by their ratio to max(d, the face\'s tolerance) and the angle; unmeasured a warning; foreign '
  + 'backends\' unchecked', () => {
  const dev = (deviation: number, tolerance = 1e-5) => one({ deviationCheck: CHECK.lowerBound, deviation, tolerance });
  assert.deepEqual(classes(dev(0.15), 'c'), all('warn'));
  assert.deepEqual(classes(dev(0.25), 'c'), ['warn', 'error', 'error']);
  assert.deepEqual(classes(dev(1.1), 'c'), all('error'));
  assert.deepEqual(classes(dev(0.09), 'c'), all('pass'));
  // The face's tolerance above d: its limit.
  assert.deepEqual(classes(dev(0.25, 0.2), 'c'), all('warn'));
  assert.equal(classify(dev(0.25, 0.2), 0, TARGETS.manufacturing, ctx).criteria.c.limit, 0.2);
  const unmeasured = one({ deviationCheck: CHECK.failedUnmeasured });
  assert.deepEqual(classes(unmeasured, 'c'), all('warn'));
  assert.equal(classify(unmeasured, 0, TARGETS.analysis, ctx).criteria.c.unmeasured, true);
  assert.deepEqual(classes(one({ deviationCheck: CHECK.unchecked }), 'c'), all('unchecked'));
  assert.deepEqual(classes(one({ normalCheck: CHECK.measured, normalAngle: 0.4 }), 'd'), all('warn'));
  assert.deepEqual(classes(one({ normalCheck: CHECK.measured, normalAngle: 0.6 }), 'd'), ['warn', 'error', 'error']);
  assert.deepEqual(classes(one({ normalCheck: CHECK.failedUnmeasured }), 'd'), all('warn'));
  assert.deepEqual(classes(one({ normalCheck: CHECK.unchecked }), 'd'), all('unchecked'));
});

test('(f), (g) and (h): the smallest angle, the longest edge, the triangles against their limits', () => {
  assert.deepEqual(classes(one({ minAngle: deg(8) }), 'f'), all('warn'));
  assert.deepEqual(classes(one({ minAngle: deg(6) }), 'f'), ['warn', 'warn', 'error']);
  // The longest edge: only analysis sets a limit, 5 % of the part's size (100: 5).
  assert.deepEqual(classes(one({ longestEdge: 6 }), 'g'), ['pass', 'pass', 'warn']);
  assert.deepEqual(classes(one({ longestEdge: 8 }), 'g'), ['pass', 'pass', 'error']);
  assert.deepEqual(classes(one({ longestEdge: 6, partSize: NaN }), 'g'), ['pass', 'pass', 'unverified']);
  // (h): min(ceiling, max(200,000, 64 x expected)).
  assert.deepEqual(classes(one({ triangles: H_FLOOR + 1, expected: 1000 }), 'h'), all('error'));
  assert.deepEqual(classes(one({ triangles: H_FLOOR + 1, expected: 10_000 }), 'h'), all('pass'));
  // (The floor: 64 x 1,000 is under it.)
  assert.deepEqual(classes(one({ triangles: 100_000, expected: 1000 }), 'h'), all('pass'));
  assert.deepEqual(classes(one({ triangles: 640_001, expected: 10_000 }), 'h'), all('error'));
  assert.equal(classify(one({ triangles: 1, expected: 1e6 }), 0, TARGETS.analysis, ctx).criteria.h.limit,
    TARGETS.analysis.ceiling);
  // No count: passed to the floor, unverified to the ceiling, an error past it.
  const none = (triangles: number) => one({ triangles, expected: NaN, expectedSource: EXPECTED.none });
  assert.deepEqual(classes(none(H_FLOOR), 'h'), all('pass'));
  assert.deepEqual(classes(none(H_FLOOR + 1), 'h'), all('unverified'));
  assert.deepEqual(classes(none(TARGETS.analysis.ceiling + 1), 'h'), all('error'));
  // (A count whose source is none isn't one.)
  assert.deepEqual(classes(one({ triangles: H_FLOOR + 1, expected: 1e5, expectedSource: EXPECTED.none }), 'h'),
    all('unverified'));
});

test('a face\'s overall class its worst criterion\'s; unverified and unchecked don\'t count; classifyAll counts',
  () => {
    const f = (x: Parameters<typeof one>[0], t: TargetName) => classify(one(x), 0, TARGETS[t], ctx).overall;
    assert.equal(f({ minAngle: deg(8) }, 'analysis'), 'warn');
    assert.equal(f({ minAngle: deg(8), triangles: 0 }, 'rendering'), 'error');
    assert.equal(f({ areaClass: AREA.unverified, deviationCheck: CHECK.unchecked, turned: -1 }, 'analysis'), 'pass');
    const two = one({ minAngle: deg(8) });
    const { faces, counts } = classifyAll(two, TARGETS.analysis, ctx);
    assert.equal(faces.length, 1);
    assert.equal(faces[0]!.entityId, 7);
    assert.deepEqual(counts.f, { pass: 0, warn: 1, error: 0, unchecked: 0, unverified: 0 });
    assert.deepEqual(counts.i, { pass: 0, warn: 0, error: 0, unchecked: 1, unverified: 0 });
  });

test('the targets as docs/triage.md has them; describeTarget names each criterion\'s limit, the meshing limits and '
  + 'the fallback\'s trigger', () => {
  assert.deepEqual(TARGETS.rendering.meshing, { minAngle: deg(10) });
  assert.deepEqual(TARGETS.manufacturing.meshing, { minAngle: deg(10), elementaryStretchCap: 16 });
  assert.deepEqual(TARGETS.analysis.meshing, { minAngle: deg(10), maxEdge: 0.05, elementaryStretchCap: 16 });
  assert.equal(TARGETS.rendering.ceiling, 10_000_000);
  const text = describeTarget(TARGETS.analysis);
  for (const c of CRITERIA) assert.match(text, new RegExp(`^  ${c}  `, 'm'));
  assert.match(text, /^ {2}c .*max\(d, the face's tolerance\).*: warn past 1 x; error past 2 x$/m);
  assert.match(text, /^ {2}b .*: error past 1 x$/m);
  assert.match(describeTarget(TARGETS.rendering), /^ {2}b .*: warn past 1 x; error past 25 % of the area$/m);
  assert.match(text, /^ {2}k .*: error$/m);
  assert.match(text, /^ {2}i .*: allowed$/m);
  assert.match(text, /meshing limits: smallest angle 10 deg, longest edge 5 % of the part's size, elementary/);
  assert.deepEqual(TARGET_NAMES.map((t) => TARGETS[t].fallbackOn), ['error', 'error', 'warn']);
  assert.match(text, /^ {2}fallback: asked where a face misses a true limit \(warned of or in error\), or the part /m);
  assert.match(describeTarget(TARGETS.rendering), /^ {2}fallback: asked where a face is in error, or the part /m);
  assert.equal(resolveTarget('analysis'), TARGETS.analysis);
  const custom = { ...TARGETS.rendering, name: 'rendering' as const };
  assert.equal(resolveTarget(custom), custom);
});

const R = TARGETS.rendering, A = TARGETS.analysis;
const cl = (x: Parameters<typeof one>[0], t = R) => classify(one(x), 0, t, ctx);

test('chooseFace: passing first, the primary\'s on a tie; warned over in error; both warned: compareFaces; both in '
  + 'error: withheld', () => {
  const pass = cl({}), warn = cl({ minAngle: deg(8) }), error = cl({ triangles: 0 });
  assert.equal(chooseFace(pass, pass), 'primary');
  assert.equal(chooseFace(pass, error), 'primary');
  assert.equal(chooseFace(warn, pass), 'fallback');
  assert.equal(chooseFace(error, pass), 'fallback');
  assert.equal(chooseFace(warn, error), 'primary');
  assert.equal(chooseFace(error, warn), 'fallback');
  assert.equal(chooseFace(error, error), 'withheld');
  // (No record of the face in the fallback's: in error there.)
  assert.equal(chooseFace(warn, undefined), 'primary');
  assert.equal(chooseFace(error, undefined), 'withheld');
  // Both warned: the better by compareFaces, the primary's on a tie.
  assert.equal(chooseFace(warn, cl({ minAngle: deg(9) })), 'fallback');
  assert.equal(chooseFace(warn, cl({ minAngle: deg(7) })), 'primary');
  assert.equal(chooseFace(warn, cl({ minAngle: deg(8) })), 'primary');
});

test('compareFaces: criterion by criterion in order, by class then by the amount past the limit; unchecked and '
  + 'unverified as passing; (k)\'s count not compared', () => {
  // (a) before (f): a face open along an edge is worse than one with a small angle, whatever the angle.
  assert.ok(compareFaces(cl({ minAngle: deg(2) }), cl({ unsewnEdges: 1 })) < 0);
  // Within a class: the ratio (b: how far off; f: the limit over the angle), else the value (a's edges).
  assert.ok(compareFaces(cl({ areaClass: AREA.short, area: 0.9 }), cl({ areaClass: AREA.short, area: 0.95 })) > 0);
  assert.ok(compareFaces(cl({ unsewnEdges: 1 }), cl({ unsewnEdges: 3 })) < 0);
  assert.ok(compareFaces(cl({ turned: 2 }), cl({ turned: 1 })) > 0);
  assert.ok(compareFaces(cl({ degenerate: 1 }), cl({ degenerate: 4 })) < 0);
  // An earlier criterion's amount decides before a later one's class differs.
  assert.ok(compareFaces(cl({ unsewnEdges: 1, minAngle: deg(2) }), cl({ unsewnEdges: 2 })) < 0);
  // Passing values aren't compared (the triangle count, a longer edge within the limit).
  assert.equal(compareFaces(cl({ triangles: 10 }), cl({ triangles: 1000 })), 0);
  assert.equal(compareFaces(cl({ longestEdge: 1 }, A), cl({ longestEdge: 2 }, A)), 0);
  assert.equal(compareFaces(cl({ areaClass: AREA.unverified }), cl({})), 0);
  assert.equal(compareFaces(cl({ deviationCheck: CHECK.unchecked }), cl({})), 0);
  // c measured, unmeasured: no amount to compare, a tie on it.
  assert.equal(compareFaces(cl({ deviationCheck: CHECK.failedUnmeasured }), cl({ deviationCheck: CHECK.lowerBound,
    deviation: 0.15 })), 0);
  assert.ok(compareFaces(cl({ deviationCheck: CHECK.lowerBound, deviation: 0.12 }), cl({ deviationCheck:
    CHECK.lowerBound, deviation: 0.15 })) < 0);
});

test('wantsFallback: an error under every target; a warning only where the target asks on warnings (analysis)', () => {
  for (const t of TARGET_NAMES) {
    assert.equal(wantsFallback(cl({ triangles: 0 }, TARGETS[t]), TARGETS[t]), true, t);
    assert.equal(wantsFallback(cl({}, TARGETS[t]), TARGETS[t]), false, t);
    assert.equal(wantsFallback(cl({ minAngle: deg(8) }, TARGETS[t]), TARGETS[t]), t === 'analysis', t);
  }
});
