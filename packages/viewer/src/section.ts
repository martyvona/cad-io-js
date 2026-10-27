// Section planes (the user, 2026-10-24; CLAUDE.md, "The viewer"): up to three, one across each world axis, each at a
// position along its axis with a side cut away; caps, hatched in the part's colour, where they cut closed parts.
//
// The planes are the renderer's clipping planes, so they cut everything drawn (N8AO's render included); picking
// skips what they cut away (`clipped`). Caps follow the stencil technique of the cadrender prototype and three.js's
// clipping example, per placed closed part and plane: the part's back faces increment the stencil, its front faces
// decrement it (both clipped, drawing nothing else), then a quad on the plane over the part draws where the count
// isn't zero (inside the solid) and clears the stencil. Each part and plane gets its own render order, so they don't
// mix. These helpers live in a group of their own outside the model (no node, no pick, no box), made again when the
// model's drawn meshes change (`invalidate`), moved when a plane moves.

import * as THREE from 'three';
import { closesUp } from './closure.ts';

export type Axis = 'x' | 'y' | 'z';
export const AXES: readonly Axis[] = ['x', 'y', 'z'];

export interface PlaneSettings {
  on: boolean;
  /** Where the plane crosses its axis, world millimetres. */
  at: number;
  /** Cut away the side below `at`, rather than above it. */
  flip: boolean;
}

export interface SectionSettings {
  x: PlaneSettings;
  y: PlaneSettings;
  z: PlaneSettings;
  caps: boolean;
}

export const DEFAULT_SECTIONS = (): SectionSettings => ({ x: { on: false, at: 0, flip: false },
  y: { on: false, at: 0, flip: false }, z: { on: false, at: 0, flip: false }, caps: true });

const UNIT: Record<Axis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1) };

/** The plane keeping a side: by default what's at or below `at` along the axis (the side above is cut away). */
export function planeFor(axis: Axis, s: PlaneSettings): THREE.Plane {
  // three.js clips points at a negative distance from a plane: the normal points to the side kept.
  return s.flip ? new THREE.Plane(UNIT[axis].clone(), -s.at) : new THREE.Plane(UNIT[axis].clone().negate(), s.at);
}

/** Whether a mesh's triangles close up (closure.ts). Cached on the geometry. */
export function isClosed(geometry: THREE.BufferGeometry): boolean {
  const cached = geometry.userData.closed as boolean | undefined;
  if (cached !== undefined) return cached;
  const closed = closedTogether([{ geometry }]);
  geometry.userData.closed = closed;
  return closed;
}

/**
 * Whether meshes close up together, each in a frame of one part (`matrix`, from its own to the part's; none: the
 * same): a glTF part split into a mesh per face closes up only as a whole.
 */
function closedTogether(meshes: { geometry: THREE.BufferGeometry; matrix?: THREE.Matrix4 }[]): boolean {
  let vertices = 0, indices = 0;
  for (const { geometry: g } of meshes) {
    const count = g.getAttribute('position')?.count ?? 0;
    vertices += count;
    indices += g.index ? g.index.count : count;
  }
  const positions = new Float32Array(vertices * 3);
  const triangles = new Uint32Array(indices);
  const v = new THREE.Vector3();
  let base = 0, at = 0;
  for (const { geometry: g, matrix } of meshes) {
    const pos = g.getAttribute('position');
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (matrix) v.applyMatrix4(matrix);
      positions.set([v.x, v.y, v.z], 3 * (base + i));
    }
    const index = g.index;
    const n = index ? index.count : pos.count;
    // Each mesh's whole triangles only.
    for (let i = 0; i < n - (n % 3); i++) triangles[at++] = base + (index ? index.getX(i) : i);
    base += pos.count;
  }
  return closesUp(positions, triangles.subarray(0, at));
}

const IDENTITY = new THREE.Matrix4();

const stencil = (side: THREE.Side, op: THREE.StencilOp) => new THREE.MeshBasicMaterial({ side, colorWrite: false,
  depthWrite: false, depthTest: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op,
  stencilZFail: op, stencilZPass: op });
const BACK = stencil(THREE.BackSide, THREE.IncrementWrapStencilOp);
const FRONT = stencil(THREE.FrontSide, THREE.DecrementWrapStencilOp);

/** A cap's material: its part's colour, hatched in screen space (diagonal stripes 4 pixels apart). */
function capMaterial(color: THREE.Color): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, stencilWrite: true, stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' +
      '  diffuseColor.rgb *= mod(floor((gl_FragCoord.x + gl_FragCoord.y) / 4.0), 2.0) < 0.5 ? 1.0 : 0.7;');
  };
  return m;
}

interface Cap { quad: THREE.Mesh; axis: Axis; box: THREE.Box3 }

/** The planes and their caps, for a renderer and a model. */
export class Sections {
  readonly group = new THREE.Group();
  private settings = DEFAULT_SECTIONS();
  private planes: THREE.Plane[] = [];
  private readonly renderer: THREE.WebGLRenderer;
  private caps: Cap[] = [];
  private dirty = true;
  private readonly capMaterials = new Map<number, THREE.MeshBasicMaterial>();
  /** Whether parts of several meshes close up, by their geometries and frames. */
  private readonly closedParts = new Map<string, boolean>();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.group.name = 'sections';
  }

  get(): SectionSettings {
    return structuredClone(this.settings);
  }

  /** Applies settings: the renderer's clipping planes; caps made again if the planes on or off changed. */
  set(s: SectionSettings): void {
    const structure = (x: SectionSettings) => AXES.map((a) => `${x[a].on}`).join() + x.caps;
    if (structure(s) !== structure(this.settings)) this.dirty = true;
    this.settings = structuredClone(s);
    this.planes = AXES.filter((a) => s[a].on).map((a) => planeFor(a, s[a]));
    this.renderer.clippingPlanes = this.planes;
    this.move();
  }

  /** Whether a world point is cut away. */
  clipped(p: THREE.Vector3): boolean {
    return this.planes.some((pl) => pl.distanceToPoint(p) < 0);
  }

  /** The model's drawn meshes changed (meshes arrived, hidden or shown, moved): caps made again at the next draw. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Before drawing: makes the caps again if needed. A part (one of `parts`, the node model's: its meshes capped as one
   * solid, a mesh per face as a glTF file may have) or else each mesh on its own.
   */
  update(model: THREE.Object3D | undefined, parts?: () => Iterable<THREE.Object3D>): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const c of [...this.group.children]) this.group.remove(c);
    this.caps = [];
    const on = AXES.filter((a) => this.settings[a].on);
    if (!model || !on.length || !this.settings.caps) return;
    model.updateWorldMatrix(true, true);
    const partSet = new Set(parts?.() ?? []);
    const units = new Map<THREE.Object3D, THREE.Mesh[]>();
    const visit = (o: THREE.Object3D, part: THREE.Object3D | undefined) => {
      if (!o.visible || o.userData.highlight) return;
      const within = part ?? (partSet.has(o) ? o : undefined);
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && o.layers.isEnabled(0)) {
        const key = within ?? m;
        const list = units.get(key);
        if (list) list.push(m);
        else units.set(key, [m]);
      }
      for (const c of o.children) visit(c, within);
    };
    visit(model, undefined);
    let order = 1000;
    for (const [part, meshes] of units) {
      if (!this.closed(part, meshes)) continue;
      const box = new THREE.Box3();
      for (const mesh of meshes) {
        mesh.geometry.computeBoundingBox();
        box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
      }
      const color = this.colorOf(meshes[0]!);
      for (const axis of on) {
        // A part's meshes count in the stencil together: one render order, one cap.
        for (const mesh of meshes) {
          for (const material of [BACK, FRONT]) {
            const s = new THREE.Mesh(mesh.geometry, material);
            s.matrixAutoUpdate = false;
            s.matrix.copy(mesh.matrixWorld);
            s.renderOrder = order;
            this.group.add(s);
          }
        }
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), color);
        quad.renderOrder = order + 1;
        quad.onAfterRender = (r) => r.clearStencil();
        this.group.add(quad);
        this.caps.push({ quad, axis, box });
        order += 2;
      }
    }
    this.move();
  }

  /**
   * Whether a part's visible meshes close up together (one mesh: isClosed, cached on its geometry; several: cached by
   * their geometries and their frames in the part's).
   */
  private closed(part: THREE.Object3D, meshes: THREE.Mesh[]): boolean {
    // What the source says, when it says it for every mesh (STEP: the scene part's closed); else their triangles.
    const stated = meshes.map((m) => m.userData.closed as boolean | undefined);
    if (stated.every((c) => c !== undefined)) return stated.every((c) => c);
    if (meshes.length === 1) return isClosed(meshes[0]!.geometry);
    const inverse = part.matrixWorld.clone().invert();
    const frames = meshes.map((m) => {
      const matrix = inverse.clone().multiply(m.matrixWorld);
      return matrix.equals(IDENTITY) ? undefined : matrix;
    });
    const key = meshes.map((m, i) => m.geometry.uuid + (frames[i] ? `@${frames[i].elements.join(',')}` : '')).join();
    let closed = this.closedParts.get(key);
    if (closed === undefined) {
      closed = closedTogether(meshes.map((m, i) => ({ geometry: m.geometry, matrix: frames[i] })));
      this.closedParts.set(key, closed);
    }
    return closed;
  }

  /** The material for a mesh's caps: its first visible material's colour. */
  private colorOf(mesh: THREE.Mesh): THREE.MeshBasicMaterial {
    const first = [mesh.material].flat().find((m) => m.visible) as THREE.MeshBasicMaterial | undefined;
    const color = first?.color ?? new THREE.Color(0.8, 0.8, 0.8);
    let m = this.capMaterials.get(color.getHex());
    if (!m) this.capMaterials.set(color.getHex(), (m = capMaterial(color.clone())));
    return m;
  }

  /**
   * Puts each cap on its plane over its part's box, a hair inside the kept side (not clipped by its own plane), and
   * the size of the box across the plane, with a margin.
   */
  private move(): void {
    for (const { quad, axis, box } of this.caps) {
      const s = this.settings[axis];
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const eps = 1e-5 * Math.max(1, size.length(), Math.abs(s.at));
      centre[axis] = s.at + (s.flip ? eps : -eps);
      quad.position.copy(centre);
      quad.rotation.set(axis === 'y' ? Math.PI / 2 : 0, axis === 'x' ? Math.PI / 2 : 0, 0);
      const [u, v] = axis === 'x' ? [size.z, size.y] : axis === 'y' ? [size.x, size.z] : [size.x, size.y];
      quad.scale.set(u * 1.1 + eps, v * 1.1 + eps, 1);
    }
  }
}
