// Pick... (the 3D view's context menu: ui.ts): everything along the line of sight through the point clicked, nearest
// first, as a flat list of the tree's rows (tree-panel.ts's drawRow) in a movable modal dialog (dialog.ts). The list
// draws only the rows in view (a fixed row height, rows absolutely placed over a spacer, as headless-tree-view.ts
// does), so it holds any number. Clicks, shift-clicks, ctrl/cmd-clicks and multi-select select as the tree's rows do
// (listClick); the row under the mouse is marked `hovered`. A cursor, the tree's focus outline, starts on the first
// row and stays on one row until the dialog closes: the arrows move it, Space and Shift+Space click and shift-click
// its row, a click moves it there; its row is marked `alert` too (drawn in the alert colour: index.html).

import { showDialog } from './dialog.ts';
import type { NodeModel } from './model.ts';
import { drawRow, ROW_HEIGHT } from './tree-panel.ts';

/** Rows drawn above and below those in view. */
const OVERSCAN = 5;
/** Space after a row's content. */
const END = 6;

export interface PickListOptions {
  model: NodeModel;
  /** The nodes, nearest first. */
  ids: readonly number[];
  /** The selection now (the tree's and the view's). */
  selected(): readonly number[];
  /** Whether multi-select is on: every click then adds or removes, as a ctrl/cmd-click does. */
  multi(): boolean;
  /** A click chose this selection. */
  onSelect(ids: number[]): void;
  /** The row under the mouse: its node, or undefined once the mouse leaves the list (or the dialog closes). */
  onHover(id: number | undefined): void;
  /** The cursor's on this node. */
  onCursor(id: number): void;
  /** The dialog closed. */
  onClose(): void;
  /** Sets the list's colours (the hovered and alert rows': ui.ts), on its element. */
  style?(el: HTMLElement): void;
}

export interface ClickKeys { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }

/**
 * A click on the list's row `i` as a tree row's (headless-tree-view.ts's): the selection after it, and the anchor a
 * shift-click spans from (the row last clicked without shift; undefined: none). A plain click selects the row alone,
 * or takes it out if selected; ctrl/cmd adds or removes it; shift selects the rows from the anchor (adding them, with
 * ctrl/cmd), and on a selected row takes them out; a shift-click with nothing selected, or no anchor, is a plain
 * click. With `multi`, every click as with ctrl/cmd held. The selection may hold nodes outside the list.
 */
export function listClick(ids: readonly number[], selected: readonly number[], anchor: number | undefined, i: number,
  keys: ClickKeys, multi = false): { selected: number[]; anchor: number | undefined } {
  const k = multi && !keys.ctrlKey && !keys.metaKey ? { shiftKey: keys.shiftKey, ctrlKey: true, metaKey: false }
    : keys;
  const ctrl = k.ctrlKey || k.metaKey;
  const id = ids[i]!;
  if (k.shiftKey && !selected.length) anchor = undefined;
  const span = () => {
    const [a, b] = [Math.min(anchor!, i), Math.max(anchor!, i)];
    return ids.slice(a, b + 1);
  };
  const isSelected = selected.includes(id);
  if (isSelected && (k.shiftKey || !ctrl)) {
    const out = new Set(k.shiftKey && anchor !== undefined ? span() : [id]);
    return { selected: selected.filter((s) => !out.has(s)), anchor: k.shiftKey && anchor !== undefined ? anchor : i };
  }
  if (k.shiftKey) {
    if (anchor === undefined) return { selected: [id], anchor: i };
    return { selected: ctrl ? [...new Set([...selected, ...span()])] : span(), anchor };
  }
  if (ctrl) return { selected: isSelected ? selected.filter((s) => s !== id) : [...selected, id], anchor: i };
  return { selected: [id], anchor: i };
}

/** Shows the list (none: nothing). Returns its redraw (the selection or the rows' appearance changed). */
export function showPickList(o: PickListOptions): { redraw(): void } {
  const { ids, model } = o;
  const box = document.createElement('div');
  box.className = 'pick-list';
  // (Short lists' boxes as tall as their rows, and a horizontal scroll bar's height.)
  box.style.setProperty('--pick-list-height', `${ids.length * ROW_HEIGHT + 18}px`);
  o.style?.(box);
  const scroller = document.createElement('div');
  scroller.className = 'tree-scroller';
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'listbox');
  scroller.setAttribute('aria-label', 'Picked');
  scroller.setAttribute('aria-multiselectable', 'true');
  const spacer = document.createElement('div');
  spacer.style.cssText = `width: 1px; height: ${ids.length * ROW_HEIGHT}px;`;
  scroller.append(spacer);
  box.append(scroller);
  const rows: HTMLElement[] = [];
  let cursor = 0, anchor: number | undefined;
  let width = 0, hovered: number | undefined, pointer: { x: number; y: number } | undefined;
  let scheduled = false, open = true;

  const row = (slot: number) => {
    let el = rows[slot];
    if (el) return el;
    el = document.createElement('div');
    el.className = 'tree-row';
    el.setAttribute('role', 'option');
    el.style.cssText = `position: absolute; left: 0; min-width: 100%; height: ${ROW_HEIGHT}px; display: flex; ` +
      'align-items: center; white-space: nowrap; box-sizing: border-box; padding-left: 4px;';
    const content = document.createElement('span');
    content.className = 'tree-content';
    el.append(content);
    scroller.append(el);
    rows[slot] = el;
    return el;
  };
  const draw = () => {
    if (!open) return;
    const sel = new Set(o.selected());
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(ids.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_HEIGHT) +
      OVERSCAN);
    let slot = 0;
    for (let i = first; i < last; i++, slot++) {
      const el = row(slot), id = ids[i]!;
      el.style.display = 'flex';
      el.style.top = `${i * ROW_HEIGHT}px`;
      el.dataset.index = String(i);
      el.dataset.id = String(id);
      drawRow(model, id, el.firstElementChild as HTMLElement);
      el.classList.toggle('selected', sel.has(id));
      el.setAttribute('aria-selected', String(sel.has(id)));
      el.classList.toggle('focused', i === cursor);
      el.classList.toggle('alert', i === cursor);
      el.classList.toggle('hovered', i === hovered);
    }
    for (let s = slot; s < rows.length; s++) rows[s]!.style.display = 'none';
    // (Every row as wide as the widest drawn so far, as the tree's: the selection's colour across, the range kept.)
    for (let s = 0; s < slot; s++) {
      const c = rows[s]!.firstElementChild as HTMLElement;
      width = Math.max(width, Math.ceil(c.offsetLeft + c.offsetWidth + END));
    }
    for (let s = 0; s < slot; s++) rows[s]!.style.width = `${width}px`;
    hoverAt();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      draw();
    });
  };
  const hoverAt = () => {
    const el = pointer && document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>('.tree-row');
    const i = el && scroller.contains(el) && el.style.display !== 'none' ? Number(el.dataset.index) : undefined;
    if (i === hovered) return;
    hovered = i;
    for (const r of rows) r.classList.toggle('hovered', i !== undefined && r.dataset.index === String(i));
    o.onHover(i === undefined ? undefined : ids[i]);
  };
  const scrollTo = (i: number) => {
    if (i * ROW_HEIGHT < scroller.scrollTop) scroller.scrollTop = i * ROW_HEIGHT;
    else if ((i + 1) * ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = (i + 1) * ROW_HEIGHT - scroller.clientHeight;
    }
  };
  const moveCursor = (i: number) => {
    cursor = Math.max(0, Math.min(ids.length - 1, i));
    scrollTo(cursor);
    o.onCursor(ids[cursor]!);
    schedule();
  };
  const click = (i: number, keys: ClickKeys) => {
    const r = listClick(ids, o.selected(), anchor, i, keys, o.multi());
    anchor = r.anchor;
    o.onSelect(r.selected);
    moveCursor(i);
  };

  scroller.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
    if (!el || el.dataset.index === undefined) return;
    click(Number(el.dataset.index), e);
    scroller.focus();
  });
  scroller.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveCursor(cursor + (e.key === 'ArrowUp' ? -1 : 1));
    } else if (e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) click(cursor, { shiftKey: e.shiftKey, ctrlKey: false, metaKey: false });
    }
  });
  scroller.addEventListener('scroll', schedule);
  scroller.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pointer = { x: e.clientX, y: e.clientY };
    hoverAt();
  });
  scroller.addEventListener('pointerleave', () => {
    pointer = undefined;
    hoverAt();
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(scroller);

  const noun = ids.length === 1 ? 'item' : 'items';
  void showDialog({ title: `Pick: ${ids.length.toLocaleString('en-US')} ${noun}`, closeButton: true,
    body: [], content: box, buttons: [] }).then(() => {
    open = false;
    resize.disconnect();
    pointer = undefined;
    if (hovered !== undefined) {
      hovered = undefined;
      o.onHover(undefined);
    }
    o.onClose();
  });
  // (The view behind not dimmed: its highlight and alert are what the list shows there.)
  box.closest('dialog')?.classList.add('pick');
  o.onCursor(ids[0]!);
  draw();
  scroller.focus();
  return { redraw: schedule };
}
