// The viewer's 3D view: renderer, orthographic camera, trackball controls, lights, and the model under two display
// transforms (the user, 2026-10-24; CLAUDE.md, "The viewer"):
//
//   scene -> display (the centring translation, once the centroid is known) -> frame (the format's up axis and
//     unit to the world's Z up and millimetres) -> the loaded model's root
//
// The centroid is the centre of the axis-aligned box of all the model's geometry, hidden included, in the world,
// found when loading finishes and fixed from then on. One model at a time; loading another replaces it.

import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { clipTo, fit, setAspect, setView, type ViewName } from './camera.ts';
import { formatOf, nativeFrame, type Format } from './formats.ts';
import { Frames } from './frames.ts';
import { loadThree, type Source } from './load.ts';

export interface ModelInfo {
  name: string;
  format: Format;
  /** The world centroid, once loading has finished. */
  centroid?: THREE.Vector3;
}

export interface Stats { objects: number; meshes: number; triangles: number; segments: number; points: number }

const drawable = (o: THREE.Object3D): o is THREE.Mesh | THREE.Line | THREE.Points =>
  (o as THREE.Mesh).isMesh === true || (o as THREE.Line).isLine === true || (o as THREE.Points).isPoints === true;

/** The world box of what's drawn: visible objects whose ancestors are visible too. */
export function visibleBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if (drawable(o)) {
      const inst = o as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        if (!inst.boundingBox) inst.computeBoundingBox();
        part.copy(inst.boundingBox!);
      } else {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        part.copy(o.geometry.boundingBox!);
      }
      if (!part.isEmpty()) box.union(part.applyMatrix4(o.matrixWorld));
    }
    for (const c of o.children) visit(c);
  };
  root.updateWorldMatrix(true, true);
  visit(root);
  return box;
}

export function stats(root: THREE.Object3D): Stats {
  const s: Stats = { objects: 0, meshes: 0, triangles: 0, segments: 0, points: 0 };
  root.traverse((o) => {
    s.objects++;
    if (!drawable(o)) return;
    const g = o.geometry;
    const n = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
    const copies = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
    if ((o as THREE.Mesh).isMesh) { s.meshes++; s.triangles += copies * Math.floor(n / 3); }
    else if ((o as THREE.LineSegments).isLineSegments) s.segments += Math.floor(n / 2);
    else if ((o as THREE.Line).isLine) s.segments += Math.max(0, n - 1);
    else s.points += n;
  });
  return s;
}

function dispose(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!drawable(o)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  readonly controls: TrackballControls;
  readonly frames: Frames;
  /** The centring translation. */
  readonly display = new THREE.Group();
  /** The format's frame to the world's. */
  readonly frame = new THREE.Group();
  model?: ModelInfo;
  private root?: THREE.Object3D;
  private centered = false;
  private bounds = new THREE.Sphere(new THREE.Vector3(), 1);
  private interacting = false;
  private changed = false;
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x404040);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    // A headlight: the light comes from over the viewer's shoulder, whatever the view.
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(1, 1, 2);
    this.camera.add(light);
    this.scene.add(this.camera, this.display);
    this.display.add(this.frame);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1, 1);

    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.rotateSpeed = 4;
    this.controls.staticMoving = true;
    this.controls.addEventListener('start', () => { this.interacting = true; this.frames.request(); });
    this.controls.addEventListener('end', () => { this.interacting = false; this.frames.request(); });
    this.controls.addEventListener('change', () => { this.changed = true; });
    // TrackballControls applies its input in update(), so a frame must follow every input event.
    for (const e of ['pointerdown', 'pointermove', 'wheel'] as const) {
      this.renderer.domElement.addEventListener(e, () => {
        if (this.interacting || e === 'wheel') this.frames.request();
      }, { passive: true });
    }

    this.frames = new Frames(() => this.draw());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private aspect(): number {
    return Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
  }

  private resize(): void {
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    setAspect(this.camera, this.aspect());
    this.controls.handleResize();
    this.frames.request();
  }

  private draw(): boolean {
    this.changed = false;
    this.controls.update();
    clipTo(this.camera, this.bounds);
    this.renderer.render(this.scene, this.camera);
    return this.interacting || this.changed;
  }

  /** Redraws soon (after any change to the scene). */
  redraw(): void {
    this.frames.request();
  }

  /** Replaces the model with the source's. */
  async load(src: Source): Promise<void> {
    const format = formatOf(src.name);
    if (!format) throw new Error(`unknown format: ${src.name}`);
    if (format === 'step') throw new Error('STEP files load in phase 2 of the viewer; not yet');
    let root: THREE.Object3D;
    try {
      root = await loadThree(src, format);
    } finally {
      for (const u of src.siblings?.values() ?? []) URL.revokeObjectURL(u);
    }
    this.clear();
    this.root = root;
    this.frame.matrix.copy(nativeFrame(format, root));
    this.frame.matrix.decompose(this.frame.position, this.frame.quaternion, this.frame.scale);
    this.frame.add(root);
    this.model = { name: src.name, format };
    this.finished();
    this.zoomAll();
  }

  /** Loading has finished: the centroid is found, once. */
  private finished(): void {
    if (!this.model || !this.root || this.model.centroid) return;
    this.display.position.set(0, 0, 0);
    this.display.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.frame);
    this.model.centroid = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    this.updateBounds();
  }

  private clear(): void {
    if (this.root) {
      this.frame.remove(this.root);
      dispose(this.root);
    }
    this.root = undefined;
    this.model = undefined;
    this.centered = false;
    this.display.position.set(0, 0, 0);
  }

  private updateBounds(): void {
    this.display.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.frame);
    if (box.isEmpty()) this.bounds.set(new THREE.Vector3(), 1);
    else box.getBoundingSphere(this.bounds);
  }

  /** Moves the model so its centroid is at the world's origin, or back. */
  setCentered(on: boolean): void {
    const c = this.model?.centroid;
    if (!c) return;
    this.centered = on;
    const before = this.display.position.clone();
    this.display.position.copy(c).multiplyScalar(on ? -1 : 0);
    // The view follows, so the model doesn't jump on the screen.
    const shift = this.display.position.clone().sub(before);
    this.camera.position.add(shift);
    this.controls.target.add(shift);
    this.updateBounds();
    this.redraw();
  }

  isCentered(): boolean {
    return this.centered;
  }

  stats(): Stats | undefined {
    return this.root ? stats(this.root) : undefined;
  }

  /** Fits what's drawn in the viewport, from the current direction. */
  zoomAll(): void {
    fit(this.camera, this.controls.target, visibleBox(this.display), this.aspect());
    this.redraw();
  }

  /** Looks along one of the world's axes, then zooms all. */
  setView(view: ViewName): void {
    setView(this.camera, this.controls.target, view, visibleBox(this.display), this.aspect());
    this.redraw();
  }
}
