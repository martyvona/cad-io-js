import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customBackground, hexColour, resolveTheme, VIEW_BACKGROUNDS } from '../src/theme.ts';

test('resolveTheme: auto is the system\'s; light and dark are themselves, whatever the system', () => {
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
  for (const system of [true, false]) {
    assert.equal(resolveTheme('light', system), 'light');
    assert.equal(resolveTheme('dark', system), 'dark');
  }
});

test('custom background: what this browser remembers, else off with the fallback colour; malformed ignored', () => {
  const store = new Map<string, string>();
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
  try {
    assert.deepEqual(customBackground('#faf8f0'), { on: false, color: '#faf8f0' });
    store.set('cad-viewer.background', JSON.stringify({ on: true, color: '#123abc' }));
    assert.deepEqual(customBackground('#faf8f0'), { on: true, color: '#123abc' });
    store.set('cad-viewer.background', JSON.stringify({ on: 'yes', color: '#123abc' }));
    assert.deepEqual(customBackground('#faf8f0'), { on: false, color: '#123abc' });
    for (const bad of [JSON.stringify({ on: true, color: 'red' }), JSON.stringify({ on: true, color: '#12345' }),
      '{', 'null']) {
      store.set('cad-viewer.background', bad);
      assert.deepEqual(customBackground('#404040'), { on: false, color: '#404040' }, bad);
    }
  } finally {
    if (old) Object.defineProperty(globalThis, 'localStorage', old);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  assert.equal(hexColour(0x00ff0a), '#00ff0a');
  assert.equal(hexColour(VIEW_BACKGROUNDS.light), '#ffffff');
});
