// The viewer's node model: what the tree shows and what selection and hiding act on, made from the loaded three.js
// graph whatever its format (the user, 2026-10-24; CLAUDE.md, "The viewer"). Kinds:
//
//   assembly, part: the placements (our STEP graph says which groups are which; for three.js's loaders, an object
//     with only drawables at or below it is a part, anything else with children an assembly);
//   below a part, when the tree shows detail (built when first asked for): for STEP, its faces, one node for all
//     its B-rep edges, its curves and its points; for three.js's loaders, its drawables (meshes, lines, points),
//     with the part's own drawing as a node of its own when the part is itself a drawable with children.
//
// Paths name nodes stably, for links, the automation interface (automation.ts) and recordings: each node's
// segment is its name (`/`, `:` and `%` escaped as in URLs), or below a part `face#<source id>`, `edges`, `curves`,
// `points` or `(self)` (a part's own drawing), followed by `:k` for the k-th sibling with that segment (k > 1); the
// path joins the segments from the top node down with `/` (`as1/l-bracket-assembly:2/nut`). A path finds its node
// whether or not the tree shows detail.
//
// One hidden flag per node, the file's hidden state included (a node starts hidden if its object does); a node is
// shown greyed when it or an ancestor is hidden. Hiding sets the object's `visible` (which hides its subtree too),
// or for a part's own drawing its layer (which doesn't), or for a STEP face the face's triangles in every placement
// of its part (the geometry is shared: the user, 2026-10-24).

import * as THREE from 'three';

export type Kind = 'assembly' | 'part' | 'face' | 'edges' | 'curves' | 'points' | 'mesh' | 'lines';

export interface ViewNode {
  id: number;
  kind: Kind;
  name: string;
  /** -1 at the top level. */
  parent: number;
  /** What hiding the node hides: the object and its subtree, or (`self`) only the object's own drawing. */
  object?: THREE.Object3D;
  self?: boolean;
  /** STEP faces: the part (scene index) and the face's source id. */
  face?: { part: number; source: number };
  hidden: boolean;
  /** Undefined until first asked for (a part's detail). */
  children?: number[];
}

/** What the STEP graph does for faces, whose triangles are shared by every placement of their part. */
export interface FaceHiding {
  isFaceHidden(part: number, source: number): boolean;
  setFaceHidden(part: number, source: number, hidden: boolean): void;
  showAllFaces(): void;
}

const drawable = (o: THREE.Object3D) => (o as THREE.Mesh).isMesh === true || (o as THREE.Line).isLine === true ||
  (o as THREE.Points).isPoints === true;
const drawableKind = (o: THREE.Object3D): Kind => (o as THREE.Mesh).isMesh ? 'mesh' : (o as THREE.Points).isPoints
  ? 'points' : 'lines';
/** Everything below `o` is drawable (and so is what's below that). */
const onlyDrawablesBelow = (o: THREE.Object3D): boolean => o.children.every((c) => drawable(c) &&
  onlyDrawablesBelow(c));

/** A name as a path segment: `%`, `/` and `:` escaped as in URLs. */
export function escapeSegment(name: string): string {
  return name.replace(/[%/:]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export class NodeModel {
  readonly nodes: ViewNode[] = [];
  readonly roots: number[] = [];
  private readonly byObject = new Map<THREE.Object3D, number>();
  private readonly faces?: FaceHiding;
  private detail = false;

  constructor(root: THREE.Object3D, faces?: FaceHiding) {
    this.faces = faces;
    // The loaded root itself is the top node.
    this.roots.push(this.build(root, -1));
  }

  private add(n: Omit<ViewNode, 'id'>): number {
    const id = this.nodes.length;
    this.nodes.push({ id, ...n });
    if (n.object && !n.self) this.byObject.set(n.object, id);
    return id;
  }

  /** The structure from `o` down to parts. */
  private build(o: THREE.Object3D, parent: number): number {
    const step = o.userData.cad as 'assembly' | 'part' | undefined;
    const part = step ? step === 'part' : (drawable(o) || o.children.length > 0) && onlyDrawablesBelow(o);
    const kind: Kind = part ? 'part' : 'assembly';
    const id = this.add({ kind, name: o.name || (drawable(o) ? drawableKind(o) : 'group'), parent, object: o,
      hidden: !o.visible });
    if (!part) this.nodes[id]!.children = o.children.map((c) => this.build(c, id));
    return id;
  }

  /** A part's detail nodes. */
  private detailOf(id: number): number[] {
    const p = this.nodes[id]!;
    const o = p.object!;
    const out: number[] = [];
    if (o.userData.cad === 'part') {
      // STEP: the placement's mesh object, with its faces in userData and its lines as children.
      for (const m of o.children) {
        const faces = (m.userData.faces as number[] | undefined) ?? [];
        const partIndex = o.userData.part as number;
        for (const source of faces) out.push(this.add({ kind: 'face', name: `face #${source}`, parent: id,
          face: { part: partIndex, source }, hidden: this.faces?.isFaceHidden(partIndex, source) ?? false }));
        for (const c of m.children) if (['edges', 'curves', 'points'].includes(c.name)) out.push(this.add(
          { kind: c.name as Kind, name: c.name, parent: id, object: c, hidden: !c.visible }));
      }
    } else {
      if (drawable(o) && o.children.length) out.push(this.add({ kind: drawableKind(o), name: `${o.name || 'part'}`
        + ' (itself)', parent: id, object: o, self: true, hidden: !o.layers.isEnabled(0) }));
      const visit = (c: THREE.Object3D) => {
        if (c.userData.highlight) return;
        out.push(this.add({ kind: drawableKind(c), name: c.name || drawableKind(c), parent: id, object: c,
          hidden: !c.visible }));
        c.children.forEach(visit);
      };
      o.children.forEach(visit);
    }
    return out;
  }

  /** Whether parts show their faces, edges, curves and points (or meshes, lines and points). */
  setDetail(on: boolean): void {
    this.detail = on;
  }

  hasDetail(): boolean {
    return this.detail;
  }

  children(id: number): readonly number[] {
    const n = this.nodes[id]!;
    if (n.kind !== 'part') return n.children ?? [];
    if (!this.detail) return [];
    n.children ??= this.detailOf(id);
    return n.children;
  }

  /** Whether a part has detail to show (its mesh may not have arrived yet). */
  hasChildren(id: number): boolean {
    const n = this.nodes[id]!;
    if (n.kind !== 'part') return (n.children?.length ?? 0) > 0;
    if (!this.detail) return false;
    if (n.children) return n.children.length > 0;
    return n.object!.children.length > 0;
  }

  /** A part's detail is stale (its mesh arrived): built again when next asked for. */
  invalidate(object: THREE.Object3D): void {
    const id = this.byObject.get(object);
    if (id !== undefined && this.nodes[id]!.kind === 'part') delete this.nodes[id]!.children;
  }

  private readonly segments = new Map<number, string>();

  /** A part's detail nodes, built whether or not the tree shows them (for paths). */
  private detailNodes(id: number): readonly number[] {
    const n = this.nodes[id]!;
    if (n.kind !== 'part') return n.children ?? [];
    n.children ??= this.detailOf(id);
    return n.children;
  }

  /** The segment of each of these siblings' nodes, cached. */
  private segmentsOf(siblings: readonly number[]): void {
    if (!siblings.length || this.segments.has(siblings[0]!)) return;
    const seen = new Map<string, number>();
    for (const id of siblings) {
      const n = this.nodes[id]!;
      // STEP's edges, curves and points nodes are named so already.
      const base = n.kind === 'face' ? `face#${n.face!.source}` : n.self ? '(self)' : escapeSegment(n.name);
      const k = (seen.get(base) ?? 0) + 1;
      seen.set(base, k);
      this.segments.set(id, k > 1 ? `${base}:${k}` : base);
    }
  }

  private siblingsOf(id: number): readonly number[] {
    const p = this.nodes[id]!.parent;
    return p < 0 ? this.roots : this.detailNodes(p);
  }

  /** The node's path (see the file's comment). */
  pathOf(id: number): string {
    const out: string[] = [];
    for (let n = this.nodes[id]; n; n = this.nodes[n.parent]) {
      this.segmentsOf(this.siblingsOf(n.id));
      out.push(this.segments.get(n.id)!);
    }
    return out.reverse().join('/');
  }

  /** The node a path names, if any (building parts' detail when the path goes below one). */
  find(path: string): number | undefined {
    let siblings: readonly number[] = this.roots;
    let found: number | undefined;
    for (const seg of path.split('/')) {
      this.segmentsOf(siblings);
      found = siblings.find((id) => this.segments.get(id) === seg);
      if (found === undefined) return undefined;
      siblings = this.detailNodes(found);
    }
    return found;
  }

  /** The node an object belongs to: the nearest object up its ancestry that is a node's. */
  nodeOf(object: THREE.Object3D): number | undefined {
    for (let o: THREE.Object3D | null = object; o; o = o.parent) {
      const id = this.byObject.get(o);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  /** Hidden itself or through an ancestor. */
  hiddenInTree(id: number): boolean {
    for (let n = this.nodes[id]; n; n = this.nodes[n.parent]) if (n.hidden) return true;
    return false;
  }

  setHidden(ids: Iterable<number>, hidden: boolean): void {
    for (const id of ids) {
      const n = this.nodes[id];
      if (!n || n.hidden === hidden) continue;
      n.hidden = hidden;
      if (n.face) {
        // Faces are per part: every placement's node of the same face follows.
        this.faces?.setFaceHidden(n.face.part, n.face.source, hidden);
        for (const m of this.nodes) if (m.face && m.face.part === n.face.part && m.face.source === n.face.source) {
          m.hidden = hidden;
        }
      } else if (n.self) {
        if (hidden) n.object!.layers.disable(0);
        else n.object!.layers.enable(0);
      } else if (n.object) n.object.visible = !hidden;
    }
  }

  /** Shows everything: every node, and every object in the model, hidden by the viewer or by the file. */
  showAll(): void {
    for (const n of this.nodes) n.hidden = false;
    for (const r of this.roots) this.nodes[r]!.object!.traverse((o) => {
      o.visible = true;
      o.layers.enable(0);
    });
    this.faces?.showAllFaces();
  }
}
