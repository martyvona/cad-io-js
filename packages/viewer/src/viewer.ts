// The viewer's 3D view: renderer, orthographic camera, trackball controls, lights, and the model under two display
// transforms (the user, 2026-10-24; CLAUDE.md, "The viewer"):
//
//   scene -> display (the centring translation, once the centroid is known) -> frame (the format's up axis and
//     unit to the world's Z up and millimetres) -> the loaded model's root
//
// The centroid is the centre of the axis-aligned box of all the model's geometry, hidden included, in the world,
// found when loading finishes (for STEP, when the last part is meshed) and fixed from then on. One model at a time;
// loading another replaces it, and cancels the meshing of the last if it's still going.

import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { partMesh, tessellateScene, type Diagnostic } from 'cad-scene';
import { importStep } from 'step-import';
import { clipTo, fit, setAspect, setView, type ViewName } from './camera.ts';
import { formatOf, nativeFrame, type Format } from './formats.ts';
import { Frames } from './frames.ts';
import { loadThree, type Source } from './load.ts';
import { NodeModel, type FaceHiding } from './model.ts';
import { pick, type Pick } from './pick.ts';
import { Composer } from './render.ts';
import { detectEdges, StepGraph } from './step.ts';
import { cadStyle, DEFAULT_RENDER, edgeLayer, type RenderSettings } from './style.ts';
import { DEFAULT_SETTINGS, Tessellation, type TessellationSettings } from './tessellation.ts';

export interface ModelInfo {
  name: string;
  format: Format;
  /** The world centroid, once loading has finished. */
  centroid?: THREE.Vector3;
  /** STEP: the parts to mesh, and how many are done and failed so far. */
  parts?: { total: number; done: number; failed: number };
  /** STEP: the importer's and the tessellation's diagnostics. */
  diagnostics?: Diagnostic[];
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
  /** The user has moved the view since the load began: no more automatic zooming. */
  private moved = false;
  /** Counts loads, so a superseded one's late results are dropped. */
  private generation = 0;
  private meshing = false;
  private readonly container: HTMLElement;
  readonly tessellation = new Tessellation();
  private readonly composer: Composer;
  /** The rendering settings; apply changes with setRender. */
  render: RenderSettings = { ...DEFAULT_RENDER };
  settings: TessellationSettings = { ...DEFAULT_SETTINGS };
  /** Progress messages while loading. */
  onStatus?: (text: string) => void;
  /** The node model of the model just shown (its tree, hiding). */
  nodes?: NodeModel;
  /** A new model is shown (its node model is `nodes`). */
  onModel?: (nodes: NodeModel) => void;
  /** Meshes arrived: parts' detail in the node model changed. */
  onMeshes?: () => void;
  /** A click or tap that didn't move the view: what's under it (or nothing), and the keys held. */
  onPick?: (hit: Pick | undefined, keys: { add: boolean }) => void;
  /** Whether a world point is cut away (by the section planes): not pickable. */
  clipped?: (p: THREE.Vector3) => boolean;

  constructor(container: HTMLElement) {
    this.container = container;
    // No multisampling: SMAA smooths the composed frame. A stencil buffer, for the section caps.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.composer = new Composer(this.renderer, this.scene, this.camera, 1, 1);
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
    this.controls.addEventListener('start', () => {
      this.interacting = this.moved = true;
      this.frames.request();
    });
    this.controls.addEventListener('end', () => { this.interacting = false; this.frames.request(); });
    this.controls.addEventListener('change', () => { this.changed = true; });
    // TrackballControls applies its input in update(), so a frame must follow every input event.
    for (const e of ['pointerdown', 'pointermove', 'wheel'] as const) {
      this.renderer.domElement.addEventListener(e, () => {
        if (this.interacting || e === 'wheel') this.frames.request();
      }, { passive: true });
    }

    // A click or tap: one pointer, down and up within a few pixels and a moment, so not a drag of the view.
    const canvas = this.renderer.domElement;
    const down = new Map<number, { x: number; y: number; t: number }>();
    let many = false;
    canvas.addEventListener('pointerdown', (e) => {
      down.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (down.size > 1) many = true;
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = down.get(e.pointerId);
      down.delete(e.pointerId);
      const single = !many;
      if (!down.size) many = false;
      if (!d || !single || e.button > 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 ||
        performance.now() - d.t > 600) return;
      this.onPick?.(this.pickAt(e.clientX, e.clientY), { add: e.ctrlKey || e.metaKey || e.shiftKey });
    });
    canvas.addEventListener('pointercancel', (e) => down.delete(e.pointerId));

    this.frames = new Frames(() => this.draw());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private aspect(): number {
    return Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
  }

  private resize(): void {
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.composer.setSize(this.container.clientWidth, this.container.clientHeight, this.renderer.getPixelRatio());
    setAspect(this.camera, this.aspect());
    this.controls.handleResize();
    this.frames.request();
  }

  private draw(): boolean {
    this.changed = false;
    this.controls.update();
    clipTo(this.camera, this.bounds);
    this.composer.render();
    return this.interacting || this.changed;
  }

  /** Applies rendering settings (shininess to every Phong face in the model). */
  setRender(s: RenderSettings): void {
    this.render = { ...s };
    this.composer.set(this.render);
    this.display.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if ((o as THREE.Mesh).isMesh) for (const x of Array.isArray(m) ? m : [m]) {
        if ((x as THREE.MeshPhongMaterial).isMeshPhongMaterial) (x as THREE.MeshPhongMaterial).shininess = s.shininess;
      }
    });
    this.redraw();
  }

  /** Redraws soon (after any change to the scene). */
  redraw(): void {
    this.frames.request();
  }

  /** Replaces the model with the source's; for STEP, resolves once every part is meshed (or has failed). */
  async load(src: Source): Promise<void> {
    const format = formatOf(src.name);
    if (!format) throw new Error(`unknown format: ${src.name}`);
    const gen = ++this.generation;
    if (this.meshing) {
      this.tessellation.dispose();
      this.meshing = false;
    }
    if (format === 'step') return this.loadStep(src, gen);
    let root: THREE.Object3D;
    try {
      root = await loadThree(src, format);
    } finally {
      for (const u of src.siblings?.values() ?? []) URL.revokeObjectURL(u);
    }
    if (gen !== this.generation) return;
    detectEdges(root);
    edgeLayer(root);
    if (this.render.cadMaterials) cadStyle(root, this.render.shininess);
    this.show(root, { name: src.name, format });
    this.finished();
    this.zoomAll();
  }

  private show(root: THREE.Object3D, model: ModelInfo, faces?: FaceHiding): void {
    this.clear();
    this.root = root;
    this.nodes = new NodeModel(root, faces);
    this.frame.matrix.copy(nativeFrame(model.format, root));
    this.frame.matrix.decompose(this.frame.position, this.frame.quaternion, this.frame.scale);
    this.frame.add(root);
    this.model = model;
    this.moved = false;
    this.onModel?.(this.nodes);
  }

  private async loadStep(src: Source, gen: number): Promise<void> {
    this.onStatus?.(`${src.name}: reading...`);
    // Let the page show that before the import holds the main thread (for some seconds with a large file).
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const { scene } = await importStep(new Uint8Array(src.bytes));
    if (gen !== this.generation) return;
    const graph = new StepGraph(scene, src.name, this.render.shininess);
    const brep = scene.parts.flatMap((p, i) => p.kind === 'brep' && graph.placements.has(i) ? [i] : []);
    const model: ModelInfo = { name: src.name, format: 'step', parts: { total: brep.length, done: 0, failed: 0 },
      diagnostics: [...scene.diagnostics] };
    this.show(graph.root, model, graph);
    const added = (part: number) => {
      for (const p of graph.placements.get(part) ?? []) this.nodes?.invalidate(p.group);
      this.onMeshes?.();
    };
    // Parts already meshes or curves need no tessellation.
    for (const i of graph.placements.keys()) {
      if (scene.parts[i]!.kind === 'brep') continue;
      const mesh = partMesh(scene, new Map(), i);
      if (mesh) {
        graph.addMesh(i, mesh);
        added(i);
      }
    }
    this.redraw();
    const progress = () => this.onStatus?.(`${src.name}: meshed ${model.parts!.done} of ${model.parts!.total} parts` +
      (model.parts!.failed ? `, ${model.parts!.failed} failed` : ''));
    progress();
    if (brep.length) {
      const s = this.settings;
      const { tess, workers } = await this.tessellation.get(s);
      if (gen !== this.generation) return;
      let zoomed = false;
      this.meshing = true;
      try {
        const { diagnostics } = await tessellateScene(scene, tess, { linearDeflection: s.linearDeflection,
          angularDeflection: s.angularDeflection * Math.PI / 180, edges: true, concurrency: workers, parts: brep,
          onPart: (part, mesh) => {
            if (gen !== this.generation) return;
            model.parts!.done++;
            if (mesh && mesh.indices.length + (mesh.curvePositions?.length ?? 0) + (mesh.points?.length ?? 0)) {
              graph.addMesh(part, mesh);
              added(part);
              if (!zoomed && !this.moved) { zoomed = true; this.zoomAll(); }
            } else model.parts!.failed++;
            progress();
            this.redraw();
          } });
        if (gen !== this.generation) return;
        model.diagnostics!.push(...diagnostics);
      } catch (e) {
        if (gen !== this.generation) return;
        throw e;
      } finally {
        if (gen === this.generation) this.meshing = false;
      }
    }
    this.finished();
    if (!this.moved) this.zoomAll();
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
    this.nodes = undefined;
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

  /** The load that `load` was called for is still the latest (it wasn't replaced by another meanwhile). */
  latest(gen: number): boolean {
    return gen === this.generation;
  }

  /** The number the next load will have. */
  nextLoad(): number {
    return this.generation + 1;
  }

  isCentered(): boolean {
    return this.centered;
  }

  stats(): Stats | undefined {
    return this.root ? stats(this.root) : undefined;
  }

  /** Fits what's drawn in the viewport, from the current direction. */
  /** A pixel's size in world units at the current zoom. */
  pixelSize(): number {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / Math.max(1, this.container.clientHeight);
  }

  /** What's drawn under a point of the page (client coordinates). */
  pickAt(clientX: number, clientY: number): Pick | undefined {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height * 2 - 1));
    this.display.updateWorldMatrix(true, true);
    return pick(this.camera, this.display, ndc, this.pixelSize(), this.clipped);
  }

  /** Fits a box in the viewport, from the current direction; zoom all if it's empty. */
  zoomTo(box: THREE.Box3): void {
    if (box.isEmpty()) return this.zoomAll();
    fit(this.camera, this.controls.target, box, this.aspect());
    this.redraw();
  }

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
