// Selection: what selected nodes cover in the scene, and what's done with it (docs/viewer.md): highlighting,
// details (counts, triangle area, edge and curve length, the placement among the part's placements), the box for zoom
// selected, and the node a pick at a level stands for.
//
// A node covers pieces: drawables whole (an assembly's or part's, or one drawable's), or some of a mesh's triangles
// (a STEP face: its index ranges in the placement's mesh). Lengths are the world's millimetres.

import * as THREE from 'three';
import { boxesSphere, type Box } from 'cad-scene';
import { biasTowardCamera, keepBias } from './depth-bias.ts';
import { itemsOf, rangeOf } from './items.ts';
import type { NodeModel } from './model.ts';

export type PickLevel = 'assembly' | 'part' | 'detail';

type Drawable = THREE.Mesh | THREE.Line | THREE.Points;

export interface Piece {
  object: Drawable;
  /** Index ranges (in indices, not triangles) of a mesh's; undefined: all of it. */
  ranges?: { start: number; count: number }[];
}

export interface FaceRange { source: number | null; start: number; count: number }

const isDrawable = (o: THREE.Object3D): o is Drawable => (o as THREE.Mesh).isMesh === true ||
  (o as THREE.Line).isLine === true || (o as THREE.Points).isPoints === true;

/** The STEP placement's mesh under a part node's group (the Mesh child with face ranges). */
function placementMesh(group: THREE.Object3D): THREE.Mesh | undefined {
  return group.children.find((c) => (c as THREE.Mesh).isMesh && c.userData.faceRanges) as THREE.Mesh | undefined;
}

/**
 * The pieces nodes cover, once each: an object covered whole and in part counts whole. A face is its ranges of its
 * placement's mesh (and its outline, if it failed); an edge, curve, vertex or point its range of its line or point
 * object as drawn now (none while hidden: items.ts); the faces group its placement's mesh and outlines, the edges and
 * vertices groups their objects.
 */
export function piecesOf(model: NodeModel, ids: Iterable<number>): Piece[] {
  const whole = new Set<Drawable>();
  const partial = new Map<Drawable, { start: number; count: number }[]>();
  const some = (o: Drawable, ranges: readonly { start: number; count: number }[]) => {
    if (!ranges.length) return;
    const list = partial.get(o) ?? [];
    list.push(...ranges.map(({ start, count }) => ({ start, count })));
    partial.set(o, list);
  };
  for (const id of ids) {
    const n = model.nodes[id];
    if (!n || n.dead) continue;
    const part = model.nodes[model.partOf(id)]!.object!;
    if (n.face) {
      // A face that failed to mesh: its outline, whole (scene-graph.ts).
      part.traverse((o) => { if (o.userData.outlineFace === n.face!.source && isDrawable(o)) whole.add(o); });
      const mesh = placementMesh(part);
      const ranges = (mesh?.userData.faceRanges ?? []) as FaceRange[];
      if (mesh) some(mesh, ranges.filter((f) => f.source === n.face!.source));
    } else if (n.item) {
      const r = rangeOf(n.item.object, n.item.k);
      if (r) some(n.item.object as Drawable, [r]);
    } else if (n.kind === 'faces') {
      part.traverse((o) => {
        const face = (o as THREE.Mesh).isMesh || o.userData.outlineFace !== undefined;
        if (isDrawable(o) && face && !o.userData.highlight) whole.add(o);
      });
    } else if (n.members) for (const m of n.members) whole.add(m as Drawable);
    else n.object?.traverse((o) => { if (isDrawable(o) && !o.userData.highlight) whole.add(o); });
  }
  const out: Piece[] = [...whole].map((object) => ({ object }));
  for (const [object, ranges] of partial) if (!whole.has(object)) out.push({ object, ranges });
  return out;
}

export interface Measures {
  meshes: number;
  triangles: number;
  /** The triangles' total area, mm^2. */
  area: number;
  lines: number;
  segments: number;
  /** The segments' total length, mm. */
  length: number;
  points: number;
}

/** Counts and sums over pieces, in the world. */
export function measure(pieces: readonly Piece[]): Measures {
  const m: Measures = { meshes: 0, triangles: 0, area: 0, lines: 0, segments: 0, length: 0, points: 0 };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const { object, ranges } of pieces) {
    object.updateWorldMatrix(true, false);
    const pos = object.geometry.getAttribute('position');
    if (!pos) continue;
    const index = object.geometry.index;
    const at = (i: number) => (index ? index.getX(i) : i);
    const world = (v: THREE.Vector3, i: number) => v.fromBufferAttribute(pos, at(i)).applyMatrix4(object.matrixWorld);
    const n = index ? index.count : pos.count;
    if ((object as THREE.Mesh).isMesh) {
      m.meshes++;
      for (const r of ranges ?? [{ start: 0, count: n }]) {
        for (let i = r.start; i + 2 < r.start + r.count; i += 3) {
          world(a, i); world(b, i + 1); world(c, i + 2);
          m.area += b.sub(a).cross(c.sub(a)).length() / 2;
          m.triangles++;
        }
      }
    } else if ((object as THREE.Line).isLine) {
      m.lines++;
      const step = (object as THREE.LineSegments).isLineSegments ? 2 : 1;
      for (const r of ranges ?? [{ start: 0, count: n }]) {
        for (let i = r.start; i + 1 < r.start + r.count; i += step) {
          m.length += world(a, i).distanceTo(world(b, i + 1));
          m.segments++;
        }
      }
    } else m.points += ranges ? ranges.reduce((t, r) => t + r.count, 0) : n;
  }
  return m;
}

/**
 * The world sphere of pieces (zoom selected: spheres, as zoom all): each one's box (a whole object's geometry's, a
 * partial one's vertices'), placed in the world by its corners, as the model's sphere is made (cad-scene's
 * boxesSphere). Empty for nothing.
 */
export function sphereOf(pieces: readonly Piece[]): THREE.Sphere {
  const boxes: { box: Box; matrix: ArrayLike<number> }[] = [];
  const v = new THREE.Vector3();
  for (const { object, ranges } of pieces) {
    object.updateWorldMatrix(true, false);
    const box = new THREE.Box3();
    if (!ranges) {
      object.geometry.computeBoundingBox();
      box.copy(object.geometry.boundingBox!);
    } else {
      const pos = object.geometry.getAttribute('position');
      const index = object.geometry.index!;
      for (const r of ranges) for (let i = r.start; i < r.start + r.count; i++) {
        box.expandByPoint(v.fromBufferAttribute(pos, index.getX(i)));
      }
    }
    if (!box.isEmpty()) boxes.push({ box: { min: box.min.toArray(), max: box.max.toArray() },
      matrix: object.matrixWorld.elements });
  }
  const s = boxesSphere(boxes);
  return s ? new THREE.Sphere(new THREE.Vector3(...s.center), s.radius) : new THREE.Sphere().makeEmpty();
}

/** The face (its range in `faceRanges`) a triangle of a STEP placement mesh belongs to: ranges are in order. */
export function faceOfTriangle(ranges: readonly FaceRange[], triangle: number): FaceRange | undefined {
  const i = triangle * 3;
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (i < r.start) hi = mid - 1;
    else if (i >= r.start + r.count) lo = mid + 1;
    else return r;
  }
  return undefined;
}

/**
 * The node a pick stands for at a level: the part (or the nearest node above, if the object isn't in a part), its
 * assembly, or the face, edge, curve, vertex or point picked (`item`: its place in the line or point object's items;
 * without one, the object's group) (detail: the model must show detail).
 */
export function nodeForPick(model: NodeModel, object: THREE.Object3D, faceIndex: number | undefined,
  level: PickLevel, item?: number): number | undefined {
  const id = model.nodeOf(object);
  if (id === undefined) return undefined;
  let part: number | undefined = id;
  while (part !== undefined && part >= 0 && model.nodes[part]!.kind !== 'part') part = model.nodes[part]!.parent;
  if (part === undefined || part < 0) return id;
  if (level === 'assembly') {
    const up = model.nodes[part]!.parent;
    return up >= 0 ? up : part;
  }
  if (level === 'part') return part;
  // (Its detail made first, if it isn't yet: a line or point object then finds its group.)
  const groups = model.children(part);
  const own = model.nodeOf(object);
  if (own !== undefined && own !== part) {
    const one = item === undefined ? undefined : model.children(own).find((c) => {
      const i = model.nodes[c]!.item;
      return i?.object === object && i.k === item;
    });
    return one ?? own;
  }
  const group = groups.find((c) => model.nodes[c]!.kind === 'faces');
  const faces = group === undefined ? [] : model.children(group);
  // A failed face's outline (scene-graph.ts) picks its face.
  const outlined = object.userData.outlineFace as number | undefined;
  if (outlined !== undefined) return faces.find((c) => model.nodes[c]!.face?.source === outlined) ?? part;
  const ranges = object.userData.faceRanges as FaceRange[] | undefined;
  if (ranges && faceIndex !== undefined) {
    const f = faceOfTriangle(ranges, faceIndex);
    const face = faces.find((c) => model.nodes[c]!.face?.source === f?.source);
    if (face !== undefined) return face;
  }
  return part;
}

/**
 * The nodes a ray's picks (nearest first: pick.ts's hitsAlong and pickOfHit) stand for at a level, each once, at its
 * nearest; picks of nothing in the model skipped.
 */
export function nodesAlong(model: NodeModel, picks: readonly { object: THREE.Object3D; faceIndex?: number;
  item?: number }[], level: PickLevel): number[] {
  const seen = new Set<number>();
  for (const p of picks) {
    const id = nodeForPick(model, p.object, p.faceIndex, level, p.item);
    if (id !== undefined) seen.add(id);
  }
  return [...seen];
}

/**
 * What the pointer being over a pick highlights at a level (outline.ts): at the part or assembly level, the node's
 * pieces outlined; at the detail level, a face's ranges (every range of its source) outlined, an edge's, curve's,
 * vertex's or point's range marked, a failed face's outline marked; a cap, its part outlined. Detail needs no nodes
 * (the tree's detail may be off).
 */
export function highlightForPick(model: NodeModel, hit: { object: THREE.Object3D; faceIndex?: number; item?: number },
  level: PickLevel): { outline: Piece[]; marks: Piece[] } {
  const none = { outline: [], marks: [] };
  const o = hit.object as Drawable;
  if (level === 'detail') {
    if (hit.item !== undefined) {
      const r = rangeOf(o, hit.item);
      return { outline: [], marks: r ? [{ object: o, ranges: [r] }] : [] };
    }
    if (o.userData.outlineFace !== undefined) return { outline: [], marks: [{ object: o }] };
    const ranges = o.userData.faceRanges as FaceRange[] | undefined;
    const f = ranges?.length && hit.faceIndex !== undefined ? faceOfTriangle(ranges, hit.faceIndex) : undefined;
    if (f) {
      const same = f.source === null ? [f] : ranges!.filter((r) => r.source === f.source);
      return { outline: [{ object: o, ranges: same.map(({ start, count }) => ({ start, count })) }], marks: [] };
    }
  }
  // (A cap, a pick without a face index: the part.)
  const id = nodeForPick(model, hit.object, hit.faceIndex, level);
  return id === undefined ? none : { outline: piecesOf(model, [id]), marks: [] };
}

/**
 * A tree node's highlight, as hovering in the 3D view at its level would give it: faces, parts, assemblies and the
 * faces group a silhouette of their pieces (a failed face's outline marked); edges, curves, vertices and points, and
 * their groups, marks.
 */
export function highlightForNode(model: NodeModel, id: number): { outline: Piece[]; marks: Piece[] } {
  const n = model.nodes[id];
  if (!n || n.dead) return { outline: [], marks: [] };
  const pieces = piecesOf(model, [id]);
  if (n.item || n.kind === 'edges' || n.kind === 'vertices') return { outline: [], marks: pieces };
  if (!n.face) return { outline: pieces, marks: [] };
  const failed = (p: Piece) => p.object.userData.outlineFace !== undefined;
  return { outline: pieces.filter((p) => !failed(p)), marks: pieces.filter(failed) };
}

/**
 * What an alert on a node draws (alerts.ts): its lines and dots, never its faces. An edge, curve, vertex or point
 * itself; a face its edges (by its part's B-rep, `edgesOf` giving a face's edge ids where the page holds it) and its
 * outline if it failed; a part, an assembly or a faces group their edges, curves, failed faces' outlines and loose
 * points; an edges or vertices group its members. Nothing hidden (items.ts) or dead.
 */
export function alertForNode(model: NodeModel, id: number, edgesOf?: (part: number, face: number) => number[]):
  Piece[] {
  const n = model.nodes[id];
  if (!n || n.dead) return [];
  // (Vertices' dots: their DiscMaterial's mark.)
  const lineOrLoose = (p: Piece) => !(p.object as THREE.Mesh).isMesh &&
    ![p.object.material].flat()[0]?.userData.dots;
  if (n.item || n.kind === 'edges' || n.kind === 'vertices') return piecesOf(model, [id]);
  if (!n.face && n.kind !== 'faces') return piecesOf(model, [id]).filter(lineOrLoose);
  const group = model.nodes[model.partOf(id)]!.object!;
  const placed = group.children.find((c) => c.userData.faceRanges !== undefined);
  const lines = placed?.children.find((c) => c.name === 'edges') as THREE.LineSegments | undefined;
  if (n.kind === 'faces') {
    const outlines = piecesOf(model, [id]).filter((p) => !(p.object as THREE.Mesh).isMesh);
    return [...lines ? [{ object: lines }] : [], ...outlines];
  }
  const own = piecesOf(model, [id]).filter((p) => !(p.object as THREE.Mesh).isMesh);
  const edges = new Set(edgesOf?.(group.userData.part as number, n.face!.source) ?? []);
  const ranges = !lines ? [] : itemsOf(lines).flatMap((item, k) => {
    const r = item.source !== null && edges.has(item.source) ? rangeOf(lines, k) : undefined;
    return r ? [r] : [];
  });
  return ranges.length ? [...own, { object: lines!, ranges }] : own;
}

/** The placements of a part node's part: the part nodes of the same scene part. */
export function instancesOf(model: NodeModel, part: number): number[] {
  const key = (id: number) => model.nodes[id]!.object!.userData.part as number;
  const k = key(part);
  return model.nodes.filter((n) => n.kind === 'part' && key(n.id) === k).map((n) => n.id);
}

/**
 * Highlights pieces: whole objects by swapping in tinted copies of their materials (shared, cached per material),
 * parts of objects by an overlay of their selected ranges: a mesh's triangles in a translucent tint; lines in the
 * tint, drawn toward the camera over the lines they cover and on their layers (so fat edges draw them fat too:
 * `fatHighlight`); points (vertices' dots: vertex-points.ts) in a tinted copy of their material on the default layer,
 * so a selected vertex shows whether Vertices is on or not. `secondary` pieces (other instances) more lightly.
 * `changed` after each change of the overlays (fat edges make theirs again).
 */
export class Highlighter {
  private readonly changed: () => void;
  constructor(changed: () => void = () => {}) {
    this.changed = changed;
  }

  private readonly swapped = new Map<Drawable, THREE.Material | THREE.Material[]>();
  /** Which tint each swapped object has (0 the selection's, 1 other instances'). */
  private readonly which = new Map<Drawable, number>();
  private readonly overlays: (THREE.Mesh | THREE.LineSegments | THREE.Points)[] = [];
  private readonly tints = [new Map<THREE.Material, THREE.Material>(), new Map<THREE.Material, THREE.Material>()];
  private readonly colors = [new THREE.Color(0xff9a2e), new THREE.Color(0x59c1ff)];
  // A tint over the face, writing no depth: pulled toward the camera, it would otherwise hide what's drawn after it at
  // the face's own depth (triangle-edges.ts's wireframes).
  private readonly overlayMaterials = this.colors.map((color) => new THREE.MeshBasicMaterial({ color,
    transparent: true, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    depthWrite: false }));
  private readonly lineOverlays = this.colors.map((color) => biasTowardCamera(new THREE.LineBasicMaterial({ color })));

  private tint(m: THREE.Material, which: number): THREE.Material {
    if (!m.visible) return m;
    let t = this.tints[which]!.get(m);
    if (!t) {
      t = keepBias(m, m.clone());
      this.colour(t, this.colors[which]!);
      this.tints[which]!.set(m, t);
    }
    return t;
  }

  private colour(t: THREE.Material, color: THREE.Color): void {
    const e = t as THREE.MeshPhongMaterial;
    if (e.emissive) e.emissive.copy(color).multiplyScalar(0.55);
    else (t as THREE.LineBasicMaterial).color?.copy(color);
  }

  /** The selection's colour (sRGB; other instances' stays), its tints and overlays made already too. */
  setColor(hex: number): void {
    const c = this.colors[0]!.setHex(hex);
    this.overlayMaterials[0]!.color.copy(c);
    this.lineOverlays[0]!.color.copy(c);
    for (const t of this.tints[0]!.values()) this.colour(t, c);
    this.changed();
  }

  /** Highlights these pieces (and those others, lightly), undoing the last highlight first. */
  apply(pieces: readonly Piece[], secondary: readonly Piece[] = []): void {
    this.clear();
    const lit = new Set(pieces.filter((p) => !p.ranges).map((p) => p.object));
    for (const [list, which] of [[pieces, 0], [secondary.filter((p) => !lit.has(p.object)), 1]] as const) {
      for (const { object, ranges } of list) {
        if (ranges) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', object.geometry.getAttribute('position'));
          const index = object.geometry.index!;
          const sub: number[] = [];
          for (const r of ranges) for (let i = r.start; i < r.start + r.count; i++) sub.push(index.getX(i));
          g.setIndex(sub);
          let overlay: THREE.Mesh | THREE.LineSegments | THREE.Points;
          if ((object as THREE.Mesh).isMesh) overlay = new THREE.Mesh(g, this.overlayMaterials[which]);
          else if ((object as THREE.Line).isLine) {
            overlay = new THREE.LineSegments(g, this.lineOverlays[which]);
            overlay.layers.mask = object.layers.mask;
            overlay.userData.fatHighlight = true;
          } else overlay = new THREE.Points(g, this.tint(object.material as THREE.Material, which));
          overlay.name = 'highlight';
          // Not part of the model: not a node, not pickable, not counted.
          overlay.userData.highlight = true;
          overlay.raycast = () => {};
          object.add(overlay);
          this.overlays.push(overlay);
          continue;
        }
        if (this.swapped.has(object)) continue;
        this.swapped.set(object, object.material);
        this.which.set(object, which);
        object.material = Array.isArray(object.material) ? object.material.map((m) => this.tint(m, which))
          : this.tint(object.material, which);
      }
    }
    this.changed();
  }

  /** The tint's colour an object is drawn with whole, if any (a section cap's part's: section.ts). */
  tintOf(object: THREE.Object3D): THREE.Color | undefined {
    const which = this.which.get(object as Drawable);
    return which === undefined ? undefined : this.colors[which];
  }

  clear(): void {
    for (const [object, material] of this.swapped) object.material = material;
    this.swapped.clear();
    this.which.clear();
    for (const o of this.overlays) {
      o.removeFromParent();
      o.geometry.dispose();
    }
    const had = this.overlays.length > 0;
    this.overlays.length = 0;
    if (had) this.changed();
  }

  /** The material an object had before it was highlighted (for whoever needs the real one). */
  original(object: Drawable): THREE.Material | THREE.Material[] {
    return this.swapped.get(object) ?? object.material;
  }
}
