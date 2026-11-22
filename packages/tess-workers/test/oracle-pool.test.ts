// The pool's area oracle: a worker measures with cad-oracle (B-spline faces too), loaded on the first request asking
// for measures, and names it in the backend's version; this thread keeps cad-scene's own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { init as initGeom } from 'cad-geom';
import { healPart } from 'cad-heal';
import { AREA_ORACLE_ID } from 'cad-oracle';
import { oracleMeasures } from 'cad-scene';
import { bsplineCylinder, line2 } from '../../cad-heal/test/models.ts';
import { WorkerTessellator } from '../src/node.ts';

test('a worker\'s results with measures carry cad-oracle\'s areas, its version naming it', async () => {
  // A B-spline cylinder of radius 2 and height 5, its face #9 (cad-scene's oracle doesn't take B-splines), its circles
  // given p-curves by healing (judging doesn't project).
  const model = (await healPart(bsplineCylinder(line2([1, 0], [0, 1])).finish(), { fixes: {
    pcurveMissingOnFreeForm: true } }, await initGeom())).model;
  assert.deepEqual(oracleMeasures(model), []);
  const pool = new WorkerTessellator({ backend: { module: new URL('./oracle-backend.ts', import.meta.url).href,
    export: 'OracleTessellator' }, workers: 1 });
  await pool.init();
  try {
    assert.equal(pool.info.version, `1, area oracle ${AREA_ORACLE_ID}`);
    const req = { format: 'cad-brep' as const, data: new Uint8Array(model.buffer), linearDeflection: 0.1,
      angularDeflection: 0.5 };
    assert.equal((await pool.tessellate(req)).oracle, undefined);
    const r = await pool.tessellate({ ...req, measures: true });
    assert.equal(r.oracle?.length, 1);
    const [o] = r.oracle!;
    assert.equal(o!.entityId, 9);
    assert.ok(Math.abs(o!.area - 20 * Math.PI) <= 1e-6 * 20 * Math.PI, `${o!.area}`);
    assert.ok(o!.error! >= 0 && o!.error! <= 1e-3 * o!.area, `${o!.error}`);
    assert.ok(!r.diagnostics.length, JSON.stringify(r.diagnostics));
  } finally {
    pool.dispose();
  }
});
