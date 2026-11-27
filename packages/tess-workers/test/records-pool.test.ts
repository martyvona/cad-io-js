// The triage records a worker measures with TessellationRequest.records: every face's, (g) and (h) by tess-cadio
// (loaded for a foreign backend; the backend's own where it's tess-cadio), the columns transferred.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AREA, EXPECTED } from 'cad-scene';
import { CadioTessellator } from 'tess-cadio';
import { cube, seamCylinder } from '../../cad-brep/test/models.ts';
import { WorkerTessellator } from '../src/node.ts';

const skip = fs.existsSync(path.join(import.meta.dirname, '..', '..', 'tess-cadio', 'dist', 'tess_cadio.wasm')) ? false
  : 'tess-cadio\'s module not built';
const model = cube().finish();
const req = { format: 'cad-brep' as const, data: new Uint8Array(model.buffer), linearDeflection: 0.01,
  angularDeflection: 0.26, edges: true, measures: true };

test('a foreign backend\'s results: each face\'s record, its part size, and its expected count unmeasured, or with '
  + 'recordExpected tess-cadio\'s first meshing\'s', { skip }, async () => {
  const local = new CadioTessellator();
  await local.init();
  const counts = local.expectedCounts(req), size = local.partSize(req.data);
  const pool = new WorkerTessellator({ backend: { module: new URL('./quads-backend.ts', import.meta.url).href,
    export: 'QuadsTessellator' }, workers: 1 });
  await pool.init();
  try {
    assert.equal((await pool.tessellate(req)).records, undefined);
    const plain = (await pool.tessellate({ ...req, records: true })).records!;
    assert.equal(plain.partSize, size);
    assert.deepEqual([...plain.expected], [0, 1, 2, 3, 4, 5].map(() => NaN));
    assert.deepEqual([...plain.expectedSource], [0, 1, 2, 3, 4, 5].map(() => EXPECTED.none));
    for (let k = 0; k < 2; k++) {
      const r = await pool.tessellate({ ...req, records: true, recordExpected: true });
      const rec = r.records!;
      assert.deepEqual([...rec.entityId], [21, 22, 23, 24, 25, 26]);
      assert.ok(rec.entityId instanceof Float64Array && rec.triangles instanceof Uint32Array);
      assert.equal(rec.partSize, size);
      assert.deepEqual([...rec.triangles], [2, 2, 2, 2, 2, 2]);
      assert.deepEqual([...rec.areaClass], [0, 1, 2, 3, 4, 5].map(() => AREA.pass));
      assert.deepEqual([...rec.expected], [...rec.entityId].map((id) => counts.get(id)));
      assert.deepEqual([...rec.expectedSource], [0, 1, 2, 3, 4, 5].map(() => EXPECTED.firstMeshing));
      assert.ok(!r.diagnostics.length, JSON.stringify(r.diagnostics));
    }
    // A curved face at two deflections: other counts (the worker's counts kept by request, not by payload alone).
    const cyl = { ...req, data: new Uint8Array(seamCylinder().finish().buffer) };
    for (const linearDeflection of [0.01, 1e-3]) {
      const counted = local.expectedCounts({ ...cyl, linearDeflection });
      const rec = (await pool.tessellate({ ...cyl, linearDeflection, records: true, recordExpected: true })).records!;
      assert.deepEqual([...rec.expected], [...rec.entityId].map((id) => counted.get(id)));
    }
    assert.notDeepEqual([...local.expectedCounts(cyl).values()],
      [...local.expectedCounts({ ...cyl, linearDeflection: 1e-3 }).values()]);
  } finally {
    pool.dispose();
  }
});

test('tess-cadio\'s results: its own checks and the counts it capped by', { skip }, async () => {
  const pool = new WorkerTessellator({ backend: { module: 'tess-cadio', export: 'CadioTessellator' }, workers: 1 });
  await pool.init();
  try {
    const r = await pool.tessellate({ ...req, records: true });
    const rec = r.records!;
    assert.deepEqual([...rec.expectedSource], [0, 1, 2, 3, 4, 5].map(() => EXPECTED.backend));
    assert.deepEqual([...rec.expected], [...rec.entityId].map((id) => r.reported!.find((x) => x.entityId === id)!
      .expected));
    assert.ok(rec.partSize > 0);
  } finally {
    pool.dispose();
  }
});
