// The viewer driven from outside (the user, 2026-10-25; CLAUDE.md, "The viewer"): `window.cadViewer`, for scripts,
// the browser check, `cad-viewer shot` and the console, and the view carried in the page's address
// (view-state.ts). It works through the UI's operations (ui.ts), so the controls follow whatever it does, and names
// nodes by their paths (model.ts), which stay the same from one load to the next. Its interface is meant to stay
// stable: change it only by adding, and say so in `version`.
//
// At start it opens ?model= if there is one (as Load URL... reads what's typed: a path within the content root, a
// path on the server or a URL, sources.ts; ?url= is the same, for older links), then applies the view in the
// address; `ready` settles after both.

import { sha256 } from 'cad-scene';
import { VIEWS, type ViewName } from './camera.ts';
import { askUrl, showDialog } from './dialog.ts';
import { formatOf } from './formats.ts';
import { AXES, type SectionSettings } from './section.ts';
import { hex, Recorder, RECORDING_FORMAT, replay, type RecordedModel, type Recording, type ReplayOptions,
  type ReplayReport, type Session } from './recorder.ts';
import { nodeForPick } from './selection.ts';
import { contentPath, fromUrl, pickFiles, typedUrl } from './sources.ts';
import type { RenderSettings } from './style.ts';
import type { Ui } from './ui.ts';
import { fromQuery, renderChanges, toQuery, type CameraState, type ViewState } from './view-state.ts';
import type { TessellationSettings } from './tessellation.ts';
import type { MeshedWith, Viewer } from './viewer.ts';

export interface NodeInfo { path: string; kind: string; name: string; hidden: boolean }

/** Everything about the view and the model, as `state()` gives it. */
export interface FullState extends Required<Pick<ViewState, 'camera' | 'centered' | 'caps' | 'pick' | 'instances'
  | 'hidden' | 'selected'>> {
  cut: NonNullable<ViewState['cut']>;
  render: RenderSettings;
  tree: { open: boolean; detail: boolean };
  /** The device's class (device.ts), as detected and as used (the user's choice, if any); and the meshing profile. */
  device: { detected: string; used: string; profile: string };
  /** The meshing settings (B-Rep Meshing's), for the next model meshed. */
  meshing: TessellationSettings;
  /**
   * The model: its file's name and URL (if it came from one), counts, centroid and parts (STEP), and (STEP) the
   * meshing settings it was meshed with.
   */
  model?: { name: string; url?: string; format: string; triangles: number; objects: number; meshes: number;
    centroid?: number[]; parts?: { total: number; done: number; failed: number }; diagnostics: number;
    meshedWith?: MeshedWith };
}

export interface CadViewer {
  /** The interface's version: 1. */
  readonly version: number;
  /** Settles once the start (?model= and the view in the address) is done. */
  readonly ready: Promise<void>;
  /** Opens a model by URL; resolves with its report once it's loaded (STEP: every part meshed), rejects if not. */
  load(url: string): Promise<Record<string, unknown>>;
  /** Resolves once nothing is loading and the last frame wanted has been drawn. */
  idle(): Promise<void>;
  state(): FullState;
  /** Applies a state (what's absent stays as it is); returns what couldn't be applied. */
  apply(state: ViewState): string[];
  /** The view's address: the model's URL (if it came from one) and the state. */
  link(): string;
  /** The nodes, their paths and whether they're hidden (detail too when the tree shows it). */
  nodes(): NodeInfo[];
  select(paths: string[], opts?: { add?: boolean }): string[];
  hide(paths: string[]): string[];
  show(paths: string[]): string[];
  showAll(): void;
  view(name: ViewName): void;
  zoomAll(): void;
  zoomSelected(): void;
  /** What's under a point of the view, given as fractions of its width and height from the top left. */
  pickAt(x: number, y: number): { path: string; point: number[] } | undefined;
  /** The view as a PNG data URL, drawn now. */
  screenshot(): string;
  /** Starts recording (recorder.ts), or stops and returns the recording. */
  record(on: boolean): Recording | undefined;
  /** The recording going on (a copy), else the last one stopped. */
  recording(): Recording | undefined;
  /** Replays a recording in this page; resolves with what diverged. */
  replay(recording: Recording, opts?: ReplayOptions): Promise<ReplayReport>;
}

const VERSION = 1;

export function buildAutomation(viewer: Viewer, ui: Ui, location: Location): CadViewer {
  let busy: Promise<unknown> = Promise.resolve();
  const loadUrl = (url: string) => {
    const p = ui.openUrl(url);
    busy = p;
    return p;
  };

  /** Paths to node ids, and the paths that name nothing. */
  const resolve = (paths: readonly string[]) => {
    const model = viewer.nodes;
    const ids: number[] = [];
    const missing: string[] = [];
    for (const p of paths) {
      const id = model?.find(p);
      if (id === undefined) missing.push(p);
      else ids.push(id);
    }
    return { ids, missing: missing.map((p) => `no node at ${p}`) };
  };

  const state = (): FullState => {
    const model = viewer.nodes;
    const s = viewer.sections.get();
    const cut: FullState['cut'] = {};
    for (const a of AXES) if (s[a].on) cut[a] = { at: s[a].at, flip: s[a].flip };
    const m = viewer.model;
    const stats = viewer.stats();
    return {
      camera: viewer.cameraState() as CameraState, centered: viewer.isCentered(), cut, caps: s.caps,
      render: { ...viewer.render }, tree: ui.tree(),
      device: { detected: viewer.detectedDevice, used: viewer.device, profile: viewer.settings.profile },
      meshing: { ...viewer.settings },
      pick: ui.selection.level, instances: ui.selection.instances,
      // Faces hidden whether or not their nodes exist yet (made on demand).
      hidden: model ? [...new Set([...model.nodes.filter((n) => n.hidden).map((n) => model.pathOf(n.id)),
        ...model.hiddenFacePaths()])] : [],
      selected: model ? ui.selected().map((id) => model.pathOf(id)) : [],
      ...(m && stats ? { model: { name: m.name, url: ui.currentUrl(), format: m.format, triangles: stats.triangles,
        objects: stats.objects, meshes: stats.meshes, centroid: m.centroid?.toArray(), parts: m.parts,
        diagnostics: (m.diagnostics ?? []).filter((d) => d.severity !== 'info').length,
        ...(m.meshedWith ? { meshedWith: { ...m.meshedWith } } : {}) } } : {}),
    };
  };

  const apply = (st: ViewState): string[] => {
    const problems: string[] = [];
    if (st.tree) ui.setTree(st.tree);
    if (st.centered !== undefined && !ui.setCentered(st.centered)) problems.push('centered: no centroid yet');
    if (st.camera) viewer.setCamera(st.camera);
    else if (st.view) viewer.setView(st.view);
    if (st.cut || st.caps !== undefined) {
      const s: SectionSettings = viewer.sections.get();
      if (st.cut) for (const a of AXES) {
        const p = st.cut[a];
        s[a] = p ? { on: true, at: p.at, flip: p.flip } : { ...s[a], on: false };
      }
      if (st.caps !== undefined) s.caps = st.caps;
      ui.setSections(s);
    }
    if (st.render) ui.setRender(st.render);
    if (st.meshing) ui.setMeshing(st.meshing);
    if (st.pick) ui.setPickLevel(st.pick);
    if (st.instances !== undefined) ui.setInstances(st.instances);
    if (st.hidden) {
      // Exactly these hidden: the others shown (the file's hidden ones included, if not listed).
      const { ids, missing } = resolve(st.hidden);
      problems.push(...missing);
      const model = viewer.nodes;
      if (model) {
        const want = new Set(ids);
        ui.setHidden(model.nodes.filter((n) => n.hidden && !want.has(n.id)).map((n) => n.id), false);
        // Hidden faces whose nodes weren't made yet, and not listed.
        const listed = new Set(st.hidden);
        ui.setHidden(resolve(model.hiddenFacePaths().filter((p) => !listed.has(p))).ids, false);
        ui.setHidden(ids, true);
      }
    }
    if (st.selected) {
      const { ids, missing } = resolve(st.selected);
      problems.push(...missing);
      ui.select(ids);
    }
    return problems;
  };

  const link = (): string => {
    const s = state();
    const view: ViewState = { camera: s.camera, centered: s.centered, cut: s.cut, caps: s.caps,
      render: renderChanges(s.render), tree: s.tree, pick: s.pick, instances: s.instances, hidden: s.hidden,
      selected: s.selected };
    const url = new URL(location.pathname, location.origin);
    const from = ui.currentUrl();
    // A model below the content root is linked by its path there, so the link works wherever the viewer is served
    // with that content (the dev server, a deployment's demo models); another from the same server by its path, so
    // the link works however the server is reached.
    if (from) url.searchParams.set('model', contentPath(from) ?? (from.startsWith(location.origin + '/')
      ? from.slice(location.origin.length) : from));
    for (const [k, v] of toQuery(view)) url.searchParams.append(k, v);
    return url.href;
  };

  const start = async () => {
    const params = new URLSearchParams(location.search);
    const { state: st, problems } = fromQuery(params);
    const given = params.get('model') ?? params.get('url');
    if (params.has('model') && params.has('url')) problems.push('model and url both given: url ignored');
    const url = given !== null ? typedUrl(given) : undefined;
    if (given !== null && !url) {
      ui.empty();
      ui.say(`the address: model=${given}: not a URL nor a path within the content root`, true);
      return;
    }
    if (url) {
      const r = await loadUrl(url);
      if (r.error) return;
    } else ui.empty();
    // Recorded (?record began before it) as the call it is, so a replay applies the address's view too.
    if (Object.keys(st).length) recorder.api('apply', [st]);
    problems.push(...apply(st));
    if (problems.length) ui.say(`the address: ${problems.join('; ')}`, true);
  };

  const api: CadViewer = {
    version: VERSION,
    ready: Promise.resolve(),
    load: async (url) => {
      const r = await loadUrl(url);
      if (r.error) throw new Error(String(r.error));
      return r;
    },
    idle: async () => {
      for (let b = busy; ; b = busy) {
        await b.catch(() => {});
        if (b === busy) break;
      }
      await ui.refreshed();
      await viewer.frames.whenIdle();
    },
    state,
    apply,
    link,
    nodes: () => {
      const model = viewer.nodes;
      if (!model) return [];
      const out: NodeInfo[] = [];
      const visit = (id: number) => {
        const n = model.nodes[id]!;
        out.push({ path: model.pathOf(id), kind: n.kind, name: n.name, hidden: n.hidden });
        model.children(id).forEach(visit);
      };
      model.roots.forEach(visit);
      return out;
    },
    select: (paths, opts = {}) => {
      const { ids, missing } = resolve(paths);
      ui.select(opts.add ? [...ui.selected(), ...ids] : ids);
      return missing;
    },
    hide: (paths) => {
      const { ids, missing } = resolve(paths);
      ui.setHidden(ids, true);
      return missing;
    },
    show: (paths) => {
      const { ids, missing } = resolve(paths);
      ui.setHidden(ids, false);
      return missing;
    },
    showAll: () => ui.showAll(),
    view: (name) => {
      if (!(name in VIEWS)) throw new Error(`no view ${name}: one of ${Object.keys(VIEWS).join(', ')}`);
      viewer.setView(name);
    },
    zoomAll: () => viewer.zoomAll(),
    zoomSelected: () => ui.zoomSelected(),
    pickAt: (x, y) => {
      const r = viewer.renderer.domElement.getBoundingClientRect();
      const hit = viewer.pickAt(r.left + x * r.width, r.top + y * r.height);
      const model = viewer.nodes;
      if (!hit || !model) return undefined;
      // As a click names it, at the pick level.
      const id = nodeForPick(model, hit.object, hit.faceIndex, ui.selection.level);
      return id === undefined ? undefined : { path: model.pathOf(id), point: hit.point.toArray() };
    },
    screenshot: () => viewer.snapshot(),
    record: () => undefined,
    recording: () => undefined,
    replay: async () => ({ events: 0, applied: 0, divergences: [] }),
  };
  // Recording: ?record starts it before anything loads; the controls' Recording folder.
  const session: Session = { state: () => ({ ...state() }), link, apply: (s) => apply(s as ViewState),
    idle: () => api.idle(), call: (method, args) => (api[method as keyof CadViewer] as (...a: unknown[]) => unknown)
      .apply(api, args) };
  const recorder = new Recorder(viewer, ui, session);
  // Calls that change the view are recorded (loads are, as loads).
  for (const m of ['select', 'hide', 'show', 'showAll', 'view', 'zoomAll', 'zoomSelected', 'apply'] as const) {
    const f = api[m] as (...a: unknown[]) => unknown;
    (api as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
      recorder.api(m, args);
      return f.apply(api, args);
    };
  }
  let lastRecording: Recording | undefined;
  api.record = (on) => {
    if (on) {
      if (!recorder.recording) recorder.start();
      return undefined;
    }
    lastRecording = recorder.stop() ?? lastRecording;
    return lastRecording;
  };
  api.recording = () => recorder.snapshot() ?? lastRecording;
  api.replay = async (rec, opts) => {
    await busy.catch(() => {});
    return replay(rec, viewer, ui, session, opts);
  };
  addRecordingControls(ui, api, recorder);
  if (new URLSearchParams(location.search).has('record')) recorder.start();
  (api as { ready: Promise<void> }).ready = start();
  ui.link = link;
  return api;
}


const CLOSE = [{ label: 'Close', value: 'close', primary: true }];
const bytesText = (n: number | undefined) => n === undefined ? 'not recorded' : `${n.toLocaleString('en-US')} byte` +
  (n === 1 ? '' : 's');

/**
 * Makes sure the model a recording loaded is open, for replaying it in the page (the user, 2026-10-25): if the model
 * open has the recorded SHA-256 (the hash alone decides), nothing to do; else a dialog names the model (name, size,
 * hash, URL) and offers Open file... and Open URL... (its URL filled in, if it had one). What's picked is hashed
 * before it's loaded: a file with another hash isn't loaded, and an error dialog says both hashes; closing it stops
 * the replay. With no hash recorded (a URL in a recording made before 2026-10-25), any model picked is taken.
 */
async function openRecordedModel(ui: Ui, want: RecordedModel): Promise<boolean> {
  const current = ui.source();
  if (current && want.sha256 && hex(await sha256(new Uint8Array(current.bytes))) === want.sha256) return true;
  const recorded: [string, string][] = [['Name', want.name], ['Size', bytesText(want.size)],
    ['SHA-256', want.sha256 ?? 'not recorded'], ...(want.url ? [['URL', want.url] as [string, string]] : [])];
  // True if the bytes are the recorded model's; else says so (the replay then stops).
  const matches = async (name: string, bytes: ArrayBuffer) => {
    const got = hex(await sha256(new Uint8Array(bytes)));
    if (!want.sha256 || got === want.sha256) return true;
    await showDialog({ title: 'Not the recorded model', error: true, buttons: CLOSE, body: [
      `${name} isn't the model the recording was made with (their SHA-256 hashes differ), so it wasn't loaded and ` +
      'the replay stops.', 'The recording\'s model:', recorded, 'The file opened:',
      [['Name', name], ['Size', bytesText(bytes.byteLength)], ['SHA-256', got]]] });
    return false;
  };
  for (;;) {
    const r = await showDialog({ title: 'Open the recorded model', body: [current ? 'The recording was made with ' +
      'another model than the one open. Open it to replay the recording:' : 'Open the model the recording was ' +
      'made with to replay it:', recorded], buttons: [{ label: 'Open file...', value: 'file', primary: true },
      { label: 'Open URL...', value: 'url' }, { label: 'Cancel', value: 'cancel' }] });
    if (r.button === 'file') {
      const files = await pickFiles();
      if (!files.length) continue;
      // Of several files (a .gltf with its .bin), the model's.
      const model = files.find((f) => formatOf(f.name)) ?? files[0]!;
      if (!(await matches(model.name, await model.arrayBuffer()))) return false;
      return !('error' in ((await ui.openFiles(files)) ?? {}));
    }
    if (r.button === 'url') {
      const typed = await askUrl({ title: 'Open the recorded model by URL', body: [recorded], value: want.url });
      if (!typed) continue;
      const url = typedUrl(typed);
      let src;
      try {
        if (!url) throw new Error(`not a URL nor a path within the content root: ${typed}`);
        src = await fromUrl(url);
      } catch (e) {
        await showDialog({ title: 'Not loaded', error: true, buttons: CLOSE, body: [(e as Error).message] });
        continue;
      }
      if (!(await matches(src.name, src.bytes))) return false;
      return !('error' in await ui.openUrl(url, src));
    }
    return false;
  }
}

/** The controls' Recording folder: record (a switch), download the recording, replay one (opening its model). */
function addRecordingControls(ui: Ui, api: CadViewer, recorder: Recorder): void {
  const folder = ui.gui.addFolder('Recording');
  const state = { on: recorder.recording };
  const toggle = folder.add(state, 'on').name('Record').onChange((on: boolean) => {
    api.record(on);
    ui.say(on ? 'recording' : `recorded ${api.recording()?.events.length ?? 0} events: Download recording`);
  });
  folder.add({ download: () => {
    const rec = api.recording();
    if (!rec) return ui.say('nothing recorded yet', true);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rec, null, 1)], { type: 'application/json' }));
    a.download = `cad-viewer-recording-${rec.started.replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } }, 'download').name('Download recording');
  folder.add({ replay: async () => {
    // The recording alone; its models are opened as it loads them (openRecordedModel).
    const files = await pickFiles();
    if (!files.length) return;
    const f = files[0]!;
    const rec = f.name.toLowerCase().endsWith('.json') ? await f.text().then((t) => JSON.parse(t) as Recording,
      () => undefined) : undefined;
    if (rec?.format !== RECORDING_FORMAT) {
      return void showDialog({ title: 'Not a recording', error: true, buttons: CLOSE, body: [`${f.name} isn't a ` +
        'cad-viewer recording (the .json file that Download recording saves).'] });
    }
    if (recorder.recording) toggle.setValue(false);
    ui.say('replaying...');
    // At the recording's pace, so what happens can be watched; Stop replay ends it.
    const stopping = new AbortController();
    stop.enable();
    stop.object.stop = () => stopping.abort();
    try {
      const r = await api.replay(rec, { openModel: (m) => openRecordedModel(ui, m), realtime: true,
        signal: stopping.signal });
      if (r.aborted === 'stopped') return ui.say(`replay stopped after ${r.applied} of ${r.events} events`);
      if (r.aborted) return ui.say('replay stopped: the recorded model wasn\'t opened', true);
      if (r.divergences.length) console.warn('replay:', r.divergences);
      ui.say(`replayed ${r.applied} of ${r.events} events; ${r.divergences.length ? `${r.divergences.length} ` +
        'divergences (in the console)' : 'as recorded'}`, r.divergences.length > 0);
    } catch (e) {
      ui.say(`replay: ${(e as Error).message}`, true);
    } finally {
      stop.disable();
    }
  } }, 'replay').name('Replay recording...');
  const stop = folder.add({ stop: () => {} }, 'stop').name('Stop replay').disable();
  folder.close();
}
