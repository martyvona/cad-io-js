// The viewer's 3D view: renderer, orthographic camera, trackball controls, lights, and the model (the user,
// 2026-10-24; CLAUDE.md, "The viewer"):
//
//   scene -> display (the model's place in the scene, kept from one model to the next) -> the model's root (its
//     scene graph, scene-graph.ts, in the world's millimetres and Z up whatever the format: the importers convert)
//
// One model at a time; loading another replaces it, and cancels the meshing of the last if it's still going. Every
// format is imported (and STEP meshed) in a worker (import-worker.ts), through the library's importers into the scene
// model (the user, 2026-10-29: one path for every format). Zoom all, zoom selected and the views fly the camera
// there, eased over a second (the user, 2026-10-30); zooming while a model loads doesn't (load-fit.ts).

import { VIEW_BACKGROUNDS, type Theme } from './theme.ts';
import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { around, chooseLod, meshDeflections, type Diagnostic, type Mesh, type Vec3 } from 'cad-scene';
import { clipTo, fitCamera, fitSphere, interpolateCamera, setAspect, smoothstep, viewCamera, VIEWS,
  type ViewName } from './camera.ts';
import type { CameraState } from './view-state.ts';
import { formatOf, type Format } from './formats.ts';
import { Frames } from './frames.ts';
import { NodeModel, type Looks } from './model.ts';
import { hitsAlong, pick, type Pick } from './pick.ts';
import { Composer } from './render.ts';
import { Sections, type SectionSettings } from './section.ts';
import { SceneGraph } from './scene-graph.ts';
import { FatEdges } from './fat-edges.ts';
import { LoadFit } from './load-fit.ts';
import { DEPTH_BIAS_DEFLECTIONS, DEPTH_BIAS_PIXELS, depthBias } from './depth-bias.ts';
import { modelInput, type Source } from './sources.ts';
import { DEFAULT_RENDER, EDGES, type RenderSettings } from './style.ts';
import { TriangleEdges } from './triangle-edges.ts';
import type { FromImportWorker, ToImportWorker } from './import-worker.ts';
import type { Meshing, ModelEvent, ModelInput } from './model-load.ts';
import type { ImportProgress } from 'step-import';
import { clearCache, defaultSettings, deflectionsOf, workerCount, type TessellationSettings } from './tessellation.ts';
import { classifyDevice, DEVICE_PROFILES, deviceOverride, deviceSignals, type DeviceClass } from './device.ts';

export interface ModelInfo {
  name: string;
  format: Format;
  /** The B-rep parts to mesh (none but in STEP), and how many are done and failed so far. */
  parts?: { total: number; done: number; failed: number };
  /** The importer's and the tessellation's diagnostics. */
  diagnostics?: Diagnostic[];
  /** What meshed it, once done (none without B-rep parts). */
  meshing?: Meshing;
  /** The meshing settings it was meshed with (the controls' may have changed since, until Mesh again). */
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
  /** How tessellated geometry was read (by us, or meshed by the backend). */
  tessellated: TessellationSettings['tessellated'];
}

/** How long zoom all, zoom selected and the views take to get there, in milliseconds. */
export const FLIGHT_MS = 1000;

/** Wheel events further apart than this begin a new zoom gesture (a new orbit centre at the cursor). */
export const ZOOM_GESTURE_MS = 300;

/** How long the page works on a load's meshes before letting the browser draw and answer (ms). */
export const SLICE_MS = 30;

/** A touchpad pinch's zoom: e^(this x the wheel's pixels). */
export const PINCH_ZOOM = 0.01;

export interface Stats { objects: number; meshes: number; triangles: number; segments: number; points: number }

const drawable = (o: THREE.Object3D): o is THREE.Mesh | THREE.Line | THREE.Points =>
  (o as THREE.Mesh).isMesh === true || (o as THREE.Line).isLine === true || (o as THREE.Points).isPoints === true;

/** The world box of what's drawn: visible objects whose ancestors are visible too. */
/** An import's phase in the status line: `reading`, `reading its structure`, `making parts, 40 %`, `assembling`. */
export function importPhase(p: ImportProgress): string {
  switch (p.phase) {
    case 'reading': return 'reading';
    case 'structure': return 'reading its structure';
    case 'parts': return `making parts${p.total ? `, ${Math.floor(100 * (p.done ?? 0) / p.total)} %` : ''}`;
    case 'assembly': return 'assembling';
  }
}

export function visibleBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if (drawable(o)) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      part.copy(o.geometry.boundingBox!);
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
    if ((o as THREE.Mesh).isMesh) { s.meshes++; s.triangles += Math.floor(n / 3); }
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
  /** The model's place in the scene: its root's parent. */
  readonly display = new THREE.Group();
  model?: ModelInfo;
  /** The model's scene graph (its parts' meshes and materials), once the scene has come. */
  graph?: SceneGraph;
  private root?: THREE.Object3D;
  /** What the near and far planes are kept around (clipTo), in the world: all that's drawn. */
  private bounds = new THREE.Sphere(new THREE.Vector3(), 1);
  /** The model's sphere (zoom all fits it), and zooming to it while it loads (load-fit.ts). */
  private readonly fit = new LoadFit((s) => this.fitWorld(s), () => this.moved);
  private interacting = false;
  /** The model's materials changed (meshes arrived, a model loaded): is anything transparent? (at the next draw) */
  private transparencyStale = true;
  private changed = false;
  /**
   * Zoom all, zoom selected and the views fly the camera there (the user, 2026-10-30): eased by smoothstep over
   * `flightMs` (0: at once), a frame at a time, stopped by the user's own input or a camera set exactly.
   */
  private flight?: { from: CameraState; to: CameraState; start: number };
  flightMs = FLIGHT_MS;
  /** How long the page works on a load's meshes before yielding (SLICE_MS; the browser check shortens it). */
  sliceMs = SLICE_MS;
  private covered = 0;
  /** Where the zoom in progress is about (client pixels), and whether its orbit centre is yet to be found there. */
  private zoomAnchor?: { x: number; y: number; fresh: boolean };
  private lastWheel = -Infinity;
  /** The last wheel events were a touchpad's pinch (ctrl held, as browsers send them). */
  private pinching = false;
  /** The pan, in millimetres along the view's right and up (cameraState's `pan`). */
  private readonly pan = new THREE.Vector2();
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
    this.scene.add(this.sections.group, this.triangleEdges.group, this.fatEdges.group);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1, 1);

    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.rotateSpeed = 4;
    this.controls.staticMoving = true;
    // Our own pan (panBy) in place of TrackballControls': the drag it measured, in pixels (its private state, three.js
    // 0.186, pinned; mouse and two-finger touch alike).
    const tc = this.controls as unknown as { _panStart: THREE.Vector2; _panEnd: THREE.Vector2; _panCamera(): void;
      screen: { width: number; height: number }; _zoomCamera(): void; _zoomStart: THREE.Vector2;
      _zoomEnd: THREE.Vector2; _touchZoomDistanceStart: number; _touchZoomDistanceEnd: number; state: number;
      zoomSpeed: number; minZoom: number; maxZoom: number };
    tc._panCamera = () => {
      const dx = (tc._panEnd.x - tc._panStart.x) * tc.screen.width, dy = (tc._panEnd.y - tc._panStart.y) *
        tc.screen.height;
      tc._panStart.copy(tc._panEnd);
      if (dx || dy) this.panBy(dx, dy);
    };
    // And our own zoom (zoomAt), at the cursor, its factor as the controls reckon it (their state 4 a pinch).
    tc._zoomCamera = () => {
      let factor: number;
      if (tc.state === 4) {
        factor = tc._touchZoomDistanceStart / tc._touchZoomDistanceEnd;
        tc._touchZoomDistanceStart = tc._touchZoomDistanceEnd;
      } else {
        // A touchpad's pinch comes as wheel events with ctrl, a pixel or a few each (the controls' 0.00025 a pixel):
        // eased as pinch zooms are elsewhere, e^(pixels / 100), at most e^0.3 a frame (so ctrl with a mouse wheel's
        // 100-pixel notches isn't a leap); else the controls' own (a mouse wheel's notch about 3 %).
        const d = tc._zoomEnd.y - tc._zoomStart.y;
        factor = this.pinching ? Math.exp(Math.max(-0.3, Math.min(0.3, d / 0.00025 * PINCH_ZOOM)))
          : 1 + d * tc.zoomSpeed;
        tc._zoomStart.copy(tc._zoomEnd);
      }
      if (factor !== 1 && factor > 0) this.zoomAt(factor, tc.minZoom, tc.maxZoom);
    };
    this.controls.addEventListener('start', () => {
      this.interacting = this.moved = true;
      this.flight = undefined;
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
    // Where each zoom gesture begins (zoomAt): a run of wheel (or touchpad) events, a middle-button drag, two fingers
    // down (their midpoint).
    canvas.addEventListener('wheel', (e) => {
      const now = performance.now();
      if (now - this.lastWheel > ZOOM_GESTURE_MS) this.zoomAnchor = { x: e.clientX, y: e.clientY, fresh: true };
      this.lastWheel = now;
      this.pinching = e.ctrlKey;
    });
    const touches = new Map<number, [number, number]>();
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button === 1) this.zoomAnchor = { x: e.clientX, y: e.clientY, fresh: true };
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size !== 2) return;
      const [p, q] = [...touches.values()] as [[number, number], [number, number]];
      this.zoomAnchor = { x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2, fresh: true };
    });
    for (const type of ['pointerup', 'pointercancel'] as const) {
      canvas.addEventListener(type, (e) => touches.delete(e.pointerId));
    }
    // Safari's pinch on a Mac's touchpad (2026-10-31): WebKit's gesture events, not Chrome's wheel events with ctrl,
    // each with the fingers' scale since the gesture began, so zoomed by its change, 1:1 with the fingers, about the
    // point under them. Ctrl-wheel events during one are let go, in case a browser sends both; on iPhone and iPad
    // the gesture comes with two touches, which the controls already zoom by. Page zoom is prevented either way.
    let gestureScale = 0;
    type Gesture = Event & { scale?: number; clientX?: number; clientY?: number };
    canvas.addEventListener('gesturestart', (e: Gesture) => {
      e.preventDefault();
      if (touches.size || !e.scale) return;
      gestureScale = e.scale;
      this.zoomAnchor = { x: e.clientX ?? 0, y: e.clientY ?? 0, fresh: true };
      this.moved = true;
      this.flight = undefined;
    });
    canvas.addEventListener('gesturechange', (e: Gesture) => {
      e.preventDefault();
      if (!gestureScale || touches.size || !e.scale) return;
      const factor = gestureScale / e.scale;
      gestureScale = e.scale;
      this.zoomAt(factor, this.controls.minZoom, this.controls.maxZoom);
      this.frames.request();
    });
    canvas.addEventListener('gestureend', (e) => {
      e.preventDefault();
      gestureScale = 0;
    });
    container.addEventListener('wheel', (e) => {
      if (gestureScale && e.ctrlKey) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, { capture: true, passive: false });

    this.frames = new Frames(() => this.draw());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private aspect(): number {
    return Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
  }

  /**
   * The width zoom all and zoom selected fit in (the user, 2026-10-30): the view less what the controls cover at its
   * right (setCovered), unless that would leave less than half of it (phones, where they cover most of it).
   */
  private freeWidth(): number {
    const w = Math.max(1, this.container.clientWidth);
    return w - this.covered >= w / 2 ? w - this.covered : w;
  }

  /** The aspect ratio fits use: the free width's (freeWidth). */
  fitAspect(): number {
    return this.freeWidth() / Math.max(1, this.container.clientHeight);
  }

  /** The CSS pixels at the view's right that the controls cover, however folded: fits leave them out. */
  setCovered(px: number): void {
    if (px === this.covered) return;
    this.covered = px;
    this.resize();
  }

  /**
   * The projection shifted: by half what the controls cover, so the camera's axis (where the orbit centre is drawn)
   * is at the free width's centre and a fitted model sits centred beside them; and by the pan, in the view's plane
   * (the user, 2026-10-30: panning slides the view, the orbit centre staying where it is on the model). Again before
   * each frame and pick, as the pan is in millimetres and the zoom changes how many pixels that is.
   */
  private shift(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const mmPerPixel = (this.camera.top - this.camera.bottom) / this.camera.zoom / h;
    const x = (w - this.freeWidth()) / 2 - this.pan.x / mmPerPixel, y = this.pan.y / mmPerPixel;
    const v = this.camera.view;
    if (x === 0 && y === 0) {
      if (v?.enabled) this.camera.clearViewOffset();
    } else if (!v?.enabled || v.offsetX !== x || v.offsetY !== y || v.fullWidth !== w || v.fullHeight !== h) {
      this.camera.setViewOffset(w, h, x, y, w, h);
    }
  }

  /**
   * Pans by a drag of `dx`, `dy` CSS pixels (right, down): the view follows the pointer one to one, whatever the zoom
   * (TrackballControls' own pan scaled by the camera's distance, which an orthographic view doesn't show: after zoom
   * selected, a crawl), and the orbit centre stays where it is on the model.
   */
  private panBy(dx: number, dy: number): void {
    const mmPerPixel = (this.camera.top - this.camera.bottom) / this.camera.zoom /
      Math.max(1, this.container.clientHeight);
    this.pan.x += dx * mmPerPixel;
    this.pan.y -= dy * mmPerPixel;
    this.shift();
    this.changed = true;
  }

  /**
   * Zooms by `factor` (the view's height times it) at the zoom's anchor (the user, 2026-10-30), the line of sight
   * through it staying under it: when the gesture begins, the orbit centre moves onto that line where something's
   * drawn there (centreAt), the view unchanged; without an anchor, about the orbit centre where it's drawn.
   */
  private zoomAt(factor: number, min = 0, max = Infinity): void {
    const a = this.zoomAnchor;
    if (a?.fresh) {
      a.fresh = false;
      this.centreAt(a.x, a.y);
    }
    const c = this.camera, mmBefore = this.pixelSize(), before = c.zoom;
    c.zoom = Math.min(max, Math.max(min, before / factor));
    // Screen distances from the anchor scale by k; the pan (where the orbit centre is drawn, from the free width's
    // centre, in pixels: right and up) with them, about the anchor.
    const k = c.zoom / before, panPx = this.pan.clone().divideScalar(mmBefore);
    const r = this.renderer.domElement.getBoundingClientRect();
    const anchor = a ? new THREE.Vector2(a.x - (r.left + this.freeWidth() / 2), -(a.y - (r.top + r.height / 2)))
      : panPx.clone();
    this.pan.copy(anchor.addScaledVector(panPx.sub(anchor), k)).multiplyScalar(mmBefore / k);
    c.updateProjectionMatrix();
    this.shift();
    this.changed = true;
  }

  /**
   * Moves the orbit centre onto the line of sight through a point of the view (client pixels), leaving the view as it
   * is: the nearest of what's drawn along it (hitsAlong; the user, 2026-10-31, first midway between the nearest and
   * the farthest), or with nothing there, the orbit centre left where it is (the user, 2026-10-31, first moved onto
   * the line).
   */
  centreAt(clientX: number, clientY: number): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height * 2 - 1));
    this.display.updateWorldMatrix(true, true);
    this.shift();
    clipTo(this.camera, this.bounds);
    const { hits } = hitsAlong(this.camera, this.display, ndc, this.pixelSize(), this.clipped,
      (q) => this.sections.capHits(q));
    if (hits.length) this.orbitAbout(hits[0]!.point);
  }

  /**
   * Makes a world point the orbit centre, leaving the view as it is: the camera moved with the target, the pan
   * keeping the point drawn where it is (zooming at the cursor; a pick, the user, 2026-10-31).
   */
  orbitAbout(point: THREE.Vector3): void {
    this.flight = undefined;
    this.shift();
    this.camera.updateMatrixWorld();
    const r = this.renderer.domElement.getBoundingClientRect(), q = point.clone().project(this.camera);
    const [x, y] = [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
    const back = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    this.controls.target.copy(point);
    this.camera.position.copy(point).add(back);
    const mmPerPixel = this.pixelSize();
    this.pan.set((x - (r.left + this.freeWidth() / 2)) * mmPerPixel, -(y - (r.top + r.height / 2)) * mmPerPixel);
    this.shift();
    this.redraw();
  }

  private resize(): void {
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.composer.setSize(this.container.clientWidth, this.container.clientHeight, this.renderer.getPixelRatio());
    setAspect(this.camera, this.aspect());
    this.shift();
    this.controls.handleResize();
    this.frames.request();
  }

  private draw(): boolean {
    this.changed = false;
    if (this.transparencyStale) {
      this.transparencyStale = false;
      let any = false;
      this.display.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (!any && m) any = (Array.isArray(m) ? m : [m]).some((x) => x.transparent && x.visible);
      });
      this.composer.setTransparent(any);
    }
    let flying = false;
    if (this.flight) {
      const f = (performance.now() - this.flight.start) / this.flightMs;
      this.place(f >= 1 ? this.flight.to : interpolateCamera(this.flight.from, this.flight.to, smoothstep(f)));
      if (f >= 1) this.flight = undefined;
      else flying = true;
    }
    this.controls.update();
    this.shift();
    clipTo(this.camera, this.bounds);
    depthBias.value = Math.max(this.pixelSize() * DEPTH_BIAS_PIXELS,
      DEPTH_BIAS_DEFLECTIONS * meshDeflections(deflectionsOf(this.settings)).linearDeflection);
    this.sections.update(this.root ? this.display : undefined, () => this.nodes?.nodes.flatMap((n) =>
      n.kind === 'part' && n.object ? [n.object] : []) ?? []);
    const fat = this.render.edges && this.render.edgeStyle === 'fat';
    const tri = this.render.triangleEdges !== 'off' || this.triangleEdgesOverridden;
    if ((tri || fat) && this.root) this.display.updateWorldMatrix(true, true);
    this.triangleEdges.update(this.root ? this.display : undefined, this.render.triangleEdges,
      this.triangleEdgesOverridden);
    this.fatEdges.update(this.root ? this.display : undefined, fat, this.render.edgeWidth);
    // Fat edges drawn instead of the thin ones, which stay shown (to the camera's layers, which picking follows) for
    // picking.
    if (fat) this.camera.layers.disable(EDGES);
    try {
      this.composer.render();
    } finally {
      if (fat) this.camera.layers.enable(EDGES);
    }
    return this.interacting || this.changed || flying;
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

  /** Materials changed (opacity set): transparency looked for again, fat edges' colours follow at the next draw. */
  materialsChanged(): void {
    this.transparencyStale = true;
    this.drawnChanged();
  }

  /** Whether some node's appearance override sets triangle edges (NodeModel.hasTriangleEdges), kept per change. */
  private triangleEdgesOverridden = false;

  /** The appearance overrides changed (model.ts): drawn, materials and triangle edges again. */
  appearanceChanged(): void {
    this.triangleEdgesOverridden = this.nodes?.hasTriangleEdges() ?? false;
    this.triangleEdges.invalidate();
    this.materialsChanged();
  }

  /** The world box of the whole model, hidden parts included (for the planes' ranges). */
  modelBox(): THREE.Box3 {
    this.display.updateWorldMatrix(true, true);
    return new THREE.Box3().setFromObject(this.display);
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
   * same model again (meshed again), so the camera stays where it is.
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
    return this.loadModel(src, format, gen, !!opts.keep && !!this.model);
  }

  private show(root: THREE.Object3D, model: ModelInfo, looks: Looks | undefined, keep: boolean): void {
    this.clear();
    this.root = root;
    this.nodes = new NodeModel(root, looks);
    this.triangleEdgesOverridden = false;
    this.display.add(root);
    this.model = model;
    this.moved = keep;
    // A new model's view starts from the default pose, iso about the origin (the user, 2026-10-30), which the fit
    // while loading then centres and zooms; meshing the same model again keeps the view.
    if (!keep) {
      this.flight = undefined;
      this.controls.target.set(0, 0, 0);
      this.camera.up.set(...VIEWS.iso.up);
      this.camera.position.set(...VIEWS.iso.dir).normalize();
      this.camera.lookAt(this.controls.target);
    }
    this.fit.start();
    this.triangleEdges.invalidate();
    this.fatEdges.invalidate();
    this.transparencyStale = true;
    this.sections.invalidate();
    this.onModel?.(this.nodes);
  }

  /** A load's events, from the import worker; they end with 'done', an error, or a newer load (`abortLoad`). */
  private events(input: ModelInput, gen: number): AsyncIterable<ModelEvent> {
    const queue: ModelEvent[] = [];
    let wake: (() => void) | undefined;
    let error: Error | undefined;
    const push = (e: ModelEvent) => { queue.push(e); wake?.(); };
    const fail = (e: Error) => { error = e; wake?.(); };
    this.abortLoad = () => wake?.();
    this.importListeners.set(gen, (m) => (m.type === 'error' ? fail(new Error(m.message)) : push(m)));
    const msg: ToImportWorker = { type: 'load', load: gen, input, settings: { ...this.settings },
      workers: workerCount(this.device) };
    this.importer().postMessage(msg, [input.bytes.buffer as ArrayBuffer,
      ...Object.values(input.resources ?? {}).map((r) => r.buffer as ArrayBuffer)]);
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

  private async loadModel(src: Source, format: Format, gen: number, keep: boolean): Promise<void> {
    const mb = src.bytes.byteLength / 1e6;
    const importing = `${src.name}: importing${mb >= 1 ? ` ${Math.round(mb)} MB` : ''}`;
    this.onStatus?.(`${importing}...`);
    // Let the page show that first.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (gen !== this.generation) return;
    // A copy goes (transferred) to the worker, a .gltf's buffers with it; the source keeps its bytes, to be meshed
    // again.
    const input = await modelInput(src, format);
    if (gen !== this.generation) return;
    // What it's meshed with: the settings now, which the import worker is given.
    const { backend, profile, linearDeflection, angularDeflection, timeout, tessellated } = this.settings;
    const meshedWith: MeshedWith = { backend, profile, linearDeflection, angularDeflection, timeout, tessellated };
    // (The deflection the worker meshes with, in mm: faces are judged by it against their measures.)
    const meshedAt = meshDeflections(deflectionsOf(this.settings)).linearDeflection;
    let graph: SceneGraph | undefined;
    let model: ModelInfo | undefined;
    const edgesAdded = (part: number) => {
      for (const p of graph!.placements.get(part) ?? []) this.nodes?.invalidate(p.group);
      this.fatEdges.invalidate();
      this.onMeshes?.();
    };
    const added = (part: number, mesh: Mesh) => {
      this.grow(graph!, part, mesh);
      for (const p of graph!.placements.get(part) ?? []) this.nodes?.invalidate(p.group);
      this.sections.invalidate();
      this.triangleEdges.invalidate();
      this.fatEdges.invalidate();
      this.transparencyStale = true;
      this.onMeshes?.();
    };
    // What the load is doing, always (the user, 2026-10-31): meshing, finding edges, or read.
    const edges = { total: 0, done: 0 };
    const progress = () => {
      const p = model!.parts!;
      const meshing = p.total && p.done < p.total ? `meshed ${p.done} of ${p.total} parts${p.failed ? `, ${p.failed} ` +
        'failed' : ''}` : '';
      const finding = edges.done < edges.total ? `found edges for ${edges.done} of ${edges.total} parts` : '';
      this.onStatus?.(`${src.name}: ${[meshing, finding].filter(Boolean).join('; ') || (p.total ? `meshed ${p.done} ` +
        `of ${p.total} parts${p.failed ? `, ${p.failed} failed` : ''}` : 'read')}`);
    };
    let ended: Extract<ModelEvent, { type: 'done' }> | undefined;
    this.meshing = true;
    try {
      for await (const ev of this.events(input, gen)) {
        if (gen !== this.generation) return;
        if (ev.type === 'importing') {
          // STEP's phases (the user, 2026-10-31: a large file said only "importing" for seconds).
          this.onStatus?.(`${importing}: ${importPhase(ev.progress)}...`);
          continue;
        }
        if (ev.type === 'scene') {
          const scene = ev.scene;
          graph = new SceneGraph(scene, src.name, this.render.shininess, this.render.specular);
          const brep = scene.parts.flatMap((p, i) => p.brep && graph!.placements.has(i) ? [i] : []);
          model = { name: src.name, format, parts: { total: brep.length, done: 0, failed: 0 },
            diagnostics: [...scene.diagnostics], meshedWith };
          this.show(graph.root, model, graph, keep);
          this.graph = graph;
          // The model's sphere, the file's or the importer's estimate, fitted before any mesh is drawn.
          this.fit.start(scene.bounds);
          if (!this.fit.sphere.isEmpty()) this.bounds.copy(this.fit.sphere);
          // Parts with a level from the file (every part of a glTF or three.js file, STEP's tessellated geometry)
          // shown at once, the level for these settings (chooseLod); a B-rep part's until ours comes.
          edges.total = ev.edgeParts;
          const wanted = meshDeflections(deflectionsOf(this.settings));
          // In slices of about 30 ms, the page drawing and answering in between (the user, 2026-10-31: LMP1's 1,251
          // parts in one task took a second), the status line counting.
          const parts = [...graph.placements.keys()];
          let slice = performance.now();
          for (const [k, i] of parts.entries()) {
            const lod = chooseLod(scene.parts[i]!, wanted);
            if (lod) {
              graph.addMesh(i, lod.mesh, lod.linearDeflection);
              added(i, lod.mesh);
            }
            if (performance.now() - slice > this.sliceMs && k + 1 < parts.length) {
              this.onStatus?.(`${src.name}: showing ${k + 1} of ${parts.length} parts`);
              this.redraw();
              await new Promise((r) => setTimeout(r, 0));
              if (gen !== this.generation) return;
              slice = performance.now();
            }
          }
          progress();
        } else if (ev.type === 'mesh') {
          const mesh = ev.mesh;
          model!.parts!.done++;
          const drawn = !!mesh && mesh.indices.length + (mesh.curvePositions?.length ?? 0) +
            (mesh.points?.length ?? 0) > 0;
          // A part that failed may still come with its faces' outlines (model-load.ts): shown, and counted failed,
          // unless the file's own tessellation of it is shown, which stays.
          // (Its measures, which the worker's scene gained in meshing, first: the mesh is judged by them.)
          if (ev.measures) graph!.scene.parts[ev.part]!.measures = ev.measures;
          if (mesh && (drawn || (mesh.faceOutlines?.length && !graph!.hasMesh(ev.part)))) {
            graph!.addMesh(ev.part, mesh, meshedAt);
            if (ev.foundEdges) graph!.setFoundEdges(ev.part, ev.foundEdges);
            added(ev.part, mesh);
          }
          if (!drawn) model!.parts!.failed++;
          progress();
        } else if (ev.type === 'edges') {
          // Edges found for a level from the file (model-load.ts), after it was shown.
          if (graph!.setFoundEdges(ev.part, ev.positions).length) edgesAdded(ev.part);
          edges.done++;
          progress();
        } else {
          ended = ev;
          model?.diagnostics!.push(...ev.diagnostics);
          if (model && ev.meshing) model.meshing = ev.meshing;
          // Made again from the meshes alone: it may shrink, for the next zoom all (loading's zooms only go out).
        }
        this.redraw();
      }
    } finally {
      if (gen === this.generation) this.meshing = false;
    }
    if (gen !== this.generation || !model) return;
    this.updateBounds();
    this.fit.end(ended?.bounds);
  }

  /** A part's new mesh grows the clipping sphere and, unless it's the file's, the model's (centres kept). */
  private grow(graph: SceneGraph, part: number, mesh: Mesh): void {
    const own = mesh.box && around({ min: mesh.box.min.map((x, k) => x + mesh.origin[k]!) as Vec3,
      max: mesh.box.max.map((x, k) => x + mesh.origin[k]!) as Vec3 });
    const box = new THREE.Box3();
    for (const p of graph.placements.get(part) ?? []) {
      // (Each placement's own world matrix, up its parents: the whole model's for every part was quadratic.)
      p.group.updateWorldMatrix(true, true);
      // Everything drawn, for the clipping planes: around the mesh's box (all it draws), placed; a mesh without one
      // (only failure outlines) by what's drawn (measuring every geometry anew took a fifth of a second on a large
      // file).
      const placed = own && new THREE.Sphere(new THREE.Vector3(...own.center), own.radius)
        .applyMatrix4(p.group.matrixWorld);
      if (placed) this.bounds.union(placed);
      else if (!box.setFromObject(p.group).isEmpty()) this.bounds.union(box.getBoundingSphere(new THREE.Sphere()));
      if (placed) this.fit.add(placed.clone());
    }
  }

  /** Fits a sphere at once (zooming while loading), ending any flight. */
  private fitWorld(s: THREE.Sphere): void {
    this.flight = undefined;
    this.pan.set(0, 0);
    fitSphere(this.camera, this.controls.target, s, this.aspect(), this.fitAspect());
    this.redraw();
  }

  /** Flies the camera to a state (or puts it there, with `flightMs` 0). */
  private fly(to: CameraState): void {
    if (this.flightMs > 0) this.flight = { from: this.cameraState(), to, start: performance.now() };
    else {
      this.flight = undefined;
      this.place(to);
    }
    this.redraw();
  }

  /** The model's sphere in the world; without one (nothing loaded yet), around what's drawn. */
  modelSphere(): THREE.Sphere {
    if (!this.fit.sphere.isEmpty()) return this.fit.sphere.clone();
    const box = visibleBox(this.display);
    return box.isEmpty() ? new THREE.Sphere().makeEmpty() : box.getBoundingSphere(new THREE.Sphere());
  }

  private clear(): void {
    if (this.root) {
      this.display.remove(this.root);
      dispose(this.root);
    }
    this.root = undefined;
    this.model = undefined;
    this.nodes = undefined;
    this.graph = undefined;
  }

  private updateBounds(): void {
    this.display.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.display);
    if (box.isEmpty()) this.bounds.set(new THREE.Vector3(), 1);
    else box.getBoundingSphere(this.bounds);
  }

  /** The load that `load` was called for is still the latest (it wasn't replaced by another meanwhile). */
  latest(gen: number): boolean {
    return gen === this.generation;
  }

  /** The number the next load will have. */
  nextLoad(): number {
    return this.generation + 1;
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
    // The projection and near plane as the next frame will have them (the camera may have moved since the last),
    // where rays start.
    this.shift();
    clipTo(this.camera, this.bounds);
    return pick(this.camera, this.display, ndc, this.pixelSize(), this.clipped, (r) => this.sections.capHits(r));
  }

  /** Fits a sphere (in the world) in the viewport, from the current direction; zoom all if it's empty. */
  zoomTo(sphere: THREE.Sphere): void {
    if (sphere.isEmpty()) return this.zoomAll();
    this.fly(fitCamera(this.cameraState(), sphere, this.fitAspect()));
  }

  /** Fits the model's sphere in the viewport, from the current direction. */
  zoomAll(): void {
    const s = this.modelSphere();
    if (!s.isEmpty()) this.fly(fitCamera(this.cameraState(), s, this.fitAspect()));
  }

  /** The camera exactly: position, target, up, and the viewport's height in world millimetres. */
  cameraState(): CameraState {
    const c = this.camera;
    return { position: c.position.toArray(), target: this.controls.target.toArray(), up: c.up.toArray(),
      height: (c.top - c.bottom) / c.zoom, ...(this.pan.x || this.pan.y ? { pan: [this.pan.x, this.pan.y] } : {}) };
  }

  /** Puts the camera exactly so (the aspect ratio stays the viewport's); no more automatic zooming this load. */
  setCamera(s: CameraState): void {
    this.flight = undefined;
    this.place(s);
    this.moved = true;
    this.redraw();
  }

  private place(s: CameraState): void {
    const c = this.camera;
    c.position.fromArray(s.position);
    c.up.fromArray(s.up).normalize();
    this.controls.target.fromArray(s.target);
    c.lookAt(this.controls.target);
    c.top = s.height / 2;
    c.bottom = -s.height / 2;
    c.zoom = 1;
    this.pan.set(s.pan?.[0] ?? 0, s.pan?.[1] ?? 0);
    setAspect(c, this.aspect());
    this.shift();
  }

  /** The view drawn now, as a PNG data URL (drawn and read in one task, so the buffer still holds it). */
  snapshot(): string {
    this.draw();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * Looks along one of the world's axes, turning about the orbit centre (zoom and pan kept): flying there, or with
   * `instant` (a link's or a recording's view) at once.
   */
  setView(view: ViewName, opts: { instant?: boolean } = {}): void {
    const to = viewCamera(this.cameraState(), view);
    if (!opts.instant) return this.fly(to);
    this.flight = undefined;
    this.place(to);
    this.redraw();
  }
}
