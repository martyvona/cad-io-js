import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VIEWS } from '../src/camera.ts';
import { fromKeyboard, nextTriangleEdges, shortcutOf, VIEW_KEYS } from '../src/shortcuts.ts';

const press = (key: string, o: Partial<Parameters<typeof shortcutOf>[0]> = {}) => shortcutOf({ key, ctrlKey: false,
  metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, target: null, ...o });
/** A target whose closest() matches selectors starting with these (as an element inside such would). */
const inside = (...starts: string[]) => ({ closest: (sel: string) => (sel.split(',').some((s) =>
  starts.some((t) => s.trim().startsWith(t))) ? {} : null) }) as unknown as EventTarget;

test('shortcutOf: f, h, s, t, g, and 1 to 7 the views in Look Along an Axis\'s order; other keys none', () => {
  assert.deepEqual(press('f'), { type: 'zoom' });
  assert.deepEqual(press('h'), { type: 'hide' });
  assert.deepEqual(press('s'), { type: 'show' });
  assert.deepEqual(press('t'), { type: 'tree' });
  assert.deepEqual(press('g'), { type: 'triangleEdges' });
  assert.deepEqual(['1', '2', '3', '4', '5', '6', '7'].map((k) => press(k)),
    ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'].map((view) => ({ type: 'view', view })));
  // (The menu's order is VIEWS's.)
  assert.deepEqual(VIEW_KEYS, Object.keys(VIEWS));
  for (const k of ['0', '8', '9', '12', 'a', 'x', 'F', 'Enter', 'Escape', 'ArrowUp', ' ']) {
    assert.equal(press(k), undefined, k);
  }
});

test('shortcutOf: none with a modifier, repeated, already handled, or in a text field or dialog', () => {
  for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat', 'defaultPrevented'] as const) {
    assert.equal(press('f', { [m]: true }), undefined, m);
    assert.equal(press('1', { [m]: true }), undefined, m);
  }
  for (const t of ['input', 'textarea', 'select', 'dialog', '[contenteditable']) {
    assert.equal(press('f', { target: inside(t) }), undefined, t);
  }
  // Elsewhere (the page, the canvas, the tree, a control's button): taken.
  assert.deepEqual(press('f', { target: inside('div') }), { type: 'zoom' });
  assert.deepEqual(press('f', { target: {} as EventTarget }), { type: 'zoom' });
});

test('nextTriangleEdges: selected or all to off; off to selected with a selection, else all', () => {
  for (const any of [false, true]) {
    assert.equal(nextTriangleEdges('selected', any), 'off');
    assert.equal(nextTriangleEdges('all', any), 'off');
  }
  assert.equal(nextTriangleEdges('off', true), 'selected');
  assert.equal(nextTriangleEdges('off', false), 'all');
});

test('fromKeyboard: a key outside a text field (where no on-screen keyboard shows) says there\'s a keyboard', () => {
  for (const t of ['input', 'textarea', 'select', '[contenteditable']) {
    assert.equal(fromKeyboard({ target: inside(t) }), false, t);
  }
  // A dialog's buttons, the page, the canvas, the tree: only a physical keyboard types there.
  assert.equal(fromKeyboard({ target: inside('dialog') }), true);
  assert.equal(fromKeyboard({ target: inside('div') }), true);
  assert.equal(fromKeyboard({ target: null }), true);
});
