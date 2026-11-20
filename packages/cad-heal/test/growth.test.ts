import assert from 'node:assert/strict';
import test from 'node:test';
import { init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { ERROR_RATIO, Growth, isError, SIZE_SHARE } from '../src/fix/growth.ts';
import { GROWTH } from '../src/fix/tolerance.ts';
import { cylinderSide, planeArc, rationalArc } from './models.ts';

const module = await init();
// cylinderSide's part: radius 2 and height 3 (its vertices' box diagonal 5 mm, so SIZE_SHARE of it 0.05 mm), its
// bottom circle's radius `r`, so its vertex and the seam's ends `r - 2` apart.
const SIZE = 5;
const part = (r: number, uncertainty = 1e-6) => cylinderSide({}, uncertainty, 0, undefined, r).finish();
const grown = async (d: ReturnType<typeof part>) => {
  const r = await healPart(d, {}, module);
  const t = r.diagnostics.filter((x) => x.message.startsWith('tolerances grown:'));
  assert.equal(t.length, 1, 'one diagnostic for the part');
  return t[0]!;
};

test('the rule: an error only past ERROR_RATIO x the start and past SIZE_SHARE x the size, both strictly', () => {
  assert.equal(ERROR_RATIO, 5);
  assert.equal(SIZE_SHARE, 0.01);
  assert.equal(isError(1e-3, 5e-3, 0.1), false, 'at 5 x');
  assert.equal(isError(1e-3, 5.0001e-3, 0.1), true);
  assert.equal(isError(1e-5, 1, 100), false, 'at 0.01 x the size');
  assert.equal(isError(1e-5, 1.0001, 100), true);
  assert.equal(isError(1, 4.9, 1), false, 'past the size, within the ratio');
  assert.equal(isError(1e-6, 1e-3, 1), false, 'past the ratio, within the size');
});

test('a gap past 5 x but within 0.01 x the part\'s size: a warning', async () => {
  const x = await grown(part(2.01));
  assert.equal(x.severity, 'warning');
  assert.match(x.message,
    /; the largest 1\.10e\+4 x its starting tolerance \((vertex #0|edge #\d+): 1\.00e-6 mm to 0\.0110 mm\)/);
  assert.ok(!x.message.includes('error'));
});

test('a gap past 5 x and past 0.01 x the part\'s size: an error, counted and the part\'s size said', async () => {
  const x = await grown(part(2.05));
  assert.equal(x.severity, 'error');
  assert.match(x.message, new RegExp(`^tolerances grown: 2 edges and 1 vertex \\(.*\\), each to ${GROWTH} times `
    + `what's measured; 3 errors \\(past 5 x its starting tolerance and 0\\.01 x the part's size of `
    + `${SIZE}\\.00 mm\\), the worst 5\\.50e\\+4 x its starting tolerance \\((vertex #0|edge #\\d+): 1\\.00e-6 mm to `
    + `0\\.0550 mm\\); the largest growth 0\\.0550 mm`));
});

test('a gap past 0.01 x the size within 5 x the part\'s stated tolerance: a warning', async () => {
  const x = await grown(part(2.05, 0.04));
  assert.equal(x.severity, 'warning');
  assert.match(x.message, /the largest 1\.3[78] x its starting tolerance \(.*: 0\.0400 mm to 0\.0550 mm\)/);
});

test('a part stating no tolerance starts from 1e-5 mm', async () => {
  const x = await grown(part(2.01, NaN));
  assert.equal(x.severity, 'warning');
  assert.match(x.message,
    /the largest 1\.10e\+3 x its starting tolerance \((vertex #0|edge #\d+): 1\.00e-5 mm to 0\.0110 mm\)/);
});

test('nothing grown: no diagnostic', async () => {
  const r = await healPart(part(2), {}, module);
  assert.deepEqual(r.diagnostics, []);
});

test('the worst named is the error with the largest ratio, not a warning\'s larger one; the largest growth apart',
  () => {
  const g = new Growth(900);
  g.add('edge', 1, 1e-9, 1e-3, ['edgeTolerance']);
  g.add('edge', 2, 20, 200, ['edgeTolerance']);
  g.add('vertex', 3, 1, 30, ['vertexTolerance', 'pcurveEnds']);
  g.add('edge', 4, 100, 300, ['pcurveEnds']);
  g.add('edge', 5, 290, 310, ['edgeTolerance']);
  const x = g.diagnostic()!;
  assert.equal(x.severity, 'error');
  assert.equal(x.message, `tolerances grown: 4 edges and 1 vertex (edgeTolerance 3 edges, vertexTolerance 1 vertex, `
    + `pcurveEnds 1 edge and 1 vertex), each to ${GROWTH} times what's measured; 2 errors (past 5 x its starting `
    + `tolerance and 0.01 x the part's size of 900 mm), the worst 30.0 x its starting tolerance (vertex #3: 1.00 mm `
    + `to 30.0 mm); the largest growth 200 mm (edge #4)`);
  assert.equal(new Growth(1).diagnostic(), undefined);
});

test('warnings alone: the worst is the largest ratio', () => {
  const g = new Growth(1e6);
  g.add('edge', 7, 1, 3, ['edgeTolerance']);
  g.add('edge', 8, 1e-3, 1, ['edgeTolerance']);
  const x = g.diagnostic()!;
  assert.equal(x.severity, 'warning');
  assert.match(x.message, /; the largest 1\.00e\+3 x its starting tolerance \(edge #8: 0\.00100 mm to 1\.00 mm\); /);
  assert.match(x.message, /; the largest growth 2\.00 mm \(edge #7\)$/);
});

test('the ratio is to the row\'s own starting tolerance where the source gives one larger than the part\'s',
  async () => {
  // Both vertices and both edges given 0.01 (the part 1e-6); the end vertex 0.02 off both edges' ends.
  const r = await healPart(planeArc(undefined, undefined, 0, 0.02, 0.01).finish(), {}, module);
  const x = r.diagnostics.find((y) => y.message.startsWith('tolerances grown:'))!;
  assert.equal(x.severity, 'warning');
  assert.match(x.message,
    /; the largest 2\.20 x its starting tolerance \((vertex|edge) #\d+: 0\.0100 mm to 0\.0220 mm\)/);
});

test('an edge grown by one fix takes only that fix\'s need, not a larger one of a fix turned off', async () => {
  // The arc off its plane by about 0.05 (edgeTolerance's, off) and its end 0.005 off its vertex (vertexTolerance's).
  const r = await healPart(planeArc(undefined, undefined, 0.1, 0.005).finish(), { fixes: { edgeTolerance: false } },
    module);
  const t = r.model.edge.tolerance[0]!;
  assert.ok(Math.abs(t - GROWTH * 0.005) < 1e-9, `${t}`);
});

test('a vertex grown by one fix takes only that fix\'s need, not a larger one of a fix turned off', async () => {
  // The arc's p-curve ending at (2.03, 0) (pcurveEnds' need about 0.03, off), its vertex 0.005 off the arc's end.
  const pc = rationalArc([[0, 0], [1, 1], [2.03, 0]], [1, 0.5, 2]);
  const r = await healPart(planeArc(pc, undefined, 0, 0.005).finish(),
    { fixes: { pcurveEnds: false, pcurveReplace: false } }, module);
  const t = r.model.vertex.tolerance[1]!;
  assert.ok(Math.abs(t - GROWTH * 0.005) < 1e-9, `${t}`);
});
