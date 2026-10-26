// Recording what someone does in the viewer, to download and replay, so bugs can be reproduced (the user,
// 2026-10-25; CLAUDE.md, "The viewer"). A recording is JSON: when it began, the browser and window, and events, each
// with `t`, milliseconds since it began:
//
//   state    the whole view (automation.ts's state()) and its link: at the start (after a load event for the model
//            already open, if any) and at the end
//   pointer  down, move (while pressed), up, cancel on the view: x and y in CSS pixels from its top left, buttons,
//            modifier keys, pointer type
//   wheel    on the view: x, y, deltaY
//   pick     a click or tap that picked: x, y, whether it added to the selection, the node picked (its path) and the
//            point (world mm), or nothing
//   select   the selection after a change: its paths, and where the change came from (tree, pick, api)
//   control  a control changed (its folder path and value) or a button pressed (no value)
//   camera   the camera at the end of each drag or zoom
//   api      a call through the automation interface (cadViewer.hide, view, apply...): its method and arguments
//   load     a model opened: its URL (with the bytes' size and SHA-256 once loaded), or local files' names, sizes
//            and SHA-256s; loaded: its report
//   resize   the view's size, and the tree panel's width if dragged; status: the status line; error: an error in
//            the page
//
// Replaying applies them in order through the same operations, waiting for the viewer to be idle before each: the
// controls' values and buttons, selections from the tree or the API, loads (local files given again, matched by
// name, size and hash, or, in the page, the model checked by its hash and asked for if it isn't the one open:
// automation.ts), the camera as it was after each drag or zoom (pointer moves themselves can't be replayed
// in the page: the controls capture the pointer), and each pick at its recorded pixel through the view's own
// picking, compared with what was picked then. Divergences are reported: a pick landing elsewhere, a file missing,
// a control gone, an end state that differs. Pointer and wheel events, statuses and errors are kept for reading.

import { sha256 } from 'cad-scene';
import { formatOf } from './formats.ts';
import { nodeForPick } from './selection.ts';
import { setSideWidth, sideWidth } from './side-handle.ts';
import type { Ui, UiEvent } from './ui.ts';
import type { CameraState } from './view-state.ts';
import type { Viewer } from './viewer.ts';

export const RECORDING_FORMAT = 'cad-viewer-recording';

export type RecordedEvent = { t: number } & (
  | { type: 'state'; state: Record<string, unknown>; link: string }
  | { type: 'pointer'; phase: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number; id: number;
    pointerType: string; button: number; buttons: number; mods: string }
  | { type: 'wheel'; x: number; y: number; deltaY: number; deltaMode: number }
  | { type: 'pick'; x: number; y: number; add: boolean; path: string | null; point?: number[] }
  | { type: 'select'; source: 'tree' | 'pick' | 'api'; paths: string[] }
  | { type: 'control'; path: string; value?: unknown }
  | { type: 'camera'; camera: CameraState }
  | { type: 'api'; method: string; args: unknown[] }
  | { type: 'load'; url?: string; size?: number; sha256?: string; files?: { name: string; size: number;
    sha256?: string }[] }
  | { type: 'loaded'; report: Record<string, unknown> }
  | { type: 'resize'; width: number; height: number; side?: number }
  | { type: 'status'; text: string; error: boolean }
  | { type: 'error'; message: string });

/** The tree panel's width, if dragged, as a recording carries it. */
const side = () => {
  const w = sideWidth();
  return w === undefined ? {} : { side: w };
};

/** An event without its time (each member of the union on its own). */
type Untimed<E> = E extends unknown ? Omit<E, 't'> : never;

export interface Recording {
  format: typeof RECORDING_FORMAT;
  version: 1;
  /** When it began (ISO 8601). */
  started: string;
  userAgent: string;
  /** The page's address when it began. */
  page: string;
  /** The window (CSS pixels) and device pixels per CSS pixel; the view's size. */
  window: { width: number; height: number; scale: number };
  view: { width: number; height: number };
  /** The tree panel's width as dragged (side-handle.ts); absent, the default. Replay sets it (the view as wide). */
  side?: number;
  events: RecordedEvent[];
}

/** What the recorder and replay need of the automation layer. */
export interface Session {
  state(): Record<string, unknown> & { selected: string[] };
  link(): string;
  apply(state: Record<string, unknown>): string[];
  idle(): Promise<void>;
  /** Calls an automation method again (replaying an `api` event). */
  call(method: string, args: unknown[]): unknown;
}

/** Controls whose changes aren't recorded (the recorder's own), and those replay leaves alone. */
const UNRECORDED = /^Recording\//;
const NOT_REPLAYED = /^(File\/|View\/Copy link|View\/(Enter|Exit) full screen|STEP meshing\/Clear cache)/;

interface Controller {
  _name: string;
  parent: { _title: string; parent?: unknown };
  domElement: HTMLElement;
  object: object;
  property: string;
  getValue(): unknown;
  setValue(v: unknown): unknown;
  $button?: HTMLElement;
}

/** A control's path: its folders' titles below the top, then its name (`Section/Cut along X`). */
export function controlPath(c: Controller): string {
  const names = [c._name];
  for (let p = c.parent as { _title: string; parent?: unknown } | undefined; p?.parent; p = p.parent as typeof p) {
    names.unshift(p._title);
  }
  return names.join('/');
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class Recorder {
  private readonly viewer: Viewer;
  private readonly ui: Ui;
  private readonly session: Session;
  private rec?: Recording;
  private t0 = 0;
  /** Pointers pressed on the view (moves are kept only while pressed). */
  private readonly pressed = new Set<number>();

  constructor(viewer: Viewer, ui: Ui, session: Session) {
    this.viewer = viewer;
    this.ui = ui;
    this.session = session;
    const canvas = viewer.renderer.domElement;
    const at = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const mods = (e: MouseEvent) => (e.ctrlKey ? 'c' : '') + (e.shiftKey ? 's' : '') + (e.altKey ? 'a' : '') +
      (e.metaKey ? 'm' : '');
    const pointer = (phase: 'down' | 'move' | 'up' | 'cancel') => (e: PointerEvent) => {
      if (phase === 'down') this.pressed.add(e.pointerId);
      else if (phase === 'move' && !this.pressed.has(e.pointerId)) return;
      else if (phase !== 'move') this.pressed.delete(e.pointerId);
      this.push({ type: 'pointer', phase, ...at(e), id: e.pointerId, pointerType: e.pointerType, button: e.button,
        buttons: e.buttons, mods: mods(e) });
    };
    // Capture, so the controls (which capture the pointer and stop nothing) can't hide them.
    canvas.addEventListener('pointerdown', pointer('down'), { capture: true });
    window.addEventListener('pointermove', pointer('move'), { capture: true });
    window.addEventListener('pointerup', pointer('up'), { capture: true });
    window.addEventListener('pointercancel', pointer('cancel'), { capture: true });
    canvas.addEventListener('wheel', (e) => this.push({ type: 'wheel', ...at(e), deltaY: e.deltaY,
      deltaMode: e.deltaMode }), { capture: true, passive: true });
    viewer.controls.addEventListener('end', () => this.push({ type: 'camera', camera: viewer.cameraState() }));
    new ResizeObserver(() => this.push({ type: 'resize', width: canvas.clientWidth, height: canvas.clientHeight,
      ...side() }))
      .observe(canvas);
    // Controls: values when a change is finished, buttons when pressed.
    const gui = ui.gui as unknown as { onFinishChange(f: (e: { controller: Controller; value: unknown }) => void):
      unknown; controllersRecursive(): Controller[]; domElement: HTMLElement };
    gui.onFinishChange(({ controller, value }) => {
      const path = controlPath(controller);
      if (!UNRECORDED.test(path)) this.push({ type: 'control', path, value });
    });
    gui.domElement.addEventListener('click', (e) => {
      const c = gui.controllersRecursive().find((x) => x.$button?.contains(e.target as Node));
      if (c && !UNRECORDED.test(controlPath(c))) this.push({ type: 'control', path: controlPath(c) });
    }, { capture: true });
    const previous = ui.onEvent;
    ui.onEvent = (e) => {
      previous?.(e);
      this.uiEvent(e);
    };
    window.addEventListener('error', (e) => this.push({ type: 'error', message: String(e.message) }));
    window.addEventListener('unhandledrejection', (e) => this.push({ type: 'error',
      message: String((e.reason as Error)?.message ?? e.reason) }));
  }

  get recording(): boolean {
    return this.rec !== undefined;
  }

  start(): void {
    const canvas = this.viewer.renderer.domElement;
    this.t0 = performance.now();
    this.rec = { format: RECORDING_FORMAT, version: 1, started: new Date().toISOString(),
      userAgent: navigator.userAgent, page: location.href,
      window: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
      view: { width: canvas.clientWidth, height: canvas.clientHeight }, ...side(), events: [] };
    // The model already open, as a load, so replay opens it first.
    const src = this.ui.source();
    if (src?.url) {
      this.push({ type: 'load', url: src.url });
      this.hashInto(this.rec.events.at(-1) as { size?: number; sha256?: string }, src.bytes);
    } else if (src) {
      const file: { name: string; size: number; sha256?: string } = { name: src.name, size: src.bytes.byteLength };
      this.push({ type: 'load', files: [file] });
      this.hashInto(file, src.bytes);
    }
    this.push({ type: 'state', state: this.session.state(), link: this.session.link() });
  }

  /** Ends the recording (with the state at the end) and returns it. */
  stop(): Recording | undefined {
    const rec = this.rec;
    if (!rec) return undefined;
    this.push({ type: 'state', state: this.session.state(), link: this.session.link() });
    this.rec = undefined;
    return rec;
  }

  /** A call through the automation interface. */
  api(method: string, args: unknown[]): void {
    this.push({ type: 'api', method, args: structuredClone(args) });
  }

  /** The recording so far (a copy), or the last one stopped. */
  snapshot(): Recording | undefined {
    return this.rec && structuredClone(this.rec);
  }

  /** A model's size at once, and its SHA-256 when hashed (the event is already in its place). */
  private hashInto(into: { size?: number; sha256?: string }, bytes: ArrayBuffer): void {
    into.size = bytes.byteLength;
    void sha256(new Uint8Array(bytes)).then((h) => { into.sha256 = hex(h); });
  }

  private push(e: Untimed<RecordedEvent>): void {
    if (!this.rec) return;
    this.rec.events.push({ t: Math.round((performance.now() - this.t0) * 10) / 10, ...e } as RecordedEvent);
  }

  private uiEvent(e: UiEvent): void {
    if (!this.rec) return;
    const model = this.viewer.nodes;
    const paths = (ids: readonly number[]) => model ? ids.map((id) => model.pathOf(id)) : [];
    if (e.type === 'load') {
      const files = e.files?.map((f) => ({ name: f.name, size: f.size } as { name: string; size: number;
        sha256?: string }));
      this.push({ type: 'load', ...(e.url ? { url: e.url } : {}), ...(files ? { files } : {}) });
      // Hashed meanwhile; the event is already in its place.
      e.files?.forEach((f, k) => void f.arrayBuffer().then((b) => sha256(new Uint8Array(b))).then((h) => {
        files![k]!.sha256 = hex(h);
      }));
    } else if (e.type === 'loaded') {
      // A model loaded by URL: its bytes' size and hash, now that they're here, into its load event.
      const load = this.rec.events.findLast((x) => x.type === 'load');
      const src = this.ui.source();
      if (load?.type === 'load' && load.url && load.size === undefined && src?.url && !e.report.error) {
        this.hashInto(load, src.bytes);
      }
      this.push({ type: 'loaded', report: e.report });
    }
    else if (e.type === 'select') this.push({ type: 'select', source: e.source, paths: paths(e.ids) });
    else if (e.type === 'pick') {
      const r = this.viewer.renderer.domElement.getBoundingClientRect();
      this.push({ type: 'pick', x: e.clientX - r.left, y: e.clientY - r.top, add: e.add,
        path: e.id !== undefined && model ? model.pathOf(e.id) : null, ...(e.point ? { point: e.point } : {}) });
    } else this.push({ type: 'status', text: e.text, error: e.error });
  }
}

/**
 * What a load event opened: the model file's name, size and SHA-256 (as recorded; older recordings of URLs have
 * neither), and its URL if it came from one.
 */
export interface RecordedModel { name: string; size?: number; sha256?: string; url?: string }

/** The model a load event opened (of local files, the one in a model format; the others are its .bin, images). */
export function recordedModel(e: Extract<RecordedEvent, { type: 'load' }>): RecordedModel {
  if (e.url) {
    const name = decodeURIComponent(new URL(e.url, location.href).pathname.split('/').pop() || e.url);
    return { name, url: e.url, ...(e.size !== undefined ? { size: e.size } : {}),
      ...(e.sha256 ? { sha256: e.sha256 } : {}) };
  }
  const f = e.files?.find((x) => formatOf(x.name)) ?? e.files?.[0];
  return f ? { ...f } : { name: '' };
}

export interface ReplayOptions {
  /**
   * Opens each model the recording loads, in place of `files` and `urls` (the page's Replay recording...: the model
   * open already if its hash matches, else asked for in dialogs); false stops the replay, as `aborted`.
   */
  openModel?: (model: RecordedModel, at: string) => Promise<boolean>;
  /** Local files the recording opened, given again (matched by name, size and hash). */
  files?: File[];
  /** URLs to use instead of the recorded ones (or for local files, by name): `{ "part.stp": "/content/part.stp" }`. */
  urls?: Record<string, string>;
  /** Keep the recording's pace (after waiting for the viewer as usual), rather than going as fast as it can. */
  realtime?: boolean;
}

export interface ReplayReport {
  events: number;
  /** Events applied (the others are kept for reading: pointer moves, wheel, statuses...). */
  applied: number;
  divergences: string[];
  /** Why the replay stopped early (`openModel` declined), if it did. */
  aborted?: string;
}

/** Replays a recording in this page (see the file's comment). */
export async function replay(rec: Recording, viewer: Viewer, ui: Ui, session: Session, opts: ReplayOptions = {}):
  Promise<ReplayReport> {
  if (rec?.format !== RECORDING_FORMAT || rec.version !== 1) throw new Error('not a cad-viewer recording (v1)');
  const divergences: string[] = [];
  let applied = 0;
  const canvas = viewer.renderer.domElement;
  // The view's size as recorded, as it changes (the tree opening, the window resized): picks need the same.
  const recorded = { ...rec.view };
  // The tree panel as wide as it was, so the view is (laid out, and the viewer resized, by the next frames).
  const widen = async (side: number | undefined) => {
    setSideWidth(side);
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  };
  await widen(rec.side);
  const gui = ui.gui as unknown as { controllersRecursive(): Controller[] };
  const resolve = (paths: string[]) => paths.map((p) => viewer.nodes?.find(p)).filter((x) => x !== undefined);
  const open = async (e: Extract<RecordedEvent, { type: 'load' }>, at: string) => {
    if (e.url) return ui.openUrl(opts.urls?.[e.url] ?? e.url);
    const wanted = e.files ?? [];
    const byUrl = wanted.map((f) => opts.urls?.[f.name]);
    if (wanted.length && byUrl.every((u) => u)) return ui.openUrl(byUrl[0]!);
    const found: File[] = [];
    for (const f of wanted) {
      const candidates = (opts.files ?? []).filter((g) => g.name === f.name && g.size === f.size);
      let match: File | undefined;
      for (const g of candidates) {
        if (!f.sha256 || hex(await sha256(new Uint8Array(await g.arrayBuffer()))) === f.sha256) { match = g; break; }
      }
      if (match) found.push(match);
      else divergences.push(`${at}: ${f.name} (${f.size} bytes) wasn't given`);
    }
    return found.length ? ui.openFiles(found) : undefined;
  };
  const start = performance.now();
  const last = rec.events.findLastIndex((e) => e.type === 'state');
  for (const [k, e] of rec.events.entries()) {
    await session.idle();
    if (opts.realtime) {
      const wait = e.t - (performance.now() - start);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const at = `event ${k} (${e.type}, ${e.t} ms)`;
    if (e.type === 'load') {
      if (!opts.openModel) await open(e, at);
      else if (!(await opts.openModel(recordedModel(e), at))) {
        return { events: rec.events.length, applied, divergences, aborted: `${at}: the model wasn't opened` };
      }
      applied++;
    } else if (e.type === 'control') {
      if (NOT_REPLAYED.test(e.path)) continue;
      const c = gui.controllersRecursive().find((x) => controlPath(x) === e.path);
      if (!c) { divergences.push(`${at}: no control ${e.path}`); continue; }
      if (c.$button) (c.getValue() as () => void).call(c.object);
      else c.setValue(e.value);
      applied++;
    } else if (e.type === 'api') {
      await session.call(e.method, e.args);
      applied++;
    } else if (e.type === 'select' && e.source === 'tree') {
      // Selections by pick and through the interface come back with their pick and api events.
      ui.select(resolve(e.paths) as number[]);
      applied++;
    } else if (e.type === 'camera') {
      viewer.setCamera(e.camera);
      applied++;
    } else if (e.type === 'resize') {
      Object.assign(recorded, { width: e.width, height: e.height });
      if (e.side !== sideWidth()) await widen(e.side);
    } else if (e.type === 'pick') {
      // What the view's own picking finds at the recorded pixel now, then the click itself.
      if (Math.abs(canvas.clientWidth - recorded.width) > 0.5 || Math.abs(canvas.clientHeight - recorded.height) >
        0.5) divergences.push(`${at}: the view is ${canvas.clientWidth}x${canvas.clientHeight}, recorded ` +
        `${recorded.width}x${recorded.height}: the pick is at the recorded pixel`);
      const r = canvas.getBoundingClientRect();
      const [cx, cy] = [r.left + e.x, r.top + e.y];
      const model = viewer.nodes;
      const hit = viewer.pickAt(cx, cy);
      const id = hit && model ? nodeForPick(model, hit.object, hit.faceIndex, ui.selection.level) : undefined;
      const path = id !== undefined && model ? model.pathOf(id) : null;
      if (path !== e.path) divergences.push(`${at}: at (${e.x.toFixed(1)}, ${e.y.toFixed(1)}) picked ${path ??
        'nothing'}, recorded ${e.path ?? 'nothing'}`);
      ui.pickAt(cx, cy, e.add);
      applied++;
    } else if (e.type === 'state' && k !== last) {
      // The view as it was then (at the start).
      divergences.push(...session.apply(e.state).map((p) => `${at}: ${p}`));
      applied++;
    } else if (e.type === 'state') {
      // The end: the view as it was then.
      await session.idle();
      const now = session.state() as Record<string, unknown>;
      for (const key of ['centered', 'cut', 'caps', 'render', 'tree', 'pick', 'instances', 'hidden', 'selected']) {
        if (JSON.stringify(now[key]) !== JSON.stringify(e.state[key])) divergences.push(
          `the end: ${key} is ${JSON.stringify(now[key])}, recorded ${JSON.stringify(e.state[key])}`);
      }
      const [a, b] = [now.camera, e.state.camera] as CameraState[];
      const far = (x: number[], y: number[], tol: number) => x.some((v, i) => Math.abs(v - y[i]!) > tol);
      const scale = Math.max(1e-9, b!.height);
      if (far(a!.position, b!.position, 1e-6 * scale) || far(a!.target, b!.target, 1e-6 * scale) ||
        far(a!.up, b!.up, 1e-6) || Math.abs(a!.height - b!.height) > 1e-6 * scale) {
        divergences.push(`the end: the camera is ${JSON.stringify(a)}, recorded ${JSON.stringify(b)}`);
      }
      applied++;
    }
  }
  return { events: rec.events.length, applied, divergences };
}
