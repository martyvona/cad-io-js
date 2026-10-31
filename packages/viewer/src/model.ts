// The viewer's node model: what the tree shows and what selection and hiding act on, made from the model's scene
// graph (scene-graph.ts), whatever its format (the user, 2026-10-24; CLAUDE.md, "The viewer"). Kinds:
//
//   assembly, part: the placements (the graph says which groups are which: component instances and placed parts);
//   below a part, when the tree shows detail (built when first asked for): its faces (those with ids), one node for
//     all its B-rep edges, its curves and its points.
//
// Paths name nodes stably, for links, the automation interface (automation.ts) and recordings: each node's
// segment is its name (`/`, `:` and `%` escaped as in URLs), or below a part `face#<source id>`, `edges`, `curves`
// or `points`, followed by `:k` for the k-th sibling with that segment (k > 1); the
// path joins the segments from the top node down with `/` (`as1/l-bracket-assembly:2/nut`). A path finds its node
// whether or not the tree shows detail.
//
// Appearance (the user, 2026-10-31: hiding and transparency one mechanism): a node may have an AppearanceOverride,
// whose slots (hidden, alpha) hold for it and for every node below it that doesn't set the same slot itself; the
// file's hidden placements start with `hidden: true`. Hide, Show and the opacity buttons collapse the nodes they're
// given to the fewest that cover them (a node whose children are all given stands for them), set the slot there and
// clear it below. A placement draws as its overrides resolve: its group and line objects' `visible`, and its faces'
// materials through the scene graph (Looks), per placement (before 2026-10-31 a face's hiding was its part's, in
// every placement). Detail nodes' overrides are kept on their part by segment, so they outlast the detail nodes
// (made again when a mesh arrives) and can be set before the mesh is there.

import * as THREE from 'three';

export type Kind = 'assembly' | 'part' | 'face' | 'edges' | 'curves' | 'points';

export interface ViewNode {
  id: number;
  kind: Kind;
  name: string;
  /** -1 at the top level. */
  parent: number;
  /** What hiding the node hides: the object and its subtree. */
  object?: THREE.Object3D;
  /** Faces: the part (scene index) and the face's source id. */
  face?: { part: number; source: number };
  /**
   * A face that failed to mesh (cad-scene's faceFailures, by its part's measures where it has them): `failed` for
   * one drawn as failed (no triangles, a mesh much larger than the face, or no area to judge it by: the kind is in
   * its mesh's `faceReport`), `partly` for one short of its area; outlined in red (scene-graph.ts).
   */
  failure?: 'failed' | 'partly';
  /** Its own override (assemblies and parts; detail nodes' are their part's `detailOverrides`). */
  override?: AppearanceOverride;
  /** A part's detail nodes' overrides, by their path segment (`face#12`, `edges`). */
  detailOverrides?: Map<string, AppearanceOverride>;
  /** Undefined until first asked for (a part's detail). */
  children?: number[];
}

/**
 * A node's own appearance, each slot inherited by the nodes below it that don't set it: hidden (true) or shown
 * (false), and an opacity, `alpha` (1 the file's own opacity).
 */
export interface AppearanceOverride { hidden?: boolean; alpha?: number }

/** An override as states and links name it: the node's path and its slots. */
export interface PathOverride extends AppearanceOverride { path: string }

/**
 * How a placement draws, its overrides resolved: hidden or not, an opacity (absent: the file's), and the faces whose
 * own overrides make them differ, resolved likewise.
 */
export interface PlacementLook {
  hidden: boolean;
  alpha?: number;
  faces?: ReadonlyMap<number, { hidden: boolean; alpha?: number }>;
}

/** What the scene graph does with a placement's look: its faces' materials (scene-graph.ts). */
export interface Looks {
  setLook(group: THREE.Object3D, look: PlacementLook): void;
}

type Slot = keyof AppearanceOverride;
const LINES = ['edges', 'curves', 'points'];
/** A slot's value when nothing sets it. */
const DEFAULT: Required<AppearanceOverride> = { hidden: false, alpha: 1 };


/** A name as a path segment: `%`, `/` and `:` escaped as in URLs. */
export function escapeSegment(name: string): string {
  return name.replace(/[%/:]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export class NodeModel {
  readonly nodes: ViewNode[] = [];
  readonly roots: number[] = [];
  private readonly byObject = new Map<THREE.Object3D, number>();
  private readonly looks?: Looks;
  private detail = false;

  constructor(root: THREE.Object3D, looks?: Looks) {
    this.looks = looks;
    // The loaded root itself is the top node.
    this.roots.push(this.build(root, -1));
    this.applyAll();
  }

  private add(n: Omit<ViewNode, 'id'>): number {
    const id = this.nodes.length;
    this.nodes.push({ id, ...n });
    if (n.object) this.byObject.set(n.object, id);
    return id;
  }

  /** The structure from `o` down to parts. */
  private build(o: THREE.Object3D, parent: number): number {
    // (The graph's root, the model, an assembly too.)
    const part = o.userData.cad === 'part';
    const kind: Kind = part ? 'part' : 'assembly';
    // (The file's hidden placements: overrides of their own.)
    const id = this.add({ kind, name: o.name || 'group', parent, object: o, ...(o.visible ? {} : { override:
      { hidden: true } }) });
    if (!part) this.nodes[id]!.children = o.children.map((c) => this.build(c, id));
    return id;
  }

  /** A part's detail nodes. */
  private detailOf(id: number): number[] {
    const p = this.nodes[id]!;
    const o = p.object!;
    const out: number[] = [];
    // The placement's mesh object, with its faces in userData and its lines as children.
    for (const m of o.children) {
      const faces = (m.userData.faces as number[] | undefined) ?? [];
      const failed = new Set((m.userData.failedFaces as number[] | undefined) ?? []);
      const partly = new Set((m.userData.partlyFailedFaces as number[] | undefined) ?? []);
      const partIndex = o.userData.part as number;
      for (const source of faces) out.push(this.add({ kind: 'face', name: `face #${source}`, parent: id,
        face: { part: partIndex, source }, ...(failed.has(source) ? { failure: 'failed' as const }
          : partly.has(source) ? { failure: 'partly' as const } : {}) }));
      for (const c of m.children) if (LINES.includes(c.name)) out.push(this.add(
        { kind: c.name as Kind, name: c.name, parent: id, object: c }));
    }
    return out;
  }

  /** Whether parts show their faces, edges, curves and points. */
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

  /** A part's detail is stale (its mesh arrived): built again when next asked for, its look applied again. */
  invalidate(object: THREE.Object3D): void {
    const id = this.byObject.get(object);
    if (id === undefined || this.nodes[id]!.kind !== 'part') return;
    delete this.nodes[id]!.children;
    this.applyPart(id);
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
      const base = n.kind === 'face' ? `face#${n.face!.source}` : escapeSegment(n.name);
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

  /**
   * Meshing failures (the user, 2026-10-28; by measures 2026-10-30): a face drawn as failed, or a part all of whose
   * faces are, `failed`; a face short of its area (cad-scene's faceFailures), or a part some of whose faces failed in
   * any way, `partly`.
   */
  failure(id: number): 'failed' | 'partly' | undefined {
    const n = this.nodes[id];
    if (!n) return undefined;
    if (n.face) return n.failure;
    if (n.kind !== 'part' || n.object?.userData.cad !== 'part') return undefined;
    for (const m of n.object.children) {
      const failed = (m.userData.failedFaces as number[] | undefined)?.length ?? 0;
      const partly = (m.userData.partlyFailedFaces as number[] | undefined)?.length ?? 0;
      if (failed && failed === (m.userData.faces as number[]).length) return 'failed';
      if (failed || partly) return 'partly';
    }
    return undefined;
  }

  /**
   * The others of a selection (Hide others; the user, 2026-10-31): the coarsest nodes that are none of these, none
   * of their ancestors and none of their descendants, the siblings of each and of each ancestor up to the roots;
   * hiding them leaves the selection and what holds it (a selected face's part keeps nothing else but its node).
   */
  others(ids: readonly number[]): number[] {
    const chosen = new Set(ids), keep = new Set<number>();
    for (const id of ids) for (let n = id; n >= 0 && this.nodes[n]; n = this.nodes[n]!.parent) keep.add(n);
    const out: number[] = [];
    const visit = (id: number) => {
      if (chosen.has(id)) return;
      if (!keep.has(id)) out.push(id);
      else for (const c of this.children(id)) visit(c);
    };
    for (const r of this.roots) visit(r);
    return out;
  }

  /** A node's own override, if it has one (a detail node's from its part). */
  ownOverride(id: number): AppearanceOverride | undefined {
    const n = this.nodes[id];
    if (!n) return undefined;
    if (n.kind === 'assembly' || n.kind === 'part') return n.override;
    return this.nodes[n.parent]!.detailOverrides?.get(this.segmentOf(id));
  }

  private segmentOf(id: number): string {
    this.segmentsOf(this.siblingsOf(id));
    return this.segments.get(id)!;
  }

  /** Each slot as the node draws with it: its own, else its nearest ancestor's that sets it, else the default. */
  look(id: number): Required<AppearanceOverride> {
    const out: AppearanceOverride = {};
    for (let n = this.nodes[id]; n; n = this.nodes[n.parent]) {
      const o = this.ownOverride(n.id);
      out.hidden ??= o?.hidden;
      out.alpha ??= o?.alpha;
    }
    return { hidden: out.hidden ?? DEFAULT.hidden, alpha: out.alpha ?? DEFAULT.alpha };
  }

  /** Hidden itself or through an ancestor (its look). */
  hiddenInTree(id: number): boolean {
    return this.look(id).hidden;
  }

  /** A node's override, slot by slot (a slot absent removes it; an override with none goes). */
  private put(id: number, o: AppearanceOverride): void {
    const n = this.nodes[id]!;
    const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as AppearanceOverride;
    const empty = !Object.keys(kept).length;
    if (n.kind === 'assembly' || n.kind === 'part') {
      if (empty) delete n.override;
      else n.override = kept;
      return;
    }
    const part = this.nodes[n.parent]!, seg = this.segmentOf(id);
    if (empty) part.detailOverrides?.delete(seg);
    else (part.detailOverrides ??= new Map()).set(seg, kept);
  }

  /** A slot cleared from every override below a node (a part's detail included). */
  private clearBelow(id: number, slot: Slot): void {
    const n = this.nodes[id]!;
    if (n.kind === 'assembly') for (const c of n.children ?? []) {
      const o = this.nodes[c]!.override;
      if (o) this.put(c, { ...o, [slot]: undefined });
      this.clearBelow(c, slot);
    } else if (n.kind === 'part') for (const [seg, o] of [...n.detailOverrides ?? []]) {
      const kept = { ...o, [slot]: undefined };
      if (kept.hidden === undefined && kept.alpha === undefined) n.detailOverrides!.delete(seg);
      else n.detailOverrides!.set(seg, kept);
    }
  }

  /**
   * The fewest nodes covering these (the user, 2026-10-31): none below another given, and wherever every child of a
   * node is given (a part's: its detail), the node instead, up the tree.
   */
  cover(ids: Iterable<number>): number[] {
    const given = new Set([...ids].filter((id) => this.nodes[id]));
    const under = (id: number) => {
      for (let p = this.nodes[id]!.parent; p >= 0; p = this.nodes[p]!.parent) if (given.has(p)) return true;
      return false;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const id of [...given]) if (under(id)) given.delete(id);
      const parents = new Set([...given].map((id) => this.nodes[id]!.parent).filter((p) => p >= 0));
      for (const p of parents) {
        const kids = this.detailNodes(p);
        if (kids.length && kids.every((k) => given.has(k))) {
          for (const k of kids) given.delete(k);
          given.add(p);
          changed = true;
        }
      }
    }
    return [...given].sort((a, b) => a - b);
  }

  /**
   * Sets a slot on the nodes covering these (`cover`), clearing it below them: hidden true or false, an alpha (1 the
   * file's). Where a node would inherit the value anyway, its own slot is cleared rather than set, so the overrides
   * stay the fewest that draw the same.
   */
  set<S extends Slot>(ids: Iterable<number>, slot: S, value: Required<AppearanceOverride>[S]): void {
    const nodes = this.cover(ids);
    const parts = new Set<number>();
    for (const id of nodes) {
      this.clearBelow(id, slot);
      const n = this.nodes[id]!;
      const inherited = n.parent >= 0 ? this.look(n.parent)[slot] : DEFAULT[slot];
      this.put(id, { ...this.ownOverride(id), [slot]: inherited === value ? undefined : value });
      this.partsUnder(id, parts);
    }
    for (const p of parts) this.applyPart(p);
  }

  /** The parts at or below a node, or a detail node's part. */
  private partsUnder(id: number, into: Set<number>): void {
    const n = this.nodes[id]!;
    if (n.kind === 'part') into.add(id);
    else if (n.kind === 'assembly') for (const c of n.children ?? []) this.partsUnder(c, into);
    else into.add(n.parent);
  }

  /** Shows everything: every hidden slot cleared, the file's hidden placements' included. */
  showAll(): void {
    for (const n of this.nodes) {
      if (n.override) this.put(n.id, { ...n.override, hidden: undefined });
      if (n.kind === 'part') this.clearBelow(n.id, 'hidden');
    }
    this.applyAll();
  }

  /** Every override, by path, in node order (a part's detail after it, by segment). */
  overrides(): PathOverride[] {
    const out: PathOverride[] = [];
    for (const n of this.nodes) {
      if (n.kind !== 'assembly' && n.kind !== 'part') continue;
      if (n.override) out.push({ path: this.pathOf(n.id), ...n.override });
      for (const [seg, o] of [...n.detailOverrides ?? []].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        out.push({ path: `${this.pathOf(n.id)}/${seg}`, ...o });
      }
    }
    return out;
  }

  /**
   * Exactly these overrides (a state's: the others cleared), each set as it is. A path below a part names its detail
   * by segment, so it can be set before the part's mesh (and so its detail nodes) arrives. Returns the paths that
   * name nothing.
   */
  setOverrides(list: readonly PathOverride[], slots: readonly Slot[] = ['hidden', 'alpha']): string[] {
    for (const n of this.nodes) {
      for (const slot of slots) {
        if (n.override) this.put(n.id, { ...n.override, [slot]: undefined });
        if (n.kind === 'part') this.clearBelow(n.id, slot);
      }
    }
    const missing: string[] = [];
    for (const { path, ...o } of list) {
      const wanted = Object.fromEntries(slots.flatMap((k) => o[k] === undefined ? [] : [[k, o[k]]]));
      if (!Object.keys(wanted).length) continue;
      const id = this.find(path);
      if (id !== undefined) {
        this.put(id, { ...this.ownOverride(id), ...wanted });
        continue;
      }
      const cut = path.lastIndexOf('/'), seg = path.slice(cut + 1);
      const part = cut > 0 ? this.find(path.slice(0, cut)) : undefined;
      if (part !== undefined && this.nodes[part]!.kind === 'part' && (/^face#\d+$/.test(seg) || LINES.includes(seg))) {
        const map = (this.nodes[part]!.detailOverrides ??= new Map());
        map.set(seg, { ...map.get(seg), ...wanted });
      } else missing.push(path);
    }
    this.applyAll();
    return missing;
  }

  private applyAll(): void {
    for (const n of this.nodes) if (n.kind === 'part') this.applyPart(n.id);
  }

  /**
   * A placement drawn as its overrides resolve: its faces' looks to the scene graph, its edges', curves' and points'
   * objects shown or hidden, its group hidden only when nothing below it is shown.
   */
  private applyPart(id: number): void {
    const n = this.nodes[id]!, group = n.object!;
    const look = this.look(id);
    const alpha = (a: number) => (a === 1 ? {} : { alpha: a });
    let shown = !look.hidden;
    const faces = new Map<number, { hidden: boolean; alpha?: number }>();
    for (const [seg, o] of n.detailOverrides ?? []) {
      const m = /^face#(\d+)$/.exec(seg);
      if (!m) continue;
      const hidden = o.hidden ?? look.hidden;
      faces.set(Number(m[1]), { hidden, ...alpha(o.alpha ?? look.alpha) });
      shown ||= !hidden;
    }
    for (const m of group.children) for (const c of m.children) if (LINES.includes(c.name)) {
      c.visible = !(n.detailOverrides?.get(c.name)?.hidden ?? look.hidden);
      shown ||= c.visible;
    }
    group.visible = shown;
    this.looks?.setLook(group, { hidden: look.hidden, ...alpha(look.alpha), ...(faces.size ? { faces } : {}) });
  }
}
