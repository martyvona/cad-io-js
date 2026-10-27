import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTheme } from '../src/theme.ts';

test('resolveTheme: auto is the system\'s; light and dark are themselves, whatever the system', () => {
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
  for (const system of [true, false]) {
    assert.equal(resolveTheme('light', system), 'light');
    assert.equal(resolveTheme('dark', system), 'dark');
  }
});
