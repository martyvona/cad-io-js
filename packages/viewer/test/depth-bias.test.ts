import assert from 'node:assert/strict';
import { test } from 'node:test';
import { biasFor } from '../src/depth-bias.ts';

test('depth bias: pixels of the view in millimetres, at least two deflections; none at 0 pixels', () => {
  assert.equal(biasFor(0, 0.5, 0.1), 0);
  assert.equal(biasFor(2, 0.5, 0.1), 1);
  assert.equal(biasFor(2, 0.01, 0.1), 0.2);
});
