import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EXPORT, EXPORT_FORMATS } from '../src/export-formats.ts';

test('the formats the dialog offers: the default among them, an extension and a MIME type each, one kind each', () => {
  assert.ok(DEFAULT_EXPORT.format in EXPORT_FORMATS);
  for (const [name, f] of Object.entries(EXPORT_FORMATS)) {
    assert.match(f.ext, /^\.[a-z0-9]+$/, name);
    assert.match(f.mime, /^[a-z]+\/[a-z0-9.+-]+$/, name);
    assert.ok([f.gltf, f.threemf, f.step].filter(Boolean).length <= 1, name);
  }
  assert.deepEqual(Object.entries(EXPORT_FORMATS).filter(([, f]) => f.gltf).map(([k]) => k), ['glb', 'gltf']);
  assert.deepEqual(Object.entries(EXPORT_FORMATS).filter(([, f]) => f.step).map(([k]) => k), ['step']);
});
