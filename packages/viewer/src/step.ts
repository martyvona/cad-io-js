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

import * as THREE from 'three';
import { instances, partInstances, type Mat4, type Mesh, type PartInstance, type Scene } from 'cad-scene';

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

export class StepGraph {
  readonly root = new THREE.Group();
  readonly scene: Scene;
  /** Each part's placements, by part index. */
  readonly placements = new Map<number, Placement[]>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });

  constructor(scene: Scene, name: string) {
    this.scene = scene;
    this.root.name = name;
    const groups = new Map<string, THREE.Group>();
    for (const inst of instances(scene)) {
      const parent = inst.path.length === 1 ? undefined : groups.get(inst.path.slice(0, -1).join('/'));
      const occ = parent ? scene.components[parent.userData.component as number]!.children[inst.path.at(-1)!]!
        : scene.roots[inst.path[0]!]!;
      const g = new THREE.Group();
      g.name = occ.name ?? scene.components[inst.component]!.name;
      g.userData = { component: inst.component, path: inst.path };
      setMatrix(g, occ.transform);
      (parent ?? this.root).add(g);
      groups.set(inst.path.join('/'), g);
    }
    for (const pi of partInstances(scene)) {
      const g = new THREE.Group();
      g.name = scene.parts[pi.part]!.name;
      g.userData = { part: pi.part, path: pi.path };
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
    m = kind === 'face' ? new THREE.MeshPhongMaterial({ ...common, specular: 0x222222, shininess: 30,
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

    const made: THREE.Object3D[] = [];
    for (const { group, instance } of placements) {
      let obj: THREE.Object3D;
      if (attrs) {
        // The faces' materials in order, as runs: one geometry group per run.
        const runs: { start: number; count: number; material: number | undefined }[] = [];
        for (const f of mesh.faces) {
          const m = (f.source !== null ? instance.faceMaterials.get(f.source) : undefined) ?? instance.material;
          const last = runs.at(-1);
          if (last && last.material === m && last.start + last.count === f.start) last.count += f.count;
          else runs.push({ start: f.start, count: f.count, material: m });
        }
        const key = runs.map((r) => `${r.start}:${r.material}`).join(',');
        let g = geometries.get(key);
        if (!g) {
          g = new THREE.BufferGeometry();
          g.setAttribute('position', attrs.position);
          if (attrs.normal) g.setAttribute('normal', attrs.normal);
          g.setIndex(attrs.index);
          runs.forEach((r, i) => g!.addGroup(r.start, r.count, i));
          geometries.set(key, g);
        }
        obj = new THREE.Mesh(g, runs.map((r) => this.material(r.material, 'face')));
      } else {
        obj = new THREE.Group();
      }
      obj.name = group.name;
      obj.position.set(...mesh.origin);
      if (edges) obj.add(Object.assign(new THREE.LineSegments(edges, this.lineMaterial), { name: 'edges' }));
      if (curves) obj.add(Object.assign(new THREE.LineSegments(curves, this.material(instance.material, 'curve')),
        { name: 'curves' }));
      if (points) obj.add(Object.assign(new THREE.Points(points, this.material(instance.material, 'point')),
        { name: 'points' }));
      group.add(obj);
      made.push(obj);
    }
    return made;
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
    m.add(Object.assign(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, EDGE_ANGLE), material),
      { name: 'edges' }));
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) Object.assign(mat,
      { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  }
  return meshes.length;
}
