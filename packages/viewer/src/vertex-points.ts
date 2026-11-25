// Vertices (Rendering's Vertices): the model's B-rep vertices (each part's model's vertex table: scene-graph.ts's
// vertexSets), each a disc drawn by a shader of our own, antialiased at its rim, in the colour of its placement's
// edges (their material, so a selection's tint shows) and as wide as vertexDiameter says. They live in a group of
// their own outside the model, as fat edges do (so the composer's search for transparent materials, which these are
// to blend their rims, doesn't find them): a Points per placement, following its placement's world matrix and
// visibility before each frame. They test depth but don't write it (a nearer disc's rim, written, would cut into a
// farther one beside it). Drawn toward the camera by the outlines' depth bias (depth-bias.ts), so the faces
// they lie on don't cut into them; clipped by the section planes as everything is. Made again when the sets change.

import * as THREE from 'three';
import { depthBias } from './depth-bias.ts';
import type { EdgeStyle } from './fat-edges.ts';

/** A placement's vertices: its object (the part's mesh there), the points (model mm), and its edges if any. */
export interface VertexSet {
  obj: THREE.Object3D;
  points: Float64Array;
  edges?: THREE.LineSegments;
}

/**
 * A disc's diameter in CSS pixels: thin edges are one device pixel, so 2 CSS pixels more than that; fat ones
 * `width` CSS pixels, so half as wide again, but at least 3 CSS pixels more (at narrow widths, half as wide again
 * hardly shows beside the line).
 */
export function vertexDiameter(style: EdgeStyle, width: number, pixelRatio: number): number {
  return style === 'thin' ? 1 / pixelRatio + 2 : Math.max(1.5 * width, width + 3);
}

const VERTEX = `
uniform float size;
uniform float depthBias;
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  gl_Position.z += projectionMatrix[2][2] * depthBias * gl_Position.w;
  gl_PointSize = size;
  #include <clipping_planes_vertex>
}`;

// (The rim's coverage: the disc's radius less the fragment's distance from its centre, both device pixels, over a
// pixel.)
const FRAGMENT = `
uniform vec3 color;
uniform float opacity;
uniform float size;
uniform float radius;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  float d = length((gl_PointCoord - 0.5) * size);
  float a = clamp(radius + 0.5 - d, 0.0, 1.0);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(color, opacity * a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class VertexPoints {
  readonly group = new THREE.Group();
  private readonly pairs: { set: VertexSet; points: THREE.Points }[] = [];
  /** A material per edge material (its colour and opacity), so a selection's tint shows. */
  private readonly materials = new Map<THREE.Material | undefined, THREE.ShaderMaterial>();
  /** The sets drawn (rebuilt when the graph gives others). */
  private sets: readonly VertexSet[] = [];
  /** The geometry for a placement's points, in its object's coordinates (minus its origin). */
  private readonly geometries = new WeakMap<THREE.Object3D, { points: Float64Array; g: THREE.BufferGeometry }>();
  private diameter = 3;
  private pixelRatio = 1;

  constructor() {
    this.group.name = 'vertices';
  }

  /**
   * Before a frame: shown or not (`root` the model's top, its world matrices up to date; `sets` the graph's), discs
   * `diameter` CSS pixels wide at `pixelRatio` device pixels to one.
   */
  update(root: THREE.Object3D | undefined, sets: () => readonly VertexSet[], on: boolean, diameter: number,
    pixelRatio: number): void {
    this.group.visible = on && root !== undefined;
    if (!this.group.visible) return;
    const now = sets();
    if (now.length !== this.sets.length || now.some((s, i) => s.obj !== this.sets[i]!.obj ||
      s.points !== this.sets[i]!.points)) this.rebuild(now);
    this.diameter = diameter;
    this.pixelRatio = pixelRatio;
    for (const { set, points } of this.pairs) {
      points.visible = shown(set.obj, root!);
      if (!points.visible) continue;
      points.matrixWorld.copy(set.obj.matrixWorld);
      points.material = this.materialFor(set.edges?.material as THREE.Material | undefined);
    }
    const radius = this.diameter * this.pixelRatio / 2;
    for (const m of this.materials.values()) {
      m.uniforms.radius!.value = radius;
      // (A pixel's rim beyond the radius each side, and whole pixels.)
      m.uniforms.size!.value = Math.ceil(2 * radius + 2);
    }
  }

  private rebuild(sets: readonly VertexSet[]): void {
    this.sets = sets;
    for (const { points } of this.pairs) this.group.remove(points);
    this.pairs.length = 0;
    for (const set of sets) {
      if (!set.points.length) continue;
      const points = new THREE.Points(this.geometryFor(set), this.materialFor(set.edges?.material as
        THREE.Material | undefined));
      points.matrixAutoUpdate = false;
      points.matrixWorldAutoUpdate = false;
      points.frustumCulled = false;
      points.raycast = () => {};
      this.group.add(points);
      this.pairs.push({ set, points });
    }
  }

  private geometryFor(set: VertexSet): THREE.BufferGeometry {
    const had = this.geometries.get(set.obj);
    if (had && had.points === set.points) return had.g;
    const o = set.obj.position;
    const out = new Float32Array(set.points.length);
    for (let i = 0; i < out.length; i += 3) {
      out[i] = set.points[i]! - o.x;
      out[i + 1] = set.points[i + 1]! - o.y;
      out[i + 2] = set.points[i + 2]! - o.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    this.geometries.set(set.obj, { points: set.points, g });
    return g;
  }

  /** The disc material for an edge material (none: black, the edges' own colour), in the same colour space. */
  private materialFor(m: THREE.Material | undefined): THREE.ShaderMaterial {
    let disc = this.materials.get(m);
    if (!disc) {
      const line = m as THREE.LineBasicMaterial | undefined;
      disc = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, clipping: true,
        transparent: true, depthWrite: false, uniforms: {
          color: { value: (line?.color ?? new THREE.Color(0x000000)).clone() }, opacity: { value: m?.opacity ?? 1 },
          size: { value: 4 }, radius: { value: 1.5 }, depthBias } });
      disc.visible = m?.visible ?? true;
      this.materials.set(m, disc);
    }
    return disc;
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
