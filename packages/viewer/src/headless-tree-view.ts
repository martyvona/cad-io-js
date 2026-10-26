// The tree view (tree-view.ts) on Headless Tree (`@headless-tree/core`; the user, 2026-10-24, after a spike: see
// CLAUDE.md, "The viewer", and workdir/2026-10-24_tree_spike/NOTES.md). The library keeps expansion, focus,
// selection and keys, and gives React-style props per item; this file draws the rows in view itself (a fixed row
// height, rows absolutely placed over a spacer) and applies the props to them. The only file that imports the
// library. What the spike taught: set the expanded items at once and rebuild (its expandAll is quadratic); its
// container props set the element's position, hence an inner scroller; a plain click on a folder would toggle it.

import { createTree, hotkeysCoreFeature, selectionFeature, syncDataLoaderFeature, type FeatureImplementation,
  type ItemInstance, type TreeInstance } from '@headless-tree/core';
import type { TreeView, TreeViewOptions } from './tree-view.ts';

const ROOT = '\u0000root';
const INDENT = 14;
/** Rows drawn above and below those in view. */
const OVERSCAN = 5;

// Plain clicks select and focus; only the expander expands and collapses.
const clickSelectsOnly: FeatureImplementation<string> = {
  key: 'click-selects-only',
  itemInstance: {
    getProps: ({ item, prev }) => {
      const p = prev?.() ?? {};
      return { ...p, onClick: (e: MouseEvent) => {
        const was = item.isExpanded();
        (p.onClick as ((e: MouseEvent) => void) | undefined)?.(e);
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
  private scheduled = false;

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
        if (sel !== this.selected) {
          this.selected = sel;
          opts.onSelectionChange([...sel]);
        }
        this.schedule();
      },
      features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, clickSelectsOnly],
    });
    this.tree.setMounted(true);
    this.tree.rebuildTree();
    applyProps(this.scroller, this.tree.getContainerProps('Model tree'));
    this.scroller.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.draw();
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
    el.style.cssText = `position: absolute; left: 0; right: 0; height: ${this.opts.rowHeight}px; display: flex; ` +
      'align-items: center; white-space: nowrap;';
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
      el.classList.toggle('focused', item.isFocused());
      el.dataset.id = item.getId();
      const exp = el.firstElementChild as HTMLElement;
      exp.className = `tree-expander${item.isFolder() ? (item.isExpanded() ? ' open' : ' closed') : ''}`;
      this.opts.renderRow(item.getId(), el.lastElementChild as HTMLElement);
    }
    for (; slot < this.rows.length; slot++) this.rows[slot]!.style.display = 'none';
  }

  refresh(): void {
    this.tree.rebuildTree();
    this.schedule();
  }

  redraw(): void {
    this.schedule();
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

  reveal(id: string): void {
    const up: string[] = [];
    for (let p = this.opts.data.parent(id); p !== undefined; p = this.opts.data.parent(p)) up.push(p);
    const expanded = new Set(this.tree.getState().expandedItems ?? []);
    if (up.some((p) => !expanded.has(p))) {
      for (const p of up) expanded.add(p);
      this.tree.applySubStateUpdate('expandedItems', [...expanded]);
      this.tree.rebuildTree();
    }
    this.scrollTo(this.tree.getItems().findIndex((i) => i.getId() === id));
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
    this.tree.setMounted(false);
    this.scroller.remove();
  }
}
