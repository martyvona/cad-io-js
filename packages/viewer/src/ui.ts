// The viewer's controls, in lil-gui (the user, 2026-10-24; CLAUDE.md, "The viewer"): opening a local file or a URL
// (also by dropping files on the page, or ?url= in the page's address), zoom all, the views along the axes,
// centring the model, full screen, the tree panel and hiding; a status line for what's loading and what went wrong.
// Every folder starts closed (the user, 2026-10-25).

import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { VIEWS, type ViewName } from './camera.ts';
import type { Source } from './load.ts';
import { details } from './details.ts';
import { showAbout } from './about.ts';
import { VERSION } from './version.ts';
import { applyTheme, onSystemTheme, themeChoice, type ThemeChoice } from './theme.ts';
import { askUrl } from './dialog.ts';
import { AXES, DEFAULT_SECTIONS, type SectionSettings } from './section.ts';
import { boxOf, Highlighter, instancesOf, nodeForPick, piecesOf, type PickLevel } from './selection.ts';
import { addSideHandle } from './side-handle.ts';
import type { RenderSettings } from './style.ts';
import { DEVICE_PROFILES, setDeviceOverride, type DeviceClass } from './device.ts';
import { defaultSettings, profileSettings } from './tessellation.ts';
import { TreePanel } from './tree-panel.ts';
import { fromFiles, fromUrl, pickFiles, typedUrl } from './sources.ts';
import { visibleBox, type Viewer } from './viewer.ts';

/** What the browser check reaches through `globalThis.ui`. */
export interface Ui {
  panel(): TreePanel | undefined;
  /** The selected nodes. */
  selected(): readonly number[];
  select(ids: readonly number[]): void;
  /** The selection settings. */
  selection: { level: PickLevel; multi: boolean; instances: boolean };
  hideSelected(): void;
  showSelected(): void;
  showAll(): void;
  zoomSelected(): void;
  selectParent(): void;
  /** Selects everything a click could at the pick level: every part, assembly or face, edge and curve shown. */
  selectAll(): void;
  /** The details panel's lines. */
  details(): string[];
  /** Opens a model by URL; resolves with what the browser check's report has (`error` if it failed). */
  /** Loads a model by URL; `fetched`: its bytes already fetched (from `fromUrl`), not fetched again. */
  openUrl(url: string, fetched?: Source): Promise<Record<string, unknown>>;
  /** Opens a model from local files (with a .gltf's .bin), as picked or dropped. */
  openFiles(files: File[]): Promise<Record<string, unknown>>;
  /** The current model's URL, if it came from one. */
  currentUrl(): string | undefined;
  /** Settles once the tree, the highlight and the restored state have caught up with the meshes that arrived. */
  refreshed(): Promise<void>;
  /** The current model's source: its name, bytes and URL (if any). */
  source(): Source | undefined;
  /** These settings take effect through the controls (which follow). */
  setSections(s: SectionSettings): void;
  setRender(r: Partial<RenderSettings>): void;
  setTree(t: { open?: boolean; detail?: boolean }): void;
  /** Centring, once the centroid is known (false if it isn't yet). */
  setCentered(on: boolean): boolean;
  setPickLevel(level: PickLevel): void;
  setInstances(on: boolean): void;
  setHidden(ids: readonly number[], hidden: boolean): void;
  /** The tree panel's state. */
  tree(): { open: boolean; detail: boolean };
  /** No model to open at start: says how to open one. */
  empty(): void;
  /** Says something in the status line. */
  say(text: string, error?: boolean): void;
  /** The view's address, for "Copy link to this view" (set by the automation layer). */
  link?: () => string;
  /** The controls (for the recorder, recorder.ts, and replay). */
  readonly gui: GUI;
  /** What happens, as it happens (for the recorder). */
  onEvent?: (e: UiEvent) => void;
  /** A click at a point of the page (client coordinates), as the view's own click handling does it. */
  pickAt(clientX: number, clientY: number, add: boolean): void;
}

/** What the UI reports as it happens: loads, selections (and where they came from), picks, the status line. */
export type UiEvent =
  | { type: 'load'; url?: string; files?: File[] }
  | { type: 'loaded'; report: Record<string, unknown> }
  | { type: 'select'; source: 'tree' | 'pick' | 'api'; ids: readonly number[] }
  | { type: 'pick'; clientX: number; clientY: number; add: boolean; id?: number; point?: number[] }
  | { type: 'status'; text: string; error: boolean };

/** How long the status line, and the details while nothing is selected, stay after they last changed. */
const HIDE_AFTER = 5000;

/**
 * Shows an element again (fading it out after HIDE_AFTER with no change, by its `faded` class, unless `stay`): call
 * it whenever its content changes (the user, 2026-10-27).
 */
function autoHide(el: HTMLElement): (stay?: boolean) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (stay = false) => {
    clearTimeout(timer);
    el.classList.remove('faded');
    timer = stay ? undefined : setTimeout(() => el.classList.add('faded'), HIDE_AFTER);
  };
}

export function buildUi(viewer: Viewer, status: HTMLElement, treeElement: HTMLElement, detailsElement: HTMLElement):
  Ui {
  const gui = new GUI({ title: `cad-io-js ${VERSION}`.trim() });
  // Where events go (ui.onEvent), usable before `ui` exists (say is called while the controls are being built).
  const hooks: { onEvent?: (e: UiEvent) => void } = {};
  const statusShown = autoHide(status);
  const say = (text: string, error = false) => {
    if (text !== status.textContent) statusShown();
    status.textContent = text;
    status.classList.toggle('error', error);
    hooks.onEvent?.({ type: 'status', text, error });
  };
  const info = { file: '', triangles: '', objects: '' };
  let centered: { enable(on: boolean): unknown; setValue(v: boolean): unknown };
  let last: Source | undefined;
  viewer.onStatus = (text) => say(text);

  // With ?check in the address, what happened goes into the body's data-report for the browser check
  // (test/browser-check.ts), which reads the DOM.
  const check = new URLSearchParams(location.search).has('check');
  const report = (r: object) => { if (check) document.body.dataset.report = JSON.stringify(r); };

  // Meshing again (the same model, other settings) keeps the view: the camera, centring and planes (Viewer.load's
  // `keep`), and the hidden and selected nodes, by their paths, restored as the nodes they name arrive (faces, edges
  // and curves only with their part's mesh); what never arrives (the faces, edges or curves of a part that fails this
  // time) is reported in the status line, its paths in the console. The new tree is expanded as the last was, and
  // scrolled to the same row at its top, again as rows arrive above it, until the user scrolls or clicks in it.
  let restore: { hidden: Set<string>; selected: string[]; pending: string[]; expanded: string[];
    top?: { path: string; offset: number } } | undefined;
  const restoreNodes = () => {
    const nodes = viewer.nodes;
    if (!restore || !nodes) return;
    const hide: number[] = [];
    restore.pending = restore.pending.filter((p) => {
      const id = nodes.find(p);
      if (id !== undefined) hide.push(id);
      return id === undefined;
    });
    if (hide.length) ui.setHidden(hide, true);
    if (!restore.selected.length) return;
    const sel = restore.selected.flatMap((p) => nodes.find(p) ?? []);
    if (sel.length !== selected.length) select(sel, 'api', false);
  };
  const anchorTree = () => {
    const id = restore?.top && viewer.nodes?.find(restore.top.path);
    if (id !== undefined && panel) panel.scrollToRow(id, restore!.top!.offset);
  };
  const open = async (get: () => Promise<Source | undefined>, what: string, keep = false):
    Promise<Record<string, unknown>> => {
    try {
      say(`loading ${what}...`);
      const src = await get();
      if (!src) {
        say('');
        return { cancelled: true };
      }
      const t = performance.now();
      const gen = viewer.nextLoad();
      last = src;
      if (!keep) restore = undefined;
      await viewer.load(src, { keep });
      if (!viewer.latest(gen)) return { superseded: true };
      restoreNodes();
      panel?.refresh();
      anchorTree();
      const lost = restore ? { hidden: restore.pending, selected: restore.selected.filter((p) =>
        viewer.nodes?.find(p) === undefined) } : { hidden: [], selected: [] };
      restore = undefined;
      fitPlanes();
      const s = viewer.stats()!;
      info.file = src.name;
      info.triangles = s.triangles.toLocaleString();
      info.objects = `${s.objects.toLocaleString()} (${s.meshes.toLocaleString()} meshes)`;
      centered.setValue(viewer.isCentered());
      centered.enable(viewer.model?.centroid !== undefined);
      const m = viewer.model!;
      const parts = m.parts ? `; ${m.parts.done - m.parts.failed} of ${m.parts.total} parts meshed` +
        (m.parts.failed ? `, ${m.parts.failed} failed` : '') : '';
      const problems = (m.diagnostics ?? []).filter((d) => d.severity !== 'info').length;
      const counts = [];
      if (lost.hidden.length) counts.push(`${lost.hidden.length} hidden`);
      if (lost.selected.length) counts.push(`${lost.selected.length} selected`);
      const notRestored = counts.length ? `; ${counts.join(' and ')} not found again (in the console)` : '';
      say(`${src.name}: ${((performance.now() - t) / 1000).toFixed(1)} s${parts}` +
        (problems ? `; ${problems} warnings and errors (in the console)` : '') + notRestored);
      if (problems) console.warn(m.diagnostics);
      if (notRestored) console.warn('meshed again, not found again:', lost);
      const box = visibleBox(viewer.display);
      const r: Record<string, unknown> = { name: src.name, seconds: (performance.now() - t) / 1000, parts: m.parts,
        stats: s, centroid: viewer.model?.centroid?.toArray(), box: [box.min.toArray(), box.max.toArray()],
        camera: { top: viewer.camera.top, target: viewer.controls.target.toArray() },
        ...(notRestored ? { notRestored: lost } : {}) };
      report(r);
      hooks.onEvent?.({ type: 'loaded', report: r });
      return r;
    } catch (e) {
      console.error(e);
      say(`${what}: ${(e as Error).message}`, true);
      report({ error: (e as Error).message });
      hooks.onEvent?.({ type: 'loaded', report: { error: (e as Error).message } });
      return { error: (e as Error).message };
    }
  };
  const openFiles = (files: File[]) => files.length ? (hooks.onEvent?.({ type: 'load', files }), open(async () => {
    const src = await fromFiles(files);
    if (!src) throw new Error('no model among the files (.stp, .step, .stpz, .glb, .gltf, .json)');
    return src;
  }, files.map((f) => f.name).join(', '))) : undefined;
  // The view's address to the clipboard (where the page may write it: a secure context), else shown to copy.
  const copyLink = () => {
    const href = ui.link?.();
    if (!href) return;
    const show = () => window.prompt('The link to this view:', href);
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(href).then(
      () => say('link copied'), show);
    else show();
  };
  // A model's URL (fetched here, unless the caller has fetched it already: replay checks its hash first).
  let lastUrl = '';
  const openUrl = (url: string, fetched?: Source) => {
    lastUrl = url;
    hooks.onEvent?.({ type: 'load', url });
    return open(async () => fetched ?? fromUrl(url), url);
  };

  const file = gui.addFolder('File');
  file.add({ open: async () => openFiles(await pickFiles()) }, 'open').name('Open file...');
  // What was typed is shown again next time; what's loaded (and recorded) is the URL it names.
  let lastTyped = '';
  file.add({ load: async () => {
    const typed = await askUrl({ value: lastTyped || lastUrl });
    if (!typed) return;
    lastTyped = typed;
    const url = typedUrl(typed);
    if (url) await openUrl(url);
    else say(`not a URL nor a path within the content root: ${typed}`, true);
  } }, 'load').name('Load URL...');
  file.add({ about: () => showAbout() }, 'about').name('About...');

  const view = gui.addFolder('View');
  view.add({ all: () => viewer.zoomAll() }, 'all').name('Zoom all');
  // Enabled while something is selected.
  const zoomSelected = view.add({ zoom: () => ui.zoomSelected() }, 'zoom').name('Zoom selected').disable();
  view.add({ copy: () => copyLink() }, 'copy').name('Copy link to this view');
  const views = view.addFolder('Look Along an Axis');
  for (const v of Object.keys(VIEWS) as ViewName[]) {
    views.add({ [v]: () => viewer.setView(v) }, v).name(v[0]!.toUpperCase() + v.slice(1));
  }
  centered = view.add({ centered: false }, 'centered').name('Center model')
    .onChange((on: boolean) => {
      viewer.setCentered(on);
      // The planes moved with the model: take their positions, and fit the sliders to where the model is now.
      const moved = viewer.sections.get();
      for (const a of AXES) cut[a].at = moved[a].at;
      fitPlanes();
    }).disable();
  const setTheme = (c: ThemeChoice) => viewer.setTheme(applyTheme(c));
  const full = {
    enter: () => void document.documentElement.requestFullscreen().catch((e: Error) => say(e.message, true)),
    exit: () => void document.exitFullscreen().catch(() => {}),
  };
  const enter = view.add(full, 'enter').name('Enter full screen');
  const exit = view.add(full, 'exit').name('Exit full screen');
  const fullscreen = () => {
    // Disabled where the page can't go full screen (iPhone, some embedded browsers).
    enter.enable(document.fullscreenEnabled && !document.fullscreenElement);
    exit.enable(!!document.fullscreenElement);
    // Leaving full screen, a phone's browser can leave the page scrolled as its toolbar comes back, the top of the
    // view (the details box) under it (the user, 2026-10-27, on a phone): back to the top, once now and once the
    // toolbar has settled.
    if (!document.fullscreenElement) for (const t of [0, 400]) setTimeout(() => window.scrollTo(0, 0), t);
  };
  document.addEventListener('fullscreenchange', fullscreen);
  const theme = { choice: themeChoice() };
  setTheme(theme.choice);
  // Auto follows the system as it changes.
  onSystemTheme(() => { if (theme.choice === 'auto') setTheme('auto'); });
  view.add(theme, 'choice', { Auto: 'auto', Light: 'light', Dark: 'dark' }).name('Theme')
    .onChange((c: ThemeChoice) => setTheme(c));
  fullscreen();

  // Section planes: the sliders span the model's box (with a margin); planes that are off start at its middle. A new
  // model starts with the defaults, every plane off (resetPlanes).
  const cut = viewer.sections.get();
  const sectionFolder = gui.addFolder('Section');
  const sliders = new Map<string, { min(v: number): unknown; max(v: number): unknown; updateDisplay(): unknown }>();
  const recut = () => viewer.setSections(cut);
  for (const a of AXES) {
    sectionFolder.add(cut[a], 'on').name(`Cut along ${a.toUpperCase()}`).onChange(recut);
    sliders.set(a, sectionFolder.add(cut[a], 'at', -100, 100, 0.01).name(`${a.toUpperCase()} position (mm)`)
      .onChange(recut));
    sectionFolder.add(cut[a], 'flip').name(`Flip ${a.toUpperCase()}`).onChange(recut);
  }
  sectionFolder.add(cut, 'caps').name('Caps on closed parts').onChange(recut);
  const resetPlanes = () => {
    const d = DEFAULT_SECTIONS();
    for (const a of AXES) Object.assign(cut[a], d[a]);
    cut.caps = d.caps;
    for (const c of sectionFolder.controllersRecursive()) c.updateDisplay();
    recut();
  };
  const fitPlanes = () => {
    const box = viewer.modelBox();
    if (box.isEmpty()) return;
    const margin = 0.05 * box.getSize(new THREE.Vector3()).length();
    for (const a of AXES) {
      const lo = box.min[a] - margin, hi = box.max[a] + margin;
      if (!cut[a].on) cut[a].at = (box.min[a] + box.max[a]) / 2;
      const s = sliders.get(a)!;
      s.min(lo);
      s.max(hi);
      s.updateDisplay();
    }
    recut();
  };

  const rendering = gui.addFolder('Rendering');
  const look = viewer.render;
  const restyle = () => viewer.setRender(look);
  rendering.add(look, 'ao').name('Ambient occlusion').onChange(restyle);
  rendering.add(look, 'aoIntensity', 0, 10, 0.1).name('AO intensity').onChange(restyle);
  rendering.add(look, 'aoRadius', 4, 128, 1).name('AO radius (pixels)').onChange(restyle);
  rendering.add(look, 'aoQuality', ['Performance', 'Low', 'Medium', 'High', 'Ultra']).name('AO quality')
    .onChange(restyle);
  rendering.add(look, 'smaa').name('Antialiasing (SMAA)').onChange(restyle);
  rendering.add(look, 'edges').name('Edges').onChange(restyle);
  rendering.add(look, 'triangleEdges', { Off: 'off', Selected: 'selected', All: 'all' }).name('Triangle edges')
    .onChange(restyle);
  rendering.add(look, 'shininess', 0, 100, 1).name('Shininess').onChange(restyle);
  rendering.add(look, 'cadMaterials').name('Phong for glTF, three.js (next file)');

  const step = gui.addFolder('B-Rep Meshing');
  const settings = viewer.settings;
  const shown = () => step.controllers.forEach((c) => c.updateDisplay());
  // The device's class (device.ts), detected or chosen: choosing one also sets its profile.
  const device = { choice: (viewer.device === viewer.detectedDevice ? 'auto' : viewer.device) as DeviceClass | 'auto' };
  step.add(device, 'choice', { [`Auto (${viewer.detectedDevice})`]: 'auto', Phone: 'phone', Tablet: 'tablet',
    Desktop: 'desktop' }).name('Device').onChange((c: DeviceClass | 'auto') => {
    setDeviceOverride(c === 'auto' ? undefined : c);
    viewer.device = c === 'auto' ? viewer.detectedDevice : c;
    Object.assign(settings, profileSettings(DEVICE_PROFILES[viewer.device]));
    shown();
  });
  step.add(settings, 'backend', ['occt', 'truck']).name('Backend');
  step.add(settings, 'profile', { Coarse: 'coarse', Medium: 'medium', Fine: 'fine', Custom: 'custom' })
    .name('Profile').onChange((p: typeof settings.profile) => {
      if (p !== 'custom') Object.assign(settings, profileSettings(p));
      shown();
    });
  // Either deflection moved: custom.
  const custom = () => {
    settings.profile = 'custom';
    shown();
  };
  step.add(settings, 'linearDeflection', 0.001, 10).name('Deflection (mm)').onChange(custom);
  step.add(settings, 'angularDeflection', 1, 90).name('Angle (degrees)').onChange(custom);
  step.add(settings, 'cache').name('Cache (IndexedDB)');
  step.add({ reload: () => {
    if (!last) return;
    const nodes = viewer.nodes;
    const hidden = nodes ? nodes.nodes.filter((n) => n.hidden).map((n) => nodes.pathOf(n.id)) : [];
    const top = panel?.topRow();
    restore = { hidden: new Set(hidden), selected: nodes ? selected.map((id) => nodes.pathOf(id)) : [],
      pending: hidden, expanded: nodes && panel ? panel.expanded().map((id) => nodes.pathOf(id)) : [],
      ...(nodes && top ? { top: { path: nodes.pathOf(top.id), offset: top.offset } } : {}) };
    return open(async () => last, last.name, true);
  } }, 'reload').name('Mesh again');
  step.add({ defaults: () => {
    Object.assign(settings, defaultSettings(DEVICE_PROFILES[viewer.device]));
    shown();
  } }, 'defaults').name('Defaults');
  step.add({ clear: () => viewer.clearCache().then(() => say('cache cleared'),
    (e: Error) => say(`cache: ${e.message}`, true)) }, 'clear').name('Clear cache');

  // The tree panel: a new one for each model; refreshed (at most once a frame) as meshes arrive.
  let panel: TreePanel | undefined;
  // The tree is closed until there's a model, then opens, unless the user has closed it (or on narrow screens,
  // phones, where it would cover the view: there it and these controls start closed, over the view when opened).
  const narrow = matchMedia('(max-width: 700px)').matches;
  if (narrow) gui.close();
  const tree = { open: false, detail: false, closedByHand: false };
  const setOpen = (open: boolean) => document.body.classList.toggle('tree-closed', !open);
  addSideHandle(treeElement.parentElement!);
  setOpen(tree.open);
  let openControl: { setValue(v: boolean): unknown } | undefined;
  // The selection: the tree's and the 3D view's, one; highlighted, described, zoomed to.
  let selected: readonly number[] = [];
  const highlighter = new Highlighter();
  const selection = { level: 'part' as PickLevel, multi: false, instances: false, details: false };
  // The objects the highlight covered: a selected part's or face's mesh may arrive after it was selected (always so
  // when meshing again restores the selection: the selection comes back with the tree, the meshes later, each in a
  // new object); it's then highlighted (and described) again.
  let lit: readonly object[] = [];
  const litChanged = (pieces: readonly { object: object }[]) => pieces.length !== lit.length ||
    pieces.some((p, i) => p.object !== lit[i]);
  const highlight = () => {
    const nodes = viewer.nodes;
    lit = [];
    if (!nodes) return highlighter.clear();
    const others = selection.instances ? selected.filter((id) => nodes.nodes[id]!.kind === 'part').flatMap(
      (id) => instancesOf(nodes, id)) : [];
    const pieces = piecesOf(nodes, selected);
    lit = pieces.map((p) => p.object);
    highlighter.apply(pieces, piecesOf(nodes, others));
    viewer.triangleEdges.select(pieces);
    viewer.redraw();
  };
  // The details stay while they describe a selection, and fade as the status line does while there's none.
  const detailsShown = autoHide(detailsElement);
  const describe = () => {
    const was = detailsElement.hidden;
    detailsElement.hidden = !selection.details;
    if (!selection.details || !viewer.nodes) return;
    const text = details(viewer.nodes, selected).join('\n');
    if (text !== detailsElement.textContent || was) detailsShown(selected.length > 0);
    detailsElement.textContent = text;
  };
  /** Sets the selection; from the 3D view (or code), the tree follows. */
  const select = (ids: readonly number[], source: 'tree' | 'pick' | 'api' = 'api', reveal = true) => {
    selected = [...new Set(ids)];
    // A selection made while meshing again replaces the one being restored.
    if (source !== 'api' && restore) restore.selected = [];
    if (source !== 'tree') panel?.select(selected, reveal);
    hooks.onEvent?.({ type: 'select', source, ids: selected });
    zoomSelected.enable(selected.length > 0);
    highlight();
    describe();
  };
  viewer.onModel = (nodes) => {
    panel?.dispose();
    highlighter.clear();
    selected = [];
    viewer.triangleEdges.select([]);
    zoomSelected.disable();
    panel = new TreePanel(treeElement, nodes);
    panel.onSelect = (ids) => select(ids, 'tree');
    if (tree.detail) panel.setDetail(true);
    if (restore) {
      // The file's own hiding gives way to what was hidden before.
      ui.setHidden(nodes.nodes.filter((n) => n.hidden && !restore!.hidden.has(nodes.pathOf(n.id))).map((n) => n.id),
        false);
      panel.setExpanded(restore.expanded.flatMap((p) => nodes.find(p) ?? []));
      restoreNodes();
      anchorTree();
    } else resetPlanes();
    if (!narrow && !tree.closedByHand && !tree.open) openControl?.setValue(true);
    describe();
  };
  let detailControl: { updateDisplay(): unknown; setValue(v: boolean): unknown } | undefined;
  viewer.onPick = (hit, keys) => {
    const nodes = viewer.nodes;
    if (!nodes || !panel) return;
    // Picking faces, edges and curves needs their nodes: the tree shows detail from then on.
    if (selection.level === 'detail' && !nodes.hasDetail()) {
      tree.detail = true;
      panel.setDetail(true);
      detailControl?.updateDisplay();
    }
    const id = hit && nodeForPick(nodes, hit.object, hit.faceIndex, selection.level);
    const add = keys.add || selection.multi;
    hooks.onEvent?.({ type: 'pick', clientX: keys.clientX, clientY: keys.clientY, add, ...(id !== undefined ? { id }
      : {}), ...(hit ? { point: hit.point.toArray() } : {}) });
    if (id === undefined) return add ? undefined : select([], 'pick');
    select(!add ? [id] : selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id], 'pick');
  };
  // Once a frame while meshes arrive; `refreshed` settles after (for cadViewer.idle).
  let refresh = false;
  let refreshed = Promise.resolve();
  viewer.onMeshes = () => {
    if (refresh) return;
    refresh = true;
    let done!: () => void;
    refreshed = new Promise((resolve) => { done = resolve; });
    requestAnimationFrame(() => {
      refresh = false;
      // Settled first, so a throw below can't leave idle() waiting; what awaits it runs after this callback anyway.
      done();
      restoreNodes();
      if (selected.length && viewer.nodes && litChanged(piecesOf(viewer.nodes, selected))) {
        highlight();
        describe();
      }
      panel?.refresh();
      anchorTree();
    });
  };
  // Scrolling or clicking in the tree while meshing again ends keeping its top row.
  for (const e of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) {
    treeElement.addEventListener(e, () => { if (restore) delete restore.top; }, { passive: true });
  }
  // Hiding faces changes materials: the highlight comes off first, and goes back on after.
  const hide = (hidden: boolean, ids: readonly number[] = selected) => {
    if (!panel) return;
    highlighter.clear();
    panel.model.setHidden(ids, hidden);
    viewer.drawnChanged();
    panel.redraw();
    highlight();
    describe();
  };
  const ui: Ui = {
    panel: () => panel,
    selected: () => selected,
    select: (ids) => select(ids),
    selection,
    hideSelected: () => hide(true),
    showSelected: () => hide(false),
    showAll: () => {
      highlighter.clear();
      panel?.model.showAll();
      viewer.drawnChanged();
      panel?.redraw();
      highlight();
      describe();
    },
    zoomSelected: () => {
      if (!viewer.nodes || !selected.length) return viewer.zoomAll();
      viewer.zoomTo(boxOf(piecesOf(viewer.nodes, selected)));
    },
    selectParent: () => {
      const nodes = viewer.nodes;
      if (!nodes) return;
      select(selected.map((id) => nodes.nodes[id]!.parent).filter((p) => p >= 0));
    },
    selectAll: () => {
      const nodes = viewer.nodes;
      if (!nodes || !panel) return;
      // Faces, edges and curves need their nodes, as picking them does.
      if (selection.level === 'detail' && !nodes.hasDetail()) {
        tree.detail = true;
        panel.setDetail(true);
        detailControl?.updateDisplay();
      }
      // What's hidden can't be clicked, so it isn't selected.
      const shown = (id: number) => !nodes.hiddenInTree(id);
      const parts = nodes.nodes.filter((n) => n.kind === 'part' && shown(n.id)).map((n) => n.id);
      const ids = selection.level === 'part' ? parts : selection.level === 'assembly'
        ? parts.map((id) => nodes.nodes[id]!.parent >= 0 ? nodes.nodes[id]!.parent : id)
        : parts.flatMap((id) => nodes.children(id).filter(shown));
      // Not revealed in the tree: that would open every branch.
      select(ids, 'api', false);
    },
    details: () => (viewer.nodes ? details(viewer.nodes, selected) : []),
    openUrl,
    openFiles: async (files) => (await openFiles(files)) ?? { error: 'no files' },
    currentUrl: () => last?.url,
    refreshed: () => refreshed,
    source: () => last,
    setSections: (s) => {
      for (const a of AXES) Object.assign(cut[a], s[a]);
      cut.caps = s.caps;
      for (const c of sectionFolder.controllersRecursive()) c.updateDisplay();
      recut();
    },
    setRender: (r) => {
      Object.assign(look, r);
      for (const c of rendering.controllersRecursive()) c.updateDisplay();
      restyle();
    },
    setTree: (t) => {
      if (t.detail !== undefined && t.detail !== tree.detail) detailControl?.setValue(t.detail);
      if (t.open !== undefined && t.open !== tree.open) openControl?.setValue(t.open);
    },
    setCentered: (on) => {
      if (on && viewer.model?.centroid === undefined) return false;
      if (on !== viewer.isCentered()) centered.setValue(on);
      return true;
    },
    setPickLevel: (level) => {
      selection.level = level;
      for (const c of selFolder.controllersRecursive()) c.updateDisplay();
    },
    setInstances: (on) => {
      selection.instances = on;
      for (const c of selFolder.controllersRecursive()) c.updateDisplay();
      highlight();
    },
    setHidden: (ids, hidden) => hide(hidden, ids),
    tree: () => ({ open: tree.open, detail: tree.detail }),
    empty: () => {
      say('Open a file (or drop one here), or load one by URL');
      report({ empty: true });
    },
    say,
    gui,
    get onEvent() { return hooks.onEvent; },
    set onEvent(f) { hooks.onEvent = f; },
    pickAt: (clientX, clientY, add) => viewer.onPick?.(viewer.pickAt(clientX, clientY), { add, clientX, clientY }),
  };
  const treeFolder = gui.addFolder('Tree');
  openControl = treeFolder.add(tree, 'open').name('Show the tree').onChange((open: boolean) => {
    setOpen(open);
    if (!open && viewer.nodes) tree.closedByHand = true;
  });
  detailControl = treeFolder.add(tree, 'detail').name('Faces, edges, curves')
    .onChange((on: boolean) => panel?.setDetail(on));
  treeFolder.add({ expand: () => panel?.expandAll() }, 'expand').name('Expand all');
  treeFolder.add({ collapse: () => panel?.collapseAll() }, 'collapse').name('Collapse all');
  treeFolder.add(ui, 'hideSelected').name('Hide selected');
  treeFolder.add(ui, 'showSelected').name('Show selected');
  treeFolder.add(ui, 'showAll').name('Show all');

  const selFolder = gui.addFolder('Selection');
  selFolder.add(selection, 'level', { 'Assembly': 'assembly', 'Part': 'part', 'Face, edge, curve': 'detail' })
    .name('Pick');
  selFolder.add(selection, 'multi').name('Multi-select (touch)');
  selFolder.add(selection, 'instances').name('All instances').onChange(highlight);
  selFolder.add(ui, 'selectParent').name('Select parent');
  selFolder.add({ none: () => select([]) }, 'none').name('Select none');
  selFolder.add(ui, 'selectAll').name('Select all');
  selFolder.add(selection, 'details').name('Details').onChange(describe);

  const about = gui.addFolder('Model');
  about.add(info, 'file').name('File').disable().listen();
  about.add(info, 'objects').name('Objects').disable().listen();
  about.add(info, 'triangles').name('Triangles').disable().listen();
  for (const f of gui.foldersRecursive()) f.close();

  // Dropped files, anywhere on the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    void openFiles([...e.dataTransfer?.files ?? []]);
  });

  // Opening ?url= at start is the automation layer's (automation.ts), which then applies the view in the address.
  return ui;
}
