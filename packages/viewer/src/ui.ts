// The viewer's controls, in lil-gui (the user, 2026-10-24; CLAUDE.md, "The viewer"): opening a local file or a URL
// (also by dropping files on the page, or ?url= in the page's address), zoom all, the views along the axes,
// centring the model, full screen, the tree panel and hiding; a status line for what's loading and what went wrong.

import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { VIEWS, type ViewName } from './camera.ts';
import type { Source } from './load.ts';
import { DEFAULT_SETTINGS } from './tessellation.ts';
import { TreePanel } from './tree-panel.ts';
import { fromFiles, fromUrl, pickFiles } from './sources.ts';
import { visibleBox, type Viewer } from './viewer.ts';

/** What the browser check reaches through `globalThis.ui`. */
export interface Ui {
  panel(): TreePanel | undefined;
  hideSelected(): void;
  showSelected(): void;
  showAll(): void;
}

export function buildUi(viewer: Viewer, status: HTMLElement, treeElement: HTMLElement): Ui {
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
    .onChange((on: boolean) => viewer.setCentered(on)).disable();
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

  const step = gui.addFolder('STEP meshing');
  const settings = viewer.settings;
  step.add(settings, 'backend', ['occt', 'truck']).name('Backend');
  step.add(settings, 'linearDeflection', 0.001, 10).name('Deflection (mm)');
  step.add(settings, 'angularDeflection', 1, 90).name('Angle (degrees)');
  step.add(settings, 'cache').name('Cache (IndexedDB)');
  step.add({ reload: () => last && open(async () => last, last.name) }, 'reload').name('Mesh again');
  step.add({ defaults: () => { Object.assign(settings, DEFAULT_SETTINGS); step.controllers.forEach((c) =>
    c.updateDisplay()); } }, 'defaults').name('Defaults');
  step.add({ clear: () => viewer.tessellation.clearCache().then(() => say('cache cleared'),
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
  viewer.onModel = (nodes) => {
    panel?.dispose();
    panel = new TreePanel(treeElement, nodes);
    if (tree.detail) panel.setDetail(true);
  };
  let refresh = false;
  viewer.onMeshes = () => {
    if (refresh) return;
    refresh = true;
    requestAnimationFrame(() => { refresh = false; panel?.refresh(); });
  };
  const hide = (hidden: boolean) => {
    if (!panel) return;
    panel.model.setHidden(panel.selected(), hidden);
    panel.redraw();
    viewer.redraw();
  };
  const ui: Ui = {
    panel: () => panel,
    hideSelected: () => hide(true),
    showSelected: () => hide(false),
    showAll: () => {
      panel?.model.showAll();
      panel?.redraw();
      viewer.redraw();
    },
  };
  const treeFolder = gui.addFolder('Tree');
  treeFolder.add(tree, 'open').name('Show the tree').onChange(setOpen);
  treeFolder.add(tree, 'detail').name('Faces, edges, curves').onChange((on: boolean) => panel?.setDetail(on));
  treeFolder.add({ expand: () => panel?.expandAll() }, 'expand').name('Expand all');
  treeFolder.add({ collapse: () => panel?.collapseAll() }, 'collapse').name('Collapse all');
  treeFolder.add(ui, 'hideSelected').name('Hide selected');
  treeFolder.add(ui, 'showSelected').name('Show selected');
  treeFolder.add(ui, 'showAll').name('Show all');

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
