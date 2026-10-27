// Our loader's three.js graph (the user, 2026-10-24; CLAUDE.md, "The viewer"): the assembly tree from the scene at
// once, then each part's mesh attached to every placement of the part as tessellation delivers it, so the model
// appears part by part.
//
//   root -> a Group per component instance (its occurrence's transform) -> ... -> a Group per placed part (the part
//     reference's transform: the part's own unit to millimetres) -> a Mesh at the mesh's origin, with its B-rep
//     edges, wireframe curves and points as children (LineSegments, LineSegments, Points)
//
// A part's geometry is shared by its placements: one set of attributes, and one geometry (its groups) per distinct
// colouring of the faces. Edges are the B-rep's where the backend gave them (shared and free ones, as the exporters
// write them); a part with triangles and no B-rep edges gets edges found from its triangles instead.
//
// For the node model (model.ts): component groups have `userData.cad` 'assembly', placed parts' groups 'part', and
// each placement's Mesh its faces' source ids in `userData.faces` (and their index ranges in `faceRanges`, for
// picking and selection). Hiding a face (FaceHiding) hides its triangles in every placement of the part: they get
// a geometry group of their own with an invisible material.

import * as THREE from 'three';
import { instances, partInstances, type Mat4, type Mesh, type PartInstance, type Scene } from 'cad-scene';
import type { FaceHiding } from './model.ts';
import { EDGES } from './style.ts';

/** sRGB, as the exporters' default: faces, curves and points without a material. */
export const DEFAULT_COLOR: readonly [number, number, number] = [0.8, 0.8, 0.8];
/** The angle between faces (degrees) above which a part without B-rep edges gets an edge drawn. */
export const EDGE_ANGLE = 10;

const EDGE_KINDS = new Set(['shared', 'free']);

const matrix = (m: Mat4) => new THREE.Matrix4().fromArray(m);

function setMatrix(o: THREE.Object3D, m: Mat4): void {
  o.matrix.copy(matrix(m));
  o.matrix.decompose(o.position, o.quaternion, o.scale);
}

/** Segment pairs for polylines given as point ranges. */
export function polylineSegments(lines: readonly { start: number; count: number }[]): Uint32Array {
  let n = 0;
  for (const l of lines) n += Math.max(0, l.count - 1);
  const index = new Uint32Array(2 * n);
  let k = 0;
  for (const l of lines) for (let i = 0; i < l.count - 1; i++) {
    index[k++] = l.start + i;
    index[k++] = l.start + i + 1;
  }
  return index;
}

/** A placed part: its group in the tree, and its appearance as the scene resolves it. */
export interface Placement {
  group: THREE.Group;
  instance: PartInstance;
}

/** A meshed part: what assigning faces to geometry groups and materials needs again when faces are hidden. */
interface MeshedPart {
  mesh: Mesh;
  attrs: { position: THREE.BufferAttribute; normal?: THREE.BufferAttribute; index: THREE.BufferAttribute };
  /** Geometries by grouping (runs of faces and their materials). */
  geometries: Map<string, THREE.BufferGeometry>;
  objects: { obj: THREE.Mesh; instance: PartInstance }[];
}

/** Hidden faces' triangles: drawn with nothing. */
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

export class StepGraph implements FaceHiding {
  readonly root = new THREE.Group();
  readonly scene: Scene;
  /** Each part's placements, by part index. */
  readonly placements = new Map<number, Placement[]>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
  private readonly meshed = new Map<number, MeshedPart>();
  /** Hidden faces' source ids, by part. */
  private readonly hiddenFaces = new Map<number, Set<number>>();

  private readonly shininess: number;

  constructor(scene: Scene, name: string, shininess = 30) {
    this.scene = scene;
    this.shininess = shininess;
    this.root.name = name;
    const groups = new Map<string, THREE.Group>();
    for (const inst of instances(scene)) {
      const parent = inst.path.length === 1 ? undefined : groups.get(inst.path.slice(0, -1).join('/'));
      const occ = parent ? scene.components[parent.userData.component as number]!.children[inst.path.at(-1)!]!
        : scene.roots[inst.path[0]!]!;
      const g = new THREE.Group();
      g.name = occ.name ?? scene.components[inst.component]!.name;
      g.userData = { cad: 'assembly', component: inst.component, path: inst.path };
      setMatrix(g, occ.transform);
      (parent ?? this.root).add(g);
      groups.set(inst.path.join('/'), g);
    }
    for (const pi of partInstances(scene)) {
      const g = new THREE.Group();
      g.name = scene.parts[pi.part]!.name;
      g.userData = { cad: 'part', part: pi.part, path: pi.path };
      g.visible = pi.visible;
      setMatrix(g, pi.ref.transform);
      groups.get(pi.path.join('/'))!.add(g);
      let list = this.placements.get(pi.part);
      if (!list) this.placements.set(pi.part, (list = []));
      list.push({ group: g, instance: pi });
    }
  }

  /** The three.js material for a scene material (or the default) and a kind of object. */
  private material(index: number | undefined, kind: 'face' | 'curve' | 'point'): THREE.Material {
    const key = `${kind}:${index ?? 'default'}`;
    let m = this.materials.get(key);
    if (m) return m;
    const sm = index === undefined ? undefined : this.scene.materials[index];
    const [r, g, b] = sm?.color ?? DEFAULT_COLOR;
    const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    const opacity = sm?.opacity ?? 1;
    const common = { color, opacity, transparent: opacity < 1 };
    m = kind === 'face' ? new THREE.MeshPhongMaterial({ ...common, specular: 0x222222, shininess: this.shininess,
      // Faces a little behind their edges, so edges draw on top.
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
      : kind === 'curve' ? new THREE.LineBasicMaterial(common) : new THREE.PointsMaterial({ ...common, size: 4,
        sizeAttenuation: false });
    if (sm?.name) m.name = sm.name;
    this.materials.set(key, m);
    return m;
  }

  /**
   * Attaches a part's mesh to each of its placements; nothing for a part without one (it failed, or is empty).
   * Returns the objects made, one per placement.
   */
  addMesh(part: number, mesh: Mesh): THREE.Object3D[] {
    const placements = this.placements.get(part) ?? [];
    if (!placements.length) return [];
    const triangles = mesh.indices.length > 0;
    let attrs: { position: THREE.BufferAttribute; normal?: THREE.BufferAttribute; index: THREE.BufferAttribute }
      | undefined;
    const geometries = new Map<string, THREE.BufferGeometry>();
    let edges: THREE.BufferGeometry | undefined;
    if (triangles) {
      attrs = { position: new THREE.BufferAttribute(mesh.positions, 3), index: new THREE.BufferAttribute(mesh.indices,
        1) };
      if (mesh.normals) attrs.normal = new THREE.BufferAttribute(mesh.normals, 3);
      const kept = (mesh.edges ?? []).filter((e) => EDGE_KINDS.has(e.kind));
      if (mesh.edgePositions && kept.length) {
        edges = new THREE.BufferGeometry();
        edges.setAttribute('position', new THREE.BufferAttribute(mesh.edgePositions, 3));
        edges.setIndex(new THREE.BufferAttribute(polylineSegments(kept), 1));
      } else if (!mesh.edges?.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', attrs.position);
        g.setIndex(attrs.index);
        edges = new THREE.EdgesGeometry(g, EDGE_ANGLE);
      }
    }
    let curves: THREE.BufferGeometry | undefined;
    if (mesh.curvePositions && mesh.curves?.length) {
      curves = new THREE.BufferGeometry();
      curves.setAttribute('position', new THREE.BufferAttribute(mesh.curvePositions, 3));
      curves.setIndex(new THREE.BufferAttribute(polylineSegments(mesh.curves), 1));
    }
    let points: THREE.BufferGeometry | undefined;
    if (mesh.points?.length) {
      points = new THREE.BufferGeometry();
      points.setAttribute('position', new THREE.BufferAttribute(mesh.points, 3));
    }

    const meshed: MeshedPart | undefined = attrs ? { mesh, attrs, geometries, objects: [] } : undefined;
    if (meshed) this.meshed.set(part, meshed);
    const faceSources = [...new Set(mesh.faces.flatMap((f) => f.source === null ? [] : [f.source]))];
    const made: THREE.Object3D[] = [];
    for (const { group, instance } of placements) {
      let obj: THREE.Object3D;
      if (meshed) {
        const m = new THREE.Mesh();
        this.assign(part, meshed, m, instance);
        meshed.objects.push({ obj: m, instance });
        obj = m;
      } else {
        obj = new THREE.Group();
      }
      const closed = this.scene.parts[part]!.closed;
      obj.userData = { faces: faceSources, faceRanges: mesh.faces, ...(closed === undefined ? {} : { closed }) };
      obj.name = group.name;
      obj.position.set(...mesh.origin);
      if (edges) {
        const e = Object.assign(new THREE.LineSegments(edges, this.lineMaterial), { name: 'edges' });
        e.layers.set(EDGES);
        obj.add(e);
      }
      if (curves) obj.add(Object.assign(new THREE.LineSegments(curves, this.material(instance.material, 'curve')),
        { name: 'curves' }));
      if (points) obj.add(Object.assign(new THREE.Points(points, this.material(instance.material, 'point')),
        { name: 'points' }));
      group.add(obj);
      made.push(obj);
    }
    return made;
  }

  /** Sets a placement's geometry (shared by grouping) and materials: runs of faces by material, hidden faces apart. */
  private assign(part: number, meshed: MeshedPart, obj: THREE.Mesh, instance: PartInstance): void {
    const hidden = this.hiddenFaces.get(part);
    const runs: { start: number; count: number; material: number | undefined | 'hidden' }[] = [];
    for (const f of meshed.mesh.faces) {
      const m = f.source !== null && hidden?.has(f.source) ? 'hidden' as const
        : (f.source !== null ? instance.faceMaterials.get(f.source) : undefined) ?? instance.material;
      const last = runs.at(-1);
      if (last && last.material === m && last.start + last.count === f.start) last.count += f.count;
      else runs.push({ start: f.start, count: f.count, material: m });
    }
    const key = runs.map((r) => `${r.start}:${r.material}`).join(',');
    let g = meshed.geometries.get(key);
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', meshed.attrs.position);
      if (meshed.attrs.normal) g.setAttribute('normal', meshed.attrs.normal);
      g.setIndex(meshed.attrs.index);
      runs.forEach((r, i) => g!.addGroup(r.start, r.count, i));
      meshed.geometries.set(key, g);
    }
    obj.geometry = g;
    obj.material = runs.map((r) => r.material === 'hidden' ? HIDDEN : this.material(r.material, 'face'));
  }

  isFaceHidden(part: number, source: number): boolean {
    return this.hiddenFaces.get(part)?.has(source) ?? false;
  }

  setFaceHidden(part: number, source: number, hidden: boolean): void {
    let set = this.hiddenFaces.get(part);
    if (!set) this.hiddenFaces.set(part, (set = new Set()));
    if (hidden) set.add(source);
    else set.delete(source);
    const meshed = this.meshed.get(part);
    if (meshed) for (const { obj, instance } of meshed.objects) this.assign(part, meshed, obj, instance);
  }

  showAllFaces(): void {
    const parts = [...this.hiddenFaces.keys()];
    this.hiddenFaces.clear();
    for (const part of parts) {
      const meshed = this.meshed.get(part);
      if (meshed) for (const { obj, instance } of meshed.objects) this.assign(part, meshed, obj, instance);
    }
  }
}

/**
 * Edges found from the triangles, for meshes loaded by three.js's loaders that have no lines of their own beside
 * them (our exports with B-rep edges put them in children); instanced meshes are left alone (a child would be drawn
 * once, not per instance).
 */
export function detectEdges(root: THREE.Object3D): number {
  const material = new THREE.LineBasicMaterial({ color: 0x000000 });
  const isLine = (o: THREE.Object3D) => (o as THREE.Line).isLine === true;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
    if (m.children.some(isLine) || m.parent?.children.some(isLine)) return;
    meshes.push(m);
  });
  for (const m of meshes) {
    const e = Object.assign(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, EDGE_ANGLE), material),
      { name: 'edges' });
    e.layers.set(EDGES);
    m.add(e);
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) Object.assign(mat,
      { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  }
  return meshes.length;
}
