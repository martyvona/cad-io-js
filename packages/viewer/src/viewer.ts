// The viewer's 3D view: renderer, orthographic camera, trackball controls, lights, and the model under two display
// transforms (the user, 2026-10-24; CLAUDE.md, "The viewer"):
//
//   scene -> display (the centring translation, once the centroid is known) -> frame (the format's up axis and
//     unit to the world's Z up and millimetres) -> the loaded model's root
//
// The centroid is the centre of the axis-aligned box of all the model's geometry, hidden included, in the world,
// found when loading finishes (for STEP, when the last part is meshed) and fixed from then on (meshing the same file
// again keeps it, as it keeps the view). One model at a time; loading another replaces it, and cancels the meshing of
// the last if it's still going. STEP files are imported and meshed in a worker (import-worker.ts).

import { VIEW_BACKGROUNDS, type Theme } from './theme.ts';
import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { partMesh, type Diagnostic } from 'cad-scene';
import { clipTo, fit, setAspect, setView, type ViewName } from './camera.ts';
import type { CameraState } from './view-state.ts';
import { formatOf, nativeFrame, type Format } from './formats.ts';
import { Frames } from './frames.ts';
import { loadThree, type Source } from './load.ts';
import { NodeModel, type FaceHiding } from './model.ts';
import { pick, type Pick } from './pick.ts';
import { Composer } from './render.ts';
import { AXES, Sections, type SectionSettings } from './section.ts';
import { detectEdges, StepGraph } from './step.ts';
import { FatEdges } from './fat-edges.ts';
import { cadStyle, DEFAULT_RENDER, EDGES, edgeLayer, type RenderSettings } from './style.ts';
import { TriangleEdges } from './triangle-edges.ts';
import type { FromImportWorker, ToImportWorker } from './import-worker.ts';
import type { Meshing, StepEvent } from './step-load.ts';
import { clearCache, defaultSettings, workerCount, type TessellationSettings } from './tessellation.ts';
import { classifyDevice, DEVICE_PROFILES, deviceOverride, deviceSignals, type DeviceClass } from './device.ts';

export interface ModelInfo {
  name: string;
  format: Format;
  /** The world centroid, once loading has finished. */
  centroid?: THREE.Vector3;
  /** STEP: the parts to mesh, and how many are done and failed so far. */
  parts?: { total: number; done: number; failed: number };
  /** STEP: the importer's and the tessellation's diagnostics. */
  diagnostics?: Diagnostic[];
  /** STEP: what meshed it, once done. */
  meshing?: Meshing;
  /** STEP: the meshing settings it was meshed with (the controls' may have changed since, until Mesh again). */
  meshedWith?: MeshedWith;
}

/** The meshing settings that decide a model's meshes. */
export interface MeshedWith {
  backend: TessellationSettings['backend'];
  profile: TessellationSettings['profile'];
  linearDeflection: number;
  angularDeflection: number;
  /** Seconds a part could take (which decides which parts time out). */
  timeout: number;
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

/** What meshing the same model again carries over from the last load. */
interface Kept { centroid?: THREE.Vector3; centered: boolean }

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
  private worker?: Worker;
  private readonly importListeners = new Map<number, (m: FromImportWorker) => void>();
  private abortLoad?: () => void;
  private readonly composer: Composer;
  /** The section planes and their caps. */
  readonly sections: Sections;
  /** Every triangle's edges, when the rendering settings say so. */
  readonly triangleEdges = new TriangleEdges();
  readonly fatEdges = new FatEdges(EDGES);
  private readonly ambient = new THREE.AmbientLight(0xffffff, DEFAULT_RENDER.ambient);
  private readonly headlight = new THREE.DirectionalLight(0xffffff, DEFAULT_RENDER.light);
  /** The rendering settings; apply changes with setRender. */
  /** The device's class as detected (device.ts). */
  readonly detectedDevice: DeviceClass = classifyDevice(deviceSignals());
  /** The class used: detected, or the user's choice; it caps the workers (from the next load). */
  device: DeviceClass = deviceOverride() ?? this.detectedDevice;
  /** The meshing settings: the device's profile at first. */
  settings: TessellationSettings = defaultSettings(DEVICE_PROFILES[this.device]);
  /**
   * Rendering: the defaults, with thin edges on phones and tablets (fat ones, 18 ms a frame against 6-9 thin for the
   * bicycle on an Apple M4, would cost their GPUs more).
   */
  render: RenderSettings = { ...DEFAULT_RENDER, ...(this.device === 'desktop' ? {} : { edgeStyle: 'thin' as const }) };
  /** Progress messages while loading. */
  onStatus?: (text: string) => void;
  /** The node model of the model just shown (its tree, hiding). */
  nodes?: NodeModel;
  /** A new model is shown (its node model is `nodes`). */
  onModel?: (nodes: NodeModel) => void;
  /** Meshes arrived: parts' detail in the node model changed. */
  onMeshes?: () => void;
  /** A click or tap that didn't move the view: what's under it (or nothing), and the keys held. */
  /** A click or tap on the view (where, in client coordinates), and what's under it. */
  onPick?: (hit: Pick | undefined, keys: { add: boolean; clientX: number; clientY: number }) => void;
  /** Whether a world point is cut away (by the section planes): not pickable. */
  clipped?: (p: THREE.Vector3) => boolean;

  /** `pixelRatio`: fixed (deterministic screenshots: ?deterministic), else the screen's, at most 2. */
  constructor(container: HTMLElement, opts: { pixelRatio?: number } = {}) {
    this.container = container;
    // No multisampling: SMAA smooths the composed frame. A stencil buffer, for the section caps.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, stencil: true });
    this.renderer.setPixelRatio(opts.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    this.composer = new Composer(this.renderer, this.scene, this.camera, 1, 1);
    this.sections = new Sections(this.renderer);
    this.clipped = (p) => this.sections.clipped(p);
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(VIEW_BACKGROUNDS.dark);
    this.scene.add(this.ambient);
    // A headlight: the light comes from over the viewer's shoulder, whatever the view.
    this.headlight.position.set(1, 1, 2);
    this.camera.add(this.headlight);
    this.scene.add(this.camera, this.display);
    this.display.add(this.frame);
    this.scene.add(this.sections.group, this.triangleEdges.group, this.fatEdges.group);
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
      this.onPick?.(this.pickAt(e.clientX, e.clientY), { add: e.ctrlKey || e.metaKey || e.shiftKey,
        clientX: e.clientX, clientY: e.clientY });
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
    this.sections.update(this.root ? this.display : undefined, () => this.nodes?.nodes.flatMap((n) =>
      n.kind === 'part' && n.object ? [n.object] : []) ?? []);
    const fat = this.render.edges && this.render.edgeStyle === 'fat';
    if ((this.render.triangleEdges !== 'off' || fat) && this.root) this.display.updateWorldMatrix(true, true);
    this.triangleEdges.update(this.root ? this.display : undefined, this.render.triangleEdges);
    this.fatEdges.update(this.root ? this.display : undefined, fat, this.render.edgeWidth);
    // Fat edges drawn instead of the thin ones, which stay shown (to the camera's layers, which picking follows) for
    // picking.
    if (fat) this.camera.layers.disable(EDGES);
    try {
      this.composer.render();
    } finally {
      if (fat) this.camera.layers.enable(EDGES);
    }
    return this.interacting || this.changed;
  }

  /** Applies rendering settings (shininess and specular to every Phong face in the model, the lights, the caps). */
  setRender(s: RenderSettings): void {
    this.render = { ...s };
    this.composer.set(this.render);
    this.ambient.intensity = s.ambient;
    this.headlight.intensity = s.light;
    this.sections.setStyle(s.capStyle);
    this.sections.setHatchWidth(s.hatchWidth);
    this.display.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if ((o as THREE.Mesh).isMesh) for (const x of Array.isArray(m) ? m : [m]) {
        const p = x as THREE.MeshPhongMaterial;
        if (!p.isMeshPhongMaterial) continue;
        p.shininess = s.shininess;
        p.specular.setScalar(s.specular);
      }
    });
    this.redraw();
  }

  /** Applies section settings. */
  setSections(s: SectionSettings): void {
    this.sections.set(s);
    this.redraw();
  }

  /** The model's drawn meshes changed (hidden or shown): the caps follow at the next draw. */
  drawnChanged(): void {
    this.sections.invalidate();
    this.redraw();
  }

  /** The world box of the whole model, hidden parts included (for the planes' ranges). */
  modelBox(): THREE.Box3 {
    this.display.updateWorldMatrix(true, true);
    return new THREE.Box3().setFromObject(this.frame);
  }

  /** Empties the tessellation cache (IndexedDB, the import worker's, whose next load opens it afresh). */
  async clearCache(): Promise<void> {
    this.worker?.postMessage({ type: 'cancel' } satisfies ToImportWorker);
    await clearCache();
  }

  /** Redraws soon (after any change to the scene). */
  private theme: Theme = 'dark';
  private background: number | undefined;

  /** The view's background for a theme (theme.ts). */
  setTheme(theme: Theme): void {
    this.theme = theme;
    this.applyBackground();
  }

  /** A background of the view's own, whatever the theme (`cad-viewer shot --background`), or undefined: the theme's. */
  setBackground(color: number | undefined): void {
    this.background = color;
    this.applyBackground();
  }

  private applyBackground(): void {
    (this.scene.background as THREE.Color).setHex(this.background ?? VIEW_BACKGROUNDS[this.theme]);
    this.redraw();
  }

  redraw(): void {
    this.frames.request();
  }

  /**
   * Replaces the model with the source's; for STEP, resolves once every part is meshed (or has failed). `keep`: the
   * same model again (meshed again), so the camera stays where it is and the centroid and centring carry over.
   */
  async load(src: Source, opts: { keep?: boolean } = {}): Promise<void> {
    const format = formatOf(src.name);
    if (!format) throw new Error(`unknown format: ${src.name}`);
    const gen = ++this.generation;
    if (this.meshing) {
      // Stop the last load's meshing (wherever it runs), and end its events.
      this.worker?.postMessage({ type: 'cancel' } satisfies ToImportWorker);
      this.meshing = false;
      this.abortLoad?.();
    }
    const keep = opts.keep && this.model ? { centroid: this.model.centroid, centered: this.centered } : undefined;
    if (format === 'step') return this.loadStep(src, gen, keep);
    let root: THREE.Object3D;
    try {
      root = await loadThree(src, format);
    } finally {
      for (const u of src.siblings?.values() ?? []) URL.revokeObjectURL(u);
    }
    if (gen !== this.generation) return;
    detectEdges(root);
    edgeLayer(root);
    if (this.render.cadMaterials) cadStyle(root, this.render.shininess, this.render.specular);
    this.show(root, { name: src.name, format }, undefined, keep);
    this.finished();
    if (!keep) this.zoomAll();
  }

  private show(root: THREE.Object3D, model: ModelInfo, faces?: FaceHiding, keep?: Kept): void {
    this.clear();
    this.root = root;
    this.nodes = new NodeModel(root, faces);
    this.frame.matrix.copy(nativeFrame(model.format, root));
    this.frame.matrix.decompose(this.frame.position, this.frame.quaternion, this.frame.scale);
    this.frame.add(root);
    this.model = model;
    this.moved = !!keep;
    this.triangleEdges.invalidate();
    this.fatEdges.invalidate();
    if (keep?.centroid) {
      model.centroid = keep.centroid;
      this.centered = keep.centered;
      if (keep.centered) this.display.position.copy(keep.centroid).multiplyScalar(-1);
      this.updateBounds();
    }
    this.sections.invalidate();
    this.onModel?.(this.nodes);
  }

  /** A load's events, from the import worker; they end with 'done', an error, or a newer load (`abortLoad`). */
  private events(bytes: Uint8Array, gen: number): AsyncIterable<StepEvent> {
    const queue: StepEvent[] = [];
    let wake: (() => void) | undefined;
    let error: Error | undefined;
    const push = (e: StepEvent) => { queue.push(e); wake?.(); };
    const fail = (e: Error) => { error = e; wake?.(); };
    this.abortLoad = () => wake?.();
    this.importListeners.set(gen, (m) => (m.type === 'error' ? fail(new Error(m.message)) : push(m)));
    const msg: ToImportWorker = { type: 'load', load: gen, bytes, settings: { ...this.settings },
      workers: workerCount(this.device) };
    this.importer().postMessage(msg, [bytes.buffer]);
    const listeners = this.importListeners;
    const latest = () => gen === this.generation;
    return { async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          while (queue.length) {
            const e = queue.shift()!;
            yield e;
            if (e.type === 'done') return;
          }
          if (error) throw error;
          if (!latest()) return;
          await new Promise<void>((r) => { wake = r; });
          wake = undefined;
        }
      } finally {
        listeners.delete(gen);
      }
    } };
  }

  /** The import worker, started when first needed and kept for later files. */
  private importer(): Worker {
    if (!this.worker) {
      const w = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<FromImportWorker>) => this.importListeners.get(e.data.load)?.(e.data);
      w.onerror = (e) => {
        e.preventDefault();
        for (const l of this.importListeners.values()) l({ type: 'error', message: e.message || 'the import worker '
          + 'failed', load: -1 });
      };
      this.worker = w;
    }
    return this.worker;
  }

  private async loadStep(src: Source, gen: number, keep?: Kept): Promise<void> {
    this.onStatus?.(`${src.name}: reading...`);
    // Let the page show that first.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (gen !== this.generation) return;
    // A copy goes (transferred) to the worker; the source keeps its bytes, to be meshed again.
    const bytes = new Uint8Array(src.bytes.slice(0));
    // What it's meshed with: the settings now, which the import worker is given.
    const { backend, profile, linearDeflection, angularDeflection, timeout } = this.settings;
    const meshedWith: MeshedWith = { backend, profile, linearDeflection, angularDeflection, timeout };
    let graph: StepGraph | undefined;
    let model: ModelInfo | undefined;
    let zoomed = false;
    const added = (part: number) => {
      for (const p of graph!.placements.get(part) ?? []) this.nodes?.invalidate(p.group);
      this.sections.invalidate();
      this.triangleEdges.invalidate();
    this.fatEdges.invalidate();
      this.onMeshes?.();
    };
    const progress = () => this.onStatus?.(`${src.name}: meshed ${model!.parts!.done} of ${model!.parts!.total} ` +
      `parts${model!.parts!.failed ? `, ${model!.parts!.failed} failed` : ''}`);
    this.meshing = true;
    try {
      for await (const ev of this.events(bytes, gen)) {
        if (gen !== this.generation) return;
        if (ev.type === 'scene') {
          const scene = ev.scene;
          graph = new StepGraph(scene, src.name, this.render.shininess, this.render.specular);
          const brep = scene.parts.flatMap((p, i) => p.kind === 'brep' && graph!.placements.has(i) ? [i] : []);
          model = { name: src.name, format: 'step', parts: { total: brep.length, done: 0, failed: 0 },
            diagnostics: [...scene.diagnostics], meshedWith };
          this.show(graph.root, model, graph, keep);
          // Parts already meshes or curves need no tessellation.
          for (const i of graph.placements.keys()) {
            if (scene.parts[i]!.kind === 'brep') continue;
            const mesh = partMesh(scene, new Map(), i);
            if (mesh) {
              graph.addMesh(i, mesh);
              added(i);
            }
          }
          progress();
        } else if (ev.type === 'mesh') {
          const mesh = ev.mesh;
          model!.parts!.done++;
          const drawn = !!mesh && mesh.indices.length + (mesh.curvePositions?.length ?? 0) +
            (mesh.points?.length ?? 0) > 0;
          // A part that failed may still come with its faces' outlines (step-load.ts): shown, and counted failed.
          if (mesh && (drawn || mesh.faceOutlines?.length)) {
            graph!.addMesh(ev.part, mesh);
            added(ev.part);
            if (!zoomed && !this.moved) { zoomed = true; this.zoomAll(); }
          }
          if (!drawn) model!.parts!.failed++;
          progress();
        } else {
          model?.diagnostics!.push(...ev.diagnostics);
          if (model && ev.meshing) model.meshing = ev.meshing;
        }
        this.redraw();
      }
    } finally {
      if (gen === this.generation) this.meshing = false;
    }
    if (gen !== this.generation || !model) return;
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
    // The planes move with the model, cutting it where they did.
    const s = this.sections.get();
    for (const a of AXES) s[a].at += shift[a];
    this.sections.set(s);
    this.sections.invalidate();
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

  /** The camera exactly: position, target, up, and the viewport's height in world millimetres. */
  cameraState(): CameraState {
    const c = this.camera;
    return { position: c.position.toArray(), target: this.controls.target.toArray(), up: c.up.toArray(),
      height: (c.top - c.bottom) / c.zoom };
  }

  /** Puts the camera exactly so (the aspect ratio stays the viewport's); no more automatic zooming this load. */
  setCamera(s: CameraState): void {
    const c = this.camera;
    c.position.fromArray(s.position);
    c.up.fromArray(s.up).normalize();
    this.controls.target.fromArray(s.target);
    c.lookAt(this.controls.target);
    c.top = s.height / 2;
    c.bottom = -s.height / 2;
    c.zoom = 1;
    setAspect(c, this.aspect());
    this.moved = true;
    this.redraw();
  }

  /** The view drawn now, as a PNG data URL (drawn and read in one task, so the buffer still holds it). */
  snapshot(): string {
    this.draw();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Looks along one of the world's axes, then zooms all. */
  setView(view: ViewName): void {
    setView(this.camera, this.controls.target, view, visibleBox(this.display), this.aspect());
    this.redraw();
  }
}
