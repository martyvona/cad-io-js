import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Diagnostic } from 'cad-scene';
import { CAUSES_HEAD } from 'tess-cadio/causes';
import { faceCausesOf, problemCounts, problemRows } from '../src/problems.ts';

test('problem rows: one kind, in order; the source\'s id', () => {
  const src = (id: number) => ({ format: 'step', id });
  const d: Diagnostic[] = [
    { severity: 'warning', message: 'w1', source: src(12) },
    { severity: 'info', message: 'i' },
    { severity: 'error', message: 'e1' },
    { severity: 'warning', message: 'w2' },
    { severity: 'error', message: 'e2', source: src(7) },
  ];
  assert.deepEqual(problemRows(d), [['error', 'e1'], ['error #7', 'e2']]);
  assert.deepEqual(problemRows(d, 'error'), problemRows(d));
  assert.deepEqual(problemRows(d, 'warning'), [['warning #12', 'w1'], ['warning', 'w2']]);
  assert.deepEqual(problemRows([{ severity: 'info', message: 'i' }, { severity: 'warning', message: 'w' }]), []);
  assert.deepEqual(problemRows([{ severity: 'info', message: 'i' }], 'warning'), []);
});

test('problem counts: errors then warnings, each only when there are some, singular for one', () => {
  const d = (e: number, w: number): Diagnostic[] => [
    ...Array.from({ length: w }, () => ({ severity: 'warning' as const, message: 'w' })),
    { severity: 'info', message: 'i' },
    ...Array.from({ length: e }, () => ({ severity: 'error' as const, message: 'e' }))];
  assert.equal(problemCounts(d(12, 3)), '12 errors, 3 warnings');
  assert.equal(problemCounts(d(12, 0)), '12 errors');
  assert.equal(problemCounts(d(0, 3)), '3 warnings');
  assert.equal(problemCounts(d(1, 1)), '1 error, 1 warning');
  assert.equal(problemCounts(d(0, 0)), '');
});

test('problem rows: a failed-faces error\'s causes in a third column, from its own part\'s by-cause diagnostic, '
  + 'grouped by cause with their faces; empty for other errors; no column where none has one', () => {
  const src = (id: number) => ({ format: 'step', id });
  const d: Diagnostic[] = [
    { severity: 'error', message: 'part failed to build', source: src(9) },
    { severity: 'error', message: '3 faces failed to mesh: #445, #446, #447', source: src(453) },
    { severity: 'error', message: 'part timed out', source: src(453) },
    { severity: 'info', message: `${CAUSES_HEAD}noConvergence: meshed past its deflection 2 (#445, #447); singular: a `
      + 'seam\'s side 1 (#446)', source: src(453) },
    // Another part's causes, and an error of a part without any.
    { severity: 'info', message: `${CAUSES_HEAD}invalidModel: x 1 (#12)`, source: src(11) },
    { severity: 'error', message: '1 faces failed to mesh: #30', source: src(29) },
  ];
  assert.deepEqual(problemRows(d), [['error #9', 'part failed to build', ''],
    ['error #453', '3 faces failed to mesh: #445, #446, #447', 'noConvergence: meshed past its deflection (#445, '
      + '#447); singular: a seam\'s side (#446)'], ['error #453', 'part timed out', ''],
    ['error #29', '1 faces failed to mesh: #30', '']]);
  // Without causes (another backend's failures): two columns, as before.
  assert.deepEqual(problemRows(d.filter((x) => x.severity === 'error')).map((r) => r.length), [2, 2, 2, 2]);
  assert.deepEqual([...faceCausesOf(d)], [[445, 'noConvergence: meshed past its deflection'],
    [447, 'noConvergence: meshed past its deflection'], [446, 'singular: a seam\'s side'], [12, 'invalidModel: x']]);
});
