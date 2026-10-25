// The viewer driven from outside (the user, 2026-10-25; CLAUDE.md, "The viewer"): `window.cadViewer`, for scripts,
// the browser check, `cad-viewer shot` and the console, and the view carried in the page's address
// (view-state.ts). It works through the UI's operations (ui.ts), so the controls follow whatever it does, and names
// nodes by their paths (model.ts), which stay the same from one load to the next. Its interface is meant to stay
// stable: change it only by adding, and say so in `version`.
//
// At start it opens ?url= if there is one, then applies the view in the address; `ready` settles after both.

import { VIEWS, type ViewName } from './camera.ts';
import { AXES, type SectionSettings } from './section.ts';
import { nodeForPick } from './selection.ts';
import type { RenderSettings } from './style.ts';
import type { Ui } from './ui.ts';
import { fromQuery, renderChanges, toQuery, type CameraState, type ViewState } from './view-state.ts';
import type { Viewer } from './viewer.ts';

export interface NodeInfo { path: string; kind: string; name: string; hidden: boolean }

/** Everything about the view and the model, as `state()` gives it. */
export interface FullState extends Required<Pick<ViewState, 'camera' | 'centered' | 'caps' | 'pick' | 'instances'
  | 'hidden' | 'selected'>> {
  cut: NonNullable<ViewState['cut']>;
  render: RenderSettings;
  tree: { open: boolean; detail: boolean };
  /** The model: its file's name and URL (if it came from one), counts, centroid and parts (STEP). */
  model?: { name: string; url?: string; format: string; triangles: number; objects: number; meshes: number;
    centroid?: number[]; parts?: { total: number; done: number; failed: number }; diagnostics: number };
}

export interface CadViewer {
  /** The interface's version: 1. */
  readonly version: number;
  /** Settles once the start (?url= and the view in the address) is done. */
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
      render: { ...viewer.render }, tree: ui.tree(), pick: ui.selection.level, instances: ui.selection.instances,
      hidden: model ? model.nodes.filter((n) => n.hidden).map((n) => model.pathOf(n.id)) : [],
      selected: model ? ui.selected().map((id) => model.pathOf(id)) : [],
      ...(m && stats ? { model: { name: m.name, url: ui.currentUrl(), format: m.format, triangles: stats.triangles,
        objects: stats.objects, meshes: stats.meshes, centroid: m.centroid?.toArray(), parts: m.parts,
        diagnostics: (m.diagnostics ?? []).filter((d) => d.severity !== 'info').length } } : {}),
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
    // A model from the same server is linked by its path, so the link works wherever the server is reached.
    if (from) url.searchParams.set('url', from.startsWith(location.origin) ? from.slice(location.origin.length)
      : from);
    for (const [k, v] of toQuery(view)) url.searchParams.append(k, v);
    return url.href;
  };

  const start = async () => {
    const params = new URLSearchParams(location.search);
    const { state: st, problems } = fromQuery(params);
    const url = params.get('url');
    if (url) {
      const r = await loadUrl(url);
      if (r.error) return;
    } else ui.empty();
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
  };
  (api as { ready: Promise<void> }).ready = start();
  ui.link = link;
  return api;
}

