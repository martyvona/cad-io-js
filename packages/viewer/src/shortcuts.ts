// The keyboard shortcuts (docs/viewer.md): single keys, no modifiers, each pressing the control it stands for (ui.ts),
// so it does what a click does and is recorded as that control. Not while typing (a text field, a dialog) or with a
// modifier held (the browser's and the tree's own keys: headless-tree-view.ts uses the arrows and modified keys).

import type { ViewName } from './camera.ts';
import type { TriangleEdgesMode } from './triangle-edges.ts';

/** What a key does. */
export type Shortcut =
  /** Zoom selected where anything is selected, else Zoom all. */
  | { type: 'zoom' }
  /** Look along an axis. */
  | { type: 'view'; view: ViewName }
  | { type: 'hide' }
  | { type: 'show' }
  /** Show the tree, or not. */
  | { type: 'tree' }
  /** Triangle edges, the next of its values (nextTriangleEdges). */
  | { type: 'triangleEdges' };

/** The views by their keys, 1 to 7, in Look Along an Axis's order. */
export const VIEW_KEYS: readonly ViewName[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];

/** Where keys are typed (an on-screen keyboard's too). */
const TEXT = 'input, textarea, select, [contenteditable]:not([contenteditable=false])';

const within = (target: EventTarget | null, selector: string) => {
  const t = target as Element | null;
  return !!t && typeof t.closest === 'function' && !!t.closest(selector);
};

/**
 * Whether a key press says there's a physical keyboard: one outside a text field, where an on-screen keyboard can't
 * be (it shows only for one). The keys' hints then show on touch screens too (ui.ts; index.html's .cv-key).
 */
export const fromKeyboard = (e: Pick<KeyboardEvent, 'target'>): boolean => !within(e.target, TEXT);

/** A key's shortcut, if it has one and nothing else should have it: undefined to leave the key alone. */
export function shortcutOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' |
  'repeat' | 'defaultPrevented' | 'target'>): Shortcut | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return undefined;
  if (within(e.target, `${TEXT}, dialog`)) return undefined;
  const k = e.key;
  if (k === 'f') return { type: 'zoom' };
  if (k === 'h') return { type: 'hide' };
  if (k === 's') return { type: 'show' };
  if (k === 't') return { type: 'tree' };
  if (k === 'g') return { type: 'triangleEdges' };
  const n = /^[1-7]$/.test(k) ? Number(k) : 0;
  return n ? { type: 'view', view: VIEW_KEYS[n - 1]! } : undefined;
}

/** Triangle edges' next value for g: selected or all to off; off to selected where anything's selected, else all. */
export function nextTriangleEdges(now: TriangleEdgesMode, anySelected: boolean): TriangleEdgesMode {
  if (now !== 'off') return 'off';
  return anySelected ? 'selected' : 'all';
}
