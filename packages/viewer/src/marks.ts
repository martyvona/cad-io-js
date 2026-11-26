// Lines and dots drawn over the model in a colour of their own (marks): copies of pieces of the model's line and point
// objects (selection.ts's Piece), lines fat (LineMaterial, `width` CSS pixels), dots as the vertices' (DiscMaterial,
// `grow` CSS pixels larger in radius), in a group apart from the model that follows their sources (placement,
// visibility) before each frame. A highlight's marks (outline.ts) and the alerts (alerts.ts).

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { Wireframe } from 'three/examples/jsm/lines/Wireframe.js';
import { biasTowardCamera } from './depth-bias.ts';
import type { Piece } from './selection.ts';
import { DiscMaterial } from './vertex-points.ts';

export type Drawable = THREE.Mesh | THREE.LineSegments | THREE.Points;

/** Drawn: it and every ancestor visible, up to the scene. */
export function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** A geometry of some of an object's index (the same attributes), kept per geometry and ranges. */
const subGeometries = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();
export function subGeometry(g: THREE.BufferGeometry, ranges: readonly { start: number; count: number }[]):
  THREE.BufferGeometry {
  const key = ranges.map((r) => `${r.start}+${r.count}`).join(',');
  let byKey = subGeometries.get(g);
  if (!byKey) subGeometries.set(g, (byKey = new Map()));
  let sub = byKey.get(key);
  if (!sub) {
    sub = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(g.attributes)) sub.setAttribute(name, a);
    const index = g.index!;
    const out: number[] = [];
    for (const r of ranges) for (let i = r.start; i < r.start + r.count; i++) out.push(index.getX(i));
    sub.setIndex(out);
    byKey.set(key, sub);
  }
  return sub;
}

/** A line geometry's segments as LineSegmentsGeometry wants them: each segment's two ends, not indexed. */
function segmentsOf(g: THREE.BufferGeometry): LineSegmentsGeometry {
  const pos = g.getAttribute('position');
  const index = g.index;
  const n = index ? index.count : pos.count;
  const m = n - (n % 2);
  const out = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) {
    const v = index ? index.getX(i) : i;
    out[3 * i] = pos.getX(v);
    out[3 * i + 1] = pos.getY(v);
    out[3 * i + 2] = pos.getZ(v);
  }
  return new LineSegmentsGeometry().setPositions(out);
}

export class Marks {
  readonly group = new THREE.Group();
  readonly line: LineMaterial;
  readonly dots = new DiscMaterial();
  private readonly lineGeometries = new WeakMap<THREE.BufferGeometry, LineSegmentsGeometry>();
  private marks: { source: Drawable; mark: THREE.Object3D }[] = [];

  /**
   * `onTop`: drawn over everything, after the model (neither depth test nor write); else tested against the model's
   * depth, the lines biased toward the camera as edges are (depth-bias.ts).
   */
  constructor(name: string, opts: { grow: number; onTop?: boolean }) {
    this.group.name = name;
    this.line = new LineMaterial({ linewidth: 3 });
    if (opts.onTop) {
      for (const m of [this.line, this.dots]) {
        m.depthTest = false;
        m.depthWrite = false;
      }
    } else {
      biasTowardCamera(this.line);
    }
    this.dots.uniforms.grow!.value = opts.grow;
  }

  /** Their colour (sRGB). */
  setColor(hex: number): void {
    this.line.color.setHex(hex);
    this.dots.color.setHex(hex);
  }

  /** The lines' width, CSS pixels. */
  setWidth(width: number): void {
    this.line.linewidth = width;
  }

  /** How many are drawn (sources gone or hidden counted too). */
  get count(): number {
    return this.marks.length;
  }

  /** Marks these pieces' lines and dots (in place of the last); their meshes aren't marked. */
  set(pieces: readonly Piece[]): void {
    for (const { mark } of this.marks) {
      mark.removeFromParent();
      if (mark instanceof THREE.Points) mark.geometry.dispose();
    }
    this.marks = [];
    for (const { object, ranges } of pieces) {
      const source = object as Drawable;
      if ((source as THREE.Mesh).isMesh) continue;
      let g = source.geometry;
      if (ranges) g = subGeometry(g, ranges);
      let mark: THREE.Object3D;
      if ((source as THREE.Points).isPoints) {
        mark = new THREE.Points(g, this.dots);
      } else {
        let fat = this.lineGeometries.get(g);
        if (!fat) this.lineGeometries.set(g, (fat = segmentsOf(g)));
        mark = new Wireframe(fat, this.line);
      }
      mark.matrixAutoUpdate = false;
      mark.matrixWorldAutoUpdate = false;
      mark.raycast = () => {};
      // (After the model, which onTop ones must be.)
      mark.renderOrder = 1;
      this.group.add(mark);
      this.marks.push({ source, mark });
    }
  }

  /** Before a frame: each mark where its source is, shown while it is. */
  update(): void {
    for (const { source, mark } of this.marks) {
      mark.visible = shown(source) && !!source.parent;
      mark.matrixWorld.copy(source.matrixWorld);
    }
  }
}
