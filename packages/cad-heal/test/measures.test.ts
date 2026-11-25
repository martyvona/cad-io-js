import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, MEASURE_TRUST, openAnalysis } from 'cad-brep';
import { init } from 'cad-geom';
import { areaOracle, FLAGS, init as initOracle, JUDGE_PROJECT, JUDGE_REL_TOL, METHOD, Oracle, shellBox, solidShells,
  STATUS } from 'cad-oracle';
import { MODELS } from '../../cad-brep/test/models.ts';
import { healPart } from '../src/index.ts';
import { bsplineCylinder, line2, planeArc } from './models.ts';

const module = await init(), om = await initOracle();

test('judging measures: every face\'s as judging takes it, its flux about its solid shell\'s centre, in the analysis',
  async () => {
  // (A B-spline cylinder's area numeric, at the relTol; a face in no shell flagged loose.)
  const makers = { cube: MODELS.cube, seamCylinder: MODELS.seamCylinder, spheres: MODELS.spheres,
    withVoid: MODELS.withVoid, bspline: () => bsplineCylinder(line2([1, 0], [0, 1])), loose: () => planeArc() };
  let flagged = 0;
  for (const [name, make] of Object.entries(makers)) {
    const r = await healPart(make().finish(), {}, module), m = r.model;
    const a = await analysisFor(m, r.analysis!);
    assert.equal(a.analysis.measureRelTol[0], JUDGE_REL_TOL);
    assert.equal(a.analysis.measureProject[0], JUDGE_PROJECT ? 1 : 0);
    using o = new Oracle(om, m.buffer, { relTol: JUDGE_REL_TOL, projectMissing: JUDGE_PROJECT });
    const centre = new Map<number, [number, number, number]>();
    for (const s of solidShells(m)) {
      const b = shellBox(m, s);
      for (const f of b.faces) if (!centre.has(f)) centre.set(f, b.c);
    }
    for (let f = 0; f < m.face.id.length; f++) {
      const x = o.face(f), F = a.face, what = `${name} face ${f}`;
      if (x.flags.length) flagged++;
      assert.deepEqual([F.area[2 * f], F.area[2 * f + 1], STATUS[F.areaStatus[f]!]],
        [x.area.value, x.area.error, x.area.status], what);
      assert.deepEqual([F.perimeter[2 * f], F.perimeter[2 * f + 1], STATUS[F.perimeterStatus[f]!]],
        [x.perimeter.value, x.perimeter.error, x.perimeter.status], what);
      assert.equal(METHOD[F.method[f]!], x.method, what);
      assert.equal(F.flags[f], x.flags.reduce((b, k) => b | FLAGS[k], 0), what);
      assert.ok(Object.is(F.boundary[f], x.boundary) && Object.is(F.offSurface[f], x.offSurface), what);
      assert.equal(F.areaFrom[f], x.area.status !== 'ok' ? MEASURE_TRUST.none
        : x.method === 'closedForm' ? MEASURE_TRUST.exact : MEASURE_TRUST.estimate, what);
      const c = centre.get(f);
      if (!c) {
        assert.ok(Number.isNaN(F.fluxCentre[3 * f]!) && F.fluxStatus[3 * f] === 255, what);
        continue;
      }
      assert.deepEqual([...F.fluxCentre.subarray(3 * f, 3 * f + 3)], c, what);
      const fx = o.faceFlux(f, c);
      for (let k = 0; k < 3; k++) {
        assert.deepEqual([F.flux[6 * f + 2 * k], F.flux[6 * f + 2 * k + 1], STATUS[F.fluxStatus[3 * f + k]!]],
          [fx[k]!.value, fx[k]!.error, fx[k]!.status], `${what} flux ${k}`);
      }
    }
  }
  assert.ok(flagged > 0, 'a face with flags among them');
});

test('the judge reads an analysis\'s measures only where they\'re of the model, taken with its options', async () => {
  const r = await healPart(MODELS.cube().finish(), {}, module), m = r.model;
  const judge = areaOracle(om), measured = judge.areas(m);
  assert.deepEqual(judge.areas(m, r.analysis!), measured, 'the same as measuring');
  // A stored area changed: read where the analysis is of the model and its options the judge's.
  const bytes = new Uint8Array(r.analysis!.buffer).slice(), a = openAnalysis(bytes), id = m.face.id[0]!;
  a.face.area[0] = 1.5;
  assert.equal(judge.areas(m, bytes).get(id)!.area, 1.5, 'read');
  // Not of this model (one byte of it changed: its hash), or other options: measured.
  const other = new Uint8Array(m.buffer).slice();
  other[other.length - 1]! ^= 1;
  const edited = { ...m, buffer: other.buffer };
  assert.notEqual(judge.areas(edited, bytes).get(id)?.area, 1.5, 'another model');
  assert.equal(areaOracle(om, { relTol: 1e-7 }).areas(m, bytes).get(id)!.area, measured.get(id)!.area,
    'another relTol');
  assert.equal(areaOracle(om, { project: !JUDGE_PROJECT }).areas(m, bytes).get(id)!.area, measured.get(id)!.area,
    'another projection');
});
