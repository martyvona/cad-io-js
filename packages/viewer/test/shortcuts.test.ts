import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AXIS_VIEWS } from '../src/camera.ts';
import { fromKeyboard, nextTriangleEdges, shortcutOf, VIEW_KEYS } from '../src/shortcuts.ts';

const press = (key: string, o: Partial<Parameters<typeof shortcutOf>[0]> = {}) => shortcutOf({ key,
  code: /^[0-9]$/.test(key) ? `Digit${key}` : '', ctrlKey: false,
  metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, target: null, ...o });
/** A target whose closest() matches selectors starting with these (as an element inside such would). */
const inside = (...starts: string[]) => ({ closest: (sel: string) => (sel.split(',').some((s) =>
  starts.some((t) => s.trim().startsWith(t))) ? {} : null) }) as unknown as EventTarget;

test('shortcutOf: f, h, s, t, g, Escape, and 1 to 9 the views in Look Along an Axis\'s order; other keys none', () => {
  assert.deepEqual(press('f'), { type: 'zoom' });
  assert.deepEqual(press('h'), { type: 'hide' });
  assert.deepEqual(press('s'), { type: 'show' });
  assert.deepEqual(press('t'), { type: 'tree' });
  assert.deepEqual(press('g'), { type: 'triangleEdges' });
  assert.deepEqual(press('Escape'), { type: 'selectNone' });
  const views = ['front', 'back', 'left', 'right', 'top', 'bottom', 'isoX', 'isoY', 'isoZ'];
  assert.deepEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => press(k)),
    views.map((view) => ({ type: 'view', view, shift: false })));
  // (The menu's order.)
  assert.deepEqual(VIEW_KEYS, AXIS_VIEWS.map((v) => v.view));
  assert.deepEqual(AXIS_VIEWS.map((v) => v.name), ['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom', 'Iso X',
    'Iso Y', 'Iso Z']);
  for (const k of ['0', '12', 'a', 'x', 'F', 'Enter', 'Esc', 'ArrowUp', ' ']) {
    assert.equal(press(k), undefined, k);
  }
});

test('shortcutOf: none with a modifier, repeated, already handled, or in a text field or dialog', () => {
  for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat', 'defaultPrevented'] as const) {
    assert.equal(press('f', { [m]: true }), undefined, m);
    if (m !== 'shiftKey') assert.equal(press('1', { [m]: true }), undefined, m);
    assert.equal(press('Escape', { [m]: true }), undefined, m);
  }
  // Shift with a view's digit (by its code: shifted, the key is another character, '!' or '"' by layout): shifted;
  // other digits and keys with shift, none; shift with ctrl, none.
  assert.deepEqual(['!', '@', '('].map((key, i) => shortcutOf({ key, code: `Digit${[1, 2, 9][i]}`, ctrlKey: false,
    metaKey: false, altKey: false, shiftKey: true, repeat: false, defaultPrevented: false, target: null })),
  ['front', 'back', 'isoZ'].map((view) => ({ type: 'view', view, shift: true })));
  assert.equal(press(')', { code: 'Digit0', shiftKey: true }), undefined);
  assert.equal(press('1', { code: '', shiftKey: true }), undefined);
  assert.equal(press('!', { code: 'Digit1', shiftKey: true, ctrlKey: true }), undefined);
  assert.equal(press('!', { code: 'Digit1', shiftKey: true, target: inside('input') }), undefined);
  for (const t of ['input', 'textarea', 'select', 'dialog', '[contenteditable']) {
    assert.equal(press('f', { target: inside(t) }), undefined, t);
    assert.equal(press('Escape', { target: inside(t) }), undefined, t);
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
