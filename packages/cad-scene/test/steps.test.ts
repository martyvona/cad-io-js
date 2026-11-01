import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drain, paced } from '../src/index.ts';

function* steps(n: number): Generator<void, number> {
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    sum += i;
    yield;
  }
  return sum;
}

test('drain and paced: the same result; paced pausing between steps once the time has gone by', async () => {
  assert.equal(drain(steps(10)), 55);
  let pauses = 0;
  assert.equal(await paced(steps(10), async () => { pauses++; }, 0), 55);
  assert.equal(pauses, 10);
  // Within the time: no pause.
  pauses = 0;
  assert.equal(await paced(steps(10), async () => { pauses++; }, 60_000), 55);
  assert.equal(pauses, 0);
});
