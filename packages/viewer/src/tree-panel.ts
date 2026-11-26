// The assembly tree panel: the node model (model.ts) through the tree view (tree-view.ts), with an icon per kind,
// hidden nodes greyed, and the selection (docs/viewer.md); an eye after the name of a node with an appearance
// override of its own, and a context menu on a row (right-click, or a long press on a touch screen, where browsers may
// not send one: iOS).

import { LONG_PRESS_MS } from './context-menu.ts';
import { HeadlessTreeView } from './headless-tree-view.ts';
import type { GeometryKind } from './geometry-info.ts';
import type { AppearanceOverride, Kind, NodeModel } from './model.ts';
import type { TreeView } from './tree-view.ts';

export const ROW_HEIGHT = 18;

const svg = (body: string) => '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  `stroke-width="1.3" aria-hidden="true">${body}</svg>`;
/** An icon per kind of node, 16 x 16, in the text colour. */
export const ICONS: Record<Kind, string> = {
  assembly: svg('<rect x="1.5" y="1.5" width="5" height="5"/><rect x="9.5" y="9.5" width="5" height="5"/>' +
    '<path d="M4 6.5v5.5h5.5"/>'),
  part: svg('<path d="M8 1.5l6 3.2v6.6L8 14.5l-6-3.2V4.7z"/><path d="M2 4.7l6 3.2 6-3.2M8 7.9v6.6"/>'),
  faces: svg('<path d="M5 9.5l2-7h7.5l-2 7z"/><path d="M1.5 14l2-7h7.5l-2 7z" fill="currentColor" ' +
    'fill-opacity="0.25"/>'),
  edges: svg('<path d="M2 12l3-9h9l-3 9z"/>'),
  vertices: svg('<circle cx="4" cy="11" r="1.5" fill="currentColor"/>' +
    '<circle cx="8" cy="5" r="1.5" fill="currentColor"/><circle cx="12.5" cy="10" r="1.5" fill="currentColor"/>'),
  face: svg('<path d="M2 12l3-9h9l-3 9z" fill="currentColor" fill-opacity="0.25"/>'),
  edge: svg('<path d="M2.5 13.5l11-11"/><circle cx="2.5" cy="13.5" r="1" fill="currentColor"/>' +
    '<circle cx="13.5" cy="2.5" r="1" fill="currentColor"/>'),
  curve: svg('<path d="M1.5 12c3-9 6 3 13-8"/>'),
  vertex: svg('<circle cx="8" cy="8" r="2.5" fill="currentColor"/>'),
  point: svg('<circle cx="8" cy="8" r="2.5"/>'),
};

const fill = 'fill="currentColor" fill-opacity="0.25"';
/**
 * A face's or edge's icon by its surface or curve (geometry-info.ts's GeometryKind), where its part's B-rep says;
 * kinds without one of their own (trimmed, offset: their basis's is shown; swept) the face's or edge's.
 */
export const GEOMETRY_ICONS: Partial<Record<GeometryKind, string>> = {
  plane: svg(`<path d="M1.5 12l3-8h10l-3 8z" ${fill}/>`),
  cylinder: svg(`<path d="M3 4v8a5 2 0 0 0 10 0V4" ${fill}/><ellipse cx="8" cy="4" rx="5" ry="2"/>`),
  cone: svg(`<path d="M8 2l5 10a5 2 0 0 1-10 0z" ${fill}/><path d="M3 12a5 2 0 0 0 10 0"/>`),
  sphere: svg(`<circle cx="8" cy="8" r="6" ${fill}/><path d="M2 8a6 2 0 0 0 12 0"/>`),
  torus: svg(`<ellipse cx="8" cy="8" rx="6.5" ry="4" ${fill}/>` +
    '<path d="M5 8.2a3 1.2 0 0 0 6 0M5.6 8.6a2.4 1 0 0 1 4.8 0"/>'),
  bspline: svg(`<path d="M1.5 6c2-3 4 0 6.5-2s4 0 6.5-2v7c-2 2-4 0-6.5 2s-4.5 0-6.5 2z" ${fill}/>` +
    '<path d="M8 4v7"/>'),
  extrusion: svg(`<path d="M2 13c2-3 4 1 6-1s4-1 6-3v-5c-2 2-4 1-6 3s-4-2-6 1z" ${fill}/>`),
  revolution: svg(`<path d="M5 1.5c-3 4.5 3 7-1 13h8c-4-6 2-8.5-1-13z" ${fill}/>` +
    '<path d="M8 0.5v15" stroke-width="0.8" stroke-dasharray="1.5 1.5"/>'),
  'curve:line': svg('<path d="M2.5 13.5l11-11"/>'),
  'curve:circle': svg('<circle cx="8" cy="8" r="5.5"/>'),
  'curve:ellipse': svg('<ellipse cx="8" cy="8" rx="6.5" ry="3.5"/>'),
  'curve:hyperbola': svg('<path d="M2 2c5 4 5 8 0 12M14 2c-5 4-5 8 0 12"/>'),
  'curve:parabola': svg('<path d="M2 2c2 15 10 15 12 0"/>'),
  'curve:bspline': svg('<path d="M1.5 12c3-9 6 3 13-8"/><path d="M1.5 12L5 3l6 9 3.5-8" stroke-width="0.7" ' +
    'stroke-dasharray="1 1.5"/>'),
  'curve:polyline': svg('<path d="M2 13l4-7 4 5 4-9"/>'),
  'curve:composite': svg('<path d="M2 13c0-5 3-7 6-7l6-3"/><circle cx="8" cy="6" r="1.2" fill="currentColor"/>'),
};

/** A node that failed to mesh (model.ts's failure): a shape with a crack, drawn in the failure colour. */
export const BROKEN_ICON = svg('<path d="M2 12l3-9h4l-1.5 3 2 2-1.5 4z" fill="currentColor" fill-opacity="0.25"/>' +
  '<path d="M10 3h4l-3 9H8.5l1.5-4-2-2z"/>');

/** An eye, for a node with an appearance override (crossed out when the override hides it). */
export const EYE_ICON = svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/>' +
  '<circle cx="8" cy="8" r="2"/>');
export const EYE_OFF_ICON = svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/>' +
  '<path d="M2.5 13.5l11-11"/>');

/** An override in words, for a row's title: `hidden; opacity 0.3`. */
export function overrideText(o: AppearanceOverride): string {
  return [o.hidden === true ? 'hidden' : o.hidden === false ? 'shown' : '', o.transparent === true
    ? `opacity ${o.alpha ?? 1}` : o.transparent === false ? "the file's opacity" : '', o.triangleEdges === true
    ? 'triangle edges on' : o.triangleEdges === false ? 'triangle edges off' : ''].filter(Boolean).join('; ');
}

/**
 * A node's icon as its row shows it: its kind's, a face's or edge's its surface's or curve's (GEOMETRY_ICONS, named
 * in its tooltip), or broken where it failed to mesh.
 */
function iconHtml(model: NodeModel, id: number): string {
  const failure = model.failure(id);
  const g = failure ? undefined : model.geometry(id);
  const icon = g && GEOMETRY_ICONS[g.kind];
  return `<span class="tree-icon${failure ? ' broken' : ''}"${icon ? ` title="${g!.name}"` : ''}>${
    failure ? BROKEN_ICON : icon ?? ICONS[model.nodes[id]!.kind]}</span>`;
}

/** A node as its row shows it, its icon and its name (the view's context menu's header). */
export function nodeLabel(model: NodeModel, id: number): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = `${iconHtml(model, id)}<span class="tree-name"></span>`;
  el.lastElementChild!.textContent = model.nodes[id]!.name;
  el.classList.toggle('failed', model.failure(id) !== undefined);
  return el;
}

export class TreePanel {
  readonly model: NodeModel;
  private readonly view: TreeView;
  private selection: number[] = [];
  /** The selection changed in the tree. */
  onSelect?: (ids: readonly number[]) => void;
  /** Whether multi-select is on (tree-view.ts's `multi`). */
  multi?: () => boolean;
  /** A row's context menu asked for, at a point of the page (client pixels). */
  onContextMenu?: (id: number, x: number, y: number) => void;
  /** The row under the mouse: its node, or undefined once the mouse leaves the tree (tree-view.ts's onHover). */
  onHover?: (id: number | undefined) => void;
  private readonly container: HTMLElement;
  private readonly listeners: [string, EventListener][] = [];

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
        // Failed to mesh, wholly or partly: red, with a broken icon (before, partly had the icon only).
        const failure = model.failure(n.id);
        content.innerHTML = `${iconHtml(model, n.id)}<span class="tree-name"></span>`;
        content.lastElementChild!.textContent = n.name;
        const own = model.ownOverride(n.id);
        if (own) content.insertAdjacentHTML('beforeend', `<span class="tree-override">${own.hidden ? EYE_OFF_ICON
          : EYE_ICON}</span>`);
        const row = content.parentElement!;
        row.classList.toggle('hidden', model.hiddenInTree(n.id));
        row.classList.toggle('failed', failure !== undefined);
        row.title = `${n.kind}: ${n.name}${failure === 'failed' ? ' (failed to mesh: its outline drawn in red)'
          : failure === 'partly' ? ' (some faces failed to mesh)' : ''}${own ? ` (appearance overridden: ${
          overrideText(own)})` : ''}`;
      },
      onSelectionChange: (ids) => {
        this.selection = ids.map(num);
        this.onSelect?.(this.selection);
      },
      onHover: (id) => this.onHover?.(id === undefined ? undefined : num(id)),
      multi: () => this.multi?.() ?? false,
    });
    this.container = container;
    // A row's context menu: right-click, or a long press with a finger; the focus moved to the row (the selection not).
    const rowAt = (target: EventTarget | null) => {
      const row = (target as HTMLElement | null)?.closest?.<HTMLElement>('.tree-row');
      return row?.dataset.id === undefined ? undefined : Number(row.dataset.id);
    };
    const on = (type: string, f: EventListener) => {
      container.addEventListener(type, f);
      this.listeners.push([type, f]);
    };
    on('contextmenu', (e) => {
      const id = rowAt(e.target), m = e as MouseEvent;
      if (id === undefined) return;
      e.preventDefault();
      this.view.focus(String(id));
      this.onContextMenu?.(id, m.clientX, m.clientY);
    });
    let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | undefined;
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = undefined;
    };
    on('pointerdown', (e) => {
      const p = e as PointerEvent, id = rowAt(e.target);
      cancel();
      if (p.pointerType !== 'touch' || id === undefined) return;
      press = { x: p.clientX, y: p.clientY, timer: setTimeout(() => {
        press = undefined;
        this.view.focus(String(id));
        this.onContextMenu?.(id, p.clientX, p.clientY);
      }, LONG_PRESS_MS) };
    });
    on('pointermove', (e) => {
      const p = e as PointerEvent;
      if (press && Math.hypot(p.clientX - press.x, p.clientY - press.y) > 8) cancel();
    });
    for (const type of ['pointerup', 'pointercancel', 'scroll']) on(type, cancel);
    // The file's roots open (often one top assembly, whose contents then show).
    this.view.expand(model.roots.map(String));
  }

  selected(): readonly number[] {
    return this.selection;
  }

  /**
   * Selects nodes from elsewhere (picking, Select by ID), showing every one, their branches unfolded, unless `reveal`
   * is false (before, only the first was shown).
   */
  select(ids: readonly number[], reveal = true): void {
    this.selection = [...ids];
    this.view.setSelection(ids.map(String));
    if (ids.length && reveal) this.view.reveal(ids.map(String));
  }

  /**
   * Moves the tree's focus (the outlined row) to a node, its branches unfolded and its row scrolled into view, the
   * selection left as it is; undefined: no row outlined (a click in the view on nothing).
   */
  setFocus(id: number | undefined): void {
    if (id !== undefined) this.view.reveal(String(id));
    this.view.focus(id === undefined ? undefined : String(id));
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

  /** Parts show their faces, edges and vertices, or not. */
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
    for (const [type, f] of this.listeners) this.container.removeEventListener(type, f);
    this.view.dispose();
  }
}
