import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Diagnostic } from 'cad-scene';
import { problemRows } from '../src/problems.ts';

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
