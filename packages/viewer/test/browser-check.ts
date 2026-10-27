// The viewer in a real browser, which `npm test` can't reach: the STEP assembly itself (imported in the page, meshed
// by OCCT in its workers) and models made from it in each three.js-loadable format (GLB with Draco, glTF with meshopt
// and a .bin beside it, three.js JSON), served by the dev server (cad-viewer start) and opened in headless Chrome
// (?url=...&check). What each page reports is compared with what the scene says, computed here independently of the
// viewer: the triangles, the B-rep edges' segments, and the world box in millimetres with Z up (so each format's
// frame mapping is checked); and centring. Also: a GLB without edges (edges found from its triangles), the page with
// no model, an unknown file, a missing one.
// Run by hand: node packages/viewer/test/browser-check.ts [path to Chrome]   (needs tess-occt built and the corpus;
// SHOTS=<dir> saves a screenshot of each page there; EXTRA=<file>,... also loads those files and prints what the
// page reports, with no expectations; BUILD=1 checks a build instead of the dev server, served below a path,
// /viewer/, by a plain static server, as a build would be deployed; ONLY=<check>,... runs only the checks named)

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import { exportView, partInstances, tessellateScene } from 'cad-scene';
import { glb, gltfJson } from 'export-gltf';
import { threejsJson } from 'export-threejs';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { main } from '../bin/viewer.ts';
import { defaultChrome, launchChrome } from '../server/headless.ts';

const repo = path.resolve(import.meta.dirname, '../../..');
const chrome = process.argv[2] ?? defaultChrome();
const step = path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-viewer-check-'));
const content = path.join(tmp, 'content');
fs.mkdirSync(content);

// The models, and what the scene says they hold.
const { scene } = await importStep(fs.readFileSync(step));
const occt = new OcctTessellator();
await occt.init();
// The viewer's meshing on a desktop (the library's default profile, medium); and on a phone, coarse.
const { meshes } = await tessellateScene(scene, occt, { edges: true });
const placed = [...partInstances(scene)].filter((p) => p.visible);
const coarseTriangles = [...(await tessellateScene(scene, occt, { profile: 'coarse' })).meshes].reduce((s, [part, m]) =>
  s + placed.filter((p) => p.part === part).length * m.indices.length / 3, 0);
occt.dispose();
const view = exportView(scene, meshes, { edges: true });
fs.writeFileSync(path.join(content, 'as1.glb'), (await glb(scene, view)).bytes);
const meshopt = await gltfJson(scene, view, 'as1-meshopt.bin', { compression: 'meshopt' });
fs.writeFileSync(path.join(content, 'as1-meshopt.gltf'), meshopt.json);
fs.writeFileSync(path.join(content, 'as1-meshopt.bin'), meshopt.bin);
fs.writeFileSync(path.join(content, 'as1.json'), threejsJson(scene, view));
fs.writeFileSync(path.join(content, 'as1.json.extras.json'), threejsJson(scene, view, { extras: true }));
fs.writeFileSync(path.join(content, 'as1-noedges.glb'), (await glb(scene, exportView(scene, meshes))).bytes);
// Its parts placed more than once as GPU instances (EXT_mesh_gpu_instancing: three.js InstancedMeshes).
fs.writeFileSync(path.join(content, 'as1-instanced.glb'), (await glb(scene, view, { instancing: true })).bytes);
fs.copyFileSync(step, path.join(content, 'as1.stp'));
// Half transparent everywhere (a copy of the scene's materials at opacity 0.5).
const clear = { ...scene, materials: scene.materials.map((m) => ({ ...m, opacity: 0.5 })) };
fs.writeFileSync(path.join(content, 'as1-clear.glb'), (await glb(clear, exportView(clear, meshes))).bytes);
const bicycle = path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/Median_cx-fs01_bicycle.stp');
fs.copyFileSync(bicycle, path.join(content, 'bicycle.stp'));
// A part in metres (its placement scales by 1000, as every part of a file in metres).
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/r103ec.stp'),
  path.join(content, 'metres.stp'));
fs.writeFileSync(path.join(content, 'notes.txt'), 'not a model');
// A box of 10 x 20 x 30 whose faces are each a primitive of one glTF mesh (three.js: a mesh each, under the node), as
// some CAD systems' glTF files have their parts: closed only as a whole (the caps check).
{
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('box');
  const c = (i: number, n: number) => (i & n ? 1 : 0);
  const corner = (i: number) => [10 * c(i, 1), 20 * c(i, 2), 30 * c(i, 4)];
  // Each face's corners (bit masks of x, y, z), counterclockwise from outside.
  for (const f of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) {
    const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(Float32Array.from(f.flatMap(corner)));
    const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(Uint16Array.from([0, 1, 2, 0, 2,
      3]));
    mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices));
  }
  doc.createScene().addChild(doc.createNode('box').setMesh(mesh));
  fs.writeFileSync(path.join(content, 'faces.glb'), await new NodeIO().writeBinary(doc));
}
// In a directory, with a name that has to be encoded in a URL (the content paths check).
fs.mkdirSync(path.join(content, 'sub dir'));
fs.copyFileSync(path.join(content, 'as1.glb'), path.join(content, 'sub dir', 'as1 #1%.glb'));

let triangles = 0;
let segments = 0;
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (const p of partInstances(scene)) {
  const m = meshes.get(p.part);
  if (!p.visible || !m) continue;
  triangles += m.indices.length / 3;
  for (const e of m.edges ?? []) if (e.kind === 'shared' || e.kind === 'free') segments += e.count - 1;
  const t = p.transform;
  for (let i = 0; i < m.positions.length; i += 3) {
    const [x, y, z] = [0, 1, 2].map((k) => m.positions[i + k]! + m.origin[k]!) as [number, number, number];
    for (let k = 0; k < 3; k++) {
      const w = t[k]! * x + t[4 + k]! * y + t[8 + k]! * z + t[12 + k]!;
      lo[k] = Math.min(lo[k]!, w);
      hi[k] = Math.max(hi[k]!, w);
    }
  }
}

const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});
const io = { out: () => {}, err: (s: string) => process.stderr.write(s), runDir: path.join(tmp, 'run') };
let staticServer: http.Server | undefined;
// Where the app is: the dev server's root, or a build's place on the static server.
const base = process.env.BUILD ? '/viewer/' : '/';
const dist = path.join(tmp, 'dist');
let buildOutput = '';
if (process.env.BUILD) {
  // vite build into the temporary directory, then a static server (no SPA fallback, no special headers, only content
  // types) with the build at /viewer/ and the models at /content/.
  const viewer = path.resolve(import.meta.dirname, '..');
  const vite = path.join(repo, 'node_modules/vite/bin/vite.js');
  const env = { ...process.env, VIEWER_CONTENT_ROOT: content, VIEWER_PORT: String(port) };
  // Its warnings and errors kept, for the build check below (a build should print none).
  await new Promise<void>((resolve, reject) => {
    const b = spawn(process.execPath, [vite, 'build', '--outDir', dist, '--logLevel', 'warn'], { cwd: viewer, env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    for (const s of [b.stdout, b.stderr]) s.on('data', (c) => { buildOutput += c; });
    b.on('exit', (c) => c === 0 ? resolve() : reject(new Error(`vite build failed: ${buildOutput}`)));
  });
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json', '.md': 'text/markdown' };
  staticServer = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    let [dir, rest] = url.startsWith(base) ? [dist, url.slice(base.length)]
      : url.startsWith('/content/') ? [content, url.slice('/content/'.length)] : [undefined, ''];
    // The build's own content root (content/ beside the page, where a deployment puts its demo models) is the same.
    if (dir === dist && rest.startsWith('content/')) [dir, rest] = [content, rest.slice('content/'.length)];
    const file = dir && path.join(dir, rest || 'index.html');
    if (!file || !file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => staticServer!.listen(port, '127.0.0.1', resolve));
} else if (await main(['start', '--content-root', content, '--port', String(port)], io) !== 0) process.exit(1);

// Headless Chrome (server/headless.ts): a tab per page, polled until the page reports.
const headless = await launchChrome(path.join(tmp, 'chrome'), { chrome });
const send = headless.send;

/** Opens a page and waits for its report; `after`, an expression, is then evaluated there, its value the `after`. */
interface PageOptions {
  /** A phone: 390 x 844 CSS pixels, touch, set before the page loads. */
  phone?: boolean;
  /** Device pixels per CSS pixel, at 1200 x 800 CSS pixels. */
  scale?: number;
  /** Driven from here after `after` (with the tab's session and `after`'s value); its value is the report's `then`. */
  then?: (sessionId: string, after: unknown) => Promise<unknown>;
  /** Run in the page before any of its own scripts. */
  first?: string;
  /** The system's colour scheme emulated light, before the page loads. */
  light?: boolean;
}

async function page(query: string, after?: string, opts: PageOptions = {}): Promise<Record<string, unknown>> {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  if (opts.phone) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  }
  if (opts.scale) await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800,
    deviceScaleFactor: opts.scale, mobile: false }, sessionId);
  if (opts.light) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme',
    value: 'light' }] }, sessionId);
  if (opts.first) {
    await send('Page.enable', {}, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: opts.first }, sessionId);
  }
  await send('Page.navigate', { url: `http://localhost:${port}${base}${query}` }, sessionId);
  try {
    for (let t = 0; t < 3000; t++) {
      const r = await send('Runtime.evaluate', { expression: 'document.body?.dataset.report ?? null',
        returnByValue: true }, sessionId) as { result: { value: string | null } };
      if (r.result.value) {
        if (process.env.SHOTS) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId) as { data: string };
          fs.mkdirSync(process.env.SHOTS, { recursive: true });
          fs.writeFileSync(path.join(process.env.SHOTS, `${query.replace(/[^a-z0-9.]+/gi, '_') || 'page'}.png`),
            Buffer.from(data, 'base64'));
        }
        const report = JSON.parse(r.result.value) as Record<string, unknown>;
        if (after) {
          // Within 3 minutes: a promise in the page that never settles fails the check rather than hanging it.
          const e = await Promise.race([send('Runtime.evaluate', { expression: after, returnByValue: true,
            awaitPromise: true }, sessionId), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
            'the page did not finish within 3 minutes')), 180_000))]) as { result: { value: unknown };
            exceptionDetails?: { exception?: { description?: string } } };
          if (e.exceptionDetails) throw new Error(`in the page: ${e.exceptionDetails.exception?.description}`);
          report.after = e.result.value;
        }
        if (opts.then) report.then = await opts.then(sessionId, report.after);
        return report;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const status = await send('Runtime.evaluate', { expression: "document.getElementById('status')?.textContent",
      returnByValue: true }, sessionId) as { result: { value: string } };
    return { missing: `no report within 300 s; status: ${status.result.value}` };
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}

const results: [string, string][] = [];
// ONLY=<name>,<name>: only those checks (for mutation runs).
const only = process.env.ONLY?.split(',');
const check = async (name: string, f: () => Promise<string | undefined>) => {
  if (only && !only.includes(name)) return;
  // Progress on standard error, so a check that hangs can be told from a slow one.
  const t0 = Date.now();
  process.stderr.write(`${name}...`);
  try { results.push([name, (await f()) ?? 'ok']); } catch (e) { results.push([name, `FAIL ${(e as Error).message}`]); }
  process.stderr.write(` ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
};
const expect = (c: boolean, m: string) => { if (!c) throw new Error(m); };

/** Chrome and the server stopped, the temporary directory removed. */
async function shutdown(): Promise<void> {
  await headless.close();
  if (staticServer) staticServer.close();
  else await main(['stop'], io);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}

// A first load, whose report isn't used: Vite optimizes the dependencies it finds on first use, and reloads the
// page when it does. If even the empty page never reports (the app didn't load), every other page would wait its
// full time for nothing: stop.
const first = await page('?check');
if (first.missing) {
  await shutdown();
  console.log(`FAIL the empty page: ${first.missing}`);
  process.exit(1);
}

// Centring and back, through the page's `viewer`: [display position, target before, target after] each way.
const CENTER = `(() => { const v = globalThis.viewer; const t0 = v.controls.target.toArray(); v.setCentered(true);
  const on = [v.display.position.toArray(), t0, v.controls.target.toArray()]; v.setCentered(true); v.setCentered(false);
  return { on, off: [v.display.position.toArray(), v.controls.target.toArray()] }; })()`;

// Draco quantizes positions to 14 bits over each part mesh's extent, meshopt to 16: well under 0.05 mm here.
const TOL = 0.05;
for (const file of ['as1.stp', 'as1.glb', 'as1-meshopt.gltf', 'as1.json', 'as1.json.extras.json', 'as1-noedges.glb']) {
  await check(file, async () => {
    const r = await page(`?url=${encodeURIComponent(`/content/${file}`)}&check`, CENTER) as {
      stats?: { triangles: number; segments: number }; box?: number[][]; centroid?: number[]; error?: string;
      missing?: string; after?: { on: number[][]; off: number[][] } };
    expect(!r.error && !r.missing, `no model: ${r.error ?? r.missing}`);
    expect(r.stats!.triangles === triangles, `${r.stats!.triangles} triangles, expected ${triangles}`);
    if (file === 'as1-noedges.glb') expect(r.stats!.segments > 0, 'no edges found from the triangles');
    else expect(r.stats!.segments === segments, `${r.stats!.segments} edge segments, expected ${segments}`);
    const [min, max] = r.box!;
    for (let k = 0; k < 3; k++) expect(Math.abs(min![k]! - lo[k]!) < TOL && Math.abs(max![k]! - hi[k]!) < TOL,
      `box ${JSON.stringify(r.box)}, expected ${JSON.stringify([lo, hi])}`);
    for (let k = 0; k < 3; k++) expect(Math.abs(r.centroid![k]! - (lo[k]! + hi[k]!) / 2) < TOL,
      `centroid ${r.centroid}`);
    // Centred: the model moved by minus the centroid, and the camera with it; uncentred: both back.
    const [[d1, t0, t1], [d2, t2]] = [r.after!.on, r.after!.off];
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(d1![k]! + r.centroid![k]!) < 1e-9 && Math.abs(t1![k]! - t0![k]! - d1![k]!) < 1e-9,
        `centred: ${JSON.stringify(r.after)}`);
      expect(d2![k] === 0 && Math.abs(t2![k]! - t0![k]!) < 1e-9, `uncentred: ${JSON.stringify(r.after)}`);
    }
    return undefined;
  });
}
for (const extra of process.env.EXTRA?.split(',') ?? []) {
  fs.copyFileSync(extra, path.join(content, path.basename(extra)));
  await check(`extra ${path.basename(extra)}`, async () => {
    const r = await page(`?url=${encodeURIComponent(`/content/${path.basename(extra)}`)}&check`);
    console.log(path.basename(extra), JSON.stringify({ ...r, box: undefined }));
    expect(!r.error && !r.missing, `no model: ${r.error ?? r.missing}`);
    return undefined;
  });
}
// Replacing a model while it's meshing: the bicycle's meshing is cancelled once it has begun (its load ends at
// once: the workers are stopped), the GLB shown alone, and STEP meshes again after (a new pool), from the cache (the
// assembly was meshed above); and with truck when that's the backend chosen.
await check('replaced while meshing', async () => {
  const r = await page('?check', `(async () => {
    const v = globalThis.viewer;
    const src = async (name) => ({ name, bytes: await (await fetch('/content/' + name)).arrayBuffer() });
    const first = v.load(await src('bicycle.stp'));
    for (let t = 0; t < 3000 && !(v.model?.parts?.done > 0); t++) await new Promise((r) => setTimeout(r, 10));
    const begun = v.model?.parts?.done ?? 0;
    await v.load(await src('as1.glb'));
    const t = performance.now();
    await first;
    const firstEnded = performance.now() - t;
    await new Promise((r) => setTimeout(r, 1500));
    const glb = { name: v.model.name, stats: v.stats() };
    await v.load(await src('as1.stp'));
    const step = { name: v.model.name, stats: v.stats(), parts: v.model.parts, ...v.model.meshing };
    v.settings.backend = 'truck';
    await v.load(await src('as1.stp'));
    const truck = { parts: v.model.parts, ...v.model.meshing };
    return { begun, firstEnded, glb, step, truck };
  })()`) as { after?: { begun: number; firstEnded: number; glb: { name: string; stats: { triangles: number } };
    step: { name: string; stats: { triangles: number }; parts: { done: number; failed: number }; backend: string;
      cache?: { hits: number; misses: number }; pools: number };
    truck: { parts: { done: number; failed: number }; backend: string } } };
  const a = r.after!;
  expect(a.begun > 0 && a.begun < 112, `the bicycle wasn't caught meshing: ${a.begun} parts done`);
  expect(a.firstEnded < 1000, `the bicycle's load went on for ${a.firstEnded} ms after it was replaced`);
  expect(a.step.backend.startsWith('occt ') && a.step.cache!.hits >= 5, `STEP again: ${JSON.stringify(a.step)}`);
  // The bicycle's pool was disposed when it was replaced: the assembly got a new one (the second).
  expect(a.step.pools === 2, `a new pool after replacing: ${JSON.stringify(a.step)}`);
  expect(a.truck.backend.startsWith('truck ') && a.truck.parts.done === 5, `truck: ${JSON.stringify(a.truck)}`);
  expect(a.glb.name === 'as1.glb' && a.glb.stats.triangles === triangles, `after: ${JSON.stringify(a.glb)}`);
  expect(a.step.name === 'as1.stp' && a.step.stats.triangles === triangles && a.step.parts.failed === 0,
    `STEP again: ${JSON.stringify(a.step)}`);
  return undefined;
});
// The tree on the STEP assembly: the top level open; with detail and everything expanded, a row per node; clicking
// rows selects them (ctrl adds); hiding them hides their objects and greys their rows; a face hidden in one
// placement is hidden in every placement of its part; show all shows everything again.
await check('tree', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const p = ui.panel(), m = p.model;
    const rows = () => [...document.querySelectorAll('.tree-row')].filter((r) => r.style.display !== 'none')
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    const spacerRows = () => Math.round(parseFloat(document.querySelector('.tree-scroller > div').style.height) / 18);
    await frame();
    const initial = rows().map((r) => r.textContent);
    p.setDetail(true);
    p.expandAll();
    await frame();
    const all = spacerRows(), nodes = m.nodes.length;
    const click = (row, ctrlKey = false) => row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey }));
    const parts = () => rows().filter((r) => m.nodes[+r.dataset.id].kind === 'part');
    const display = getComputedStyle(rows()[0]).display;
    const label = rows()[1].getAttribute('aria-label');
    click(parts()[0]);
    await frame();
    click(parts()[1], true);
    await frame();
    const selected = [...p.selected()];
    const afterClicks = spacerRows();
    ui.hideSelected();
    await frame();
    const hiddenObjects = selected.filter((i) => m.nodes[i].object.visible === false).length;
    const greyed = rows().filter((r) => r.classList.contains('hidden')).length;
    // A face of the first part, hidden: every placement of that part draws it with nothing.
    ui.showAll();
    await frame();
    const face = rows().find((r) => m.nodes[+r.dataset.id].kind === 'face');
    const faceNode = m.nodes[+face.dataset.id];
    click(face);
    await frame();
    ui.hideSelected();
    await frame();
    const same = m.nodes.filter((n) => n.face && n.face.part === faceNode.face.part && n.face.source ===
      faceNode.face.source);
    const sameHidden = same.filter((n) => n.hidden).length;
    let invisibleGroups = 0;
    viewer.display.traverse((o) => { if (o.isMesh && Array.isArray(o.material)) invisibleGroups +=
      o.geometry.groups.filter((g) => !o.material[g.materialIndex].visible).length; });
    ui.showAll();
    await frame();
    // Selecting from elsewhere (as picking will): the node's row selected and in view.
    const last = m.nodes.length - 1;
    p.select([last]);
    await frame();
    const pickedRow = rows().find((r) => +r.dataset.id === last);
    const picked = !!pickedRow && pickedRow.classList.contains('selected') && p.selected().join() === String(last);
    p.collapseAll();
    await frame();
    const collapsed = spacerRows();
    let invisibleAfter = 0;
    viewer.display.traverse((o) => { if (o.isMesh && Array.isArray(o.material)) invisibleAfter +=
      o.geometry.groups.filter((g) => !o.material[g.materialIndex].visible).length; });
    return { initial, all, nodes, selected: selected.length, hiddenObjects, greyed, same: same.length, sameHidden,
      invisibleGroups, invisibleAfter, greyAfter: rows().filter((r) => r.classList.contains('hidden')).length,
      display, label, afterClicks, picked, collapsed };
  })()`) as { after?: { initial: string[]; all: number; nodes: number; selected: number; hiddenObjects: number;
    greyed: number; same: number; sameHidden: number; invisibleGroups: number; invisibleAfter: number;
    greyAfter: number; display: string; label: string; afterClicks: number; picked: boolean; collapsed: number } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.initial.length > 3 && a.initial[0] === 'as1.stp' && a.initial[1] === 'as1', `initial rows: ${j}`);
  expect(a.all === a.nodes, `rows ${a.all}, nodes ${a.nodes}`);
  expect(a.display === 'flex' && a.label === 'as1', `rows' layout and labels: ${j}`);
  // Clicks select; they don't expand or collapse.
  expect(a.afterClicks === a.all, `rows after clicks: ${j}`);
  expect(a.picked && a.collapsed === 1, `selecting from elsewhere, collapsing: ${j}`);
  expect(a.selected === 2 && a.hiddenObjects === 2, `selection and hiding: ${j}`);
  // Each hidden part greys itself and its detail rows (its faces and edges).
  expect(a.greyed > 2, `greyed rows: ${j}`);
  expect(a.same > 1 && a.sameHidden === a.same && a.invisibleGroups === a.same, `face hiding: ${j}`);
  expect(a.invisibleAfter === 0 && a.greyAfter === 0, `show all: ${j}`);
  return undefined;
});
// Picking on the STEP assembly with pointer events on the canvas: a click over a part selects it (tinted, and in
// the tree), ctrl adds another, empty space clears; details describe it; zoom selected centres it; at the detail
// level a click picks a face (or the edges on it); all instances tints the part's other placements.
await check('picking', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const m = ui.panel().model, canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    const click = (x, y, ctrlKey = false) => {
      for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, { bubbles: true,
        pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, ctrlKey }));
    };
    const part = (id) => { while (id >= 0 && m.nodes[id].kind !== 'part') id = m.nodes[id].parent; return id; };
    // Points over two different parts' meshes: their placements' box centres, where a pick hits the same part.
    const spots = [];
    for (const n of m.nodes) {
      if (n.kind !== 'part' || spots.length === 2) continue;
      const b = n.object.children[0].geometry; b.computeBoundingBox();
      const centre = b.boundingBox.getCenter(viewer.camera.position.clone())
        .applyMatrix4(n.object.children[0].matrixWorld);
      const p = centre.clone().project(viewer.camera);
      const x = rect.left + (p.x + 1) / 2 * rect.width, y = rect.top + (1 - p.y) / 2 * rect.height;
      const hit = viewer.pickAt(x, y);
      if (hit && hit.object.isMesh && part(m.nodeOf(hit.object)) === n.id && !spots.some((s) => s.id === n.id)) {
        spots.push({ id: n.id, x, y });
      }
    }
    // A drag (the pointer moved) rotates; it doesn't pick.
    for (const [type, dx] of [['pointerdown', 0], ['pointerup', 30]]) canvas.dispatchEvent(new PointerEvent(type,
      { bubbles: true, pointerId: 1, button: 0, isPrimary: true, clientX: spots[0].x + dx, clientY: spots[0].y }));
    await frame();
    const dragged = [...ui.selected()];
    click(spots[0].x, spots[0].y);
    await frame();
    const first = [...ui.selected()];
    const mesh = m.nodes[spots[0].id].object.children[0];
    const tinted = mesh.material.some((x) => x.emissive && x.emissive.getHex() !== 0);
    const row = [...document.querySelectorAll('.tree-row')].find((r) => +r.dataset.id === spots[0].id);
    const rowSelected = !!row && row.classList.contains('selected');
    ui.selection.details = true;
    const detailsText = ui.details().join('|');
    click(spots[1].x, spots[1].y, true);
    await frame();
    const two = [...ui.selected()];
    click(rect.left + 2, rect.top + 2);
    await frame();
    const none = [...ui.selected()];
    // Multi-select (touch): taps toggle without keys; select parent: the selection's parents.
    ui.selection.multi = true;
    click(spots[0].x, spots[0].y);
    click(spots[1].x, spots[1].y);
    click(spots[0].x, spots[0].y);
    await frame();
    const toggled = [...ui.selected()];
    ui.selection.multi = false;
    ui.selectParent();
    const parent = [...ui.selected()];
    ui.select([spots[0].id]);
    ui.zoomSelected();
    const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const centre = b.getCenter(viewer.camera.position.clone());
    const centred = viewer.controls.target.distanceTo(centre) < 1e-6;
    // The detail level: the same spot (after zooming in, recomputed) picks a face or the edges on it.
    ui.selection.level = 'detail';
    const p = centre.clone().project(viewer.camera);
    click(rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height);
    await frame();
    const detailKind = ui.selected().length === 1 ? m.nodes[ui.selected()[0]].kind : 'none';
    // All instances: a part placed more than once, its other placements tinted too.
    ui.selection.level = 'part';
    ui.selection.instances = true;
    const shared = m.nodes.find((n) => n.kind === 'part' && m.nodes.filter((o) => o.kind === 'part' &&
      o.object.userData.part === n.object.userData.part).length > 1);
    ui.select([shared.id]);
    const placements = m.nodes.filter((n) => n.kind === 'part' && n.object.userData.part ===
      shared.object.userData.part);
    const lit = placements.filter((n) => n.object.children[0].material.some((x) => x.emissive &&
      x.emissive.getHex() !== 0)).length;
    ui.selection.instances = false;
    ui.select([]);
    const unlit = placements.filter((n) => n.object.children[0].material.some((x) => x.emissive &&
      x.emissive.getHex() !== 0)).length;
    return { spots: spots.map((s) => s.id), first, tinted, rowSelected, detailsText, two, none, centred, detailKind,
      placements: placements.length, lit, unlit, toggled, parent, parentExpected: [m.nodes[spots[1].id].parent],
      dragged };
  })()`) as { after?: { spots: number[]; first: number[]; tinted: boolean; rowSelected: boolean;
    detailsText: string; two: number[]; none: number[]; centred: boolean; detailKind: string; placements: number;
    lit: number; unlit: number; toggled: number[]; parent: number[]; parentExpected: number[]; dragged: number[] } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.spots.length === 2, `no two parts to click: ${j}`);
  expect(a.first.join() === String(a.spots[0]) && a.tinted && a.rowSelected, `a click: ${j}`);
  expect(/Placement \d+ of \d+|The only placement/.test(a.detailsText) && /Triangles: /.test(a.detailsText),
    `details: ${j}`);
  expect(a.two.join() === a.spots.join() && a.none.length === 0, `ctrl-click, empty space: ${j}`);
  expect(a.toggled.join() === String(a.spots[1]) && a.parent.join() === a.parentExpected.join(),
    `multi-select, select parent: ${j}`);
  expect(a.centred, `zoom selected: ${j}`);
  expect(a.detailKind === 'face' || a.detailKind === 'edges', `detail pick: ${j}`);
  expect(a.placements > 1 && a.lit === a.placements && a.unlit === 0, `all instances: ${j}`);
  expect(a.dragged.length === 0, `a drag picked: ${j}`);
  return undefined;
});
// The rendering settings: N8AO then SMAA by default; without AO, a render pass and the output pass; edges drawn and
// pickable only while shown (their layer); shininess on the model's faces; a glTF file's own materials kept when
// asked; no WebGL errors.
await check('rendering', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    // (By identity: class names are mangled in N8AO's bundle, and in a build.)
    const c = viewer.composer;
    const names = new Map([[c.n8ao, 'N8AOPass'], [c.smaa, 'SMAAPass'], [c.plain, 'RenderPass'],
      [c.output, 'OutputPass']]);
    const passes = () => c.composer.passes.map((p) => names.get(p) ?? 'other');
    const gl = viewer.renderer.getContext();
    const edgesShown = () => viewer.camera.layers.isEnabled(1);
    const edgeHits = () => { let n = 0; viewer.display.traverse((o) => { if (o.isLine && o.name === 'edges' &&
      o.layers.mask === 2) n++; }); return n; };
    const initial = passes();
    viewer.setRender({ ...viewer.render, ao: false, smaa: false, edges: false, shininess: 77 });
    await frame();
    const plain = passes(), hidden = edgesShown();
    let shiny = 0, faces = 0;
    viewer.display.traverse((o) => { if (o.isMesh) for (const m of [o.material].flat()) if (m.isMeshPhongMaterial) {
      faces++; if (m.shininess === 77) shiny++; } });
    // A pick on an edge's midpoint with edges hidden doesn't hit edges.
    let edge;
    viewer.display.traverse((o) => { if (!edge && o.isLine && o.name === 'edges') edge = o; });
    const pos = edge.geometry.attributes.position, i0 = edge.geometry.index.getX(0), i1 = edge.geometry.index.getX(1);
    const mid = viewer.camera.position.clone().set((pos.getX(i0) + pos.getX(i1)) / 2, (pos.getY(i0) + pos.getY(i1)) / 2,
      (pos.getZ(i0) + pos.getZ(i1)) / 2).applyMatrix4(edge.matrixWorld).project(viewer.camera);
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const at = [rect.left + (mid.x + 1) / 2 * rect.width, rect.top + (1 - mid.y) / 2 * rect.height];
    const hitHidden = viewer.pickAt(...at);
    viewer.setRender({ ...viewer.render, ao: true, smaa: true, edges: true });
    await frame();
    const hitShown = viewer.pickAt(...at);
    const back = passes();
    return { initial, plain, back, hidden, shown: edgesShown(), shiny, faces, edgeLayers: edgeHits(),
      hitHidden: hitHidden ? hitHidden.object.name || hitHidden.object.type : 'none',
      hitShown: hitShown ? hitShown.object.name || hitShown.object.type : 'none', glError: gl.getError() };
  })()`) as { after?: { initial: string[]; plain: string[]; back: string[]; hidden: boolean; shown: boolean;
    shiny: number; faces: number; edgeLayers: number; hitHidden: string; hitShown: string; glError: number } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.initial.join() === 'N8AOPass,SMAAPass' && a.back.join() === a.initial.join(), `passes: ${j}`);
  expect(a.plain.join() === 'RenderPass,OutputPass', `passes without AO and SMAA: ${j}`);
  expect(!a.hidden && a.shown && a.edgeLayers > 0, `edges layer: ${j}`);
  expect(a.faces > 0 && a.shiny === a.faces, `shininess: ${j}`);
  expect(a.hitHidden !== 'edges' && a.hitShown === 'edges', `picking edges shown and hidden: ${j}`);
  expect(a.glError === 0, `WebGL error ${a.glError}`);
  // The file's own materials: a GLB loaded with CAD materials off keeps glTF-Transform's standard ones.
  const g = await page(`?url=${encodeURIComponent('/content/as1.glb')}&check`, `(async () => {
    const kinds = (root) => { const s = new Set(); root.traverse((o) => { if (o.isMesh) for (const m of
      [o.material].flat()) s.add(m.type); }); return [...s].sort(); };
    const phong = kinds(viewer.display);
    let edges = 0, onLayer = 0;
    viewer.display.traverse((o) => {
      if (o.isLine && o.name === 'edges') { edges++; if (o.layers.mask === 2) onLayer++; }
    });
    viewer.render.cadMaterials = false;
    await viewer.load({ name: 'as1.glb', bytes: await (await fetch('/content/as1.glb')).arrayBuffer() });
    return { phong, own: kinds(viewer.display), edges, onLayer };
  })()`) as { after?: { phong: string[]; own: string[]; edges: number; onLayer: number } };
  expect(g.after!.phong.join() === 'MeshPhongMaterial' && g.after!.own.join() === 'MeshStandardMaterial',
    `CAD materials: ${JSON.stringify(g.after)}`);
  expect(g.after!.edges > 0 && g.after!.onLayer === g.after!.edges, `glTF edges' layer: ${JSON.stringify(g.after)}`);
  // Transparency: three.js's sorting of transparent objects; N8AO aware of them.
  const t = await page(`?url=${encodeURIComponent('/content/as1-clear.glb')}&check`, `(async () => {
    const ms = []; viewer.display.traverse((o) => { if (o.isMesh) ms.push(...[o.material].flat()); });
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    return { all: ms.length, clear: ms.filter((m) => m.isMeshPhongMaterial && m.transparent && m.opacity === 0.5)
      .length, aware: viewer.composer.n8ao.configuration.transparencyAware,
      sorted: viewer.renderer.sortObjects, glError: viewer.renderer.getContext().getError() };
  })()`) as { after?: { all: number; clear: number; aware: boolean; sorted: boolean; glError: number } };
  const ta = t.after!;
  expect(ta.all > 0 && ta.clear === ta.all && ta.aware && ta.sorted && ta.glError === 0,
    `transparency: ${JSON.stringify(ta)}`);
  return undefined;
});
// Sections on the STEP assembly: a plane across X through the middle cuts the model (the renderer's clipping
// planes), caps the closed parts (read back from the drawn frame: the plate's colour where its cut is, the background
// without caps), keeps picks off the cut-away side; flipping it keeps the other side; centring moves it with the
// model.
await check('sections', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const m = ui.panel().model;
    const mesh = (name) => m.nodes.find((n) => n.kind === 'part' && n.name === name).object.children[0];
    const boxOf = (o) => { o.geometry.computeBoundingBox(); return o.geometry.boundingBox.clone()
      .applyMatrix4(o.matrixWorld); };
    const frames = (n) => new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });
    // Colours where world points are drawn, after real frames (the viewer's own drawing makes the caps), rendered
    // again and read back in one task.
    const colours = async (points) => {
      await frames(3);
      viewer.composer.render();
      viewer.composer.render();
      const dpr = viewer.renderer.getPixelRatio();
      return points.map((v) => { const p = v.clone().project(viewer.camera), out = new Uint8Array(4);
        gl.readPixels(Math.round((p.x + 1) / 2 * canvas.clientWidth * dpr),
          Math.round((p.y + 1) / 2 * canvas.clientHeight * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return [...out.slice(0, 3)]; });
    };
    // The rod (round, along X) cut through its middle, seen close: its cap's centre is inside it, the corner of the
    // cap's square isn't.
    const rod = mesh('rod'), rb = boxOf(rod), c = rb.getCenter(rod.position.clone());
    const at = c.x;
    viewer.zoomTo(rb);
    const r = Math.min(rb.max.y - rb.min.y, rb.max.z - rb.min.z) / 2;
    // (The corner away from the camera, which looks from +X -Y +Z: behind it, nothing of the rod's kept length.)
    const centre = c.clone(), corner = c.clone().add(rod.position.clone().set(0, 0.9 * r, -0.9 * r));
    const s = viewer.sections.get();
    s.x.on = true;
    s.x.at = at;
    s.caps = true;
    viewer.setSections(s);
    const [capped, outside] = await colours([centre, corner]);
    // The same without AO (the composer's own render targets, which need their stencil buffer).
    viewer.setRender({ ...viewer.render, ao: false });
    const [cappedPlain, outsidePlain] = await colours([centre, corner]);
    viewer.setRender({ ...viewer.render, ao: true });
    const planes = viewer.renderer.clippingPlanes.length, caps = viewer.sections.group.children.length;
    viewer.setSections({ ...s, caps: false });
    const [open] = await colours([centre]);
    viewer.setSections(s);
    viewer.zoomAll();
    // Picks: on the kept side something, on the cut-away side nothing of the model's beyond the plane.
    const pb = boxOf(mesh('plate'));
    const rect = canvas.getBoundingClientRect();
    const screen = (v) => { const p = v.clone().project(viewer.camera);
      return [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height]; };
    const top = (x) => pb.getCenter(rod.position.clone()).setX(x).setZ(pb.max.z);
    const kept = viewer.pickAt(...screen(top(at - 0.25 * (at - pb.min.x))));
    const gone = viewer.pickAt(...screen(top(at + 0.25 * (pb.max.x - at))));
    // Flipped: the other side kept.
    viewer.setSections({ ...s, x: { ...s.x, flip: true } });
    const flipped = viewer.sections.clipped(c.clone().setX(at - 1)) &&
      !viewer.sections.clipped(c.clone().setX(at + 1));
    // Centring moves the plane with the model (off the centroid, so the move shows).
    const cx = viewer.model.centroid.x;
    viewer.setSections({ ...s, x: { ...s.x, at: at - 10 } });
    viewer.setCentered(true);
    const movedTo = viewer.sections.get().x.at;
    viewer.setCentered(false);
    const back = viewer.sections.get().x.at;
    return { planes, caps, capped, outside, cappedPlain, outsidePlain, open, kept: kept ? kept.point.x : null,
      gone: gone ? gone.point.x : null,
      at, flipped, movedTo, expectedMove: at - 10 - cx, back, glError: gl.getError() };
  })()`) as { after?: { planes: number; caps: number; capped: number[]; outside: number[]; cappedPlain: number[];
    outsidePlain: number[]; open: number[];
    kept: number | null; gone: number | null; at: number; flipped: boolean; movedTo: number; expectedMove: number;
    back: number; glError: number } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.planes === 1 && a.caps > 0, `planes and caps: ${j}`);
  // The rod is orange (red high, green middling, blue low), hatched; its cap's square outside the circle isn't; with
  // no caps, the cut shows what's beyond.
  const orange = ([r, g, b]: number[]) => r! > 150 && g! > 40 && g! < 200 && b! < 60 && r! > g! + 40;
  expect(orange(a.capped), `cap colour: ${j}`);
  expect(!orange(a.outside), `cap outside the solid: ${j}`);
  expect(orange(a.cappedPlain) && !orange(a.outsidePlain), `caps without AO: ${j}`);
  expect(!orange(a.open), `no caps: ${j}`);
  expect(a.kept !== null && a.kept <= a.at + 1e-6 && (a.gone === null || a.gone <= a.at + 1e-6),
    `picking across the plane: ${j}`);
  expect(a.flipped, `flip: ${j}`);
  expect(Math.abs(a.movedTo - a.expectedMove) < 1e-6 && Math.abs(a.back - (a.at - 10)) < 1e-6 && a.movedTo !== a.back,
    `centring: ${j}`);
  expect(a.glError === 0, `WebGL error: ${j}`);
  return undefined;
});
// Picks against what's drawn, over a grid of points on as1 and the bicycle: an ID render (each part's meshes in a flat
// colour of its own, edges off, read back after three frames and two renders) says which part each pixel shows, and
// pickAt at the pixel's centre must pick that part (its face, or its own edge within reach) wherever a part is drawn
// and the ray hits it. Off the parts, an edge within reach may be picked, and a wireframe in front (by design); parts
// thinner than a pixel may be drawn where the ray misses them (at most 2% of the points). Before 2026-10-25, any
// part's edge within 4 pixels beat the face under the point: 27 of 860 points on parts wrong on as1, 39 of 171 on
// the bicycle (measured with a 1200 x 800 window). Everywhere, on parts or off, a line or point picked must be within
// reach on the screen (4 pixels, pick.ts, and half a pixel for the sample's centre): under a scaled parent (a STEP
// file in metres, or any glTF, scaled by the display transform) three.js's thresholds reached 1000 times too far, so
// a click in empty space picked the nearest part's edges (2026-10-25), which the check, on parts only and on files in
// millimetres, didn't see; a part in metres is checked too since (our GLB doesn't show it: its millimetre meshes sit
// under a root scaling by 0.001, which the display transform undoes, so lines are at a world scale of 1).
const PICK_ORACLE = `(async () => {
  const m = ui.panel().model, r = viewer.renderer, cam = viewer.camera, canvas = r.domElement;
  const partOf = (id) => { while (id !== undefined && id >= 0 && m.nodes[id].kind !== 'part') id = m.nodes[id].parent;
    return id; };
  const saved = [];
  viewer.display.updateWorldMatrix(true, true);
  viewer.display.traverse((o) => {
    if (!o.isMesh) return;
    const pid = partOf(m.nodeOf(o));
    const k = pid === undefined ? 4095 : pid + 1;
    const first = [o.material].flat()[0];
    const mat = first.clone();
    mat.color.setRGB(0, 0, 0);
    mat.specular?.setRGB(0, 0, 0);
    mat.emissive.setRGB(((k % 16) * 16 + 8) / 255, ((Math.floor(k / 16) % 16) * 16 + 8) / 255,
      ((Math.floor(k / 256) % 16) * 16 + 8) / 255, 'srgb');
    Object.assign(mat, { polygonOffset: false, transparent: false, opacity: 1 });
    saved.push([o, o.material]);
    o.material = Array.isArray(o.material) ? o.material.map((x) => Object.assign(mat.clone(), { visible: x.visible }))
      : mat;
  });
  const bg = viewer.scene.background, layers = cam.layers.mask;
  viewer.scene.background = null;
  cam.layers.set(0);
  r.setClearColor(0x000000, 1);
  for (let f = 0; f < 3; f++) await new Promise((res) => requestAnimationFrame(res));
  r.render(viewer.scene, cam);
  r.render(viewer.scene, cam);
  const rect = canvas.getBoundingClientRect();
  const gl = r.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  for (const [o, mat] of saved) o.material = mat;
  viewer.scene.background = bg;
  cam.layers.mask = layers;
  viewer.redraw();
  const q = (v) => Math.round((v - 8) / 16);
  const shown = (x, y) => { const i = 4 * (y * W + x);
    return px[i] + px[i + 1] + px[i + 2] < 4 ? undefined : q(px[i]) + 16 * q(px[i + 1]) + 256 * q(px[i + 2]) - 1; };
  const sx = W / rect.width, sy = H / rect.height;
  let onParts = 0, wrong = 0, subpixel = 0, lines = 0, far = 0;
  const examples = [];
  for (let gy = 1; gy < 40; gy++) for (let gx = 1; gx < 60; gx++) {
    const ox = Math.floor(W * gx / 60), oy = Math.floor(H * gy / 40);
    const cx = (ox + 0.5) / sx, cy = (oy + 0.5) / sy;
    const hit = viewer.pickAt(rect.left + cx, rect.top + cy);
    if (hit && !hit.object.isMesh) {
      lines++;
      const s = hit.point.clone().project(cam);
      const d = Math.hypot((s.x + 1) / 2 * rect.width - cx, (1 - s.y) / 2 * rect.height - cy);
      if (d > 4.5) {
        far++;
        if (examples.length < 5) examples.push({ x: ox, y: oy, far: d, line: m.nodes[partOf(m.nodeOf(hit.object))]
          ?.name });
      }
    }
    const want = shown(ox, H - 1 - oy);
    if (want === undefined) continue;
    onParts++;
    const got = hit ? partOf(m.nodeOf(hit.object)) : undefined;
    if (got === want) continue;
    // Wireframes (parts with no faces) in front win by design; the ID render doesn't draw them.
    let gotFaces = false;
    if (got !== undefined) m.nodes[got].object.traverse((o) => { gotFaces ||= !!o.isMesh; });
    if (got !== undefined && !gotFaces) continue;
    // A part thinner than a pixel can be drawn in a pixel whose centre the ray passes beside: wrong only if the ray
    // does hit the drawn part's face (picking with every other part hidden).
    const parts = m.nodes.filter((n) => n.kind === 'part' && n.id !== want && n.object?.visible);
    for (const n of parts) n.object.visible = false;
    const alone = viewer.pickAt(rect.left + cx, rect.top + cy);
    for (const n of parts) n.object.visible = true;
    if (!alone || !alone.object.isMesh) { subpixel++; continue; }
    wrong++;
    if (examples.length < 5) examples.push({ x: ox, y: oy, want: m.nodes[want]?.name, got: got === undefined ? null :
      m.nodes[got]?.name, line: hit ? !hit.object.isMesh : null });
  }
  return { onParts, wrong, subpixel, lines, far, examples };
})()`;
await check('picks match what is drawn', async () => {
  const out = [];
  for (const file of ['as1.stp', 'as1.glb', 'bicycle.stp', 'metres.stp']) {
    const r = await page(`?url=${encodeURIComponent(`/content/${file}`)}&check`, PICK_ORACLE) as
      { after: { onParts: number; wrong: number; subpixel: number; lines: number; far: number; examples: unknown[] } };
    const a = r.after;
    expect(a.onParts > 100 && a.wrong === 0 && a.subpixel <= a.onParts / 50 && a.lines > 0 && a.far === 0,
      `${file}: ${JSON.stringify(a)}`);
    out.push(`${file} ${a.onParts} (${a.subpixel} thinner than a pixel; ${a.lines} lines picked)`);
  }
  console.log(`picks match what is drawn: points on parts ${out.join(', ')}`);
  return undefined;
});
// A phone (emulated: narrow, touch): the tree and the controls start closed, the page doesn't scroll or bounce,
// detected as a phone, so three workers at most and the coarse profile, no handle for the tree's width, and a tap
// (touch events) on a part selects it.
await check('phone', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(() => {
    const m = ui.panel().model, canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    const part = (id) => { while (id >= 0 && m.nodes[id].kind !== 'part') id = m.nodes[id].parent; return id; };
    let spot;
    for (const n of m.nodes) {
      if (spot || n.kind !== 'part') continue;
      const g = n.object.children[0].geometry; g.computeBoundingBox();
      const p = g.boundingBox.getCenter(viewer.camera.position.clone()).applyMatrix4(n.object.children[0].matrixWorld)
        .project(viewer.camera);
      const x = rect.left + (p.x + 1) / 2 * rect.width, y = rect.top + (1 - p.y) / 2 * rect.height;
      const hit = viewer.pickAt(x, y);
      if (hit && part(m.nodeOf(hit.object)) === n.id) spot = { id: n.id, x, y };
    }
    return { treeClosed: document.body.classList.contains('tree-closed'),
      guiClosed: document.querySelector('.lil-gui.root').classList.contains('closed'),
      overscroll: getComputedStyle(document.body).overscrollBehaviorY, touch: navigator.maxTouchPoints,
      handle: getComputedStyle(document.getElementById('side-handle')).display,
      workers: viewer.model.meshing?.workers, spot, device: cadViewer.state().device,
      triangles: viewer.stats().triangles };
  })()`, { phone: true, then: async (sessionId, after) => {
    // A tap: a touch down and up at the spot, as a finger would.
    const spot = (after as { spot?: { x: number; y: number } }).spot;
    if (!spot) return [];
    const at = [{ x: spot.x, y: spot.y, id: 1 }];
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at }, sessionId);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const selected = await evaluate(sessionId, '[...ui.selected()]') as number[];
    // The tree opened: 140 pixels, the narrowest (and its border), over the view; its handle, 24 pixels for a finger,
    // dragged by one to 200, and remembered.
    const widths = `new Promise((r) => setTimeout(r, 200)).then(() => {
      const h = document.getElementById('side-handle').getBoundingClientRect();
      return { side: document.getElementById('side').getBoundingClientRect().width, handle: h.width,
        x: h.left + h.width / 2, y: h.top + h.height / 2, saved: localStorage.getItem('cad-viewer.side') }; })`;
    type W = { side: number; handle: number; x: number; y: number; saved: string | null };
    const opened = await evaluate(sessionId, `(localStorage.removeItem('cad-viewer.side'), ui.setTree({ open: true }),
      ${widths})`) as W;
    const touch = (type: string, x?: number) => send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined
      ? [] : [{ x, y: opened.y, id: 2 }] }, sessionId);
    await touch('touchStart', opened.x);
    for (let k = 1; k <= 4; k++) await touch('touchMove', opened.x + 15 * k);
    await touch('touchEnd');
    const dragged = await evaluate(sessionId, widths) as W;
    // A width set where it fit (as before turning the phone upright): capped at 40 pixels from the window's edge.
    // (The remembered width forgotten again: later pages share this browser's storage.)
    const wide = await evaluate(sessionId, `(document.documentElement.style.setProperty('--side', '500px'),
      localStorage.removeItem('cad-viewer.side'), document.getElementById('side').getBoundingClientRect().width)`) as
      number;
    return { selected, opened, dragged, wide };
  } }) as { after?: { treeClosed: boolean; guiClosed: boolean; overscroll: string; touch: number; handle: string;
    workers: number; spot?: { id: number; x: number; y: number }; triangles: number;
    device: { detected: string; used: string; profile: string } }; then?: { selected: number[];
    opened: { side: number; handle: number; saved: string | null }; dragged: { side: number; saved: string | null };
    wide: number } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.treeClosed && a.guiClosed, `closed at first: ${j}`);
  expect(a.device.detected === 'phone' && a.device.used === 'phone' && a.device.profile === 'coarse' &&
    a.triangles === coarseTriangles, `a phone, meshed coarse (${coarseTriangles} triangles): ${j}`);
  expect(a.overscroll === 'none' && a.touch > 0 && a.workers <= 3 && a.handle === 'block', `phone settings: ${j}`);
  expect(!!a.spot, `no part to tap: ${j}`);
  expect(r.then?.selected.join() === String(a.spot!.id), `a tap selects: ${JSON.stringify(r.then)}, ${j}`);
  const t = r.then!;
  expect(t.opened.side === 141 && t.opened.handle === 24 && t.opened.saved === null, `the tree opened on a phone: ${
    JSON.stringify(t)}`);
  expect(t.dragged.side === 201 && t.dragged.saved === '200', `the tree's handle dragged by a finger: ${
    JSON.stringify(t)}`);
  expect(t.wide === 390 - 40 + 1, `a width too wide for the window, capped (and its border): ${JSON.stringify(t)}`);
  return undefined;
});
// The import worker, the only way STEP files load (the page has no tessellation of its own); every folder of the
// controls closed at first; Zoom selected in View, enabled only with a selection; Mesh again (at another deflection,
// the cache off) keeps the camera, centring, a cut, what's hidden and what's selected, the tree's expansion (detail
// on, all expanded but one assembly) and the row at its top (scrolled partway), and meshes anew; meshed again
// once more with those nodes not coming back (simulated: their paths not found), the status line says so.
// The device (a desktop here, headless Chrome): detected so, meshed medium; the Device control overrides it (a tablet:
// coarse), remembered across pages, and Auto clears that; the Profile control sets the deflections, which, moved,
// make it custom; Defaults goes back to the device's profile.
await check('device', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const c = (name) => ui.gui.controllersRecursive().find((x) => x._name === name);
    const now = () => ({ ...cadViewer.state().device, mm: viewer.settings.linearDeflection,
      deg: Math.round(viewer.settings.angularDeflection * 1e6) / 1e6, stored: localStorage.getItem('cad-viewer.device'),
      auto: c('Device').$select.options[0].text,
      workers: viewer.model?.meshing?.workers, triangles: viewer.stats()?.triangles });
    const start = now();
    c('Device').setValue('tablet');
    // Meshed again as a tablet: at most 3 workers (a new pool).
    const model = viewer.model;
    c('Mesh again').getValue().call(c('Mesh again').object);
    for (let t = 0; t < 600 && (viewer.model === model || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const tablet = now();
    c('Profile').setValue('fine');
    const fine = now();
    c('Deflection (mm)').setValue(0.07);
    const custom = now();
    c('Defaults').getValue().call(c('Defaults').object);
    const defaults = now();
    return { start, tablet, fine, custom, defaults };
  })()`, { then: async (sessionId) => {
    // Another page: the override remembered, then cleared by Auto.
    const evaluate = async (expression: string) => ((await send('Runtime.evaluate', { expression, returnByValue: true,
      awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
    await send('Page.reload', {}, sessionId);
    await new Promise((res) => setTimeout(res, 1500));
    return evaluate(`(async () => {
      await cadViewer.ready;
      const c = (name) => ui.gui.controllersRecursive().find((x) => x._name === name);
      const again = { ...cadViewer.state().device, choice: c('Device').getValue() };
      c('Device').setValue('auto');
      return { again, auto: { ...cadViewer.state().device, stored: localStorage.getItem('cad-viewer.device') } };
    })()`);
  } }) as { after: Record<string, Record<string, unknown>>; then: Record<string, Record<string, unknown>> };
  const { start, tablet, fine, custom, defaults } = r.after;
  const j = JSON.stringify({ ...r.after, ...r.then });
  expect(start!.detected === 'desktop' && start!.used === 'desktop' && start!.profile === 'medium' &&
    start!.mm === 0.1 && start!.deg === 15 && start!.stored === null && start!.auto === 'Auto (desktop)' &&
    start!.triangles === triangles, `a desktop, medium: ${j}`);
  expect(tablet!.used === 'tablet' && tablet!.profile === 'coarse' && tablet!.mm === 0.2 && tablet!.deg === 30 &&
    tablet!.stored === 'tablet', `overridden as a tablet: ${j}`);
  expect((start!.workers as number) > 3 && (tablet!.workers as number) <= 3 && tablet!.triangles === coarseTriangles,
    `meshed again as a tablet: ${j}`);
  expect(fine!.profile === 'fine' && fine!.mm === 0.05 && fine!.deg === 7.5, `fine: ${j}`);
  expect(custom!.profile === 'custom' && custom!.mm === 0.07 && custom!.deg === 7.5, `custom: ${j}`);
  expect(defaults!.profile === 'coarse' && defaults!.mm === 0.2, `the tablet's defaults: ${j}`);
  const { again, auto } = r.then;
  expect(again!.used === 'tablet' && again!.detected === 'desktop' && again!.choice === 'tablet' &&
    auto!.used === 'desktop' && auto!.profile === 'medium' && auto!.stored === null, `remembered, then auto: ${j}`);
  return undefined;
});
await check('mesh again', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const folders = ui.gui.foldersRecursive();
    const allClosed = folders.length > 0 && folders.every((f) => f._closed);
    const zoom = ui.gui.foldersRecursive().find((f) => f._title === 'View').controllers
      .find((c) => c._name === 'Zoom selected');
    const button = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    const disabledEmpty = zoom._disabled;
    const meshing = viewer.model.meshing;
    const pageTessellation = 'tessellation' in viewer || 'importInWorker' in viewer;
    const m = viewer.nodes;
    const parts = m.nodes.filter((n) => n.kind === 'part');
    viewer.setView('top');
    ui.setCentered(true);
    cadViewer.apply({ cut: { x: { at: 10, flip: false } } });
    ui.setHidden([parts[0].id], true);
    ui.select([parts[1].id]);
    button('Details').setValue(true);
    const enabledSelected = !zoom._disabled;
    ui.setTree({ open: true, detail: true });
    ui.panel().expandAll();
    const assembly = m.nodes.find((n) => n.kind === 'assembly' && n.parent >= 0 && m.nodes[n.parent].parent >= 0);
    ui.panel().setExpanded(ui.panel().expanded().filter((id) => id !== assembly.id));
    const scroller = document.querySelector('.tree-scroller');
    await new Promise((r) => requestAnimationFrame(r));
    scroller.scrollTop = 20 * 18 + 5;
    await new Promise((r) => requestAnimationFrame(r));
    const treeState = () => {
      const p = ui.panel(), n = viewer.nodes, t = p.topRow();
      return { expanded: p.expanded().map((id) => n.pathOf(id)).sort(), top: t && [n.pathOf(t.id), t.offset],
        rows: scroller.scrollHeight > scroller.clientHeight + 20 * 18 };
    };
    const treeBefore = treeState();
    // The selection's highlight in the 3D view: a tinted material on the selected part's meshes.
    const tinted = (path) => {
      const n = viewer.nodes;
      let t = false;
      n.nodes[n.find(path)].object.traverse((o) => { if (o.isMesh && [].concat(o.material).some((x) => x.emissive &&
        x.emissive.getHex() !== 0)) t = true; });
      return t;
    };
    const before = cadViewer.state();
    const tintedBefore = tinted(before.selected[0]);
    const triangles = viewer.stats().triangles;
    const model = viewer.model;
    viewer.settings.cache = false;
    viewer.settings.profile = 'custom';
    viewer.settings.linearDeflection = 1;
    button('Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.model === model || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cadViewer.idle();
    const after = cadViewer.state();
    const tintedAfter = tinted(after.selected[0]);
    // The details panel describes the new meshes (its triangles), as a fresh description would.
    const details = document.getElementById('details');
    const detailsAfter = { shown: details.textContent, fresh: ui.details().join('\\n') };
    const treeAfter = treeState();
    const zoomAfter = !zoom._disabled;
    const lostPaths = [...after.hidden, ...after.selected];
    const proto = Object.getPrototypeOf(viewer.nodes);
    const find = proto.find;
    proto.find = function (p) { return lostPaths.includes(p) ? undefined : find.call(this, p); };
    const again = viewer.model;
    try {
      button('Mesh again').$button.click();
      for (let t = 0; t < 1200 && (viewer.model === again || !viewer.model?.meshing); t++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await cadViewer.idle();
    } finally {
      proto.find = find;
    }
    const lost = { status: document.getElementById('status').textContent,
      notRestored: JSON.parse(document.body.dataset.report).notRestored, paths: lostPaths };
    // A face selected: after meshing again, its overlay is on the face's new mesh, sharing that mesh's positions.
    const face = viewer.nodes.nodes.find((n) => n.face && viewer.nodes.nodes[n.parent].object.children[0]?.geometry);
    const facePath = viewer.nodes.pathOf(face.id);
    ui.select([face.id]);
    const faceModel = viewer.model;
    viewer.settings.linearDeflection = 0.5;
    button('Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.model === faceModel || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cadViewer.idle();
    const overlays = [];
    viewer.display.traverse((o) => { if (o.userData.highlight) overlays.push(o); });
    const faceAfter = { selected: cadViewer.state().selected, overlays: overlays.length, path: facePath,
      shared: overlays.every((o) => o.geometry.getAttribute('position') === o.parent.geometry.getAttribute('position'))
    };
    return { faceAfter, allClosed, disabledEmpty, enabledSelected, backend: meshing?.backend, pageTessellation,
      before, after,
      triangles: [triangles, viewer.stats().triangles], zoomAfter, lost, tree: [treeBefore, treeAfter],
      tinted: [tintedBefore, tintedAfter], detailsAfter };
  })()`) as { after: { detailsAfter: { shown: string; fresh: string };
    faceAfter: { selected: string[]; overlays: number; shared: boolean; path: string };
    tinted: boolean[]; allClosed: boolean; disabledEmpty: boolean; enabledSelected: boolean;
    backend?: string;
    pageTessellation: boolean; triangles: number[]; zoomAfter: boolean; before: Record<string, unknown>;
    after: Record<string, unknown>; tree: { expanded: string[]; top?: [string, number]; rows: boolean }[];
    lost: { status: string; paths: string[];
    notRestored?: { hidden: string[]; selected: string[] } } } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.allClosed, `folders closed at first: ${j}`);
  expect(a.disabledEmpty && a.enabledSelected && a.zoomAfter, `zoom selected: ${j}`);
  expect(/^occt /.test(a.backend ?? '') && !a.pageTessellation, `the import worker: ${j}`);
  expect(a.triangles[0]! > 0 && a.triangles[1]! > 0 && a.triangles[0] !== a.triangles[1], `meshed anew: ${j}`);
  const kept = ['camera', 'centered', 'cut', 'hidden', 'selected'] as const;
  for (const k of kept) {
    expect(JSON.stringify(a.before[k]) === JSON.stringify(a.after[k]), `${k} kept: ${JSON.stringify(a.before[k])} `
      + `then ${JSON.stringify(a.after[k])}`);
  }
  expect(a.detailsAfter.fresh !== '' && a.detailsAfter.shown === a.detailsAfter.fresh, `the details, after: ${
    JSON.stringify(a.detailsAfter)}`);
  const f = a.faceAfter;
  expect(f.selected.join() === f.path && f.overlays === 1 && f.shared, `a selected face, after: ${JSON.stringify(f)}`);
  expect(a.tinted[0] === true && a.tinted[1] === true, `the selection highlighted in the 3D view, before and after: ${
    JSON.stringify(a.tinted)}`);
  expect((a.after.hidden as string[]).length === 1 && (a.after.selected as string[]).length === 1 &&
    a.after.centered === true && 'x' in (a.after.cut as object), `the state set: ${j}`);
  const [tb, ta] = a.tree;
  expect(tb!.rows && tb!.expanded.length > 3 && tb!.top?.[1] === 5, `the tree set: ${JSON.stringify(tb)}`);
  expect(JSON.stringify(tb!.expanded) === JSON.stringify(ta!.expanded), `the tree's expansion kept: ${
    JSON.stringify(a.tree)}`);
  expect(JSON.stringify(tb!.top) === JSON.stringify(ta!.top), `the tree's top row kept: ${JSON.stringify(a.tree)}`);
  const l = a.lost;
  expect(/; 1 hidden and 1 selected not found again \(in the console\)$/.test(l.status) &&
    l.notRestored?.hidden.join() === l.paths[0] && l.notRestored?.selected.join() === l.paths[1],
    `not found again: ${JSON.stringify(l)}`);
  return undefined;
});
// Triangle edges (Rendering): all, a wireframe mesh per drawn mesh, sharing its geometry, outside the model (the node
// model, statistics and picking unchanged), a hidden part's and a hidden face's edges not drawn, and they show on
// screen; selected, only the selection's: a part's whole meshes, a face's triangles alone, following the selection.
await check('triangle edges', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const m = viewer.nodes;
    const nodes = m.nodes.length, triangles = viewer.stats().triangles, pick = cadViewer.pickAt(0.3, 0.5)?.path;
    const pixels = async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.width, img.height];
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, c.width, c.height).data;
    };
    const off = await pixels(cadViewer.screenshot());
    cadViewer.apply({ render: { triangleEdges: 'all' } });
    await cadViewer.idle();
    const on = await pixels(cadViewer.screenshot());
    let changed = 0;
    for (let i = 0; i < on.length; i += 4) {
      if (Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) > 30) changed++;
    }
    const meshes = [];
    viewer.display.traverse((o) => { if (o.isMesh && !o.userData.highlight) meshes.push(o); });
    const wires = [...viewer.triangleEdges.group.children];
    const shared = wires.length === meshes.length && wires.every((w, i) => w.geometry === meshes[i].geometry &&
      w.material.wireframe !== false);
    // Where their meshes are.
    const placed = wires.every((w, i) => !w.visible || w.matrixWorld.equals(meshes[i].matrixWorld));
    const unchanged = m.nodes.length === nodes && viewer.stats().triangles === triangles &&
      cadViewer.pickAt(0.3, 0.5)?.path === pick;
    // A part hidden: its meshes' edges not drawn, the others' drawn.
    const part = m.nodes.find((n) => n.kind === 'part');
    const under = new Set();
    part.object.traverse((o) => under.add(o));
    ui.setHidden([part.id], true);
    await cadViewer.idle();
    const partHidden = wires.filter((w, i) => under.has(meshes[i])).every((w) => !w.visible) &&
      wires.some((w, i) => !under.has(meshes[i]) && w.visible) && wires.some((w, i) => under.has(meshes[i]));
    ui.setHidden([part.id], false);
    // A face hidden: its group's edges not drawn.
    ui.setTree({ detail: true });
    const face = m.children(part.id).map((id) => m.nodes[id]).find((n) => n.kind === 'face');
    ui.setHidden([face.id], true);
    await cadViewer.idle();
    const k = meshes.findIndex((x) => Array.isArray(x.material) && x.material.some((y) => !y.visible));
    const invisible = (ms) => ms.map((y, i) => y.visible ? -1 : i).filter((i) => i >= 0).join();
    const faceHidden = k >= 0 && wires[k].visible && invisible(wires[k].material) === invisible(meshes[k].material);
    ui.setHidden([face.id], false);
    await cadViewer.idle();
    // Selected: nothing with nothing selected; a part's meshes whole; a face, its triangles alone.
    cadViewer.apply({ render: { triangleEdges: 'selected' } });
    ui.select([]);
    await cadViewer.idle();
    const none = viewer.triangleEdges.group.children.length;
    ui.select([part.id]);
    await cadViewer.idle();
    const partMeshes = meshes.filter((x) => under.has(x));
    const forPart = [...viewer.triangleEdges.group.children];
    const selectedPart = forPart.length === partMeshes.length && forPart.every((w, i) => w.geometry ===
      partMeshes[i].geometry);
    ui.select([face.id]);
    await cadViewer.idle();
    const forFace = [...viewer.triangleEdges.group.children];
    const host = meshes.find((x) => x.userData.faceRanges && under.has(x));
    const want = host.userData.faceRanges.filter((f) => f.source === face.face.source)
      .reduce((s, f) => s + f.count, 0);
    const selectedFace = forFace.length === 1 && forFace[0].geometry !== host.geometry &&
      forFace[0].geometry.index.count === want && want > 0;
    ui.select([]);
    await cadViewer.idle();
    const cleared = viewer.triangleEdges.group.children.length === 0;
    // GPU instances: an instanced wireframe on the same instance matrices.
    await cadViewer.load('/content/as1-instanced.glb');
    cadViewer.apply({ render: { triangleEdges: 'all' } });
    await cadViewer.idle();
    const inst = [];
    viewer.display.traverse((o) => { if (o.isInstancedMesh) inst.push(o); });
    const iw = viewer.triangleEdges.group.children.filter((w) => w.isInstancedMesh);
    const instanced = inst.length > 0 && iw.length === inst.length && iw.every((w, i) =>
      w.instanceMatrix === inst[i].instanceMatrix && w.count === inst[i].count && w.visible);
    return { placed, instanced, none, selectedPart, selectedFace, cleared, changed, total: on.length / 4, shared,
      unchanged, partHidden, faceHidden, wires: wires.length };
  })()`) as { after: { changed: number; total: number; shared: boolean; unchanged: boolean; partHidden: boolean;
    faceHidden: boolean; wires: number; none: number; selectedPart: boolean; selectedFace: boolean;
    cleared: boolean; placed: boolean; instanced: boolean } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.shared && a.wires > 0 && a.placed, `a wireframe per mesh, its geometry shared, where it is: ${j}`);
  expect(a.instanced, `GPU instances: ${j}`);
  expect(a.unchanged, `the model, its statistics and picking unchanged: ${j}`);
  expect(a.partHidden && a.faceHidden, `hidden parts and faces: ${j}`);
  expect(a.changed > a.total * 0.01, `drawn: ${j}`);
  expect(a.none === 0 && a.selectedPart && a.selectedFace && a.cleared, `the selection's: ${j}`);
  return undefined;
});
await check('no model', async () => {
  const r = await page('?check');
  expect(r.empty === true, `report ${JSON.stringify(r)}`);
  return undefined;
});
// The controls flush right. A new model: the tree panel closed with no model, open once one loads, and kept closed
// for later models once closed by hand; section planes back to their defaults (all off) for each model, the controls
// too.
await check('new model', async () => {
  const r = await page('?check', `(async () => {
    const closed = () => document.body.classList.contains('tree-closed');
    const load = async (name) => viewer.load({ name, bytes: await (await fetch('/content/' + name)).arrayBuffer() });
    const empty = closed();
    const gui = document.querySelector('.lil-gui.root').getBoundingClientRect();
    const flush = Math.abs(gui.right - document.documentElement.clientWidth) < 0.5;
    await load('as1.glb');
    const loaded = closed();
    const control = (name) => [...document.querySelectorAll('.lil-gui .controller')]
      .find((c) => c.textContent.includes(name)).querySelector('input');
    control('Show the tree').click();
    const byHand = closed();
    control('Cut along X').click();
    control('Flip Y').click();
    control('Caps on closed parts').click();
    const cutting = viewer.sections.get();
    await load('as1-noedges.glb');
    const s = viewer.sections.get();
    const reset = !s.x.on && !s.y.on && !s.z.on && !s.x.flip && !s.y.flip && s.caps &&
      viewer.renderer.clippingPlanes.length === 0 && !control('Cut along X').checked && !control('Flip Y').checked &&
      control('Caps on closed parts').checked;
    return { flush, empty, loaded, byHand, again: closed(), cutting: cutting.x.on && cutting.y.flip && !cutting.caps,
      reset };
  })()`) as { after: { flush: boolean; empty: boolean; loaded: boolean; byHand: boolean; again: boolean;
    cutting: boolean; reset: boolean } };
  const a = r.after;
  expect(a.flush && a.empty && !a.loaded && a.byHand && a.again && a.cutting && a.reset, JSON.stringify(a));
  return undefined;
});
// The tree panel's width: its handle dragged 100 pixels right (real mouse events) widens the panel and narrows the
// view by as much, and is remembered; a double click goes back to the default (300 pixels), forgotten.
await check('tree width', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
  const widths = `new Promise((r) => setTimeout(r, 200)).then(() => ({
    side: document.getElementById('side').getBoundingClientRect().width,
    view: viewer.renderer.domElement.getBoundingClientRect().width,
    saved: localStorage.getItem('cad-viewer.side') }))`;
  type Widths = { side: number; view: number; saved: string | null };
  const r = await page(`?url=${encodeURIComponent('/content/as1.glb')}&check`, `(() => {
    localStorage.removeItem('cad-viewer.side');
    const h = document.getElementById('side-handle').getBoundingClientRect();
    return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
  })()`, { then: async (sessionId, after) => {
    const { x, y } = after as { x: number; y: number };
    const mouse = (type: string, at: number, extra: object = {}) => send('Input.dispatchMouseEvent', { type, x: at,
      y, button: 'left', ...extra }, sessionId);
    const before = await evaluate(sessionId, widths) as Widths;
    await mouse('mouseMoved', x, { button: 'none' });
    await mouse('mousePressed', x, { buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 4; k++) await mouse('mouseMoved', x + 25 * k, { buttons: 1 });
    await mouse('mouseReleased', x + 100, { clickCount: 1 });
    const dragged = await evaluate(sessionId, widths) as Widths;
    const at = x + 100;
    await mouse('mousePressed', at, { buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', at, { clickCount: 1 });
    await mouse('mousePressed', at, { buttons: 1, clickCount: 2 });
    await mouse('mouseReleased', at, { clickCount: 2 });
    const reset = await evaluate(sessionId, widths) as Widths;
    return { before, dragged, reset };
  } }) as { then: { before: Widths; dragged: Widths; reset: Widths } };
  const { before, dragged, reset } = r.then;
  const j = JSON.stringify(r.then);
  const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
  // The panel's box is --side plus its 1-pixel border.
  expect(before.side === 301 && before.saved === null, `before: ${j}`);
  expect(dragged.side === 401 && near(dragged.view, before.view - 100) && dragged.saved === '400',
    `dragged: ${j}`);
  expect(reset.side === 301 && near(reset.view, before.view) && reset.saved === null, `reset: ${j}`);
  return undefined;
});
// The tree scrolls sideways when names don't fit: rows as wide as their content (no ellipsis), all as wide as the
// widest drawn so far (scrolling down and back doesn't change the range); with room enough, no horizontal scroll
// bar, and rows as wide as the panel.
await check('tree scrolls sideways', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const frames = async () => { for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(r)); };
    const scroller = document.querySelector('.tree-scroller');
    const look = () => {
      const rows = [...scroller.querySelectorAll('.tree-row')].filter((r) => r.style.display !== 'none');
      const clipped = rows.filter((r) => { const n = r.querySelector('.tree-name'); return n.scrollWidth > n.clientWidth
        || n.getBoundingClientRect().right > r.getBoundingClientRect().right; }).length;
      return { overflow: scroller.scrollWidth > scroller.clientWidth, clipped, rows: rows.length,
        widths: new Set(rows.map((r) => r.offsetWidth)).size, range: scroller.scrollWidth,
        fill: rows.every((r) => r.offsetWidth >= scroller.clientWidth) };
    };
    ui.setTree({ open: true, detail: true });
    ui.panel().expandAll();
    document.documentElement.style.setProperty('--side', '140px');
    await frames();
    const narrow = look();
    scroller.scrollLeft = scroller.scrollWidth;
    await frames();
    const scrolled = scroller.scrollLeft > 0;
    // Down the tree and back: the widest so far kept.
    const ranges = [narrow.range];
    for (const top of [scroller.scrollHeight / 2, scroller.scrollHeight, 0]) {
      scroller.scrollTop = top;
      await frames();
      ranges.push(look().range);
    }
    document.documentElement.style.setProperty('--side', '900px');
    await frames();
    return { narrow, scrolled, ranges, wide: look() };
  })()`) as { after: { narrow: { overflow: boolean; widths: number; clipped: number; rows: number };
    scrolled: boolean; ranges: number[];
    wide: { overflow: boolean; widths: number; clipped: number; fill: boolean } } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.narrow.rows > 10 && a.narrow.overflow && a.scrolled && a.narrow.clipped === 0 && a.narrow.widths === 1,
    `narrow: ${j}`);
  const rs = a.ranges;
  expect(rs.every((x, i) => i === 0 || x >= rs[i - 1]!) && new Set(rs).size > 1 && rs.at(-1) === Math.max(...rs),
    `the range kept while scrolling down and back: ${j}`);
  expect(!a.wide.overflow && a.wide.clipped === 0 && a.wide.widths === 1 && a.wide.fill, `wide: ${j}`);
  return undefined;
});
// The status line fades 5 s after it last changed, and comes back when it changes; the details too, but only while
// nothing is selected. Select all (Selection) selects what a click could at the pick level, leaving out what's hidden.
await check('auto hide and select all', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const status = document.getElementById('status'), details = document.getElementById('details');
    const faded = (el) => el.classList.contains('faded');
    const button = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    const out = { statusAtFirst: faded(status) };
    ui.say('one');
    await wait(4000);
    out.statusAt4 = faded(status);
    await wait(1600);
    out.statusAt56 = faded(status);
    // Gone from the screen once its fade has run (0.6 s; waited for, up to 3 s, as a loaded machine runs it late).
    for (let t = 0; t < 30 && getComputedStyle(status).opacity !== '0'; t++) await wait(100);
    out.statusOpacity = getComputedStyle(status).opacity;
    ui.say('one');
    out.sameText = faded(status);
    ui.say('two');
    out.newText = faded(status);
    button('Details').setValue(true);
    out.detailsShown = !details.hidden && !faded(details);
    await wait(5600);
    out.detailsNothing = faded(details);
    // Off and on again, faded, the text the same: shown again.
    button('Details').setValue(false);
    button('Details').setValue(true);
    out.detailsReshown = !faded(details);
    const m = viewer.nodes;
    const parts = m.nodes.filter((n) => n.kind === 'part');
    ui.select([parts[0].id]);
    out.detailsSelected = faded(details);
    await wait(5600);
    out.detailsKept = faded(details);
    // Select all at each level, one part hidden.
    ui.setHidden([parts[0].id], true);
    const all = (level) => { ui.setPickLevel(level); button('Select all').$button.click(); return [...ui.selected()]; };
    const expanded = ui.panel().expanded().length;
    const part = all('part');
    out.expandedKept = ui.panel().expanded().length === expanded;
    const assembly = all('assembly');
    const detail = all('detail');
    const n = viewer.nodes;
    const kinds = [...new Set(detail.map((id) => n.nodes[id].kind))].sort();
    const shown = parts.slice(1).map((p) => p.id);
    // (Ids change once the tree has detail: compared by path.)
    return { ...out, part, shown, assembly, parents: [...new Set(shown.map((id) => m.nodes[id].parent))],
      detailCount: detail.length, kinds, shownPaths: shown.map((id) => m.pathOf(id)).sort(),
      detailParents: [...new Set(detail.map((id) => n.pathOf(n.nodes[id].parent)))].sort(),
      detailHidden: detail.filter((id) => n.hiddenInTree(id)).length, tree: cadViewer.state().tree };
  })()`) as { after: Record<string, unknown> & { part: number[]; shown: number[]; assembly: number[];
    parents: number[]; detailCount: number; kinds: string[]; shownPaths: string[]; detailParents: string[];
    detailHidden: number;
    tree: { detail: boolean } } };
  const a = r.after;
  const j = JSON.stringify({ ...a, part: a.part.length, shown: a.shown.length });
  expect(a.statusAt4 === false && a.statusAt56 === true && a.statusOpacity === '0' && a.sameText === true &&
    a.newText === false,
    `the status line: ${j}`);
  expect(a.detailsShown === true && a.detailsNothing === true && a.detailsSelected === false &&
    a.detailsKept === false && a.detailsReshown === true, `the details: ${j}`);
  expect(a.expandedKept === true, `select all leaves the tree's expansion: ${j}`);
  expect(JSON.stringify([...a.part].sort()) === JSON.stringify([...a.shown].sort()), `select all, parts: ${j}`);
  expect(JSON.stringify([...a.assembly].sort()) === JSON.stringify([...a.parents].sort()), `assemblies: ${j}`);
  expect(a.tree.detail && a.detailCount > a.shown.length && a.kinds.includes('face') && a.detailHidden === 0 &&
    JSON.stringify(a.detailParents) === JSON.stringify(a.shownPaths), `detail: ${j}`);
  return undefined;
});
// About... (File): the authors, Claude first; the license; the repository's link; in a build, licenses.md's, which
// is there.
await check('about', async () => {
  const r = await page('?check', `(async () => {
    await cadViewer.ready;
    ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
    const d = await new Promise((res) => { const f = () => { const e = document.querySelector('dialog.cv-dialog[open]');
      if (e) res(e); else setTimeout(f, 50); }; f(); });
    const links = [...d.querySelectorAll('a')].map((a) => ({ href: a.href, target: a.target, rel: a.rel }));
    const licenses = links.find((l) => /licenses\.md$/.test(l.href));
    const status = licenses ? (await fetch(licenses.href)).status : undefined;
    const text = d.textContent;
    d.querySelector('button').click();
    await new Promise((res) => setTimeout(res, 100));
    return { title: d.querySelector('h2').textContent, text, links, status, closed: !d.isConnected };
  })()`) as { after: { title: string; text: string; links: { href: string; target: string; rel: string }[];
    status?: number; closed: boolean } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.title === 'cad-io-js CAD viewer' && /By Claude \(Anthropic\) and Marsette Vona\./.test(a.text) &&
    /Apache-2\.0/.test(a.text) && /LGPL-2\.1/.test(a.text) && /CC BY-SA 4\.0/.test(a.text), `the text: ${j}`);
  expect(a.links.some((l) => l.href === 'https://github.com/martyvona/cad-io-js') &&
    a.links.every((l) => l.target === '_blank' && l.rel === 'noopener'), `the links: ${j}`);
  expect(base === '/' ? a.status === undefined : a.status === 200, `licenses.md (a build's only): ${j}`);
  expect(a.closed, `closed: ${j}`);
  return undefined;
});
// The theme (View's Theme): auto (the default) follows the system's preference as it changes; light and dark hold
// whatever it is. The page's colours (the tree panel's, lil-gui's), the browser's toolbar colour and the 3D view's
// background follow, drawn at once; a choice is remembered, so a new page starts with it (index.html's inline
// script), and auto forgets it.
await check('theme', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
  const system = (sessionId: string, light: boolean) => send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: light ? 'light' : 'dark' }] }, sessionId);
  const look = `({ theme: document.documentElement.dataset.theme ?? 'dark',
    panel: getComputedStyle(document.getElementById('side')).backgroundColor,
    gui: getComputedStyle(document.querySelector('.lil-gui.root')).backgroundColor,
    bar: document.querySelector('meta[name="theme-color"]').content,
    view: viewer.scene.background.getHex(), saved: localStorage.getItem('cad-viewer.theme'),
    control: ui.gui.controllersRecursive().find((c) => c._name === 'Theme').getValue(),
    systemLight: matchMedia('(prefers-color-scheme: light)').matches })`;
  const later = `new Promise((r) => setTimeout(r, 200)).then(() => ${look})`;
  // (Drawn again at once: the frames drawn after the change counted.)
  const set = (choice: string) => `(async () => { await cadViewer.idle();
    let drawn = 0; const draw = viewer.draw; viewer.draw = function () { drawn++; return draw.call(this); };
    ui.gui.controllersRecursive().find((c) => c._name === 'Theme').setValue('${choice}');
    await cadViewer.idle(); viewer.draw = draw; return { ...${look}, drawn }; })()`;
  type Look = { theme: string; panel: string; gui: string; bar: string; view: number; saved: string | null;
    control: string; systemLight: boolean; drawn?: number };
  const first = await page('?check', `(async () => { await cadViewer.ready;
    localStorage.removeItem('cad-viewer.theme'); return ${look}; })()`, { then: async (sid, fresh) => {
    const out: Record<string, unknown> = {};
    await system(sid, false);
    out.autoDark = await evaluate(sid, later);
    await system(sid, true);
    out.autoLight = await evaluate(sid, later);
    out.dark = await evaluate(sid, set('dark'));
    await system(sid, false);
    out.light = await evaluate(sid, set('light'));
    // Last, the opposite of a new page's system (left unemulated), to see it remembered there.
    out.kept = (fresh as Look).systemLight ? 'dark' : 'light';
    out.chosen = await evaluate(sid, set(out.kept as string));
    return out;
  } }) as { after: Look; then: { autoDark: Look; autoLight: Look; dark: Look; light: Look; kept: string;
    chosen: Look } };
  // The theme when the page is parsed, before the app's modules run (index.html's inline script's alone).
  const early = `document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive')
    window.earlyTheme = document.documentElement.dataset.theme ?? 'dark'; });`;
  const again = await page('?check', `(async () => { await cadViewer.ready; return { early: window.earlyTheme,
    reloaded: ${look}, auto: await ${set('auto')} }; })()`, { first: early }) as { after: { early: string;
    reloaded: Look; auto: Look } };
  // A new page, nothing remembered, the system emulated light: light before the modules run.
  const fresh = await page('?check', `(async () => { await cadViewer.ready; return window.earlyTheme; })()`, {
    first: early, light: true }) as { after: string };
  const t = first.then;
  const j = JSON.stringify({ fresh: first.after, ...t, ...again.after });
  // (lil-gui's own dark background, #1f1f1f, and its documented light one.)
  const dark = (l: Look) => l.theme === 'dark' && l.panel === 'rgb(31, 31, 31)' && l.gui === 'rgb(31, 31, 31)' &&
    l.bar === '#1f1f1f' && l.view === 0x404040;
  const light = (l: Look) => l.theme === 'light' && l.panel === 'rgb(244, 244, 244)' &&
    l.gui === 'rgb(246, 246, 246)' && l.bar === '#f4f4f4' && l.view === 0xd9d9d9;
  const as = (l: Look, theme: string) => theme === 'light' ? light(l) : dark(l);
  const f = first.after;
  expect(f.control === 'auto' && f.saved === null && as(f, f.systemLight ? 'light' : 'dark'), `auto at first: ${j}`);
  expect(dark(t.autoDark) && light(t.autoLight) && t.autoLight.control === 'auto', `auto follows the system: ${j}`);
  expect(dark(t.dark) && t.dark.saved === 'dark' && t.dark.systemLight && t.dark.drawn! > 0, `dark, the system light: ${
    j}`);
  expect(light(t.light) && t.light.saved === 'light' && !t.light.systemLight, `light, the system dark: ${j}`);
  const r = again.after.reloaded;
  expect(as(r, t.kept) && r.control === t.kept && r.systemLight === (t.kept === 'dark') &&
    again.after.early === t.kept, `remembered, from the first paint: ${j}`);
  expect(fresh.after === 'light', `auto, a light system, from the first paint: ${JSON.stringify(fresh.after)}`);
  const a = again.after.auto;
  expect(as(a, a.systemLight ? 'light' : 'dark') && a.control === 'auto' && a.saved === null, `auto again: ${j}`);
  return undefined;
});
// Caps on a part whose faces are meshes of their own (faces.glb: a box, a primitive per face): capped as one solid,
// one cap; the cap drawn where the plane cuts it.
await check('caps on a part of several meshes', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/faces.glb')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const meshes = [];
    viewer.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const st = viewer.sections.get();
    st.z.on = true;
    ui.setSections(st);
    await cadViewer.idle();
    return { meshes: meshes.length, caps: viewer.sections.caps.length };
  })()`) as { after: { meshes: number; caps: number } };
  expect(r.after.meshes === 6 && r.after.caps === 1, JSON.stringify(r.after));
  return undefined;
});
// The version in the controls' title and in About: the repository's (its root package.json's); a build adds the
// commit's first 7 hex digits (and -dirty with uncommitted changes).
await check('version', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const release = (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version: string }).version;
  const want = base === '/' ? release : `${release}-${git('rev-parse', '--short=7', 'HEAD')}${
    git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : ''}`;
  const r = await page('?check', `(async () => {
    await cadViewer.ready;
    const title = document.querySelector('.lil-gui.root > .title').textContent;
    ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
    const d = await new Promise((res) => { const f = () => { const e = document.querySelector('dialog.cv-dialog[open]');
      if (e) res(e); else setTimeout(f, 50); }; f(); });
    const about = d.textContent;
    d.querySelector('button').click();
    return { title, about };
  })()`) as { after: { title: string; about: string } };
  expect(r.after.title === `cad-io-js ${want}` && r.after.about.includes(`Version ${want}.`),
    `wanted ${want}: ${JSON.stringify(r.after)}`);
  return undefined;
});
// The automation interface (src/automation.ts) and links: nodes by path, select, hide and show by path, a pick and a
// screenshot; a view (top, a cut, AO off, a hidden part, a selected face) taken as a link and opened in another page
// gives the same state; with ?deterministic one pixel per CSS pixel at any screen scale, and screenshots that repeat.
type State = { camera: { position: number[]; target: number[]; up: number[]; height: number }; cut: object;
  render: { ao: boolean }; hidden: string[]; selected: string[]; tree: object; model?: { triangles: number } };
await check('automation', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const nodes = cadViewer.nodes();
    const parts = nodes.filter((n) => n.kind === 'part').map((n) => n.path);
    const missing = cadViewer.select([parts[0], 'nowhere/at/all']);
    const selected = cadViewer.state().selected;
    cadViewer.hide([parts[1]]);
    const hidden = cadViewer.state().hidden;
    cadViewer.show([parts[1]]);
    const shown = cadViewer.state().hidden;
    cadViewer.view('iso');
    const pick = cadViewer.pickAt(0.5, 0.5);
    // Off the centre: the point pickAt names is the viewer's at the same place, from the view's top left.
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const offCentre = [[0.3, 0.3], [0.6, 0.7], [0.45, 0.62], [0.7, 0.4]].map(([x, y]) => {
      const a = cadViewer.pickAt(x, y), b = viewer.pickAt(rect.left + x * rect.width, rect.top + y * rect.height);
      return !a === !b && (!a || a.point.every((v, k) => Math.abs(v - b.point.getComponent(k)) < 1e-6));
    });
    const shot = cadViewer.screenshot();
    // Drawn when asked for: another view at once, another picture.
    cadViewer.view('top');
    const other = cadViewer.screenshot();
    cadViewer.view('iso');
    // A view to link: top, a cut, no AO, a part hidden, a face selected (a path below a part, detail not shown).
    const face = parts[2] + '/face#' + viewer.nodes.nodes[viewer.nodes.find(parts[2])].object.children[0]
      .userData.faces[0];
    const problems = cadViewer.apply({ view: 'top', cut: { x: { at: 50, flip: true } }, render: { ao: false },
      hidden: [parts[3]], selected: [face] });
    await cadViewer.idle();
    // The controls follow.
    const control = (name) => [...document.querySelectorAll('.lil-gui .controller')]
      .find((c) => c.textContent.includes(name)).querySelector('input').checked;
    const controls = [control('Cut along X'), control('Flip X'), control('Ambient occlusion')];
    return { controls, version: cadViewer.version, count: nodes.length, unique: new Set(nodes.map((n) => n.path)).size,
      parts, missing, selected, hidden, shown, pick, shot: shot.slice(0, 30), shotLength: shot.length, problems,
      offCentre, redrawn: other !== shot,
      face, state: cadViewer.state(), link: cadViewer.link() };
  })()`) as { after: { version: number; count: number; unique: number; parts: string[]; missing: string[];
    selected: string[]; hidden: string[]; shown: string[]; pick?: { path: string }; shot: string; shotLength: number;
    problems: string[]; face: string; state: State; link: string; controls: boolean[]; offCentre: boolean[];
    redrawn: boolean } };
  const a = r.after;
  const j = JSON.stringify({ ...a, state: undefined });
  expect(a.version === 1 && a.count === a.unique && a.parts.length >= 4, `nodes: ${j}`);
  expect(a.missing.length === 1 && /nowhere/.test(a.missing[0]!) && a.selected[0] === a.parts[0], `select: ${j}`);
  expect(a.hidden.includes(a.parts[1]!) && !a.shown.includes(a.parts[1]!), `hide and show: ${j}`);
  expect(!!a.pick && a.pick.path.startsWith(a.parts[0]!.split('/')[0]!), `pick: ${j}`);
  expect(a.offCentre.every((x) => x), `pickAt off the centre: ${j}`);
  expect(a.shot.startsWith('data:image/png;base64,') && a.shotLength > 10_000 && a.redrawn, `screenshot: ${j}`);
  expect(a.problems.length === 0 && a.state.selected[0] === a.face && a.state.hidden.includes(a.parts[3]!) &&
    a.state.render.ao === false && JSON.stringify(a.state.cut) === '{"x":{"at":50,"flip":true}}', `apply: ${j}`);
  expect(JSON.stringify(a.controls) === '[true,true,false]', `the controls: ${j}`);
  // The link, opened in a new page: the same state.
  const linked = await page(a.link.slice(a.link.indexOf('?')) + '&check', `cadViewer.ready.then(() => cadViewer.idle())
    .then(() => cadViewer.state())`) as { after: State };
  const b = linked.after;
  const near = (x: number[], y: number[]) => x.every((v, k) => Math.abs(v - y[k]!) < 1e-4);
  const sa = a.state;
  expect(near(b.camera.position, sa.camera.position) && near(b.camera.target, sa.camera.target) &&
    near(b.camera.up, sa.camera.up) && Math.abs(b.camera.height - sa.camera.height) < 1e-4,
    `linked camera: ${JSON.stringify([b.camera, sa.camera])}`);
  expect(JSON.stringify([b.cut, b.render.ao, b.hidden, b.selected, b.tree]) === JSON.stringify([sa.cut,
    sa.render.ao, sa.hidden, sa.selected, sa.tree]), `linked state: ${JSON.stringify([b, sa])}`);
  return undefined;
});
// ?model= reads its value as Load URL... reads what's typed (sources.ts): a relative path within the content root
// (content/ beside the page), a path on the server or a URL; refused paths (leaving the root, empty, with empty or
// `.` segments) said in the status line; ?url= the same, for older links, and model winning when both are given. Copy
// link names a model by model=, by its path in the content root where it's below it.
await check('content paths', async () => {
  const status = `document.getElementById('status').textContent`;
  const bad: string[] = [];
  for (const m of ['../as1.glb', 'sub/../as1.glb', './as1.glb', 'a//as1.glb', '']) {
    const r = await page(`?model=${encodeURIComponent(m)}&url=${encodeURIComponent('/content/as1.glb')}&check`,
      `cadViewer.ready.then(() => ({ model: cadViewer.state().model?.name, status: ${status} }))`) as
      { after: { model?: string; status: string } };
    if (r.after.model || !/not a URL nor a path within the content root/.test(r.after.status)) bad.push(`${m}: ${
      JSON.stringify(r.after)}`);
  }
  expect(bad.length === 0, `refused: ${bad.join('; ')}`);
  const opened = async (q: string) => (await page(`${q}&check`, `cadViewer.ready.then(() => ({ model:
    cadViewer.state().model?.name, url: ui.currentUrl(), link: cadViewer.link(), status: ${status} }))`) as
    { after: { model?: string; url?: string; link: string; status: string } }).after;
  const linked = (a: { link: string }) => new URL(a.link).searchParams;
  const root = `http://localhost:${port}${base}content/`;
  // In a directory, with characters a URL encodes: loaded, and linked by the same path.
  const odd = 'sub dir/as1 #1%.glb';
  const o = await opened(`?model=${encodeURIComponent(odd)}`);
  expect(o.model === 'as1 #1%.glb' && linked(o).get('model') === odd && !linked(o).has('url'),
    `an encoded name: ${JSON.stringify(o)}`);
  // Both given: model wins, said.
  const both = await opened(`?model=as1.glb&url=${encodeURIComponent('/content/as1-noedges.glb')}`);
  expect(both.model === 'as1.glb' && both.url === root + 'as1.glb' && /model and url both given: url ignored/.test(
    both.status), `both: ${JSON.stringify(both)}`);
  // A path on the server (the dev server's content root, or for a build, outside its own): linked by its path in
  // the content root where it's below it, else by its path on the server.
  const server = await opened(`?model=${encodeURIComponent('/content/as1.glb')}`);
  expect(server.model === 'as1.glb' && linked(server).get('model') === (base === '/' ? 'as1.glb'
    : '/content/as1.glb'), `a server path: ${JSON.stringify(server)}`);
  // url= alone: the same reading (a relative path is in the content root).
  const alias = await opened('?url=as1-noedges.glb');
  expect(alias.model === 'as1-noedges.glb' && alias.url === root + 'as1-noedges.glb' &&
    linked(alias).get('model') === 'as1-noedges.glb', `url= alone: ${JSON.stringify(alias)}`);
  const r = await page('?model=as1.glb&check', `(async () => {
    await cadViewer.ready;
    const out = {};
    const until = async (f, what) => {
      for (const end = Date.now() + 60000; Date.now() < end;) {
        const v = f();
        if (v) return v;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error('timed out waiting for ' + what);
    };
    const load = async (typed) => {
      ui.say('');
      [...document.querySelectorAll('.lil-gui .controller')].find((c) => c.textContent.trim() === 'Load URL...')
        .querySelector('button').click();
      const d = await until(() => document.querySelector('dialog.cv-dialog[open]'), 'the dialog');
      d.querySelector('input').value = typed;
      [...d.querySelectorAll('button')].find((b) => b.textContent === 'Load').click();
      await until(() => !d.isConnected, 'the dialog to close');
      await cadViewer.idle();
      return { model: cadViewer.state().model?.name, url: ui.currentUrl(), status: ${status} };
    };
    out.relative = await load('as1-noedges.glb');
    out.server = await load('/content/as1.glb');
    out.absolute = await load(new URL('content/as1-noedges.glb', document.baseURI).href);
    out.bad = await load('../as1.glb');
    return out;
  })()`) as { after: Record<string, { model?: string; url?: string; status: string }> };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.relative?.model === 'as1-noedges.glb' && a.relative.url === root + 'as1-noedges.glb', `relative: ${j}`);
  expect(a.server?.model === 'as1.glb' && new URL(a.server.url!, root).href ===
    `http://localhost:${port}/content/as1.glb`, `a server path: ${j}`);
  expect(a.absolute?.model === 'as1-noedges.glb', `a URL: ${j}`);
  expect(a.bad?.model === 'as1-noedges.glb' && /not a URL nor a path within the content root/.test(a.bad.status),
    `refused in Load URL...: ${j}`);
  return undefined;
});
await check('deterministic', async () => {
  const shots = `cadViewer.ready.then(() => cadViewer.idle()).then(() => { cadViewer.view('iso');
    const a = cadViewer.screenshot(), b = cadViewer.screenshot(), c = viewer.renderer.domElement;
    return { same: a === b, ratio: c.width / c.clientWidth, dpr: devicePixelRatio }; })`;
  const go = (q: string) => page(`?url=${encodeURIComponent('/content/as1.glb')}&check${q}`, shots,
    { scale: 2 }) as Promise<{ after: { same: boolean; ratio: number; dpr: number } }>;
  const [plain, fixed] = [(await go('')).after, (await go('&deterministic')).after];
  expect(plain.dpr === 2 && plain.ratio === 2 && fixed.ratio === 1 && fixed.same,
    `${JSON.stringify({ plain, fixed })}`);
  return undefined;
});
// cad-viewer shot (the dev server only): a PNG of the size asked for, and the page's state with the scene's
// triangles.
/**
 * A PNG's top-left pixel, [r, g, b] (8-bit RGB or RGBA, as Chrome writes them): whatever a row's filter, its first
 * pixel's bytes are stored as they are, since the bytes it would be predicted from (left, above) are zero in the
 * first row.
 */
function topLeftPixel(png: Buffer): number[] {
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return [raw[1]!, raw[2]!, raw[3]!];
}

// cad-viewer shot: dark by default (the viewer's Auto theme, with headless Chrome told the system is dark), light by
// --theme, or a background of its own by --background (the background in the PNG's corner).
if (!staticServer) await check('shot', async () => {
  const png = path.join(tmp, 'shot.png'), json = path.join(tmp, 'shot.json');
  const out: string[] = [];
  const code = await main(['shot', path.join(content, 'as1.stp'), '-o', png, '--size', '1000x600', '--view', 'top',
    '--json', json, '--content-root', content, '--port', String(port)], { ...io, out: (s) => out.push(s),
    err: (s) => out.push(s) });
  expect(code === 0, `exit ${code}: ${out.join('')}`);
  const bytes = fs.readFileSync(png);
  const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  const report = JSON.parse(fs.readFileSync(json, 'utf8')) as { state: State; link: string };
  // Wider than a phone, where the tree would open with the model unless shot closes it.
  expect(bytes.subarray(1, 4).toString() === 'PNG' && w === 1000 && h === 600, `png ${w}x${h}`);
  expect(report.state.model?.triangles === triangles && /[?&]model=as1\.stp(&|$)/.test(report.link),
    JSON.stringify(report.state.model));
  expect(topLeftPixel(bytes).join() === '64,64,64', `dark by default: ${topLeftPixel(bytes)}`);
  const lightPng = path.join(tmp, 'shot-light.png');
  const code2 = await main(['shot', path.join(content, 'as1.stp'), '-o', lightPng, '--size', '400x300', '--theme',
    'light', '--content-root', content, '--port', String(port)], { ...io, out: (s) => out.push(s),
    err: (s) => out.push(s) });
  expect(code2 === 0, `exit ${code2}: ${out.join('')}`);
  expect(topLeftPixel(fs.readFileSync(lightPng)).join() === '217,217,217', `light: ${
    topLeftPixel(fs.readFileSync(lightPng))}`);
  // A background of its own (the README's pictures, on white).
  const code3 = await main(['shot', path.join(content, 'as1.stp'), '-o', lightPng, '--size', '400x300', '--background',
    '#ffffff', '--content-root', content, '--port', String(port)], { ...io, out: (s) => out.push(s),
    err: (s) => out.push(s) });
  expect(code3 === 0 && topLeftPixel(fs.readFileSync(lightPng)).join() === '255,255,255', `white: ${
    topLeftPixel(fs.readFileSync(lightPng))}`);
  return undefined;
});
// Recording (src/recorder.ts): a session driven by real input (clicks on parts, shift-click, a drag, a wheel zoom)
// and controls (a switch, a button), recorded from the page's start (?record); its events timed in order, with
// pixels; replayed in a fresh page with nothing diverging; a model from a local file replayed with the file given
// again (and without it, said); and cad-viewer replay (the dev server only).
type Rec = { events: { t: number; type: string; phase?: string; x?: number; y?: number; path?: string | null;
  value?: unknown; url?: string; files?: { sha256?: string }[]; side?: number }[];
  view: { width: number; height: number };
  side?: number };
await check('recording', async () => {
  let recording: Rec | undefined;
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&record`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    // Two points on two parts, from the view's top left.
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const spots = [];
    for (let gy = 1; gy < 20 && spots.length < 2; gy++) for (let gx = 1; gx < 20 && spots.length < 2; gx++) {
      const p = cadViewer.pickAt(gx / 20, gy / 20);
      if (p && !spots.some((s) => s.path === p.path)) spots.push({ path: p.path, x: rect.left + gx / 20 * rect.width,
        y: rect.top + gy / 20 * rect.height });
    }
    // Away from the controls' panel, which lies over the view's right side.
    return { spots, left: rect.left, top: rect.top,
      centre: [rect.left + rect.width * 0.3, rect.top + rect.height / 2] };
  })()`, { then: async (sessionId, after) => {
    const { spots, centre } = after as { spots: { x: number; y: number }[]; centre: [number, number] };
    const mouse = (type: string, x: number, y: number, extra: object = {}) => send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: 1, ...extra }, sessionId);
    const pause = () => new Promise((res) => setTimeout(res, 150));
    // Hovering: not recorded.
    await mouse('mouseMoved', centre[0], centre[1], { button: 'none' });
    await mouse('mouseMoved', centre[0] + 5, centre[1] + 5, { button: 'none' });
    // A click on the first part; a shift-click on the second.
    await mouse('mousePressed', spots[0]!.x, spots[0]!.y, { buttons: 1 });
    await mouse('mouseReleased', spots[0]!.x, spots[0]!.y);
    await pause();
    await mouse('mousePressed', spots[1]!.x, spots[1]!.y, { buttons: 1, modifiers: 8 });
    await mouse('mouseReleased', spots[1]!.x, spots[1]!.y, { modifiers: 8 });
    await pause();
    // A drag (the view turns), then a wheel zoom.
    await mouse('mousePressed', centre[0], centre[1], { buttons: 1 });
    for (let k = 1; k <= 6; k++) {
      await mouse('mouseMoved', centre[0] + 15 * k, centre[1] + 5 * k, { buttons: 1 });
      await new Promise((res) => setTimeout(res, 40));
    }
    await mouse('mouseReleased', centre[0] + 90, centre[1] + 30);
    await pause();
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centre[0], y: centre[1], deltaX: 0, deltaY: -120 },
      sessionId);
    await pause();
    // A switch and a button, as clicked.
    const end = await send('Runtime.evaluate', { expression: `(async () => {
      const control = (name) => [...document.querySelectorAll('.lil-gui .controller')]
        .find((c) => c.textContent.trim() === name);
      control('Cut along X').querySelector('input').click();
      await cadViewer.idle();
      control('Zoom all').querySelector('button').click();
      await cadViewer.idle();
      return { rec: cadViewer.record(false), state: cadViewer.state() };
    })()`, returnByValue: true, awaitPromise: true }, sessionId) as { result: { value: { rec: Rec; state: State } } };
    return end.result.value;
  } }) as { then: { rec: Rec; state: State }; after: { spots: { x: number; y: number }[]; left: number;
    top: number } };
  recording = r.then.rec;
  const ev = recording.events;
  const kinds = (type: string) => ev.filter((e) => e.type === type);
  const j = JSON.stringify(ev.map((e) => [e.t, e.type, e.phase ?? e.path ?? e.value ?? e.url ?? '']));
  expect(ev.every((e, k) => k === 0 || e.t >= ev[k - 1]!.t), `times in order: ${j}`);
  // Recorded from the page's start: the (empty) view, then the address's model opened.
  expect(ev[0]!.type === 'state' && ev[1]!.type === 'load' && /as1\.stp/.test(ev[1]!.url ?? '') &&
    kinds('state').length === 2 && ev.at(-1)!.type === 'state', `ends: ${j}`);
  const downs = ev.filter((e) => e.type === 'pointer' && e.phase === 'down');
  expect(downs.length === 3 && downs.every((e) => e.x! > 0 && e.y! > 0 && e.x! < recording!.view.width),
    `pointers with pixels: ${j}`);
  // In the view's pixels, from its top left; timed from the start; no hovering.
  const spot = r.after.spots[0]!;
  expect(Math.abs(downs[0]!.x! - (spot.x - r.after.left)) < 0.01 && Math.abs(downs[0]!.y! - (spot.y - r.after.top)) <
    0.01, `the first press at ${JSON.stringify([downs[0], spot, r.after.left, r.after.top])}`);
  expect(ev[0]!.t < 1000, `the first event at ${ev[0]!.t} ms`);
  const firstDown = ev.indexOf(downs[0]!);
  expect(!ev.slice(0, firstDown).some((e) => e.type === 'pointer'), `hovering recorded: ${j}`);
  expect(ev.some((e) => e.type === 'pointer' && e.phase === 'move') && kinds('wheel').length >= 1 &&
    kinds('camera').length >= 2, `drag, wheel, camera: ${j}`);
  const picks = kinds('pick');
  expect(picks.length === 2 && picks.every((e) => typeof e.path === 'string' && e.x! > 0), `picks: ${j}`);
  expect(ev.some((e) => e.type === 'control' && e.path === 'Section/Cut along X' && e.value === true) &&
    ev.some((e) => e.type === 'control' && e.path === 'View/Zoom all' && e.value === undefined), `controls: ${j}`);
  // Replayed in a fresh page: nothing diverges (picks land where they did, the end state is the same).
  const replayed = await page('?check', `cadViewer.ready.then(() => cadViewer.replay(${JSON.stringify(recording)}))`) as
    { after: { applied: number; divergences: string[] } };
  expect(replayed.after.divergences.length === 0 && replayed.after.applied > 5,
    `replay: ${JSON.stringify(replayed.after)}`);
  // Replayed where the tree panel was dragged wider (remembered in this browser): the recording's width (the
  // default) is put back, so the view is as wide and nothing diverges (cnc-box, 2026-10-25: 262 pixels recorded,
  // replayed at 300).
  const widened = await page('?check', `cadViewer.ready.then(() => {
    document.documentElement.style.setProperty('--side', '400px');
    return cadViewer.replay(${JSON.stringify(recording)});
  })`) as { after: { divergences: string[] } };
  expect(widened.after.divergences.length === 0, `the tree panel's width: ${JSON.stringify(widened.after)}`);
  // Replayed in a view of another size (a larger window): said at the picks.
  const resized = await page('?check', `cadViewer.ready.then(() => cadViewer.replay(${JSON.stringify(recording)}))`,
    { scale: 1 }) as { after: { divergences: string[] } };
  expect(resized.after.divergences.some((d) => /the view is \d+x\d+, recorded \d+x\d+: the pick/.test(d)),
    `another view size: ${JSON.stringify(resized.after)}`);
  // A pick that landed elsewhere when recorded: said.
  const tampered = structuredClone(recording);
  tampered.events.find((e) => e.type === 'pick')!.path = 'somewhere/else';
  const diverged = await page('?check', `cadViewer.ready.then(() => cadViewer.replay(${JSON.stringify(tampered)}))`) as
    { after: { divergences: string[] } };
  expect(diverged.after.divergences.some((d) => /picked .* recorded somewhere\/else/.test(d)),
    `a tampered pick: ${JSON.stringify(diverged.after)}`);
  // A model from a local file: recorded, then replayed with the file given again, and without it.
  const local = await page('?check', `(async () => {
    await cadViewer.ready;
    const file = new File([await (await fetch('/content/as1.glb')).arrayBuffer()], 'as1.glb');
    // Well after the page's start: the recording's times still begin at 0.
    await new Promise((res) => setTimeout(res, 1200));
    // The tree panel dragged to 360 pixels: recorded.
    document.documentElement.style.setProperty('--side', '360px');
    cadViewer.record(true);
    await ui.openFiles([file]);
    await cadViewer.idle();
    cadViewer.hide([cadViewer.nodes().find((n) => n.kind === 'part').path]);
    await new Promise((res) => setTimeout(res, 300));
    // The panel dragged narrower meanwhile (a resize event with its width), then a click at the view's centre: replay
    // must narrow it too, or the click is in a view of another size.
    document.documentElement.style.setProperty('--side', '320px');
    for (let f = 0; f < 3; f++) await new Promise((res) => requestAnimationFrame(res));
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    ui.pickAt(rect.left + rect.width / 2, rect.top + rect.height / 2, false);
    await new Promise((res) => setTimeout(res, 300));
    const rec = cadViewer.record(false);
    return { rec, file: [...new Uint8Array(await file.arrayBuffer())].length };
  })()`) as { after: { rec: Rec } };
  const localRec = local.after.rec;
  expect(localRec.events.some((e) => e.files?.[0]?.sha256?.length === 64), 'the local file hashed');
  expect(localRec.side === 360, `the tree panel's width recorded: ${localRec.side}`);
  expect(localRec.events.some((e) => e.type === 'resize' && e.side === 320) && localRec.events.some((e) =>
    e.type === 'pick'), `the width changed, then a pick: ${JSON.stringify(localRec.events.map((e) => e.type))}`);
  expect(localRec.events[0]!.t < 500, `a later recording's first event at ${localRec.events[0]!.t} ms`);
  // Without its hash (stopped before hashing finished), a file of another size isn't taken for it.
  const unhashed = structuredClone(localRec);
  for (const e of unhashed.events) for (const f of e.files ?? []) delete f.sha256;
  const wrongSize = await page('?check', `cadViewer.ready.then(() => cadViewer.replay(${JSON.stringify(unhashed)},
    { files: [new File([new Uint8Array(10)], 'as1.glb')] }))`) as { after: { divergences: string[] } };
  expect(wrongSize.after.divergences.some((d) => /as1\.glb .* wasn't given/.test(d)),
    `a file of another size: ${JSON.stringify(wrongSize.after)}`);
  const withFile = await page('?check', `(async () => {
    await cadViewer.ready;
    const file = new File([await (await fetch('/content/as1.glb')).arrayBuffer()], 'as1.glb');
    const a = await cadViewer.replay(${JSON.stringify(localRec)}, { files: [file] });
    return a;
  })()`) as { after: { divergences: string[] } };
  expect(withFile.after.divergences.length === 0, `with the file: ${JSON.stringify(withFile.after)}`);
  const without = await page('?check', `cadViewer.ready.then(() => cadViewer.replay(${JSON.stringify(localRec)},
    { files: [new File([new Uint8Array(${fs.statSync(path.join(content, 'as1.glb')).size})], 'as1.glb')] }))`) as
    { after: { divergences: string[] } };
  expect(without.after.divergences.some((d) => /as1\.glb .* wasn't given/.test(d)),
    `without the file: ${JSON.stringify(without.after)}`);
  // cad-viewer replay, headless, at the recorded window's size.
  if (!staticServer) {
    const json = path.join(tmp, 'recording.json'), png = path.join(tmp, 'replay.png');
    fs.writeFileSync(json, JSON.stringify(recording));
    const out: string[] = [];
    const code = await main(['replay', json, '-o', png, '--content-root', content, '--port', String(port)],
      { ...io, out: (s) => out.push(s), err: (s) => out.push(s) });
    expect(code === 0 && fs.existsSync(png) && /as recorded/.test(out.join('')), `cad-viewer replay: exit ${code}: ${
      out.join('')}`);
    // Dark by default, as shot; light by --theme (below).
    expect(topLeftPixel(fs.readFileSync(png)).join() === '64,64,64', `replay, dark: ${topLeftPixel(fs.readFileSync(
      png))}`);
    // The local file found below the content root, by name and size.
    fs.writeFileSync(json, JSON.stringify(localRec));
    const out2: string[] = [];
    const code2 = await main(['replay', json, '-o', png, '--theme', 'light', '--content-root', content, '--port',
      String(port)], { ...io, out: (s) => out2.push(s), err: (s) => out2.push(s) });
    expect(code2 === 0 && /as recorded/.test(out2.join('')), `cad-viewer replay, a local file: exit ${code2}: ${
      out2.join('')}`);
    expect(topLeftPixel(fs.readFileSync(png)).join() === '217,217,217', `replay, light: ${topLeftPixel(
      fs.readFileSync(png))}`);
  }
  return undefined;
});
// Replay recording... in the page (the user, 2026-10-25): only the recording is picked (the picker stubbed here); its
// model is taken as it is if the one open has its hash, else a dialog asks for it (Open file..., Open URL..., the
// recorded URL filled in); a file with another hash isn't loaded, an error dialog says both hashes, and the replay
// stops. And the File folder's Load URL... asks in a dialog (no URL field among the controls).
await check('replay dialogs', async () => {
  const r = await page('?check', `(async () => {
    await cadViewer.ready;
    const until = async (f, what) => {
      for (const end = Date.now() + 60000; Date.now() < end;) {
        const v = f();
        if (v) return v;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error('timed out waiting for ' + what);
    };
    const dialog = () => document.querySelector('dialog.cv-dialog[open]');
    // The open dialog's title and text, then the button pressed (and the field filled first, if given).
    const answer = async (label, input) => {
      const d = await until(dialog, 'a dialog');
      const seen = { title: d.querySelector('h2').textContent, text: d.textContent, input: d.querySelector('input')
        ?.value, error: d.classList.contains('error') };
      if (input !== undefined) d.querySelector('input').value = input;
      [...d.querySelectorAll('button')].find((b) => b.textContent === label).click();
      await until(() => !d.isConnected, 'the dialog to close');
      return seen;
    };
    const picks = [];
    window.showOpenFilePicker = async () => {
      const files = picks.shift();
      if (!files) throw new DOMException('cancelled', 'AbortError');
      return files.map((f) => ({ getFile: async () => f }));
    };
    const control = (name) => [...document.querySelectorAll('.lil-gui .controller')]
      .find((c) => c.textContent.trim() === name);
    const status = () => document.getElementById('status').textContent;
    const replay = (rec) => {
      ui.say('');
      picks.push([new File([JSON.stringify(rec)], 'recording.json')]);
      control('Replay recording...').querySelector('button').click();
    };
    const ended = () => until(() => /^(replayed|replay stopped)/.test(status()) && status(), 'the replay');
    const bytes = async (url) => (await fetch(url)).arrayBuffer();
    const glb = new File([await bytes('/content/as1.glb')], 'as1.glb');
    const other = new File([await bytes('/content/as1-noedges.glb')], 'as1-noedges.glb');
    const record = async () => {
      cadViewer.record(true);
      cadViewer.hide([cadViewer.nodes().find((n) => n.kind === 'part').path]);
      await until(() => { const l = cadViewer.recording().events.find((e) => e.type === 'load');
        return l && (l.sha256 || l.files?.[0]?.sha256); }, 'the hash');
      return cadViewer.record(false);
    };
    const out = {};
    // A recording of a local file, replayed with it open: no dialog.
    await ui.openFiles([glb]);
    const local = await record();
    replay(local);
    out.same = { status: await ended(), dialog: !!dialog() };
    // Another model open: asked for; opened by URL.
    await ui.openFiles([other]);
    replay(local);
    out.asked = await answer('Open URL...');
    out.urlDialog = await answer('Load', '/content/as1.glb');
    out.byUrl = { status: await ended(), model: cadViewer.state().model?.name };
    // A file with another hash: not loaded; said; the replay stops.
    await ui.openFiles([other]);
    replay(local);
    picks.push([other]);
    await answer('Open file...');
    out.wrong = await answer('Close');
    out.wrongEnd = { status: await ended(), model: cadViewer.state().model?.name };
    // Cancelled: stops.
    replay(local);
    await answer('Cancel');
    out.cancelled = await ended();
    // The right file picked: loaded, replayed.
    replay(local);
    picks.push([glb]);
    await answer('Open file...');
    out.byFile = { status: await ended(), model: cadViewer.state().model?.name };
    // A URL loaded while recording: its size and hash recorded (once fetched), the URL filled in.
    await ui.openFiles([other]);
    cadViewer.record(true);
    await ui.openUrl('/content/as1.glb');
    await until(() => cadViewer.recording().events.find((e) => e.url)?.sha256, 'the hash of the URL');
    const byUrl = cadViewer.record(false);
    out.urlLoad = byUrl.events.find((e) => e.url);
    await ui.openFiles([other]);
    replay(byUrl);
    await answer('Open URL...');
    out.filled = await answer('Load');
    out.filledEnd = await ended();
    // Not a recording.
    picks.push([other]);
    control('Replay recording...').querySelector('button').click();
    out.notRecording = await answer('Close');
    // File: no URL field; Load URL... asks.
    out.urlField = !!control('URL');
    control('Load URL...').querySelector('button').click();
    out.loadUrl = await answer('Load', '/content/as1-noedges.glb');
    await until(() => cadViewer.state().model?.name === 'as1-noedges.glb', 'the URL loaded');
    return out;
  })()`) as { after: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const a = r.after;
  const j = JSON.stringify(a);
  expect(!a.error, `the page: ${a.error}`);
  const asRecorded = (s: string | undefined) => /^replayed \d+ of \d+ events; as recorded/.test(s ?? '');
  expect(asRecorded(a.same?.status) && !a.same.dialog, `the model open: ${j}`);
  expect(a.asked?.title === 'Open the recorded model' && /as1\.glb/.test(a.asked.text) && /[0-9a-f]{64}/.test(
    a.asked.text) && /bytes/.test(a.asked.text) && a.urlDialog?.input === '', `asked for: ${j}`);
  expect(asRecorded(a.byUrl?.status) && a.byUrl.model === 'as1.glb', `opened by URL: ${j}`);
  const hashes = (a.wrong?.text ?? '').match(/[0-9a-f]{64}/g) ?? [];
  expect(a.wrong?.error && a.wrong.title === 'Not the recorded model' && /as1-noedges\.glb/.test(a.wrong.text) &&
    new Set(hashes).size === 2, `a wrong file: ${j}`);
  expect(/^replay stopped/.test(a.wrongEnd?.status) && a.wrongEnd.model === 'as1-noedges.glb', `wrong, then: ${j}`);
  expect(/^replay stopped/.test(a.cancelled), `cancelled: ${j}`);
  expect(asRecorded(a.byFile?.status) && a.byFile.model === 'as1.glb', `opened by file: ${j}`);
  expect(/\/content\/as1\.glb$/.test(a.urlLoad?.url) && a.urlLoad.size > 0 && /^[0-9a-f]{64}$/.test(a.urlLoad.sha256),
    `a URL's size and hash recorded: ${j}`);
  expect(/\/content\/as1\.glb$/.test(a.filled?.input) && asRecorded(a.filledEnd), `the URL filled in: ${j}`);
  expect(a.notRecording?.error && a.notRecording.title === 'Not a recording', `not a recording: ${j}`);
  expect(a.urlField === false && a.loadUrl?.title === 'Load URL', `Load URL...: ${j}`);
  return undefined;
});
// Replaying in real time (the page's Replay recording...): a recording made here (two control changes 500 ms apart,
// a drag of 800 ms, a pause of 5.6 s, Mesh again recorded as taking 50 ms, then a control change) keeps the gaps,
// turns the camera through the drag with the pointer shown, cuts the pause to maxPause (1 s), and starts the control
// after Mesh again only once its meshing is done, however long that takes, and the next one its full gap after that
// (not hurrying to catch up); each control shown as it changes (its folder open, the control flashed), the folders
// closed again at the end; a replay stopped early applies no more.
await check('replay in real time', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    viewer.settings.cache = false;
    viewer.setView('front');
    const from = viewer.cameraState();
    viewer.setView('iso');
    const to = viewer.cameraState();
    viewer.setCamera(from);
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const [x, y] = [rect.width * 0.3, rect.height / 2];
    const p = (t, phase, dx = 0) => ({ t, type: 'pointer', phase, x: x + dx, y, id: 1, pointerType: 'mouse',
      button: 0, buttons: phase === 'up' ? 0 : 1, mods: '' });
    const rec = { format: 'cad-viewer-recording', version: 1, started: new Date().toISOString(), userAgent: '',
      page: location.href, window: { width: innerWidth, height: innerHeight, scale: 1 },
      view: { width: rect.width, height: rect.height }, events: [
        { t: 100, type: 'control', path: 'Rendering/Edges', value: false },
        { t: 600, type: 'control', path: 'Rendering/Edges', value: true },
        p(1600, 'down'), p(2000, 'move', 40), { t: 2400, type: 'camera', camera: to }, p(2400, 'up', 80),
        { t: 8000, type: 'control', path: 'Rendering/Ambient occlusion', value: false },
        { t: 8100, type: 'control', path: 'B-Rep Meshing/Mesh again' },
        { t: 8150, type: 'control', path: 'Rendering/Antialiasing (SMAA)', value: false },
        { t: 8650, type: 'control', path: 'Rendering/Shininess', value: 50 },
      ] };
    // What happened when: control changes, the camera and the pointer each frame, the meshing done.
    const log = [];
    const shown = [];
    ui.gui.onChange(({ controller, value }) => {
      log.push([performance.now(), 'control', controller._name, value]);
      // The recording's controls (not those the viewer sets itself, as Mesh again's Center model).
      if (rec.events.some((e) => e.path?.endsWith('/' + controller._name))) shown.push(!controller.parent._closed &&
        controller.domElement.classList.contains('replay-flash'));
    });
    const folders = () => ui.gui.foldersRecursive().map((f) => f._closed).join();
    const foldersBefore = folders();
    let watching = true;
    const model = viewer.model;
    let meshed;
    const watch = () => {
      if (!watching) return;
      const c = viewer.cameraState();
      log.push([performance.now(), 'camera', c.position, document.querySelector('.replay-pointer')?.hidden === false]);
      if (meshed === undefined && viewer.model !== model && viewer.model?.meshing) meshed = performance.now();
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    const t0 = performance.now();
    const report = await cadViewer.replay(rec, { realtime: true, maxPause: 1000 });
    const end = performance.now();
    watching = false;
    const foldersAfter = folders();
    const showing = [...shown];
    // Stopped after the first event.
    const stopping = new AbortController();
    setTimeout(() => stopping.abort(), 350);
    const before = log.length;
    const stopped = await cadViewer.replay(rec, { realtime: true, maxPause: 1000, signal: stopping.signal });
    const after = log.slice(before).filter((l) => l[1] === 'control').length;
    // At full speed too, stopped before it starts.
    const fast = await cadViewer.replay(rec, { signal: AbortSignal.abort() });
    return { showing, foldersBefore, foldersAfter, fast, t0, end, meshed, log, report, from: from.position,
      to: to.position, stopped, after,
      marker: !!document.querySelector('.replay-pointer') };
  })()`) as { after: { t0: number; end: number; meshed?: number; log: [number, string, unknown, unknown][];
    report: { applied: number; aborted?: string }; from: number[]; to: number[];
    stopped: { applied: number; aborted?: string }; after: number; marker: boolean;
    fast: { applied: number; aborted?: string }; showing: boolean[]; foldersBefore: string;
    foldersAfter: string } };
  const a = r.after;
  const at = (name: string, value?: unknown) => a.log.find((l) => l[1] === 'control' && l[2] === name &&
    (value === undefined || l[3] === value))?.[0];
  const rel = (t: number | undefined) => t === undefined ? NaN : Math.round(t - a.t0);
  const times = { edgesOff: rel(at('Edges', false)), edgesOn: rel(at('Edges', true)), ao: rel(at('Ambient occlusion')),
    meshed: rel(a.meshed), smaa: rel(at('Antialiasing (SMAA)')), shininess: rel(at('Shininess')), end: rel(a.end) };
  const j = JSON.stringify({ times, report: a.report, stopped: a.stopped, after: a.after });
  console.log(`replay in real time: ${j}`);
  const close = (t: number, want: number) => Math.abs(t - want) <= 150;
  // The first event no sooner than recorded (later by the replay's own start).
  expect(times.edgesOff >= 90 && times.edgesOff <= 700 && close(times.edgesOn - times.edgesOff, 500),
    `the gaps kept: ${j}`);
  // The drag from 1600 to 2400 ms, the pause after it cut from 5.6 s to 1 s: 2.8 s after the second change, not 7.4.
  expect(close(times.ao - times.edgesOn, 2800), `the pause cut: ${j}`);
  // The drag, 1000 to 1800 ms after the second change.
  const drag = a.log.filter((l) => l[1] === 'camera' && l[0] - a.t0 > times.edgesOn + 1100 &&
    l[0] - a.t0 < times.edgesOn + 1700);
  const dist = (p: number[], q: number[]) => Math.hypot(...p.map((v, i) => v - q[i]!));
  const between = drag.filter((l) => dist(l[2] as number[], a.from) > 1e-3 && dist(l[2] as number[], a.to) > 1e-3);
  expect(drag.length > 10 && between.length > drag.length * 0.8 && drag.every((l) => l[3] === true),
    `the camera turning through the drag, the pointer shown (${between.length} of ${drag.length} frames): ${j}`);
  const last = a.log.filter((l) => l[1] === 'camera').at(-1)!;
  expect(dist(last[2] as number[], a.to) < 1e-6, `the camera where the drag ended: ${JSON.stringify(last)}`);
  expect(times.meshed > times.ao && times.smaa >= times.meshed, `the control after Mesh again waits for it: ${j}`);
  expect(close(times.shininess - times.smaa, 500), `the gap after a late step kept: ${j}`);
  expect(a.report.applied === 7 && !a.report.aborted && !a.marker, `the replay: ${j}`);
  expect(a.stopped.aborted === 'stopped' && a.stopped.applied === 1 && a.after === 1, `stopped: ${j}`);
  expect(a.showing.length === 5 && a.showing.every(Boolean) && a.foldersBefore.includes('true') &&
    a.foldersAfter === a.foldersBefore, `controls shown: ${JSON.stringify([a.showing, a.foldersBefore,
    a.foldersAfter])}`);
  expect(a.fast.aborted === 'stopped' && a.fast.applied === 0, `stopped at full speed: ${JSON.stringify(a.fast)}`);
  return undefined;
});
await check('not a model', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/notes.txt')}&check`);
  expect(typeof r.error === 'string' && /unknown format/.test(r.error), `report ${JSON.stringify(r)}`);
  return undefined;
});
await check('missing file', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/nothing.glb')}&check`);
  expect(typeof r.error === 'string' && /404/.test(r.error), `report ${JSON.stringify(r)}`);
  return undefined;
});

// What a build holds (printing nothing as it's made): one Draco decoder (three.js's glTF one: the GLBs above loaded
// through it), no JavaScript decoder; licenses.md with the npm packages' licenses and OCCT's, not precached by its
// service worker (which precaches OCCT's module).
if (staticServer) {
  await check('build', async () => {
    expect(buildOutput.trim() === '', `the build printed: ${buildOutput.slice(0, 1000)}`);
    const assets = fs.readdirSync(path.join(dist, 'assets'));
    const draco = assets.filter((f) => f.startsWith('draco_'));
    expect(draco.length === 2 && draco.some((f) => /^draco_decoder-.*\.wasm$/.test(f)) &&
      draco.some((f) => /^draco_wasm_wrapper-.*\.js$/.test(f)), `Draco's files: ${draco}`);
    const licenses = fs.readFileSync(path.join(dist, 'licenses.md'), 'utf8');
    expect(['### three - 0.186.1 (MIT)', '### @headless-tree/core', 'Open CASCADE exception (version 1.0)',
      'GNU LESSER GENERAL PUBLIC LICENSE', 'Apache License'].every((t) => licenses.includes(t)), 'licenses.md');
    expect(!fs.existsSync(path.join(dist, '.vite')), 'Vite\'s own licenses file left');
    const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
    expect(sw.includes('occt_tess-') && !sw.includes('licenses.md'), 'the precache list');
    return undefined;
  });
}

// Offline (a build only: the service worker exists only there): once the page is controlled by its service worker,
// the server is stopped and the page reloaded; it comes back from the cache, and meshes the STEP assembly (given as
// bytes; the tessellation cache off, so OCCT's module must load from the cache too).
if (staticServer) {
  await check('offline', async () => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const evaluate = async (expression: string) => {
      const e = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId) as
        { result: { value: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string } };
      if (e.exceptionDetails) throw new Error(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text);
      return e.result.value;
    };
    const ready = async () => {
      for (let t = 0; t < 600; t++) {
        if (await evaluate('document.body?.dataset.report ?? null').catch(() => null)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    try {
      await send('Page.enable', {}, sessionId);
      await send('Page.navigate', { url: `http://localhost:${port}${base}?check` }, sessionId);
      expect(await ready(), 'the page never reported');
      // Controlled once the worker has installed (it claims its clients); reload once if it hasn't yet. Within
      // 20 s: without a service worker, ready never settles.
      let controlled = await evaluate(`Promise.race([navigator.serviceWorker.ready.then(() => new Promise((r) =>
        setTimeout(() => r(!!navigator.serviceWorker.controller), 500))), new Promise((r) => setTimeout(() => r(false),
        20000))])`);
      if (!controlled) {
        await send('Page.reload', {}, sessionId);
        await ready();
        controlled = await evaluate('!!navigator.serviceWorker.controller');
      }
      expect(controlled === true, 'no service worker controls the page');
      await new Promise((resolve) => { staticServer!.close(resolve); staticServer!.closeAllConnections(); });
      const down = !(await new Promise<boolean>((resolve) => net.connect(port, '127.0.0.1').once('connect',
        function (this: net.Socket) { this.destroy(); resolve(true); }).once('error', () => resolve(false))));
      expect(down, 'the server is still up');
      await send('Page.reload', {}, sessionId);
      expect(await ready(), 'the page did not come back offline');
      const bytes = fs.readFileSync(step).toString('base64');
      const r = await evaluate(`(async () => {
        viewer.settings.cache = false;
        const bin = atob('${bytes}');
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
        await viewer.load({ name: 'as1.stp', bytes });
        return { triangles: viewer.stats().triangles, parts: viewer.model.parts, backend:
          viewer.model.meshing?.backend };
      })()`) as { triangles: number; parts: { done: number; failed: number }; backend: string };
      expect(r.triangles === triangles && r.parts.failed === 0 && /^occt /.test(r.backend),
        `offline meshing: ${JSON.stringify(r)}`);
      return undefined;
    } finally {
      await send('Target.closeTarget', { targetId });
    }
  });
}

await shutdown();
const rounded = [lo, hi].map((v) => v.map((x) => +x.toFixed(3)));
console.log(`expected: ${triangles} triangles, ${segments} edge segments, box ${JSON.stringify(rounded)}`);
for (const [name, r] of results) console.log(`${r === 'ok' ? 'ok  ' : 'FAIL'} ${name}${r === 'ok' ? '' : `: ${r}`}`);
process.exit(results.every(([, r]) => r === 'ok') ? 0 : 1);
