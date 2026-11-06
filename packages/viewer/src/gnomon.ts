// The axes gnomon (View's Axes): the file's own axes (Scene.fileAxes, turned by the model's place in the world), X red,
// Y green, Z blue, turning with the view. A scene and camera of its own, drawn after the composed frame into a square
// viewport over the view (where index.html's #gnomon box is), its depth cleared first and its colour not, so the
// model shows around the lines, and without the section planes. It turns about the centre of the smallest sphere holding its four points (the origin
// and the three tips), not about the origin: for perpendicular unit axes that sphere's centre is the tips' centroid
// and its radius sqrt(6)/3 (the origin lies inside it, sqrt(3)/3 from the centre).

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/** The axes' colours, X, Y, Z: readable on the dark and the light themes' backgrounds. */
export const AXIS_COLOURS = [0xff4040, 0x30c030, 0x4080ff] as const;
/** The lines' width, CSS pixels. */
const WIDTH = 2;
/** The sphere's radius, the axes being of unit length. */
const RADIUS = Math.sqrt(6) / 3;
/** The sphere's margin in the viewport (a fraction of its half width), room for the lines' width. */
const MARGIN = 0.08;

export class Gnomon {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
  /** Holds the axes in the world's frame (`set`), moved so the sphere's centre is at the origin. */
  private readonly axes = new THREE.Group();
  private readonly lines: LineSegments2[] = [];
  /** The file's axes in the world, columns of unit length. */
  private readonly frame = new THREE.Matrix4();

  constructor() {
    for (const [i, colour] of AXIS_COLOURS.entries()) {
      const g = new LineSegmentsGeometry().setPositions([0, 0, 0, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]);
      const line = new LineSegments2(g, new LineMaterial({ color: colour, linewidth: WIDTH }));
      line.name = 'XYZ'[i]!;
      this.lines.push(line);
      this.axes.add(line);
    }
    this.axes.matrixAutoUpdate = false;
    this.scene.add(this.axes);
    const s = RADIUS / (1 - MARGIN);
    Object.assign(this.camera, { left: -s, right: s, top: s, bottom: -s });
    this.camera.updateProjectionMatrix();
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
  }

  /** The origin and the three tips where they're drawn in the gnomon's scene, for checks. */
  get points(): THREE.Vector3[] {
    return [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => new THREE.Vector3().fromArray(p)
      .applyMatrix4(this.axes.matrix));
  }

  /** The file's axes in the world (unit columns), for checks. */
  get axesInWorld(): THREE.Matrix4 {
    return this.frame.clone();
  }

  /**
   * Draws over what's on the canvas: looking as `view` looks (its turn), into `box` (CSS pixels from the canvas's
   * bottom left, as setViewport takes them).
   */
  draw(renderer: THREE.WebGLRenderer, view: THREE.Camera, box: { x: number; y: number; size: number }): void {
    view.getWorldQuaternion(this.camera.quaternion);
    this.camera.position.set(0, 0, 2).applyQuaternion(this.camera.quaternion);
    this.camera.updateMatrixWorld();
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
      renderer.setViewport(box.x, box.y, box.size, box.size);
      renderer.setScissor(box.x, box.y, box.size, box.size);
      renderer.setScissorTest(true);
      renderer.clearDepth();
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(target);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.autoClear = autoClear;
      renderer.clippingPlanes = planes;
    }
  }
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
