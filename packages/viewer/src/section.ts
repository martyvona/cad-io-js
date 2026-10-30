// Section planes (the user, 2026-10-24; CLAUDE.md, "The viewer"): up to three, one across each world axis, each at a
// position along its axis with a side cut away; caps, hatched, where they cut closed parts: in the drawing style of
// the cadrender prototype (beige, two beiges alternating by part colour, black lines), or in each part's colour with
// lines a darker shade of it, as Onshape draws them (the user, 2026-10-27). Either way the lines lie at an angle and
// spacing of the part's own, fixed on the model (they don't move as it turns), and a width fixed on the screen, as
// cadrender's (the user, 2026-10-27).
//
// The planes are the renderer's clipping planes, so they cut everything drawn (N8AO's render included); picking
// skips what they cut away (`clipped`). Caps follow the stencil technique of the cadrender prototype and three.js's
// clipping example, per placed closed part and plane: the part's back faces increment the stencil, its front faces
// decrement it (both clipped, drawing nothing else), then a quad on the plane over the part draws where the count
// isn't zero (inside the solid) and clears the stencil. Each part and plane gets its own render order, so they don't
// mix. The counting passes are clipped by their own plane only (a shader of ours, which the renderer's planes don't
// reach): clipped by another plane too, a solid's far side cut away by it went uncounted, and the cap was missing
// there (the user, 2026-10-27). These helpers live in a group of their own outside the model (no node, no pick, no
// box), made again when the model's drawn meshes change (`invalidate`), moved when a plane moves.

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

/**
 * A counting pass's material, clipped by one plane (`plane`: normal and constant, three.js's sense: what's at a
 * negative distance is cut away). A ShaderMaterial without three.js's clipping chunks, so the renderer's clipping
 * planes don't apply to it.
 */
function stencil(side: THREE.Side, op: THREE.StencilOp, plane: { value: THREE.Vector4 }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ side, colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
    uniforms: { plane },
    vertexShader: 'varying vec3 world;\nvoid main() {\n  vec4 w = modelMatrix * vec4(position, 1.0);\n' +
      '  world = w.xyz;\n  gl_Position = projectionMatrix * viewMatrix * w;\n}',
    fragmentShader: 'uniform vec4 plane;\nvarying vec3 world;\nvoid main() {\n' +
      '  if (dot(plane.xyz, world) + plane.w < 0.0) discard;\n  gl_FragColor = vec4(0.0);\n}' });
}

/** A plane as the counting passes' uniform. */
const planeVector = (p: THREE.Plane, v = new THREE.Vector4()) => v.set(p.normal.x, p.normal.y, p.normal.z, p.constant);

/**
 * How caps look: the drawing style (beige, black hatching), or each part's colour, as Onshape draws them (the default,
 * the user, 2026-10-27).
 */
export type CapStyle = 'drawing' | 'parts';

/**
 * A cap's hatching: its ground and its lines' colours, the lines' angle (radians, in the plane: from its first axis
 * towards its second, `BASIS`) and their spacing (a fraction of the model's size, the radius of its box's bounding
 * sphere).
 */
export interface Hatch { ground: THREE.Color; ink: THREE.Color; angle: number; spacing: number }

// The drawing style's two grounds (the cadrender prototype's beiges), alternating by part colour.
const BEIGES = [0xe9d9b8, 0xf1e9d2];
// A part's angle and spacing, chosen by a hash of its name and colour. cadrender's lines are 0.002 / sqrt(2) model
// units apart; on lightarm, the model it was made for (an Onshape GLB in metres, its bounding sphere's radius
// 84.95 mm), 1.414 mm, 1/60 of the radius: the widest spacing here.
const ANGLES = [30, 45, 60, 120, 135, 150].map((d) => d * Math.PI / 180);
const SPACINGS = [5, 6.5, 8].map((s) => s / 8 / 60);
/**
 * The lines' default width, CSS pixels at half their ink. cadrender's are as wide as 0.8 / zoom of its stripe units,
 * kept on the screen: 0.8 * 2 * scale / (1000 * sqrt(2)) CSS pixels (2 pixels a world unit at zoom 1, the model
 * scaled by 100 / its radius), 1.33 for lightarm.
 */
export const HATCH_WIDTH = 1.33;
/** Each plane's axes, the first at angle 0. */
const BASIS: Record<Axis, [THREE.Vector3, THREE.Vector3]> = { x: [UNIT.y, UNIT.z], y: [UNIT.x, UNIT.z],
  z: [UNIT.x, UNIT.y] };

/** A hash of a string (FNV-1a, 32 bits). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** A part's hatching in the parts style: its colour, lines a darker shade of it, angle and spacing from its name. */
export function partHatch(name: string, color: THREE.Color): Hatch {
  const h = hash(`${name}#${color.getHexString()}`);
  return { ground: color.clone(), ink: color.clone().multiplyScalar(0.35), angle: ANGLES[h % ANGLES.length]!,
    spacing: SPACINGS[Math.floor(h / ANGLES.length) % SPACINGS.length]! };
}

/** What every cap's hatching shares: the model's size, the lines' width and the pixel ratio. */
interface HatchUniforms {
  hatchSize: { value: number };
  hatchWidth: { value: number };
  hatchPixelRatio: { value: number };
}

/**
 * A cap's material for a plane: its ground hatched on the plane, the lines' positions fixed on the model (from the
 * world's origin, in millimetres: the model doesn't move) and their width on the screen, with cadrender's profile: full ink to 0.3 of the width
 * at 0.8 of full (the width at half ink, `hatchWidth`) from the centre line, none from 0.5 on.
 */
function capMaterial(h: Hatch, axis: Axis, shared: HatchUniforms): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: h.ground, side: THREE.DoubleSide, stencilWrite: true, stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp });
  m.userData.hatch = h;
  const [u, v] = BASIS[axis];
  // Everything as uniforms (no per-material code): three.js shares a program between materials whose
  // onBeforeCompile reads the same.
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { hatchInk: { value: h.ink }, hatchSpacing: { value: h.spacing },
      hatchDir: { value: u.clone().multiplyScalar(Math.cos(h.angle)).addScaledVector(v, Math.sin(h.angle)) } });
    shader.vertexShader = 'varying vec3 hatchWorld;\n' + shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  hatchWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = 'varying vec3 hatchWorld;\nuniform float hatchSize;\n' +
      'uniform float hatchWidth;\nuniform float hatchPixelRatio;\nuniform vec3 hatchInk;\n' +
      'uniform vec3 hatchDir;\nuniform float hatchSpacing;\n' +
      shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' +
      // Across the lines in spacings; the distance to the nearest centre line in CSS pixels, by how fast that
      // changes on the screen.
      '  float hatchT = dot(hatchWorld, hatchDir) / (hatchSpacing * hatchSize);\n' +
      '  float hatchPx = abs(fract(hatchT + 0.5) - 0.5) / max(length(vec2(dFdx(hatchT), dFdy(hatchT))), 1e-9) / ' +
      'hatchPixelRatio;\n' +
      '  float hatchW = max(hatchWidth, 0.01) / 0.8;\n' +
      '  diffuseColor.rgb = mix(diffuseColor.rgb, hatchInk, 1.0 - smoothstep(0.3 * hatchW, 0.5 * hatchW, ' +
      'hatchPx));');
  };
  return m;
}

interface Cap { quad: THREE.Mesh; axis: Axis; box: THREE.Box3 }

/** The planes and their caps, for a renderer and a model. */
export class Sections {
  readonly group = new THREE.Group();
  private settings = DEFAULT_SECTIONS();
  private planes: THREE.Plane[] = [];
  /** Each plane's counting passes' materials, back faces then front, sharing the plane's uniform. */
  private readonly counting = Object.fromEntries(AXES.map((a) => {
    const plane = { value: new THREE.Vector4() };
    return [a, [stencil(THREE.BackSide, THREE.IncrementWrapStencilOp, plane),
      stencil(THREE.FrontSide, THREE.DecrementWrapStencilOp, plane)]];
  })) as Record<Axis, [THREE.ShaderMaterial, THREE.ShaderMaterial]>;
  private readonly renderer: THREE.WebGLRenderer;
  private caps: Cap[] = [];
  private dirty = true;
  private readonly capMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private style: CapStyle = 'parts';
  private readonly hatch: HatchUniforms = { hatchSize: { value: 1 },
    hatchWidth: { value: HATCH_WIDTH }, hatchPixelRatio: { value: 1 } };
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
    for (const a of AXES) planeVector(planeFor(a, s[a]), this.counting[a][0].uniforms.plane!.value as THREE.Vector4);
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
    this.hatch.hatchPixelRatio.value = this.renderer.getPixelRatio();
    if (!this.dirty) return;
    this.dirty = false;
    for (const c of [...this.group.children]) this.group.remove(c);
    this.caps = [];
    const on = AXES.filter((a) => this.settings[a].on);
    if (!model || !on.length || !this.settings.caps) return;
    model.updateWorldMatrix(true, true);
    // The lines spaced by the model's size (hidden items included, so hiding doesn't respace them).
    const radius = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere()).radius;
    this.hatch.hatchSize.value = radius > 0 ? radius : 1;
    const partSet = new Set(parts?.() ?? []);
    const units = new Map<THREE.Object3D, THREE.Mesh[]>();
    const visit = (o: THREE.Object3D, part: THREE.Object3D | undefined) => {
      if (!o.visible || o.userData.highlight) return;
      const within = part ?? (partSet.has(o) ? o : undefined);
      const m = o as THREE.Mesh;
      if (m.isMesh && o.layers.isEnabled(0)) {
        const key = within ?? m;
        const list = units.get(key);
        if (list) list.push(m);
        else units.set(key, [m]);
      }
      for (const c of o.children) visit(c, within);
    };
    visit(model, undefined);
    let order = 1000;
    // The drawing style: its two beiges alternate between part colours, in the order met (as cadrender does).
    const byColour = new Map<number, number>();
    const drawingHatch = (color: THREE.Color) => {
      let g = byColour.get(color.getHex());
      if (g === undefined) byColour.set(color.getHex(), (g = BEIGES[byColour.size % BEIGES.length]!));
      return g;
    };
    for (const [part, meshes] of units) {
      if (!this.closed(part, meshes)) continue;
      const box = new THREE.Box3();
      for (const mesh of meshes) {
        mesh.geometry.computeBoundingBox();
        box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
      }
      const hatch = this.capFor(part, meshes[0]!, drawingHatch);
      for (const axis of on) {
        // A part's meshes count in the stencil together: one render order, one cap.
        for (const mesh of meshes) {
          for (const material of this.counting[axis]) {
            const s = new THREE.Mesh(mesh.geometry, material);
            s.matrixAutoUpdate = false;
            s.matrix.copy(mesh.matrixWorld);
            s.renderOrder = order;
            this.group.add(s);
          }
        }
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material(hatch, axis));
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

  /**
   * A part's hatching, by the cap style: from its first mesh's first visible material's colour; the angle and
   * spacing the same in both styles.
   */
  private capFor(part: THREE.Object3D, mesh: THREE.Mesh, drawing: (c: THREE.Color) => number): Hatch {
    const first = [mesh.material].flat().find((m) => m.visible) as THREE.MeshBasicMaterial | undefined;
    const color = first?.color ?? new THREE.Color(0.8, 0.8, 0.8);
    // (A STEP placement by its scene part, so every placement of a part hatches alike.)
    const h = partHatch(part.userData.part !== undefined ? `part ${part.userData.part}` : part.name || mesh.name,
      color);
    return this.style === 'drawing' ? { ...h, ground: new THREE.Color(drawing(color)), ink: new THREE.Color(0) } : h;
  }

  /** The material for caps of a hatching on a plane across an axis. */
  private material(h: Hatch, axis: Axis): THREE.MeshBasicMaterial {
    const key = [h.ground, h.ink].map((c) => c.getHex()).join() + `,${h.angle},${h.spacing},${axis}`;
    let m = this.capMaterials.get(key);
    if (!m) this.capMaterials.set(key, (m = capMaterial(h, axis, this.hatch)));
    return m;
  }

  /** The hatching's lines' width, CSS pixels at half their ink. */
  setHatchWidth(width: number): void {
    this.hatch.hatchWidth.value = width;
  }

  /** The cap style; caps made again at the next draw when it changes. */
  setStyle(style: CapStyle): void {
    if (style === this.style) return;
    this.style = style;
    this.dirty = true;
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
