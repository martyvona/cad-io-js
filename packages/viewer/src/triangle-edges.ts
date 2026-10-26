// Triangles' edges over the faces, for inspecting the tessellation (the user, 2026-10-26; Rendering's Triangle
// edges): off, for the selection only, or for everything. They live in a group of their own outside the model, so
// picking, the node model, statistics and section caps never see them: a mesh per drawn mesh of the model (or of the
// selection), sharing its geometry (and, for GPU instancing, its instance matrices), drawn by three.js as wireframe;
// a selected face's edges a geometry of its triangles alone, sharing the mesh's positions. Before each frame drawn
// they follow their meshes: placement, visibility (the mesh's and its ancestors', and its layers), and materials, so
// hidden faces (an invisible material's group) stay hidden. Made again when the model's meshes or the selection
// change; nothing is made while they're off.

import * as THREE from 'three';
import type { Piece } from './selection.ts';

export type TriangleEdgesMode = 'off' | 'selected' | 'all';

const WIRE = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, wireframe: true, transparent: true, opacity: 0.55 });
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

export class TriangleEdges {
  readonly group = new THREE.Group();
  private readonly pairs: { source: THREE.Mesh; wire: THREE.Mesh; own?: THREE.BufferGeometry }[] = [];
  /** What the mode 'selected' shows: meshes, each whole or some index ranges of it. */
  private selection = new Map<THREE.Object3D, Piece['ranges']>();
  private stale = true;
  /** The selection changed since the edges were made (only the mode 'selected' makes them again). */
  private selectionChanged = false;
  private builtFor: TriangleEdgesMode = 'off';

  constructor() {
    this.group.name = 'triangle edges';
  }

  /** The model's meshes changed (a new model, meshes arrived): made again at the next frame they're shown. */
  invalidate(): void {
    this.stale = true;
  }

  /** The selection's pieces (selection.ts), for the mode 'selected'. */
  select(pieces: readonly Piece[]): void {
    this.selection = new Map(pieces.map((p) => [p.object, p.ranges]));
    this.selectionChanged = true;
  }

  /** Before a frame: shown or not (`root` the model's top, its world matrices up to date), following the model. */
  update(root: THREE.Object3D | undefined, mode: TriangleEdgesMode): void {
    this.group.visible = mode !== 'off' && root !== undefined;
    if (!this.group.visible) return;
    if (this.stale || this.builtFor !== mode || (mode === 'selected' && this.selectionChanged)) {
      this.rebuild(root!, mode);
    }
    for (const { source, wire, own } of this.pairs) {
      wire.visible = shown(source, root!);
      if (!wire.visible) continue;
      wire.matrixWorld.copy(source.matrixWorld);
      wire.layers.mask = source.layers.mask;
      // A face's own triangles: drawn while the face is (its group's material visible); hidden faces aren't selected.
      if (!own) {
        wire.material = Array.isArray(source.material) ? source.material.map(wireFor) : wireFor(source.material);
      }
      if ((source as THREE.InstancedMesh).isInstancedMesh) (wire as THREE.InstancedMesh).count =
        (source as THREE.InstancedMesh).count;
    }
  }

  private rebuild(root: THREE.Object3D, mode: TriangleEdgesMode): void {
    this.stale = false;
    this.selectionChanged = false;
    this.builtFor = mode;
    for (const { wire, own } of this.pairs) {
      this.group.remove(wire);
      own?.dispose();
    }
    this.pairs.length = 0;
    root.traverse((o) => {
      const source = o as THREE.Mesh;
      // Faces only: not the selection's overlays.
      if (!source.isMesh || source.userData.highlight) return;
      if (mode === 'selected' && !this.selection.has(source)) return;
      const ranges = mode === 'selected' ? this.selection.get(source) : undefined;
      let own: THREE.BufferGeometry | undefined;
      if (ranges) {
        own = new THREE.BufferGeometry();
        own.setAttribute('position', source.geometry.getAttribute('position'));
        const index = source.geometry.index!;
        const sub: number[] = [];
        for (const r of ranges) for (let i = r.start; i < r.start + r.count; i++) sub.push(index.getX(i));
        own.setIndex(sub);
      }
      const instanced = source as THREE.InstancedMesh;
      let wire: THREE.Mesh;
      if (instanced.isInstancedMesh) {
        const w = new THREE.InstancedMesh(own ?? source.geometry, WIRE, instanced.count);
        w.instanceMatrix = instanced.instanceMatrix;
        wire = w;
      } else wire = new THREE.Mesh(own ?? source.geometry, WIRE);
      wire.matrixAutoUpdate = false;
      wire.matrixWorldAutoUpdate = false;
      wire.raycast = () => {};
      // Drawn after the faces, so they lie over them.
      wire.renderOrder = 1;
      this.group.add(wire);
      this.pairs.push({ source, wire, ...(own ? { own } : {}) });
    });
  }
}

/** A face material's wireframe: none where the faces aren't drawn (hidden faces). */
function wireFor(m: THREE.Material): THREE.Material {
  return m.visible ? WIRE : HIDDEN;
}

/** Drawn: it and every ancestor up to the model's top visible. */
function shown(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return true;
}
