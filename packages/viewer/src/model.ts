// The viewer's node model: what the tree shows and what selection and hiding act on, made from the model's scene graph
// (scene-graph.ts), whatever its format (docs/viewer.md). Kinds:
//
//   assembly, part: the placements (the graph says which groups are which: component instances and placed parts);
//   below a part, when the tree shows detail (built when first asked for), up to three groups, each only where it has
//     something: `faces` (a face node each, those with ids), `edges` (an edge node each of its B-rep edges, then a
//     curve node each of its free curves) and `vertices` (a vertex node each of its B-rep vertices, once the page
//     holds its model, then a point node each of its isolated points); and after `edges`, beside the groups, one
//     edge node, "detected mesh edges", for the edges detected from its triangles (a mesh without edges of its own, or
//     asked for: Mesh edge detection...), shown and hidden apart from the B-rep edges. Edges, curves, vertices and
//     points are items of their placement's line and point objects (items.ts).
//
// Paths name nodes stably, for links, the automation interface (automation.ts) and recordings: each node's
// segment is its name (`/`, `:` and `%` escaped as in URLs), or below a part `faces`, `edges` or `vertices`, and
// below those `face#<source id>`, `edge#<id>`, `curve#<id>`, `vertex#<id>`, `point#<id>` (the kind alone where
// there's no id), or `detected` for the detected mesh edges (beside the groups), followed by `:k` for the k-th
// sibling with that segment (k > 1); the
// path joins the segments from the top node down with `/` (`as1/l-bracket-assembly:2/nut/faces/face#78`). A path
// finds its node whether or not the tree shows detail. Older paths are read too (legacyDetail): a face's straight
// below its part (`nut/face#78`), the one-node `curves` and `points`, read as the edges and vertices groups, and the
// edges found from the triangles in the edges group (`edges/found`), read as `detected`.
//
// Appearance (hiding and transparency one mechanism): a node may have an AppearanceOverride, whose slots (hidden,
// alpha) hold for it and for every node below it that doesn't set the same slot itself; the file's hidden placements
// start with `hidden: true`. Hide, Show and the opacity buttons collapse the nodes they're given to the fewest that
// cover them (a node whose children are all given stands for them) and set the slot there, leaving the overrides below
// as they are (first cleared below); the tree's Override Appearance... sets one node's exactly. A placement draws as
// its overrides resolve: its group and line objects' `visible`, and its faces' materials through the scene graph
// (Looks), per placement; its line and point objects' items hidden by drawing the objects without them (items.ts).
// Detail nodes' overrides are kept on their part by their path below it (`faces/face#12`), so they outlast the
// detail nodes (made again when a mesh arrives) and can be set before the mesh is there.
//
// Reveal: while any node has `reveal: true` (`revealing`), what doesn't resolve to revealed is a ghost: its faces drawn
// at Rendering's Reveal alpha, only their nearest layer (the scene graph's twins, render.ts's RevealPass), its edges,
// curves and points not drawn; what's revealed draws as it would.

import * as THREE from 'three';
import type { Geometry, GeometryKind } from './geometry-info.ts';
import { DETECTED_EDGES, hideItems, itemsOf } from './items.ts';

export type Kind = 'assembly' | 'part' | 'faces' | 'edges' | 'vertices' | 'face' | 'edge' | 'curve' | 'vertex' |
  'point';

/** A part's detail groups, in order. */
export const GROUPS = ['faces', 'edges', 'vertices'] as const;
export type Group = typeof GROUPS[number];

/** A placement's line and point objects (scene-graph.ts's children of its mesh): whose items each is, in order. */
const ITEM_OBJECTS: Record<string, { group: Group; kind: Kind }> = {
  edges: { group: 'edges', kind: 'edge' }, curves: { group: 'edges', kind: 'curve' },
  vertices: { group: 'vertices', kind: 'vertex' }, points: { group: 'vertices', kind: 'point' },
};

/** Whether a kind is drawn as lines or dots (no opacity of its own: the tree's menu). */
export const isLineKind = (k: Kind): boolean => k === 'edges' || k === 'vertices' || k === 'edge' || k === 'curve' ||
  k === 'vertex' || k === 'point';

/** A path below a part that names detail (normalized: legacyDetail), by its form alone. */
const DETAIL_PATH = /^((faces|edges|vertices)(\/(face|edge|curve|vertex|point)(#\d+)?(:\d+)?)?|detected(:\d+)?)$/;

/** The path below a part of its detected mesh edges (a sibling of its groups). */
const DETECTED = 'detected';

/** An older path below a part as it's named now (the file's comment); unchanged if it's not an older one. */
export function legacyDetail(rel: string): string {
  if (/^face#\d+(:\d+)?$/.test(rel)) return `faces/${rel}`;
  const found = /^edges\/found(:\d+)?$/.exec(rel);
  if (found) return `${DETECTED}${found[1] ?? ''}`;
  if (rel === 'curves') return 'edges';
  if (rel === 'points') return 'vertices';
  return rel;
}

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
  /** Edges, curves, vertices and points: their placement's line or point object, the item's place in its list. */
  item?: { object: THREE.Object3D; k: number; source: number | null };
  /**
   * A face that failed to mesh (cad-scene's faceFailures, by its part's measures where it has them): `failed` for
   * one drawn as failed (no triangles, a mesh much larger than the face, or no area to judge it by: the kind is in
   * its mesh's `faceReport`), `partly` for one short of its area; outlined in red (scene-graph.ts).
   */
  failure?: 'failed' | 'partly';
  /** Its own override (assemblies and parts; detail nodes' are their part's `detailOverrides`). */
  override?: AppearanceOverride;
  /** A part's detail nodes' overrides, by their path below it (`faces/face#12`, `edges`). */
  detailOverrides?: Map<string, AppearanceOverride>;
  /** Edges and vertices groups: their placement's line or point objects (a pick of one finds the group). */
  members?: THREE.Object3D[];
  /** Undefined until first asked for (a part's detail). */
  children?: number[];
  /**
   * A detail node of a part's mesh before it changed, until its part's detail is made again, and then for good if the
   * new mesh has no counterpart (no face with its source id, no such lines): in no part's children, found by nothing.
   */
  dead?: true;
}

/**
 * A node's own appearance, each slot inherited by the nodes below it that don't set it: hidden (true) or shown (false);
 * opacity: `transparent` true at `alpha` (0 to 1), false the file's own opacity (first `alpha` alone, 1 meaning the
 * file's); and its triangles' edges drawn (true) or not (false), where Rendering's Triangle edges decides when nothing
 * sets it. Absent: inherited.
 */
export interface AppearanceOverride {
  hidden?: boolean;
  transparent?: boolean;
  alpha?: number;
  triangleEdges?: boolean;
  /** Revealed (true: drawn as it is while the rest is a ghost), or not (false). */
  reveal?: boolean;
}

/** An override as states and links name it: the node's path and its slots. */
export interface PathOverride extends AppearanceOverride { path: string }

/**
 * How a placement draws, its overrides resolved: hidden or not, an opacity (absent: the file's), and the faces whose
 * own overrides make them differ, resolved likewise.
 */
export interface PlacementLook {
  hidden: boolean;
  alpha?: number;
  /** Drawn as a ghost (Reveal: the file's comment). */
  ghost?: boolean;
  faces?: ReadonlyMap<number, { hidden: boolean; alpha?: number; ghost?: boolean }>;
}

/** What the scene graph does with a placement's look: its faces' materials (scene-graph.ts). */
export interface Looks {
  setLook(group: THREE.Object3D, look: PlacementLook): void;
  /** A face's surface or an edge's or curve's curve, kind and name, where the part's B-rep says (geometry-info.ts). */
  geometry?(part: number, kind: 'face' | 'edge' | 'curve', id: number): Geometry | undefined;
}

/**
 * What a node draws with, its overrides resolved: hidden or not, an opacity (absent: the file's), and its triangles'
 * edges on or off (absent: as Rendering's Triangle edges says).
 */
export interface Look { hidden: boolean; alpha?: number; triangleEdges?: boolean; reveal?: boolean }

/**
 * Triangle edges a placement's overrides ask for (the triangle-edges.ts draws them): the placement's own resolved
 * value (absent: none above it sets it), and its faces' where theirs differ. On its part group's
 * `userData.triangleEdges`.
 */
export interface TriangleEdgesLook { whole?: boolean; faces?: ReadonlyMap<number, boolean> }

/** The slots a change or a state sets: hiding, opacity (`transparent` with its `alpha`), triangle edges, reveal. */
export type Slot = 'hidden' | 'opacity' | 'triangleEdges' | 'reveal';
/** An override's fields of a slot. */
const FIELDS: Record<Slot, (keyof AppearanceOverride)[]> = { hidden: ['hidden'], opacity: ['transparent', 'alpha'],
  triangleEdges: ['triangleEdges'], reveal: ['reveal'] };
/** An override without a slot's fields. */
const without = (o: AppearanceOverride | undefined, slot: Slot): AppearanceOverride => {
  const out = { ...o };
  for (const k of FIELDS[slot]) delete out[k];
  return out;
};
/** An override's opacity as a look's: a number, or undefined for the file's; `null` when it doesn't set it. */
const opacityOf = (o: AppearanceOverride | undefined): number | undefined | null => o?.transparent === undefined ? null
  : o.transparent ? o.alpha ?? 1 : undefined;


/** A name as a path segment: `%`, `/` and `:` escaped as in URLs. */
export function escapeSegment(name: string): string {
  return name.replace(/[%/:]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** A detail node as a part's objects give it: its path below the part, kind and name, and its face or item. */
interface DetailEntry {
  rel: string;
  kind: Kind;
  name: string;
  face?: number;
  item?: { object: THREE.Object3D; k: number; source: number | null };
}

/** A part's detail: its groups, each with its members (line and point objects) and entries; its detected edges. */
interface Detail {
  groups: { group: Group; members: THREE.Object3D[]; entries: DetailEntry[] }[];
  /** The detected mesh edges, one entry per line object (DETECTED_EDGES; one item each), beside the groups. */
  detected: DetailEntry[];
}

/**
 * A part's detail as its placement's objects have it now (its mesh's faces, its line and point objects' items), by
 * group, in order, each entry's segment made unique among its siblings with `:k`; the groups with none left out. The
 * one source both the nodes (detailOf) and the drawing (applyPart) work from, so their paths agree.
 */
function detailEntries(o: THREE.Object3D): Detail {
  const out = GROUPS.map((group) => ({ group, members: [] as THREE.Object3D[], entries: [] as DetailEntry[],
    seen: new Map<string, number>() }));
  const push = (g: typeof out[number], base: string, e: Omit<DetailEntry, 'rel'>) => {
    const k = (g.seen.get(base) ?? 0) + 1;
    g.seen.set(base, k);
    g.entries.push({ rel: `${g.group}/${k > 1 ? `${base}:${k}` : base}`, ...e });
  };
  for (const m of o.children) {
    for (const source of (m.userData.faces as number[] | undefined) ?? []) {
      push(out[0]!, `face#${source}`, { kind: 'face', name: `face #${source}`, face: source });
    }
  }
  for (const [name, { group, kind }] of Object.entries(ITEM_OBJECTS)) {
    const g = out[GROUPS.indexOf(group)]!;
    for (const m of o.children) for (const c of m.children) {
      if (c.name !== name) continue;
      g.members.push(c);
      itemsOf(c).forEach((item, k) => {
        const base = item.source === null ? kind : `${kind}#${item.source}`;
        push(g, base, { kind, name: item.source === null ? kind : `${kind} #${item.source}`,
          item: { object: c, k, source: item.source } });
      });
    }
  }
  const detected: DetailEntry[] = [];
  for (const m of o.children) for (const c of m.children) {
    if (c.name !== DETECTED_EDGES) continue;
    const k = detected.length + 1;
    detected.push({ rel: k > 1 ? `${DETECTED}:${k}` : DETECTED, kind: 'edge', name: 'detected mesh edges',
      item: { object: c, k: 0, source: null } });
  }
  return { groups: out.filter((g) => g.entries.length).map(({ group, members, entries }) => ({ group, members,
    entries })), detected };
}

export class NodeModel {
  readonly nodes: ViewNode[] = [];
  readonly roots: number[] = [];
  private readonly byObject = new Map<THREE.Object3D, number>();
  private readonly looks?: Looks;
  private detail = false;
  /** The scene's parts still to be meshed, and a count of their changes (set by the viewer: Viewer.pending). */
  loadingParts?: () => { parts: ReadonlySet<number>; version: number };
  /** The nodes `loading` says are, for one version of the parts. */
  private loadingNodes?: { version: number; ids: Set<number> };
  /** Whether any node has `reveal: true` (kept by `apply`). */
  private reveals = false;

  constructor(root: THREE.Object3D, looks?: Looks) {
    this.looks = looks;
    // The file's own roots are the top nodes, not a node for the file (a file usually has one root, which a file node
    // would only repeat; several files open at once would want file nodes again).
    for (const c of root.children) this.roots.push(this.build(c, -1));
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

  /** A part's detail nodes: its groups (each with its nodes as children). */
  private detailOf(id: number): number[] {
    const o = this.nodes[id]!.object!;
    // The ids of the detail it had (invalidate), by their paths below it: used again for the same paths.
    const free = new Map<string, number>();
    for (const [k, rel] of this.stale.get(id) ?? []) free.set(rel, k);
    this.stale.delete(id);
    const add = (n: Omit<ViewNode, 'id'>, rel: string) => {
      let k = free.get(rel);
      if (k === undefined) k = this.add(n);
      else {
        free.delete(rel);
        this.nodes[k] = { id: k, ...n };
      }
      for (const m of n.members ?? []) this.byObject.set(m, k);
      // (A detected mesh edges node is its line object's: a pick of it finds the node.)
      if (n.item && rel.startsWith(DETECTED)) this.byObject.set(n.item.object, k);
      this.segments.set(k, rel.slice(rel.lastIndexOf('/') + 1));
      return k;
    };
    const partIndex = o.userData.part as number;
    const failures = new Map<number, 'failed' | 'partly'>();
    for (const m of o.children) {
      for (const f of (m.userData.defectFaces as number[] | undefined) ?? []) failures.set(f, 'partly');
      for (const f of (m.userData.partlyFailedFaces as number[] | undefined) ?? []) failures.set(f, 'partly');
      for (const f of (m.userData.failedFaces as number[] | undefined) ?? []) failures.set(f, 'failed');
    }
    // (A face, edge or curve named for its geometry, where its B-rep says: `cylinder #12`.)
    const named = (e: DetailEntry) => {
      const source = e.face ?? e.item?.source;
      if (source === undefined || source === null || (e.kind !== 'face' && e.kind !== 'edge' && e.kind !== 'curve')) {
        return e.name;
      }
      const g = this.looks?.geometry?.(partIndex, e.kind, source);
      return g ? `${g.name} #${source}` : e.name;
    };
    const out: number[] = [];
    const { groups, detected } = detailEntries(o);
    const loose = () => detected.map((e) => add({ kind: e.kind, name: e.name, parent: id, item: e.item! }, e.rel));
    for (const { group, members, entries } of groups) {
      const g = add({ kind: group, name: group, parent: id, ...(members.length ? { members } : {}) }, group);
      this.nodes[g]!.children = entries.map((e) => {
        const failure = e.face === undefined ? undefined : failures.get(e.face);
        return add({ kind: e.kind, name: named(e), parent: g, ...(e.face === undefined ? {}
          : { face: { part: partIndex, source: e.face } }), ...(e.item ? { item: e.item } : {}),
          ...(failure ? { failure } : {}) }, e.rel);
      });
      out.push(g);
      // (After the edges group, or where it would be.)
      if (group === 'edges' || group === 'faces' && !groups.some((x) => x.group === 'edges')) out.push(...loose());
    }
    if (!groups.some((x) => x.group === 'faces' || x.group === 'edges')) out.unshift(...loose());
    // (Those with no counterpart now stay dead.)
    return out;
  }

  /** Whether parts show their faces, edges and vertices. */
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

  /** Whether a node has children to show (a part's detail: its mesh may not have arrived yet). */
  hasChildren(id: number): boolean {
    const n = this.nodes[id]!;
    if (n.kind !== 'part') return (n.children?.length ?? 0) > 0;
    if (!this.detail) return false;
    if (n.children) return n.children.length > 0;
    return n.object!.children.length > 0;
  }

  /** A face's, edge's or curve's geometry by kind (its icon), where its part's B-rep says; none for other nodes. */
  geometryKind(id: number): GeometryKind | undefined {
    return this.geometry(id)?.kind;
  }

  /** A face's, edge's or curve's geometry, its kind and name (its icon and tooltip); as geometryKind. */
  geometry(id: number): Geometry | undefined {
    const n = this.nodes[id];
    if (!n || n.dead || (n.kind !== 'face' && n.kind !== 'edge' && n.kind !== 'curve')) return undefined;
    const source = n.face?.source ?? n.item?.source;
    if (source === undefined || source === null) return undefined;
    const part = this.nodes[this.partOf(id)]!.object!.userData.part as number;
    return this.looks?.geometry?.(part, n.kind, source);
  }

  /** The part a node is or is detail of (itself for assemblies). */
  partOf(id: number): number {
    let n = this.nodes[id]!;
    while (n.kind !== 'part' && n.kind !== 'assembly' && n.parent >= 0) n = this.nodes[n.parent]!;
    return n.id;
  }

  /** A detail node's path below its part (`faces/face#12`). */
  private relPath(id: number): string {
    const out: string[] = [];
    for (let n = this.nodes[id]!; n.kind !== 'part' && n.kind !== 'assembly'; n = this.nodes[n.parent]!) {
      this.segmentsOf(this.siblingsOf(n.id));
      out.push(this.segments.get(n.id)!);
    }
    return out.reverse().join('/');
  }

  /**
   * A part's detail is stale (its mesh or its model arrived): built again when next asked for, its look applied
   * again. The new detail nodes take the old ones' ids by path (the same face, edge or vertex), so a selection or a
   * row of the tree holding one still means it; the old ones left over are dead.
   */
  invalidate(object: THREE.Object3D): void {
    const id = this.byObject.get(object);
    if (id === undefined || this.nodes[id]!.kind !== 'part') return;
    const groups = this.nodes[id]!.children;
    if (groups) {
      const old = groups.flatMap((g) => [g, ...this.nodes[g]!.children ?? []]);
      const stale = this.stale.get(id) ?? new Map<number, string>();
      for (const k of old) stale.set(k, this.relPath(k));
      this.stale.set(id, stale);
      // (Dead until made again: found by nothing meanwhile.)
      for (const k of old) {
        const n = this.nodes[k]!;
        for (const m of n.members ?? []) this.byObject.delete(m);
        if (n.item && this.byObject.get(n.item.object) === k) this.byObject.delete(n.item.object);
        this.nodes[k] = { id: k, kind: n.kind, name: n.name, parent: n.parent, ...(n.face ? { face: n.face } : {}),
          dead: true };
        this.segments.delete(k);
      }
    }
    delete this.nodes[id]!.children;
    this.applyPart(id);
  }

  /** A part's detail nodes from before its mesh changed, by part: their ids and paths below it (detailOf). */
  private readonly stale = new Map<number, Map<number, string>>();

  private readonly segments = new Map<number, string>();

  /** A node's children, a part's detail built whether or not the tree shows it (for paths). */
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
      // (Detail nodes' are set as they're made: detailOf.)
      const base = escapeSegment(n.name);
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

  /**
   * The node a path names, if any (building parts' detail when the path goes below one; older paths' detail as
   * legacyDetail names it now).
   */
  find(path: string): number | undefined {
    const segs = path.split('/');
    let siblings: readonly number[] = this.roots;
    let found: number | undefined;
    for (let i = 0; i < segs.length; i++) {
      this.segmentsOf(siblings);
      if (found !== undefined && this.nodes[found]!.kind === 'part') {
        const now = legacyDetail(segs.slice(i).join('/'));
        if (now !== segs.slice(i).join('/')) segs.splice(i, segs.length - i, ...now.split('/'));
      }
      found = siblings.find((id) => this.segments.get(id) === segs[i]);
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
   * Whether a node is still loading: a part whose mesh is still to come (a load's or Mesh again's), or a node holding
   * one (its assemblies). A part's faces, edges and vertices aren't: a backend meshes the part whole.
   */
  loading(id: number): boolean {
    const l = this.loadingParts?.();
    if (!l?.parts.size) return false;
    if (this.loadingNodes?.version !== l.version) {
      const ids = new Set<number>();
      for (const n of this.nodes) {
        if (n.kind !== 'part' || n.object?.userData.cad !== 'part' || !l.parts.has(n.object.userData.part as number)) {
          continue;
        }
        for (let k = n.id; k >= 0 && !ids.has(k); k = this.nodes[k]!.parent) ids.add(k);
      }
      this.loadingNodes = { version: l.version, ids };
    }
    return this.loadingNodes.ids.has(id);
  }

  /**
   * Meshing failures: a face drawn as failed, or a part all of whose faces are, `failed`; a face short of its area
   * (cad-scene's faceFailures) or at a defect of its part's mesh (not a closed, oriented manifold: Mesh.defectFaces),
   * or a part some of whose faces failed in any way, `partly`.
   */
  failure(id: number): 'failed' | 'partly' | undefined {
    const n = this.nodes[id];
    if (!n) return undefined;
    if (n.face) return n.failure;
    // (A part's faces as the part.)
    if (n.kind === 'faces') return this.failure(n.parent);
    if (n.kind !== 'part' || n.object?.userData.cad !== 'part') return undefined;
    for (const m of n.object.children) {
      const failed = (m.userData.failedFaces as number[] | undefined)?.length ?? 0;
      const partly = (m.userData.partlyFailedFaces as number[] | undefined)?.length ?? 0;
      const defects = (m.userData.defectFaces as number[] | undefined)?.length ?? 0;
      if (failed && failed === (m.userData.faces as number[]).length) return 'failed';
      if (failed || partly || defects) return 'partly';
    }
    return undefined;
  }

  /**
   * The others of a selection (Hide others): the coarsest nodes that are none of these, none of their ancestors and
   * none of their descendants, the siblings of each and of each ancestor up to the roots; hiding them leaves the
   * selection and what holds it (a selected face's part keeps nothing else but its node).
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
    return this.nodes[this.partOf(id)]!.detailOverrides?.get(this.relPath(id));
  }

  /** What the node draws with: each slot its own, else its nearest ancestor's that sets it, else the file's. */
  look(id: number): Look {
    let hidden: boolean | undefined, alpha: number | undefined | null = null, edges: boolean | undefined;
    let reveal: boolean | undefined;
    for (let n = this.nodes[id]; n; n = this.nodes[n.parent]) {
      const o = this.ownOverride(n.id);
      hidden ??= o?.hidden;
      edges ??= o?.triangleEdges;
      reveal ??= o?.reveal;
      if (alpha === null) alpha = opacityOf(o);
    }
    return { hidden: hidden ?? false, ...(alpha === null || alpha === undefined ? {} : { alpha }),
      ...(edges === undefined ? {} : { triangleEdges: edges }), ...(reveal === undefined ? {} : { reveal }) };
  }

  /** Whether any node is revealed (`reveal: true`), so what isn't draws as a ghost. */
  get revealing(): boolean {
    return this.reveals;
  }

  /** Whether a node draws as a ghost: something is revealed, and it isn't (itself or through an ancestor). */
  ghost(id: number): boolean {
    return this.reveals && this.look(id).reveal !== true;
  }

  /** Every reveal override cleared (Hide others, Show others, Show all). */
  clearReveal(): void {
    if (!this.nodes.some((n) => n.override?.reveal !== undefined ||
      [...n.detailOverrides?.values() ?? []].some((o) => o.reveal !== undefined))) return;
    this.clearAll('reveal');
    this.applyAll();
  }

  /** Whether any node sets triangle edges (else Rendering's Triangle edges alone decides: triangle-edges.ts). */
  hasTriangleEdges(): boolean {
    return this.nodes.some((n) => n.override?.triangleEdges !== undefined ||
      [...n.detailOverrides?.values() ?? []].some((o) => o.triangleEdges !== undefined));
  }

  /** What a node inherits: its parent's look (the file's, at the top). */
  inherited(id: number): Look {
    const p = this.nodes[id]!.parent;
    return p >= 0 ? this.look(p) : { hidden: false };
  }

  /** Hidden itself or through an ancestor (its look). */
  hiddenInTree(id: number): boolean {
    return this.look(id).hidden;
  }

  /** A node's override, field by field (a field absent removes it; an override with none goes). */
  private put(id: number, o: AppearanceOverride): void {
    const n = this.nodes[id]!;
    const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as AppearanceOverride;
    // (An alpha only with transparent: true.)
    if (kept.transparent !== true) delete kept.alpha;
    const empty = !Object.keys(kept).length;
    if (n.kind === 'assembly' || n.kind === 'part') {
      if (empty) delete n.override;
      else n.override = kept;
      return;
    }
    const part = this.nodes[this.partOf(id)]!, rel = this.relPath(id);
    if (empty) part.detailOverrides?.delete(rel);
    else (part.detailOverrides ??= new Map()).set(rel, kept);
  }

  /** A slot cleared from every override (show all, a state's). */
  private clearAll(slot: Slot): void {
    for (const n of this.nodes) {
      if (n.override) this.put(n.id, without(n.override, slot));
      for (const [seg, o] of [...n.detailOverrides ?? []]) {
        const kept = without(o, slot);
        if (Object.keys(kept).length) n.detailOverrides!.set(seg, kept);
        else n.detailOverrides!.delete(seg);
      }
    }
  }

  /**
   * The fewest nodes covering these: none below another given, and wherever every child of a node is given (a part's:
   * its detail), the node instead, up the tree.
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
   * Hides or shows the nodes covering these (`cover`), the overrides below them left as they are. Where a node would
   * inherit the value anyway, its own is cleared rather than set, so the overrides stay the fewest that draw the same.
   */
  setHidden(ids: Iterable<number>, hidden: boolean): void {
    this.change(ids, 'hidden', (id) => this.inherited(id).hidden === hidden ? {} : { hidden });
  }

  /**
   * Makes the nodes covering these transparent at `alpha`, or with 'default' back to the file's opacity, likewise.
   */
  setOpacity(ids: Iterable<number>, alpha: number | 'default'): void {
    const want = alpha === 'default' ? undefined : alpha;
    this.change(ids, 'opacity', (id) => this.inherited(id).alpha === want ? {}
      : want === undefined ? { transparent: false } : { transparent: true, alpha: want });
  }

  private change(ids: Iterable<number>, slot: Slot, value: (id: number) => AppearanceOverride): void {
    const parts = new Set<number>();
    for (const id of this.cover(ids)) {
      this.put(id, { ...without(this.ownOverride(id), slot), ...value(id) });
      this.partsUnder(id, parts);
    }
    this.apply(parts);
  }

  /** These parts drawn again; every part, if whether anything is revealed changed (every ghost changes). */
  private apply(parts: Iterable<number>): void {
    const was = this.reveals;
    this.reveals = this.nodes.some((n) => n.override?.reveal === true ||
      [...n.detailOverrides?.values() ?? []].some((o) => o.reveal === true));
    if (was !== this.reveals) this.applyAll();
    else for (const p of parts) this.applyPart(p);
  }

  /** One node's override exactly (Override Appearance...: each field as given, absent ones inherited). */
  setOverride(id: number, o: AppearanceOverride): void {
    if (!this.nodes[id]) return;
    this.put(id, o);
    const parts = new Set<number>();
    this.partsUnder(id, parts);
    this.apply(parts);
  }

  /** The parts at or below a node, or a detail node's part. */
  private partsUnder(id: number, into: Set<number>): void {
    const n = this.nodes[id]!;
    if (n.kind === 'part') into.add(id);
    else if (n.kind === 'assembly') for (const c of n.children ?? []) this.partsUnder(c, into);
    else into.add(this.partOf(id));
  }

  /** Shows everything: every hidden slot cleared, the file's hidden placements' included. */
  showAll(): void {
    this.clearAll('hidden');
    this.applyAll();
  }

  /** Every override, by path, in node order (a part's detail after it, by its path below it). */
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
   * Exactly these overrides of these slots (a state's: the others cleared), each set as it is. A path below a part
   * names its detail by its form (DETAIL_PATH, older ones as legacyDetail reads them), so it can be set before the
   * part's mesh or model (and so its detail nodes) arrives. Returns the paths that name nothing.
   */
  setOverrides(list: readonly PathOverride[],
    slots: readonly Slot[] = ['hidden', 'opacity', 'triangleEdges', 'reveal']): string[] {
    for (const slot of slots) this.clearAll(slot);
    const missing: string[] = [];
    for (const { path, ...o } of list) {
      const wanted = Object.fromEntries(slots.flatMap((k) => FIELDS[k]).flatMap((k) => o[k] === undefined ? []
        : [[k, o[k]]])) as AppearanceOverride;
      if (!Object.keys(wanted).length) continue;
      const id = this.find(path);
      if (id !== undefined) {
        this.put(id, { ...this.ownOverride(id), ...wanted });
        continue;
      }
      // (The part: the path's longest beginning that names one.)
      const segs = path.split('/');
      let part: number | undefined, rel = '';
      for (let i = segs.length - 1; i > 0 && part === undefined; i--) {
        const p = this.find(segs.slice(0, i).join('/'));
        if (p !== undefined && this.nodes[p]!.kind === 'part') [part, rel] = [p, legacyDetail(segs.slice(i).join('/'))];
      }
      if (part !== undefined && DETAIL_PATH.test(rel)) {
        const map = (this.nodes[part]!.detailOverrides ??= new Map());
        const merged = { ...map.get(rel), ...wanted };
        if (merged.transparent !== true) delete merged.alpha;
        map.set(rel, merged);
      } else missing.push(path);
    }
    this.applyAll();
    return missing;
  }

  private applyAll(): void {
    this.reveals = this.nodes.some((n) => n.override?.reveal === true ||
      [...n.detailOverrides?.values() ?? []].some((o) => o.reveal === true));
    for (const n of this.nodes) if (n.kind === 'part') this.applyPart(n.id);
  }

  /**
   * A part's group's look, whether or not its node is made: its own override's slots, else the part's (what its
   * nodes inherit).
   */
  groupLook(part: number, g: Group): Look {
    const p = this.look(part), o = this.nodes[part]!.detailOverrides?.get(g);
    const own = opacityOf(o), alpha = own === null ? p.alpha : own, tri = o?.triangleEdges ?? p.triangleEdges;
    const reveal = o?.reveal ?? p.reveal;
    return { hidden: o?.hidden ?? p.hidden, ...(alpha === undefined ? {} : { alpha }),
      ...(tri === undefined ? {} : { triangleEdges: tri }), ...(reveal === undefined ? {} : { reveal }) };
  }

  /** A part's faces' own overrides, by source id, whether or not their nodes are made. */
  faceOverrides(part: number): Map<number, AppearanceOverride> {
    const out = new Map<number, AppearanceOverride>();
    for (const [rel, o] of this.nodes[part]!.detailOverrides ?? []) {
      const m = /^faces\/face#(\d+)$/.exec(rel);
      if (m) out.set(Number(m[1]), o);
    }
    return out;
  }

  /**
   * A placement drawn as its overrides resolve, its groups' between its own and their nodes': its faces' looks to
   * the scene graph, its line and point objects drawn without their hidden items (hidden whole when every one is),
   * its group hidden only when nothing below it is shown.
   */
  private applyPart(id: number): void {
    const n = this.nodes[id]!, group = n.object!;
    const over = (rel: string) => n.detailOverrides?.get(rel);
    const alpha = (a: number | undefined) => (a === undefined ? {} : { alpha: a });
    const fl = this.groupLook(id, 'faces');
    // (A ghost: something's revealed, and this isn't.)
    const ghost = (reveal: boolean | undefined) => this.reveals && reveal !== true;
    const ghosted = (g: boolean) => (g ? { ghost: true } : {});
    let shown = !fl.hidden;
    const faces = new Map<number, { hidden: boolean; alpha?: number; ghost?: boolean }>();
    const edges = new Map<number, boolean>();
    for (const [source, o] of this.faceOverrides(id)) {
      if (o.triangleEdges !== undefined) edges.set(source, o.triangleEdges);
      if (o.hidden === undefined && o.transparent === undefined && o.reveal === undefined) continue;
      const hidden = o.hidden ?? fl.hidden;
      const own = opacityOf(o);
      faces.set(source, { hidden, ...alpha(own === null ? fl.alpha : own), ...ghosted(ghost(o.reveal ?? fl.reveal)) });
      shown ||= !hidden;
    }
    const tri: TriangleEdgesLook = { ...(fl.triangleEdges === undefined ? {} : { whole: fl.triangleEdges }),
      ...(edges.size ? { faces: edges } : {}) };
    group.userData.triangleEdges = tri;
    const { groups, detected } = detailEntries(group);
    // The detected mesh edges: as their own override says, else as the part.
    const partLook = this.look(id), partHidden = partLook.hidden;
    for (const e of detected) {
      const m = e.item!.object;
      m.visible = !(over(e.rel)?.hidden ?? partHidden) && !ghost(over(e.rel)?.reveal ?? partLook.reveal);
      hideItems(m as THREE.Object3D & { geometry: THREE.BufferGeometry }, new Set());
      shown ||= m.visible;
    }
    for (const { group: g, members, entries } of groups) {
      if (g === 'faces') continue;
      const gl = this.groupLook(id, g), hidden = gl.hidden;
      const out = new Map<THREE.Object3D, Set<number>>(members.map((m) => [m, new Set()]));
      // (A ghost's lines aren't drawn: hidden as items, as the faces' alone show through.)
      for (const e of entries) {
        if ((over(e.rel)?.hidden ?? hidden) || ghost(over(e.rel)?.reveal ?? gl.reveal)) out.get(e.item!.object)!
          .add(e.item!.k);
      }
      for (const [m, set] of out) {
        m.visible = set.size < itemsOf(m).length;
        hideItems(m as THREE.Object3D & { geometry: THREE.BufferGeometry }, set);
        shown ||= m.visible;
      }
    }
    group.visible = shown;
    this.looks?.setLook(group, { hidden: fl.hidden, ...alpha(fl.alpha), ...ghosted(ghost(fl.reveal)),
      ...(faces.size ? { faces } : {}) });
  }
}
