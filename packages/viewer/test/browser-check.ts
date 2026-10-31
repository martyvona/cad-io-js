// The viewer in a real browser, which `npm test` can't reach: the STEP assembly itself (imported in the page, meshed
// by OCCT in its workers) and models made from it in each three.js-loadable format (GLB with Draco, glTF with meshopt
// and a .bin beside it, three.js JSON), served by the dev server (cad-viewer start) and opened in headless Chrome
// (?url=...&check). What each page reports is compared with what the scene says, computed here independently of the
// viewer: the triangles, the B-rep edges' segments, and the world box in millimetres with Z up (so each format's
// frame mapping is checked). Also: a GLB without edges (edges found from its triangles), the page with
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
import { chooseLod, exportView, meshDeflections, partInstances, tessellateScene } from 'cad-scene';
import { threemf, type ThreeMfOptions } from 'export-3mf';
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
await tessellateScene(scene, occt, { edges: true });
// (The scene holds both levels: exports at the medium profile's, the library's default.)
const medium = meshDeflections({});
const placed = [...partInstances(scene)].filter((p) => p.visible);
const coarseTriangles = [...(await tessellateScene(scene, occt, { profile: 'coarse' })).meshes].reduce((s, [part, m]) =>
  s + placed.filter((p) => p.part === part).length * m.indices.length / 3, 0);
occt.dispose();
const view = exportView(scene, { ...medium, edges: true });
fs.writeFileSync(path.join(content, 'as1.glb'), (await glb(scene, view)).bytes);
const meshopt = await gltfJson(scene, view, 'as1-meshopt.bin', { compression: 'meshopt' });
fs.writeFileSync(path.join(content, 'as1-meshopt.gltf'), meshopt.json);
fs.writeFileSync(path.join(content, 'as1-meshopt.bin'), meshopt.bin);
fs.writeFileSync(path.join(content, 'as1.json'), threejsJson(scene, view));
fs.writeFileSync(path.join(content, 'as1.json.extras.json'), threejsJson(scene, view, { extras: true }));
fs.writeFileSync(path.join(content, 'as1-noedges.glb'), (await glb(scene, exportView(scene, medium))).bytes);
// Its parts placed more than once as GPU instances (EXT_mesh_gpu_instancing), which gltf-import puts back.
fs.writeFileSync(path.join(content, 'as1-instanced.glb'), (await glb(scene, view, { instancing: true })).bytes);
// 3MF with our extras (the tree, faces) and without (anyone's: flat); open meshes as surfaces, so every part's there.
const threemfBytes = (o: ThreeMfOptions) => {
  const chunks = threemf(scene, view, { nonManifold: 'surface', ...o }).chunks;
  return Buffer.concat(chunks);
};
fs.writeFileSync(path.join(content, 'as1.3mf'), threemfBytes({ extras: true }));
fs.writeFileSync(path.join(content, 'as1-plain.3mf'), threemfBytes({}));
fs.copyFileSync(step, path.join(content, 'as1.stp'));
// OCCT's broken-references file: the importer warns of its dangling references (the problems dialog's check).
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/bug31292.stp'),
  path.join(content, 'broken.stp'));
// Half transparent everywhere (a copy of the scene's materials at opacity 0.5).
const clear = { ...scene, materials: scene.materials.map((m) => ({ ...m, opacity: 0.5 })) };
fs.writeFileSync(path.join(content, 'as1-clear.glb'), (await glb(clear, exportView(clear, medium))).bytes);
const bicycle = path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/Median_cx-fs01_bicycle.stp');
fs.copyFileSync(bicycle, path.join(content, 'bicycle.stp'));
// A part in metres (its placement scales by 1000, as every part of a file in metres).
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/r103ec.stp'),
  path.join(content, 'metres.stp'));
fs.writeFileSync(path.join(content, 'notes.txt'), 'not a model');
// AP242 tessellated geometry: NIST FTC 08's tessellated solid (272 faces of strips), and a 10 mm cube's B-rep with a
// tessellation of one of its faces (two triangles) beside it, related to it, which the importer makes a level of the
// cube's part, shown until OCCT's mesh replaces it.
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files/'
  + 'nist_ftc_08_asme1_ap242-e1-tg.stp'), path.join(content, 'ftc08-tg.stp'));
const cubeText = fs.readFileSync(path.join(repo, 'test_corpus/third_party/occt-import-js/test/testfiles/cube-10x10mm/'
  + 'Cube 10x10.stp'), 'latin1');
fs.writeFileSync(path.join(content, 'cube-tess.stp'), cubeText.replace(/ENDSEC;(\s*END-ISO-10303-21;)/, `
#900000=COORDINATES_LIST('',4,((-5.,0.,-5.),(5.,0.,-5.),(5.,0.,5.),(-5.,0.,5.)));
#900001=COMPLEX_TRIANGULATED_FACE('',#900000,4,(),$,(),((1,2,4,3)),());
#900002=TESSELLATED_SHELL('',(#900001),$);
#900003=TESSELLATED_SHAPE_REPRESENTATION('',(#900002),#188);
#900004=SHAPE_REPRESENTATION_RELATIONSHIP('','',#900003,#12);
ENDSEC;$1`), 'latin1');
// A box of 10 x 20 x 30 whose faces are each a primitive of one glTF mesh (three.js: a mesh each, under the node), as
// some CAD systems' glTF files have their parts: closed only as a whole (the caps check).
{
  const doc = new Document();
  // Written as Onshape writes (its colours sRGB though glTF's are linear): Onshape's orange.
  doc.getRoot().getAsset().generator = 'ONSHAPE BY PTC INC, 1.222';
  const orange = doc.createMaterial('orange').setBaseColorFactor([0.9725, 0.5294, 0.0039, 1]);
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
    mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices)
      .setMaterial(orange));
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
  const m = chooseLod(scene.parts[p.part]!, medium)?.mesh;
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
  /** The query as it is: not thin edges unless it says (page's default). */
  asIs?: boolean;
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
  // Thin edges unless the check asks: fat ones cost several times as much in software rendering (SwiftShader), which
  // the timing checks would feel (the fat edges check asks for them).
  const thin = opts.asIs || /[?&]edgeStyle=/.test(query) || !query.startsWith('?') ? query
    : `${query}&edgeStyle=thin`;
  await send('Page.navigate', { url: `http://localhost:${port}${base}${thin}` }, sessionId);
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
          // (Camera flights at once, as checks read the camera right after zooming: 'camera flights' checks them.)
          const e = await Promise.race([send('Runtime.evaluate', { expression: `(globalThis.viewer.flightMs = 0, ${
            after})`, returnByValue: true,
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

// Draco quantizes positions to 14 bits over each part mesh's extent, meshopt to 16: well under 0.05 mm here.
const TOL = 0.05;
for (const file of ['as1.stp', 'as1.glb', 'as1-meshopt.gltf', 'as1.json', 'as1.json.extras.json', 'as1-noedges.glb',
  'as1.3mf', 'as1-plain.3mf']) {
  await check(file, async () => {
    const r = await page(`?url=${encodeURIComponent(`/content/${file}`)}&check`) as {
      stats?: { triangles: number; segments: number }; box?: number[][]; error?: string; missing?: string };
    expect(!r.error && !r.missing, `no model: ${r.error ?? r.missing}`);
    expect(r.stats!.triangles === triangles, `${r.stats!.triangles} triangles, expected ${triangles}`);
    // (3MF has no lines: the viewer finds edges from the triangles, as for a GLB without edges.)
    if (file === 'as1-noedges.glb' || file.endsWith('.3mf')) expect(r.stats!.segments > 0,
      'no edges found from the triangles');
    else expect(r.stats!.segments === segments, `${r.stats!.segments} edge segments, expected ${segments}`);
    const [min, max] = r.box!;
    for (let k = 0; k < 3; k++) expect(Math.abs(min![k]! - lo[k]!) < TOL && Math.abs(max![k]! - hi[k]!) < TOL,
      `box ${JSON.stringify(r.box)}, expected ${JSON.stringify([lo, hi])}`);
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
// Zooming while a model loads (the user, 2026-10-30; CLAUDE.md, "Decisions": bounding volumes): the bicycle, meshed
// without the cache, is fitted to its estimated sphere before its first mesh is drawn, then only zooms out, at most
// once a second, ending fitted to all that loaded; zoom all then fits the sphere made from the meshes. Moving the
// view stops it.
await check('zoom while loading', async () => {
  const r = await page('?check', `(async () => {
    const v = globalThis.viewer;
    v.settings.cache = false;
    const bytes = await (await fetch('/content/bicycle.stp')).arrayBuffer();
    const cam = v.camera;
    const height = () => (cam.top - cam.bottom) / cam.zoom;
    // The height a sphere is fitted at: its diameter plus the margins, by the narrower side.
    const fitted = (s) => 2 * s.radius * (1 + 2 * 0.05) * Math.max(1, 1 / v.fitAspect());
    const out = { heights: [], at: [] };
    // At the scene, before any mesh (the status then says none is meshed).
    let first;
    const status = v.onStatus;
    v.onStatus = (t) => {
      status?.(t);
      if (!first && / meshed 0 of /.test(t)) first = { height: height(), target: v.controls.target.toArray(),
        sphere: v.modelSphere().radius, centre: v.modelSphere().center.toArray() };
    };
    const before = v.onMeshes;
    const t0 = performance.now();
    const timer = setInterval(() => {
      const h = height();
      if (h !== out.heights.at(-1)) { out.heights.push(h); out.at.push(performance.now() - t0); }
    }, 20);
    await v.load({ name: 'bicycle.stp', bytes: bytes.slice(0) });
    clearInterval(timer);
    out.first = first;
    // Every mesh drawn inside the sphere fitted (from the camera: its target the centre, the view's narrower side
    // its diameter and margins), in space, not only on the screen.
    const fittedRadius = height() / (2 * (1 + 2 * 0.05) * Math.max(1, 1 / v.fitAspect()));
    let outside = 0, meshes = 0;
    cam.updateMatrixWorld();
    v.display.updateWorldMatrix(true, true);
    v.display.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const sp = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
      meshes++;
      if (sp.center.distanceTo(v.controls.target) + sp.radius > fittedRadius * (1 + 1e-6)) outside++;
    });
    out.end = { height: height(), sphere: v.modelSphere().radius, outside, meshes, fitted: fittedRadius };
    v.zoomAll();
    out.zoomAll = { height: height(), fitted: fitted(v.modelSphere()), sphere: v.modelSphere().radius };
    // Moved by the user (as a camera set from outside counts) once the first mesh comes: left there.
    let moved;
    v.onMeshes = () => {
      before?.();
      if (moved !== undefined) return;
      v.setCamera({ position: [0, -5000, 0], target: [0, 0, 0], up: [0, 0, 1], height: 123 });
      moved = height();
    };
    await v.load({ name: 'bicycle.stp', bytes: bytes.slice(0) });
    out.moved = { set: moved, end: height() };
    v.onMeshes = before;
    v.onStatus = status;
    out.duration = performance.now() - t0;
    return out;
  })()`) as { after?: { heights: number[]; at: number[]; first: { height: number; target: number[]; sphere: number;
    centre: number[] }; end: { height: number; sphere: number; outside: number; meshes: number;
      fitted: number };
    zoomAll: { height: number; fitted: number; sphere: number }; moved: { set: number; end: number } } };
  const a = r.after!;
  const j = JSON.stringify({ ...a, heights: a.heights.length, at: a.at.map((t) => Math.round(t)) });
  // Fitted before the first mesh: about the final size (the estimate was 1,058 mm against 1,066), centred on it.
  expect(a.first.height > 0.95 * a.zoomAll.height && a.first.height < 1.05 * a.zoomAll.height,
    `not fitted before the first mesh: ${j}`);
  expect(a.first.target.every((x, k) => Math.abs(x - a.first.centre[k]!) < 1e-6 * a.first.sphere),
    `not centred on the sphere: ${j}`);
  // Only out, and the changes a second apart (the first two, the empty page's and the estimate's, at once).
  const loading = a.heights.slice(1);
  expect(loading.every((h, i) => i === 0 || h >= loading[i - 1]!), `zoomed back in while loading: ${j}`);
  const times = a.at.slice(2);
  expect(times.every((t, i) => i === 0 || t - times[i - 1]! > 900), `zoomed more than once a second: ${j}`);
  // At the end, all that loaded in view; zoom all to the meshes' sphere (made again, so smaller or larger).
  expect(a.end.meshes > 0 && a.end.outside === 0, `not all in view at the end: ${j}`);
  // Zoom all fits the sphere made again from the meshes, not the one grown while loading (on this model, larger
  // by 0.3 mm: Ritter's from scratch against the estimate's centre kept).
  expect(Math.abs(a.zoomAll.sphere - a.end.fitted) > 1e-3, `zoom all fits the grown sphere: ${j}`);
  expect(Math.abs(a.zoomAll.height - a.zoomAll.fitted) < 1e-6 * a.zoomAll.fitted, `zoom all: ${j}`);
  expect(a.moved.set === 123 && a.moved.end === 123, `zoomed after the view was moved: ${j}`);
  return undefined;
});
// Camera flights (the user, 2026-10-30): zoom all, zoom selected and the views ease there over a second
// (smoothstep), from where the camera is; a view turns about the orbit centre, its zoom and pan kept; idle() waits
// for the flight; the user's own input stops it where it is.
// A new model starts from the default pose (the user, 2026-10-30): iso, centred on its sphere, however the last was
// turned and panned; meshing the same model again keeps the view.
await check('pose on load', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const v = globalThis.viewer;
    const src = async (name) => ({ name, bytes: await (await fetch('/content/' + name)).arrayBuffer() });
    const dir = () => { const s = v.cameraState(); const d = s.position.map((x, k) => x - s.target[k]);
      const n = Math.hypot(...d); return d.map((x) => x / n); };
    v.setCamera({ position: [500, 400, 900], target: [300, 200, 100], up: [0, 1, 0], height: 50 });
    await v.load(await src('as1.glb'));
    await cadViewer.idle();
    const loaded = { dir: dir(), up: v.cameraState().up, target: v.cameraState().target,
      centre: v.modelSphere().center.toArray() };
    v.setCamera({ position: [500, 400, 900], target: [300, 200, 100], up: [0, 1, 0], height: 50 });
    const before = v.cameraState();
    await v.load(await src('as1.stp'), { keep: true });
    await cadViewer.idle();
    return { loaded, before, kept: v.cameraState() };
  })()`) as { after: { loaded: { dir: number[]; up: number[]; target: number[]; centre: number[] };
    before: Record<string, unknown>; kept: Record<string, unknown> } };
  const a = r.after;
  const j = JSON.stringify(a);
  const iso = 1 / Math.sqrt(3);
  expect(a.loaded.dir.every((x, k) => Math.abs(x - [iso, -iso, iso][k]!) < 1e-9), `not iso: ${j}`);
  // (Up as the fit leaves it: across the view, towards +Z.)
  expect(a.loaded.up[2]! > 0.8 && a.loaded.target.every((x, k) => Math.abs(x - a.loaded.centre[k]!) < 1e-6),
    `not centred upright: ${j}`);
  expect(JSON.stringify(a.kept) === JSON.stringify(a.before), `Mesh again moved the view: ${j}`);
  return undefined;
});
// Panning (the user, 2026-10-30): a right-button drag moves the model with the pointer one to one, after zoom
// selected too (TrackballControls' own pan crawled there), and leaves the orbit centre where it is on the model; a
// turn afterwards pivots about it, where it's drawn.
await check('panning', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
  const where = `(() => { const v = globalThis.viewer, c = v.renderer.domElement.getBoundingClientRect();
    v.camera.updateMatrixWorld();
    const px = (p) => { const q = p.clone().project(v.camera); return [c.left + (q.x + 1) / 2 * c.width,
      c.top + (1 - q.y) / 2 * c.height]; };
    const corner = v.modelSphere().center.clone().addScalar(10);
    return { target: v.controls.target.toArray(), targetPx: px(v.controls.target), cornerPx: px(corner),
      centre: [c.left + c.width / 2, c.top + c.height / 2], pan: v.cameraState().pan ?? null }; })()`;
  type Where = { target: number[]; targetPx: number[]; cornerPx: number[]; centre: number[]; pan: number[] | null };
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    ui.select([ui.panel().model.nodes.find((n) => n.kind === 'part' && n.name === 'nut').id]);
    ui.zoomSelected();
    await cadViewer.idle();
    return ${where};
  })()`, { scale: 1, then: async (sid, before) => {
    const b = before as Where;
    const drag = async (button: 'left' | 'right', from: number[], dx: number, dy: number) => {
      const buttons = button === 'left' ? 1 : 2;
      const m = (type: string, x: number, y: number, extra: object = {}) => send('Input.dispatchMouseEvent',
        { type, x, y, button, ...extra }, sid);
      await m('mouseMoved', from[0]!, from[1]!, { button: 'none' });
      await m('mousePressed', from[0]!, from[1]!, { buttons, clickCount: 1 });
      for (let k = 1; k <= 6; k++) await m('mouseMoved', from[0]! + dx * k / 6, from[1]! + dy * k / 6, { buttons });
      await m('mouseReleased', from[0]! + dx, from[1]! + dy, { clickCount: 1 });
      await evaluate(sid, 'cadViewer.idle()');
    };
    const start = [b.centre[0]! - 100, b.centre[1]! - 50];
    await drag('right', start, 120, 60);
    const panned = await evaluate(sid, `${where}`) as Where;
    await drag('left', [panned.targetPx[0]! + 40, panned.targetPx[1]! + 40], 80, 20);
    const turned = await evaluate(sid, `${where}`) as Where;
    return { panned, turned };
  } }) as { after: Where; then: { panned: Where; turned: Where } };
  const [b, p, t] = [r.after, r.then.panned, r.then.turned];
  const j = JSON.stringify({ b, p, t });
  const moved = (from: number[], to: number[]) => [to[0]! - from[0]!, to[1]! - from[1]!];
  // One to one: the orbit centre and another point of the model moved with the pointer, within a pixel.
  for (const [m, what] of [[moved(b.targetPx, p.targetPx), 'the orbit centre'], [moved(b.cornerPx, p.cornerPx),
    'a point of the model']] as const) expect(Math.abs(m[0]! - 120) <= 1 && Math.abs(m[1]! - 60) <= 1,
    `${what} moved ${m}, the pointer 120, 60: ${j}`);
  // The orbit centre where it was on the model; the pan in the camera's state.
  expect(p.target.every((x, k) => x === b.target[k]) && p.pan !== null, `the orbit centre moved: ${j}`);
  // A turn pivots about it where it's drawn.
  expect(t.target.every((x, k) => x === b.target[k]) && Math.hypot(...moved(p.targetPx, t.targetPx)) <= 1,
    `the turn didn't pivot about the orbit centre: ${j}`);
  return undefined;
});
// Zooming at the cursor (the user, 2026-10-30): a wheel zoom over a part moves the orbit centre onto the line of
// sight there, at the nearest of what's drawn along it (2026-10-31; first midway to the farthest), and zooms keeping
// that line under the cursor (the point picked there stays put); over empty space, the orbit centre stays where it
// is (2026-10-31; first slid onto the line), the zoom still about the cursor. A touchpad's pinch (ctrl, a few pixels
// an event) zooms e^(pixels / 100); a click that picks makes the point picked the orbit centre, the view unchanged.
// Safari's pinch on a Mac's touchpad (WebKit's gesture events, here synthetic: headless Chrome has none): zoomed by
// the scale's change, 1:1, about the point under the fingers; a ctrl-wheel event during the gesture let go; page zoom
// prevented.
await check('safari pinch', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const v = globalThis.viewer, canvas = v.renderer.domElement, c = canvas.getBoundingClientRect(), cam = v.camera;
    const rod = ui.panel().model.nodes.find((n) => n.kind === 'part' && n.name === 'rod').object.children[0];
    rod.geometry.computeBoundingBox();
    const q = rod.geometry.boundingBox.getCenter(v.controls.target.clone()).applyMatrix4(rod.matrixWorld).project(cam);
    const at = [Math.round(c.left + (q.x + 1) / 2 * c.width), Math.round(c.top + (1 - q.y) / 2 * c.height)];
    const px = (p) => { cam.updateMatrixWorld(); const s = p.clone().project(cam); return [c.left + (s.x + 1) / 2 *
      c.width, c.top + (1 - s.y) / 2 * c.height]; };
    const hit = v.pickAt(at[0], at[1]).point;
    const h0 = v.cameraState().height;
    const gesture = (type, scale) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { scale, clientX: at[0], clientY: at[1] });
      canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const prevented = [gesture('gesturestart', 1), gesture('gesturechange', 1.5)];
    await cadViewer.idle();
    const h1 = v.cameraState().height;
    // (A ctrl-wheel event mid-gesture, as Chrome sends a pinch: not a second zoom.)
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -50,
      clientX: at[0], clientY: at[1] }));
    await cadViewer.idle();
    const h2 = v.cameraState().height;
    prevented.push(gesture('gesturechange', 2), gesture('gestureend', 2));
    await cadViewer.idle();
    const h3 = v.cameraState().height;
    // After the gesture, the same wheel event zooms (Chrome's pinch).
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -50,
      clientX: at[0], clientY: at[1] }));
    await cadViewer.idle();
    const h4 = v.cameraState().height;
    return { at, prevented, ratios: [h0 / h1, h1 / h2, h0 / h3, h3 / h4], hitPx: px(hit) };
  })()`, { scale: 1 }) as { after: { at: number[]; prevented: boolean[]; ratios: number[]; hitPx: number[] } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.prevented.every((x) => x), `page zoom not prevented: ${j}`);
  expect(Math.abs(a.ratios[0]! - 1.5) < 1e-9 && Math.abs(a.ratios[1]! - 1) < 1e-12 &&
    Math.abs(a.ratios[2]! - 2) < 1e-9 && a.ratios[3]! > 1.05, `zoom: ${j}`);
  expect(Math.hypot(a.hitPx[0]! - a.at[0]!, a.hitPx[1]! - a.at[1]!) < 1, `the point under the fingers moved: ${j}`);
  return undefined;
});
await check('zoom at the cursor', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
  const where = (x: number, y: number) => `(() => { const v = globalThis.viewer, c = v.renderer.domElement
    .getBoundingClientRect(), cam = v.camera;
    v.camera.updateMatrixWorld();
    const px = (p) => { const q = p.clone().project(cam); return [c.left + (q.x + 1) / 2 * c.width,
      c.top + (1 - q.y) / 2 * c.height]; };
    const hit = v.pickAt(${x}, ${y});
    const dir = cam.getWorldDirection(v.controls.target.clone());
    return { target: v.controls.target.toArray(), targetPx: px(v.controls.target), height: v.cameraState().height,
      hit: hit ? hit.point.toArray() : null, hitPx: hit ? px(hit.point) : null, dir: dir.toArray(),
      depth: hit ? hit.point.clone().sub(v.controls.target).dot(dir) : null }; })()`;
  type Where = { target: number[]; targetPx: number[]; height: number; hit: number[] | null; hitPx: number[] | null;
    dir: number[]; depth: number | null };
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const v = globalThis.viewer, c = v.renderer.domElement.getBoundingClientRect(), cam = v.camera;
    const rod = ui.panel().model.nodes.find((n) => n.kind === 'part' && n.name === 'rod').object.children[0];
    rod.geometry.computeBoundingBox();
    const q = rod.geometry.boundingBox.getCenter(v.controls.target.clone()).applyMatrix4(rod.matrixWorld).project(cam);
    // (Whole pixels, as the mouse events give them.)
    return { over: [Math.round(c.left + (q.x + 1) / 2 * c.width), Math.round(c.top + (1 - q.y) / 2 * c.height)],
      empty: [Math.round(c.left + 30), Math.round(c.top + 30)] };
  })()`, { scale: 1, then: async (sid, at) => {
    const { over, empty } = at as { over: number[]; empty: number[] };
    const wheel = async (x: number, y: number, n: number) => {
      for (let k = 0; k < n; k++) await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0,
        deltaY: -100 }, sid);
      await evaluate(sid, 'cadViewer.idle()');
    };
    const before = await evaluate(sid, where(over[0]!, over[1]!)) as Where;
    await wheel(over[0]!, over[1]!, 3);
    const zoomed = await evaluate(sid, where(over[0]!, over[1]!)) as Where;
    // A new gesture over empty space, after a pause.
    await new Promise((res) => setTimeout(res, 500));
    const beforeEmpty = await evaluate(sid, where(empty[0]!, empty[1]!)) as Where;
    await wheel(empty[0]!, empty[1]!, 2);
    const zoomedEmpty = await evaluate(sid, where(empty[0]!, empty[1]!)) as Where;
    // A pinch: 20 events of 2 pixels in, ctrl held (modifiers 2), as Chrome gives a Mac's touchpad.
    await new Promise((res) => setTimeout(res, 500));
    const beforePinch = await evaluate(sid, where(over[0]!, over[1]!)) as Where;
    for (let k = 0; k < 20; k++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: over[0]!, y: over[1]!, deltaX: 0, deltaY: -2,
        modifiers: 2 }, sid);
      await evaluate(sid, 'new Promise((r) => requestAnimationFrame(() => r()))');
    }
    await evaluate(sid, 'cadViewer.idle()');
    const pinched = await evaluate(sid, where(over[0]!, over[1]!)) as Where;
    // A click picking a point off the orbit centre: the orbit centre there, everything drawn where it was.
    const clickAt = [over[0]! + 15, over[1]! + 25];
    const beforeClick = await evaluate(sid, where(clickAt[0]!, clickAt[1]!)) as Where;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: clickAt[0]!, y: clickAt[1]!, button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, sid);
    }
    await evaluate(sid, 'cadViewer.idle()');
    const clicked = await evaluate(sid, where(clickAt[0]!, clickAt[1]!)) as Where;
    return { over, empty, before, zoomed, beforeEmpty, zoomedEmpty, beforePinch, pinched, at: clickAt, beforeClick,
      clicked };
  } }) as { then: { over: number[]; empty: number[]; before: Where; zoomed: Where; beforeEmpty: Where;
    zoomedEmpty: Where; beforePinch: Where; pinched: Where; at: number[]; beforeClick: Where; clicked: Where } };
  const a = r.then;
  const j = JSON.stringify(a);
  const off = (p: number[] | null, q: number[]) => p ? Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!) : Infinity;
  // Over the rod: zoomed in; the orbit centre drawn at the cursor, at or beyond the surface hit (midway into the
  // part); the point first hit there still under the cursor.
  expect(a.zoomed.height < a.before.height * 0.95, `not zoomed in: ${j}`);
  expect(off(a.zoomed.targetPx, a.over) < 1 && a.zoomed.depth !== null && Math.abs(a.zoomed.depth) < 1e-3,
    `the orbit centre not on the line of sight, at the surface: ${j}`);
  expect(a.before.hit !== null && off(a.zoomed.hitPx, a.over) < 1 &&
    a.zoomed.hit!.every((x, k) => Math.abs(x - a.before.hit![k]!) < 1e-3), `the point under the cursor moved: ${j}`);
  // Over empty space: the orbit centre left where it was, the zoom still about the cursor (the orbit centre's
  // distance from it on the screen scaled by the zoom).
  const k = a.beforeEmpty.height / a.zoomedEmpty.height;
  const expected = [0, 1].map((i) => a.empty[i]! + (a.beforeEmpty.targetPx[i]! - a.empty[i]!) * k);
  expect(a.beforeEmpty.hit === null && k > 1.01 &&
    a.zoomedEmpty.target.every((x, i) => x === a.beforeEmpty.target[i]) && off(a.zoomedEmpty.targetPx, expected) < 1,
    `over empty space: ${j}`);
  // The pinch: 40 pixels in, e^0.4 (the controls' own would have been 1 %).
  const ratio = a.beforePinch.height / a.pinched.height;
  expect(Math.abs(ratio - Math.exp(0.4)) < 0.02, `the pinch zoomed x${ratio}, wanted e^0.4: ${j}`);
  // The click: the orbit centre at the point picked, drawn where it was clicked; the rest unmoved.
  expect(a.beforeClick.hit !== null && a.clicked.target.every((x, k) => Math.abs(x - a.beforeClick.hit![k]!) < 1e-6) &&
    off(a.clicked.targetPx, a.at) < 1 && Math.abs(a.clicked.height - a.beforeClick.height) < 1e-9 &&
    off(a.clicked.hitPx, a.beforeClick.hitPx!) < 1e-3, `the click's orbit centre: ${j}`);
  return undefined;
});
// Picks on section caps (the user, 2026-10-31): a click where a cap is drawn picks the part cut, at the point on the
// plane, through cadViewer.pickAt and the view's own picking; the zoom at the cursor's orbit centre counts it too.
await check('picks on caps', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const v = globalThis.viewer, cam = v.camera, c = v.renderer.domElement.getBoundingClientRect();
    const rod = ui.panel().model.nodes.find((n) => n.kind === 'part' && n.name === 'rod').object.children[0];
    rod.geometry.computeBoundingBox();
    const centre = rod.geometry.boundingBox.getCenter(v.controls.target.clone()).applyMatrix4(rod.matrixWorld);
    v.setSections({ ...v.sections.get(), x: { on: true, at: centre.x, flip: false }, caps: true });
    // Looking at the cut face (from +X, the cut-away side).
    // (The orbit centre 100 mm deeper along the view, which shows the same: off the cap's plane.)
    v.setCamera({ position: [centre.x + 500, centre.y, centre.z], target: [centre.x - 100, centre.y, centre.z],
      up: [0, 0, 1], height: 120 });
    await cadViewer.idle();
    const q = centre.clone().project(cam);
    const fx = (q.x + 1) / 2, fy = (1 - q.y) / 2;
    const picked = cadViewer.pickAt(fx, fy);
    const off = cadViewer.pickAt(fx, fy) && (v.setSections({ ...v.sections.get(), caps: false }),
      cadViewer.pickAt(fx, fy));
    v.setSections({ ...v.sections.get(), caps: true });
    // The zoom's orbit centre found a little above the rod's centre, on the cap.
    v.centreAt(c.left + fx * c.width, c.top + fy * c.height - 10);
    return { picked, off, centre: centre.toArray(), target: v.controls.target.toArray() };
  })()`) as { after: { picked: { path: string; point: number[]; cap?: string } | undefined;
    off: { path: string; cap?: string } | undefined; centre: number[]; target: number[] } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.picked?.cap === 'x' && /rod/.test(a.picked.path) && Math.abs(a.picked.point[0]! - a.centre[0]!) < 1e-6,
    `the cap didn't pick the rod: ${j}`);
  // Without caps, the cut shows what's beyond: not the rod's cap.
  expect(a.off?.cap === undefined, `a cap hit with caps off: ${j}`);
  // (Along the rod's axis the cap is all that's drawn there, the rod's far end facing away: the orbit centre on it.)
  expect(Math.abs(a.target[0]! - a.centre[0]!) < 1e-6 && a.target[2]! > a.centre[2]! + 1e-3,
    `the zoom's orbit centre didn't take the cap: ${j}`);
  return undefined;
});
// Edges found off the page's thread (the user, 2026-10-31): a GLB of meshes without edges (the user's VW, from
// Onshape) loads with every part's edges found in the import worker, the page's longest task no longer than the
// scene graph's own building (finding them on the page made it more than twice as long).
const vwGlb = path.join(repo, 'test_corpus/models/onshape/VW-medium-uncompressed.glb.glb');
if (fs.existsSync(vwGlb)) await check('edges off the page', async () => {
  fs.copyFileSync(vwGlb, path.join(content, 'vw.glb'));
  const r = await page('?check', `(async () => {
    const tasks = [], statuses = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e.duration); })
      .observe({ type: 'longtask', buffered: false });
    const st = document.getElementById('status');
    new MutationObserver(() => statuses.push(st.textContent)).observe(st, { childList: true, characterData: true,
      subtree: true });
    // (Slices of a millisecond, so the parts are shown a few at a time even here.)
    viewer.sliceMs = 1;
    const t0 = performance.now();
    await cadViewer.load('/content/vw.glb');
    await cadViewer.idle();
    const ms = performance.now() - t0;
    let parts = 0, withEdges = 0, segments = 0;
    viewer.display.traverse((o) => {
      if (!o.isMesh || o.userData.faceRanges === undefined) return;
      parts++;
      const e = o.children.find((c) => c.name === 'edges');
      if (e) { withEdges++; segments += e.geometry.getAttribute('position').count / 2; }
    });
    return { ms, longest: Math.max(0, ...tasks), tasks: tasks.length, parts, withEdges, segments,
      statuses: [...new Set(statuses.map((t) => t.replace(/[0-9]+ of/, 'N of')))] };
  })()`) as { after: { ms: number; longest: number; tasks: number; parts: number; withEdges: number;
    segments: number; statuses: string[] } };
  const a = r.after;
  console.log(`edges off the page: VW's GLB ${Math.round(a.ms)} ms, ${a.segments} edge segments, longest task ` +
    `${Math.round(a.longest)} ms`);
  expect(a.parts > 0 && a.withEdges === a.parts && a.segments > 100000, `edges not found: ${JSON.stringify(a)}`);
  // What the load is doing, said all along: importing (with the size), then edges found, counted.
  expect(a.statuses.some((t) => /^vw\.glb: importing \d+ MB\.\.\.$/.test(t)) &&
    a.statuses.some((t) => /^vw\.glb: found edges for N of \d+ parts$/.test(t)) &&
    a.statuses.some((t) => /^vw\.glb: showing N of \d+ parts$/.test(t)), `statuses: ${a.statuses}`);
  // (Here about 280 ms, the scene graph's building; with the edges found on the page about 640.)
  expect(a.longest < 450, `a long task on the page: ${JSON.stringify(a)}`);
  return undefined;
});
// A STEP file's import says its phases in the status line as the import worker reaches them (the user, 2026-10-31:
// "importing" alone for the seconds a large file takes): reading, its structure, the parts by percent, assembling.
await check('import phases', async () => {
  const r = await page('?check', `(async () => {
    const statuses = [];
    const st = document.getElementById('status');
    new MutationObserver(() => statuses.push(st.textContent)).observe(st, { childList: true, characterData: true,
      subtree: true });
    await cadViewer.load('/content/bicycle.stp');
    await cadViewer.idle();
    return { statuses: [...new Set(statuses)] };
  })()`) as { after: { statuses: string[] } };
  const s = r.after.statuses;
  const at = (re: RegExp) => s.findIndex((t) => re.test(t));
  const order = [/^bicycle\.stp: importing \d+ MB: reading\.\.\.$/,
    /^bicycle\.stp: importing \d+ MB: reading its structure\.\.\.$/,
    /^bicycle\.stp: importing \d+ MB: making parts, 0 %\.\.\.$/,
    /^bicycle\.stp: importing \d+ MB: assembling\.\.\.$/, /^bicycle\.stp: meshed \d+ of \d+ parts/].map(at);
  expect(order.every((k, i) => k >= 0 && (i === 0 || k > order[i - 1]!)), `statuses: ${JSON.stringify(s)}`);
  return undefined;
});
// Hide others, Show others and transparency (the user, 2026-10-31), through the controls: one of as1's nuts selected,
// Hide others leaves it alone shown; Show others shows the rest, the nut keeping its own hiding; the rod made
// transparent at the Opacity control's value and back to the file's.
await check('hide others and transparency', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const m = ui.panel().model, button = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    const parts = () => m.nodes.filter((n) => n.kind === 'part');
    const shown = () => parts().filter((n) => !m.hiddenInTree(n.id)).map((n) => n.id);
    const nut = parts().find((n) => n.name === 'nut');
    const all = shown().length;
    ui.select([nut.id]);
    button('Hide others').$button.click();
    const alone = shown();
    button('Show others').$button.click();
    const back = shown().length;
    // The nut hidden itself, then Show others with it selected: the rest shown, the nut not.
    ui.hideSelected();
    button('Hide others').$button.click();
    button('Show others').$button.click();
    const nutKept = m.hiddenInTree(nut.id) && shown().length === all - 1;
    ui.showAll();
    // Transparency: the rod at 0.4 (the Opacity control), then back.
    const rod = parts().find((n) => n.name === 'rod');
    const mesh = rod.object.children.find((c) => c.isMesh);
    const before = [mesh.material].flat().map((x) => [x.opacity, x.transparent]);
    ui.select([rod.id]);
    button('Opacity').setValue(0.4);
    button('Make transparent').$button.click();
    ui.select([]);
    const made = [mesh.material].flat().map((x) => [x.opacity, x.transparent]);
    ui.select([rod.id]);
    button('Restore opacity').$button.click();
    ui.select([]);
    const restored = [mesh.material].flat().map((x) => [x.opacity, x.transparent]);
    // Overrides inherited (the user, 2026-10-31): the nut's assembly hidden, the nut shown within it; the assembly at
    // 0.5, one of its children back to the file's within it. In the state and the link. (An assembly of several
    // children: of one, the child would stand for it, NodeModel.cover.)
    const asm = m.nodes.find((n) => n.kind === 'assembly' && n.parent >= 0 && m.children(n.id).length > 1).id;
    const one = m.nodes[m.children(asm)[0]];
    ui.select([asm]);
    ui.hideSelected();
    ui.select([one.id]);
    ui.showSelected();
    const inAsm = m.children(asm).map((id) => m.nodes[id]);
    const within = inAsm.map((n) => [n.id === one.id, m.hiddenInTree(n.id)]);
    ui.select([asm]);
    button('Opacity').setValue(0.5);
    button('Make transparent').$button.click();
    ui.select([one.id]);
    button('Restore opacity').$button.click();
    ui.select([]);
    const alphas = inAsm.map((n) => [n.id === one.id, m.look(n.id).alpha ?? 'file']);
    const st = cadViewer.state();
    return { all, alone, nut: nut.id, back, nutKept, before, made, restored, within, alphas, drawn: shown().length,
      overrides: { hidden: st.hidden, shown: st.shown, opacity: st.opacity }, link: cadViewer.link() };
  })()`) as { after: { all: number; alone: number[]; nut: number; back: number; nutKept: boolean;
    before: [number, boolean][]; made: [number, boolean][]; restored: [number, boolean][];
    within: [boolean, boolean][]; alphas: [boolean, number | 'file'][]; drawn: number; overrides: { hidden: string[];
      shown: string[]; opacity: { path: string; alpha: number | 'default' }[] }; link: string } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.within.length > 1 && a.within.every(([isOne, hidden]) => hidden === !isOne) && a.drawn < a.all,
    `hidden within: ${j}`);
  expect(a.alphas.every(([isOne, alpha]) => alpha === (isOne ? 'file' : 0.5)), `opacity within: ${j}`);
  const o = a.overrides;
  expect(o.hidden.length === 1 && o.shown.length === 1 && o.shown[0]!.startsWith(o.hidden[0]! + '/') &&
    o.opacity.length === 2 && o.opacity[0]!.path === o.hidden[0] && o.opacity[0]!.alpha === 0.5 &&
    o.opacity[1]!.path === o.shown[0] && o.opacity[1]!.alpha === 'default', `the overrides: ${j}`);
  // The link, opened: the same overrides, drawn so.
  const at = a.link.indexOf('#');
  const linked = await page(a.link.slice(a.link.indexOf('?'), at) + '&check' + a.link.slice(at), `cadViewer.ready
    .then(() => cadViewer.idle()).then(() => { const st = cadViewer.state(), m = ui.panel().model;
      return { hidden: st.hidden, shown: st.shown, opacity: st.opacity, drawn: m.nodes.filter((n) => n.kind ===
        'part' && !m.hiddenInTree(n.id)).length }; })`) as { after: typeof o & { drawn: number } };
  expect(JSON.stringify({ ...linked.after, drawn: undefined }) === JSON.stringify(o) &&
    linked.after.drawn === a.drawn, `linked: ${JSON.stringify(linked.after)} ${j}`);
  expect(a.all > 3 && a.alone.length === 1 && a.alone[0] === a.nut && a.back === a.all, `hide/show others: ${j}`);
  expect(a.nutKept, `Show others showed the selection: ${j}`);
  expect(a.made.every(([o, t]) => o === 0.4 && t) && JSON.stringify(a.restored) === JSON.stringify(a.before) &&
    a.before.every(([o]) => o === 1), `transparency: ${j}`);
  return undefined;
});
// The tree's context menu and Override Appearance... (the user, 2026-10-31): right-click an assembly's row, the
// menu's one item, the panel's controls (Inherit at first, the alpha shown and not editable; Transparent starting
// from it), each change taking effect at once (no OK or Cancel), the eye on the row; asked for a child while it's
// open, the same panel showing the child (what it inherits), not a second; changed elsewhere (Hide selected), shown
// again; triangle edges on through it; not modal, so the page stays usable; closed by its x and by Escape; a
// long press on a touch screen opening the menu too; recorded and replayed in a fresh page with the same overrides.
await check('override appearance', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&record`, `(async () => {
    const m = ui.panel().model;
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const asm = m.nodes.find((n) => n.kind === 'assembly' && n.parent >= 0 && m.children(n.id).length > 1).id;
    const child = m.children(asm)[0];
    const rowOf = async (id) => {
      ui.select([id]);
      await frame();
      return [...document.querySelectorAll('#tree .tree-row')].find((r) => +r.dataset.id === id);
    };
    const menuFor = async (id) => {
      const row = await rowOf(id), b = row.getBoundingClientRect();
      const allowed = row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: b.left + 20, clientY: b.top + 5 }));
      // (The browser's own menu not shown.)
      return [...document.querySelectorAll('.cv-menu button')].map((x) => x.textContent).concat(allowed ? ['shown']
        : []);
    };
    const panel = async (id) => {
      await menuFor(id);
      document.querySelector('.cv-menu button').click();
      await frame();
      const d = document.querySelector('dialog.cv-dialog.floating');
      const [visibility, opacity, edges] = d.querySelectorAll('select');
      const [slider, number] = d.querySelectorAll('.alpha input');
      const change = (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); };
      return { d, visibility, opacity, edges, slider, number, change, read: () => ({ title: d.querySelector('h2')
        .textContent, visibility: visibility.value, opacity: opacity.value, edges: edges.value,
        options: [...visibility.options, ...opacity.options, ...edges.options].map((o) => o.text),
        disabled: slider.disabled && number.disabled, value: number.value,
        buttons: [...d.querySelectorAll('button')].map((x) => x.getAttribute('aria-label') ?? x.textContent) }) };
    };
    const items = await menuFor(asm);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const closed = !document.querySelector('.cv-menu');
    let c = await panel(asm);
    const first = c.read();
    const modal = c.d.matches(':modal');
    c.change(c.opacity, 'transparent');
    const switched = c.read();
    // The box typed in: at once, before anything else.
    c.number.value = '0.4';
    c.number.dispatchEvent(new Event('input'));
    const live = m.look(asm).alpha;
    c.number.dispatchEvent(new Event('change'));
    c.change(c.visibility, 'hide');
    const own = m.ownOverride(asm);
    const eye = !!(await rowOf(asm)).querySelector('.tree-override');
    const childHidden = m.hiddenInTree(child);
    // The child, the panel open: the same panel, showing the child.
    c = await panel(child);
    const panels = document.querySelectorAll('dialog.cv-dialog').length;
    const inChild = c.read();
    c.change(c.opacity, 'transparent');
    const childSwitched = c.read();
    c.change(c.opacity, 'default');
    const childDefault = c.read();
    c.change(c.visibility, 'show');
    c.change(c.edges, 'on');
    // Drawn, Rendering's Triangle edges off: the child's placements' meshes only.
    await cadViewer.idle();
    const te = viewer.triangleEdges.group;
    const wires = te.visible ? te.children.filter((w) => w.visible).length : 0;
    let childMeshes = 0;
    m.nodes[child].object.traverse((o) => { if (o.isMesh && o.userData.faceRanges) childMeshes++; });
    const childOwn = m.ownOverride(child);
    const childLook = m.look(child);
    // Changed elsewhere, the panel open on the child: shown again (hidden as its assembly is: its own cleared).
    ui.select([child]);
    ui.hideSelected();
    const refreshed = c.read().visibility;
    ui.showSelected();
    const reshown = c.read().visibility;
    // Closed by its x; opened again, by Escape.
    c.d.querySelector('button.close').click();
    const xClosed = !document.querySelector('dialog.cv-dialog');
    c = await panel(child);
    c.d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escClosed = !document.querySelector('dialog.cv-dialog');
    // A long press with a finger.
    const row = await rowOf(child), b = row.getBoundingClientRect();
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: b.left + 20,
      clientY: b.top + 5 }));
    await new Promise((res) => setTimeout(res, 700));
    const pressed = [...document.querySelectorAll('.cv-menu button')].map((x) => x.textContent);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // (The rows were selected here through the interface, which replay doesn't repeat: none at the end.)
    ui.select([]);
    const st = cadViewer.state();
    return { items, closed, first, modal, switched, live, own, eye, childHidden, panels, inChild, childSwitched,
      childDefault, childOwn, childLook, wires, childMeshes, refreshed, reshown, xClosed, escClosed, pressed,
      overrides: { hidden: st.hidden, shown: st.shown, opacity: st.opacity, triangleEdges: st.triangleEdges },
      rec: cadViewer.record(false) };
  })()`) as { after: Record<string, unknown> & { overrides: unknown; rec: { events: { type: string }[] } } };
  const a = r.after;
  const j = JSON.stringify({ ...a, rec: undefined });
  type Read = { title: string; visibility: string; opacity: string; edges: string; options: string[];
    disabled: boolean; value: string; buttons: string[] };
  expect(JSON.stringify(a.items) === '["Override Appearance..."]' && !!a.closed, `the menu: ${j}`);
  const first = a.first as Read;
  expect(first.visibility === 'inherit' && first.opacity === 'inherit' && first.edges === 'inherit' &&
    first.disabled && first.value === '1' && first.options.includes("Inherit (Rendering's: off)") &&
    JSON.stringify(first.buttons) === '["Close"]' && a.modal === false, `the panel at first: ${j}`);
  const sw = a.switched as Read;
  expect(!sw.disabled && sw.value === '1', `transparent, from the alpha shown: ${j}`);
  expect(a.live === 0.4, `not at once: ${j}`);
  expect(JSON.stringify(a.own) === '{"hidden":true,"transparent":true,"alpha":0.4}' && !!a.eye && !!a.childHidden,
    `the assembly's override: ${j}`);
  const ic = a.inChild as Read;
  expect(a.panels === 1 && ic.title.endsWith(String((a.inChild as Read).title.split(': ')[1])) &&
    ic.title !== first.title && ic.visibility === 'inherit' && ic.options.includes('Inherit (hidden)') &&
    ic.options.includes('Inherit (0.4)') && ic.disabled && ic.value === '0.4', `the child in the panel: ${j}`);
  expect((a.childSwitched as Read).value === '0.4', `the child transparent from 0.4: ${j}`);
  const cd = a.childDefault as Read;
  expect(cd.disabled && cd.value === '1', `the child's default, the file's: ${j}`);
  expect(JSON.stringify(a.childOwn) === '{"hidden":false,"transparent":false,"triangleEdges":true}' &&
    JSON.stringify(a.childLook) === '{"hidden":false,"triangleEdges":true}', `the child's override: ${j}`);
  expect(a.refreshed === 'inherit' && a.reshown === 'show', `refreshed: ${j}`);
  expect((a.childMeshes as number) > 0 && a.wires === a.childMeshes, `the child's triangle edges: ${j}`);
  expect(!!a.xClosed && !!a.escClosed, `closed: ${j}`);
  expect(JSON.stringify(a.pressed) === '["Override Appearance..."]', `a long press: ${j}`);
  // Recorded once each change was made (the box's input not, its change yes), Hide and Show selected as buttons.
  expect(a.rec.events.filter((e) => e.type === 'appearance').length === 7, `recorded: ${JSON.stringify(
    a.rec.events.filter((e) => e.type === 'appearance'))}`);
  const replayed = await page('?check', `(async () => {
    await cadViewer.ready;
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    const st = cadViewer.state();
    // A state's triangle edges: exactly these (none).
    cadViewer.apply({ triangleEdges: [] });
    return { divergences: report.divergences, overrides: { hidden: st.hidden, shown: st.shown, opacity: st.opacity,
      triangleEdges: st.triangleEdges }, cleared: cadViewer.state().triangleEdges };
  })()`) as { after: { divergences: string[]; overrides: unknown; cleared: unknown[] } };
  expect(replayed.after.divergences.length === 0 && JSON.stringify(replayed.after.overrides) ===
    JSON.stringify(a.overrides), `replayed: ${JSON.stringify(replayed.after)} ${j}`);
  expect((a.overrides as { triangleEdges: unknown[] }).triangleEdges.length === 1 &&
    replayed.after.cleared.length === 0, `a state's triangle edges: ${JSON.stringify(replayed.after)}`);
  return undefined;
});
// Dialogs dragged by their title (the user, 2026-10-31): Override Appearance... moved by a mouse drag of its title,
// as far as the drag, a second from where it was left; dragged far off, its title kept in the window; a modal one
// (About) too.
await check('dialog drag', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
  const title = `(() => { const r = document.querySelector('dialog.cv-dialog h2').getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom]; })()`;
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const m = ui.panel().model;
    ui.select([m.roots[0]]);
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const row = [...document.querySelectorAll('#tree .tree-row')].find((x) => +x.dataset.id === m.roots[0]);
    const b = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20,
      clientY: b.top + 5 }));
    document.querySelector('.cv-menu button').click();
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    return true;
  })()`, { scale: 1, then: async (sid) => {
    const drag = async (from: number[], by: number[]) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left',
        buttons: 1, clickCount: 1 }, sid);
      for (let k = 1; k <= 5; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0]! +
        by[0]! * k / 5, y: from[1]! + by[1]! * k / 5, button: 'left', buttons: 1 }, sid);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from[0]! + by[0]!, y: from[1]! + by[1]!,
        button: 'left', buttons: 0, clickCount: 1 }, sid);
    };
    const before = await evaluate(sid, title) as number[];
    const at = [before[0]! + 30, (before[1]! + before[3]!) / 2];
    await drag(at, [150, 80]);
    const moved = await evaluate(sid, title) as number[];
    // Again, from where it was left.
    await drag([at[0]! + 150, at[1]! + 80], [-50, -30]);
    const again = await evaluate(sid, title) as number[];
    await drag([at[0]! + 100, at[1]! + 50], [-5000, -5000]);
    const far = await evaluate(sid, title) as number[];
    const win = await evaluate(sid, '[innerWidth, innerHeight]') as number[];
    // A modal one: About, dragged too.
    const aboutBefore = await evaluate(sid, `(async () => { document.querySelector('dialog.cv-dialog button.close')
      .click();
      ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
      return ${title}; })()`) as number[];
    await drag([aboutBefore[0]! + 30, (aboutBefore[1]! + aboutBefore[3]!) / 2], [40, 20]);
    const aboutMoved = await evaluate(sid, title) as number[];
    return { before, moved, again, far, win, aboutBefore, aboutMoved };
  } }) as { then: { before: number[]; moved: number[]; again: number[]; far: number[]; win: number[];
    aboutBefore: number[]; aboutMoved: number[] } };
  const t = r.then;
  const j = JSON.stringify(t);
  const by = (x: number[], y: number[], dx: number, dy: number) => Math.abs(y[0]! - x[0]! - dx) < 1 &&
    Math.abs(y[1]! - x[1]! - dy) < 1;
  expect(by(t.before, t.moved, 150, 80), `dragged: ${j}`);
  expect(by(t.before, t.again, 100, 50), `dragged again: ${j}`);
  expect(t.far[2]! >= 40 - 1e-6 && t.far[1]! >= -1e-6 && t.far[0]! <= t.win[0]! && t.far[3]! <= t.win[1]!,
    `the title kept in the window: ${j}`);
  expect(by(t.aboutBefore, t.aboutMoved, 40, 20), `About dragged: ${j}`);
  return undefined;
});
await check('camera flights', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const v = globalThis.viewer;
    v.flightMs = 1000;
    const st = () => v.cameraState();
    const far = { position: [5000, -4000, 3000], target: [400, 300, 200], up: [0, 0, 1], height: 40 };
    // Where zoom all goes, at once.
    v.setCamera(far);
    v.flightMs = 0;
    v.zoomAll();
    const goal = st();
    v.flightMs = 1000;
    v.setCamera(far);
    const t0 = performance.now();
    v.zoomAll();
    const right = st();
    const samples = [];
    const timer = setInterval(() => samples.push([performance.now() - t0, st().height]), 20);
    await cadViewer.idle();
    const took = performance.now() - t0;
    clearInterval(timer);
    const end = st();
    // A view: turned about the target, from the same distance and height.
    const before = st();
    v.setView('top');
    await cadViewer.idle();
    const top = st();
    // Stopped by the user's input partway.
    v.setView('front');
    await new Promise((r) => setTimeout(r, 400));
    v.controls.dispatchEvent({ type: 'start' });
    v.controls.dispatchEvent({ type: 'end' });
    const stopped = st();
    await new Promise((r) => setTimeout(r, 900));
    const later = st();
    // Zoom selected flies too: not there at once.
    v.setCamera(far);
    ui.select([ui.panel().model.nodes.find((n) => n.kind === 'part').id]);
    ui.zoomSelected();
    const selectedAtOnce = st();
    await cadViewer.idle();
    const selectedEnd = st();
    // A link's view (a state applied) at once; an exact camera set mid-flight ends the flight there.
    cadViewer.apply({ view: 'left' });
    const left = st();
    v.zoomAll();
    v.setCamera(far);
    await new Promise((r) => setTimeout(r, 300));
    const set = st();
    // A flight of the zoom alone (the camera already where zoom all puts it, only the height off): it goes on.
    v.setCamera({ ...goal, height: goal.height * 10 });
    v.zoomAll();
    await new Promise((r) => setTimeout(r, 500));
    const zoomHalf = st();
    await cadViewer.idle();
    const zoomEnd = st();
    return { zoomHalf, zoomEnd, far, goal, right, samples, took, end, before, top, stopped, later, selectedAtOnce,
      selectedEnd, left, set };
  })()`) as { after?: Record<string, unknown> };
  type S = { position: number[]; target: number[]; up: number[]; height: number };
  const a = r.after as { far: S; goal: S; right: S; samples: [number, number][]; took: number; end: S; before: S;
    top: S; stopped: S; later: S; selectedAtOnce: S; selectedEnd: S; left: S; set: S; zoomHalf: S; zoomEnd: S };
  const j = JSON.stringify({ ...a, samples: a.samples.length });
  const same = (p: S, q: S, tol = 1e-6) => [p.position, p.target, p.up].every((x, i) => x.every((c, k) =>
    Math.abs(c - [q.position, q.target, q.up][i]![k]!) < tol * Math.max(1, q.height))) &&
    Math.abs(p.height - q.height) < tol * q.height;
  // Not there at once; there at the end (as zoom all at once puts it), after about a second.
  expect(same(a.right, a.far), `jumped at once: ${j}`);
  expect(same(a.end, a.goal), `not where zoom all goes: ${j}`);
  expect(a.took > 900 && a.took < 1600, `the flight took ${a.took} ms`);
  // On the way: the height from the start's to the goal's, by ratio, eased (slow at the ends, half at half time).
  const frac = ([, h]: [number, number]) => Math.log(h / a.far.height) / Math.log(a.goal.height / a.far.height);
  const mid = a.samples.filter(([t]) => t > 400 && t < 600).map(frac);
  const early = a.samples.filter(([t]) => t > 50 && t < 150).map(frac);
  expect(mid.length > 0 && mid.every((f) => f > 0.25 && f < 0.75), `halfway: ${JSON.stringify(mid)}`);
  expect(early.length > 0 && early.every((f) => f >= 0 && f < 0.12), `eased at the start: ${JSON.stringify(early)}`);
  expect(a.samples.map(frac).every((f, i, fs) => i === 0 || f >= fs[i - 1]! - 1e-9), `not monotone: ${j}`);
  // The view: the target and height kept, the distance too, looking down.
  const dist = (p: S) => Math.hypot(...p.position.map((c, k) => c - p.target[k]!));
  expect(a.top.target.every((c, k) => Math.abs(c - a.before.target[k]!) < 1e-6) &&
    Math.abs(a.top.height - a.before.height) < 1e-6 * a.before.height &&
    Math.abs(dist(a.top) - dist(a.before)) < 1e-6 * dist(a.before) &&
    Math.abs(a.top.position[2]! - a.top.target[2]! - dist(a.top)) < 1e-6 * dist(a.top), `the top view: ${j}`);
  // Stopped where it was, partway.
  expect(same(a.stopped, a.later) && !same(a.stopped, a.top) && Math.abs(a.stopped.position[2]! - a.stopped.target[2]!)
    < dist(a.stopped) * 0.999, `the flight not stopped by input: ${j}`);
  expect(same(a.selectedAtOnce, a.far) && !same(a.selectedEnd, a.far), `zoom selected: ${j}`);
  expect(a.left.position[0]! < a.left.target[0]! && Math.abs(a.left.position[1]! - a.left.target[1]!) < 1e-6 *
    dist(a.left), `a state's view not at once: ${j}`);
  expect(same(a.set, a.far), `a camera set didn't end the flight: ${j}`);
  expect(a.zoomHalf.height < a.goal.height * 9 && a.zoomHalf.height > a.goal.height * 1.1 && same(a.zoomEnd, a.goal),
    `a zoom alone: ${j}`);
  return undefined;
});
// Fitting beside the controls (the user, 2026-10-30): zoom all and zoom selected fit the sphere in the width between
// the view's left and the controls' left edge, centred there, however folded the controls are; the camera's axis
// (what it orbits) there too.
await check('fit beside the controls', async () => {
  const script = `(async () => {
    const v = globalThis.viewer, cam = v.camera;
    const fitted = (s = v.modelSphere()) => {
      const c = v.renderer.domElement.getBoundingClientRect(), g = ui.gui.domElement.getBoundingClientRect();
      cam.updateMatrixWorld();
      const right = new s.center.constructor().setFromMatrixColumn(cam.matrixWorld, 0);
      const px = (p) => c.left + (p.clone().project(cam).x + 1) / 2 * c.width;
      const target = px(v.controls.target);
      return { viewLeft: c.left, viewRight: c.right, guiLeft: g.left, centre: px(s.center),
        lo: px(s.center.clone().addScaledVector(right, -s.radius)),
        hi: px(s.center.clone().addScaledVector(right, s.radius)), target, height: c.height,
        top: c.top + (1 - s.center.clone().project(cam).y) / 2 * c.height };
    };
    // Not squashed: as many pixels a millimetre across as down, after the load's own fit, zoom all and a view.
    const scales = () => { const P = cam.projectionMatrix.elements, c = v.renderer.domElement;
      return P[0] * c.clientWidth / (P[5] * c.clientHeight); };
    const squash = [scales()];
    v.zoomAll();
    squash.push(scales());
    v.setView('iso');
    squash.push(scales());
    v.zoomAll();
    const open = fitted();
    // Nothing covered (as when the controls are hidden): the axis back at the view's centre at once.
    const was = v.covered;
    v.setCovered(0);
    const uncovered = fitted().target;
    v.setCovered(was);
    ui.gui.close();
    await new Promise((r) => setTimeout(r, 300));
    v.setCamera({ ...v.cameraState(), height: 10 });
    v.zoomAll();
    const closed = fitted();
    ui.gui.open();
    // Zoom selected the same.
    // (A part's sphere as zoom selected makes it: around its mesh's box, placed.)
    const part = ui.panel().model.nodes.find((n) => n.kind === 'part' && n.name === 'plate');
    ui.select([part.id]);
    ui.zoomSelected();
    const mesh = part.object.children[0];
    mesh.geometry.computeBoundingBox();
    const selected = fitted(mesh.geometry.boundingBox.getBoundingSphere(v.modelSphere())
      .applyMatrix4(mesh.matrixWorld));
    return { open, closed, selected, uncovered, squash };
  })()`;
  type Fitted = { viewLeft: number; viewRight: number; guiLeft: number; centre: number; lo: number; hi: number;
    target: number; height: number; top: number };
  const url = `?url=${encodeURIComponent('/content/as1.stp')}&check`;
  // In a window 1200 pixels wide; in the check's usual one, where the free width would be under half the view's,
  // the whole view (as on phones).
  const { uncovered, squash, ...a } = (await page(url, script, { scale: 1 }) as { after: Record<string, Fitted> &
    { uncovered: number; squash: number[] } }).after;
  expect(squash.every((x) => Math.abs(x - 1) < 1e-9), `squashed (across / down): ${squash}`);
  expect(Math.abs(uncovered - (a.open!.viewLeft + a.open!.viewRight) / 2) < 1, `uncovered: ${uncovered}`);
  const narrow = (await page(url, script) as { after: Record<string, Fitted> }).after.open!;
  expect(narrow.guiLeft - narrow.viewLeft < (narrow.viewRight - narrow.viewLeft) / 2 &&
    Math.abs(narrow.target - (narrow.viewLeft + narrow.viewRight) / 2) < 1, `narrow: ${JSON.stringify(narrow)}`);
  const j = JSON.stringify(a);
  for (const [k, f] of Object.entries(a)) {
    const mid = (f.viewLeft + f.guiLeft) / 2;
    expect(f.guiLeft < f.viewRight - 100, `${k}: the controls aren't over the view: ${j}`);
    expect(Math.abs(f.target - mid) < 1, `${k}: the axis not centred beside the controls: ${j}`);
    expect(Math.abs(f.centre - mid) < 1 && f.lo >= f.viewLeft - 1 && f.hi <= f.guiLeft + 1 &&
      Math.abs(f.top - f.height / 2) < 1, `${k}: not fitted beside the controls: ${j}`);
    // The narrower side: the free width here (wider than tall would fit the height instead).
    const free = f.guiLeft - f.viewLeft;
    if (free < f.height) expect(Math.abs((f.hi - f.lo) - free / 1.1) < 2, `${k}: not filling the width: ${j}`);
  }
  return undefined;
});
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
    // A face of the first part, hidden: that placement draws it with nothing, the part's others draw it (faces per
    // placement since 2026-10-31).
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
    const sameHidden = same.filter((n) => m.hiddenInTree(n.id)).length;
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
  expect(a.same > 1 && a.sameHidden === 1 && a.invisibleGroups === 1, `face hiding: ${j}`);
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
  // A GLB (through gltf-import, as every format): Phong faces as STEP's, its edges (our `edges` nodes) on their layer.
  const g = await page(`?url=${encodeURIComponent('/content/as1.glb')}&check`, `(async () => {
    const kinds = new Set();
    viewer.display.traverse((o) => { if (o.isMesh) for (const m of [o.material].flat()) kinds.add(m.type); });
    let edges = 0, onLayer = 0;
    viewer.display.traverse((o) => {
      if (o.isLine && o.name === 'edges') { edges++; if (o.layers.mask === 2) onLayer++; }
    });
    return { phong: [...kinds].sort(), edges, onLayer };
  })()`) as { after?: { phong: string[]; edges: number; onLayer: number } };
  expect(g.after!.phong.join() === 'MeshPhongMaterial', `Phong faces: ${JSON.stringify(g.after)}`);
  expect(g.after!.edges > 0 && g.after!.onLayer === g.after!.edges, `glTF edges' layer: ${JSON.stringify(g.after)}`);
  // Transparency: three.js's sorting of transparent objects; N8AO aware of them.
  const t = await page(`?url=${encodeURIComponent('/content/as1-clear.glb')}&check`, `(async () => {
    const ms = []; viewer.display.traverse((o) => { if (o.isMesh) ms.push(...[o.material].flat()); });
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const out = { all: ms.length, clear: ms.filter((m) => m.isMeshPhongMaterial && m.transparent &&
      m.opacity === 0.5).length, aware: viewer.composer.n8ao.configuration.transparencyAware,
      sorted: viewer.renderer.sortObjects, glError: viewer.renderer.getContext().getError() };
    // An opaque model next: N8AO told so.
    await cadViewer.load('/content/as1.glb');
    await cadViewer.idle();
    return { ...out, opaqueAware: viewer.composer.n8ao.configuration.transparencyAware };
  })()`) as { after?: { all: number; clear: number; aware: boolean; sorted: boolean; glError: number;
    opaqueAware: boolean } };
  const ta = t.after!;
  expect(ta.all > 0 && ta.clear === ta.all && ta.aware && ta.sorted && ta.glError === 0 && !ta.opaqueAware,
    `transparency: ${JSON.stringify(ta)}`);
  return undefined;
});
// Sections on the STEP assembly: a plane across X through the middle cuts the model (the renderer's clipping
// planes), caps the closed parts (read back from the drawn frame: the plate's colour where its cut is, the background
// without caps), keeps picks off the cut-away side; flipping it keeps the other side.
await check('sections', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const m = ui.panel().model;
    const mesh = (name) => m.nodes.find((n) => n.kind === 'part' && n.name === name).object.children[0];
    const boxOf = (o) => { o.geometry.computeBoundingBox(); return o.geometry.boundingBox.clone()
      .applyMatrix4(o.matrixWorld); };
    const frames = (n) => new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });
    // Colours where world points are drawn, after real frames (the viewer's own drawing makes the caps), rendered
    // again and read back in one task: each the mean over a square of 16 device pixels a side (caps are hatched).
    const colours = async (points) => {
      await frames(3);
      viewer.composer.render();
      viewer.composer.render();
      const dpr = viewer.renderer.getPixelRatio(), n = 16;
      return points.map((v) => { const p = v.clone().project(viewer.camera), out = new Uint8Array(4 * n * n);
        gl.readPixels(Math.round((p.x + 1) / 2 * canvas.clientWidth * dpr) - n / 2,
          Math.round((p.y + 1) / 2 * canvas.clientHeight * dpr) - n / 2, n, n, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return [0, 1, 2].map((k) => Math.round(out.filter((_, i) => i % 4 === k).reduce((s, x) => s + x, 0) /
          (n * n))); });
    };
    // The rod (round, along X) cut through its middle, seen close: its cap's centre is inside it, the corner of the
    // cap's square isn't.
    const rod = mesh('rod'), rb = boxOf(rod), c = rb.getCenter(rod.position.clone());
    const at = c.x;
    viewer.zoomTo(rb.getBoundingSphere(viewer.modelSphere().clone()));
    const r = Math.min(rb.max.y - rb.min.y, rb.max.z - rb.min.z) / 2;
    // (The corner away from the camera, which looks from +X -Y +Z: behind it, nothing of the rod's kept length.)
    const centre = c.clone(), corner = c.clone().add(rod.position.clone().set(0, 0.9 * r, -0.9 * r));
    const s = viewer.sections.get();
    s.x.on = true;
    s.x.at = at;
    s.caps = true;
    viewer.setSections(s);
    viewer.setRender({ ...viewer.render, capStyle: 'drawing' });
    const [capped, outside] = await colours([centre, corner]);
    // In the parts style (the default): the part's colour.
    viewer.setRender({ ...viewer.render, capStyle: 'parts' });
    const [cappedParts] = await colours([centre]);
    viewer.setRender({ ...viewer.render, capStyle: 'drawing' });
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
    return { planes, caps, capped, cappedParts, outside, cappedPlain, outsidePlain, open,
      kept: kept ? kept.point.x : null,
      gone: gone ? gone.point.x : null,
      at, flipped, glError: gl.getError() };
  })()`) as { after?: { planes: number; caps: number; capped: number[]; cappedParts: number[]; outside: number[];
    cappedPlain: number[];
    outsidePlain: number[]; open: number[];
    kept: number | null; gone: number | null; at: number; flipped: boolean; glError: number } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.planes === 1 && a.caps > 0, `planes and caps: ${j}`);
  // The rod is orange (red high, green middling, blue low); its cap beige hatched black (the drawing style, a mean
  // a quarter black), or orange hatched darker (the parts style); its cap's square outside the circle is neither;
  // with no caps, the cut shows what's beyond.
  const orange = ([r, g, b]: number[]) => r! > 150 && g! > 40 && g! < 200 && b! < 60 && r! > g! + 40;
  const beige = ([r, g, b]: number[]) => r! > 120 && g! > 110 && b! > 90 && r! - b! > 15 && r! - b! < 60 &&
    Math.abs(r! - g!) < 25;
  expect(beige(a.capped), `cap colour (drawing): ${j}`);
  expect(orange(a.cappedParts), `cap colour (parts): ${j}`);
  expect(!beige(a.outside) && !orange(a.outside), `cap outside the solid: ${j}`);
  expect(beige(a.cappedPlain) && !beige(a.outsidePlain), `caps without AO: ${j}`);
  expect(!beige(a.open) && !orange(a.open), `no caps: ${j}`);
  expect(a.kept !== null && a.kept <= a.at + 1e-6 && (a.gone === null || a.gone <= a.at + 1e-6),
    `picking across the plane: ${j}`);
  expect(a.flipped, `flip: ${j}`);
  expect(a.glError === 0, `WebGL error: ${j}`);
  return undefined;
});
// The problems dialog (problems.ts): a file with warnings, once meshed, shows them in a modal (only with
// ?check=dialogs among the check's pages), as many rows as the model's warnings and errors, errors first; OK closes
// it. A file without, and the plain ?check pages, show none.
await check('problems dialog', async () => {
  const look = `(async () => { await cadViewer.ready; await cadViewer.idle();
    await new Promise((r) => setTimeout(r, 200));
    const d = document.querySelector('dialog.cv-dialog');
    const problems = (viewer.model?.diagnostics ?? []).filter((x) => x.severity !== 'info');
    const out = { open: !!d?.open, title: d?.querySelector('h2')?.textContent ?? null,
      rows: d ? [...d.querySelectorAll('tr')].map((r) => r.cells[0].textContent) : [], problems: problems.length,
      errors: problems.filter((x) => x.severity === 'error').length };
    d?.querySelector('button.primary')?.click();
    await new Promise((r) => setTimeout(r, 100));
    return { ...out, closed: !document.querySelector('dialog.cv-dialog') };
  })()`;
  type Seen = { open: boolean; title: string | null; rows: string[]; problems: number; errors: number;
    closed: boolean };
  const broken = (await page(`?url=${encodeURIComponent('/content/broken.stp')}&check=dialogs`, look) as
    { after: Seen }).after;
  const clean = (await page(`?url=${encodeURIComponent('/content/as1.stp')}&check=dialogs`, look) as
    { after: Seen }).after;
  const quiet = (await page(`?url=${encodeURIComponent('/content/broken.stp')}&check`, look) as { after: Seen }).after;
  const j = JSON.stringify({ broken, clean, quiet });
  const firstWarning = broken.rows.findIndex((r) => r.startsWith('warning'));
  expect(broken.problems > 0 && broken.open && broken.rows.length === Math.min(broken.problems, 500) &&
    broken.title!.startsWith('broken.stp: ') && broken.rows.slice(0, broken.errors).every((r) =>
    r.startsWith('error')) && (firstWarning < 0 || firstWarning === broken.errors) && broken.closed,
  `a file with warnings: ${j}`);
  expect(clean.problems === 0 && !clean.open, `a file without: ${j}`);
  expect(quiet.problems > 0 && !quiet.open, `none in plain ?check pages: ${j}`);
  return undefined;
});
// STEP ids (step-ids.ts): the problems dialog's Copy IDs copies its rows' ids (the clipboard stubbed), the dialog
// staying open; Select by ID (Selection) reads what's typed in its dialog: a part's id selects every placement, a
// face's turns the tree's detail on and selects its face nodes, anything else is said; the details panel lists the
// selection's ids, cut short past about 50 characters.
await check('step ids', async () => {
  const copy = (await page(`?url=${encodeURIComponent('/content/broken.stp')}&check=dialogs`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    let copied; navigator.clipboard.writeText = async (t) => { copied = t; };
    await new Promise((r) => setTimeout(r, 200));
    const d = document.querySelector('dialog.cv-dialog');
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent === 'Copy IDs');
    const rows = [...d.querySelectorAll('tr')].map((r) => r.cells[0].textContent);
    b.click();
    await new Promise((r) => setTimeout(r, 100));
    const out = { copied, label: b.textContent, open: d.open, rows };
    d.querySelector('button.primary').click();
    return out;
  })()`) as { after: { copied: string; label: string; open: boolean; rows: string[] } }).after;
  const sel = (await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const m = viewer.nodes;
    const nuts = m.nodes.filter((n) => n.kind === 'part' && n.name === 'nut');
    const partId = nuts[0].object.userData.sources[0];
    const face = m.nodes.find((n) => n.kind === 'part' && n.name === 'plate').object.children[0].userData.faces[0];
    const detailBefore = cadViewer.state().tree.detail;
    // (Every branch folded first: the selection must unfold what it needs.)
    ui.panel().collapseAll();
    ui.gui.controllersRecursive().find((c) => c._name === 'Select by ID...').$button.click();
    await new Promise((r) => setTimeout(r, 100));
    const d = document.querySelector('dialog.cv-dialog');
    d.querySelector('textarea').value = '  #' + partId + '\\n' + face + ' bogus 999999 ';
    d.querySelector('button.primary').click();
    await new Promise((r) => setTimeout(r, 100));
    const status = document.getElementById('status').textContent;
    const s = ui.selected();
    const open = new Set(ui.panel().expanded());
    const unfolded = s.every((id) => { for (let p = m.nodes[id].parent; p >= 0; p = m.nodes[p].parent) {
      if (!open.has(p)) return false; } return true; });
    const kinds = s.map((id) => m.nodes[id].kind).sort();
    const parts = s.filter((id) => m.nodes[id].kind === 'part').sort();
    const lines = ui.details();
    // Every face of the plate selected: the ids line cut short.
    ui.selectByIds(m.nodes.find((n) => n.kind === 'part' && n.name === 'plate').object.children[0].userData.faces
      .join(' '));
    const all = ui.details().find((l) => l.startsWith('STEP IDs: '));
    return { partId, face, kinds, parts, nuts: nuts.map((n) => n.id).sort(), detailBefore,
      detail: cadViewer.state().tree.detail, lines, status, all, unfolded };
  })()`) as { after: { partId: number; face: number; kinds: string[]; parts: number[]; nuts: number[];
    detailBefore: boolean; detail: boolean; lines: string[]; status: string; all: string; unfolded: boolean } })
    .after;
  const j = JSON.stringify({ copy, sel });
  const rowIds = [...new Set(copy.rows.flatMap((r) => r.match(/#(\d+)/)?.[1] ?? []))].map((x) => `#${x}`).join(' ');
  expect(copy.copied === rowIds && rowIds.length > 0 && copy.open && /^Copied \d+ IDs?$/.test(copy.label),
    `copy ids: ${j}`);
  expect(JSON.stringify(sel.parts) === JSON.stringify(sel.nuts) && sel.kinds.includes('face') && !sel.detailBefore &&
    sel.detail, `select by id: ${j}`);
  expect(sel.unfolded, `every node selected shown in the tree, its branches unfolded: ${j}`);
  expect(/not found: #999999/.test(sel.status) && /not IDs: bogus/.test(sel.status), `what wasn't found: ${j}`);
  expect(sel.lines.some((l) => l.startsWith('STEP IDs: ') && l.includes(`#${sel.partId}`) &&
    l.includes(`#${sel.face}`)), `the details' ids: ${j}`);
  expect(sel.all.length <= 'STEP IDs: '.length + 50 && sel.all.endsWith(' ...'), `cut short: ${j}`);
  return undefined;
});
// Picks unfold the tree (the user, 2026-10-28): with every branch folded, two parts picked in the 3D view (the
// second added, as ctrl-click does) are both shown selected in the tree, their branches unfolded.
await check('picks unfold the tree', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const m = viewer.nodes, canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    const centre = (name) => { const o = m.nodes.find((n) => n.kind === 'part' && n.name === name).object.children[0];
      o.geometry.computeBoundingBox();
      const p = o.geometry.boundingBox.getCenter(o.position.clone()).applyMatrix4(o.matrixWorld).project(viewer.camera);
      return [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height]; };
    ui.panel().collapseAll();
    const [rx, ry] = centre('rod'), [px, py] = centre('plate');
    ui.pickAt(rx, ry, false);
    ui.pickAt(px, py, true);
    const s = ui.selected(), open = new Set(ui.panel().expanded());
    const unfolded = s.every((id) => { for (let p = m.nodes[id].parent; p >= 0; p = m.nodes[p].parent) {
      if (!open.has(p)) return false; } return true; });
    return { selected: s.map((id) => m.nodes[id].name), unfolded };
  })()`) as { after: { selected: string[]; unfolded: boolean } };
  const j = JSON.stringify(r.after);
  expect(r.after.selected.length === 2 && r.after.unfolded, `both picks shown, their branches unfolded: ${j}`);
  return undefined;
});
// Selection's buttons in the tree (the user, 2026-10-28): with every branch folded, Select all, Invert selection,
// Select parent and Select none each leave every selected node shown, its branches unfolded, and the drawn rows
// highlighted exactly as the selection is (none stale), the tree scrolled to show a selected row.
await check('selection buttons in the tree', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const m = viewer.nodes;
    const press = (name) => ui.gui.controllersRecursive().find((c) => c._name === name).$button.click();
    const look = async () => {
      for (let i = 0; i < 2; i++) await new Promise((res) => requestAnimationFrame(res));
      const s = new Set(ui.selected()), open = new Set(ui.panel().expanded());
      const unfolded = [...s].every((id) => { for (let p = m.nodes[id].parent; p >= 0; p = m.nodes[p].parent) {
        if (!open.has(p)) return false; } return true; });
      const rows = [...document.querySelectorAll('.tree-row')].filter((e) => e.style.display !== 'none');
      const stale = rows.filter((e) => e.classList.contains('selected') !== s.has(Number(e.dataset.id))).length;
      const shown = rows.filter((e) => e.classList.contains('selected')).length;
      return { selected: s.size, unfolded, stale, shown };
    };
    const out = {};
    ui.select([m.nodes.find((n) => n.kind === 'part' && n.name === 'rod').id]);
    ui.panel().collapseAll();
    press('Select all'); out.all = await look();
    ui.panel().collapseAll();
    ui.select([m.nodes.find((n) => n.kind === 'part' && n.name === 'plate').id]);
    ui.panel().collapseAll();
    press('Invert selection'); out.invert = await look();
    ui.panel().collapseAll();
    press('Select parent'); out.parent = await look();
    press('Select none'); out.none = await look();
    return out;
  })()`) as { after: Record<string, { selected: number; unfolded: boolean; stale: number; shown: number }> };
  const a = r.after, j = JSON.stringify(a);
  for (const k of ['all', 'invert', 'parent']) {
    expect(a[k]!.selected > 0 && a[k]!.unfolded && a[k]!.stale === 0 && a[k]!.shown > 0, `${k}: ${j}`);
  }
  expect(a.none!.selected === 0 && a.none!.stale === 0, `none: ${j}`);
  return undefined;
});
// Faces that fail to mesh (the user, 2026-10-28): every part of as1 timed out (a millisecond, the cache emptied)
// comes with its faces' outlines from the file, red, the parts and their faces marked failed in the tree (red, a
// broken icon), a click on an outline picking its face (the detail level), the details saying so; the bicycle's
// faces OCCT fails, outlined and marked, their parts partly failed.
await check('failed faces', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    await viewer.clearCache();
    ui.setMeshing({ timeout: 0.001 });
    const before = viewer.model;
    ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.model === before || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100)); }
    await cadViewer.idle();
    const m = viewer.nodes, parts = m.nodes.filter((n) => n.kind === 'part');
    const outlines = [];
    viewer.display.traverse((o) => { if (o.name === 'outline') outlines.push(o); });
    const out = { failedCount: viewer.model.parts.failed, total: viewer.model.parts.total, outlines: outlines.length,
      red: outlines.every((o) => o.material.color.getHex() === 0xe02020),
      partsFailed: parts.filter((n) => m.failure(n.id) === 'failed').length, parts: parts.length };
    // A click on an outline's first point: its face.
    ui.setPickLevel('detail');
    await cadViewer.idle();
    const line = outlines.find((o) => o.visible), rect = viewer.renderer.domElement.getBoundingClientRect();
    const p = line.position.clone().fromBufferAttribute(line.geometry.getAttribute('position'),
      line.geometry.index.getX(0)).applyMatrix4(line.matrixWorld).project(viewer.camera);
    ui.pickAt(rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height, false);
    const picked = ui.selected().map((id) => m.nodes[id]);
    out.picked = picked.map((n) => n.kind + ':' + n.failure);
    for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
    const row = document.querySelector('.tree-row.selected');
    out.row = row ? { failed: row.classList.contains('failed'), broken: !!row.querySelector('.tree-icon.broken'),
      colour: getComputedStyle(row).color } : null;
    out.details = ui.details();
    return out;
  })()`) as { after: { failedCount: number; total: number; outlines: number; red: boolean; partsFailed: number;
    parts: number; picked: string[]; row: { failed: boolean; broken: boolean; colour: string } | null;
    details: string[] } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.total > 0 && a.failedCount === a.total && a.outlines > 0 && a.red, `every part outlined in red: ${j}`);
  expect(a.partsFailed === a.parts, `every part marked failed: ${j}`);
  expect(a.picked.length === 1 && a.picked[0] === 'face:failed', `an outline picks its face: ${j}`);
  // (Red in either theme: #d32f2f light, #ff6b6b dark, as the system prefers.)
  const [red, green, blue] = (a.row?.colour.match(/\d+/g) ?? []).map(Number);
  expect(!!a.row?.failed && a.row.broken && red! >= 200 && red! - Math.max(green!, blue!) >= 80,
    `its row red, a broken icon: ${j}`);
  expect(a.details.some((l) => /Failed to mesh: its outline is drawn in red/.test(l)), `the details: ${j}`);
  const b = (await page(`?url=${encodeURIComponent('/content/bicycle.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const m = viewer.nodes, parts = m.nodes.filter((n) => n.kind === 'part');
    let outlines = 0;
    viewer.display.traverse((o) => { if (o.name === 'outline') outlines++; });
    const partly = parts.filter((n) => m.failure(n.id) === 'partly');
    ui.setTree({ detail: true });
    // (Each partly failed part has a face that failed: wholly, red, or partly, short of its area.)
    const faces = partly.flatMap((n) => m.children(n.id)).map((c) => m.failure(c)).filter((f) => f);
    // Rows that failed partly red too, with the broken icon (the user, 2026-10-30): a partly failed part's, and a
    // face of it short of its area, each selected (so revealed and drawn).
    const shortFace = partly.flatMap((n) => m.children(n.id)).find((c) => m.failure(c) === 'partly');
    const rows = [];
    for (const id of [partly[0].id, ...(shortFace === undefined ? [] : [shortFace])]) {
      ui.select([id]);
      for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
      const row = document.querySelector('.tree-row.selected');
      rows.push(!!row && row.classList.contains('failed') && !!row.querySelector('.tree-icon.broken'));
    }
    const rowsRed = rows.filter((x) => x).length;
    // The outlines drawn red over the black edges along the same B-rep edges (depth-bias.ts), thin and fat: each
    // outline seen close, the pixels at its segments' midpoints read back.
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const frames = (n) => new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });
    const lines = [];
    viewer.display.traverse((o) => { if (o.name === 'outline') lines.push(o); });
    const drawnRed = async () => {
      let red = 0, black = 0, all = 0;
      for (const l of lines) {
        l.geometry.computeBoundingSphere();
        viewer.zoomTo(l.geometry.boundingSphere.clone().applyMatrix4(l.matrixWorld));
        await frames(3);
        viewer.composer.render();
        const pos = l.geometry.getAttribute('position'), dpr = viewer.renderer.getPixelRatio();
        const v = l.geometry.boundingSphere.center.clone(), w = v.clone(), out = new Uint8Array(4 * 9);
        for (let i = 0; i + 1 < pos.count; i += 2) {
          v.fromBufferAttribute(pos, i).add(w.fromBufferAttribute(pos, i + 1)).multiplyScalar(0.5)
            .applyMatrix4(l.matrixWorld).project(viewer.camera);
          if (Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.95) continue;
          // The reddest of the 3 x 3 device pixels around it (a line 1 pixel wide may fall between two).
          gl.readPixels(Math.round((v.x + 1) / 2 * canvas.clientWidth * dpr) - 1,
            Math.round((v.y + 1) / 2 * canvas.clientHeight * dpr) - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, out);
          let best = -255, dark = 255;
          for (let k = 0; k < 9; k++) {
            best = Math.max(best, out[4 * k] - Math.max(out[4 * k + 1], out[4 * k + 2]));
            dark = Math.min(dark, Math.max(out[4 * k], out[4 * k + 1], out[4 * k + 2]));
          }
          all++;
          if (best > 100) red++;
          // (Black edges' colour where the outline isn't: lost to the edge along it.)
          else if (dark < 60) black++;
        }
      }
      return { red, black, all };
    };
    const thin = await drawnRed();
    viewer.setRender({ ...viewer.render, edgeStyle: 'fat' });
    const fat = await drawnRed();
    return { outlines, partly: partly.length, faces: faces.length, red: faces.filter((f) => f === 'failed').length,
      failedParts: viewer.model.parts.failed, thin, fat, rows: rows.length, rowsRed };
  })()`) as { after: { outlines: number; partly: number; faces: number; red: number; failedParts: number;
    thin: { red: number; black: number; all: number }; fat: { red: number; black: number; all: number };
    rows: number; rowsRed: number } }).after;
  console.log(`failed faces: the bicycle's outlines at ${b.thin.all} midpoints: red ${b.thin.red}, black ${b.thin.black} `
    + `thin; red ${b.fat.red}, black ${b.fat.black} fat`);
  expect(b.rows > 0 && b.rowsRed === b.rows, `broken rows not all red: ${b.rowsRed} of ${b.rows}`);
  expect(b.outlines > 0 && b.partly > 0 && b.faces >= b.partly && b.red > 0 && b.failedParts === 0,
    `the bicycle's failed faces: ${JSON.stringify(b)}`);
  // Black where the red outline should be, at its midpoints: without the bias 270 fat and 175 thin of 5,176; with it
  // 3 and 67 (thin lines lose more to the faces beside them, behind which the file's curve can lie).
  expect(b.fat.all > 1000 && b.fat.black <= b.fat.all / 500 && b.thin.black <= b.thin.all / 50,
    `outlines under the black edges: ${JSON.stringify({ thin: b.thin, fat: b.fat })}`);
  return undefined;
});
// B-Rep Meshing's Timeout: a limit too short for any part (a millisecond) fails every part, timed out (said in the
// diagnostics; the cache on, emptied first); then 60 s and Mesh again meshes them all, the cache's timeouts not
// answering for a longer limit. The model's meshedWith has the timeout.
await check('meshing timeout', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const again = async () => {
      const before = viewer.model;
      ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
      for (let t = 0; t < 1200 && (viewer.model === before || !viewer.model?.meshing); t++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await cadViewer.idle();
      const m = viewer.model;
      return { parts: m.parts, timedOut: m.diagnostics.filter((d) => /timed out/.test(d.message)).length,
        timeout: m.meshedWith.timeout };
    };
    const control = ui.gui.controllersRecursive().find((c) => c._name.startsWith('Timeout'));
    // (The cache emptied first: it answers with the meshes made at startup, and pages share it.)
    await viewer.clearCache();
    control.setValue(0.001);
    const short = await again();
    control.setValue(60);
    const long = await again();
    return { short, long };
  })()`) as { after: { short: Meshed; long: Meshed } };
  type Meshed = { parts: { total: number; done: number; failed: number }; timedOut: number; timeout: number };
  const { short, long } = r.after, j = JSON.stringify(r.after);
  expect(short.parts.total > 0 && short.parts.failed === short.parts.total && short.timedOut >= short.parts.total &&
    short.timeout === 0.001, `a millisecond: every part timed out: ${j}`);
  expect(long.parts.failed === 0 && long.parts.done === long.parts.total && long.timedOut === 0 &&
    long.timeout === 60, `60 s: every part meshed again: ${j}`);
  return undefined;
});
// STEP's tessellated geometry (the user, 2026-10-29): read and drawn as it is, nothing meshed, faces by STEP id and
// edges shared between them; a B-rep's tessellation shown, then replaced by OCCT's mesh (not drawn beside it), kept
// when meshing fails (a millisecond's timeout); by the backend when chosen, a part of its own, meshed.
await check('tessellated STEP', async () => {
  const ftc = await page(`?url=${encodeURIComponent('/content/ftc08-tg.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const m = viewer.model;
    return { parts: m.parts, status: document.getElementById('status').textContent };
  })()`) as { stats?: { triangles: number; segments: number }; after: { parts: { total: number }; status: string } };
  expect(ftc.stats!.triangles === 3368 && ftc.stats!.segments === 1883,
    `FTC 08: ${JSON.stringify(ftc.stats)}, expected 3368 triangles, 1883 edge segments`);
  expect(ftc.after.parts.total === 0 && /^ftc08-tg.stp: [\d.]+ s$/.test(ftc.after.status), `FTC 08 meshed: ${JSON.stringify(ftc.after)}`);
  const r = await page(`?url=${encodeURIComponent('/content/cube-tess.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const again = async () => {
      const before = viewer.model;
      ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
      for (let t = 0; t < 1200 && (viewer.model === before || !viewer.model?.meshing); t++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await cadViewer.idle();
      return { parts: viewer.model.parts, triangles: viewer.stats().triangles };
    };
    const first = { parts: viewer.model.parts, triangles: viewer.stats().triangles };
    const control = (name) => ui.gui.controllersRecursive().find((c) => c._name.startsWith(name));
    await viewer.clearCache();
    control('Timeout').setValue(0.001);
    const failed = await again();
    control('Timeout').setValue(60);
    control('Tessellated geometry').setValue('backend');
    const backend = await again();
    return { first, failed, backend };
  })()`) as { after: Record<string, { parts: { total: number; done: number; failed: number }; triangles: number }> };
  const { first, failed, backend } = r.after, j = JSON.stringify(r.after);
  expect(first!.parts.total === 1 && first!.parts.failed === 0 && first!.triangles === 12,
    `the cube meshed: OCCT's 12 triangles in place of the file's 2: ${j}`);
  expect(failed!.parts.failed === 1 && failed!.triangles === 2, `meshing failed: the file's 2 triangles kept: ${j}`);
  expect(backend!.parts.total === 2 && backend!.parts.failed === 0 && backend!.triangles === 14,
    `by the backend: two parts meshed, 12 + 2 triangles: ${j}`);
  return undefined;
});
// Two planes (the user, 2026-10-27: a cap missing where another plane cuts): the plate cut across X through its
// middle (the side above cut away) and across Z through its middle, flipped (the side below cut away), seen from
// +X -Y +Z. On the X cap above the Z plane, the plate's far side along the view lies below it, cut away: the stencil
// passes counting it must be clipped by their own plane only, or the X cap isn't drawn there.
await check('two planes', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const plate = ui.panel().model.nodes.find((n) => n.kind === 'part' && n.name === 'plate').object.children[0];
    plate.geometry.computeBoundingBox();
    const pb = plate.geometry.boundingBox.clone().applyMatrix4(plate.matrixWorld);
    const c = pb.getCenter(plate.position.clone());
    ui.setRender({ capStyle: 'drawing' });
    cadViewer.view('iso');
    viewer.zoomTo(pb.getBoundingSphere(viewer.modelSphere().clone()));
    const s = viewer.sections.get();
    s.x = { on: true, at: c.x, flip: false };
    s.z = { on: true, at: c.z, flip: true };
    s.caps = true;
    viewer.setSections(s);
    // On the X cap, halfway between the Z plane and the plate's top.
    const p = c.clone().setZ((c.z + pb.max.z) / 2);
    const colour = async () => {
      for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
      viewer.composer.render(); viewer.composer.render();
      const dpr = viewer.renderer.getPixelRatio(), n = 8, q = p.clone().project(viewer.camera);
      const out = new Uint8Array(4 * n * n);
      gl.readPixels(Math.round((q.x + 1) / 2 * canvas.clientWidth * dpr) - n / 2,
        Math.round((q.y + 1) / 2 * canvas.clientHeight * dpr) - n / 2, n, n, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return [0, 1, 2].map((k) => Math.round(out.filter((_, i) => i % 4 === k).reduce((a, x) => a + x, 0) /
        (n * n)));
    };
    const both = await colour();
    viewer.setSections({ ...s, z: { ...s.z, on: false } });
    const alone = await colour();
    viewer.setSections({ ...s, caps: false });
    const open = await colour();
    return { both, alone, open };
  })()`) as { after: { both: number[]; alone: number[]; open: number[] } };
  const a = r.after, j = JSON.stringify(a);
  const beige = ([r, g, b]: number[]) => r! > 120 && g! > 110 && b! > 90 && r! - b! > 15 && r! - b! < 60 &&
    Math.abs(r! - g!) < 25;
  expect(beige(a.alone) && !beige(a.open), `the X cap there, X alone; none with caps off: ${j}`);
  expect(beige(a.both), `the X cap there with the Z plane on too: ${j}`);
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
  // (And as1 in a window 1200 pixels wide, where the projection is shifted beside the controls.)
  for (const [file, wide] of [['as1.stp', false], ['as1.glb', false], ['bicycle.stp', false], ['metres.stp', false],
    ['as1.stp', true]] as const) {
    const r = await page(`?url=${encodeURIComponent(`/content/${file}`)}&check`,
      wide ? `(viewer.zoomAll(), ${PICK_ORACLE})` : PICK_ORACLE, wide ? { scale: 1 } : {}) as
      { after: { onParts: number; wrong: number; subpixel: number; lines: number; far: number; examples: unknown[] } };
    const a = r.after;
    expect(a.onParts > 100 && a.wrong === 0 && a.subpixel <= a.onParts / 50 && a.lines > 0 && a.far === 0,
      `${file}: ${JSON.stringify(a)}`);
    out.push(`${file}${wide ? ' (wide)' : ''} ${a.onParts} (${a.subpixel} thinner than a pixel; ${a.lines} lines `
      + 'picked)');
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
      edgeStyle: viewer.render.edgeStyle,
      triangles: viewer.stats().triangles };
  })()`, { phone: true, asIs: true, then: async (sessionId, after) => {
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
    workers: number; spot?: { id: number; x: number; y: number }; triangles: number; edgeStyle: string;
    device: { detected: string; used: string; profile: string } }; then?: { selected: number[];
    opened: { side: number; handle: number; saved: string | null }; dragged: { side: number; saved: string | null };
    wide: number } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.treeClosed && a.guiClosed, `closed at first: ${j}`);
  expect(a.device.detected === 'phone' && a.device.used === 'phone' && a.device.profile === 'coarse' &&
    a.triangles === coarseTriangles, `a phone, meshed coarse (${coarseTriangles} triangles): ${j}`);
  expect(a.overscroll === 'none' && a.touch > 0 && a.workers <= 3 && a.handle === 'block' && a.edgeStyle === 'thin',
    `phone settings (thin edges too): ${j}`);
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
// the cache off) keeps the camera, a cut, what's hidden and what's selected, the tree's expansion (detail
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
    notRestored?: { overrides: string[]; selected: string[] } } } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.allClosed, `folders closed at first: ${j}`);
  expect(a.disabledEmpty && a.enabledSelected && a.zoomAfter, `zoom selected: ${j}`);
  expect(/^occt /.test(a.backend ?? '') && !a.pageTessellation, `the import worker: ${j}`);
  expect(a.triangles[0]! > 0 && a.triangles[1]! > 0 && a.triangles[0] !== a.triangles[1], `meshed anew: ${j}`);
  const kept = ['camera', 'cut', 'hidden', 'selected'] as const;
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
    'x' in (a.after.cut as object), `the state set: ${j}`);
  const [tb, ta] = a.tree;
  expect(tb!.rows && tb!.expanded.length > 3 && tb!.top?.[1] === 5, `the tree set: ${JSON.stringify(tb)}`);
  expect(JSON.stringify(tb!.expanded) === JSON.stringify(ta!.expanded), `the tree's expansion kept: ${
    JSON.stringify(a.tree)}`);
  expect(JSON.stringify(tb!.top) === JSON.stringify(ta!.top), `the tree's top row kept: ${JSON.stringify(a.tree)}`);
  const l = a.lost;
  expect(/; 1 hidden or transparent and 1 selected not found again \(in the console\)$/.test(l.status) &&
    l.notRestored?.overrides.join() === l.paths[0] && l.notRestored?.selected.join() === l.paths[1],
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
    // (Made again: every appearance change rebuilds them, model.ts's overrides deciding per face.)
    const now = () => [...viewer.triangleEdges.group.children];
    let ws = now();
    const partHidden = ws.length === meshes.length && ws.filter((w, i) => under.has(meshes[i])).every((w) =>
      !w.visible) && ws.some((w, i) => !under.has(meshes[i]) && w.visible) && ws.some((w, i) => under.has(meshes[i]));
    ui.setHidden([part.id], false);
    // A face hidden: its group's edges not drawn.
    ui.setTree({ detail: true });
    const face = m.children(part.id).map((id) => m.nodes[id]).find((n) => n.kind === 'face');
    ui.setHidden([face.id], true);
    await cadViewer.idle();
    const k = meshes.findIndex((x) => Array.isArray(x.material) && x.material.some((y) => !y.visible));
    const invisible = (ms) => ms.map((y, i) => y.visible ? -1 : i).filter((i) => i >= 0).join();
    ws = now();
    const faceHidden = k >= 0 && ws[k].visible && invisible(ws[k].material) === invisible(meshes[k].material);
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
    // GPU instances (our GLB's), read back as placements: a wireframe on each, as for any mesh.
    await cadViewer.load('/content/as1-instanced.glb');
    cadViewer.apply({ render: { triangleEdges: 'all' } });
    await cadViewer.idle();
    const inst = [], placedMeshes = [];
    viewer.display.traverse((o) => { if (o.isInstancedMesh) inst.push(o); else if (o.isMesh) placedMeshes.push(o); });
    const iw = viewer.triangleEdges.group.children;
    const instanced = inst.length === 0 && placedMeshes.length === 18 && iw.length === placedMeshes.length;
    return { placed, instanced, none, selectedPart, selectedFace, cleared, changed, total: on.length / 4, shared,
      unchanged, partHidden, faceHidden, wires: wires.length };
  })()`) as { after: { changed: number; total: number; shared: boolean; unchanged: boolean; partHidden: boolean;
    faceHidden: boolean; wires: number; none: number; selectedPart: boolean; selectedFace: boolean;
    cleared: boolean; placed: boolean; instanced: boolean } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.shared && a.wires > 0 && a.placed, `a wireframe per mesh, its geometry shared, where it is: ${j}`);
  expect(a.instanced, `GPU instances, as placements: ${j}`);
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
    // On by default (the user, 2026-10-28).
    out.detailsDefault = button('Details').getValue();
    button('Details').setValue(false);
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
    const part = all('part');
    // Invert selection: one shown part selected, the other shown ones; inverted again, that one.
    const first = parts[1].id;
    ui.select([first]);
    button('Invert selection').$button.click();
    out.inverted = [...ui.selected()].sort();
    button('Invert selection').$button.click();
    out.invertedBack = [...ui.selected()];
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
  expect(a.detailsDefault === true, `details on by default: ${j}`);
  expect(JSON.stringify(a.inverted) === JSON.stringify(a.shown.slice(1).sort()) &&
    JSON.stringify(a.invertedBack) === JSON.stringify([a.shown[0]]), `invert selection: ${j}`);
  expect(JSON.stringify([...a.part].sort()) === JSON.stringify([...a.shown].sort()), `select all, parts: ${j}`);
  expect(JSON.stringify([...a.assembly].sort()) === JSON.stringify([...a.parents].sort()), `assemblies: ${j}`);
  expect(a.tree.detail && a.detailCount > a.shown.length && a.kinds.includes('face') && a.detailHidden === 0 &&
    JSON.stringify(a.detailParents) === JSON.stringify(a.shownPaths), `detail: ${j}`);
  return undefined;
});
// About... (File): the authors, Claude first; the license; the repository's link; in a build, licenses.md's, which
// is there; no model open, or the model's file, objects and triangles (the Model folder until 2026-10-28, gone).
await check('about', async () => {
  const about = (query: string) => page(query, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
    const d = await new Promise((res) => { const f = () => { const e = document.querySelector('dialog.cv-dialog[open]');
      if (e) res(e); else setTimeout(f, 50); }; f(); });
    const links = [...d.querySelectorAll('a')].map((a) => ({ href: a.href, target: a.target, rel: a.rel }));
    const licenses = links.find((l) => /licenses\.md$/.test(l.href));
    const status = licenses ? (await fetch(licenses.href)).status : undefined;
    const text = d.textContent;
    const rows = [...d.querySelectorAll('tr')].map((r) => [...r.cells].map((c) => c.textContent));
    d.querySelector('button').click();
    await new Promise((res) => setTimeout(res, 100));
    return { title: d.querySelector('h2').textContent, text, links, status, closed: !d.isConnected, rows,
      triangles: viewer.stats()?.triangles, folders: ui.gui.foldersRecursive().map((f) => f._title) };
  })()`) as Promise<{ after: { title: string; text: string; links: { href: string; target: string; rel: string }[];
    status?: number; closed: boolean; rows: string[][]; triangles?: number; folders: string[] } }>;
  const a = (await about('?check')).after;
  const m = (await about(`?url=${encodeURIComponent('/content/as1.stp')}&check`)).after;
  const j = JSON.stringify({ a, m });
  expect(/No model open\./.test(a.text) && !a.rows.length && !a.folders.includes('Model'), `no model: ${j}`);
  expect(m.rows[0]?.join() === 'File,as1.stp' && m.rows[1]?.[0] === 'Objects' &&
    m.rows[2]?.join() === `Triangles,${m.triangles!.toLocaleString()}` && m.triangles! > 0, `as1 open: ${j}`);
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
    l.gui === 'rgb(246, 246, 246)' && l.bar === '#f4f4f4' && l.view === 0xffffff;
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
// View's Custom background: off, the theme's; on, the picker's colour (drawn, and the page's --view-bg behind the
// view), the picker enabled only then; remembered, so a new page starts with it from its first paint (index.html's
// inline script); off again, the theme's. (Turned off and forgotten at the end: pages share the profile.)
await check('custom background', async () => {
  const look = `({ view: viewer.scene.background.getHex(),
    css: getComputedStyle(document.documentElement).getPropertyValue('--view-bg').trim(),
    theme: document.documentElement.dataset.theme ?? 'dark',
    picker: !ui.gui.controllersRecursive().find((c) => c._name === 'Background')._disabled,
    saved: localStorage.getItem('cad-viewer.background') })`;
  const control = (name: string, v: unknown) => `ui.gui.controllersRecursive().find((c) => c._name === '${name}')
    .setValue(${JSON.stringify(v)})`;
  const r = await page('?check', `(async () => { await cadViewer.ready; await cadViewer.idle();
    const off = ${look};
    ${control('Background', '#123abc')}; const pickedOff = ${look};
    ${control('Custom background', true)}; await cadViewer.idle(); const on = ${look};
    ${control('Background', '#00ff0a')}; await cadViewer.idle(); const changed = ${look};
    return { off, pickedOff, on, changed }; })()`) as { after: Record<string, Look> };
  type Look = { view: number; css: string; theme: string; picker: boolean; saved: string | null };
  const early = `document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive')
    window.earlyBg = getComputedStyle(document.documentElement).getPropertyValue('--view-bg').trim(); });`;
  const again = await page('?check', `(async () => { await cadViewer.ready; await cadViewer.idle();
    const kept = { ...${look}, early: window.earlyBg };
    ${control('Custom background', false)}; await cadViewer.idle(); const off = ${look};
    localStorage.removeItem('cad-viewer.background');
    return { kept, off }; })()`, { first: early }) as { after: { kept: Look & { early: string }; off: Look } };
  const j = JSON.stringify({ ...r.after, ...again.after });
  const themes: Record<string, number> = { dark: 0x404040, light: 0xffffff };
  const { off, pickedOff, on, changed } = r.after as Record<string, Look>;
  // (A build's CSS writes #ffffff as #fff.)
  const hex = (css: string) => css.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3');
  const theirs = (l: Look) => l.view === themes[l.theme] && hex(l.css) === `#${themes[l.theme]!.toString(16)}`;
  expect(theirs(off!) && !off!.picker, `off at first, the theme's: ${j}`);
  expect(theirs(pickedOff!), `a colour picked while off changes nothing: ${j}`);
  expect(on!.view === 0x123abc && on!.css === '#123abc' && on!.picker, `on, the picker's: ${j}`);
  expect(changed!.view === 0x00ff0a && changed!.css === '#00ff0a', `the picker followed: ${j}`);
  const { kept, off: off2 } = again.after;
  expect(kept.view === 0x00ff0a && kept.early === '#00ff0a' && kept.picker, `remembered, from the first paint: ${j}`);
  expect(theirs(off2) && !off2.picker && JSON.parse(off2.saved!).color === '#00ff0a',
    `off again, the theme's (the colour kept): ${j}`);
  return undefined;
});
// Caps on a part whose faces are primitives of their own (faces.glb: a box, a primitive per face, as Onshape writes
// them): one part (gltf-import: a mesh's primitives its faces), capped as one solid, one cap.
await check('caps on a part of several meshes', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/faces.glb')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const meshes = [];
    viewer.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const st = viewer.sections.get();
    st.z.on = true;
    ui.setSections(st);
    await cadViewer.idle();
    return { meshes: meshes.length, caps: viewer.sections.caps.length,
      colour: [meshes[0].material].flat()[0].color.getHexString('srgb') };
  })()`) as { after: { meshes: number; caps: number; colour: string } };
  // (One part: the glTF mesh, its six primitives its faces.)
  expect(r.after.meshes === 1 && r.after.caps === 1, JSON.stringify(r.after));
  // Its colour as Onshape shows it: the factor read as sRGB (248, 135, 1), not as linear.
  expect(r.after.colour === 'f88701', `Onshape's colour: ${JSON.stringify(r.after)}`);
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
// Fat edges (Rendering's Edge lines, the default on desktops): a Wireframe per edge object, outside the model, drawn
// instead of the thin lines, which stay on their layer for picking; wider than thin ones on screen, and as wide as
// asked; a selection's tint and a part's hiding followed; none with edges off; the width control only for fat ones.
await check('fat edges', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&edgeStyle=fat`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    // Dark pixels in a frame drawn as the viewer draws it, read back in the same task.
    const dark = () => {
      viewer.draw();
      const w = canvas.width, h = canvas.height, px = new Uint8Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40) n++;
      return n;
    };
    const set = (r) => ui.setRender({ ...viewer.render, ...r });
    const thinEdges = [];
    viewer.display.traverse((o) => { if (o.isLineSegments && o.layers.isEnabled(1)) thinEdges.push(o); });
    // (three.js's Vector2, from an object that has one: the page has no THREE.)
    viewer.draw();
    const THREE_V2 = viewer.fatEdges.pairs[0].wire.material.resolution.constructor;
    viewer.draw();
    const wires = viewer.fatEdges.group.children;
    // Each where its thin edges are; its lines' resolution the view's (CSS pixels; Wireframe sets it itself).
    const size = viewer.renderer.getSize(new THREE_V2());
    const placed = viewer.fatEdges.pairs.every((p) => p.wire.matrixWorld.equals(p.source.matrixWorld) &&
      p.wire.material.resolution.equals(size));
    const out = { thinEdges: thinEdges.length, wires: wires.length, shown: viewer.fatEdges.group.visible,
      layerAfter: viewer.camera.layers.isEnabled(1), fat: dark(), placed };
    // The view resized: the lines' resolution follows.
    const was = viewer.renderer.getSize(new THREE_V2());
    viewer.renderer.setSize(was.x - 100, was.y - 50, false);
    viewer.draw();
    out.resized = viewer.fatEdges.pairs.every((p) => p.wire.material.resolution.x === was.x - 100 &&
      p.wire.material.resolution.y === was.y - 50);
    viewer.renderer.setSize(was.x, was.y, false);
    out.wide = (set({ edgeWidth: 6 }), dark());
    out.thin = (set({ edgeStyle: 'thin', edgeWidth: 1.5 }), dark());
    out.thinShown = viewer.fatEdges.group.visible;
    out.widthHidden = ui.gui.controllersRecursive().find((c) => c._name === 'Edge width (pixels)')._hidden;
    set({ edgeStyle: 'fat' });
    out.widthShown = !ui.gui.controllersRecursive().find((c) => c._name === 'Edge width (pixels)')._hidden;
    // A part selected: its edges' fat lines in the tint its thin lines have.
    const part = viewer.nodes.nodes.find((n) => n.kind === 'part');
    ui.select([part.id]);
    viewer.draw();
    const thinOf = []; part.object.traverse((o) => { if (o.isLineSegments && o.layers.isEnabled(1)) thinOf.push(o); });
    const wireOf = (t) => viewer.fatEdges.pairs.find((p) => p.source === t).wire;
    out.tint = thinOf.every((t) => wireOf(t).material.color.equals(t.material.color)) &&
      thinOf.some((t) => t.material.color.getHex() !== 0);
    // Hidden: its fat lines too.
    ui.setHidden([part.id], true);
    viewer.draw();
    out.hidden = thinOf.every((t) => !wireOf(t).visible);
    set({ edges: false });
    viewer.draw();
    out.edgesOff = viewer.fatEdges.group.visible;
    return out;
  })()`) as { after: Record<string, number | boolean> };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.placed === true && a.resized === true, `placed with their edges, at the view's resolution: ${
    JSON.stringify(a)}`);
  expect((a.thinEdges as number) > 0 && a.wires === a.thinEdges && a.shown === true && a.layerAfter === true,
    `a fat line per edge object, the thin ones' layer kept for picking: ${j}`);
  expect((a.fat as number) > 1.3 * (a.thin as number) && (a.wide as number) > 1.5 * (a.fat as number),
    `wider on screen, and wider still at 6 pixels: ${j}`);
  expect(a.thinShown === false && a.widthHidden === true && a.widthShown === true, `thin: none; the width control: ${
    j}`);
  expect(a.tint === true && a.hidden === true && a.edgesOff === false, `selection, hiding, edges off: ${j}`);
  return undefined;
});
// The lights and specular (Rendering): the ambient light's and the headlight's intensities and every Phong face's
// specular follow the settings; a model loaded after takes them too. (The address as it is: rendering settings in it
// would be applied again after the load, and hide what the meshes were made with.)
await check('lights and specular', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const look = () => {
      const lights = []; viewer.scene.traverse((o) => { if (o.isLight) lights.push([o.type, o.intensity]); });
      const speculars = new Set();
      viewer.display.traverse((o) => { if (o.isMesh) for (const m of [o.material].flat()) if (m.isMeshPhongMaterial)
        speculars.add(m.specular.getHex(THREE_LINEAR)); });
      return { lights: lights.sort(), speculars: [...speculars] };
    };
    const THREE_LINEAR = 'srgb-linear';
    const before = look();
    ui.setRender({ ...viewer.render, specular: 0.8, ambient: 0.7, light: 3 });
    const after = look();
    await cadViewer.load('/content/as1.glb');
    await cadViewer.idle();
    return { before, after, loaded: look() };
  })()`, { asIs: true }) as { after: Record<string, { lights: [string, number][]; speculars: number[] }> };
  const a = r.after;
  const j = JSON.stringify(a);
  const grey = (x: number) => Math.round(x * 255) * 0x010101;
  expect(JSON.stringify(a.before!.lights) === JSON.stringify([['AmbientLight', 1], ['DirectionalLight', 2.5]]) &&
    JSON.stringify(a.before!.speculars) === JSON.stringify([grey(0.4)]), `the defaults: ${j}`);
  expect(JSON.stringify(a.after!.lights) === JSON.stringify([['AmbientLight', 0.7], ['DirectionalLight', 3]]) &&
    JSON.stringify(a.after!.speculars) === JSON.stringify([grey(0.8)]), `changed: ${j}`);
  expect(JSON.stringify(a.loaded!.speculars) === JSON.stringify([grey(0.8)]), `a model loaded after: ${j}`);
  return undefined;
});
// Cap hatching, at a pixel ratio of 2: the lines fixed on the model (twice as far apart on the screen zoomed in
// twice as far) and their width on the screen (the same zoomed in, cadrender's by default, wider as set).
type Look = { lines: number; width: number; gap: number };
await check('cap hatching', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const plate = ui.panel().model.nodes.find((n) => n.kind === 'part' && n.name === 'plate').object.children[0];
    plate.geometry.computeBoundingBox();
    const pb = plate.geometry.boundingBox.clone().applyMatrix4(plate.matrixWorld);
    const c = pb.getCenter(plate.position.clone());
    const s = viewer.sections.get();
    s.x.on = true; s.x.at = c.x; s.caps = true;
    viewer.setSections(s);
    // The drawing style, whose black lines on beige are easy to tell apart (through the controls, as the width below).
    ui.setRender({ capStyle: 'drawing' });
    cadViewer.view('right');
    viewer.draw();
    // Zoomed so the widest spacing (1/60 of the model's radius) is 24 CSS pixels: a few lines along the row, zoomed
    // in twice as far too.
    viewer.camera.zoom *= viewer.pixelSize() / (viewer.sections.hatch.hatchSize.value / 60 / 24);
    viewer.camera.updateProjectionMatrix();
    // Looking at the plate's centre.
    const shift = c.clone().sub(viewer.controls.target);
    viewer.camera.position.add(shift); viewer.controls.target.add(shift);
    const dpr = viewer.renderer.getPixelRatio(), n = 600;
    // The dark runs between beige pixels along the row through the plate's centre: their widths and the gaps between
    // their centres, in device pixels.
    const look = async () => {
      for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
      viewer.draw();
      const p = c.clone().project(viewer.camera), px = new Uint8Array(4 * n);
      gl.readPixels(Math.round((p.x + 1) / 2 * canvas.clientWidth * dpr) - n / 2,
        Math.round((p.y + 1) / 2 * canvas.clientHeight * dpr), n, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const kind = (i) => {
        const [r, g, b] = [px[4 * i], px[4 * i + 1], px[4 * i + 2]];
        return r < 80 && g < 80 && b < 80 ? 'ink' : r > 180 && r - b > 20 ? 'beige' : 'other';
      };
      const widths = [], centres = [];
      // (An antialiased pixel may lie between ink and beige.)
      const beige = (i) => [i, i + 1].some((k) => k >= 0 && k < n && kind(k) === 'beige');
      for (let i = 2; i < n; i++) {
        if (kind(i) !== 'ink' || kind(i - 1) === 'ink' || !beige(i - 2)) continue;
        let j = i;
        while (j < n && kind(j) === 'ink') j++;
        if (beige(j)) { widths.push(j - i); centres.push((i + j - 1) / 2); }
      }
      const gaps = centres.slice(1).map((x, i) => x - centres[i]);
      const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      return { lines: widths.length, width: mean(widths), gap: mean(gaps) };
    };
    const before = await look();
    viewer.camera.zoom *= 2; viewer.camera.updateProjectionMatrix();
    const zoomed = await look();
    ui.setRender({ hatchWidth: 4 });
    const wide = await look();
    return { dpr, before, zoomed, wide };
  })()`, { scale: 2 }) as { after: { dpr: number; before: Look; zoomed: Look; wide: Look } };
  const { dpr, before, zoomed, wide } = r.after;
  const all = JSON.stringify(r.after);
  expect(dpr === 2 && before.lines >= 4 && zoomed.lines >= 2, `hatch lines found: ${all}`);
  // Fixed on the model: twice as far apart zoomed in twice as far; as wide on the screen.
  expect(Math.abs(zoomed.gap / before.gap - 2) < 0.25, `lines' gap doubled zooming in twice: ${all}`);
  expect(Math.abs(zoomed.width - before.width) <= 1, `lines as wide zoomed in: ${all}`);
  // The width as set: 1.33 CSS pixels at half ink (cadrender's), so about 2 to 3 device pixels darker than the
  // check's threshold; 4 pixels three times that.
  expect(before.width >= 1.5 && before.width <= 3.5, `the lines' default width: ${all}`);
  expect(wide.width > 2.4 * before.width, `wider lines with the width set to 4: ${all}`);
  return undefined;
});
// The state's meshing and hidden faces (recordings' snapshots): a face hidden through one placement listed below every
// placement of its part, its nodes made or not; the controls' meshing settings, and those the model was meshed with
// apart; a recording begun mid-session replays in a fresh page meshing as the model was (the same triangles), the
// controls' settings and the hidden faces as they were, with nothing diverging.
await check('snapshot: meshing and hidden faces', async () => {
  const first = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    // Meshed again coarse (not what a fresh page would mesh with), the controls then changed again.
    ui.setMeshing({ profile: 'coarse', linearDeflection: 0.2, angularDeflection: 30, cache: false });
    const before = viewer.model;
    ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.model === before || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cadViewer.idle();
    const m = viewer.nodes;
    const nuts = m.nodes.filter((n) => n.kind === 'part' && n.name === 'nut');
    const source = nuts[0].object.children[0].userData.faces[0];
    // (One face in every placement: faces are hidden per placement since 2026-10-31.)
    const want = nuts.map((n) => m.pathOf(n.id) + '/face#' + source);
    cadViewer.hide(want);
    ui.setTree({ detail: false });
    const hidden = cadViewer.state().hidden;
    ui.setMeshing({ profile: 'custom', linearDeflection: 0.5 });
    const st = cadViewer.state();
    cadViewer.record(true);
    cadViewer.view('top');
    await cadViewer.idle();
    const rec = cadViewer.record(false);
    // A face hidden by a state with no node made for it (the tree without detail), then a state hiding nothing.
    const bolt = m.nodes.find((n) => n.kind === 'part' && n.name === 'bolt');
    cadViewer.apply({ hidden: [m.pathOf(bolt.id) + '/face#' + bolt.object.children[0].userData.faces[0]] });
    const unmade = cadViewer.state().hidden.filter((p) => p.startsWith(m.pathOf(bolt.id) + '/face#')).length;
    cadViewer.apply({ hidden: [] });
    const cleared = cadViewer.state().hidden;
    return { want, hidden, meshing: st.meshing, meshedWith: st.model.meshedWith, triangles: st.model.triangles, rec,
      unmade, cleared };
  })()`) as { after: { want: string[]; hidden: string[]; meshing: { profile: string; linearDeflection: number };
    meshedWith: { profile: string; linearDeflection: number }; triangles: number;
    rec: { events: { type: string; state?: { meshing?: { linearDeflection: number } } }[] }; unmade: number;
    cleared: string[] } };
  const a = first.after;
  const j = JSON.stringify({ ...a, rec: undefined });
  expect(a.want.length > 1 && a.want.every((p) => a.hidden.includes(p)), `the face in every placement: ${j}`);
  expect(a.meshing.profile === 'custom' && a.meshing.linearDeflection === 0.5 && a.meshedWith.profile === 'coarse',
    `the controls' meshing apart from the model's: ${j}`);
  expect(a.unmade === 1 && a.cleared.length === 0, `a hidden face with no node: listed, and shown by a state: ${j}`);
  // The recording with its end's meshing changed: replay says so.
  const tampered = structuredClone(a.rec);
  tampered.events.findLast((e) => e.type === 'state')!.state!.meshing!.linearDeflection = 0.3;
  const second = await page('?check', `(async () => {
    await cadViewer.ready;
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    await cadViewer.idle();
    const st = cadViewer.state();
    // The controls show it.
    const shown = ui.gui.controllersRecursive().find((c) => c._name === 'Deflection (mm)').$input.value;
    const tampered = await cadViewer.replay(${JSON.stringify(tampered)});
    return { report, triangles: st.model?.triangles, meshing: st.meshing, meshedWith: st.model?.meshedWith,
      hidden: st.hidden, tampered: tampered.divergences, shown };
  })()`) as { after: { report: { divergences: string[] }; triangles: number; meshing: { linearDeflection: number };
    meshedWith: { profile: string }; hidden: string[]; tampered: string[]; shown: string } };
  const b = second.after;
  const k = JSON.stringify(b);
  expect(b.report.divergences.length === 0, `replayed with nothing diverging: ${k}`);
  expect(b.triangles === a.triangles && b.meshedWith.profile === 'coarse' && b.meshing.linearDeflection === 0.5 &&
    Number(b.shown) === 0.5,
    `meshed as the model was, the controls as they were: ${k}`);
  expect(a.want.every((p) => b.hidden.includes(p)), `the hidden faces: ${k}`);
  expect(b.tampered.some((d) => /^the end: meshing is/.test(d)), `a different meshing at the end, said: ${k}`);
  return undefined;
});
// The automation interface (src/automation.ts) and links: nodes by path, select, hide and show by path, a pick and a
// screenshot; a view (top, a cut, AO off, a hidden part, a selected face) taken as a link and opened in another page
// gives the same state; with ?deterministic one pixel per CSS pixel at any screen scale, and screenshots that repeat.
type State = { camera: { position: number[]; target: number[]; up: number[]; height: number }; cut: object;
  render: { ao: boolean }; hidden: string[]; selected: string[]; tree: object; model?: { triangles: number } };
// 3MF's tree: with our extras the STEP file's (its shown nodes: the export leaves hidden ones out), names and
// kinds; without, anyone's, the placed parts flat under one root (`build`, below the file's own node).
await check('3mf tree', async () => {
  const tree = async (file: string) => (await page(`?url=${encodeURIComponent(`/content/${file}`)}&check`,
    `(async () => {
      await cadViewer.ready;
      await cadViewer.idle();
      return cadViewer.nodes().filter((n) => !n.hidden).map((n) => n.kind + ' ' + n.path);
    })()`) as { after: string[] }).after.map((n) => n.replace(file, '<file>'));
  const [stp, ours, plain] = [await tree('as1.stp'), await tree('as1.3mf'), await tree('as1-plain.3mf')];
  expect(stp.length > 10 && JSON.stringify(ours) === JSON.stringify(stp), `with extras: ${ours.length} nodes, `
    + `expected the STEP file's ${stp.length}: ${ours.filter((n) => !stp.includes(n)).slice(0, 3)}`);
  const parts = stp.filter((n) => n.startsWith('part ')).length;
  const flat = plain.filter((n) => n.startsWith('part '));
  expect(flat.length === parts && flat.every((n) => n.split('/').length === 3) && plain.filter((n) =>
    n.startsWith('assembly ')).length === 2, `without extras: ${JSON.stringify(plain.slice(0, 4))}`);
  return undefined;
});

await check('automation', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const nodes = cadViewer.nodes();
    const parts = nodes.filter((n) => n.kind === 'part').map((n) => n.path);
    const missing = cadViewer.select([parts[0], 'nowhere/at/all']);
    const selected = cadViewer.state().selected;
    // (Hidden as nodes() says: the override may be on the part's occurrence, standing for it, NodeModel.cover.)
    const hiddenNow = () => cadViewer.nodes().filter((n) => n.hidden).map((n) => n.path);
    cadViewer.hide([parts[1]]);
    const hidden = hiddenNow();
    cadViewer.show([parts[1]]);
    const shown = hiddenNow();
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
  expect(a.version === 3 && a.count === a.unique && a.parts.length >= 4, `nodes: ${j}`);
  expect(a.missing.length === 1 && /nowhere/.test(a.missing[0]!) && a.selected[0] === a.parts[0], `select: ${j}`);
  expect(a.hidden.includes(a.parts[1]!) && !a.shown.includes(a.parts[1]!), `hide and show: ${j}`);
  expect(!!a.pick && a.pick.path.startsWith(a.parts[0]!.split('/')[0]!), `pick: ${j}`);
  expect(a.offCentre.every((x) => x), `pickAt off the centre: ${j}`);
  expect(a.shot.startsWith('data:image/png;base64,') && a.shotLength > 10_000 && a.redrawn, `screenshot: ${j}`);
  expect(a.problems.length === 0 && a.state.selected[0] === a.face && a.state.hidden.includes(a.parts[3]!) &&
    a.state.render.ao === false && JSON.stringify(a.state.cut) === '{"x":{"at":50,"flip":true}}', `apply: ${j}`);
  expect(JSON.stringify(a.controls) === '[true,true,false]', `the controls: ${j}`);
  // The link, opened in a new page: the same state.
  // (The view after #, the page's options in the query.)
  expect(a.link.includes('#') && !/[?&](hide|select|camera)=/.test(a.link.split('#')[0]!) &&
    /[#&]hide=/.test(a.link), `the view after #: ${a.link}`);
  const at = a.link.indexOf('#');
  const linked = await page(a.link.slice(a.link.indexOf('?'), at) + '&check' + a.link.slice(at), `cadViewer.ready.then(() => cadViewer.idle())
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
  expect(a.bad?.model === 'as1-noedges.glb' && /not a URL, nor a path within the content root/.test(a.bad.status),
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
  const report = JSON.parse(fs.readFileSync(json, 'utf8')) as { state: State; link: string; page: string };
  // The controls hidden (the shot is of the view alone), so nothing covers the view and the model's sphere is drawn
  // at its centre: shot's page, opened here, fits in the whole width.
  expect(new URL(report.page).searchParams.get('controls') === '0', `controls shown: ${report.page}`);
  const shotPage = await page(new URL(report.page).search + '&check', `(() => ({ hidden: ui.gui._hidden,
    fit: viewer.fitAspect(), aspect: viewer.renderer.domElement.clientWidth / viewer.renderer.domElement.clientHeight
    }))()`) as { after: { hidden: boolean; fit: number; aspect: number } };
  expect(shotPage.after.hidden && Math.abs(shotPage.after.fit - shotPage.after.aspect) < 1e-9,
    `shot's page fits beside the controls: ${JSON.stringify(shotPage.after)}`);
  // Wider than a phone, where the tree would open with the model unless shot closes it.
  expect(bytes.subarray(1, 4).toString() === 'PNG' && w === 1000 && h === 600, `png ${w}x${h}`);
  expect(report.state.model?.triangles === triangles && /[?&]model=as1\.stp(&|#|$)/.test(report.link),
    JSON.stringify(report.state.model));
  expect(topLeftPixel(bytes).join() === '64,64,64', `dark by default: ${topLeftPixel(bytes)}`);
  const lightPng = path.join(tmp, 'shot-light.png');
  const code2 = await main(['shot', path.join(content, 'as1.stp'), '-o', lightPng, '--size', '400x300', '--theme',
    'light', '--content-root', content, '--port', String(port)], { ...io, out: (s) => out.push(s),
    err: (s) => out.push(s) });
  expect(code2 === 0, `exit ${code2}: ${out.join('')}`);
  expect(topLeftPixel(fs.readFileSync(lightPng)).join() === '255,255,255', `light: ${
    topLeftPixel(fs.readFileSync(lightPng))}`);
  // A background of its own (the README's pictures, on white: here another colour, as the light theme's is white).
  const code3 = await main(['shot', path.join(content, 'as1.stp'), '-o', lightPng, '--size', '400x300', '--background',
    '#123456', '--content-root', content, '--port', String(port)], { ...io, out: (s) => out.push(s),
    err: (s) => out.push(s) });
  expect(code3 === 0 && topLeftPixel(fs.readFileSync(lightPng)).join() === '18,52,86', `its own: ${
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
    expect(topLeftPixel(fs.readFileSync(png)).join() === '255,255,255', `replay, light: ${topLeftPixel(
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
  const asRecorded = (s: string | undefined) => /^replayed all \d+ steps; as recorded/.test(s ?? '');
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
      // The recording's controls (not those the viewer sets itself).
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
// Opening that fails (the user, 2026-10-28): an error modal saying why, besides the status line: a file not found
// (404), one that isn't a model, a server that can't be reached, a typed address that's neither a URL nor a content
// path (Load URL...); none in the plain ?check pages.
await check('open errors', async () => {
  const dialog = `(async () => { await cadViewer.ready; await cadViewer.idle();
    for (let t = 0; t < 50 && !document.querySelector('dialog.cv-dialog'); t++) {
      await new Promise((r) => setTimeout(r, 100)); }
    const d = document.querySelector('dialog.cv-dialog');
    const out = d ? { title: d.querySelector('h2').textContent, text: d.textContent,
      error: d.classList.contains('error') } : null;
    d?.querySelector('button.primary').click();
    return out; })()`;
  type Seen = { title: string; text: string; error: boolean } | null;
  const at = async (url: string, q = 'check=dialogs') => (await page(`?url=${encodeURIComponent(url)}&${q}`, dialog) as
    { after: Seen }).after;
  const missing = await at('/content/nothing.glb');
  const notModel = await at('/content/notes.txt');
  const unreachable = await at('http://127.0.0.1:9/model.glb');
  const quiet = await at('/content/nothing.glb', 'check');
  const typed = (await page('?check=dialogs', `(async () => { await cadViewer.ready;
    ui.gui.controllersRecursive().find((c) => c._name === 'Load URL...').$button.click();
    for (let t = 0; t < 50 && !document.querySelector('dialog.cv-dialog input'); t++) {
      await new Promise((r) => setTimeout(r, 100)); }
    const ask = document.querySelector('dialog.cv-dialog');
    ask.querySelector('input').value = '../outside.glb';
    ask.querySelector('button.primary').click();
    await new Promise((r) => setTimeout(r, 200));
    return ${dialog}; })()`) as { after: Seen }).after;
  const j = JSON.stringify({ missing, notModel, unreachable, quiet, typed });
  expect(!!missing?.error && /Could not open/.test(missing.title) && /not found \(404/.test(missing.text),
    `a file not found: ${j}`);
  expect(!!notModel?.error && /unknown format/.test(notModel.text), `not a model: ${j}`);
  expect(!!unreachable?.error && /could not fetch/.test(unreachable.text), `a server not reached: ${j}`);
  expect(quiet === null, `none in plain ?check pages: ${j}`);
  expect(!!typed?.error && /not a URL, nor a path within the content root/.test(typed.text), `a bad address: ${j}`);
  return undefined;
});
// File's Save... (the user, 2026-10-28): disabled with no model; the save dialog (File System Access, stubbed)
// suggested the file's name (a URL's last segment) and given exactly its bytes; cancelled, nothing said; without the
// API, a download by that name (the link's click stubbed) with the same bytes; a load that fails before showing
// its model leaves the last one's file to save; the next model shown, its file.
await check('save', async () => {
  const r = await page(`?check`, `(async () => {
    await cadViewer.ready;
    const save = ui.gui.controllersRecursive().find((c) => c._name === 'Save...');
    const before = save._disabled;
    await ui.openUrl('/content/as1.stp');
    await cadViewer.idle();
    const want = new Uint8Array(await (await fetch('/content/as1.stp')).arrayBuffer());
    const same = (b) => b.length === want.length && b.every((x, i) => x === want[i]);
    let suggested, written;
    window.showSaveFilePicker = async (o) => { suggested = o.suggestedName; return { createWritable: async () => ({
      write: async (d) => { written = new Uint8Array(d); }, close: async () => {} }) }; };
    await save.getValue().call(save.object);
    const status = document.getElementById('status').textContent;
    window.showSaveFilePicker = async () => { throw new DOMException('cancelled', 'AbortError'); };
    ui.say('before');
    await save.getValue().call(save.object);
    const cancelled = document.getElementById('status').textContent;
    delete window.showSaveFilePicker;
    let download, blob;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { download = this.download;
      blob = fetch(this.href).then((r) => r.arrayBuffer()); };
    await save.getValue().call(save.object);
    HTMLAnchorElement.prototype.click = click;
    const downloaded = new Uint8Array(await blob), first = download;
    // A file not found: the model shown stays, and Save... with it; then another shown: its file saved.
    await ui.openUrl('/content/nothing.glb');
    const kept = !save._disabled;
    await ui.openUrl('/content/as1.glb');
    await cadViewer.idle();
    HTMLAnchorElement.prototype.click = function () { download = this.download; };
    await save.getValue().call(save.object);
    HTMLAnchorElement.prototype.click = click;
    return { kept, next: download, before, suggested, same: same(written), status, cancelled, download: first,
      downloadedSame: same(downloaded) };
  })()`) as { after: { before: boolean; suggested: string; same: boolean; status: string; cancelled: string;
    download: string; downloadedSame: boolean; kept: boolean; next: string } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.before === true, `disabled with no model: ${j}`);
  expect(a.suggested === 'as1.stp' && a.same && /^saved as1\.stp/.test(a.status), `the save dialog: ${j}`);
  expect(a.cancelled === 'before', `cancelled: ${j}`);
  expect(a.download === 'as1.stp' && a.downloadedSame, `a download without the API: ${j}`);
  expect(a.kept && a.next === 'as1.glb', `the model shown's file: ${j}`);
  return undefined;
});
await check('missing file', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/nothing.glb')}&check`);
  expect(typeof r.error === 'string' && /not found \(404/.test(r.error), `report ${JSON.stringify(r)}`);
  return undefined;
});

// What a build holds (printing nothing as it's made): one Draco decoder (draco3dgltf's, for gltf-import in the import
// worker: the GLBs above loaded through it); licenses.md with the npm packages' licenses and OCCT's, not precached by
// its service worker (which precaches OCCT's module).
if (staticServer) {
  await check('build', async () => {
    expect(buildOutput.trim() === '', `the build printed: ${buildOutput.slice(0, 1000)}`);
    const assets = fs.readdirSync(path.join(dist, 'assets'));
    const draco = assets.filter((f) => f.startsWith('draco_'));
    expect(draco.length === 1 && /^draco_decoder_gltf-.*\.wasm$/.test(draco[0]!), `Draco's files: ${draco}`);
    const licenses = fs.readFileSync(path.join(dist, 'licenses.md'), 'utf8');
    expect(['### three - 0.186.1 (MIT)', '### @headless-tree/core', '`@gltf-transform/core`', 'draco3dgltf',
      'meshoptimizer', 'Open CASCADE exception (version 1.0)',
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
