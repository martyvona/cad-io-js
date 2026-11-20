import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Diagnostic } from 'cad-scene';
import { CAUSES_HEAD } from 'tess-cadio/causes';
import { faceCausesOf, problemRows } from '../src/problems.ts';

test('problem rows: errors only, in order; the source\'s id; at most max', () => {
  const src = (id: number) => ({ format: 'step', id });
  const d: Diagnostic[] = [
    { severity: 'warning', message: 'w1', source: src(12) },
    { severity: 'info', message: 'i' },
    { severity: 'error', message: 'e1' },
    { severity: 'warning', message: 'w2' },
    { severity: 'error', message: 'e2', source: src(7) },
  ];
  const r = problemRows(d);
  assert.deepEqual(r.rows, [['error', 'e1'], ['error #7', 'e2']]);
  assert.deepEqual([r.errors, r.more], [2, 0]);
  const short = problemRows(d, 1);
  assert.deepEqual(short.rows.map((x) => x[1]), ['e1']);
  assert.deepEqual([short.errors, short.more], [2, 1]);
  assert.deepEqual(problemRows([{ severity: 'info', message: 'i' }, { severity: 'warning', message: 'w' }]).rows, []);
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
  assert.deepEqual(problemRows(d).rows, [['error #9', 'part failed to build', ''],
    ['error #453', '3 faces failed to mesh: #445, #446, #447', 'noConvergence: meshed past its deflection (#445, '
      + '#447); singular: a seam\'s side (#446)'], ['error #453', 'part timed out', ''],
    ['error #29', '1 faces failed to mesh: #30', '']]);
  // Without causes (another backend's failures): two columns, as before.
  assert.deepEqual(problemRows(d.filter((x) => x.severity === 'error')).rows.map((r) => r.length), [2, 2, 2, 2]);
  assert.deepEqual([...faceCausesOf(d)], [[445, 'noConvergence: meshed past its deflection'],
    [447, 'noConvergence: meshed past its deflection'], [446, 'singular: a seam\'s side'], [12, 'invalidModel: x']]);
});
