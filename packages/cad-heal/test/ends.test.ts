import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, PROVENANCE } from 'cad-brep';
import { init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { GROWTH } from '../src/fix/tolerance.ts';
import { cylinderSide } from './models.ts';

const module = await init();
// The bottom circle of radius 2.05 and its vertex on it at (2.05, 0, 0); the seam's line and its p-curves at x = 2,
// so the vertex is 0.05 from the seam's curve's start and from its p-curves' starts. Vertex 0 is it, vertex 1 the top.
const offSeam = () => cylinderSide({}, 1e-6, 0, undefined, 2.05).finish();
const SEAM = 2;

test('vertexTolerance: a vertex 0.05 off an edge\'s curve\'s end has its tolerance grown to cover it', async () => {
  const d = offSeam();
  const r = await healPart(d, { fixes: { pcurveEnds: false } }, module);
  assert.ok(Math.abs(r.model.vertex.tolerance[0]! - GROWTH * 0.05) < 1e-9, `${r.model.vertex.tolerance[0]}`);
  assert.ok(Number.isNaN(r.model.vertex.tolerance[1]!), 'the top vertex is on its curves');
  assert.match(r.diagnostics.find((x) => x.message.startsWith('vertexTolerance:'))!.message,
    /^vertexTolerance: 1 vertices' tolerances grown .*: vertex #\d+ \(0\.0500 mm\)$/);
  const a = await analysisFor(r.model, r.analysis!);
  assert.equal(a.vertex.toleranceFrom[0], PROVENANCE.healed);
  assert.equal(a.vertex.toleranceFrom[1], PROVENANCE.none);
});

test('pcurveEnds: a kept p-curve\'s end 0.05 off its vertex: the vertex\'s and the edge\'s tolerances grown',
  async () => {
  const d = offSeam();
  const r = await healPart(d, { fixes: { vertexTolerance: false, edgeTolerance: false } }, module);
  assert.ok(Math.abs(r.model.vertex.tolerance[0]! - GROWTH * 0.05) < 1e-9);
  assert.ok(Math.abs(r.model.edge.tolerance[SEAM]! - GROWTH * 0.05) < 1e-9, 'the seam edge\'s, so the face joins');
  assert.ok(Number.isNaN(r.model.edge.tolerance[1]!), 'the top edge\'s p-curve meets its vertex');
  assert.match(r.diagnostics.find((x) => x.message.startsWith('pcurveEnds:'))!.message,
    /^pcurveEnds: 1 vertices' tolerances and their edges' grown .*up to 0\.0500 mm/);
});

test('vertexTolerance and pcurveEnds off: no vertex tolerance grown', async () => {
  const r = await healPart(offSeam(), { fixes: { vertexTolerance: false, pcurveEnds: false } }, module);
  assert.ok(Number.isNaN(r.model.vertex.tolerance[0]!));
});

test('a vertex tolerance the source gave that covers the gap is kept', async () => {
  const d = cylinderSide({}, 1e-6, 0, 0.1, 2.05).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.model.vertex.tolerance[0], 0.1);
  assert.ok(!r.diagnostics.some((x) => x.message.startsWith('vertexTolerance:')));
});

test('vertices on their curves and p-curves: nothing grown', async () => {
  const r = await healPart(cylinderSide().finish(), {}, module);
  assert.ok([...r.model.vertex.tolerance].every(Number.isNaN));
  assert.equal(r.changed, false);
});

test('vertexTolerance: an edge\'s end vertex off its curve\'s end (a wire\'s, in no face)', async () => {
  const r = await healPart((await import('./models.ts')).wireLine(0.05).finish(), {}, module);
  assert.ok(Number.isNaN(r.model.vertex.tolerance[0]!), 'the start on the line');
  assert.ok(Math.abs(r.model.vertex.tolerance[1]! - GROWTH * 0.05) < 1e-9, `${r.model.vertex.tolerance[1]}`);
});
