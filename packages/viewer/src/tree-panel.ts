// The assembly tree panel: the node model (model.ts) through the tree view (tree-view.ts), with an icon per kind,
// hidden nodes greyed, and the selection (the user, 2026-10-24; CLAUDE.md, "The viewer").

import { HeadlessTreeView } from './headless-tree-view.ts';
import type { Kind, NodeModel } from './model.ts';
import type { TreeView } from './tree-view.ts';

export const ROW_HEIGHT = 18;

const svg = (body: string) => '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  `stroke-width="1.3" aria-hidden="true">${body}</svg>`;
/** An icon per kind of node, 16 x 16, in the text colour. */
export const ICONS: Record<Kind, string> = {
  assembly: svg('<rect x="1.5" y="1.5" width="5" height="5"/><rect x="9.5" y="9.5" width="5" height="5"/>' +
    '<path d="M4 6.5v5.5h5.5"/>'),
  part: svg('<path d="M8 1.5l6 3.2v6.6L8 14.5l-6-3.2V4.7z"/><path d="M2 4.7l6 3.2 6-3.2M8 7.9v6.6"/>'),
  face: svg('<path d="M2 12l3-9h9l-3 9z" fill="currentColor" fill-opacity="0.25"/>'),
  edges: svg('<path d="M2 12l3-9h9l-3 9z"/>'),
  curves: svg('<path d="M1.5 12c3-9 6 3 13-8"/>'),
  points: svg('<circle cx="4" cy="11" r="1.5" fill="currentColor"/>' +
    '<circle cx="8" cy="5" r="1.5" fill="currentColor"/><circle cx="12.5" cy="10" r="1.5" fill="currentColor"/>'),
};

/** A node that failed to mesh (model.ts's failure): a shape with a crack, drawn in the failure colour. */
export const BROKEN_ICON = svg('<path d="M2 12l3-9h4l-1.5 3 2 2-1.5 4z" fill="currentColor" fill-opacity="0.25"/>' +
  '<path d="M10 3h4l-3 9H8.5l1.5-4-2-2z"/>');

export class TreePanel {
  readonly model: NodeModel;
  private readonly view: TreeView;
  private selection: number[] = [];
  /** The selection changed in the tree. */
  onSelect?: (ids: readonly number[]) => void;

  constructor(container: HTMLElement, model: NodeModel) {
    this.model = model;
    const num = (id: string) => Number(id);
    this.view = new HeadlessTreeView({
      container,
      rowHeight: ROW_HEIGHT,
      data: {
        roots: () => model.roots.map(String),
        children: (id) => model.children(num(id)).map(String),
        hasChildren: (id) => model.hasChildren(num(id)),
        label: (id) => model.nodes[num(id)]!.name,
        parent: (id) => {
          const p = model.nodes[num(id)]!.parent;
          return p < 0 ? undefined : String(p);
        },
      },
      renderRow: (id, content) => {
        const n = model.nodes[num(id)]!;
        // Failed to mesh, wholly or partly: red, with a broken icon (the user, 2026-10-30; before, partly had the
        // icon only).
        const failure = model.failure(n.id);
        content.innerHTML = `<span class="tree-icon${failure ? ' broken' : ''}">${failure ? BROKEN_ICON
          : ICONS[n.kind]}</span><span class="tree-name"></span>`;
        content.lastElementChild!.textContent = n.name;
        const row = content.parentElement!;
        row.classList.toggle('hidden', model.hiddenInTree(n.id));
        row.classList.toggle('failed', failure !== undefined);
        row.title = `${n.kind}: ${n.name}${failure === 'failed' ? ' (failed to mesh: its outline drawn in red)'
          : failure === 'partly' ? ' (some faces failed to mesh)' : ''}`;
      },
      onSelectionChange: (ids) => {
        this.selection = ids.map(num);
        this.onSelect?.(this.selection);
      },
    });
    // Two levels open: the file, and what it holds (often one top assembly, whose contents then show).
    this.view.expand([...model.roots, ...model.roots.flatMap((r) => model.children(r))].map(String));
  }

  selected(): readonly number[] {
    return this.selection;
  }

  /**
   * Selects nodes from elsewhere (picking, Select by ID), showing every one, their branches unfolded, unless
   * `reveal` is false (the user, 2026-10-28; before, only the first was shown).
   */
  select(ids: readonly number[], reveal = true): void {
    this.selection = [...ids];
    this.view.setSelection(ids.map(String));
    if (ids.length && reveal) this.view.reveal(ids.map(String));
  }

  /** The expanded nodes. */
  expanded(): number[] {
    return this.view.expanded().map(Number);
  }

  /** Expands exactly these nodes (instead of the first two levels). */
  setExpanded(ids: readonly number[]): void {
    this.view.setExpanded(ids.map(String));
  }

  /** The node at the top of the view, and how many pixels of its row are scrolled past. */
  topRow(): { id: number; offset: number } | undefined {
    const t = this.view.topRow();
    return t && { id: Number(t.id), offset: t.offset };
  }

  scrollToRow(id: number, offset: number): void {
    this.view.scrollToRow(String(id), offset);
  }

  /** Parts show their faces, edges, curves and points, or not. */
  setDetail(on: boolean): void {
    this.model.setDetail(on);
    this.view.refresh();
  }

  /** The model's shape changed (meshes arrived). */
  refresh(): void {
    this.view.refresh();
  }

  /** Only appearance changed (hidden nodes). */
  redraw(): void {
    this.view.redraw();
  }

  expandAll(): void {
    this.view.expandAll();
  }

  collapseAll(): void {
    this.view.collapseAll();
  }

  dispose(): void {
    this.view.dispose();
  }
}
