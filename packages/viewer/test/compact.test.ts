import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compact } from '../src/compact.ts';

test('counts: as they are to 999, then thousands with a decimal, rounding up into the next unit', () => {
  const cases: [number, string][] = [[0, '0'], [2, '2'], [999, '999'], [1000, '1.0k'], [8500, '8.5k'],
    [8549, '8.5k'], [8550, '8.6k'], [12_345, '12.3k'], [999_949, '999.9k'], [999_950, '1.0M'], [2_500_000, '2.5M'],
    [3e9, '3.0G'], [1.5e12, '1.5T'], [2e15, '2000.0T']];
  for (const [n, text] of cases) assert.equal(compact(n), text, `${n}`);
});
