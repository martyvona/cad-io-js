// corpus_checks/face_density.ts: DENSITY lines read, within the deflection, the two densities by hand, nearest-rank
// quantiles, the report's ordering and other backends' counts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLine, perArea, perCurvature, quantiles, report, within } from '../corpus_checks/face_density.ts';

const line = (id: number, kind: string, r: number | string, ...m: (number | string)[]) =>
  ['f.stp #1', id, kind, 0.1, r, ...m].join('\t');

test('parseLine, within, perArea and perCurvature', () => {
  const f = parseLine(line(7, 'cylinder', 2, 400, 50, 9, 0.05, 300, 50, 9, 'NaN', 100, 25, 9, 0.2))!;
  assert.equal(f.id, 7), assert.equal(f.kind, 'cylinder'), assert.equal(f.radius, 2), assert.equal(f.d, 0.1);
  assert.deepEqual(f.mesh[2], { triangles: 100, area: 25, extent: 9, deviation: 0.2 });
  assert.equal(within(f, 0), true), assert.equal(within(f, 1), false), assert.equal(within(f, 2), false);
  // 400 / (50 / 0.01) = 0.08; 400 / (50 / (8 * 2 * 0.1)) = 12.8.
  assert.ok(Math.abs(perArea(f, 0) - 0.08) < 1e-12), assert.ok(Math.abs(perCurvature(f, 0) - 12.8) < 1e-9);
  const flat = parseLine(line(8, 'plane', 'Infinity', 2, 10, 5, 0, 2, 10, 5, 0, 2, 10, 5, 0))!;
  assert.equal(flat.radius, Infinity), assert.ok(Number.isNaN(perCurvature(flat, 0)));
  assert.ok(Number.isNaN(perArea(parseLine(line(9, 'plane', 1, 2, 0, 5, 0, 2, 0, 5, 0, 2, 0, 5, 0))!, 0)));
  assert.equal(parseLine('a\tb'), undefined);
});

test('quantiles: nearest rank, the max last, non-finite left out', () => {
  const xs = Array.from({ length: 1000 }, (_, k) => k + 1);
  assert.deepEqual(quantiles(xs), [500, 900, 990, 999, 1000]);
  assert.deepEqual(quantiles([3, NaN, 1, Infinity, 2]), [2, 3, 3, 3, 3]);
  assert.deepEqual(quantiles([NaN]), []);
});

test('report: faces within the deflection only, the most triangles first, every backend\'s count beside', () => {
  const faces = [
    line(1, 'plane', 'Infinity', 10, 1, 1, 0, 20, 1, 1, 0, 30, 1, 1, 0),
    line(2, 'cylinder', 1, 5000, 10, 4, 0.2, 900, 10, 4, 0.05, 800, 10, 4, 0.05),
    line(3, 'cylinder', 1, 700, 10, 4, 0.09, 600, 10, 4, 'NaN', 500, 10, 4, 0.01),
    line(4, 'plane', 'Infinity', 1, 1, 1, 0, 2000, 1, 1, 0, 3, 1, 1, 0),
  ].map((l) => parseLine(l)!);
  const out = report(faces, 5);
  const top = out.indexOf(out.find((l) => l.startsWith("### ours's"))!);
  // (Face 2 is past d for ours, so not listed; 3 then 1.)
  assert.match(out[top + 1]!, /face #3 .*700 triangles.*ours 700 \(0\.90 x\), OCCT 600 \(not sampled\), SMLib 500/);
  assert.match(out[top + 2]!, /face #1 .*r flat/), assert.match(out[top + 3]!, /face #4 /);
  assert.equal(out[top + 4]!, '');
  // OCCT's by its own counts: face 4's 2000 first.
  const occt = out.indexOf(out.find((l) => l.startsWith("### OCCT's"))!);
  assert.match(out[occt + 1]!, /face #4 .*: 2000 triangles/), assert.match(out[occt + 2]!, /face #2 .*: 900 triangles/);
  assert.ok(out.includes('  ours: 3 faces within the deflection'), out.join('\n'));
  assert.ok(out.includes('  OCCT: 3 faces within the deflection'));
  // At most `top` listed.
  const one = report(faces, 1), at = one.indexOf(one.find((l) => l.startsWith("### ours's"))!);
  assert.match(one[at]!, /ours's 1 faces/), assert.match(one[at + 1]!, /face #3 /), assert.equal(one[at + 2]!, '');
  assert.ok(out.some((l) => l.startsWith('    cylinder (1): triangles 50% 700')));
});
