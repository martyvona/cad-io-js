// The viewer's controls, in lil-gui (the user, 2026-10-24; CLAUDE.md, "The viewer"): opening a local file or a URL
// (also by dropping files on the page, or ?url= in the page's address), zoom all, the views along the axes,
// centring the model, full screen, the tree panel and hiding; a status line for what's loading and what went wrong.

import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { VIEWS, type ViewName } from './camera.ts';
import type { Source } from './load.ts';
import { details } from './details.ts';
import { AXES } from './section.ts';
import { boxOf, Highlighter, instancesOf, nodeForPick, piecesOf, type PickLevel } from './selection.ts';
import { DEFAULT_SETTINGS } from './tessellation.ts';
import { TreePanel } from './tree-panel.ts';
import { fromFiles, fromUrl, pickFiles } from './sources.ts';
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
  /** The details panel's lines. */
  details(): string[];
}

export function buildUi(viewer: Viewer, status: HTMLElement, treeElement: HTMLElement, detailsElement: HTMLElement):
  Ui {
  const gui = new GUI({ title: 'cad-viewer' });
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  const info = { file: '', triangles: '', objects: '', url: '' };
  let centered: { enable(on: boolean): unknown; setValue(v: boolean): unknown };
  let last: Source | undefined;
  viewer.onStatus = (text) => say(text);

  // With ?check in the address, what happened goes into the body's data-report for the browser check
  // (test/browser-check.ts), which reads the DOM.
  const check = new URLSearchParams(location.search).has('check');
  const report = (r: object) => { if (check) document.body.dataset.report = JSON.stringify(r); };

  const open = async (get: () => Promise<Source | undefined>, what: string) => {
    try {
      say(`loading ${what}...`);
      const src = await get();
      if (!src) return say('');
      const t = performance.now();
      const gen = viewer.nextLoad();
      last = src;
      await viewer.load(src);
      if (!viewer.latest(gen)) return;
      fitPlanes();
      const s = viewer.stats()!;
      info.file = src.name;
      info.triangles = s.triangles.toLocaleString();
      info.objects = `${s.objects.toLocaleString()} (${s.meshes.toLocaleString()} meshes)`;
      centered.setValue(false);
      centered.enable(viewer.model?.centroid !== undefined);
      const m = viewer.model!;
      const parts = m.parts ? `; ${m.parts.done - m.parts.failed} of ${m.parts.total} parts meshed` +
        (m.parts.failed ? `, ${m.parts.failed} failed` : '') : '';
      const problems = (m.diagnostics ?? []).filter((d) => d.severity !== 'info').length;
      say(`${src.name}: ${((performance.now() - t) / 1000).toFixed(1)} s${parts}` +
        (problems ? `; ${problems} warnings and errors (in the console)` : ''));
      if (problems) console.warn(m.diagnostics);
      const box = visibleBox(viewer.display);
      report({ name: src.name, seconds: (performance.now() - t) / 1000, parts: m.parts, stats: s,
        centroid: viewer.model?.centroid?.toArray(), box: [box.min.toArray(),
        box.max.toArray()], camera: { top: viewer.camera.top, target: viewer.controls.target.toArray() } });
    } catch (e) {
      console.error(e);
      say(`${what}: ${(e as Error).message}`, true);
      report({ error: (e as Error).message });
    }
  };
  const openFiles = (files: File[]) => files.length ? open(async () => {
    const src = await fromFiles(files);
    if (!src) throw new Error('no model among the files (.stp, .step, .stpz, .glb, .gltf, .json)');
    return src;
  }, files.map((f) => f.name).join(', ')) : undefined;
  const openUrl = (url: string) => open(() => fromUrl(url), url);

  const file = gui.addFolder('File');
  file.add({ open: async () => openFiles(await pickFiles()) }, 'open').name('Open file...');
  file.add(info, 'url').name('URL').listen();
  file.add({ load: () => info.url && openUrl(info.url) }, 'load').name('Load URL');

  const view = gui.addFolder('View');
  view.add({ all: () => viewer.zoomAll() }, 'all').name('Zoom all');
  const views = view.addFolder('Look along an axis');
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
  };
  document.addEventListener('fullscreenchange', fullscreen);
  fullscreen();

  // Section planes: the sliders span the model's box (with a margin); planes that are off start at its middle.
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
  sectionFolder.close();
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
  rendering.add(look, 'shininess', 0, 100, 1).name('Shininess').onChange(restyle);
  rendering.add(look, 'cadMaterials').name('Phong for glTF, three.js (next file)');
  rendering.close();

  const step = gui.addFolder('STEP meshing');
  const settings = viewer.settings;
  step.add(settings, 'backend', ['occt', 'truck']).name('Backend');
  step.add(settings, 'linearDeflection', 0.001, 10).name('Deflection (mm)');
  step.add(settings, 'angularDeflection', 1, 90).name('Angle (degrees)');
  step.add(settings, 'cache').name('Cache (IndexedDB)');
  step.add(viewer, 'importInWorker').name('Import in a worker');
  step.add({ reload: () => last && open(async () => last, last.name) }, 'reload').name('Mesh again');
  step.add({ defaults: () => { Object.assign(settings, DEFAULT_SETTINGS); step.controllers.forEach((c) =>
    c.updateDisplay()); } }, 'defaults').name('Defaults');
  step.add({ clear: () => viewer.clearCache().then(() => say('cache cleared'),
    (e: Error) => say(`cache: ${e.message}`, true)) }, 'clear').name('Clear cache');
  step.close();

  // The tree panel: a new one for each model; refreshed (at most once a frame) as meshes arrive.
  let panel: TreePanel | undefined;
  // Narrow screens (phones): the tree and these controls start closed, over the view when opened.
  const narrow = matchMedia('(max-width: 700px)').matches;
  if (narrow) gui.close();
  const tree = { open: !narrow, detail: false };
  const setOpen = (open: boolean) => document.body.classList.toggle('tree-closed', !open);
  setOpen(tree.open);
  // The selection: the tree's and the 3D view's, one; highlighted, described, zoomed to.
  let selected: readonly number[] = [];
  const highlighter = new Highlighter();
  const selection = { level: 'part' as PickLevel, multi: false, instances: false, details: false };
  const highlight = () => {
    const nodes = viewer.nodes;
    if (!nodes) return highlighter.clear();
    const others = selection.instances ? selected.filter((id) => nodes.nodes[id]!.kind === 'part').flatMap(
      (id) => instancesOf(nodes, id)) : [];
    highlighter.apply(piecesOf(nodes, selected), piecesOf(nodes, others));
    viewer.redraw();
  };
  const describe = () => {
    detailsElement.hidden = !selection.details;
    if (selection.details && viewer.nodes) detailsElement.textContent = details(viewer.nodes, selected).join('\n');
  };
  /** Sets the selection; from the 3D view (or code), the tree follows. */
  const select = (ids: readonly number[], fromTree = false) => {
    selected = [...new Set(ids)];
    if (!fromTree) panel?.select(selected);
    highlight();
    describe();
  };
  viewer.onModel = (nodes) => {
    panel?.dispose();
    highlighter.clear();
    selected = [];
    panel = new TreePanel(treeElement, nodes);
    panel.onSelect = (ids) => select(ids, true);
    if (tree.detail) panel.setDetail(true);
    describe();
  };
  let detailControl: { updateDisplay(): unknown } | undefined;
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
    if (id === undefined) return add ? undefined : select([]);
    select(!add ? [id] : selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };
  let refresh = false;
  viewer.onMeshes = () => {
    if (refresh) return;
    refresh = true;
    requestAnimationFrame(() => { refresh = false; panel?.refresh(); });
  };
  // Hiding faces changes materials: the highlight comes off first, and goes back on after.
  const hide = (hidden: boolean) => {
    if (!panel) return;
    highlighter.clear();
    panel.model.setHidden(selected, hidden);
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
    details: () => (viewer.nodes ? details(viewer.nodes, selected) : []),
  };
  const treeFolder = gui.addFolder('Tree');
  treeFolder.add(tree, 'open').name('Show the tree').onChange(setOpen);
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
  selFolder.add(ui, 'zoomSelected').name('Zoom selected');
  selFolder.add(selection, 'details').name('Details').onChange(describe);

  const about = gui.addFolder('Model');
  about.add(info, 'file').name('File').disable().listen();
  about.add(info, 'objects').name('Objects').disable().listen();
  about.add(info, 'triangles').name('Triangles').disable().listen();

  // Dropped files, anywhere on the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    void openFiles([...e.dataTransfer?.files ?? []]);
  });

  const start = new URLSearchParams(location.search).get('url');
  if (start) {
    info.url = start;
    void openUrl(start);
  } else {
    say('Open a file (or drop one here), or load one by URL');
    report({ empty: true });
  }
  return ui;
}
