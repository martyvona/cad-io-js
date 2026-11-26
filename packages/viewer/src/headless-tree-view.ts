// The tree view (tree-view.ts) on Headless Tree (`@headless-tree/core`; after a spike: see docs/viewer.md, and
// workdir/2026-10-24_tree_spike/NOTES.md). The library keeps expansion, focus, selection and keys, and gives
// React-style props per item; this file draws the rows in view itself (a fixed row height, rows absolutely placed over
// a spacer) and applies the props to them. The only file that imports the library. What the spike taught: set the
// expanded items at once and rebuild (its expandAll is quadratic); its container props set the element's position,
// hence an inner scroller; a plain click on a folder would toggle it. Rows are as wide as their content, with no
// ellipsis, and all of them as wide as the widest drawn since this view was made (a horizontal scroll bar when names
// don't fit): only the rows in view are drawn, so that's the widest known, kept so the scroll range doesn't jump as
// rows scroll in and out of view.

import { createTree, hotkeysCoreFeature, selectionFeature, syncDataLoaderFeature, type FeatureImplementation,
  type HotkeyConfig, type ItemInstance, type TreeInstance } from '@headless-tree/core';
import type { TreeView, TreeViewOptions } from './tree-view.ts';

const ROOT = '\u0000root';
const INDENT = 14;
/** Rows drawn above and below those in view. */
const OVERSCAN = 5;
/** Space after a row's content. */
const END = 6;

/** What the library keeps between clicks (`selectUpToAnchorId`: the row last clicked without shift), and ours. */
type ClickData = { selectUpToAnchorId?: string | null; holdSelection?: boolean };

// Plain clicks select and focus; only the expander expands and collapses. A shift-click with nothing selected (a
// click on nothing in the 3D view may have cleared it) is a plain click: the library's range would start at the row
// last clicked, no longer selected, so its anchor is dropped first (with none, selectUpTo selects the row alone).
// A click on a selected row takes it out of the selection, a shift-click the rows from it to the anchor (as a
// shift-click selects them), instead of what the library does; its selection changes on the way aren't reported
// (`holdSelection`), only the result. A ctrl/cmd-click is the library's toggle.
const clickSelectsOnly: FeatureImplementation<string> = {
  key: 'click-selects-only',
  itemInstance: {
    getProps: ({ tree, item, itemId, prev }) => {
      const p = prev?.() ?? {};
      return { ...p, onClick: (e: MouseEvent) => {
        const data = tree.getDataRef().current as ClickData;
        const before = tree.getState().selectedItems ?? [];
        if (e.shiftKey && before.length === 0) data.selectUpToAnchorId = null;
        const deselect = item.isSelected() && (e.shiftKey || !(e.ctrlKey || e.metaKey));
        let span = [itemId];
        if (deselect && e.shiftKey && data.selectUpToAnchorId) {
          const ids = tree.getItems().map((i) => i.getId());
          const a = ids.indexOf(data.selectUpToAnchorId), b = ids.indexOf(itemId);
          if (a >= 0) span = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
        }
        const was = item.isExpanded();
        data.holdSelection = deselect;
        try {
          (p.onClick as ((e: MouseEvent) => void) | undefined)?.(e);
        } finally {
          data.holdSelection = false;
        }
        if (deselect) {
          const out = new Set(span);
          tree.setSelectedItems(before.filter((id) => !out.has(id)));
        }
        if (item.isExpanded() !== was) {
          if (was) item.expand();
          else item.collapse();
        }
      } };
    },
  },
};

type Handlers = HTMLElement & { _handlers?: Map<string, EventListener> };

/** React-style props onto an element: event handlers (replacing those set last time), attributes, the ref. */
function applyProps(el: HTMLElement, props: Record<string, unknown>): void {
  const h = el as Handlers;
  for (const [type, f] of h._handlers ?? []) el.removeEventListener(type, f);
  const handlers = new Map<string, EventListener>();
  for (const [k, v] of Object.entries(props)) {
    if (k === 'ref') (v as (e: HTMLElement) => void)(el);
    else if (k.startsWith('on') && typeof v === 'function') {
      const type = k.slice(2).toLowerCase();
      handlers.set(type, v as EventListener);
      el.addEventListener(type, v as EventListener);
    } else if (k === 'style' || k === 'className') continue;
    else {
      const name = k === 'tabIndex' ? 'tabindex' : k;
      if (v === undefined || v === null || v === false) el.removeAttribute(name);
      else el.setAttribute(name, String(v));
    }
  }
  h._handlers = handlers;
}

export class HeadlessTreeView implements TreeView {
  private readonly opts: TreeViewOptions;
  private readonly tree: TreeInstance<string>;
  private readonly scroller = document.createElement('div');
  private readonly spacer = document.createElement('div');
  private readonly rows: HTMLElement[] = [];
  private selected: readonly string[] = [];
  /** The focus cleared (focus(undefined)): the library, focused on nothing, would outline the first row. */
  private unfocused = false;
  private scheduled = false;
  /** Where the mouse is over the tree (client pixels), and the node of the row there. */
  private pointer: { x: number; y: number } | undefined;
  private hovered: string | undefined;
  /** The widest row drawn so far (pixels). */
  private width = 0;

  constructor(opts: TreeViewOptions) {
    this.opts = opts;
    const { data } = opts;
    this.scroller.className = 'tree-scroller';
    this.scroller.style.cssText = 'position: absolute; inset: 0; overflow: auto;';
    this.spacer.style.width = '1px';
    this.scroller.append(this.spacer);
    opts.container.append(this.scroller);
    this.tree = createTree<string>({
      rootItemId: ROOT,
      getItemName: (item) => item.getId() === ROOT ? '' : data.label(item.getId()),
      isItemFolder: (item) => item.getId() === ROOT || data.hasChildren(item.getId()),
      dataLoader: { getItem: (id) => id, getChildren: (id) => [...(id === ROOT ? data.roots() : data.children(id))] },
      scrollToItem: (item) => this.scrollTo(this.tree.getItems().indexOf(item)),
      setState: (state) => {
        const sel = (state as { selectedItems?: string[] }).selectedItems ?? [];
        if (sel !== this.selected && !(this.tree.getDataRef().current as ClickData).holdSelection) {
          this.selected = sel;
          opts.onSelectionChange([...sel]);
        }
        this.schedule();
      },
      features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, clickSelectsOnly],
      // The arrows move the focus through the tree's structure, not its rows (the library's, replaced): up and down
      // to the previous and next sibling, past the first to the parent, past the last to the next sibling of the
      // nearest ancestor that has one; right to the first child, unfolding the node; left to the parent. (Right and
      // left would otherwise scroll the tree sideways. Each entry whole: the library matches keys against ours alone.)
      hotkeys: {
        focusPreviousItem: this.arrow('ArrowUp', (id) => this.sibling(id, -1) ?? data.parent(id)),
        focusNextItem: this.arrow('ArrowDown', (id) => {
          for (let a: string | undefined = id; a !== undefined; a = data.parent(a)) {
            const next = this.sibling(a, 1);
            if (next !== undefined) return next;
          }
          return undefined;
        }),
        expandOrDown: this.arrow('ArrowRight', (id) => {
          const first = data.hasChildren(id) ? data.children(id)[0] : undefined;
          if (first !== undefined) this.expand([id]);
          return first;
        }),
        collapseOrUp: this.arrow('ArrowLeft', (id) => data.parent(id)),
        // Space and shift-space: a click and a shift-click on the focused row (outlined), if any.
        customClick: { hotkey: 'Space', preventDefault: true, handler: (_e, tree) => this.clickFocused(tree, false) },
        customShiftClick: { hotkey: 'Shift+Space', preventDefault: true,
          handler: (_e, tree) => this.clickFocused(tree, true) },
      },
    });
    this.tree.setMounted(true);
    this.tree.rebuildTree();
    applyProps(this.scroller, this.tree.getContainerProps('Model tree'));
    this.scroller.addEventListener('scroll', () => this.schedule());
    this.scroller.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.pointer = { x: e.clientX, y: e.clientY };
      this.hoverAt();
    });
    this.scroller.addEventListener('pointerleave', () => {
      this.pointer = undefined;
      this.hoverAt();
    });
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.draw();
  }

  /** An arrow key's hotkey: the focus moved by `to` (step), held down to repeat, the page's default prevented. */
  private arrow(key: string, to: (id: string) => string | undefined): HotkeyConfig<string> {
    return { hotkey: key, canRepeat: true, preventDefault: true, handler: (_e, tree) => this.step(tree, to) };
  }

  /** A node's sibling `by` places along (-1 the previous), or none. */
  private sibling(id: string, by: number): string | undefined {
    const p = this.opts.data.parent(id);
    const list = p === undefined ? this.opts.data.roots() : this.opts.data.children(p);
    const i = list.indexOf(id);
    return i < 0 ? undefined : list[i + by];
  }

  /**
   * An arrow key: the focus moved to `to(focused)`, if anything. None with the focus cleared (focus(undefined));
   * focused on nothing yet, the library's focus is its first row, as drawn.
   */
  private step(tree: TreeInstance<string>, to: (id: string) => string | undefined): void {
    const focused = tree.getState().focusedItem;
    if (focused === null && this.unfocused) return;
    const target = to(focused ?? tree.getFocusedItem().getId());
    if (target === undefined) return;
    tree.getItemInstance(target).setFocused();
    tree.updateDomFocus();
  }

  /** The focused row clicked (its props' handler, as a click on it would be), shift held or not; none, nothing. */
  private clickFocused(tree: TreeInstance<string>, shiftKey: boolean): void {
    if (tree.getState().focusedItem === null && this.unfocused) return;
    const onClick = tree.getFocusedItem().getProps().onClick as (e: Partial<MouseEvent>) => void;
    onClick({ shiftKey, ctrlKey: false, metaKey: false });
    tree.updateDomFocus();
  }

  /** The scroller's height for the rows now (drawing sets it too, but only at the next frame). */
  private fitSpacer(): void {
    this.spacer.style.height = `${this.tree.getItems().length * this.opts.rowHeight}px`;
  }

  private scrollTo(index: number): void {
    const h = this.opts.rowHeight;
    if (index < 0) return;
    // So the new rows can be scrolled to before they're drawn.
    this.fitSpacer();
    if (index * h < this.scroller.scrollTop) this.scroller.scrollTop = index * h;
    else if ((index + 1) * h > this.scroller.scrollTop + this.scroller.clientHeight) {
      this.scroller.scrollTop = (index + 1) * h - this.scroller.clientHeight;
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => { this.scheduled = false; this.draw(); });
  }

  private row(slot: number): HTMLElement {
    let el = this.rows[slot];
    if (el) return el;
    el = document.createElement('div');
    el.className = 'tree-row';
    el.style.cssText = `position: absolute; left: 0; min-width: 100%; height: ${this.opts.rowHeight}px; ` +
      'display: flex; align-items: center; white-space: nowrap; box-sizing: border-box;';
    const exp = document.createElement('span');
    exp.className = 'tree-expander';
    exp.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = (el as HTMLElement & { _item?: ItemInstance<string> })._item;
      if (!item?.isFolder()) return;
      if (item.isExpanded()) item.collapse();
      else item.expand();
    });
    const content = document.createElement('span');
    content.className = 'tree-content';
    el.append(exp, content);
    this.scroller.append(el);
    this.rows[slot] = el;
    return el;
  }

  private draw(): void {
    const h = this.opts.rowHeight;
    const items = this.tree.getItems();
    this.fitSpacer();
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / h) - OVERSCAN);
    const last = Math.min(items.length, Math.ceil((this.scroller.scrollTop + this.scroller.clientHeight) / h) +
      OVERSCAN);
    let slot = 0;
    for (let i = first; i < last; i++, slot++) {
      const item = items[i]!;
      const el = this.row(slot);
      (el as HTMLElement & { _item?: ItemInstance<string> })._item = item;
      el.style.display = 'flex';
      el.style.top = `${i * h}px`;
      el.style.paddingLeft = `${item.getItemMeta().level * INDENT}px`;
      applyProps(el, item.getProps());
      el.classList.toggle('selected', item.isSelected());
      el.classList.toggle('hovered', item.getId() === this.hovered);
      el.classList.toggle('focused', item.isFocused() && !(this.unfocused &&
        this.tree.getState().focusedItem === null));
      el.dataset.id = item.getId();
      const exp = el.firstElementChild as HTMLElement;
      exp.className = `tree-expander${item.isFolder() ? (item.isExpanded() ? ' open' : ' closed') : ''}`;
      this.opts.renderRow(item.getId(), el.lastElementChild as HTMLElement);
    }
    for (let s = slot; s < this.rows.length; s++) this.rows[s]!.style.display = 'none';
    // Measured once all rows are written (one layout).
    let widest = this.width;
    for (let s = 0; s < slot; s++) {
      const content = this.rows[s]!.lastElementChild as HTMLElement;
      widest = Math.max(widest, Math.ceil(content.offsetLeft + content.offsetWidth + END));
    }
    this.width = widest;
    // (The rows, absolutely placed, make the scroller as wide; at least as wide as it, for the selection's colour.)
    for (let s = 0; s < slot; s++) this.rows[s]!.style.width = `${this.width}px`;
    // (Rows drawn again may have moved under a still mouse: scrolled, or the tree's shape changed.)
    this.hoverAt();
  }

  /** The node of the row under the mouse, marked and reported if it changed. */
  private hoverAt(): void {
    const p = this.pointer;
    const el = p && document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('.tree-row');
    const id = el && this.scroller.contains(el) && el.style.display !== 'none' ? el.dataset.id : undefined;
    if (id === this.hovered) return;
    this.hovered = id;
    for (const row of this.rows) row.classList.toggle('hovered', id !== undefined && row.dataset.id === id);
    this.opts.onHover?.(id);
  }

  refresh(): void {
    this.tree.rebuildTree();
    this.schedule();
  }

  redraw(): void {
    this.schedule();
  }

  focus(id: string | undefined): void {
    // (Through setState, which draws again. Clicks and keys focus a row again, so the flag needs no reset.)
    this.unfocused = id === undefined;
    this.tree.applySubStateUpdate('focusedItem', id ?? null);
  }

  setSelection(ids: readonly string[]): void {
    const sel = [...ids];
    this.selected = sel;
    this.tree.applySubStateUpdate('selectedItems', sel);
    this.tree.rebuildTree();
    this.schedule();
  }

  expand(ids: readonly string[]): void {
    const expanded = new Set([...this.tree.getState().expandedItems ?? [], ...ids]);
    this.tree.applySubStateUpdate('expandedItems', [...expanded]);
    this.tree.rebuildTree();
    this.schedule();
  }

  expanded(): string[] {
    return [...this.tree.getState().expandedItems ?? []];
  }

  setExpanded(ids: readonly string[]): void {
    this.tree.applySubStateUpdate('expandedItems', [...ids]);
    this.tree.rebuildTree();
    this.schedule();
  }

  topRow(): { id: string; offset: number } | undefined {
    const h = this.opts.rowHeight;
    const index = Math.floor(this.scroller.scrollTop / h);
    const item = this.tree.getItems()[index];
    return item && { id: item.getId(), offset: this.scroller.scrollTop - index * h };
  }

  scrollToRow(id: string, offset: number): void {
    const index = this.tree.getItems().findIndex((i) => i.getId() === id);
    if (index < 0) return;
    this.fitSpacer();
    this.scroller.scrollTop = index * this.opts.rowHeight + offset;
    this.schedule();
  }

  reveal(id: string | readonly string[]): void {
    const ids = typeof id === 'string' ? [id] : id;
    if (!ids.length) return;
    const up = new Set<string>();
    for (const i of ids) {
      for (let p = this.opts.data.parent(i); p !== undefined && !up.has(p); p = this.opts.data.parent(p)) up.add(p);
    }
    const expanded = new Set(this.tree.getState().expandedItems ?? []);
    if ([...up].some((p) => !expanded.has(p))) {
      for (const p of up) expanded.add(p);
      this.tree.applySubStateUpdate('expandedItems', [...expanded]);
      this.tree.rebuildTree();
    }
    // (The topmost row of them.)
    const wanted = new Set(ids);
    this.scrollTo(this.tree.getItems().findIndex((i) => wanted.has(i.getId())));
    this.schedule();
  }

  expandAll(): void {
    const ids: string[] = [];
    const visit = (id: string) => {
      if (!this.opts.data.hasChildren(id)) return;
      ids.push(id);
      for (const c of this.opts.data.children(id)) visit(c);
    };
    for (const r of this.opts.data.roots()) visit(r);
    this.tree.applySubStateUpdate('expandedItems', ids);
    this.tree.rebuildTree();
    this.schedule();
  }

  collapseAll(): void {
    this.tree.applySubStateUpdate('expandedItems', []);
    this.tree.rebuildTree();
    this.schedule();
  }

  dispose(): void {
    this.pointer = undefined;
    this.hoverAt();
    this.tree.setMounted(false);
    this.scroller.remove();
  }
}
