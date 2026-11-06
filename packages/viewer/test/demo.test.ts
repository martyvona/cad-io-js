import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSize, parseCatalog } from '../src/demo.ts';

test('sizes in powers of 1000, one decimal, rounding up into the next unit', () => {
  const cases: [number, string][] = [
    [0, '0B'], [512, '512B'], [999, '999B'], [1000, '1.0k'], [8200, '8.2k'], [8249, '8.2k'], [8250, '8.3k'],
    [999_949, '999.9k'], [999_950, '1.0M'], [23_400_000, '23.4M'], [999_960_000, '1.0G'], [8_200_000_000, '8.2G'],
    [1_500_000_000_000, '1.5T'], [2_000_000_000_000_000, '2000.0T'],
  ];
  for (const [bytes, text] of cases) assert.equal(formatSize(bytes), text, `${bytes}`);
});

test('a catalog: its well-formed entries, in order; not a catalog throws', () => {
  assert.deepEqual(parseCatalog({ models: [
    { path: 'a.step', size: 10 }, { path: 'sub/b.glb', size: 0 }, { path: '', size: 1 }, { path: 'c.stp' },
    { path: 3, size: 1 }, { path: 'd.3mf', size: -1 }, { path: 'e.3mf', size: Infinity }, null, 'f.step',
    { path: 'g.json', size: 7, extra: true },
  ] }), [{ path: 'a.step', size: 10 }, { path: 'sub/b.glb', size: 0 }, { path: 'g.json', size: 7, extra: true }]);
  assert.deepEqual(parseCatalog({ models: [] }), []);
  for (const bad of [null, [], {}, { models: {} }, 'x']) assert.throws(() => parseCatalog(bad), /not a catalog/);
});
