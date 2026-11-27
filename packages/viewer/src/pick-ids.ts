// Picking by ids (docs/viewer.md): everything pickable drawn into an off-screen buffer as its id, a 32-bit number in
// an RGBA8 pixel, read under the pointer. The ids are the viewer's own, made again before each such drawing
// (PickIds.assign): numbered depth-first through the model, so each placement's ids, and an assembly's, are one run,
// a placement's its cap (on a section's cap: the part cut) and its faces (by their place in the mesh's `faceRanges`),
// then each line or point child's items (items.ts), then its failed faces' outlines. A face's or item's place reaches
// the shader as a vertex attribute (`pickIndex`: a face's place plus one, an item's place), shared by every placement
// of a part as its geometry is; the placement's or child's first id is its material's uniform. A vertex two faces
// share gets the second's own copy in a geometry made for picking alone (`userData.pick`: scene-graph.ts).
//
// The pass draws what the frame draws: the camera's layers (with the edges' layer while edges are shown, even fat:
// the thin lines stand in for them), the materials' hidden faces and sides, the section planes, the caps (their stencil
// passes as they are, each cap's quad as its part's cap id). Lines and points test depth but don't write it, and are
// drawn after the faces, so the depth is the faces' and caps' alone (the silhouette's x-ray compares with it:
// outline.ts). Transparent faces are drawn as opaque: they're picked, as raycasting did.

import * as THREE from 'three';
import { depthBias, dotBias } from './depth-bias.ts';
import { itemsOf } from './items.ts';
import type { FaceRange } from './selection.ts';

/** The vertex attribute that gives a face's place plus one, or an item's place. */
export const PICK_INDEX = 'pickIndex';

/**
 * Each vertex's face place plus one (faces in `faces`' order; a mesh without faces: 1 for all), and, if some vertex is
 * used by two faces, an index for picking alone in which the later faces' uses of such vertices are copies appended
 * after the `vertexCount` (`copies[i]`: the vertex copied as vertex vertexCount + i).
 */
export function faceIndexAttribute(indices: ArrayLike<number>, faces: readonly { start: number; count: number }[],
  vertexCount: number): { pickIndex: Float32Array; split?: { index: Uint32Array; copies: Uint32Array } } {
  const owner = new Int32Array(vertexCount).fill(-1);
  const runs = faces.length ? faces : [{ start: 0, count: indices.length }];
  let shared = false;
  for (let f = 0; f < runs.length && !shared; f++) {
    const r = runs[f]!;
    for (let i = r.start; i < r.start + r.count; i++) {
      const v = indices[i]!;
      if (owner[v] === -1) owner[v] = f;
      else if (owner[v] !== f) { shared = true; break; }
    }
  }
  if (!shared) {
    const pickIndex = new Float32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) pickIndex[v] = owner[v]! + 1;
    return { pickIndex };
  }
  owner.fill(-1);
  const index = Uint32Array.from(indices);
  const copies: number[] = [];
  const values: number[] = [];
  for (let f = 0; f < runs.length; f++) {
    const r = runs[f]!;
    // This face's copy of each vertex an earlier face owns.
    const mine = new Map<number, number>();
    for (let i = r.start; i < r.start + r.count; i++) {
      const v = indices[i]!;
      if (owner[v] === -1 || owner[v] === f) {
        owner[v] = f;
        continue;
      }
      let c = mine.get(v);
      if (c === undefined) {
        c = vertexCount + copies.length;
        copies.push(v);
        values.push(f + 1);
        mine.set(v, c);
      }
      index[i] = c;
    }
  }
  const pickIndex = new Float32Array(vertexCount + copies.length);
  for (let v = 0; v < vertexCount; v++) pickIndex[v] = owner[v]! + 1;
  pickIndex.set(values, vertexCount);
  return { pickIndex, split: { index, copies: Uint32Array.from(copies) } };
}

/** Each vertex's item place (items as index ranges of `index`); a vertex no item uses 0. */
export function itemIndexAttribute(index: ArrayLike<number>, items: readonly { start: number; count: number }[],
  vertexCount: number): Float32Array {
  const out = new Float32Array(vertexCount);
  items.forEach((item, k) => {
    for (let i = item.start; i < item.start + item.count; i++) out[index[i]!] = k;
  });
  return out;
}

/** What an id stands for. */
export interface IdTarget {
  /** The placement's object (scene-graph.ts: a mesh, or a group for a part without triangles). */
  placement: THREE.Object3D;
  /** What was drawn: the placement's mesh (a face or the cap), a line or point child (an item), a failed outline. */
  object: THREE.Object3D;
  /** A face: its place in the placement's `faceRanges` (none for a mesh without faces). */
  face?: number;
  /** An item: its place in the object's items. */
  item?: number;
  cap?: true;
  /** A line, point or outline (not a face or cap). */
  line?: true;
}

interface Run {
  base: number;
  count: number;
  placement: THREE.Object3D;
  object: THREE.Object3D;
  kind: 'faces' | 'items' | 'outline';
}


/** The model's ids, as last assigned. */
export class PickIds {
  private runs: Run[] = [];
  private readonly byObject = new Map<THREE.Object3D, Run>();
  /** Each placement's ids, [first, end). */
  private readonly blocks = new Map<THREE.Object3D, [number, number]>();

  /** Numbers everything under `root` (in children's order, depth first). */
  assign(root: THREE.Object3D | undefined): void {
    this.runs = [];
    this.byObject.clear();
    this.blocks.clear();
    let next = 1;
    const add = (r: Run) => {
      this.runs.push(r);
      this.byObject.set(r.object, r);
      next += r.count;
    };
    // (Highlight overlays, the selection's, have neither face ranges nor items: never numbered.)
    const visit = (o: THREE.Object3D) => {
      if (o.userData.faceRanges === undefined) {
        for (const c of o.children) visit(c);
        return;
      }
      const first = next;
      const faces = (o.userData.faceRanges as FaceRange[]).length;
      add({ base: next, count: 1 + Math.max(1, faces), placement: o, object: o, kind: 'faces' });
      for (const c of o.children) {
        const n = itemsOf(c).length;
        if (n) add({ base: next, count: n, placement: o, object: c, kind: 'items' });
      }
      for (const c of o.children) {
        if (c.userData.outlineFace !== undefined) {
          add({ base: next, count: 1, placement: o, object: c, kind: 'outline' });
        }
      }
      this.blocks.set(o, [first, next]);
    };
    if (root) visit(root);
  }

  /** The first id of an object's run (a placement's: its cap's), if it has one. */
  baseOf(object: THREE.Object3D): number | undefined {
    return this.byObject.get(object)?.base;
  }

  /** What an id stands for (0: nothing). */
  resolve(id: number): IdTarget | undefined {
    let lo = 0, hi = this.runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.runs[mid]!;
      if (id < r.base) hi = mid - 1;
      else if (id >= r.base + r.count) lo = mid + 1;
      else {
        const at = id - r.base;
        if (r.kind === 'items') return { placement: r.placement, object: r.object, item: at, line: true };
        if (r.kind === 'outline') return { placement: r.placement, object: r.object, line: true };
        if (at === 0) return { placement: r.placement, object: r.object, cap: true };
        const faces = (r.object.userData.faceRanges as FaceRange[]).length;
        return { placement: r.placement, object: r.object, ...(faces ? { face: at - 1 } : {}) };
      }
    }
    return undefined;
  }

  /**
   * The ids of pieces (selection.ts's: whole objects, or ranges of their index), as sorted runs [first, end): a
   * placement's mesh whole is its whole block (its lines, points and cap with it), a line or point object its items;
   * a mesh's ranges the faces they overlap, a line's or point's the items they overlap.
   */
  idsOf(pieces: readonly { object: THREE.Object3D; ranges?: readonly { start: number; count: number }[] }[]):
    [number, number][] {
    const out: [number, number][] = [];
    for (const { object, ranges } of pieces) {
      const run = this.byObject.get(object);
      if (!run) continue;
      if (!ranges) {
        out.push(this.blocks.get(object) ?? [run.base, run.base + run.count]);
        continue;
      }
      const spans = run.kind === 'faces' ? (object.userData.faceRanges as FaceRange[]) : itemsOf(object);
      const offset = run.kind === 'faces' ? 1 : 0;
      spans.forEach((s, k) => {
        const overlaps = ranges.some((r) => r.start < s.start + s.count && s.start < r.start + r.count);
        if (overlaps) out.push([run.base + offset + k, run.base + offset + k + 1]);
      });
    }
    return mergeRuns(out);
  }
}

/** Runs [first, end) sorted and joined where they touch or overlap. */
export function mergeRuns(runs: readonly [number, number][]): [number, number][] {
  const sorted = [...runs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * At most `n` runs covering `runs` (sorted, apart): the narrowest gaps filled first, so the cover takes in as few other
 * ids as it can.
 */
export function coverRuns(runs: readonly [number, number][], n: number): [number, number][] {
  const out = runs.map(([a, b]): [number, number] => [a, b]);
  while (out.length > n) {
    let best = 0;
    for (let i = 1; i < out.length - 1; i++) {
      if (out[i + 1]![0] - out[i]![1] < out[best + 1]![0] - out[best]![1]) best = i;
    }
    out[best]![1] = out[best + 1]![1];
    out.splice(best + 1, 1);
  }
  return out;
}

/** Ids in a window of the buffer (row 0 its bottom), as read. */
export interface IdWindow { ids: Uint32Array; width: number; height: number; cx: number; cy: number }

/**
 * The id picked in windows around the pointer (the pixel at cx, cy) of the faces' ids and the lines' (IdPass), lines
 * and points `reach` device pixels away counting as under it: with a face (or cap) under the pointer, its own
 * placement's nearest point within reach, else its nearest line, else the face; another placement's lines never beat
 * a face, however close, but those of a placement with no faces (a wireframe) do, as nothing else would pick them.
 * With nothing under the pointer, the nearest point within reach, else the nearest line. 0: nothing.
 */
export function choose(faces: IdWindow, w: IdWindow, reach: number, resolve: (id: number) => IdTarget | undefined):
  number {
  const centre = faces.ids[faces.cy * faces.width + faces.cx] ?? 0;
  const face = centre ? resolve(centre) : undefined;
  let point = { id: 0, d: Infinity }, line = { id: 0, d: Infinity };
  const seen = new Map<number, IdTarget | undefined>();
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) {
    const id = w.ids[y * w.width + x]!;
    if (!id) continue;
    const d = Math.hypot(x - w.cx, y - w.cy);
    if (d > reach) continue;
    let t = seen.get(id);
    if (!seen.has(id)) seen.set(id, (t = resolve(id)));
    if (!t?.line) continue;
    if (face && t.placement !== face.placement && !faceless(t.placement)) continue;
    const best = t.object.type === 'Points' ? point : line;
    if (d < best.d || d === best.d && id < best.id) {
      best.id = id;
      best.d = d;
    }
  }
  return point.id || line.id || (face ? centre : 0);
}

/** A placement with no triangles (its object a group, not a mesh). */
const faceless = (placement: THREE.Object3D) => !(placement as THREE.Mesh).isMesh;

const ID_VERTEX = `
uniform float depthBias;
uniform float pointSize;
#ifdef PICK_ATTR
attribute float pickIndex;
#endif
flat varying float vIndex;
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #ifdef PICK_ATTR
  vIndex = pickIndex;
  #else
  vIndex = 0.0;
  #endif
  #include <begin_vertex>
  #include <project_vertex>
  #ifdef DEPTH_BIAS
  gl_Position.z += projectionMatrix[2][2] * depthBias * gl_Position.w;
  #endif
  #ifdef POINTS
  gl_PointSize = pointSize;
  #endif
  #include <clipping_planes_vertex>
}`;

const ID_FRAGMENT = `
uniform uint base;
flat varying float vIndex;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  #ifdef POINTS
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  #endif
  uint id = base + uint(vIndex + 0.5);
  gl_FragColor = vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float(id >> 24)) / 255.0;
}`;

export type IdKind = 'mesh' | 'line' | 'points';

/** A material drawing ids: a run's first id `base` plus the vertex's `pickIndex` (when `perVertex`). */
export function idMaterial(kind: IdKind, opts: { perVertex: boolean; bias: boolean; side?: THREE.Side }):
  THREE.ShaderMaterial {
  const line = kind !== 'mesh';
  return new THREE.ShaderMaterial({
    vertexShader: ID_VERTEX, fragmentShader: ID_FRAGMENT, clipping: true, blending: THREE.NoBlending,
    defines: { ...(opts.perVertex ? { PICK_ATTR: 1 } : {}), ...(opts.bias ? { DEPTH_BIAS: 1 } : {}),
      ...(kind === 'points' ? { POINTS: 1 } : {}) },
    uniforms: { base: { value: 0 }, depthBias: kind === 'points' ? dotBias : depthBias, pointSize: { value: 1 } },
    side: opts.side ?? THREE.FrontSide,
    // Faces as drawn (behind their edges: scene-graph.ts); lines and points after them, writing no depth.
    ...(line ? { transparent: true, depthWrite: false } : { polygonOffset: true, polygonOffsetFactor: 1,
      polygonOffsetUnits: 1 }),
  });
}

/** Device pixels for a points material's dots, as drawn. */
export type PointSize = (m: THREE.Material) => number;

/**
 * The ids drawn off screen, the size of the drawing buffer: the faces' and caps' (`target`, its depth and stencil a
 * texture), then the lines' and points' (`lines`) on a copy of that depth, so a line drawn over a face leaves the
 * face's id under it (picking wants the face under the pointer, and the lines near it).
 */
export class IdPass {
  readonly ids = new PickIds();
  readonly target: THREE.WebGLRenderTarget;
  readonly lines: THREE.WebGLRenderTarget;
  private readonly materials = new WeakMap<THREE.Object3D, THREE.ShaderMaterial>();
  private readonly hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });

  constructor() {
    const target = () => {
      const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedInt248Type);
      depthTexture.format = THREE.DepthStencilFormat;
      return new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: true, depthTexture, generateMipmaps: false });
    };
    this.target = target();
    this.lines = target();
  }

  setSize(width: number, height: number): void {
    if (this.target.width === width && this.target.height === height) return;
    this.target.setSize(width, height);
    this.lines.setSize(width, height);
  }

  private material(o: THREE.Object3D, kind: IdKind, opts: { perVertex: boolean; bias: boolean;
    side?: THREE.Side }): THREE.ShaderMaterial {
    let m = this.materials.get(o);
    const key = `${kind}:${opts.perVertex}:${opts.bias}:${opts.side ?? THREE.FrontSide}`;
    if (!m || m.userData.key !== key) {
      m?.dispose();
      m = idMaterial(kind, opts);
      m.userData.key = key;
      this.materials.set(o, m);
    }
    return m;
  }

  /**
   * Draws the ids of `model` (under `scene`, drawn by `camera` with `layers`), numbered afresh; `skip` the scene's
   * other drawings (fat edges, triangle edges, highlights: hidden meanwhile); caps by their quads'
   * `userData.capOf` (the placement cut). Everything put back after.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, layers: number,
    model: THREE.Object3D | undefined, skip: readonly THREE.Object3D[], pointSize: PointSize): void {
    this.ids.assign(model);
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const hidden: THREE.Object3D[] = [];
    const swap = (o: THREE.Mesh, m: THREE.Material | THREE.Material[]) => {
      swapped.push([o, o.material]);
      o.material = m;
    };
    const geometries: [THREE.Mesh, THREE.BufferGeometry][] = [];
    // What each of the two drawings leaves out: the second the faces by their material (their lines are children).
    const faces: THREE.Object3D[] = [];
    const meshes: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const lines: THREE.Object3D[] = [];
    for (const s of skip) if (s.visible) {
      s.visible = false;
      hidden.push(s);
    }
    scene.traverseVisible((o) => {
      if (o.userData.highlight) {
        o.visible = false;
        hidden.push(o);
        return;
      }
      const d = o as THREE.Mesh;
      if (!d.isMesh && !(o as THREE.Line).isLine && !(o as THREE.Points).isPoints) return;
      const capOf = o.userData.capOf as THREE.Object3D | undefined;
      if (capOf) {
        const cap = d.material as THREE.Material;
        const m = this.material(o, 'mesh', { perVertex: false, bias: false, side: THREE.DoubleSide });
        m.uniforms.base!.value = this.ids.baseOf(capOf) ?? 0;
        // (Its stencil test as the cap's own.)
        Object.assign(m, { stencilWrite: cap.stencilWrite, stencilRef: cap.stencilRef, stencilFunc: cap.stencilFunc,
          stencilFail: cap.stencilFail, stencilZFail: cap.stencilZFail, stencilZPass: cap.stencilZPass,
          polygonOffset: false });
        swap(d, m);
        faces.push(o);
        return;
      }
      const base = this.ids.baseOf(o);
      if (base === undefined) {
        // (A section's counting passes write no colour: kept as they are.)
        if (!(d.material as THREE.Material).colorWrite) {
          faces.push(o);
          return;
        }
        o.visible = false;
        hidden.push(o);
        return;
      }
      const first = [d.material].flat()[0]!;
      if (d.isMesh) {
        const pick = d.geometry.userData.pick as THREE.BufferGeometry | undefined;
        const m = this.material(o, 'mesh', { perVertex: true, bias: false, side: first.side });
        m.uniforms.base!.value = base;
        swap(d, Array.isArray(d.material) ? d.material.map((x) => x.visible ? m : this.hiddenMaterial)
          : d.material.visible ? m : this.hiddenMaterial);
        if (pick) {
          geometries.push([d, d.geometry]);
          d.geometry = pick;
        }
        meshes.push([d, d.material]);
        return;
      }
      const points = (o as THREE.Points).isPoints;
      const perVertex = o.userData.outlineFace === undefined;
      const m = this.material(o, points ? 'points' : 'line', { perVertex, bias: first.userData.depthBias === true ||
        first.userData.dots === true });
      m.uniforms.base!.value = base;
      if (points) m.uniforms.pointSize!.value = pointSize(first);
      m.visible = first.visible;
      swap(d, m);
      lines.push(o);
    });
    const background = scene.background;
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    const mask = camera.layers.mask;
    const was = renderer.getRenderTarget();
    const show = (list: THREE.Object3D[], on: boolean) => { for (const o of list) o.visible = on; };
    try {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;
      camera.layers.mask = layers;
      show(lines, false);
      renderer.setRenderTarget(this.target);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      show(lines, true);
      show(faces, false);
      for (const [o] of meshes) o.material = this.hiddenMaterial;
      renderer.setRenderTarget(this.lines);
      renderer.clear(true, true, true);
      renderer.copyTextureToTexture(this.target.depthTexture!, this.lines.depthTexture!);
      renderer.setRenderTarget(this.lines);
      renderer.render(scene, camera);
    } finally {
      show(faces, true);
      renderer.setRenderTarget(was);
      camera.layers.mask = mask;
      renderer.autoClear = autoClear;
      renderer.setClearColor(clear, alpha);
      scene.background = background;
      for (const [o, m] of swapped) o.material = m;
      for (const [o, g] of geometries) o.geometry = g;
      for (const o of hidden) o.visible = true;
    }
  }

  /**
   * The ids in a rectangle of a target (device pixels from its bottom left), clipped to it; `cx`, `cy` the
   * rectangle's centre in what was read.
   */
  readWindow(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, x: number, y: number, width: number,
    height: number): IdWindow {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(target.width, x + width), y1 = Math.min(target.height, y + height);
    const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
    const bytes = new Uint8Array(4 * w * h);
    if (w && h) renderer.readRenderTargetPixels(target, x0, y0, w, h, bytes);
    const ids = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      ids[i] = (bytes[4 * i]! | bytes[4 * i + 1]! << 8 | bytes[4 * i + 2]! << 16 | bytes[4 * i + 3]! << 24) >>> 0;
    }
    return { ids, width: w, height: h, cx: x + (width >> 1) - x0, cy: y + (height >> 1) - y0 };
  }
}
