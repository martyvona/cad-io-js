// The axes gnomon (View's Axes): the file's own axes (Scene.fileAxes, turned by the model's place in the world), X red,
// Y green, Z blue, turning with the view, each labelled with its lowercase letter beyond its tip. A scene and camera
// of its own, drawn after the composed frame into a viewport over the view (index.html's #gnomon box, sized here), its
// depth cleared first and its colour not, so the model shows around it, and without the section planes. It turns about
// the centre of the smallest sphere holding its four points (the origin and the three tips), not about the origin: for
// perpendicular unit axes that sphere's centre is the tips' centroid and its radius sqrt(6)/3 (the origin lies inside
// it, sqrt(3)/3 from the centre).
//
// Labels: each centred on its placement point, (1 + LABEL_GAP) along its axis, projected, in a square box of LABEL_BOX
// pixels (one for every letter, not fitted to it); boxes that overlap are nudged sideways apart (layoutLabels), never
// the fourth, unlabelled box at the origin, which the others clear. The labels and the origin box are click targets
// (Viewer: an axis looks along it, the origin box the iso view), a finger's reaching further (TOUCH_REACH).
// An axis along the line of sight shows as a symbol in the origin's box (axisSymbol): a ringed dot pointing at the
// viewer, a ringed cross pointing away, its ring filled with the view's background, fading in over SYMBOL_FADE. The #gnomon box holds every layout the labels can
// take (GNOMON_EXTENT, checked over sampled turns by the unit test), so nothing leaves it as the gnomon turns.
//
// Labels move smoothly: each rides its placement point (which turns with the view, as its tip does), its nudge changing
// at most NUDGE_SPEED as the view turns freely, and during a flight (Viewer's eased moves to a view) blended from what
// it was to the destination's layout as the camera's turn is, so each label ends the flight where it belongs.

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { VIEWS, type ViewName } from './camera.ts';

/** The axes' colours, X, Y, Z: readable on the dark and the light themes' backgrounds. */
export const AXIS_COLOURS = [0xff4040, 0x30c030, 0x4080ff] as const;
/** The lines' width, CSS pixels. */
const WIDTH = 2;
/** An axis's length on the screen, CSS pixels. */
export const AXIS_PIXELS = 34;
/** How far beyond its tip a label's placement point is, in axis lengths. */
export const LABEL_GAP = 0.3;
/** The labels' (and the origin box's) square box, CSS pixels. */
export const LABEL_BOX = 14;
/** How far from a target's centre a finger's tap hits it, CSS pixels (its drawn box's half for a mouse). */
export const TOUCH_REACH = 20;
/**
 * How far the gnomon (its lines and every label box however nudged) can reach from its sphere's centre, CSS pixels:
 * the most over every turn (gnomon.test.ts samples them), rounded up. The #gnomon box is this big, the centre placed
 * `left` and `down` from its lower left corner.
 */
export const GNOMON_EXTENT = { left: 44, right: 44, down: 44, up: 44 };
/** How fast a label's nudge may change while the view turns freely, CSS pixels a second. */
export const NUDGE_SPEED = 120;
/** The longest time between frames a nudge's change counts, seconds: after a pause, the next frame isn't a jump. */
const MAX_STEP = 0.05;
/** The sphere's radius, the axes being of unit length. */
const RADIUS = Math.sqrt(6) / 3;

/** What a click on the gnomon hits: an axis's label, or the box at its origin. */
export type GnomonTarget = 'x' | 'y' | 'z' | 'iso';

export interface Point2 {
  x: number;
  y: number;
}

/**
 * Label centres for the three placement points (screen pixels, any origin, y up) with the fixed box at `origin`, every
 * box `size` square: boxes that overlap are moved sideways apart, a pair of labels each by half, a label alone from the
 * origin box; each pair parts the way their placement points lie (lower index left where they're level).
 */
export function layoutLabels(points: readonly Point2[], origin: Point2, size: number): Point2[] {
  const start = [...points, origin];
  const at = start.map((p) => ({ x: p.x, y: p.y }));
  const fixed = start.length - 1;
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < at.length; i++) {
      for (let j = i + 1; j < at.length; j++) {
        const a = at[i]!, b = at[j]!;
        if (Math.abs(a.y - b.y) >= size || Math.abs(a.x - b.x) >= size) continue;
        // i goes to side s of j.
        const s = Math.sign(start[i]!.x - start[j]!.x) || -1;
        const need = size - s * (a.x - b.x);
        if (need <= 1e-9) continue;
        if (j === fixed) a.x += s * need;
        else {
          a.x += s * need / 2;
          b.x -= s * need / 2;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return at.slice(0, fixed);
}

/** The labels' nudges (where layoutLabels puts them less their placement points) for a projection. */
export function nudgesOf(p: { placements: Point2[]; origin: Point2 }): Point2[] {
  return layoutLabels(p.placements, p.origin, LABEL_BOX).map((l, k) => ({ x: l.x - p.placements[k]!.x,
    y: l.y - p.placements[k]!.y }));
}

/** Nudges moved from `shown` towards `target`, each by at most `step` pixels. */
export function stepNudges(shown: readonly Point2[], target: readonly Point2[], step: number): Point2[] {
  return shown.map((a, k) => {
    const b = target[k]!, d = Math.hypot(b.x - a.x, b.y - a.y);
    return d <= step ? { ...b } : { x: a.x + (b.x - a.x) * step / d, y: a.y + (b.y - a.y) * step / d };
  });
}

/**
 * Where the gnomon's points are on the screen for a turn of its axes relative to the view (`axes`, columns the axes in
 * the camera's frame): the sphere's centre at (0, 0), CSS pixels, y up. `placements` the labels' points, `tips` the
 * lines' ends, `origin` where they meet.
 */
export function project(axes: THREE.Matrix4): { tips: Point2[]; placements: Point2[]; origin: Point2 } {
  const e = axes.elements;
  const col = (k: number) => new THREE.Vector3(e[k * 4]!, e[k * 4 + 1]!, e[k * 4 + 2]!);
  const centre = col(0).add(col(1)).add(col(2)).divideScalar(3);
  const px = (v: THREE.Vector3) => ({ x: (v.x - centre.x) * AXIS_PIXELS, y: (v.y - centre.y) * AXIS_PIXELS });
  return { tips: [0, 1, 2].map((k) => px(col(k))), placements: [0, 1, 2].map((k) => px(col(k)
    .multiplyScalar(1 + LABEL_GAP))), origin: px(new THREE.Vector3()) };
}

/** How opaque a label's backing is: a little off the view's background (backingColour), veiling what's behind. */
export const BACKING_OPACITY = 0.75;
/** How far a backing's colour is from the view's background, towards white on dark ones, black on light ones. */
const BACKING_TINT = 0.15;

/** A label's backing's colour for a view's background: a shade lighter on a dark one, darker on a light one. */
export function backingColour(background: THREE.Color): THREE.Color {
  const dark = background.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace).l < 0.5;
  return background.clone().lerp(new THREE.Color(dark ? 0xffffff : 0x000000), BACKING_TINT);
}
/** The backing's corners' radius, CSS pixels. */
const BACKING_RADIUS = 3;

/**
 * A label's backing: a square of rounded corners, white on transparent, as an alpha map (its green channel). Not as a
 * colour map: filtering mixes in the transparent texels' black, a dark fringe at every edge once tinted.
 */
function backingTexture(): THREE.CanvasTexture {
  const n = 64, r = n * BACKING_RADIUS / LABEL_BOX;
  const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  // (arcTo, not roundRect: older Safari lacks it.)
  g.beginPath();
  g.moveTo(r, 0);
  g.arcTo(n, 0, n, n, r);
  g.arcTo(n, n, 0, n, r);
  g.arcTo(0, n, 0, 0, r);
  g.arcTo(0, 0, n, 0, r);
  g.closePath();
  g.fill();
  return new THREE.CanvasTexture(canvas);
}

/** The symbol of an axis along the line of sight: its ring's radius, its stroke, its dot's radius, CSS pixels. */
export const SYMBOL = { ring: 6, stroke: 1.5, dot: 2.25, arm: 3.75 };
/** How far off the line of sight an axis's symbol starts fading in, and where it's whole, degrees. */
export const SYMBOL_FADE = { from: 10, whole: 3 };

/**
 * An axis's symbol along the line of sight, as an alpha map (as the backing's) the label box's size: a ring with a
 * dot (`head`: the axis points at the viewer, an arrow's head) or a cross (its tail).
 */
function symbolTexture(head: boolean): THREE.CanvasTexture {
  const n = 64, k = n / LABEL_BOX, c = n / 2;
  const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = canvas.getContext('2d')!;
  g.strokeStyle = g.fillStyle = '#fff';
  g.lineWidth = SYMBOL.stroke * k;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(c, c, SYMBOL.ring * k, 0, 2 * Math.PI);
  g.stroke();
  g.beginPath();
  if (head) {
    g.arc(c, c, SYMBOL.dot * k, 0, 2 * Math.PI);
    g.fill();
  } else {
    const a = SYMBOL.arm * k / Math.SQRT2;
    g.moveTo(c - a, c - a);
    g.lineTo(c + a, c + a);
    g.moveTo(c - a, c + a);
    g.lineTo(c + a, c - a);
    g.stroke();
  }
  return new THREE.CanvasTexture(canvas);
}

/** The inside of a symbol's ring, filled, as an alpha map the label box's size (to the ring's middle). */
function discTexture(): THREE.CanvasTexture {
  const n = 64, c = n / 2;
  const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(c, c, SYMBOL.ring * n / LABEL_BOX, 0, 2 * Math.PI);
  g.fill();
  return new THREE.CanvasTexture(canvas);
}

/**
 * The symbol for axes `back` (each axis's part along the view's back, a unit's): the axis within SYMBOL_FADE.from
 * degrees of the line of sight (one at most), whether it points at the viewer, and how much shown.
 */
export function axisSymbol(back: readonly number[]): { axis: number; head: boolean; opacity: number } | undefined {
  const cos = (deg: number) => Math.cos(deg * Math.PI / 180);
  const k = back.findIndex((z) => Math.abs(z) > cos(SYMBOL_FADE.from));
  if (k < 0) return undefined;
  const t = (Math.abs(back[k]!) - cos(SYMBOL_FADE.from)) / (cos(SYMBOL_FADE.whole) - cos(SYMBOL_FADE.from));
  return { axis: k, head: back[k]! > 0, opacity: Math.min(1, t) };
}

/** A letter's alpha map (as the backing's): white on transparent, its x-height centred. */
function letterTexture(letter: string): THREE.CanvasTexture {
  const n = 64;
  const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = canvas.getContext('2d')!;
  g.font = `600 ${Math.round(n * 0.8)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const xHeight = g.measureText('x').actualBoundingBoxAscent;
  g.fillText(letter, n / 2, n / 2 + xHeight / 2);
  return new THREE.CanvasTexture(canvas);
}

export class Gnomon {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
  /** The labels, in pixels of the viewport (labelCamera). */
  private readonly labelScene = new THREE.Scene();
  private readonly labelCamera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  private labels?: THREE.Object3D[];
  /** The labels' backings' material, its colour set from the view's background at each draw. */
  private backing?: THREE.MeshBasicMaterial;
  /** Holds the axes in the world's frame (`set`), moved so the sphere's centre is at the origin. */
  private readonly axes = new THREE.Group();
  /** The file's axes in the world, columns of unit length. */
  private readonly frame = new THREE.Matrix4();
  /** The last drawn layout's boxes' centres, CSS pixels from the viewport's lower left: x, y, z, then the origin. */
  private boxes: Point2[] = [];
  /**
   * The labels' nudges as drawn: following the layout's at NUDGE_SPEED as the view turns freely, or blended from what
   * they were to the destination's during a flight; undefined, the layout's at the next draw (a new model).
   */
  private nudges?: Point2[];
  /** The flight being followed (Viewer's, by identity) and the nudges it goes from and to. */
  private flight?: { id: object; from: Point2[]; to: Point2[] };
  /** When the last draw was (performance.now()). */
  private last = -Infinity;
  /** The labels are still on their way to the layout's places: more frames wanted. */
  moving = false;
  /** The symbol of the axis along the line of sight, if one is (axisSymbol), as last laid out. */
  symbol?: { axis: number; head: boolean; opacity: number };
  private symbolMesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Behind the symbol, inside its ring: the view's background, opaque (but as the symbol fades). */
  private disc?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private symbolMaps?: { head: THREE.Texture; tail: THREE.Texture };

  constructor() {
    for (const [i, colour] of AXIS_COLOURS.entries()) {
      const g = new LineSegmentsGeometry().setPositions([0, 0, 0, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]);
      const line = new LineSegments2(g, new LineMaterial({ color: colour, linewidth: WIDTH }));
      line.name = 'XYZ'[i]!;
      this.axes.add(line);
    }
    this.axes.matrixAutoUpdate = false;
    this.scene.add(this.axes);
  }

  /** The #gnomon box's size, CSS pixels. */
  static get size(): { width: number; height: number } {
    return { width: GNOMON_EXTENT.left + GNOMON_EXTENT.right, height: GNOMON_EXTENT.down + GNOMON_EXTENT.up };
  }

  /**
   * The file's axes in the world: `fileAxes` (Scene.fileAxes; undefined, the world's) under `world`, the model's place
   * (its turn only: scale and translation dropped).
   */
  set(fileAxes: ArrayLike<number> | undefined, world: THREE.Matrix4): void {
    // (extractRotation drops the scale and translation; fileAxes is a rotation alone.)
    this.frame.extractRotation(world);
    if (fileAxes) this.frame.multiply(new THREE.Matrix4().fromArray(Array.from(fileAxes)));
    const e = this.frame.elements;
    // The tips' centroid to the origin.
    const centre = new THREE.Vector3(e[0]! + e[4]! + e[8]!, e[1]! + e[5]! + e[9]!, e[2]! + e[6]! + e[10]!)
      .divideScalar(3);
    this.axes.matrix.copy(this.frame).premultiply(new THREE.Matrix4().makeTranslation(centre.negate()));
    this.axes.matrixWorldNeedsUpdate = true;
    this.nudges = undefined;
  }

  /** The axes in the frame of a camera turned so (columns: each axis's right, up and back there). */
  private turnFor(q: THREE.Quaternion): THREE.Matrix4 {
    return new THREE.Matrix4().makeRotationFromQuaternion(q).invert().multiply(this.frame);
  }

  /** The origin and the three tips where they're drawn in the gnomon's scene, for checks. */
  get points(): THREE.Vector3[] {
    return [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => new THREE.Vector3().fromArray(p)
      .applyMatrix4(this.axes.matrix));
  }

  /** The file's axes in the world (unit columns). */
  get axesInWorld(): THREE.Matrix4 {
    return this.frame.clone();
  }

  /** The last drawn boxes' centres (x, y, z, origin), CSS pixels from the viewport's lower left, for checks. */
  get layout(): Point2[] {
    return this.boxes.map((b) => ({ ...b }));
  }

  /**
   * What's at a point (CSS pixels from the viewport's lower left) in the last drawn layout: a label's box or the
   * origin's, reaching `reach` pixels from its centre across and up (its drawn box's half by default; TOUCH_REACH for a
   * finger), the nearest centre where reaches overlap.
   */
  hit(x: number, y: number, reach = LABEL_BOX / 2): GnomonTarget | undefined {
    let best: number | undefined, nearest = Infinity;
    for (const [k, b] of this.boxes.entries()) {
      if (Math.abs(x - b.x) > reach || Math.abs(y - b.y) > reach) continue;
      const d = Math.hypot(x - b.x, y - b.y);
      if (d < nearest) [best, nearest] = [k, d];
    }
    return best === undefined ? undefined : (['x', 'y', 'z', 'iso'] as const)[best];
  }

  /**
   * Draws over what's on the canvas: looking as `view` looks (its turn), into `box` (CSS pixels from the canvas's
   * bottom left, as setViewport takes them; Gnomon.size), the sphere's centre at GNOMON_EXTENT's left and down; the
   * labels' backings a shade off `background`, the view's. `motion`: the time, and the flight in progress (its
   * identity, its destination's turn, and how far it has come, smoothstepped as the camera is).
   */
  draw(renderer: THREE.WebGLRenderer, view: THREE.Camera, box: { x: number; y: number; width: number;
    height: number }, background: THREE.Color, motion: { now: number; flight?: { id: object;
    to: THREE.Quaternion; s: number } } = { now: 0 }): void {
    view.getWorldQuaternion(this.camera.quaternion);
    this.camera.position.set(0, 0, 2).applyQuaternion(this.camera.quaternion);
    this.camera.updateMatrixWorld();
    // The lines' camera: axis lengths across the viewport, the sphere's centre (the scene's origin) where it belongs.
    const cx = GNOMON_EXTENT.left, cy = GNOMON_EXTENT.down;
    Object.assign(this.camera, { left: -cx / AXIS_PIXELS, right: (box.width - cx) / AXIS_PIXELS,
      bottom: -cy / AXIS_PIXELS, top: (box.height - cy) / AXIS_PIXELS });
    this.camera.updateProjectionMatrix();
    this.advance(this.camera.quaternion, motion);
    this.layOut(box);
    this.backing!.color.copy(backingColour(background));
    this.disc!.material.color.copy(background);
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    const autoClear = renderer.autoClear;
    const target = renderer.getRenderTarget();
    // (The section planes are the renderer's global clipping planes: not the gnomon's.)
    const planes = renderer.clippingPlanes;
    try {
      renderer.clippingPlanes = [];
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.setViewport(box.x, box.y, box.width, box.height);
      renderer.setScissor(box.x, box.y, box.width, box.height);
      renderer.setScissorTest(true);
      renderer.clearDepth();
      renderer.render(this.scene, this.camera);
      renderer.render(this.labelScene, this.labelCamera);
    } finally {
      renderer.setRenderTarget(target);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.autoClear = autoClear;
      renderer.clippingPlanes = planes;
    }
  }

  /**
   * The labels for a camera turned `q`: each at its placement point plus its nudge as drawn (`nudges`), in `layout`
   * (draw's `motion`).
   */
  advance(q: THREE.Quaternion, motion: { now: number; flight?: { id: object; to: THREE.Quaternion; s: number } }):
    void {
    const turn = this.turnFor(q);
    const now = project(turn);
    const target = nudgesOf(now);
    this.symbol = axisSymbol([0, 1, 2].map((k) => turn.elements[k * 4 + 2]!));
    const dt = Math.min(MAX_STEP, Math.max(0, (motion.now - this.last) / 1000));
    this.last = motion.now;
    const f = motion.flight;
    if (!this.nudges) this.nudges = target;
    else if (f) {
      if (this.flight?.id !== f.id) this.flight = { id: f.id, from: this.nudges, to: nudgesOf(project(
        this.turnFor(f.to))) };
      const { from, to } = this.flight;
      this.nudges = from.map((a, k) => ({ x: a.x + (to[k]!.x - a.x) * f.s, y: a.y + (to[k]!.y - a.y) * f.s }));
    } else {
      this.flight = undefined;
      this.nudges = stepNudges(this.nudges, target, NUDGE_SPEED * dt);
    }
    this.moving = this.nudges.some((n, k) => Math.hypot(n.x - target[k]!.x, n.y - target[k]!.y) > 1e-3);
    const labels = now.placements.map((p, k) => ({ x: p.x + this.nudges![k]!.x, y: p.y + this.nudges![k]!.y }));
    this.boxes = [...labels, now.origin].map((p) => ({ x: p.x + GNOMON_EXTENT.left, y: p.y + GNOMON_EXTENT.down }));
  }

  /** The labels' quads where `layout` says (made the first time: they need a document). */
  private layOut(box: { width: number; height: number }): void {
    if (!this.labels) {
      const quad = new THREE.PlaneGeometry(LABEL_BOX, LABEL_BOX);
      this.backing = new THREE.MeshBasicMaterial({ alphaMap: backingTexture(), transparent: true,
        opacity: BACKING_OPACITY, depthTest: false, depthWrite: false });
      this.labels = AXIS_COLOURS.map((colour, i) => {
        const label = new THREE.Group();
        const back = new THREE.Mesh(quad, this.backing);
        const letter = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ alphaMap: letterTexture('xyz'[i]!),
          color: colour, transparent: true, depthTest: false, depthWrite: false }));
        // (No depth test: drawn in this order, the letter over its backing.)
        back.renderOrder = 0;
        letter.renderOrder = 1;
        label.add(back, letter);
        this.labelScene.add(label);
        return label;
      });
    }
    for (const [i, m] of this.labels.entries()) m.position.set(this.boxes[i]!.x, this.boxes[i]!.y, 0);
    // The symbol where the axes meet, in the origin's box, which the labels clear.
    if (!this.symbolMesh) {
      this.symbolMaps = { head: symbolTexture(true), tail: symbolTexture(false) };
      // (Made with an alpha map, so its program has one: the maps are swapped, never added.)
      this.symbolMesh = new THREE.Mesh(new THREE.PlaneGeometry(LABEL_BOX, LABEL_BOX), new THREE.MeshBasicMaterial({
        alphaMap: this.symbolMaps.tail, transparent: true, depthTest: false, depthWrite: false }));
      this.disc = new THREE.Mesh(this.symbolMesh.geometry, new THREE.MeshBasicMaterial({ alphaMap: discTexture(),
        transparent: true, depthTest: false, depthWrite: false }));
      // (No depth test: drawn in this order, the disc under the symbol.)
      this.disc.renderOrder = 0;
      this.symbolMesh.renderOrder = 1;
      this.symbolMesh.add(this.disc);
      this.labelScene.add(this.symbolMesh);
    }
    const sym = this.symbol, m = this.symbolMesh;
    m.visible = sym !== undefined;
    if (sym) {
      m.material.alphaMap = sym.head ? this.symbolMaps!.head : this.symbolMaps!.tail;
      m.material.color.setHex(AXIS_COLOURS[sym.axis]!);
      m.material.opacity = this.disc!.material.opacity = sym.opacity;
      m.position.set(this.boxes[3]!.x, this.boxes[3]!.y, 0);
    }
    Object.assign(this.labelCamera, { left: 0, right: box.width, bottom: 0, top: box.height });
    this.labelCamera.updateProjectionMatrix();
  }
}

/** How near a view must be to a direction (or the iso view's turn) to count as along it, degrees. */
export const ALIGNED_DEGREES = 1;
const ALIGNED = Math.cos(ALIGNED_DEGREES * Math.PI / 180);

/**
 * The view a click on axis `k`'s label asks for: the one with that axis pointing at the viewer, or away if it already
 * does (`back` the view's back, a unit, in the world); undefined where no view is along it (axes turned off the
 * world's).
 */
export function axisView(k: number, axes: THREE.Matrix4, back: THREE.Vector3): ViewName | undefined {
  const e = axes.elements;
  const d = new THREE.Vector3(e[k * 4]!, e[k * 4 + 1]!, e[k * 4 + 2]!).normalize();
  if (d.dot(back) >= ALIGNED) d.negate();
  // (A view's `dir` is where the camera sits from what it looks at: the axis pointing at it.)
  return (Object.keys(VIEWS) as ViewName[]).find((v) => v !== 'iso' &&
    new THREE.Vector3(...VIEWS[v].dir).normalize().dot(d) >= ALIGNED);
}

/** Whether two cameras' turns are within ALIGNED_DEGREES of each other. */
export function sameTurn(a: THREE.Quaternion, b: THREE.Quaternion): boolean {
  return 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) <= ALIGNED_DEGREES * Math.PI / 180;
}

/**
 * Whether the gnomon starts shown, from the page's query and what this browser remembers ('0' hidden): ?gnomon=0 or 1
 * decides; else pages for checks and shots (?check, ?controls=0) start without it; else as remembered, shown at first.
 */
export function gnomonShown(search: string, remembered: string | null): boolean {
  const q = new URLSearchParams(search);
  const asked = q.get('gnomon');
  if (asked !== null) return asked !== '0';
  if (q.has('check') || q.get('controls') === '0') return false;
  return remembered !== '0';
}
