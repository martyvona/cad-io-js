// The tree view as the viewer uses it: deliberately small, so that the library behind it (Headless Tree, in
// headless-tree-view.ts, the only file that imports it) could be replaced (the user, 2026-10-24; CLAUDE.md, "The
// viewer"). The viewer gives the tree's shape by ids and draws each row's content itself; the view keeps expansion,
// focus and selection, draws only the rows in view, and reports selection changes. Ids are strings.

export interface TreeViewData {
  /** The top-level nodes, in order. */
  roots(): readonly string[];
  /** A node's children, in order (computed on demand: called only for expanded nodes). */
  children(id: string): readonly string[];
  /** Whether a node can be expanded (cheap: called for every row drawn). */
  hasChildren(id: string): boolean;
  /** A node's name, for screen readers (and typing to find a node, later). */
  label(id: string): string;
  /** A node's parent, or undefined for a top-level node (for reveal). */
  parent(id: string): string | undefined;
}

export interface TreeViewOptions {
  /** The element the view fills (it scrolls inside it). */
  container: HTMLElement;
  data: TreeViewData;
  /** Pixels; every row has this height. */
  rowHeight: number;
  /** Fills a row's content element (after the indentation and the expander) for a node. */
  renderRow(id: string, content: HTMLElement): void;
  /** The selection changed by the user (clicks, ctrl/cmd-click, shift-click, keys). */
  onSelectionChange(ids: string[]): void;
}

export interface TreeView {
  /** The shape changed (nodes added or removed, children computed differently): rebuild and redraw. */
  refresh(): void;
  /** Only the rows' appearance changed: draw the rows in view again. */
  redraw(): void;
  /** Sets the selection (from elsewhere, as picking in 3D), without reporting it back. */
  setSelection(ids: readonly string[]): void;
  /** Expands these nodes (leaving others as they are). */
  expand(ids: readonly string[]): void;
  /** Expands a node's ancestors and scrolls it into view. */
  reveal(id: string): void;
  expandAll(): void;
  collapseAll(): void;
  dispose(): void;
}
