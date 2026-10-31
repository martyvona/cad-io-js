// Fat edges (the user, 2026-10-27, from the cadrender prototype: Rendering's Edges, Thin or Fat, and Edge width):
// three.js's Wireframe, LineSegmentsGeometry and LineMaterial, lines a given number of pixels wide, where WebGL's own
// lines are one device pixel. They live in a group of their own outside the model, as triangle edges do: a Wireframe
// per edge object of the model (B-rep edges, or edges found from the triangles: LineSegments on the EDGES layer), its
// segments its source's, made once per geometry. Before each frame drawn they follow their sources: placement,
// visibility (with every ancestor's), and colour, a LineMaterial per source material (so a selection's tint shows);
// the lines' resolution Wireframe sets itself, from the renderer's viewport, before each render.
// The thin edges stay in the model, on their layer, for picking; the Viewer leaves that layer out of the frame while
// fat edges are drawn. Made again when the model's meshes change; nothing is made while they're thin.

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { Wireframe } from 'three/examples/jsm/lines/Wireframe.js';
import { keepBias } from './depth-bias.ts';

export type EdgeStyle = 'thin' | 'fat';

export class FatEdges {
  readonly group = new THREE.Group();
  private readonly pairs: { source: THREE.LineSegments; wire: Wireframe }[] = [];
  private readonly geometries = new WeakMap<THREE.BufferGeometry, LineSegmentsGeometry>();
  private readonly materials = new Map<THREE.Material, LineMaterial>();
  private stale = true;
  private width = 2;
  /** The layer the model's edges are on. */
  private readonly layer: number;

  constructor(layer: number) {
    this.layer = layer;
    this.group.name = 'fat edges';
  }

  /** The model's lines changed (a new model, meshes arrived): made again at the next frame they're shown. */
  invalidate(): void {
    this.stale = true;
  }

  /** Before a frame: shown or not (`root` the model's top, its world matrices up to date), `width` CSS pixels wide. */
  update(root: THREE.Object3D | undefined, on: boolean, width: number): void {
    this.group.visible = on && root !== undefined;
    if (!this.group.visible) return;
    if (this.stale) this.rebuild(root!);
    this.width = width;
    for (const { source, wire } of this.pairs) {
      wire.visible = shown(source, root!);
      if (!wire.visible) continue;
      wire.matrixWorld.copy(source.matrixWorld);
      wire.material = this.materialFor(source.material as THREE.Material);
    }
    for (const m of this.materials.values()) m.linewidth = this.width;
  }

  private rebuild(root: THREE.Object3D): void {
    this.stale = false;
    for (const { wire } of this.pairs) this.group.remove(wire);
    this.pairs.length = 0;
    root.traverse((o) => {
      const source = o as THREE.LineSegments;
      if (!source.isLineSegments || !source.layers.isEnabled(this.layer) || o.userData.highlight) return;
      const wire = new Wireframe(this.geometryFor(source.geometry), this.materialFor(source.material as
        THREE.Material));
      wire.matrixAutoUpdate = false;
      wire.matrixWorldAutoUpdate = false;
      wire.raycast = () => {};
      this.group.add(wire);
      this.pairs.push({ source, wire });
    });
  }

  /** A line geometry's segments as LineSegmentsGeometry wants them: each segment's two ends, not indexed. */
  private geometryFor(g: THREE.BufferGeometry): LineSegmentsGeometry {
    let fat = this.geometries.get(g);
    if (!fat) {
      const pos = g.getAttribute('position');
      const index = g.index;
      const n = index ? index.count : pos.count;
      const out = new Float32Array((n - (n % 2)) * 3);
      for (let i = 0; i < n - (n % 2); i++) {
        const v = index ? index.getX(i) : i;
        out[3 * i] = pos.getX(v);
        out[3 * i + 1] = pos.getY(v);
        out[3 * i + 2] = pos.getZ(v);
      }
      fat = new LineSegmentsGeometry().setPositions(out);
      this.geometries.set(g, fat);
    }
    return fat;
  }

  /** The fat material for a line material: its colour (in the same colour space) and opacity. */
  private materialFor(m: THREE.Material): LineMaterial {
    let fat = this.materials.get(m);
    if (!fat) {
      const line = m as THREE.LineBasicMaterial;
      fat = keepBias(m, new LineMaterial({ linewidth: this.width, transparent: m.transparent, opacity: m.opacity }));
      // Both in the working colour space.
      if (line.color) fat.color.copy(line.color);
      fat.visible = m.visible;
      this.materials.set(m, fat);
    }
    return fat;
  }
}

/** Drawn: it and every ancestor up to the model's top visible. */
function shown(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return true;
}
