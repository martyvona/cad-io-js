import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overrideOf } from '../src/appearance-dialog.ts';
import { overrideText } from '../src/tree-panel.ts';

test("overrideOf: the dialog's choices as an override, inherit leaving a slot out, the alpha kept within 0 to 1", () => {
  assert.deepEqual(overrideOf('inherit', 'inherit', 0.3), {});
  assert.deepEqual(overrideOf('hide', 'default', 0.3), { hidden: true, transparent: false });
  assert.deepEqual(overrideOf('show', 'transparent', 0.3), { hidden: false, transparent: true, alpha: 0.3 });
  assert.deepEqual(overrideOf('inherit', 'transparent', 1.5), { transparent: true, alpha: 1 });
  assert.deepEqual(overrideOf('inherit', 'transparent', -1), { transparent: true, alpha: 0 });
});

test("overrideText: a row's title", () => {
  assert.equal(overrideText({ hidden: true, transparent: true, alpha: 0.3 }), 'hidden; opacity 0.3');
  assert.equal(overrideText({ hidden: false, transparent: false }), "shown; the file's opacity");
  assert.equal(overrideText({ transparent: true, alpha: 0 }), 'opacity 0');
});
