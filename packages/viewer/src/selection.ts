// Selection: what selected nodes cover in the scene, and what's done with it (the user, 2026-10-24; CLAUDE.md, "The
// viewer"): highlighting, details (counts, triangle area, edge and curve length, the placement among the part's
// placements), the box for zoom selected, and the node a pick at a level stands for.
//
// A node covers pieces: drawables whole (an assembly's or part's, or one drawable's), or some of a mesh's triangles
// (a STEP face: its index ranges in the placement's mesh). Lengths are the world's millimetres.

import * as THREE from 'three';
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

/** The pieces nodes cover, once each: an object covered whole and in part counts whole. */
export function piecesOf(model: NodeModel, ids: Iterable<number>): Piece[] {
  const whole = new Set<Drawable>();
  const partial = new Map<Drawable, { start: number; count: number }[]>();
  for (const id of ids) {
    const n = model.nodes[id];
    if (!n) continue;
    if (n.face) {
      // A face that failed to mesh: its outline, whole (step.ts).
      model.nodes[n.parent]!.object!.traverse((o) => {
        if (o.userData.outlineFace === n.face!.source && isDrawable(o)) whole.add(o);
      });
      const mesh = placementMesh(model.nodes[n.parent]!.object!);
      const ranges = ((mesh?.userData.faceRanges ?? []) as FaceRange[]).filter((f) => f.source === n.face!.source);
      if (mesh && ranges.length) {
        const list = partial.get(mesh) ?? [];
        list.push(...ranges.map(({ start, count }) => ({ start, count })));
        partial.set(mesh, list);
      }
    } else if (n.self) {
      if (isDrawable(n.object!)) whole.add(n.object);
    } else n.object?.traverse((o) => { if (isDrawable(o) && !o.userData.highlight) whole.add(o); });
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

/** Counts and sums over pieces, in the world (instanced meshes count once, untransformed by their instances). */
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
      for (let i = 0; i + 1 < n; i += step) {
        m.length += world(a, i).distanceTo(world(b, i + 1));
        m.segments++;
      }
    } else m.points += n;
  }
  return m;
}

/** The world box of pieces: whole objects by their geometry's box, partial ones by their vertices. */
export function boxOf(pieces: readonly Piece[]): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const { object, ranges } of pieces) {
    object.updateWorldMatrix(true, false);
    if (!ranges) {
      const inst = object as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        inst.computeBoundingBox();
        box.union(inst.boundingBox!.clone().applyMatrix4(object.matrixWorld));
      } else {
        object.geometry.computeBoundingBox();
        box.union(object.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld));
      }
      continue;
    }
    const pos = object.geometry.getAttribute('position');
    const index = object.geometry.index!;
    for (const r of ranges) for (let i = r.start; i < r.start + r.count; i++) {
      box.expandByPoint(v.fromBufferAttribute(pos, index.getX(i)).applyMatrix4(object.matrixWorld));
    }
  }
  return box;
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
 * assembly, or the face, edges, curves, points or drawable picked (detail: the model must show detail).
 */
export function nodeForPick(model: NodeModel, object: THREE.Object3D, faceIndex: number | undefined,
  level: PickLevel): number | undefined {
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
  if (id !== part) return id;
  const children = model.children(part);
  // A failed face's outline (step.ts) picks its face.
  const outlined = object.userData.outlineFace as number | undefined;
  if (outlined !== undefined) return children.find((c) => model.nodes[c]!.face?.source === outlined) ?? part;
  const ranges = object.userData.faceRanges as FaceRange[] | undefined;
  if (ranges && faceIndex !== undefined) {
    const f = faceOfTriangle(ranges, faceIndex);
    const face = children.find((c) => model.nodes[c]!.face?.source === f?.source);
    if (face !== undefined) return face;
  }
  return children.find((c) => model.nodes[c]!.object === object) ?? part;
}

/** The placements of a part node's part: STEP parts by their scene part, others by their drawables' geometries. */
export function instancesOf(model: NodeModel, part: number): number[] {
  const key = (id: number) => {
    const o = model.nodes[id]!.object!;
    if (o.userData.cad === 'part') return `step:${o.userData.part}`;
    const geometries: string[] = [];
    o.traverse((d) => { if (isDrawable(d)) geometries.push(d.geometry.uuid); });
    return geometries.length ? geometries.join(',') : `node:${id}`;
  };
  const k = key(part);
  return model.nodes.filter((n) => n.kind === 'part' && key(n.id) === k).map((n) => n.id);
}

/**
 * Highlights pieces: whole objects by swapping in tinted copies of their materials (shared, cached per material),
 * partial meshes by an overlay of their selected triangles; `secondary` pieces (other instances) more lightly.
 */
export class Highlighter {
  private readonly swapped = new Map<Drawable, THREE.Material | THREE.Material[]>();
  private readonly overlays: THREE.Mesh[] = [];
  private readonly tints = [new Map<THREE.Material, THREE.Material>(), new Map<THREE.Material, THREE.Material>()];
  private readonly colors = [new THREE.Color(0xff9a2e), new THREE.Color(0x59c1ff)];
  private readonly overlayMaterials = this.colors.map((color) => new THREE.MeshBasicMaterial({ color,
    transparent: true, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));

  private tint(m: THREE.Material, which: number): THREE.Material {
    if (!m.visible) return m;
    let t = this.tints[which]!.get(m);
    if (!t) {
      t = m.clone();
      const color = this.colors[which]!;
      const e = t as THREE.MeshPhongMaterial;
      if (e.emissive) e.emissive.copy(color).multiplyScalar(0.55);
      else (t as THREE.LineBasicMaterial).color?.copy(color);
      this.tints[which]!.set(m, t);
    }
    return t;
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
          const overlay = new THREE.Mesh(g, this.overlayMaterials[which]);
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
        object.material = Array.isArray(object.material) ? object.material.map((m) => this.tint(m, which))
          : this.tint(object.material, which);
      }
    }
  }

  clear(): void {
    for (const [object, material] of this.swapped) object.material = material;
    this.swapped.clear();
    for (const o of this.overlays) {
      o.removeFromParent();
      o.geometry.dispose();
    }
    this.overlays.length = 0;
  }

  /** The material an object had before it was highlighted (for whoever needs the real one). */
  original(object: Drawable): THREE.Material | THREE.Material[] {
    return this.swapped.get(object) ?? object.material;
  }
}
