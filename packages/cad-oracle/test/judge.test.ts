// areaOracle: the judging area oracle tess-workers' workers set.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cube } from '../../cad-brep/test/models.ts';
import { bsplineCylinder, line2 } from '../../cad-heal/test/models.ts';
import { areaOracle, init, JUDGE_PROJECT, JUDGE_REL_TOL, JUDGE_RELATIVE, Oracle } from '../src/index.ts';

const module = await init();

test('areaOracle: the faces trusted at JUDGE_RELATIVE by id, with their errors; faces sharing an id left out', () => {
  // The B-spline cylinder's circles have no p-curves: by default not projected, so the face isn't judged.
  const d = bsplineCylinder(line2([1, 0], [0, 1])).finish();
  assert.equal(JUDGE_PROJECT, false);
  assert.equal(areaOracle(module).areas(d).size, 0);
  const a = areaOracle(module, { project: true }).areas(d);
  assert.deepEqual([...a.keys()], [9]);
  const f = a.get(9)!;
  assert.ok(Math.abs(f.area - 20 * Math.PI) <= 1e-6 * 20 * Math.PI && f.error > 0
    && f.error <= JUDGE_RELATIVE * f.area, JSON.stringify(f));
  assert.ok(Math.abs(f.perimeter - (8 * Math.PI + 10)) <= 1e-6 * f.perimeter, `${f.perimeter}`);
  // Its error the area's own, at judging's quadrature tolerance.
  { using o = new Oracle(module, d.buffer, { relTol: JUDGE_REL_TOL }); assert.equal(f.error, o.face(0).area.error); }
  // Without projections: no area for the face (its circles have no p-curve to follow).
  { using o = new Oracle(module, d.buffer, { projectMissing: false }); assert.notEqual(o.face(0).area.status, 'ok'); }
  // Stricter than its error (its projected circles' bound): left out.
  assert.equal(areaOracle(module, { relative: 1e-9, project: true }).areas(d).size, 0);
  // A cube's six faces; two of them given one id: both left out.
  const c = cube().finish();
  assert.equal(areaOracle(module).areas(c).size, 6);
  c.face.id[1] = c.face.id[0]!;
  assert.deepEqual([...areaOracle(module).areas(c).keys()].length, 4);
});
