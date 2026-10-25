import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampWidth } from '../src/side-handle.ts';

test('the tree panel width: at least 140 pixels, leaving the view 200, whole pixels', () => {
  assert.equal(clampWidth(350.4, 1200), 350);
  assert.equal(clampWidth(50, 1200), 140);
  assert.equal(clampWidth(1100, 1200), 1000);
  assert.equal(clampWidth(300, 250), 140);
});
