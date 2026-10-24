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
  mesh: svg('<path d="M2 13L8 2l6 11z M5 7.5h6M8 2v11"/>'),
  lines: svg('<path d="M2 13L8 2l6 11"/>'),
};

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
        content.innerHTML = `<span class="tree-icon">${ICONS[n.kind]}</span><span class="tree-name"></span>`;
        content.lastElementChild!.textContent = n.name;
        content.parentElement!.classList.toggle('hidden', model.hiddenInTree(n.id));
        content.parentElement!.title = `${n.kind}: ${n.name}`;
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

  /** Selects nodes from elsewhere (picking), showing the first. */
  select(ids: readonly number[]): void {
    this.selection = [...ids];
    this.view.setSelection(ids.map(String));
    if (ids.length) this.view.reveal(String(ids[0]));
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
