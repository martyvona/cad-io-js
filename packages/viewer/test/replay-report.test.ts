import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecordedEvent } from '../src/recorder.ts';
import { isStep, replayed } from '../src/replay-report.ts';

test('replayed: steps, not events', () => {
  assert.equal(replayed({ steps: 342, applied: 342 }), 'replayed all 342 steps');
  assert.equal(replayed({ steps: 5, applied: 4 }), 'replayed 4 of 5 steps');
  assert.equal(replayed({ steps: 5, applied: 2, aborted: 'stopped' }), 'replay stopped after 2 of 5 steps');
});

test('isStep: what replay acts on, and what it keeps only for reading', () => {
  const ev = (e: object) => ({ t: 0, ...e }) as RecordedEvent;
  const steps = [{ type: 'load', files: [] }, { type: 'control', path: 'View/Zoom selected' },
    { type: 'select', source: 'tree', paths: [] }, { type: 'select', source: 'id', paths: [] },
    { type: 'api', method: 'view', args: [] }, { type: 'camera' }, { type: 'state' },
    { type: 'pick', x: 0, y: 0, add: false, path: null }].map(ev);
  const others = [{ type: 'control', path: 'File/Open file...' },
    { type: 'control', path: 'Selection/Select by ID...' },
    { type: 'select', source: 'pick', paths: [] }, { type: 'select', source: 'api', paths: [] },
    { type: 'status', text: '', error: false }, { type: 'pointer' }, { type: 'wheel' }, { type: 'resize' }].map(ev);
  assert.deepEqual(steps.map(isStep), steps.map(() => true));
  assert.deepEqual(others.map(isStep), others.map(() => false));
});
