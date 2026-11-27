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
import { chooseLod, exportView, meshDeflections, multiply, partInstances, tessellateScene } from 'cad-scene';
import { threemf, type ThreeMfOptions } from 'export-3mf';
import { glb, gltfJson } from 'export-gltf';
import { threejsJson } from 'export-threejs';
import { importGltf } from 'gltf-import';
import { StepTessellator } from 'step-export';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { CadioTessellator } from 'tess-cadio';
import { KEEP_FAILING } from 'tess-cadio/options';
import { HEAL_BY_DEFAULT } from 'cad-heal/options';
import { healTestScene, stepOf } from '../../cad-heal/test/scene.ts';
import { writeCatalog } from '../../../scripts/demo-catalog.ts';
import { hostLine } from '../../../scripts/host.ts';
import { main } from '../bin/viewer.ts';
import { defaultChrome, launchChrome } from '../server/headless.ts';

console.log(await hostLine());
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
await tessellateScene(scene, new StepTessellator(occt), { edges: true });
// (The scene holds both levels: exports at the medium profile's, the library's default.)
const medium = meshDeflections({});
const placed = [...partInstances(scene)].filter((p) => p.visible);
const coarseTriangles = [...(await tessellateScene(scene, new StepTessellator(occt), { profile: 'coarse' }))
  .meshes].reduce((s, [part, m]) =>
  s + placed.filter((p) => p.part === part).length * m.indices.length / 3, 0);
occt.dispose();
const view = exportView(scene, { ...medium, edges: true });
fs.writeFileSync(path.join(content, 'as1.glb'), (await glb(scene, view)).bytes);
const meshopt = await gltfJson(scene, view, 'as1-meshopt.bin', { compression: 'meshopt' });
fs.writeFileSync(path.join(content, 'as1-meshopt.gltf'), meshopt.json);
fs.writeFileSync(path.join(content, 'as1-meshopt.bin'), meshopt.bin);
fs.writeFileSync(path.join(content, 'as1.json'), threejsJson(scene, view));
fs.writeFileSync(path.join(content, 'as1.json.extras.json'), threejsJson(scene, view, { extras: true }));
// as1 with nut_1 mirrored in x about its own middle (so it stays where it was) and the plate sheared, in a three.js
// file (our exporter writes rigid placements only: the stretches put into the objects' matrices here): read with the
// stretches baked into copies of the parts (rigid placements), picking what's drawn, Details and Model Details saying
// what's stretched.
{
  const nut = scene.components.flatMap((c) => c.parts).find((p) => p.name === 'nut_1')!;
  const nutMesh = scene.parts[nut.part]!.lods[0]!.mesh;
  const cx = nutMesh.origin[0] + (nutMesh.box!.min[0] + nutMesh.box!.max[0]) / 2;
  const plate = scene.components.flatMap((c) => c.parts).find((p) => p.name === 'plate_1')!;
  const move = (o: readonly number[], k: number) => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, k * o[0]!,
    k * o[1]!, k * o[2]!, 1);
  // Each object's matrix is its placement's then its mesh's origin: the stretch goes between them.
  const stretches = new Map([[nut, Float64Array.of(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2 * cx, 0, 0, 1)],
    [plate, Float64Array.of(1, 0, 0, 0, 0.6, 0.8, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)]]);
  const json = JSON.parse(threejsJson(scene, exportView(scene, { ...medium, edges: true }), { extras: true }));
  for (const [ref, m] of stretches) {
    const o = scene.parts[ref.part]!.lods[0]!.mesh.origin;
    const found: { matrix: number[] }[] = [];
    const walk = (x: { name?: string; matrix: number[]; children?: unknown[] }) => {
      if (x.name === ref.name) found.push(x);
      for (const c of x.children ?? []) walk(c as typeof x);
    };
    walk(json.object);
    if (found.length !== 1) throw new Error(`${ref.name}: ${found.length} objects`);
    found[0]!.matrix = Array.from(multiply(Float64Array.from(found[0]!.matrix), multiply(move(o, -1),
      multiply(m, move(o, 1)))));
  }
  fs.writeFileSync(path.join(content, 'as1-transforms.json'), JSON.stringify(json));
}
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
// Parts that healing changes (cad-heal's test scene: a stray pole, an arc off its plane).
fs.writeFileSync(path.join(content, 'heal.stp'), stepOf(healTestScene()));
// A part with a face tess-cadio fails for its mesh (#453's #445, past its deflection), which keepFailing keeps.
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/pr1ct.stp'),
  path.join(content, 'pr1ct.stp'));
// (A face tess-cadio fails past its deflection, alone in its part: arm-ap242 #119's cylinder #1231; and one it fails
// by construction, whatever its mesher's progress: conical-surface's #77 at 1.2e-6 mm, past its point cap.)
fs.copyFileSync(path.join(repo, 'test_corpus/models/arm/arm-ap242.step'), path.join(content, 'arm-ap242.step'));
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/occt-import-js/test/testfiles/conical-surface/'
  + 'conical-surface.step'), path.join(content, 'conical-surface.step'));
// as1 with its nut-bolt assemblies' nut (its occurrence: the tree's name for it, three levels down, so no row of it is
// drawn before the tree is expanded, and the first below the first screen once it is) named long enough to be the
// widest row in any font (the tree check).
const longName = 'nut_3-with-a-name-long-enough-to-be-the-widest-row-in-any-font';
{
  const text = fs.readFileSync(step, 'latin1'), occurrence = "NEXT_ASSEMBLY_USAGE_OCCURRENCE('6','nut_3'";
  if (text.split(occurrence).length !== 2) throw new Error(`as1: not one ${occurrence}`);
  fs.writeFileSync(path.join(content, 'as1-long-name.stp'),
    text.replace(occurrence, `NEXT_ASSEMBLY_USAGE_OCCURRENCE('6','${longName}'`), 'latin1');
}
// as1 with an author of its own beside a placeholder, and a model with no metadata but its format (Model Details).
fs.writeFileSync(path.join(content, 'as1-authored.stp'), fs.readFileSync(step, 'latin1').replace("('Author')",
  "('Ann B','none')"), 'latin1');
fs.writeFileSync(path.join(content, 'bare.json'), JSON.stringify({ object: { type: 'Scene', children: [] } }));
// OCCT's broken-references file: the importer warns of a reference beyond the largest id, and a part fails to mesh
// (an error; the problems dialog's check). And one with warnings alone (as1 with an instance of its own whose
// reference is beyond the largest id), and one whose only error is a face that fails to mesh (OCCT's), the rest of its
// part meshed.
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/bug31292.stp'),
  path.join(content, 'broken.stp'));
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/trj7_b1-ec-214.stp'),
  path.join(content, 'face-failed.stp'));
// A part whose B-spline faces' edges have no p-curves, all within tolerance: healing leaves them bare unless
// pcurveMissingOnFreeForm asks for every one.
fs.copyFileSync(path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/bug24595_281390.stp'),
  path.join(content, 'bare-edges.stp'));
fs.writeFileSync(path.join(content, 'warned.stp'), fs.readFileSync(step, 'latin1').replace(/\nENDSEC;\s*END-ISO/,
  "\n#999999=CARTESIAN_POINT('',(0.,0.,#99999999999));\nENDSEC;\nEND-ISO"), 'latin1');
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
    '.webmanifest': 'application/manifest+json', '.md': 'text/markdown', '.pdf': 'application/pdf' };
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
// (Tab capture accepted without its prompt, for Screenshot...'s check.)
const headless = await launchChrome(path.join(tmp, 'chrome'), { chrome, args: ['--auto-accept-this-tab-capture'] });
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
  /** The system's colour scheme emulated dark, before the page loads. */
  dark?: boolean;
  /** The query as it is: not thin edges unless it says (page's default). */
  asIs?: boolean;
  /** Healing as the viewer has it by default (page's default: heal=0 unless the query says, below). */
  healDefault?: boolean;
  /** The page focused, as a tab in front is (headless Chrome's tabs aren't). */
  focus?: boolean;
}

/**
 * Defined in every page before its own scripts: `settled()`, what a check awaits before it reads pixels or picks, as
 * the load from other work on the machine can delay what the page does next by frames: the viewer idle, the view's
 * resize reached the camera's projection (as many pixels a millimetre across as down: the canvas's box and the
 * projection agree, up to 2 s), then two frames drawn and idle again.
 */
const SETTLED = `globalThis.settled = async () => {
  await globalThis.cadViewer?.idle?.();
  const v = globalThis.viewer;
  if (v) {
    const P = () => v.camera.projectionMatrix.elements, el = v.renderer.domElement;
    for (let t = 0; t < 40 && el.clientHeight && Math.abs(P()[0] * el.clientWidth / (P()[5] * el.clientHeight) - 1)
      > 1e-6; t++) await new Promise((r) => setTimeout(r, 50));
  }
  for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  await globalThis.cadViewer?.idle?.();
};`;

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
  if (opts.light || opts.dark) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme',
    value: opts.light ? 'light' : 'dark' }] }, sessionId);
  if (opts.focus) await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SETTLED }, sessionId);
  if (opts.first) await send('Page.addScriptToEvaluateOnNewDocument', { source: opts.first }, sessionId);
  // Thin edges unless the check asks: fat ones cost several times as much in software rendering (SwiftShader), which
  // the timing checks would feel (the fat edges check asks for them).
  // Models as imported unless the check asks: these checks' counts of warnings and failed faces are of the files as
  // written, and healing's own (on by default) are the healing checks' (heal B-reps). Not a recording's page: its
  // replay opens the model in a page of its own, with healing as by default (heal= is the address's model's alone).
  const thin = opts.asIs || /[?&]edgeStyle=/.test(query) || !query.startsWith('?') ? query
    : `${query}&edgeStyle=thin`;
  const healed = opts.asIs || opts.healDefault || /[?&](heal(On|Off|Fit)?=|record\b)/.test(thin)
    || !thin.startsWith('?') ? thin : `${thin}&heal=0`;
  await send('Page.navigate', { url: `http://localhost:${port}${base}${healed}` }, sessionId);
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
          // (Camera flights at once, as checks read the camera right after zooming: 'camera flights' checks them.
          // `partOf(node)`: a placed part's node's part name, as nodes are named as their placements.)
          const e = await Promise.race([send('Runtime.evaluate', { expression: `(globalThis.viewer.flightMs = 0, `
            + 'globalThis.partOf = (n) => viewer.graph.scene.parts[n.object.userData.part].name, '
            + `${after})`, returnByValue: true,
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
// The tree's spinners: while the bicycle loads (without the cache), and while it's meshed again, a part's row has
// one (its `loading` class, its tooltip saying still meshing) exactly while its part is still to be meshed (judged
// apart from the viewer's own record: its mesh not yet in the scene graph, or for Mesh again not yet replaced), and
// an assembly's while it holds such a part (compared once the rows have caught up: two frames with no part done);
// none once it's done.
await check('tree spinners', async () => {
  const r = await page('?check', `(async () => {
    const v = globalThis.viewer;
    v.settings.cache = false;
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const watch = async (run, again) => {
      const out = { compared: 0, busy: 0, wrong: [], titled: 0 };
      let done = false;
      // (Each part's mesh as Mesh again starts: replaced once it's meshed again.)
      const before = again ? new Map([...v.graph.meshed].map(([i, m]) => [i, m.mesh])) : undefined;
      const waiting = (i) => before ? v.graph?.meshed.get(i)?.mesh === before.get(i) : !v.graph?.meshed.has(i);
      const p = run().then(() => { done = true; });
      while (!done) {
        const at = v.pendingVersion;
        await frame();
        await frame();
        const panel = ui.panel();
        if (done || !panel || v.pendingVersion !== at) continue;
        panel.expandAll?.();
        const m = panel.model;
        out.compared++;
        if ([...m.nodes].some((x) => x.kind === 'part' && x.object?.userData.cad === 'part'
          && waiting(x.object.userData.part))) out.busy++;
        for (const row of document.querySelectorAll('.tree-row')) {
          if (row.style.display === 'none' || row.dataset.id === undefined) continue;
          const n = m.nodes[+row.dataset.id];
          let want = false;
          const isPart = (x) => x.kind === 'part' && x.object?.userData.cad === 'part';
          const holds = (k) => { const x = m.nodes[k]; return isPart(x) ? waiting(x.object.userData.part)
            : (x.children ?? []).some(holds); };
          if (n.kind === 'part' || n.kind === 'assembly') want = holds(n.id);
          const has = row.classList.contains('loading');
          if (has !== want) out.wrong.push([n.kind, n.name, has, want]);
          if (has && row.title.endsWith('(still meshing)')) out.titled++;
        }
      }
      await p;
      await cadViewer.idle();
      await frame();
      out.after = document.querySelectorAll('.tree-row.loading').length;
      return out;
    };
    const load = await watch(() => ui.openUrl('/content/bicycle.stp'));
    const again = ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again');
    const remesh = await watch(() => again.getValue().call(again.object), true);
    return { load, remesh };
  })()`) as { after: Record<string, { compared: number; busy: number; wrong: unknown[]; titled: number;
    after: number }> };
  const j = JSON.stringify(r.after);
  for (const k of ['load', 'remesh']) {
    const a = r.after[k]!;
    expect(a.busy >= 3 && a.wrong.length === 0 && a.titled > 0, `${k}: spinners on the parts still to mesh and `
      + `what holds them, only: ${j}`);
    expect(a.after === 0, `${k}: none once done: ${j}`);
  }
  return undefined;
});
// Replacing a model while it's meshing: the bicycle's meshing is cancelled once it has begun (its load ends at
// once: the workers are stopped), the GLB shown alone, and STEP meshes again after (a new pool), from the cache (the
// assembly was meshed above); and with truck, then SMLib, when that's the backend chosen.
// Zooming while a model loads (docs/viewer.md): the bicycle, meshed without the cache, is fitted to its
// estimated sphere before its first mesh is drawn, then only zooms out, at most once a second, ending fitted to all
// that loaded; zoom all then fits the sphere made from the meshes. Moving the view stops it.
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
// Camera flights: zoom all, zoom selected and the views ease there over a second (smoothstep), from where the camera
// is; a view turns about the orbit centre, its zoom and pan kept; idle() waits for the flight; the user's own input
// stops it where it is.
// A new model starts from the default pose: iso, centred on its sphere, however the last was turned and panned; meshing
// the same model again keeps the view.
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
// Panning: a right-button drag moves the model with the pointer one to one, after zoom selected too (TrackballControls'
// own pan crawled there), and leaves the orbit centre where it is on the model; a turn afterwards pivots about it,
// where it's drawn.
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
    ui.select([ui.panel().model.nodes.find((n) => n.kind === 'part' && partOf(n) === 'nut').id]);
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
// Zooming at the cursor: a wheel zoom over a part moves the orbit centre onto the line of sight there, at the nearest
// of what's drawn along it, and zooms keeping that line under the cursor (the point picked there stays put); over empty
// space, the orbit centre stays where it is, the zoom still about the cursor. A touchpad's pinch (ctrl, a few pixels an
// event) zooms e^(pixels / 100); a click that picks makes the point picked the orbit centre, the view unchanged.
// Safari's pinch on a Mac's touchpad (WebKit's gesture events, here synthetic: headless Chrome has none): zoomed by the
// scale's change, 1:1, about the point under the fingers; a ctrl-wheel event during the gesture let go; page zoom
// prevented.
await check('safari pinch', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await settled();
    const v = globalThis.viewer, canvas = v.renderer.domElement, c = canvas.getBoundingClientRect(), cam = v.camera;
    const rod = ui.panel().model.nodes.find((n) => n.kind === 'part' && partOf(n) === 'rod').object.children[0];
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
  const where = (x: number, y: number) => `(async () => { await settled();
    const v = globalThis.viewer, c = v.renderer.domElement.getBoundingClientRect(), cam = v.camera;
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
    await settled();
    const v = globalThis.viewer, c = v.renderer.domElement.getBoundingClientRect(), cam = v.camera;
    const rod = ui.panel().model.nodes.find((n) => n.kind === 'part' && partOf(n) === 'rod').object.children[0];
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
// Picks on section caps: a click where a cap is drawn picks the part cut, at the point on the plane, through
// cadViewer.pickAt and the view's own picking; the zoom at the cursor's orbit centre counts it too.
await check('picks on caps', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const v = globalThis.viewer, cam = v.camera;
    // (Settled first: the clicks below are placed by the canvas's box and the camera's projection, which must agree.)
    await settled();
    const rod = ui.panel().model.nodes.find((n) => n.kind === 'part' && partOf(n) === 'rod').object.children[0];
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
    // The zoom's orbit centre found a little above the rod's centre, on the cap (drawn again; the canvas's box now).
    await settled();
    const c = v.renderer.domElement.getBoundingClientRect();
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
// Edges found off the page's thread: a GLB of meshes without edges (the user's VW, from Onshape) loads with every
// part's edges found in the model worker, the page's longest task no longer than the scene graph's own building
// (finding them on the page made it more than twice as long).
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
      // (Found edges: the line object beside the B-rep edges, which a GLB without edges has none of.)
      const e = o.children.find((c) => c.name === 'detectedEdges');
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
// A STEP file's import says its phases in the status line as the model worker reaches them ("importing" alone for the
// seconds a large file takes): reading, its structure, the parts by percent, assembling.
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
// Hide others, Show others and transparency, through the controls: one of as1's nuts selected, Hide others leaves it
// alone shown; Show others shows the rest, the nut keeping its own hiding; the rod made transparent at the Opacity
// control's value and back to the file's.
await check('hide others and transparency', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const m = ui.panel().model, button = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    const parts = () => m.nodes.filter((n) => n.kind === 'part');
    const shown = () => parts().filter((n) => !m.hiddenInTree(n.id)).map((n) => n.id);
    const nut = parts().find((n) => partOf(n) === 'nut');
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
    const rod = parts().find((n) => partOf(n) === 'rod');
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
    // Overrides inherited: the nut's assembly hidden, the nut shown within it; the assembly at 0.5, one of its children
    // back to the file's within it. In the state and the link. (An assembly of several children: of one, the child
    // would stand for it, NodeModel.cover.)
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
// The tree's context menu and Override Appearance...: right-click an assembly's row, the menu's one item, the panel's
// controls (Inherit at first, the alpha shown and not editable; Transparent starting from it), each change taking
// effect at once (no OK or Cancel), the eye on the row; asked for a child while it's open, the same panel showing the
// child (what it inherits), not a second; changed elsewhere (Hide selected), shown again; following a selection of one
// node, not of several or none, a right-click winning over the selection; triangle edges on through it; not modal, so
// the page stays usable; closed by its x and by Escape; a long press on a touch screen opening the menu too; recorded
// and replayed in a fresh page with the same overrides.
// The tree's context menu ends with Selection's actions: what's before them (else the whole menu, so it doesn't match).
const SELECT_ITEMS = ['Select parent', 'Select children', 'Select none', 'Select all', 'Invert selection',
  'Select by ID...', 'Hide selected', 'Show selected'];
// (A node's problems item, last where it has any, healing's warnings among them, left out too.)
const ownItems = (all: string[]) => {
  const items = /^\d+ Errors?, \d+ Warnings?\.\.\.$/.test(all.at(-1) ?? '') ? all.slice(0, -1) : all;
  return JSON.stringify(items.slice(-SELECT_ITEMS.length)) === JSON.stringify(SELECT_ITEMS)
    ? items.slice(0, -SELECT_ITEMS.length) : items;
};
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
      [...document.querySelectorAll('.cv-menu button')].find((x) => x.textContent === 'Override Appearance...')
        .click();
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
    // (On a desktop, Visibility takes the focus, for the keyboard.)
    const focused = document.activeElement === c.visibility;
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
    // The panel follows a selection of one node; several, or none, leave it; a right-click on a row not selected shows
    // that row's node.
    const other = m.nodes.find((n) => n.kind === 'part' && n.name !== m.nodes[child].name).id;
    const titled = () => {
      const t = c.d.querySelector('h2 span').textContent;
      return t === 'Override Appearance: ' + m.nodes[other].name ? 'other'
        : t === 'Override Appearance: ' + m.nodes[child].name ? 'child' : t;
    };
    const follows = [];
    document.activeElement?.blur();
    ui.select([other]);
    await frame();
    // (The focus left where it was: the tree's arrow keys keep moving through the tree.)
    follows.push(titled(), c.d.contains(document.activeElement) ? 'focus moved' : 'focus kept');
    ui.select([child, other]);
    await frame();
    follows.push(titled());
    ui.select([]);
    await frame();
    follows.push(titled());
    ui.select([other]);
    await frame();
    const childRow = [...document.querySelectorAll('#tree .tree-row')].find((r) => +r.dataset.id === child);
    const cb = childRow.getBoundingClientRect();
    childRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cb.left + 20,
      clientY: cb.top + 5 }));
    [...document.querySelectorAll('.cv-menu button')].find((x) => x.textContent === 'Override Appearance...')
      .click();
    await frame();
    follows.push(titled(), ui.selected().join() === String(other) ? 'other selected' : 'selection changed');
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
    return { items, closed, first, modal, focused, follows, switched, live, own, eye, childHidden, panels, inChild,
      childSwitched, childDefault, childOwn, childLook, wires, childMeshes, refreshed, reshown, xClosed, escClosed,
      pressed,
      overrides: { hidden: st.hidden, shown: st.shown, opacity: st.opacity, triangleEdges: st.triangleEdges },
      rec: cadViewer.record(false) };
  })()`) as { after: Record<string, unknown> & { overrides: unknown; rec: { events: { type: string }[] } } };
  const a = r.after;
  const j = JSON.stringify({ ...a, rec: undefined });
  type Read = { title: string; visibility: string; opacity: string; edges: string; options: string[];
    disabled: boolean; value: string; buttons: string[] };
  expect(JSON.stringify(ownItems(a.items as string[])) === '["Hide","Show","Reveal","Hide others",' +
      '"Show others","Show all","Override Appearance..."]' && !!a.closed,
    `the menu: ${j}`);
  const first = a.first as Read;
  expect(first.visibility === 'inherit' && first.opacity === 'inherit' && first.edges === 'inherit' &&
    first.disabled && first.value === '1' && first.options.includes('Inherit') &&
    first.options.every((o) => !o.includes('(')) && JSON.stringify(first.buttons) === '["Close"]' &&
    a.modal === false && a.focused === true, `the panel at first: ${j}`);
  const sw = a.switched as Read;
  expect(!sw.disabled && sw.value === '1', `transparent, from the alpha shown: ${j}`);
  expect(a.live === 0.4, `not at once: ${j}`);
  expect(JSON.stringify(a.own) === '{"hidden":true,"transparent":true,"alpha":0.4}' && !!a.eye && !!a.childHidden,
    `the assembly's override: ${j}`);
  const ic = a.inChild as Read;
  expect(a.panels === 1 && ic.title.endsWith(String((a.inChild as Read).title.split(': ')[1])) &&
    ic.title !== first.title && ic.visibility === 'inherit' && ic.options.includes('Inherit') && ic.disabled &&
    ic.value === '0.4', `the child in the panel: ${j}`);
  expect((a.childSwitched as Read).value === '0.4', `the child transparent from 0.4: ${j}`);
  const cd = a.childDefault as Read;
  expect(cd.disabled && cd.value === '1', `the child's default, the file's: ${j}`);
  expect(JSON.stringify(a.childOwn) === '{"hidden":false,"transparent":false,"triangleEdges":true}' &&
    JSON.stringify(a.childLook) === '{"hidden":false,"triangleEdges":true}', `the child's override: ${j}`);
  expect(a.refreshed === 'inherit' && a.reshown === 'show', `refreshed: ${j}`);
  expect(JSON.stringify(a.follows) === '["other","focus kept","other","other","child","other selected"]', `the panel following `
    + `the selection: ${JSON.stringify(a.follows)}`);
  expect((a.childMeshes as number) > 0 && a.wires === a.childMeshes, `the child's triangle edges: ${j}`);
  expect(!!a.xClosed && !!a.escClosed, `closed: ${j}`);
  // (The child has an override of its own by then.)
  expect(JSON.stringify(ownItems(a.pressed as string[])) ===
    '["Hide","Show","Reveal","Hide others",' +
        '"Show others","Show all","Override Appearance...","Remove Appearance Override"]',
    `a long press: ${j}`);
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
// The tree's context menu's Hide, Show and Remove Appearance Override: each at once, on the node's own override (the
// rest of it kept), the open panel following; Remove only for a node with an override; on the whole selection when
// the node right-clicked is in it with others (Override Appearance... still on that node alone); the focus moved to the
// row right-clicked; recorded and replayed.
// The tree's context menu's Hide others, Show others and Show all (after Show) do what Selection's buttons do (Hide
// and Show others on the node right-clicked, or the selection it's in), and Hide selected and Show selected (last of
// the selection's actions) on the selection, whatever was right-clicked; recorded, replayed with the same overrides.
await check('tree menu others and selected', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const m = ui.panel().model;
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    ui.panel().setExpanded(m.nodes.filter((n) => n.kind === 'assembly').map((n) => n.id));
    await frame();
    const [p1, p2, p3] = m.nodes.filter((n) => n.kind === 'part').map((n) => n.id);
    const menu = async (id, choose) => {
      ui.panel().scrollToRow(id, 0);
      await frame();
      const row = [...document.querySelectorAll('#tree .tree-row')].find((x) => +x.dataset.id === id);
      const b = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20,
        clientY: b.top + 5 }));
      const items = [...document.querySelectorAll('.cv-menu button')].map((x) => x.textContent);
      [...document.querySelectorAll('.cv-menu button')].find((x) => x.textContent === choose).click();
      await frame();
      const st = cadViewer.state();
      return { items, hidden: [...st.hidden].sort(), shown: [...st.shown].sort() };
    };
    const control = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    // What Selection's buttons do from no overrides, with those ids selected.
    const button = (ids, name) => {
      control('Show all').$button.click();
      ui.select(ids);
      control(name).$button.click();
      const st = cadViewer.state();
      return { hidden: [...st.hidden].sort(), shown: [...st.shown].sort() };
    };
    cadViewer.record(true);
    // (Through the interface, which replay makes again.)
    cadViewer.select([p1, p2].map((p) => m.pathOf(p)));
    const out = {};
    out.othersSel = await menu(p1, 'Hide others');
    out.showOthers = await menu(p2, 'Show others');
    out.all = await menu(p1, 'Show all');
    // Outside the selection: the node right-clicked alone.
    out.othersOne = await menu(p3, 'Hide others');
    await menu(p3, 'Show all');
    // Hide selected and Show selected: the selection's, not p3's.
    out.hideSel = await menu(p3, 'Hide selected');
    out.showSel = await menu(p3, 'Show selected');
    // Hide others then Show others, with no Show all after it (so the overrides Show others removes must be recorded),
    // then Hide others on a sibling (which hides p3, not itself: a replay without either recording differs).
    const sib = m.children(m.nodes[p3].parent).find((c) => c !== p3 && m.nodes[c].kind === 'part');
    await menu(p3, 'Hide others');
    await menu(p3, 'Show others');
    await menu(sib, 'Hide others');
    out.sib = sib !== undefined;
    out.final = cadViewer.state();
    out.rec = cadViewer.record(false);
    // The buttons' (after the recording).
    out.want = { othersSel: button([p1, p2], 'Hide others'), othersOne: button([p3], 'Hide others'),
      hideSel: button([p1, p2], 'Hide selected') };
    button([p1, p2], 'Hide others');
    control('Show others').$button.click();
    out.want.showOthers = { hidden: [...cadViewer.state().hidden].sort(), shown: [...cadViewer.state().shown].sort() };
    out.paths = [p1, p2, p3].map((p) => m.pathOf(p));
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify({ ...a, rec: undefined });
  const same = (x: { hidden: string[]; shown: string[] }, y: { hidden: string[]; shown: string[] }) =>
    JSON.stringify([x.hidden, x.shown]) === JSON.stringify([y.hidden, y.shown]);
  const items = a.othersSel.items as string[];
  expect(JSON.stringify(items.slice(0, 6)) === '["Hide 2","Show 2","Reveal 2","Hide others",' +
      '"Show others","Show all"]' &&
    JSON.stringify(items.slice(-2)) === '["Hide selected","Show selected"]' && items.at(-3) === 'Select by ID...',
  `the items: ${j}`);
  expect(same(a.othersSel, a.want.othersSel) && a.othersSel.hidden.length > 0 &&
    !a.othersSel.hidden.some((p: string) => a.paths.slice(0, 2).includes(p)), `Hide others on the selection: ${j}`);
  expect(same(a.showOthers, a.want.showOthers), `Show others: ${j}`);
  expect(a.all.hidden.length === 0 && a.all.shown.length === 0, `Show all: ${j}`);
  expect(same(a.othersOne, a.want.othersOne) && a.othersOne.hidden.includes(a.paths[0]) &&
    !a.othersOne.hidden.includes(a.paths[2]), `Hide others outside the selection: that node's: ${j}`);
  expect(same(a.hideSel, a.want.hideSel) && a.hideSel.hidden.includes(a.paths[0]) &&
    !a.hideSel.hidden.includes(a.paths[2]), `Hide selected: the selection's: ${j}`);
  // (Nothing above them hidden: their hiding cleared, no shown override needed.)
  expect(!a.showSel.hidden.some((p: string) => a.paths.slice(0, 2).some((q: string) => q.startsWith(p))),
  `Show selected: the selection's: ${j}`);
  const replayed = await page('?check', `(async () => {
    await cadViewer.ready;
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    const st = cadViewer.state();
    return { divergences: report.divergences, hidden: [...st.hidden].sort(), shown: [...st.shown].sort() };
  })()`) as { after: { divergences: string[]; hidden: string[]; shown: string[] } };
  const b = replayed.after;
  expect(a.sib && b.divergences.length === 0 && JSON.stringify([b.hidden, b.shown]) === JSON.stringify([
    [...a.final.hidden].sort(), [...a.final.shown].sort()]), `replayed: ${JSON.stringify(b)}`);
  return undefined;
});
// Reveal (model.ts): the tree's and the view's menus' Reveal (after Show), greyed where it would change nothing (Hide
// on what's hidden, itself or inherited; Show on what's shown; Reveal on what's revealed); Hide taking a reveal away
// first; Hide others, Show others and Show all taking every reveal away. Drawn: what's revealed as it is, the rest
// (ghosts) blending only their nearest layer at Reveal alpha: at 0.5, each pixel the even mix (in linear colour) of the
// revealed drawn alone (the rest hidden) and the nearest ghost drawn opaque (Reveal alpha 1), with ambient occlusion
// and without; no caps for a ghost. Override Appearance's Reveal pulldown; Reveal alpha in Rendering; in a link;
// recorded and replayed.
await check('reveal', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const m = ui.panel().model;
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const control = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    ui.panel().setExpanded(m.nodes.filter((n) => n.kind === 'assembly').map((n) => n.id));
    await frame();
    const rod = m.nodes.find((n) => n.name.startsWith('rod')).id;
    const parts = m.nodes.filter((n) => n.kind === 'part').map((n) => n.id);
    const others = parts.filter((p) => p !== rod && m.nodes[p].parent !== rod);
    // A node's menu (the tree's): its items, greyed or not; one chosen.
    const menu = async (id, choose) => {
      ui.panel().onContextMenu(id, 100, 100);
      const items = [...document.querySelectorAll('.cv-menu button')].map((b) => (b.disabled ? '-' : '') +
        b.textContent);
      if (choose) [...document.querySelectorAll('.cv-menu button')].find((b) => b.textContent === choose).click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await frame();
      await cadViewer.idle();
      return items.slice(0, 4);
    };
    const out = { alpha: control('Reveal alpha')?.getValue() };
    cadViewer.record(true);
    out.plain = await menu(rod);
    out.revealIt = await menu(rod, 'Reveal');
    out.revealed = { revealing: m.revealing, own: m.ownOverride(rod) ?? null };
    out.again = await menu(rod);
    // Inherited: a part of the rod's assembly (if it is one) revealed through it; a part hidden through its parent.
    const child = m.children(rod).find((c) => m.nodes[c].kind === 'part');
    out.child = child === undefined ? null : await menu(child);
    // Drawn: pixels at Reveal alpha 0.5, the revealed alone, and the ghosts opaque.
    const canvas = viewer.renderer.domElement, gl = viewer.renderer.getContext();
    const grab = () => {
      viewer.draw();
      const px = new Uint8Array(4 * canvas.width * canvas.height);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const srgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
    out.mix = [];
    // (Where the revealed is nearest, without AO: the frame drawn as usual, nothing revealed, the same as it alone.)
    let front;
    for (const ao of [false, true]) {
      ui.setRender({ ao, smaa: false, revealAlpha: 0.5 });
      ui.setOverride(rod, {});
      await cadViewer.idle();
      const N = grab();
      ui.setOverride(rod, { reveal: true });
      await cadViewer.idle();
      const M = grab();
      ui.setRender({ revealAlpha: 1 });
      const G = grab();
      for (const p of others) ui.setOverride(p, { ...m.ownOverride(p), hidden: true });
      await cadViewer.idle();
      const R = grab();
      for (const p of others) { const { hidden, ...o } = m.ownOverride(p) ?? {}; ui.setOverride(p, o); }
      ui.setRender({ revealAlpha: 0.5 });
      await cadViewer.idle();
      const same = (P, Q, i) => [0, 1, 2].every((c) => Math.abs(P[i + c] - Q[Q.length === 4 ? c : i + c]) <= 1);
      if (!ao) {
        front = new Uint8Array(M.length / 4);
        for (let i = 0; i < M.length; i += 4) front[i / 4] = same(N, R, i) ? 1 : 0;
      }
      let ghosted = 0, wrong = 0, worst = 0, unlike = 0, covered = 0, fronts = 0, shift = 0;
      for (let i = 0; i < M.length; i += 4) {
        // The revealed where it's nearest: the ghosts change nothing there.
        // (The revealed's own pixels: not the background's, the first pixel's.)
        const rodPixel = front[i / 4] && !same(R, R.subarray(0, 4), i);
        if (rodPixel) fronts++;
        // (Its colour as the frame drawn as usual has it, but for AO from what's hidden: the same on average.)
        if (rodPixel) shift += [0, 1, 2].reduce((t, c) => t + Math.abs(R[i + c] - N[i + c]), 0) / 3;
        if (rodPixel && !same(G, R, i)) covered++;
        if ([0, 1, 2].every((c) => G[i + c] === R[i + c])) continue;
        ghosted++;
        const d = Math.max(...[0, 1, 2].map((c) => Math.abs(M[i + c] - srgb((lin(R[i + c]) + lin(G[i + c])) / 2))));
        worst = Math.max(worst, d);
        if (d > 3) wrong++;
        // Without AO, opaque ghosts are what's drawn as usual where a ghost is nearest (lit alike; their edges not).
        if (!ao && !same(G, N, i)) unlike++;
      }
      out.mix.push({ ao, ghosted, wrong, worst: Math.round(worst), unlike, covered, fronts,
        shift: Math.round(shift / fronts * 100) / 100 });
    }
    ui.setRender({ ao: true, smaa: true, revealAlpha: 0.1 });
    // Caps: none for a ghost.
    const capped = () => { viewer.sections.invalidate(); viewer.draw(); return viewer.sections.caps.length; };
    ui.setSections({ ...viewer.sections.get(), z: { on: true, at: 20, flip: false } });
    out.caps = { revealed: capped() };
    ui.setOverride(rod, {});
    out.caps.plain = capped();
    ui.setOverride(rod, { reveal: true });
    ui.setSections({ ...viewer.sections.get(), z: { on: false, at: 20, flip: false } });
    // The link carries it; a page opened with it reveals the same.
    out.link = cadViewer.link();
    // Override Appearance...: its Reveal pulldown.
    await menu(others[0], 'Override Appearance...');
    const panel = document.querySelector('dialog.cv-dialog.floating');
    const select = [...panel.querySelectorAll('label')].find((l) => l.textContent.startsWith('Reveal'))
      ?.querySelector('select');
    out.pulldown = select ? [...select.options].map((o) => o.textContent) : null;
    select.value = 'none';
    select.dispatchEvent(new Event('change'));
    out.none = m.ownOverride(others[0]) ?? null;
    select.value = 'reveal';
    select.dispatchEvent(new Event('change'));
    out.revealPulldown = m.ownOverride(others[0]) ?? null;
    panel.querySelector('button.close').click();
    // Hide takes the reveal away; Show greyed then not; Hide greyed once hidden.
    out.hideMenu = await menu(others[0], 'Hide');
    out.hidden = m.ownOverride(others[0]) ?? null;
    out.hiddenMenu = await menu(others[0]);
    // Show all, Hide others, Show others: every reveal gone.
    const clears = {};
    for (const item of ['Show all', 'Hide others', 'Show others']) {
      ui.setOverride(rod, { reveal: true });
      await menu(others[1], item);
      clears[item] = m.revealing;
    }
    out.clears = clears;
    ui.setOverride(rod, { reveal: true });
    control('Reveal alpha').setValue(0.3);
    control('Reveal alpha')._callOnFinishChange();
    out.final = cadViewer.state();
    out.rec = cadViewer.record(false);
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify({ ...a, rec: undefined, final: undefined });
  expect(a.alpha === 0.1, `Reveal alpha, 0.1 at first: ${j}`);
  expect(JSON.stringify(a.plain) === '["Hide","-Show","Reveal","Hide others"]' &&
    JSON.stringify(a.again) === '["Hide","-Show","-Reveal","Hide others"]' && a.revealed.revealing &&
    a.revealed.own?.reveal === true, `the menu's Reveal, greyed once revealed: ${j}`);
  expect(a.child === null || JSON.stringify(a.child) === '["Hide","-Show","-Reveal","Hide others"]',
    `revealed through its parent: ${j}`);
  for (const x of a.mix) {
    expect(x.ghosted > 1000 && x.wrong === 0, `one ghost layer blended (ao ${x.ao}): ${JSON.stringify(x)}`);
    expect(x.ao || x.unlike < x.ghosted * 0.1, `ghosts at alpha 1 drawn as usual: ${JSON.stringify(x)}`);
    // (With AO, what's hidden darkens it a little when drawn as usual: about 4 in 255 on average; twice over the gamma
    // correction, about 30.)
    expect(x.shift < 10, `the revealed's colours as usual (ao ${x.ao}): ${JSON.stringify(x)}`);
    // (A few pixels where the rod meets a bracket's hole, at nearly one depth, either way.)
    expect(x.fronts > 200 && x.covered <= x.fronts * 0.01, `nothing over the revealed where it's nearest (ao ${
      x.ao}): ${JSON.stringify(x)}`);
  }
  expect(a.caps.revealed > 0 && a.caps.revealed < a.caps.plain, `no caps for ghosts: ${j}`);
  expect(/[?&#]reveal=/.test(a.link), `in the link: ${a.link}`);
  expect(JSON.stringify(a.pulldown) === '["Inherit","Reveal","None"]' && a.none?.reveal === false &&
    a.revealPulldown?.reveal === true, `Override Appearance's Reveal: ${j}`);
  expect(JSON.stringify(a.hideMenu) === '["Hide","-Show","-Reveal","Hide others"]' && a.hidden?.hidden === true &&
    a.hidden.reveal === undefined && JSON.stringify(a.hiddenMenu) === '["-Hide","Show","Reveal","Hide others"]',
  `Hide takes the reveal away; then greyed, Show not: ${j}`);
  expect(Object.values(a.clears).every((x) => x === false), `every reveal gone: ${j}`);
  const replayed = await page('?check', `(async () => {
    await cadViewer.ready;
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    const st = cadViewer.state();
    return { divergences: report.divergences, revealed: st.revealed, alpha: st.render.revealAlpha,
      revealing: viewer.nodes.revealing };
  })()`) as { after: { divergences: string[]; revealed: string[]; alpha: number; revealing: boolean } };
  const b = replayed.after;
  expect(b.divergences.length === 0 && JSON.stringify(b.revealed) === JSON.stringify(a.final.revealed) &&
    b.alpha === 0.3 && b.revealing, `replayed: ${JSON.stringify(b)}`);
  const u = new URL(a.link);
  const linked = await page(`${u.search}&check${u.hash}`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    return { revealing: viewer.nodes?.revealing, revealed: cadViewer.state().revealed };
  })()`) as { after: { revealing: boolean; revealed: string[] } };
  expect(linked.after.revealing && linked.after.revealed.length > 0, `a link's: ${JSON.stringify(linked.after)}`);
  return undefined;
});
await check('tree menu hide and show', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&record`, `(async () => {
    const m = ui.panel().model;
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const part = m.nodes.find((n) => n.kind === 'part').id;
    const menu = async (id, choose) => {
      const row = [...document.querySelectorAll('#tree .tree-row')].find((x) => +x.dataset.id === id);
      const b = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20,
        clientY: b.top + 5 }));
      const items = [...document.querySelectorAll('.cv-menu button')].map((x) => x.textContent);
      if (choose) [...document.querySelectorAll('.cv-menu button')].find((x) => x.textContent === choose).click();
      await frame();
      return { items, open: !!document.querySelector('.cv-menu'), own: m.ownOverride(part) ?? null,
        hidden: m.hiddenInTree(part), drawn: viewer.nodes.nodes[part].object.visible };
    };
    ui.panel().setExpanded(m.nodes.filter((n) => n.kind === 'assembly').map((n) => n.id));
    await frame();
    const plain = await menu(part, 'Hide');
    const shown = await menu(part, 'Show');
    // Over an override of more than visibility, kept; the open panel showing the change.
    ui.setOverride(part, { transparent: true, alpha: 0.5, triangleEdges: true });
    await menu(part, 'Override Appearance...');
    const visibility = () => document.querySelector('dialog.cv-dialog.floating select').value;
    const hidden = { ...await menu(part, 'Hide'), panel: visibility() };
    const removed = { ...await menu(part, 'Remove Appearance Override'), panel: visibility() };
    const after = await menu(part);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Several selected, one of them right-clicked: Hide, Show and Remove on each (Remove offered as one has an
    // override); Override Appearance... on the one clicked. Right-clicked outside the selection: that one alone.
    const [p1, p2, p3] = m.nodes.filter((n) => n.kind === 'part').map((n) => n.id);
    ui.setOverride(p2, { transparent: true, alpha: 0.5 });
    ui.select([p1, p2]);
    await frame();
    const owns = () => [p1, p2, p3].map((p) => m.ownOverride(p) ?? null);
    const several = async (id, choose) => ({ ...await menu(id, choose), owns: owns(), selected: ui.selected(),
      focused: +document.querySelector('#tree .tree-row.focused')?.dataset.id });
    const multi = { hide: await several(p1, 'Hide 2'), show: await several(p2, 'Show 2'),
      panel: (await menu(p1, 'Override Appearance...'), document.querySelector('dialog.cv-dialog.floating h2 span')
        ?.textContent), name: m.nodes[p1].name, remove: await several(p1, 'Remove Appearance Override 2'),
      outside: await several(p3, 'Hide'), p: [p1, p2, p3] };
    // (The menu only opened, then closed: the focus still moved, though nothing else is drawn again.)
    multi.opened = await several(p1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector('dialog.cv-dialog.floating button.close')?.click();
    ui.select([]);
    const st = cadViewer.state();
    return { plain, shown, hidden, removed, after, multi,
      overrides: { hidden: st.hidden, shown: st.shown, opacity: st.opacity, triangleEdges: st.triangleEdges },
      rec: cadViewer.record(false) };
  })()`) as { after: Record<string, { items: string[]; open: boolean; own: unknown; hidden: boolean;
    drawn: boolean; panel?: string }> & { overrides: unknown; rec: { events: { type: string }[] }; multi: unknown } };
  const a = r.after;
  const j = JSON.stringify({ ...a, rec: undefined });
  expect(JSON.stringify(ownItems(a.plain!.items)) === '["Hide","Show","Reveal","Hide others",' +
      '"Show others","Show all","Override Appearance..."]' && !a.plain!.open &&
    JSON.stringify(a.plain!.own) === '{"hidden":true}' && a.plain!.hidden && !a.plain!.drawn, `Hide: ${j}`);
  expect(JSON.stringify(ownItems(a.shown!.items)) ===
    '["Hide","Show","Reveal","Hide others",' +
        '"Show others","Show all","Override Appearance...","Remove Appearance Override"]' &&
    JSON.stringify(a.shown!.own) === '{"hidden":false}' && !a.shown!.hidden && a.shown!.drawn, `Show: ${j}`);
  expect(JSON.stringify(a.hidden!.own) === '{"transparent":true,"alpha":0.5,"triangleEdges":true,"hidden":true}' &&
    a.hidden!.panel === 'hide', `Hide keeping the rest, the panel following: ${j}`);
  expect(a.removed!.own === null && !a.removed!.hidden && a.removed!.drawn && a.removed!.panel === 'inherit',
    `removed: ${j}`);
  expect(JSON.stringify(ownItems(a.after!.items)) === '["Hide","Show","Reveal","Hide others",' +
      '"Show others","Show all","Override Appearance..."]',
    `no Remove without: ${j}`);
  type Several = { items: string[]; open: boolean; owns: unknown[]; selected: number[]; focused: number };
  const mu = a.multi as unknown as { hide: Several; show: Several; remove: Several; outside: Several; opened: Several;
    panel: string; name: string; p: number[] };
  // (How many, on several: Remove's those with an override, one of the two at first.)
  const all = '["Hide 2","Show 2","Reveal 2","Hide others",' +
      '"Show others","Show all","Override Appearance...","Remove Appearance Override 1"]';
  const both = JSON.stringify(mu.p.slice(0, 2));
  expect(JSON.stringify(ownItems(mu.hide.items)) === all && JSON.stringify(mu.hide.owns) ===
    '[{"hidden":true},{"transparent":true,"alpha":0.5,"hidden":true},null]' && JSON.stringify(mu.hide.selected) ===
    both, `Hide on the selection: ${j}`);
  expect(JSON.stringify(mu.show.owns) === '[{"hidden":false},{"transparent":true,"alpha":0.5,"hidden":false},null]',
    `Show on the selection: ${j}`);
  expect(mu.panel === `Override Appearance: ${mu.name}`, `Override Appearance... on the one clicked: ${j}`);
  expect(JSON.stringify(ownItems(mu.remove.items)) === '["Hide 2","Show 2","Reveal 2","Hide others",' +
      '"Show others","Show all","Override Appearance...",' +
    '"Remove Appearance Override 2"]' && JSON.stringify(mu.remove.owns) === '[null,null,null]',
    `Remove on the selection: ${j}`);
  expect(JSON.stringify(ownItems(mu.outside.items)) === '["Hide","Show","Reveal","Hide others",' +
      '"Show others","Show all","Override Appearance..."]' &&
    JSON.stringify(mu.outside.owns) === '[null,null,{"hidden":true}]' && JSON.stringify(mu.outside.selected) === both,
    `outside the selection, that one alone: ${j}`);
  // The focus (the outlined row) moved to each row right-clicked, the selection kept.
  expect(mu.hide.focused === mu.p[0] && mu.show.focused === mu.p[1] && mu.outside.focused === mu.p[2] &&
    mu.opened.focused === mu.p[0] && mu.opened.open,
    `the focus on the row right-clicked: ${j}`);
  // (Each node's change recorded: 5 above, the second part's override, 2 each for Hide, Show and Remove, 1 outside.)
  expect(a.rec.events.filter((e) => e.type === 'appearance').length === 13, `recorded: ${j}`);
  const replayed = await page('?check', `(async () => {
    await cadViewer.ready;
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    const st = cadViewer.state();
    return { divergences: report.divergences, overrides: { hidden: st.hidden, shown: st.shown, opacity: st.opacity,
      triangleEdges: st.triangleEdges } };
  })()`) as { after: { divergences: string[]; overrides: unknown } };
  expect(replayed.after.divergences.length === 0 && JSON.stringify(replayed.after.overrides) ===
    JSON.stringify(a.overrides), `replayed: ${JSON.stringify(replayed.after)} ${j}`);
  return undefined;
});
// The view's context menu and the tree's focus: a right-click on a part (the mouse unmoved) opens the tree's menu for
// it, the selection unchanged, the tree's focus (outlined) on its row, revealed in a folded tree; its Hide hides that
// part alone; on nothing, no menu and no focus; a right-drag (a pan) no menu; a long press with a finger the menu,
// its lift no pick; a left click moves the focus to what it picks, or clears it on nothing; at the detail level, a
// face's, edge's or vertex's.
await check('view context menu', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    // (Multi-select off: its clicks are checked as they are then; 'multi-select' checks it on.)
    ui.selection.multi = false;
    const m = viewer.nodes, canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const send = (type, x, y, o = {}) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1,
      isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, ...o }));
    const rightClick = (x, y) => { send('pointerdown', x, y, { button: 2, buttons: 2 });
      send('pointerup', x, y, { button: 2, buttons: 0 }); };
    const leftClick = (x, y) => { send('pointerdown', x, y, { button: 0, buttons: 1 });
      send('pointerup', x, y, { button: 0, buttons: 0 }); };
    const look = async () => {
      await frame();
      const menu = [...document.querySelectorAll('.cv-menu button')].map((b) => b.textContent);
      const f = document.querySelector('#tree .tree-row.focused');
      return { menu, focused: f ? +f.dataset.id : null, selected: [...ui.selected()] };
    };
    const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // A point over a part (as a click picks it), and one over nothing.
    let spot;
    for (let i = 1; i < 10 && !spot; i++) for (let j = 1; j < 10 && !spot; j++) {
      const path = cadViewer.pickAt(i / 10, j / 10)?.path;
      if (path) spot = { x: rect.left + i / 10 * rect.width, y: rect.top + j / 10 * rect.height, id: m.find(path) };
    }
    if (!spot) return { spot: null };
    const empty = { x: rect.left + 2, y: rect.top + 2 };
    const part = spot.id, other = m.nodes.find((n) => n.kind === 'part' && n.id !== part).id;
    const out = { part, other };
    ui.select([other]);
    ui.panel().collapseAll();
    await frame();
    rightClick(spot.x, spot.y);
    out.right = await look();
    [...document.querySelectorAll('.cv-menu button')].find((b) => b.textContent === 'Hide').click();
    await frame();
    out.hid = { part: !!m.ownOverride(part)?.hidden, other: !!m.ownOverride(other)?.hidden };
    ui.setOverride(part, {});
    await cadViewer.idle();
    rightClick(empty.x, empty.y);
    out.rightEmpty = await look();
    // A long press: the menu while the finger is down, no pick when it lifts, even at once (within a tap's time).
    send('pointerdown', spot.x, spot.y, { pointerType: 'touch', pointerId: 2, button: 0, buttons: 1 });
    const t0 = performance.now();
    while (!document.querySelector('.cv-menu') && performance.now() - t0 < 2000) {
      await new Promise((res) => setTimeout(res, 2));
    }
    send('pointerup', spot.x, spot.y, { pointerType: 'touch', pointerId: 2, button: 0, buttons: 0 });
    out.liftedAfter = Math.round(performance.now() - t0);
    out.press = await look();
    out.lifted = await look();
    escape();
    leftClick(spot.x, spot.y);
    out.left = await look();
    leftClick(empty.x, empty.y);
    out.leftEmpty = await look();
    // The detail level: a face's menu and focus.
    ui.setPickLevel('detail');
    rightClick(spot.x, spot.y);
    out.detail = await look();
    out.detailKind = out.detail.focused === null ? null : m.nodes[out.detail.focused].kind;
    escape();
    // Last, as they move the view, each just past its threshold (so what's under the point stays the part): a finger
    // that moves 12 px (turning the view), no menu; a right-drag of 8 px (a pan), no menu.
    send('pointerdown', spot.x, spot.y, { pointerType: 'touch', pointerId: 3, button: 0, buttons: 1 });
    send('pointermove', spot.x + 12, spot.y, { pointerType: 'touch', pointerId: 3, button: -1, buttons: 1 });
    await new Promise((res) => setTimeout(res, 700));
    out.turned = await look();
    send('pointerup', spot.x + 12, spot.y, { pointerType: 'touch', pointerId: 3, button: 0, buttons: 0 });
    escape();
    send('pointerdown', spot.x, spot.y, { button: 2, buttons: 2 });
    send('pointermove', spot.x + 8, spot.y, { button: -1, buttons: 2 });
    send('pointerup', spot.x + 8, spot.y, { button: 2, buttons: 0 });
    out.drag = await look();
    escape();
    return out;
  })()`) as { after: Record<string, unknown> & Record<'right' | 'rightEmpty' | 'drag' | 'press' | 'lifted' | 'turned' |
    'left' | 'leftEmpty' | 'detail', { menu: string[]; focused: number | null; selected: number[] }> };
  const a = r.after, j = JSON.stringify(a);
  const other = JSON.stringify([a.other]);
  expect(a.right?.menu[0] === 'Hide' && a.right.menu.includes('Select children') && a.right.focused === a.part &&
    JSON.stringify(a.right.selected) === other, `a right-click on a part: ${j}`);
  expect(JSON.stringify(a.hid) === '{"part":true,"other":false}', `its Hide: ${j}`);
  expect(a.rightEmpty.menu.length === 0 && a.rightEmpty.focused === null, `a right-click on nothing: ${j}`);
  expect(a.drag.menu.length === 0, `a right-drag: ${j}`);
  expect(a.press.menu[0] === 'Hide' && a.press.focused === a.part && JSON.stringify(a.lifted.selected) === other &&
    (a.liftedAfter as number) < 600,
    `a long press: ${j}`);
  expect(a.turned.menu.length === 0, `a finger that moves: ${j}`);
  expect(a.left.focused === a.part && JSON.stringify(a.left.selected) === JSON.stringify([a.part]) &&
    a.leftEmpty.focused === null && a.leftEmpty.selected.length === 0, `left clicks: ${j}`);
  expect(a.detail.menu[0] === 'Hide' && ['face', 'edge', 'curve', 'vertex', 'point'].includes(a.detailKind as string) &&
    a.detail.selected.length === 0, `at the detail level: ${j}`);
  return undefined;
});
// The view's menu's Pick... (above Select parent, starting its group; not in the tree's menu) opens a movable modal
// listing everything along the line of sight at the point right-clicked, nearest first: as many as hiding the nearest
// part and picking again peels off there (the ids' pick sees only the nearest), the rows as the tree's (icon, name).
// The cursor on the first row from the start, outlined and in the alert colour, its node alerted in the view; the
// arrows move it (clamped at the ends), a click moves it there. The mouse over a row marks it hovered and highlights
// its node as the tree's row does. Clicks, shift-clicks and Space select as the tree's rows do, the rows drawn
// selected, the tree following; recorded and replayed as those selections. Closed by Escape: no alert, no highlight.
// Long lists: only the rows in view drawn (200,000, through the module, on the dev server).
await check('pick list', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    ui.selection.multi = false;
    const m = viewer.nodes, canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const send = (type, x, y, o = {}) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1,
      isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, ...o }));
    // What's along the line of sight at a point (fractions of the view), by hiding the nearest and picking again.
    const peel = async (fx, fy) => {
      const ids = [];
      for (let k = 0; k < 20; k++) {
        await frame();
        const path = cadViewer.pickAt(fx, fy)?.path;
        if (!path) break;
        const id = m.find(path);
        if (ids.includes(id)) break;
        ids.push(id);
        ui.setOverride(id, { hidden: true });
      }
      for (const id of ids) ui.setOverride(id, {});
      await cadViewer.idle();
      await frame();
      return ids;
    };
    let spot;
    for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.5], [0.55, 0.5], [0.5, 0.45], [0.5, 0.55], [0.4, 0.4], [0.6, 0.6],
      [0.4, 0.6], [0.6, 0.4], [0.35, 0.5], [0.65, 0.5]]) {
      const ids = await peel(fx, fy);
      if (!spot || ids.length > spot.ids.length) spot = { fx, fy, ids, x: rect.left + fx * rect.width,
        y: rect.top + fy * rect.height };
      if (spot.ids.length >= 3) break;
    }
    const out = { peeled: spot.ids };
    const items = () => [...document.querySelectorAll('.cv-menu button')].map((b) => ({ text: b.textContent,
      divider: b.classList.contains('divider') }));
    // The tree's menu: no Pick....
    ui.panel().onContextMenu(spot.ids[0], 100, 100);
    out.treeMenu = items().map((i) => i.text);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // The colours the list's rows take: Rendering's (not the page's defaults).
    ui.setRender({ highlightColor: '#1f3fff', alertColor: '#20a040' });
    await frame();
    cadViewer.record(true);
    send('pointerdown', spot.x, spot.y, { button: 2, buttons: 2 });
    send('pointerup', spot.x, spot.y, { button: 2, buttons: 0 });
    await frame();
    out.viewMenu = items();
    [...document.querySelectorAll('.cv-menu button')].find((b) => b.textContent === 'Pick...').click();
    await frame();
    await frame();
    const dialog = document.querySelector('dialog.cv-dialog[open]');
    const scroller = dialog.querySelector('.pick-list .tree-scroller');
    const rows = () => [...dialog.querySelectorAll('.tree-row')].filter((x) => x.style.display !== 'none')
      .sort((a, b) => +a.dataset.index - +b.dataset.index);
    const state = () => {
      const all = rows();
      const cls = (c) => all.filter((x) => x.classList.contains(c)).map((x) => +x.dataset.index);
      const h = viewer.highlights.highlight;
      return { focused: cls('focused'), alert: cls('alert'), hovered: cls('hovered'), selected: cls('selected'),
        alerted: [...viewer.alerted], picked: [...ui.selected()], outline: h.outline.length + h.marks.length,
        treeSelected: [...document.querySelectorAll('#tree .tree-row.selected')].map((x) => +x.dataset.id),
        cursorBg: all.find((x) => x.classList.contains('alert')) && getComputedStyle(all.find((x) =>
          x.classList.contains('alert'))).backgroundColor, active: document.activeElement === scroller };
    };
    out.title = dialog.querySelector('h2 span').textContent;
    out.modal = dialog.matches(':modal');
    out.backdrop = getComputedStyle(dialog, '::backdrop').backgroundColor;
    out.drag = dialog.querySelector('h2').classList.contains('drag');
    out.rows = rows().map((x) => ({ id: +x.dataset.id, name: x.querySelector('.tree-name').textContent,
      icon: x.querySelector('.tree-icon')?.outerHTML }));
    out.names = out.rows.map((x) => m.nodes[x.id].name);
    // The tree's own rows' icons, for the same nodes.
    out.treeIcons = [];
    for (const x of out.rows) {
      ui.panel().setFocus(x.id);
      await frame();
      out.treeIcons.push(document.querySelector('#tree .tree-row[data-id="' + x.id + '"] .tree-icon')?.outerHTML);
    }
    out.start = state();
    const key = (k, o = {}) => scroller.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true,
      cancelable: true, ...o }));
    const n = out.rows.length;
    key('ArrowDown');
    await frame();
    out.down = state();
    for (let i = 0; i < n + 2; i++) key('ArrowDown');
    await frame();
    out.bottom = state();
    for (let i = 0; i < n + 2; i++) key('ArrowUp');
    await frame();
    out.top = state();
    const rowAt = (i) => rows().find((x) => +x.dataset.index === i);
    const over = async (i) => {
      const b = rowAt(i).getBoundingClientRect();
      scroller.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: b.left + 30,
        clientY: b.top + b.height / 2, pointerType: 'mouse' }));
      await frame();
    };
    await over(1);
    out.hover = state();
    out.hoverBg = getComputedStyle(rowAt(1)).backgroundColor;
    const click = async (i, o = {}) => {
      rowAt(i).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...o }));
      await frame();
    };
    await click(1);
    out.click = state();
    await click(n - 1, { shiftKey: true });
    out.shiftClick = state();
    key('ArrowUp');
    await frame();
    key(' ');
    await frame();
    out.space = state();
    key('ArrowUp');
    await frame();
    key(' ', { shiftKey: true });
    await frame();
    out.shiftSpace = state();
    await click(0, { ctrlKey: true });
    out.ctrlClick = state();
    scroller.dispatchEvent(new PointerEvent('pointerleave', { clientX: 0, clientY: 0, pointerType: 'mouse' }));
    await frame();
    out.left = state();
    out.final = [...ui.selected()];
    // Closed with the mouse over a row: its highlight gone.
    await over(1);
    out.hoverBeforeClose = state().outline;
    dialog.close();
    await frame();
    out.closed = { open: !!document.querySelector('dialog.cv-dialog[open]'), alerted: [...viewer.alerted],
      outline: viewer.highlights.highlight.outline.length + viewer.highlights.highlight.marks.length };
    out.rec = cadViewer.record(false);
    if (${!process.env.BUILD}) {
      // A long list, through the module: only the rows in view drawn, the last reached by scrolling.
      const { showPickList } = await import('${base}src/pick-list.ts');
      const parts = m.nodes.filter((x) => x.kind === 'part').map((x) => x.id);
      const ids = Array.from({ length: 200000 }, (_, i) => parts[i % parts.length]);
      const t0 = performance.now();
      let cursor;
      showPickList({ model: m, ids, selected: () => [], multi: () => false, onSelect: () => {}, onHover: () => {},
        onCursor: (c) => { cursor = c; }, onClose: () => {} });
      await frame();
      const big = document.querySelector('dialog.cv-dialog[open]');
      const sc = big.querySelector('.tree-scroller');
      out.big = { ms: Math.round(performance.now() - t0), rows: big.querySelectorAll('.tree-row').length,
        height: sc.scrollHeight };
      sc.scrollTop = sc.scrollHeight;
      await frame();
      await frame();
      const shown = [...big.querySelectorAll('.tree-row')].filter((x) => x.style.display !== 'none')
        .map((x) => +x.dataset.index);
      out.big.last = Math.max(...shown);
      out.big.drawn = shown.length;
      out.big.cursor = cursor;
      big.close();
      await frame();
    }
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify({ ...a, rec: undefined });
  const ids = (x: number[]) => JSON.stringify(x);
  const menu = a.viewMenu as { text: string; divider: boolean }[];
  const at = menu.findIndex((i) => i.text === 'Pick...');
  expect(at > 0 && menu[at + 1]?.text === 'Select parent' && menu[at]!.divider && !menu[at + 1]!.divider &&
    !(a.treeMenu as string[]).includes('Pick...'), `the menus: ${j}`);
  const rows = a.rows as { id: number; name: string; icon: string }[];
  const n = rows.length;
  expect(a.peeled.length >= 3 && ids(rows.map((x) => x.id)) === ids(a.peeled), `the rows, nearest first: ${j}`);
  expect(a.title === `Pick: ${n} items` && a.modal && a.drag && a.backdrop === 'rgba(0, 0, 0, 0)' &&
    rows.every((x, i) => x.name === a.names[i] && !!x.icon && x.icon === a.treeIcons[i]), `the dialog, the rows as the tree's: ${j}`);
  const green = 'rgb(32, 160, 64)';
  const s = (o: any, cursor: number) => ids(o.focused) === ids([cursor]) && ids(o.alert) === ids([cursor]) &&
    ids(o.alerted) === ids([rows[cursor]!.id]);
  expect(s(a.start, 0) && a.start.cursorBg === green && a.start.active && a.start.selected.length === 0,
    `the cursor at first: ${j}`);
  expect(s(a.down, 1) && s(a.bottom, n - 1) && s(a.top, 0), `the arrows: ${j}`);
  expect(ids(a.hover.hovered) === '[1]' && a.hover.outline > 0 && a.hoverBg === 'rgb(31, 63, 255)' && s(a.hover, 0),
    `hovered: ${j}`);
  const sel = (from: number, to: number) => ids(rows.slice(from, to + 1).map((x) => x.id));
  expect(s(a.click, 1) && ids(a.click.picked) === sel(1, 1) && ids(a.click.selected) === '[1]' &&
    ids(a.click.treeSelected) === sel(1, 1), `a click: ${j}`);
  expect(s(a.shiftClick, n - 1) && ids([...a.shiftClick.picked].sort()) === ids(rows.slice(1).map((x) => x.id)
    .sort()), `a shift-click: ${j}`);
  // (Space on a selected row: it comes out; shift-space there: the span from the anchor, row 1, comes out.)
  const cur = n - 2;
  expect(s(a.space, cur) && !a.space.picked.includes(rows[cur]!.id) && a.space.picked.length === n - 2,
    `space: ${j}`);
  // (Up a row, shift-space: the rows from there to the anchor, the row Space clicked, in place of the selection.)
  const spanned = rows.slice(cur - 1, cur + 1).map((x) => x.id);
  expect(s(a.shiftSpace, cur - 1) && ids([...a.shiftSpace.picked].sort()) === ids([...spanned].sort()),
    `shift-space: ${j}`);
  const toggled = spanned.includes(rows[0]!.id) ? spanned.filter((x) => x !== rows[0]!.id) : [...spanned, rows[0]!.id];
  expect(s(a.ctrlClick, 0) && ids([...a.ctrlClick.picked].sort()) === ids(toggled.sort()), `a ctrl-click: ${j}`);
  expect(a.left.hovered.length === 0, `the mouse gone: ${j}`);
  expect(!a.closed.open && a.closed.alerted.length === 0 && a.hoverBeforeClose > 0 && a.closed.outline === 0,
    `closed: ${j}`);
  if (!process.env.BUILD) {
    expect(a.big.rows < 80 && a.big.last === 199999 && a.big.drawn < 80 && a.big.height >= 199999 * 18 &&
      a.big.ms < 1000, `a long list: ${JSON.stringify(a.big)}`);
  }
  const replayed = await page('?check', `(async () => {
    await cadViewer.ready;
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    return { divergences: report.divergences, selected: [...ui.selected()] };
  })()`) as { after: { divergences: string[]; selected: number[] } };
  expect(replayed.after.divergences.length === 0 && ids(replayed.after.selected) === ids(a.final),
    `replayed: ${JSON.stringify(replayed.after)} ${j}`);
  return undefined;
});
// The tree's arrow keys move its focus through the structure: up and down to the previous and next sibling, past
// the first to the parent, past the last to the next sibling of the parent; right to the first child, unfolding it;
// left to the parent; with the focus cleared, nowhere. Space and shift-space click and shift-click the focused row.
// As1's tree, by name.
await check('tree arrow keys', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const m = viewer.nodes, p = ui.panel();
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 20)));
    const focused = () => document.querySelector('#tree .tree-row.focused');
    const at = () => { const f = focused(); return f ? m.pathOf(+f.dataset.id) : null; };
    // A key on the focused row (the tree's keys are its container's), its default prevented or not.
    const key = async (k) => {
      const t = focused() ?? document.querySelector('#tree .tree-row');
      const allowed = t.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true,
        cancelable: true }));
      t.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, bubbles: true }));
      await frame();
      return at() + (allowed ? ' (default)' : '');
    };
    p.collapseAll();
    p.setFocus(m.find('as1/rod-assembly_1'));
    await frame();
    const seq = [['start', at()]];
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowRight',
      'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'ArrowLeft', 'ArrowUp']) seq.push([k, await key(k)]);
    // The last child of a last child: on to the next sibling of the parent's.
    p.setFocus(m.find('as1/l-bracket-assembly_2/l-bracket_1'));
    await frame();
    seq.push(['ArrowDown', await key('ArrowDown')]);
    // A part, folded and without detail: no child to go to.
    seq.push(['ArrowRight', await key('ArrowRight')]);
    // The focus cleared: the keys do nothing (not even from the first row, which a fresh tree outlines).
    p.setFocus(undefined);
    await frame();
    seq.push(['ArrowRight', await key('ArrowRight')]);
    const selected = ui.selected().length;
    // Space and shift-space click and shift-click the focused row (selecting and deselecting as clicks do); with the
    // focus cleared, nothing.
    const press = async (shift) => {
      const t = focused() ?? document.querySelector('#tree .tree-row');
      const ev = (type, k, code) => t.dispatchEvent(new KeyboardEvent(type, { key: k, code, shiftKey: shift,
        bubbles: true, cancelable: true }));
      if (shift) ev('keydown', 'Shift', 'ShiftLeft');
      const allowed = ev('keydown', ' ', 'Space');
      ev('keyup', ' ', 'Space');
      if (shift) ev('keyup', 'Shift', 'ShiftLeft');
      await frame();
      return ui.selected().map((i) => m.pathOf(i).replace('as1/', '')).join() + (allowed ? ' (default)' : '');
    };
    const space = [await press(false)];
    p.setFocus(m.find('as1/rod-assembly_1'));
    await frame();
    space.push(await press(false));
    await key('ArrowDown');
    await key('ArrowDown');
    space.push(await press(true), await press(false));
    await key('ArrowUp');
    space.push(await press(true));
    return { seq, selected, space };
  })()`) as { after: { seq: [string, string][]; selected: number; space: string[] } };
  const got = r.after.seq.map(([k, v]) => `${k}: ${v}`);
  const lb2 = 'as1/l-bracket-assembly_2';
  const want = ['start: as1/rod-assembly_1', 'ArrowDown: as1/l-bracket-assembly_1', `ArrowDown: ${lb2}`,
    'ArrowDown: as1/plate_1', 'ArrowDown: as1/plate_1', `ArrowUp: ${lb2}`,
    `ArrowRight: ${lb2}/nut-bolt-assembly_1`, `ArrowRight: ${lb2}/nut-bolt-assembly_1/bolt_1`,
    `ArrowDown: ${lb2}/nut-bolt-assembly_1/nut_3`, `ArrowDown: ${lb2}/nut-bolt-assembly_2`,
    `ArrowUp: ${lb2}/nut-bolt-assembly_1`, `ArrowUp: ${lb2}`, 'ArrowLeft: as1', 'ArrowLeft: as1',
    'ArrowUp: as1', 'ArrowDown: as1/plate_1', 'ArrowRight: as1/plate_1', 'ArrowRight: null'];
  const diff = want.map((w, i) => (w === got[i] ? '' : `step ${i}: ${got[i]}, not ${w}`)).filter(Boolean);
  expect(!diff.length && got.length === want.length, `the moves: ${diff.join('; ')} (${got.join(' | ')})`);
  expect(r.after.selected === 0, `the selection unchanged: ${r.after.selected}`);
  const space = ['', 'rod-assembly_1', 'rod-assembly_1,l-bracket-assembly_1,l-bracket-assembly_2',
    'rod-assembly_1,l-bracket-assembly_1', 'rod-assembly_1'];
  expect(r.after.space.join(' | ') === space.join(' | '), `space and shift-space: ${r.after.space.join(' | ')}`);
  return undefined;
});
// Dialogs dragged by their title: Override Appearance... moved by a mouse drag of its title, as far as the drag, a
// second from where it was left; dragged far off, its title kept in the window; a modal one (About) too.
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
    [...document.querySelectorAll('.cv-menu button')].find((x) => x.textContent === 'Override Appearance...')
      .click();
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
// The page's clock stood in for (performance.now, which flights and frames read), each step drawing a frame at a
// known time: under load, frames come late, and a check by the real clock reads the camera before it moves.
await check('camera flights', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const v = globalThis.viewer;
    const real = performance.now;
    let now = real.call(performance);
    performance.now = () => now;
    // The clock moved on (by more than a frame's interval), and the frame then due drawn.
    const step = async (ms) => {
      now += ms;
      const f = v.frames.frames;
      while (v.frames.scheduled && v.frames.frames === f) await new Promise((r) => requestAnimationFrame(r));
    };
    // Steps until no flight is left and no frame is due.
    const land = async () => { for (let i = 0; i < 1000 && (v.flight || v.frames.scheduled); i++) await step(40); };
    try {
      v.flightMs = 1000;
      const st = () => v.cameraState();
      const far = { position: [5000, -4000, 3000], target: [400, 300, 200], up: [0, 0, 1], height: 40 };
      // Where zoom all goes, at once.
      v.setCamera(far);
      v.flightMs = 0;
      v.zoomAll();
      await land();
      const goal = st();
      v.flightMs = 1000;
      v.setCamera(far);
      await land();
      const t0 = now;
      v.zoomAll();
      const right = st();
      const samples = [];
      while (v.flight && now - t0 < 5000) {
        await step(40);
        samples.push([now - t0, st().height]);
      }
      const took = now - t0;
      await land();
      const end = st();
      // A view: turned about the target, from the same distance and height.
      const before = st();
      v.setView('top');
      await land();
      const top = st();
      // Stopped by the user's input partway.
      v.setView('front');
      await step(400);
      v.controls.dispatchEvent({ type: 'start' });
      v.controls.dispatchEvent({ type: 'end' });
      const stopped = st();
      await step(900);
      await land();
      const later = st();
      // Zoom selected flies too: not there at once.
      v.setCamera(far);
      await land();
      ui.select([ui.panel().model.nodes.find((n) => n.kind === 'part').id]);
      ui.zoomSelected();
      const selectedAtOnce = st();
      await land();
      const selectedEnd = st();
      // A link's view (a state applied) at once; an exact camera set mid-flight ends the flight there.
      cadViewer.apply({ view: 'left' });
      const left = st();
      v.zoomAll();
      v.setCamera(far);
      await step(300);
      await land();
      const set = st();
      // A flight of the zoom alone (the camera already where zoom all puts it, only the height off): it goes on.
      v.setCamera({ ...goal, height: goal.height * 10 });
      v.zoomAll();
      await step(500);
      const zoomHalf = st();
      await land();
      const zoomEnd = st();
      return { zoomHalf, zoomEnd, far, goal, right, samples, took, end, before, top, stopped, later, selectedAtOnce,
        selectedEnd, left, set };
    } finally {
      performance.now = real;
    }
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
  expect(a.took === 1000, `the flight took ${a.took} ms`);
  // On the way: the height from the start's to the goal's, by ratio, eased by smoothstep (slow at the ends, half at
  // half time), written out here.
  const frac = ([, h]: [number, number]) => Math.log(h / a.far.height) / Math.log(a.goal.height / a.far.height);
  const eased = (t: number) => (t / 1000) ** 2 * (3 - 2 * t / 1000);
  const off = a.samples.filter((s) => s[0] < 1000 && Math.abs(frac(s) - eased(s[0])) > 1e-6);
  expect(a.samples.length === 25 && !off.length, `not eased: ${JSON.stringify(off)} of ${a.samples.length}`);
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
// Fitting beside the controls: zoom all and zoom selected fit the sphere in the width between the view's left and the
// controls' left edge, centred there, however folded the controls are; the camera's axis (what it orbits) there too.
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
    await settled();
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
    const part = ui.panel().model.nodes.find((n) => n.kind === 'part' && partOf(n) === 'plate');
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
// The cache as the check needs it, whatever the checks before left: empty, so the bicycle meshes slowly enough to be
// caught (from the cache, it could end before it's replaced, and nothing would be cancelled); then the assembly in it,
// so loading it again hits. The assembly's pool serves the bicycle too (the same settings).
await check('replaced while meshing', async () => {
  const r = await page('?check', `(async () => {
    const v = globalThis.viewer;
    const src = async (name) => ({ name, bytes: await (await fetch('/content/' + name)).arrayBuffer() });
    await v.clearCache();
    await v.load(await src('as1.stp'));
    const first = v.load(await src('bicycle.stp'));
    // (The bicycle's model, not the assembly's still shown.)
    const bike = () => (v.model?.name === 'bicycle.stp' ? v.model.parts?.done ?? 0 : 0);
    for (let t = 0; t < 3000 && !(bike() > 0); t++) await new Promise((r) => setTimeout(r, 10));
    const begun = bike();
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
    v.settings.backend = 'smlib';
    await v.load(await src('as1.stp'));
    const smlib = { parts: v.model.parts, ...v.model.meshing };
    return { begun, firstEnded, glb, step, truck, smlib };
  })()`) as { after?: { begun: number; firstEnded: number; glb: { name: string; stats: { triangles: number } };
    step: { name: string; stats: { triangles: number }; parts: { done: number; failed: number }; backend: string;
      cache?: { hits: number; misses: number }; pools: number };
    truck: { parts: { done: number; failed: number }; backend: string };
    smlib: { parts: { done: number; failed: number }; backend: string } } };
  const a = r.after!;
  expect(a.begun > 0 && a.begun < 112, `the bicycle wasn't caught meshing: ${a.begun} parts done`);
  expect(a.firstEnded < 1000, `the bicycle's load went on for ${a.firstEnded} ms after it was replaced`);
  expect(a.step.backend.startsWith('occt+smlib ') && a.step.cache!.hits >= 5, `STEP again: ${JSON.stringify(a.step)}`);
  // The bicycle's pool was disposed when it was replaced: the assembly got a new one (the second).
  expect(a.step.pools === 2, `a new pool after replacing: ${JSON.stringify(a.step)}`);
  expect(a.truck.backend.startsWith('truck+smlib ') && a.truck.parts.done === 5, `truck: ${JSON.stringify(a.truck)}`);
  // (SMLib's fallback SMLib: none.)
  expect(a.smlib.backend.startsWith('smlib ') && a.smlib.parts.done === 5 && a.smlib.parts.failed === 0,
    `SMLib: ${JSON.stringify(a.smlib)}`);
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
    // (Multi-select off: its clicks are checked as they are then; 'multi-select' checks it on.)
    ui.selection.multi = false;
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
    const click = (row, ctrlKey = false, shiftKey = false) => row.dispatchEvent(new MouseEvent('click',
      { bubbles: true, ctrlKey, shiftKey }));
    const display = getComputedStyle(rows()[0]).display;
    const label = rows()[0].getAttribute('aria-label');
    // (A part's row brought into view first: the first part's detail, every edge and vertex a row, fills the panel.)
    const partIds = m.nodes.filter((n) => n.kind === 'part').map((n) => n.id);
    const rowOf = async (id) => {
      p.scrollToRow(id, 0);
      await frame();
      return rows().find((r) => +r.dataset.id === id);
    };
    click(await rowOf(partIds[0]));
    await frame();
    click(await rowOf(partIds[1]), true);
    await frame();
    const selected = [...p.selected()];
    const afterClicks = spacerRows();
    ui.hideSelected();
    await frame();
    const hiddenObjects = selected.filter((i) => m.nodes[i].object.visible === false).length;
    const greyed = rows().filter((r) => r.classList.contains('hidden')).length;
    // A face of the first part, hidden: that placement draws it with nothing, the part's others draw it (faces are per
    // placement).
    ui.showAll();
    await frame();
    // Shift-click: from the row last clicked; with nothing selected (cleared from elsewhere), that row alone.
    click(await rowOf(partIds[2]), false, true);
    await frame();
    const range = [...p.selected()];
    p.select([], false);
    await frame();
    click(await rowOf(partIds[2]), false, true);
    await frame();
    const fromNone = [...p.selected()];
    click(await rowOf(partIds[3]), false, true);
    await frame();
    const fromThat = [...p.selected()];
    // Clicks on selected rows: a plain click takes the row out, a shift-click the rows from it to the row last
    // clicked; the 3D view's selection the same, told once a click.
    click(await rowOf(partIds[1]));
    await frame();
    click(await rowOf(partIds[3]), false, true);
    await frame();
    const all3 = [...p.selected()];
    let told = 0;
    const onSelect = p.onSelect;
    p.onSelect = (ids) => { told++; onSelect(ids); };
    click(await rowOf(partIds[2]));
    await frame();
    const lessOne = [...p.selected()];
    click(await rowOf(partIds[3]), false, true);
    await frame();
    const lessSpan = [...p.selected()], inView = [...ui.selected()];
    p.onSelect = onSelect;
    const shift = { range, fromNone, fromThat, parts: partIds.slice(1, 4), all3, lessOne, lessSpan, inView, told };
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
      display, label, afterClicks, picked, collapsed, shift };
  })()`) as { after?: { shift: { range: number[];
    fromNone: number[]; fromThat: number[]; parts: number[];
    all3: number[]; lessOne: number[]; lessSpan: number[]; inView: number[]; told: number }; initial: string[]; all: number; nodes: number; selected: number; hiddenObjects: number;
    greyed: number; same: number; sameHidden: number; invisibleGroups: number; invisibleAfter: number;
    greyAfter: number; display: string; label: string; afterClicks: number; picked: boolean; collapsed: number } };
  const a = r.after!;
  const j = JSON.stringify(a);
  // (The file's root at the top, no row for the file, and its contents open.)
  expect(a.initial.length > 3 && a.initial[0] === 'as1' && a.initial[1] === 'rod-assembly_1' &&
    a.initial[2] === 'l-bracket-assembly_1', `initial rows: ${j}`);
  expect(a.all === a.nodes, `rows ${a.all}, nodes ${a.nodes}`);
  expect(a.display === 'flex' && a.label === 'as1', `rows' layout and labels: ${j}`);
  // Clicks select; they don't expand or collapse.
  expect(a.afterClicks === a.all, `rows after clicks: ${j}`);
  expect(a.picked && a.collapsed === 1, `selecting from elsewhere, collapsing: ${j}`);
  // (Rows between parts are their detail: a range from part 1 to part 2 is more than the two.)
  const sh = a.shift, [p1, p2, p3] = sh.parts;
  expect(sh.range.length > 2 && sh.range.includes(p1!) && sh.range.includes(p2!) && !sh.range.includes(p3!),
    `shift-click, a range from the row last clicked: ${JSON.stringify(sh)}`);
  expect(sh.fromNone.join() === String(p2), `shift-click with nothing selected, the row alone: ${JSON.stringify(sh)}`);
  expect(sh.fromThat.length > 2 && sh.fromThat.includes(p2!) && sh.fromThat.includes(p3!) &&
    !sh.fromThat.includes(p1!), `shift-click after it, from that row: ${JSON.stringify(sh)}`);
  const upTo2 = sh.all3.slice(0, sh.all3.indexOf(p2!));
  expect(sh.all3[0] === p1 && sh.all3.at(-1) === p3 && sh.lessOne.join() === sh.all3.filter((i) => i !== p2).join(),
    `a click on a selected row: ${JSON.stringify(sh)}`);
  expect(upTo2.length > 1 && sh.lessSpan.join() === upTo2.join() && sh.inView.join() === upTo2.join() &&
    sh.told === 2, `a shift-click on a selected row: ${JSON.stringify(sh)}`);
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
    // (Multi-select off: its clicks are checked as they are then; 'multi-select' checks it on.)
    ui.selection.multi = false;
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
    // A plain click on what's selected takes it out.
    click(spots[0].x, spots[0].y);
    await frame();
    const removed = [...ui.selected()];
    click(rect.left + 2, rect.top + 2);
    await frame();
    const none = [...ui.selected()];
    // Multi-select: taps toggle without keys; select parent: the selection's parents.
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
      dragged, removed };
  })()`) as { after?: { removed: number[]; spots: number[]; first: number[]; tinted: boolean; rowSelected: boolean;
    detailsText: string; two: number[]; none: number[]; centred: boolean; detailKind: string; placements: number;
    lit: number; unlit: number; toggled: number[]; parent: number[]; parentExpected: number[]; dragged: number[] } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.spots.length === 2, `no two parts to click: ${j}`);
  expect(a.first.join() === String(a.spots[0]) && a.tinted && a.rowSelected, `a click: ${j}`);
  expect(/Placement \d+ of \d+|The only placement/.test(a.detailsText) && /Triangles: /.test(a.detailsText),
    `details: ${j}`);
  expect(a.two.join() === a.spots.join() && a.none.length === 0, `ctrl-click, empty space: ${j}`);
  expect(a.removed.join() === String(a.spots[1]), `a click on what's selected: ${j}`);
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
    // (Those drawn: the highlights' silhouette is there, off, without one.)
    const passes = () => c.composer.passes.filter((p) => p.enabled).map((p) => names.get(p) ?? 'other');
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
    const mesh = (name) => m.nodes.find((n) => n.kind === 'part' && partOf(n) === name).object.children[0];
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
// The problems dialog (problems.ts): a file with errors, once meshed, shows them in a modal (only with ?check=dialogs
// among the check's pages), a list of its errors and one of its warnings, each scrolling on its own, "None." for a
// kind it hasn't, a Copy button for each kind, disabled for one without ids; OK closes it. A face that fails to mesh is
// an error too. A file with warnings alone, one without either, and the plain ?check pages, show none by themselves.
// The status line counts each kind ("2 errors, 1 warning (details from the About box)"; nothing for none); About's
// errors/warnings link shows the same dialog at any time. Nothing goes to the console.
await check('problems dialog', async () => {
  const first = `globalThis.consoleSaid = [];
    for (const k of ['log', 'info', 'warn', 'error']) {
      const f = console[k];
      console[k] = (...a) => { consoleSaid.push(k + ': ' + String(a[0]).slice(0, 80)); f.apply(console, a); };
    }`;
  const look = `(async () => { await cadViewer.ready; await cadViewer.idle();
    await new Promise((r) => setTimeout(r, 200));
    const dialogs = () => [...document.querySelectorAll('dialog.cv-dialog')];
    const read = (d) => {
      const list = (kind) => {
        const box = d.querySelector('.table.' + kind);
        return { rows: [...box.querySelectorAll('tr')].map((r) => [...r.cells].map((c) => c.textContent)),
          none: box.querySelector('p.none')?.textContent ?? null, scrolls: getComputedStyle(box).overflowY,
          heading: box.previousElementSibling?.textContent ?? null };
      };
      const button = (label) => [...d.querySelectorAll('button')].find((b) => b.textContent === label);
      return { title: d.querySelector('h2')?.textContent ?? null, error: d.classList.contains('error'),
        errors: list('errors'), warnings: list('warnings'),
        copyErrors: button('Copy error IDs')?.disabled ?? null,
        copyWarnings: button('Copy warning IDs')?.disabled ?? null };
    };
    const close = async (d) => {
      d.querySelector('button.primary').click();
      // (Removed once it has closed: waited for, up to 5 s, as it can take longer than a frame or two under load.)
      for (let t = 0; t < 100 && d.isConnected; t++) await new Promise((r) => setTimeout(r, 50));
      return !d.isConnected;
    };
    const diagnostics = viewer.model?.diagnostics ?? [];
    const auto = dialogs()[0];
    const out = { open: !!auto?.open, auto: auto ? read(auto) : null,
      warnings: diagnostics.filter((x) => x.severity === 'warning').length,
      errors: diagnostics.filter((x) => x.severity === 'error').length,
      status: document.getElementById('status').textContent };
    out.closed = auto ? await close(auto) : true;
    // About's link: the same dialog, over About.
    ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
    await new Promise((r) => setTimeout(r, 100));
    const about = dialogs()[0];
    const link = [...about.querySelectorAll('a')].find((a) => a.textContent === 'errors/warnings');
    out.link = !!link;
    link?.click();
    await new Promise((r) => setTimeout(r, 100));
    const fromAbout = dialogs()[1];
    out.fromAbout = fromAbout ? read(fromAbout) : null;
    if (fromAbout) out.fromAboutClosed = await close(fromAbout);
    out.aboutStill = about.open;
    await close(about);
    out.console = consoleSaid;
    return out;
  })()`;
  type List = { rows: string[][]; none: string | null; scrolls: string; heading: string | null };
  type Read = { title: string | null; error: boolean; errors: List; warnings: List; copyErrors: boolean | null;
    copyWarnings: boolean | null };
  type Seen = { open: boolean; auto: Read | null; warnings: number; errors: number; status: string; closed: boolean;
    link: boolean; fromAbout: Read | null; fromAboutClosed?: boolean; aboutStill: boolean; console: string[] };
  const see = async (file: string, dialogs = true) => (await page(`?url=${encodeURIComponent(`/content/${file}`)}`
    + `&check${dialogs ? '=dialogs' : ''}`, look, { first }) as { after: Seen }).after;
  const broken = await see('broken.stp'), clean = await see('as1.stp'), warned = await see('warned.stp');
  // (OCCT fails a face of it, meshes ten over their area and leaves an edge open; SMLib, the fallback, meshes those
  // ten but leaves out three, one the face OCCT fails: the per-face fallback's mix, OCCT's mesh with SMLib's ten,
  // still without that face and open along an edge between the two.)
  const face = await see('face-failed.stp'), quiet = await see('broken.stp', false);
  const j = JSON.stringify({ broken, clean, warned, face, quiet });
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const counts = (s: Seen) => [s.errors ? plural(s.errors, 'error') : '', s.warnings ? plural(s.warnings, 'warning')
    : ''].filter(Boolean).join(', ');
  // The dialog as it should be for a page's diagnostics, however it was opened.
  const shown = (s: Seen, r: Read | null, name: string) => !!r && r.title === `${name}: ${counts(s) ||
    'no errors or warnings'}` && r.error === s.errors > 0 && r.errors.rows.length === s.errors
    && r.warnings.rows.length === s.warnings && r.errors.rows.every((x) => x[0]!.startsWith('error'))
    && r.warnings.rows.every((x) => x[0]!.startsWith('warning'))
    && r.errors.none === (s.errors ? null : 'None.') && r.warnings.none === (s.warnings ? null : 'None.')
    && r.errors.heading === `Errors (${s.errors})` && r.warnings.heading === `Warnings (${s.warnings})`
    && r.errors.scrolls === 'auto' && r.warnings.scrolls === 'auto'
    && r.copyErrors === !r.errors.rows.some((x) => /#\d/.test(x[0]!))
    && r.copyWarnings === !r.warnings.rows.some((x) => /#\d/.test(x[0]!));
  const said = (s: Seen) => counts(s) ? s.status.endsWith(`; ${counts(s)} (details from the About box)`)
    : !/error|warning|About/.test(s.status);
  for (const [name, s] of [['broken.stp', broken], ['as1.stp', clean], ['warned.stp', warned],
    ['face-failed.stp', face], ['broken.stp', quiet]] as const) {
    expect(said(s), `${name}'s status line: ${s.status}`);
    expect(s.link && shown(s, s.fromAbout, name) && !!s.fromAboutClosed && s.aboutStill,
      `${name} from About: ${JSON.stringify(s.fromAbout)}`);
    expect(s.console.length === 0, `${name}: nothing in the console: ${JSON.stringify(s.console)}`);
  }
  expect(broken.errors > 0 && broken.warnings > 0 && broken.open && shown(broken, broken.auto, 'broken.stp')
    && !broken.auto!.copyErrors && broken.closed, `a file with errors: ${j}`);
  expect(clean.errors + clean.warnings === 0 && !clean.open && !!clean.fromAbout?.copyErrors
    && !!clean.fromAbout.copyWarnings, `a file without: ${j}`);
  expect(warned.warnings > 0 && warned.errors === 0 && !warned.open, `a file with warnings alone: ${j}`);
  expect(face.errors === 2 && face.open && !!face.auto?.title?.startsWith('face-failed.stp: 2 errors')
    && face.auto.errors.rows.map((r) => r[0]).join() === 'error #10,error #10'
    && face.auto.errors.rows.map((r) => r[1]).join('|') === '1 faces failed to mesh: #18168|1 edges along which the '
    + 'meshes of the faces they join don\'t meet: the mesh is open there', `a face failed: ${j}`);
  expect(quiet.errors > 0 && !quiet.open, `none by itself in plain ?check pages: ${j}`);
  return undefined;
});
// Who holds the B-rep models and their analyses (model-load.ts's handOver; healed, so each part has one): the page,
// each placed part's handed over with its mesh event, never waiting for the end, the same bytes the worker had; lent
// back for Mesh again and returned part by part (each as its mesh message comes); a Mesh again cancelled by another
// while its mesh events are on their way (held back here until the second has started) loses none, the second meshing
// in place; lent for an export, STEP's exact geometry written from them, and back with its answer.
await check('model ownership', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&heal=1&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const graph = () => viewer.graph;
    const breps = () => [...graph().placements.keys()].filter((i) => graph().scene.parts[i].brep).sort((a, b) => a - b);
    // Each placed part's model and analysis as the page holds them: their bytes summed (or null where either isn't
    // held).
    const sum = (b) => new Uint8Array(b).reduce((a, x) => (a * 31 + x) >>> 0, 0);
    const held = () => breps().map((i) => { const m = graph().modelOf(i), a = graph().analysisOf(i);
      return m && a ? \`\${sum(m.buffer)}/\${sum(a.buffer)}\` : null; });
    const out = { first: held(), parts: breps().length };
    // The worker's messages counted as they come (and, while 'holding', kept back to deliver later).
    const worker = viewer.modelWorker(), deliver = worker.onmessage;
    let meshes = 0, done = false, holding = false;
    const kept = [];
    worker.onmessage = (e) => {
      if (holding) return void kept.push(e);
      if (e.data.type === 'mesh') meshes++;
      if (e.data.type === 'done') done = true;
      deliver(e);
    };
    // Each model's arrival: the mesh messages come by then, and whether the end had.
    const proto = Object.getPrototypeOf(graph()), hold = proto.holdModel;
    const arrivals = [];
    proto.holdModel = function (part, buffer) {
      arrivals.push({ meshes, done });
      return hold.call(this, part, buffer);
    };
    const reset = () => { meshes = 0; done = false; return arrivals.splice(0); };
    const until = async (f) => {
      for (let t = 0; t < 1500 && !f(); t++) await new Promise((res) => setTimeout(res, 20));
    };
    reset();
    // A load whose messages are held back, then delivered at once: its meshes come before the page has shown its
    // scene (taken then, once it has).
    holding = true;
    const loading = cadViewer.load('/content/as1.stp');
    await until(() => kept.filter((e) => e.data.type === 'mesh').length >= 2);
    holding = false;
    for (const e of kept.splice(0)) worker.onmessage(e);
    await loading;
    await cadViewer.idle();
    out.arrivals = reset();
    out.loaded = held();
    const button = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    // Mesh again: lent, and back part by part; in place (the same scene graph: not the file loaded again, which would
    // hand every model over afresh).
    const before = graph();
    let again = viewer.nextLoad();
    button('Mesh again').$button.click();
    await until(() => viewer.nextLoad() !== again);
    await ui.opened();
    await cadViewer.idle();
    out.againArrivals = reset();
    out.again = held();
    // Twice: the first's messages held back until the second has started, then delivered (stale by then).
    holding = true;
    again = viewer.nextLoad();
    const t0 = performance.now();
    button('Mesh again').$button.click();
    await until(() => kept.filter((e) => e.data.type === 'mesh').length >= 2);
    out.stale = kept.filter((e) => e.data.type === 'mesh').length;
    button('Mesh again').$button.click();
    // (Released once the second has begun: the first's run is over, its listener gone.)
    await until(() => viewer.nextLoad() > again + 1);
    await new Promise((res) => setTimeout(res, 50));
    holding = false;
    for (const e of kept.splice(0)) worker.onmessage(e);
    await until(() => viewer.nextLoad() > again + 1 && !viewer.loading);
    await ui.opened();
    await cadViewer.idle();
    out.twice = held();
    out.inPlace = graph() === before;
    // (Not waiting out CANCEL_WAIT_MS, 10 s: the worker took the cancel.)
    out.twiceSeconds = (performance.now() - t0) / 1000;
    reset();
    // An export of STEP with its exact geometry: written from the models, which come back.
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (d) => {
      out.written = await new Blob([d]).text(); }, close: async () => {} }) });
    const exp = button('Export...');
    const exporting = exp.getValue().call(exp.object);
    let d;
    for (let i = 0; i < 300 && !(d = document.querySelector('dialog.cv-dialog')); i++) {
      await new Promise((res) => requestAnimationFrame(res));
    }
    const s = d.querySelector('select[data-key=format]');
    s.value = 'step';
    s.dispatchEvent(new Event('change'));
    d.querySelector('button.primary').click();
    await exporting;
    out.exported = held();
    out.faces = (out.written?.match(/ADVANCED_FACE\\(/g) ?? []).length;
    delete out.written;
    proto.holdModel = hold;
    worker.onmessage = deliver;
    return out;
  })()`) as { after: { first: (string | null)[]; parts: number; arrivals: { meshes: number; done: boolean }[];
    loaded: (string | null)[]; againArrivals: { meshes: number; done: boolean }[]; again: (string | null)[];
    stale: number; twice: (string | null)[]; inPlace: boolean; twiceSeconds: number; exported: (string | null)[];
    faces: number } };
  const a = r.after, j = JSON.stringify(a);
  const all = (h: (string | null)[]) => h.length === a.parts && h.every((x) => x !== null);
  const same = (h: (string | null)[]) => JSON.stringify(h) === JSON.stringify(a.first);
  expect(a.parts > 1 && all(a.first) && same(a.loaded), `every placed part's model and analysis with the page: ${j}`);
  // (A load's held back come, with its end, before the page has shown its scene: taken once it has.)
  expect(a.arrivals.length === a.parts && a.arrivals[0]!.meshes >= 2,
    `a load's, those before its scene was shown too: ${j}`);
  expect(a.againArrivals.length === a.parts && a.againArrivals.every((x, k) => x.meshes === k + 1 && !x.done)
    && same(a.again), `Mesh again: lent, back part by part as each mesh comes, the same bytes: ${j}`);
  expect(a.stale >= 2 && same(a.twice) && a.inPlace && a.twiceSeconds < 8, `Mesh again twice, the first's meshes `
    + `stale: none lost, in place, the cancel taken: ${j}`);
  expect(same(a.exported) && a.faces > 0, `an export of STEP's exact geometry, the models back: ${j}`);
  return undefined;
});
// A node's errors and warnings in its context menu (problems.ts's itemDiagnostics): "N Errors, M Warnings..." where it
// has any, opening the problems dialog with those alone. A node's are its own STEP ids' and everything's below it: an
// assembly's and its descendants', a part's and its B-rep model's entities' (the model the page holds); a face's own
// and its part's that name it; a top node's also the file's own, which no node covers. Checked against each
// diagnostic's owners found here by brute force. The view's menu (a right-click on the 3D view) starts with a header
// naming what was clicked as its tree row does (its icon and name); the tree's has none.
await check('item errors and warnings', async () => {
  const look = (face: boolean) => `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const m = viewer.nodes, graph = viewer.graph, diagnostics = viewer.model.diagnostics;
    if (${face}) { ui.setTree({ detail: true }); for (const n of [...m.nodes]) m.children(n.id); }
    // The ids each node holds, found here: its own (step-ids' sources, a face's source), a part's model's.
    const ownIds = (n) => {
      if (n.face) return graph.scene.parts[n.face.part] && m.nodes[m.nodes[n.parent].parent].object.userData.stepFaces
        ? [n.face.source] : [];
      const own = n.object?.userData.sources ?? [];
      if (n.kind !== 'part') return own;
      const faces = [];
      n.object.traverse((o) => faces.push(...(o.userData.faces ?? []), ...(o.userData.failedFaces ?? [])));
      // (The model's ids read here from its tables, the page holding it once meshed.)
      const model = graph.modelOf(n.object.userData.part), held = [];
      for (const t of Object.values(model ?? {})) if (t?.id instanceof Uint32Array) held.push(...t.id);
      if (model?.copy) held.push(...model.copy.source);
      return [...own, ...held, ...faces];
    };
    const structure = m.nodes.filter((n) => !n.dead && (n.kind === 'assembly' || n.kind === 'part' || n.face));
    const holders = (d) => d.source?.format !== 'step' ? [] : structure.filter((n) => ownIds(n).includes(d.source.id));
    const under = (k, top) => { for (let p = k; p >= 0; p = m.nodes[p].parent) if (p === top) return true;
      return false; };
    const expected = (n) => diagnostics.filter((d) => {
      if (d.severity !== 'error' && d.severity !== 'warning') return false;
      if (n.face) return d.source?.format === 'step' && (d.source.id === n.face.source
        || (m.nodes[m.nodes[n.parent].parent].object.userData.sources ?? []).includes(d.source.id)
        && new RegExp('#' + n.face.source + '(?!\\\\d)').test(d.message));
      const hs = holders(d);
      // (A face's id is its part's too.)
      return hs.some((h) => !h.face && under(h.id, n.id)) || n.parent < 0 && hs.filter((h) => !h.face).length === 0;
    });
    const items = () => [...document.querySelectorAll('.cv-menu button')].map((b) => b.textContent);
    const close = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const label = (e, w) => e + ' Error' + (e === 1 ? '' : 's') + ', ' + w + ' Warning' + (w === 1 ? '' : 's') + '...';
    const out = { nodes: [], counts: { errors: diagnostics.filter((d) => d.severity === 'error').length,
      warnings: diagnostics.filter((d) => d.severity === 'warning').length },
      sources: diagnostics.map((d) => d.severity[0] + (d.source ? d.source.format + '#' + d.source.id : '')) };
    for (const n of structure) {
      ui.panel().onContextMenu(n.id, 100, 100);
      await frame();
      const got = items().find((t) => / Errors?, \\d+ Warnings?\\.\\.\\.$/.test(t)) ?? null;
      const header = !!document.querySelector('.cv-menu-header');
      const ex = expected(n);
      const e = ex.filter((d) => d.severity === 'error').length, w = ex.length - e;
      const want = e + w ? label(e, w) : null;
      const entry = { path: m.pathOf(n.id), kind: n.kind, got, want, header };
      if (got) {
        [...document.querySelectorAll('.cv-menu button')].find((b) => b.textContent === got).click();
        const d = await (async () => { for (let t = 0; t < 100; t++) { const x = document.querySelector(
          'dialog.cv-dialog[open]'); if (x) return x; await frame(); } })();
        entry.dialog = { title: d.querySelector('h2').textContent,
          errors: d.querySelectorAll('.table.errors tr').length, warnings: d.querySelectorAll('.table.warnings tr')
            .length, intro: d.querySelector('p').textContent.slice(0, 60),
          sources: [...d.querySelectorAll('tr')].map((r) => r.cells[0].textContent) };
        d.querySelector('button.primary').click();
        for (let t = 0; t < 100 && d.isConnected; t++) await frame();
      } else close();
      await frame();
      out.nodes.push(entry);
    }
    // The view's menu: a right-click over a part.
    const canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    let spot;
    for (let i = 1; i < 10 && !spot; i++) for (let j = 1; j < 10 && !spot; j++) {
      const path = cadViewer.pickAt(i / 10, j / 10)?.path;
      if (path) spot = { x: rect.left + i / 10 * rect.width, y: rect.top + j / 10 * rect.height, id: m.find(path) };
    }
    if (spot) {
      const send = (type, o) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1,
        isPrimary: true, pointerType: 'mouse', clientX: spot.x, clientY: spot.y, ...o }));
      send('pointerdown', { button: 2, buttons: 2 });
      send('pointerup', { button: 2, buttons: 0 });
      await frame();
      const h = document.querySelector('.cv-menu-header');
      const row = document.querySelector('#tree .tree-row[data-id="' + spot.id + '"] .tree-content');
      out.view = { id: spot.id, selectable: h ? getComputedStyle(h).userSelect : null,
        header: h ? { icon: h.querySelector('.tree-icon')?.outerHTML,
        name: h.querySelector('.tree-name')?.textContent, first: h === document.querySelector('.cv-menu')
          .firstElementChild } : null, rowIcon: row?.querySelector('.tree-icon')?.outerHTML ?? null,
        name: m.nodes[spot.id].name, focused: document.querySelector('.cv-menu button') === document.activeElement };
      close();
    }
    return out;
  })()`;
  type Entry = { path: string; kind: string; got: string | null; want: string | null; header: boolean;
    dialog?: { title: string; errors: number; warnings: number; intro: string; sources: string[] } };
  type Seen = { nodes: Entry[]; counts: { errors: number; warnings: number }; sources: string[];
    view?: { id: number; selectable: string | null; header: { icon?: string; name?: string; first: boolean } | null;
      rowIcon: string | null;
      name: string; focused: boolean } };
  const see = async (file: string, face: boolean) => (await page(`?url=${encodeURIComponent(`/content/${file}`)}`
    + '&check', look(face)) as { after: Seen }).after;
  for (const [file, face] of [['broken.stp', false], ['face-failed.stp', true], ['as1.stp', false],
    ['warned.stp', false]] as const) {
    const a = await see(file, face), j = JSON.stringify(a);
    // (A face named for its surface where its B-rep says: `plane #12` for the path's `face#12`.)
    const named = (e: Entry, text: string, after: string) => {
      const tail = e.path.split('/').at(-1)!;
      if (!tail.startsWith('face#')) return text.startsWith(`${tail}${after}`);
      const m = text.match(/^([A-Za-z -]+) #(\d+)(.*)$/s);
      return !!m && m[2] === tail.slice(5) && m[3]!.startsWith(after);
    };
    for (const e of a.nodes) {
      expect(e.got === e.want && !e.header, `${file} ${e.path}: ${e.got} for ${e.want}: ${j}`);
      if (!e.got) continue;
      const [, ne, nw] = e.got.match(/^(\d+) Errors?, (\d+) Warnings?/)!.map(Number);
      expect(!!e.dialog && e.dialog.errors === ne && e.dialog.warnings === nw && named(e, e.dialog.title, ': ') &&
        e.dialog.intro.startsWith('Those of ') && named(e, e.dialog.intro.slice(9), e.kind === 'face' ? ', from'
        : ' and everything in it'),
      `${file} ${e.path}'s dialog: ${JSON.stringify(e)}`);
    }
    // The top nodes hold every error and warning; a file without has no item anywhere.
    const tops = a.nodes.filter((e) => !e.path.includes('/'));
    expect(tops.every((e) => e.want === (a.counts.errors + a.counts.warnings ? `${a.counts.errors} Error${
      a.counts.errors === 1 ? '' : 's'}, ${a.counts.warnings} Warning${a.counts.warnings === 1 ? '' : 's'}...`
      : null)), `${file}: the top nodes hold them all: ${j}`);
    if (file === 'broken.stp') {
      // (Some below the top, not all: a part's of its own.) Its warning at #69, an EDGE_CURVE in the B-rep of the
      // part whose shape representation is #62 (its error's source), is each placement's of that part, and their
      // parents'.
      expect(a.nodes.some((e) => e.kind === 'part' && e.got) && a.nodes.some((e) => !e.got), `${file}: ${j}`);
      const holding = a.nodes.filter((e) => e.dialog?.sources.includes('warning #69')).map((e) => e.path);
      const parts = a.nodes.filter((e) => e.kind === 'part' && e.dialog?.sources.includes('error #62'))
        .map((e) => e.path);
      expect(parts.length > 0 && parts.every((p) => holding.includes(p)) && holding.every((h) => parts.some((p) =>
        p === h || p.startsWith(`${h}/`))), `${file}: #69 its part's: ${JSON.stringify({ holding, parts })}`);
    }
    if (file === 'warned.stp') {
      // Its one warning, at an instance of its own outside every part: the file's, the top nodes' alone.
      expect(a.counts.errors === 0 && a.counts.warnings === 1 && a.nodes.every((e) => !e.got === e.path.includes('/')),
        `${file}: the file's own, the top's: ${j}`);
    }
    if (file === 'face-failed.stp') {
      // (The failed face the error names; others the fallback's warnings name.)
      const f = a.nodes.filter((e) => e.kind === 'face' && e.got?.startsWith('1 Error'));
      expect(f.length === 1 && f[0]!.path.endsWith('/face#18168'), `${file}: the failed face's: ${JSON.stringify(f)}`);
    }
    const v = a.view;
    expect(!!v && !!v.header && v.header.first && v.header.name === v.name && !!v.rowIcon
      && v.header.icon === v.rowIcon && v.focused && v.selectable === 'none',
    `${file}: the view's menu's header (not selectable: Android would select it under the long press): ${
      JSON.stringify(v)}`);
  }
  return undefined;
});
// What an operation has to say beyond the status line goes in a modal once it's done (ui.ts's notice, ?check=dialogs
// here), never the console: a model that can't be opened (its error dialog), what Mesh again didn't find again (each
// path), Mesh again falling back to loading the file again (why), an export's warnings (each), a replay's divergences
// (each, from Replay recording...).
await check('operation notices', async () => {
  const first = `globalThis.consoleSaid = [];
    for (const k of ['log', 'info', 'warn', 'error']) {
      const f = console[k];
      console[k] = (...a) => { consoleSaid.push(k + ': ' + String(a[0]).slice(0, 80)); f.apply(console, a); };
    }`;
  const r = await page('?check=dialogs', `(async () => {
    await cadViewer.ready;
    const until = async (f, what) => {
      for (const end = Date.now() + 60000; Date.now() < end;) {
        const v = f();
        if (v) return v;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error('timed out waiting for ' + what + ' (status: ' + document.getElementById('status').textContent
        + ')');
    };
    const status = () => document.getElementById('status').textContent;
    // The open dialog: its title, rows and whether it's an error, then OK.
    const answer = async (what) => {
      const d = await until(() => document.querySelector('dialog.cv-dialog[open]'), what);
      const seen = { title: d.querySelector('h2').textContent, text: d.textContent,
        error: d.classList.contains('error'), rows: [...d.querySelectorAll('tr')].map((r) => r.textContent) };
      d.querySelector('button.primary').click();
      await until(() => !d.isConnected, 'the dialog to close');
      return seen;
    };
    const none = () => !document.querySelector('dialog.cv-dialog');
    const out = {};
    // Not opened.
    void ui.openUrl('/content/no-such-model.stp');
    out.notOpened = await answer('the error dialog');
    await ui.opened();
    await ui.openUrl('/content/as1.stp');
    await cadViewer.idle();
    out.cleanLoad = none();
    const button = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    const meshAgain = async () => {
      const again = viewer.nextLoad();
      button('Mesh again').$button.click();
      await until(() => viewer.nextLoad() !== again, 'Mesh again to start');
      await ui.opened();
      await cadViewer.idle();
    };
    // A selection not found again.
    const nodes = viewer.nodes;
    const part = nodes.nodes.find((n) => n.kind === 'part');
    const lostPath = nodes.pathOf(part.id);
    ui.select([part.id]);
    const proto = Object.getPrototypeOf(viewer.nodes), find = proto.find;
    proto.find = function (p) { return p === lostPath ? undefined : find.call(this, p); };
    try {
      await meshAgain();
    } finally {
      proto.find = find;
    }
    out.lostStatus = status();
    out.lost = await answer('the not found again dialog');
    // Mesh again loading the file again.
    const meshAgainFn = viewer.meshAgain;
    viewer.meshAgain = async () => { throw new Error('the models are gone (planted)'); };
    try {
      await meshAgain();
    } finally {
      viewer.meshAgain = meshAgainFn;
    }
    out.fellBack = await answer('the loaded again dialog');
    // An export's warnings: a part's override with triangle edges, the view's look applied.
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => {},
      close: async () => {} }) });
    ui.setOverride(part.id, { triangleEdges: true });
    const exp = button('Export...');
    const done = exp.getValue().call(exp.object);
    const d = await until(() => document.querySelector('dialog.cv-dialog[open]'), 'the export dialog');
    const s = d.querySelector('select[data-key=format]');
    s.value = 'threejs';
    s.dispatchEvent(new Event('change'));
    const box = d.querySelector('input[data-key=shown]');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    d.querySelector('button.primary').click();
    await done;
    out.exportStatus = status();
    out.exported = await answer('the export warnings');
    ui.setOverride(part.id, {});
    // A replay with a divergence: the recording's end said another meshing than the replay's.
    cadViewer.record(true);
    ui.select([part.id]);
    const rec = cadViewer.record(false);
    const end = rec.events.findLast((e) => e.type === 'state');
    out.recorded = !!end?.state?.meshing;
    if (out.recorded) end.state.meshing.linearDeflection = 0.3;
    window.showOpenFilePicker = async () => [{ getFile: async () => new File([JSON.stringify(rec)],
      'recording.json') }];
    [...document.querySelectorAll('.lil-gui .controller')].find((c) => c.textContent.trim() === 'Replay recording...')
      .querySelector('button').click();
    out.replayed = await answer('the divergences');
    out.replayStatus = status();
    out.console = consoleSaid;
    return out;
  })()`, { first }) as { after: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const a = r.after, j = JSON.stringify(a);
  expect(!a.error, `the page: ${a.error}`);
  expect(a.notOpened?.error && a.notOpened.title === 'Could not open /content/no-such-model.stp', `not opened: ${j}`);
  expect(a.cleanLoad, `no dialog for a clean load: ${j}`);
  expect(/; 1 selected not found again$/.test(a.lostStatus) && a.lost?.title === 'as1.stp: not found again'
    && a.lost.rows.length === 1 && /^selected: as1\/.+/.test(a.lost.rows[0]), `not found again: ${j}`);
  expect(a.fellBack?.title === 'as1.stp: loaded again' && a.fellBack.text.includes('the models are gone (planted)')
    && !a.fellBack.error, `loaded again: ${j}`);
  expect(/; 1 warning: triangle edges aren't written/.test(a.exportStatus) && a.exported?.title === 'Exported '
    + 'as1.json: 1 warning' && a.exported.rows.join() === "triangle edges aren't written: the formats have no such "
    + 'setting', `export warnings: ${j}`);
  const n = a.replayed?.rows.length ?? 0;
  expect(a.recorded && n > 0 && a.replayStatus.endsWith(`; ${n} divergence${n === 1 ? '' : 's'}`)
    && a.replayed.title === `Replay: ${n} divergence${n === 1 ? '' : 's'}` && a.replayed.error
    && a.replayed.rows.some((x: string) => x.startsWith('the end: meshing is')),
  `replay divergences: ${j}`);
  expect(a.console?.length === 0, `nothing in the console: ${JSON.stringify(a.console)}`);
  return undefined;
});
// STEP ids (step-ids.ts): the problems dialog's Copy error IDs copies its errors' ids (the clipboard stubbed), the
// dialog staying open; Select by ID (Selection) reads what's typed in its dialog: a part's id selects every placement,
// a face's turns the tree's detail on and selects its face nodes, anything else is said; the details panel lists the
// selection's ids, cut short past about 50 characters.
await check('step ids', async () => {
  const copy = (await page(`?url=${encodeURIComponent('/content/broken.stp')}&check=dialogs`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    let copied; navigator.clipboard.writeText = async (t) => { copied = t; };
    await new Promise((r) => setTimeout(r, 200));
    const d = document.querySelector('dialog.cv-dialog');
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent === 'Copy error IDs');
    const rows = [...d.querySelectorAll('.table.errors tr')].map((r) => r.cells[0].textContent);
    b.click();
    await new Promise((r) => setTimeout(r, 100));
    const out = { copied, label: b.textContent, open: d.open, rows };
    d.querySelector('button.primary').click();
    return out;
  })()`) as { after: { copied: string; label: string; open: boolean; rows: string[] } }).after;
  const sel = (await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const m = viewer.nodes;
    const nuts = m.nodes.filter((n) => n.kind === 'part' && partOf(n) === 'nut');
    // (The part's shape representation: a placed part's ids are its NAUO's, its product's, then its part's.)
    const partId = viewer.graph.scene.parts[nuts[0].object.userData.part].sources[0].id;
    const nauo = nuts[0].object.userData.sources[0];
    const face = m.nodes.find((n) => n.kind === 'part' && partOf(n) === 'plate').object.children[0].userData.faces[0];
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
    ui.selectByIds(m.nodes.find((n) => n.kind === 'part' && partOf(n) === 'plate').object.children[0].userData.faces
      .join(' '));
    const all = ui.details().find((l) => l.startsWith('STEP IDs: '));
    // A placement's NAUO selects that placement alone.
    ui.selectByIds('#' + nauo);
    const byNauo = ui.selected();
    return { partId, face, kinds, parts, nuts: nuts.map((n) => n.id).sort(), detailBefore,
      detail: cadViewer.state().tree.detail, lines, status, all, unfolded, byNauo, nut: nuts[0].id };
  })()`) as { after: { partId: number; face: number; kinds: string[]; parts: number[]; nuts: number[];
    detailBefore: boolean; detail: boolean; lines: string[]; status: string; all: string; unfolded: boolean;
    byNauo: number[]; nut: number } })
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
  expect(JSON.stringify(sel.byNauo) === JSON.stringify([sel.nut]), `a NAUO's placement: ${j}`);
  return undefined;
});
// Picks unfold the tree: with every branch folded, two parts picked in the 3D view (the second added, as ctrl-click
// does) are both shown selected in the tree, their branches unfolded.
await check('picks unfold the tree', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const m = viewer.nodes, canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    const centre = (name) => {
      const o = m.nodes.find((n) => n.kind === 'part' && partOf(n) === name).object.children[0];
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
// Selection's buttons in the tree: with every branch folded, Select all, Invert selection, Select parent, Select
// children and Select none each leave every selected node shown, its branches unfolded, and the drawn rows highlighted
// exactly as the selection is (none stale), the tree scrolled to show a selected row. Select children: the assemblies'
// children; a part's nothing while the tree's detail is off (the selection kept, the detail left off), its groups
// (faces, edges, vertices) once it's on, and theirs the faces, edges and vertices. The tree's menu: Select parent and
// Select children on the row right-clicked (not the selection), the rest as the buttons.
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
    ui.select([m.nodes.find((n) => n.kind === 'part' && partOf(n) === 'rod').id]);
    ui.panel().collapseAll();
    press('Select all'); out.all = await look();
    ui.panel().collapseAll();
    ui.select([m.nodes.find((n) => n.kind === 'part' && partOf(n) === 'plate').id]);
    ui.panel().collapseAll();
    press('Invert selection'); out.invert = await look();
    ui.panel().collapseAll();
    press('Select parent'); out.parent = await look();
    const parents = [...ui.selected()];
    ui.panel().collapseAll();
    press('Select children'); out.children = await look();
    out.childrenOk = ui.selected().length > 0 && ui.selected().every((id) => parents.includes(m.nodes[id].parent));
    const part = m.nodes.find((n) => n.kind === 'part').id;
    out.detailBefore = m.hasDetail();
    ui.select([part]);
    press('Select children');
    out.kept = JSON.stringify(ui.selected()) === JSON.stringify([part]) && !m.hasDetail();
    const detail = ui.gui.controllersRecursive().find((c) => c._name === 'Faces, edges, curves, vertices');
    detail.setValue(true);
    detail._callOnFinishChange();
    press('Select children'); out.detail = await look();
    out.kinds = [...new Set(ui.selected().map((id) => m.nodes[id].kind))].sort();
    out.detailAfter = m.hasDetail();
    press('Select children');
    out.items = [...new Set(ui.selected().map((id) => m.nodes[id].kind))].sort();
    press('Select none'); out.none = await look();
    // The menu: on a row not selected, Select parent selects that row's parent; Select children, its children.
    const menu = async (id, choose) => {
      // (Its row in view: a selection of every edge and vertex scrolls far down.)
      ui.panel().scrollToRow(id, 0);
      for (let i = 0; i < 2; i++) await new Promise((res) => requestAnimationFrame(res));
      const row = [...document.querySelectorAll('#tree .tree-row')].find((x) => +x.dataset.id === id);
      const b = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20,
        clientY: b.top + 5 }));
      const items = [...document.querySelectorAll('.cv-menu button')];
      const divided = items.find((x) => x.textContent === 'Select parent')?.classList.contains('divider');
      items.find((x) => x.textContent === choose).click();
      return { divided, selected: [...ui.selected()] };
    };
    // (Something else selected, of another parent, so the selection's parent or children differ.)
    const asm = m.nodes[part].parent;
    const other = m.nodes.find((n) => n.kind === 'part' && n.parent !== asm && n.parent >= 0).id;
    ui.select([other]);
    const mp = await menu(part, 'Select parent');
    out.menuParent = mp.divided && JSON.stringify(mp.selected) === JSON.stringify([asm]);
    ui.select([other]);
    const mc = await menu(asm, 'Select children');
    out.menuChildren = JSON.stringify(mc.selected) === JSON.stringify(m.children(asm));
    out.menuAll = (await menu(part, 'Select all')).selected.length > 1;
    out.menuNone = (await menu(part, 'Select none')).selected.length === 0;
    return out;
  })()`) as { after: Record<string, { selected: number; unfolded: boolean; stale: number; shown: number }> };
  const a = r.after, j = JSON.stringify(a);
  const o = r.after as unknown as Record<string, unknown>;
  for (const k of ['all', 'invert', 'parent', 'children', 'detail']) {
    expect(a[k]!.selected > 0 && a[k]!.unfolded && a[k]!.stale === 0 && a[k]!.shown > 0, `${k}: ${j}`);
  }
  expect(a.none!.selected === 0 && a.none!.stale === 0, `none: ${j}`);
  expect(o.childrenOk === true, `the parents' children: ${j}`);
  expect(o.detailBefore === false && o.kept === true, `a part's children with the detail off: none, the selection `
    + `kept: ${j}`);
  expect(o.detailAfter === true && (o.kinds as string[]).join() === 'edges,faces,vertices' &&
    (o.items as string[]).join() === 'edge,face,vertex', `with it on, its detail's groups, then theirs: ${j}`);
  expect(o.menuParent === true && o.menuChildren === true && o.menuAll === true && o.menuNone === true,
    `the tree's menu: ${j}`);
  return undefined;
});
// Faces that fail to mesh: every part of as1 timed out (a millisecond, the cache emptied; a part OCCT meshes within it
// meshed) comes with its faces' outlines from the file, red, the parts and their faces marked failed in the tree (red,
// a broken icon), the rest not, a click on an
// outline picking its face (the detail level), the details saying so; the bicycle's faces OCCT fails, outlined and
// marked, their parts partly failed.
// The model shown meshed again without a fallback (OCCT's meshes alone): for checks of drawing and picking whose
// numbers were measured on them (the bicycle's parts the fallback meshes with SMLib change its outlines and slivers).
const WITHOUT_FALLBACK = `(async () => {
  await cadViewer.ready; await cadViewer.idle();
  ui.setMeshing({ fallback: 'none' });
  const before = viewer.nextLoad();
  ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
  for (let t = 0; t < 1200 && (viewer.nextLoad() === before || !viewer.model?.meshing); t++) {
    await new Promise((r) => setTimeout(r, 100)); }
  await cadViewer.idle();
})()`;
await check('failed faces', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    await viewer.clearCache();
    ui.setMeshing({ timeout: 0.001 });
    const before = viewer.nextLoad();
    ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.nextLoad() === before || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100)); }
    await cadViewer.idle();
    const m = viewer.nodes, parts = m.nodes.filter((n) => n.kind === 'part');
    const outlines = [];
    viewer.display.traverse((o) => { if (o.name === 'outline') outlines.push(o); });
    // The outlines drawn as nothing in the model, by the alerts over everything, in the alert colour.
    const alertLines = viewer.alerts.group.children;
    const out = { failedCount: viewer.model.parts.failed, total: viewer.model.parts.total, outlines: outlines.length,
      red: outlines.every((o) => o.material.colorWrite === false) && alertLines.length === outlines.length &&
        alertLines.every((o) => o.material.color.getHex() === 0xff0000 && !o.material.depthTest &&
        !o.material.depthWrite),
      partsFailed: parts.filter((n) => m.failure(n.id) === 'failed').length, parts: parts.length,
      // (Placed parts with triangles drawn, the rest.)
      meshed: parts.filter((n) => { let t = false; n.object?.traverse((o) => { t ||= !!o.isMesh
        && (o.geometry.index?.count ?? o.geometry.getAttribute('position')?.count ?? 0) > 0; }); return t; }).length };
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
    // The Alert colour; any node alerted (its lines: a part's edges, curves and outlines), then none but the failed.
    // (Rendering's controls: Alert colour; no Depth offset, its setting 0.)
    const controls = ui.gui.controllersRecursive();
    controls.find((c) => c._name === 'Alert colour').setValue('#00c000');
    out.green = viewer.alerts.line.color.getHex() === 0x00c000 && viewer.alerts.dots.color.getHex() === 0x00c000 &&
      !controls.some((c) => /^Depth offset/.test(c._name)) && viewer.render.depthOffset === 0;
    controls.find((c) => c._name === 'Alert colour').setValue('#ff0000');
    // (Every part may have failed: its outlines alerted again with it.)
    const one = parts.find((n) => m.failure(n.id) !== 'failed') ?? parts[0];
    let lines = 0;
    one.object.traverse((o) => { if (o.isLineSegments) lines++; });
    viewer.alertNodes([one.id]);
    viewer.draw();
    out.alerted = [viewer.alerts.count - outlines.length, lines];
    viewer.alertNodes([]);
    viewer.draw();
    out.cleared = viewer.alerts.count === outlines.length;
    return out;
  })()`) as { after: { failedCount: number; total: number; outlines: number; red: boolean; partsFailed: number;
    parts: number; meshed: number; picked: string[]; row: { failed: boolean; broken: boolean; colour: string } | null;
    details: string[]; green: boolean; alerted: number[]; cleared: boolean } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.total > 0 && a.failedCount > 0 && a.outlines > 0 && a.red, `the failed parts outlined in red: ${j}`);
  expect(a.green && a.alerted[0]! > 0 && a.alerted[0] === a.alerted[1] && a.cleared,
    `the alert colour; a node alerted, then none: ${j}`);
  expect(a.partsFailed > 0 && a.partsFailed + a.meshed === a.parts, `every part not meshed marked failed: ${j}`);
  expect(a.picked.length === 1 && a.picked[0] === 'face:failed', `an outline picks its face: ${j}`);
  // (Red in either theme: #d32f2f light, #ff6b6b dark, as the system prefers.)
  const [red, green, blue] = (a.row?.colour.match(/\d+/g) ?? []).map(Number);
  expect(!!a.row?.failed && a.row.broken && red! >= 200 && red! - Math.max(green!, blue!) >= 80,
    `its row red, a broken icon: ${j}`);
  expect(a.details.some((l) => /Failed to mesh: its outline is drawn in red/.test(l)), `the details: ${j}`);
  const b = (await page(`?url=${encodeURIComponent('/content/bicycle.stp')}&check`, `(async () => {
    await ${WITHOUT_FALLBACK};
    const m = viewer.nodes, parts = m.nodes.filter((n) => n.kind === 'part');
    let outlines = 0;
    viewer.display.traverse((o) => { if (o.name === 'outline') outlines++; });
    const partly = parts.filter((n) => m.failure(n.id) === 'partly');
    ui.setTree({ detail: true });
    // (Each partly failed part has a face that failed: wholly, red, or partly, short of its area. Its faces in its
    // faces group.)
    const facesOf = (id) => m.children(id).filter((g) => m.nodes[g].kind === 'faces').flatMap((g) => m.children(g));
    const faces = partly.flatMap((n) => facesOf(n.id)).map((c) => m.failure(c)).filter((f) => f);
    // Rows that failed partly red too, with the broken icon: a partly failed part's, and a face of it short of its
    // area, each selected (so revealed and drawn).
    const shortFace = partly.flatMap((n) => facesOf(n.id)).find((c) => m.failure(c) === 'partly');
    const rows = [];
    for (const id of [partly[0].id, ...(shortFace === undefined ? [] : [shortFace])]) {
      ui.select([id]);
      for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
      const row = document.querySelector('.tree-row.selected');
      rows.push(!!row && row.classList.contains('failed') && !!row.querySelector('.tree-icon.broken'));
    }
    const rowsRed = rows.filter((x) => x).length;
    // The outlines drawn red by the alerts over everything (the black edges along the same B-rep edges, the faces in
    // front), thin and fat: each outline seen close, the pixels at its segments' midpoints read back.
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
  // Red at the outlines' midpoints (OCCT's meshes, its measures replaced by the area oracle's where they disagree):
  // over everything, 2,005 thin and 2,006 fat of 2,011, none black (a few midpoints off the view's pixels).
  expect(b.fat.all > 1000 && b.fat.red >= 0.99 * b.fat.all && b.thin.red >= 0.99 * b.thin.all && b.fat.black === 0 &&
    b.thin.black === 0, `outlines not drawn over everything: ${JSON.stringify({ thin: b.thin, fat: b.fat })}`);
  return undefined;
});
// B-Rep Meshing's Timeout: a limit too short for most parts (a millisecond) fails them, timed out (said in the
// diagnostics; the cache on, emptied first); then 60 s and Mesh again meshes them all, the cache's timeouts not
// answering for a longer limit. The model's meshedWith has the timeout.
await check('meshing timeout', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const again = async () => {
      const before = viewer.nextLoad();
      ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
      for (let t = 0; t < 1200 && (viewer.nextLoad() === before || !viewer.model?.meshing); t++) {
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
  // (A part OCCT meshes within the millisecond meshes.)
  expect(short.parts.total > 0 && short.parts.failed > 0 && short.timedOut >= short.parts.failed &&
    short.timeout === 0.001, `a millisecond: the parts it failed timed out: ${j}`);
  expect(long.parts.failed === 0 && long.parts.done === long.parts.total && long.timedOut === 0 &&
    long.timeout === 60, `60 s: every part meshed again: ${j}`);
  return undefined;
});
// STEP's tessellated geometry: read and drawn as it is, nothing meshed, faces by STEP id and edges shared between them;
// a B-rep's tessellation shown, then replaced by OCCT's mesh (not drawn beside it), kept when meshing fails (a
// millisecond's timeout).
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
      const before = viewer.nextLoad();
      ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
      for (let t = 0; t < 1200 && (viewer.nextLoad() === before || !viewer.model?.meshing); t++) {
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
    return { first, failed };
  })()`) as { after: Record<string, { parts: { total: number; done: number; failed: number }; triangles: number }> };
  const { first, failed } = r.after, j = JSON.stringify(r.after);
  expect(first!.parts.total === 1 && first!.parts.failed === 0 && first!.triangles === 12,
    `the cube meshed: OCCT's 12 triangles in place of the file's 2: ${j}`);
  expect(failed!.parts.failed === 1 && failed!.triangles === 2, `meshing failed: the file's 2 triangles kept: ${j}`);
  return undefined;
});
// Two planes (a cap missing where another plane cuts): the plate cut across X through its middle (the side above cut
// away) and across Z through its middle, flipped (the side below cut away), seen from +X -Y +Z. On the X cap above the
// Z plane, the plate's far side along the view lies below it, cut away: the stencil passes counting it must be clipped
// by their own plane only, or the X cap isn't drawn there.
await check('two planes', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const plate = ui.panel().model.nodes.find((n) => n.kind === 'part' && partOf(n) === 'plate').object.children[0];
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
      await settled();
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
// thinner than a pixel may be drawn where the ray misses them (at most 2% of the points). In an earlier version any
// part's edge within 4 pixels beat the face under the point: 27 of 860 points on parts wrong on as1, 39 of 171 on the
// bicycle (measured with a 1200 x 800 window). Everywhere, on parts or off, a line or point picked must be within reach
// on the screen (4 pixels, pick.ts, and half a pixel for the sample's centre): under a scaled parent (a STEP file in
// metres, or any glTF, scaled by the display transform) three.js's thresholds reached 1000 times too far, so a click in
// empty space picked the nearest part's edges, which the check, on parts only and on files in millimetres, didn't see;
// a part in metres is checked too since (our GLB doesn't show it: its millimetre meshes sit under a root scaling by
// 0.001, which the display transform undoes, so lines are at a world scale of 1).
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
    const oracle = file === 'bicycle.stp' ? `(async () => { await ${WITHOUT_FALLBACK}; return ${PICK_ORACLE}; })()`
      : PICK_ORACLE;
    const r = await page(`?url=${encodeURIComponent(`/content/${file}`)}&check`,
      wide ? `(viewer.zoomAll(), ${oracle})` : oracle, wide ? { scale: 1 } : {}) as
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
    // Screenshot...'s model width with the tree over the view: starting right of the tree.
    const shotWidth = await evaluate(sessionId, `(async () => {
      const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
      const shot = ui.gui.controllersRecursive().find((c) => c._name === 'Screenshot...');
      const done = shot.getValue().call(shot.object);
      let d;
      for (let i = 0; i < 100 && !(d = document.querySelector('dialog.cv-dialog')); i++) await frame();
      const w = +d.querySelector('input[type=number]').value, what = d.querySelectorAll('select')[1].value;
      d.querySelector('button[value=cancel]').click();
      await done;
      const c = viewer.modelCircle(), cv = viewer.renderer.domElement.getBoundingClientRect();
      const side = document.getElementById('side').getBoundingClientRect().right;
      const g = ui.gui.domElement.getBoundingClientRect().left;
      const left = Math.max(cv.left, side, c.x - c.r), right = Math.min(cv.right, g > left ? g : cv.right, c.x + c.r);
      return { w, what, side, from: c.x - c.r, expected: Math.round(right) - Math.round(left) };
    })()`) as { w: number; what: string; side: number; from: number; expected: number };
    // A width set where it fit (as before turning the phone upright): capped at 40 pixels from the window's edge.
    // (The remembered width forgotten again: later pages share this browser's storage.)
    const wide = await evaluate(sessionId, `(document.documentElement.style.setProperty('--side', '500px'),
      localStorage.removeItem('cad-viewer.side'), document.getElementById('side').getBoundingClientRect().width)`) as
      number;
    // Override Appearance... on a touch screen: the panel itself focused, not Visibility, whose picker iOS would open.
    const focus = await evaluate(sessionId, `(async () => {
      const row = document.querySelector('#tree .tree-row');
      const b = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20,
        clientY: b.top + 5 }));
      [...document.querySelectorAll('.cv-menu button')].find((x) => x.textContent === 'Override Appearance...')
        .click();
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
      const d = document.querySelector('dialog.cv-dialog.floating');
      const out = { panel: !!d && document.activeElement === d, select: document.activeElement?.tagName === 'SELECT' };
      d?.querySelector('button')?.click();
      return out;
    })()`) as { panel: boolean; select: boolean };
    return { selected, opened, dragged, wide, focus, shotWidth };
  } }) as { after?: { treeClosed: boolean; guiClosed: boolean; overscroll: string; touch: number; handle: string;
    workers: number; spot?: { id: number; x: number; y: number }; triangles: number; edgeStyle: string;
    device: { detected: string; used: string; profile: string } }; then?: { selected: number[];
    opened: { side: number; handle: number; saved: string | null }; dragged: { side: number; saved: string | null };
    wide: number; focus: { panel: boolean; select: boolean };
    shotWidth: { w: number; what: string; side: number; from: number; expected: number } } };
  const a = r.after!;
  const j = JSON.stringify(a);
  expect(a.treeClosed && a.guiClosed, `closed at first: ${j}`);
  const sw = r.then?.shotWidth;
  expect(!!sw && sw.what === 'model' && sw.from < sw.side && Math.abs(sw.w - sw.expected) <= 1,
    `Screenshot...'s model width beside the tree over the view: ${JSON.stringify(sw)}`);
  expect(r.then?.focus.panel === true && !r.then.focus.select, `Override Appearance's focus on a touch screen: ${
    JSON.stringify(r.then?.focus)}`);
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
// The model worker, the only way STEP files load (the page has no tessellation of its own); every folder of the
// controls closed at first; Zoom selected in View, enabled only with a selection; Mesh again (at another deflection,
// the cache off) keeps the camera, a cut, what's hidden and what's selected, the tree's expansion (detail
// on, all expanded but one assembly) and the row at its top (scrolled partway), and meshes anew; meshed again
// once more with the selected node not coming back (simulated: its path not found), the status line says so (the
// hidden one's override stays on its node, meshed again in place).
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
    const model = viewer.nextLoad();
    c('Mesh again').getValue().call(c('Mesh again').object);
    for (let t = 0; t < 600 && (viewer.nextLoad() === model || !viewer.model?.meshing); t++) {
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
    const model = viewer.nextLoad();
    viewer.settings.cache = false;
    viewer.settings.profile = 'custom';
    viewer.settings.linearDeflection = 1;
    button('Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.nextLoad() === model || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cadViewer.idle();
    const after = cadViewer.state();
    const trianglesAfter = viewer.stats().triangles;
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
    const again = viewer.nextLoad();
    try {
      button('Mesh again').$button.click();
      for (let t = 0; t < 1200 && (viewer.nextLoad() === again || !viewer.model?.meshing); t++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await cadViewer.idle();
    } finally {
      proto.find = find;
    }
    const lost = { status: document.getElementById('status').textContent,
      notRestored: JSON.parse(document.body.dataset.report).notRestored, paths: lostPaths };
    // A face selected: after meshing again, its overlay is on the face's new mesh, sharing that mesh's positions.
    // (A face's parent its part's faces group: the part above that.)
    const face = viewer.nodes.nodes.find((n) => n.face && !n.dead &&
      viewer.nodes.nodes[viewer.nodes.nodes[n.parent].parent].object.children[0]?.geometry);
    const facePath = viewer.nodes.pathOf(face.id);
    ui.select([face.id]);
    const faceModel = viewer.nextLoad();
    viewer.settings.linearDeflection = 0.5;
    button('Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.nextLoad() === faceModel || !viewer.model?.meshing); t++) {
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
      triangles: [triangles, trianglesAfter], zoomAfter, lost, tree: [treeBefore, treeAfter],
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
  expect(/^occt\+smlib /.test(a.backend ?? '') && !a.pageTessellation, `the model worker: ${j}`);
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
  // (Meshed again in place: the overrides stay on their nodes, never looked for by path; a selection is.)
  expect(/; 1 selected not found again$/.test(l.status) &&
    l.notRestored?.overrides.length === 0 && l.notRestored?.selected.join() === l.paths[1],
    `not found again: ${JSON.stringify(l)}`);
  return undefined;
});
// Healing in the browser (cad-heal and cad-geom's module in the tessellation pool's workers, as Vite bundles them):
// heal=1 in the address heals before meshing (its warnings the model's, its settings in meshedWith); Heal B-reps
// unticked and Mesh again, the models put back as imported in place (but the moved pole, said kept); healOff= a fix
// off; without heal=, HEAL_BY_DEFAULT; the checkbox and its closed fixes folder.
await check('heal B-reps', async () => {
  const healingSaid = `(() => viewer.model.diagnostics.filter((d) => /^(strayPole|tolerances grown):/.test(d.message))
    .map((d) => d.message.split(':')[0]).sort())()`;
  const again = `(async () => {
    const model = viewer.nextLoad();
    ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.nextLoad() === model || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cadViewer.idle();
  })`;
  const r = await page(`?url=${encodeURIComponent('/content/heal.stp')}&heal=1&check`, `(async () => {
    await cadViewer.idle();
    const said = ${healingSaid}, triangles = viewer.stats().triangles;
    const heal = ui.gui.controllersRecursive().find((c) => c._name === 'Heal B-reps');
    const folder = ui.gui.foldersRecursive().find((f) => f._title === 'Healing fixes');
    const fixes = folder.controllers.map((c) => c._name);
    const meshedWith = viewer.model.meshedWith, parts = viewer.model.parts;
    heal.setValue(false);
    await ${again}();
    const off = { said: ${healingSaid}, heal: viewer.model.meshedWith.heal, triangles: viewer.stats().triangles };
    return { said, triangles, checked: heal.getValue(), closed: folder._closed, fixes, meshedWith, parts, off,
      backend: viewer.model.meshing?.backend };
  })()`) as { after: { said: string[]; triangles: number; closed: boolean; fixes: string[];
    meshedWith: { heal: boolean; healFixes: Record<string, boolean> }; parts: { total: number; failed: number };
    off: { said: string[]; heal: boolean; triangles: number }; backend?: string } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.said.join() === 'strayPole,tolerances grown', `healed, in the workers: ${j}`);
  expect(a.meshedWith.heal && a.meshedWith.healFixes.strayPole === true
    && !a.meshedWith.healFixes.pcurveMissingOnFreeForm, `meshed with healing: ${j}`);
  expect(a.triangles > 0 && a.parts.total === 4 && a.parts.failed === 0, `meshed: ${j}`);
  expect(a.closed && a.fixes.join() === 'strayPole,pcurveMissingOnPlane,pcurveMissingOnElementary,'
    + 'pcurveMissingOnFreeForm,pcurveReparam,pcurveReplace,pcurveEnds,edgeTolerance,vertexTolerance,orientShells,'
    + 'pcurveTight,Fit (mm)',
    `the fixes and the fit, closed: ${j}`);
  expect(a.off.said.join() === 'strayPole' && !a.off.heal && a.off.triangles > 0,
    `unticked, meshed again as imported in place (the moved pole said kept): ${j}`);
  const f = await page(`?url=${encodeURIComponent('/content/heal.stp')}&healOff=strayPole&check`, `(async () => {
    await cadViewer.idle();
    return { said: ${healingSaid}, heal: viewer.settings.heal, fix: viewer.settings.healFixes.strayPole };
  })()`) as { after: { said: string[]; heal: boolean; fix: boolean } };
  expect(f.after.said.join() === 'tolerances grown' && f.after.heal && !f.after.fix, `healOff=strayPole: ${
    JSON.stringify(f.after)}`);
  const d = await page(`?url=${encodeURIComponent('/content/heal.stp')}&check`, `(async () => {
    await cadViewer.idle();
    return { said: ${healingSaid}, heal: viewer.settings.heal };
  })()`, { healDefault: true }) as { after: { said: string[]; heal: boolean } };
  expect(d.after.heal === HEAL_BY_DEFAULT && (d.after.said.length > 0) === HEAL_BY_DEFAULT, `the default: ${
    JSON.stringify(d.after)}`);
  return undefined;
});

// Mesh again with other healing heals again in place: no question, the file not fetched again, the same scene (the
// model worker's models healed again from their analyses' source values), the view and the selection kept; unticked,
// the models put back as imported, but heal.stp's stray pole, which stays moved, said kept; ticked again, healed as at
// first. The page keeps no copy of the file: the source has its size and SHA-256 only. Recorded and replayed in
// another page: the same end, nothing diverging.
await check('re-heal in place', async () => {
  const healingSaid = `(() => viewer.model.diagnostics.filter((d) => /^(strayPole|tolerances grown):/.test(d.message))
    .map((d) => d.message.replace(/\\d+/g, 'N')).sort())()`;
  const r = await page(`?url=${encodeURIComponent('/content/heal.stp')}&heal=1&check`, `(async () => {
    await cadViewer.idle();
    // The file's fetches from now on, counted (the page's resource timing buffer is full of the dev server's modules).
    const url = new URL('/content/heal.stp', location.href).href, fetchWas = window.fetch;
    let fetched = 0;
    window.fetch = (u, o) => {
      if (new URL(String(u), location.href).href === url) fetched++;
      return fetchWas(u, o);
    };
    const warned = [], warn = console.warn;
    console.warn = (...a) => { warned.push(String(a[0])); warn(...a); };
    const open = () => document.querySelector('dialog.cv-dialog[open]');
    const button = ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again');
    const heal = ui.gui.controllersRecursive().find((c) => c._name === 'Heal B-reps');
    // Pressed (asked or not, within a second: a dialog open then would be the question); then its work done.
    const press = async () => {
      const done = button.getValue().call(button.object);
      let asked = false;
      for (let t = 0; t < 20 && !asked; t++) asked = !!open(), await new Promise((res) => setTimeout(res, 50));
      await done;
      await cadViewer.idle();
      return { asked };
    };
    const src = ui.source();
    const kept = { bytes: src.bytes === undefined, sha: /^[0-9a-f]{64}$/.test(src.sha256), size: src.size };
    const graph0 = viewer.graph, first = { said: ${healingSaid}, triangles: viewer.stats().triangles };
    // A part selected, the view moved: both kept.
    const part = viewer.nodes.find('heal.stp/stray') ?? viewer.nodes.find(viewer.nodes.pathOf(1));
    ui.select([part]);
    const path = viewer.nodes.pathOf(part);
    viewer.controls.target.set(1, 2, 3);
    viewer.controls.update();
    heal.setValue(false);
    const off = { ...await press(), heal: viewer.model.meshedWith.heal, same: viewer.graph === graph0,
      said: ${healingSaid}, fetched, triangles: viewer.stats().triangles,
      selected: ui.selected().map((id) => viewer.nodes.pathOf(id)), target: viewer.controls.target.toArray() };
    heal.setValue(true);
    const on = { ...await press(), heal: viewer.model.meshedWith.heal, same: viewer.graph === graph0,
      said: ${healingSaid}, fetched, triangles: viewer.stats().triangles };
    return { kept, first, off, on, warned, path, bytes: ui.source().bytes === undefined };
  })()`) as { after: { kept: { bytes: boolean; sha: boolean; size: number }; first: { said: string[];
    triangles: number }; off: { asked: boolean; heal: boolean; same: boolean; said: string[]; fetched: number;
    triangles: number; selected: string[]; target: number[] }; on: { asked: boolean; heal: boolean; same: boolean;
    said: string[]; fetched: number; triangles: number }; warned: string[]; path: string; bytes: boolean } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.kept.bytes && a.kept.sha && a.kept.size === fs.statSync(path.join(content, 'heal.stp')).size && a.bytes,
    `no copy of the file kept, its size and SHA-256: ${j}`);
  const kept = 'strayPole: N stray poles moved by an earlier healing kept';
  const grown = a.first.said.find((x) => x.startsWith('tolerances grown: '));
  expect(a.first.said.length === 2 && a.first.said[0]!.startsWith('strayPole: N poles of N curves moved') && !!grown,
    `healed at first: ${j}`);
  expect(!a.off.asked && !a.off.heal && a.off.same && a.off.fetched === 0 && a.off.triangles > 0
    && a.off.said.join() === kept,
    `unticked: in place, nothing asked or fetched, as imported but the pole, said kept: ${j}`);
  expect(a.off.selected.join() === a.path && a.off.target.join() === '1,2,3', `the selection and the view kept: ${j}`);
  expect(!a.on.asked && a.on.heal && a.on.same && a.on.fetched === 0 && a.on.triangles === a.first.triangles
    && a.on.said.join() === [kept, grown].join(),
    `ticked again: healed in place as at first, the pole said kept: ${j}`);
  expect(!a.warned.some((w) => /meshing again from the models failed/.test(w)), `nothing failed in place: ${j}`);
  // Recorded (unticked, Mesh again; ticked, Mesh again) and replayed in another page (heal=1): the same end.
  const rec = await page(`?url=${encodeURIComponent('/content/heal.stp')}&heal=1&check`, `(async () => {
    await cadViewer.idle();
    const button = ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again');
    cadViewer.record(true);
    // (Clicked as a user does: a change by setValue isn't a recorded one.)
    for (let k = 0; k < 2; k++) {
      ui.gui.controllersRecursive().find((c) => c._name === 'Heal B-reps').$input.click();
      button.$button.click();
      await new Promise((res) => setTimeout(res, 200));
      await ui.opened();
      await cadViewer.idle();
    }
    const r = cadViewer.record(false);
    return { rec: r, events: r.events.filter((e) => e.type === 'control').map((e) => /Mesh again/.test(e.path)
      ? 'press' : e.path + '=' + e.value), triangles: viewer.stats().triangles };
  })()`) as { after: { rec: unknown; events: string[]; triangles: number } };
  expect(rec.after.events.join() === 'B-Rep Meshing/Heal B-reps=false,press,B-Rep Meshing/Heal B-reps=true,press',
    `recorded: ${JSON.stringify(rec.after.events)}`);
  const played = await page(`?url=${encodeURIComponent('/content/heal.stp')}&heal=1&check`, `(async () => {
    await cadViewer.idle();
    const report = await cadViewer.replay(${JSON.stringify(rec.after.rec)});
    await cadViewer.idle();
    return { aborted: report.aborted, open: !!document.querySelector('dialog.cv-dialog[open]'),
      heal: viewer.model.meshedWith.heal, control: viewer.settings.heal, triangles: viewer.stats().triangles,
      divergences: report.divergences };
  })()`) as { after: { aborted?: string; open: boolean; heal: boolean; control: boolean; triangles: number;
    divergences: string[] } };
  expect(!played.after.aborted && !played.after.open && played.after.heal && played.after.control
    && played.after.triangles === rec.after.triangles && !played.after.divergences.length,
    `replayed: ${JSON.stringify(played.after)}`);
  return undefined;
});

// Mesh again's fallback (the model worker can't mesh in place: here its meshAgain made to reject, as when the worker
// lost the model) after the file changed on the server (a line more): the file fetched again once, loaded as it is
// now, said in the status line, its size the new one; the view kept.
await check('reload changed file', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/heal.stp')}&check`, `(async () => {
    await cadViewer.idle();
    const url = new URL('/content/heal.stp', location.href).href, fetchWas = window.fetch;
    const bytes = new Uint8Array(await (await fetchWas(url)).arrayBuffer());
    const more = new Uint8Array(bytes.length + 1);
    more.set(bytes);
    more[bytes.length] = 10;
    let fetched = 0;
    window.fetch = async (u, o) => {
      if (new URL(String(u), location.href).href !== url) return fetchWas(u, o);
      fetched++;
      return new Response(more);
    };
    const size0 = ui.source().size, graph0 = viewer.graph;
    viewer.controls.target.set(1, 2, 3);
    viewer.controls.update();
    viewer.meshAgain = async () => { throw new Error('the worker lost the model (planted)'); };
    const statuses = [], st = document.getElementById('status');
    new MutationObserver(() => statuses.push(st.textContent)).observe(st, { childList: true, characterData: true,
      subtree: true });
    const button = ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again');
    await button.getValue().call(button.object);
    await cadViewer.idle();
    return { fetched, size0, size: ui.source().size, same: viewer.graph === graph0, status: statuses.join(' | '),
      triangles: viewer.stats().triangles, target: viewer.controls.target.toArray(),
      open: !!document.querySelector('dialog.cv-dialog[open]') };
  })()`) as { after: { fetched: number; size0: number; size: number; same: boolean; status: string;
    triangles: number; target: number[]; open: boolean } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.fetched === 1 && a.size === a.size0 + 1 && !a.same && a.triangles > 0 && !a.open,
    `loaded again, fetched once, as it is now: ${j}`);
  expect(/the file had changed since it was loaded: meshed as it is now/.test(a.status), `said: ${j}`);
  expect(a.target.join() === '1,2,3', `the view kept: ${j}`);
  return undefined;
});

// Healing's pcurveMissing fixes in the browser, the switches for consumers that want every p-curve (on planes, on
// elementary surfaces, on free-form ones): healOn=<fix> on a file whose bare uses are all within tolerance makes a
// p-curve for each of that fix's (said in its diagnostic, the fix on in meshedWith and its checkbox ticked), and only
// that fix's; healOn=pcurveMissing (the alias of the elementary and free-form ones, for older links) both; heal=1
// alone makes none (a correct bare use stays bare). healFit= sets the fit tolerance: its field and meshedWith.
await check('heal pcurveMissing', async () => {
  const FIXES = ['pcurveMissingOnPlane', 'pcurveMissingOnElementary', 'pcurveMissingOnFreeForm'];
  const load = (query: string) => page(`?url=${encodeURIComponent('/content/bare-edges.stp')}&heal=1${query}&check`,
    `(async () => {
    await cadViewer.idle();
    const box = (f) => ui.gui.controllersRecursive().find((c) => c._name === f)?.getValue();
    const made = (fix) => viewer.model.diagnostics.map((d) => new RegExp('^' + fix + ': (\\\\d+) p-curves made')
      .exec(d.message)).filter(Boolean).map((m) => Number(m[1]));
    const fixes = ${JSON.stringify(FIXES)}, w = viewer.model.meshedWith;
    return { made: fixes.map(made), fixes: fixes.map((f) => w.healFixes[f]), boxes: fixes.map(box),
      fit: w.healFit, fitBox: box('Fit (mm)') };
  })()`) as Promise<{ after: { made: number[][]; fixes: boolean[]; boxes: boolean[]; fit: number; fitBox: number } }>;
  const runs = { plane: await load('&healOn=pcurveMissingOnPlane'), free: await load('&healOn=pcurveMissingOnFreeForm'),
    alias: await load('&healOn=pcurveMissing'), none: await load('&healFit=0.01') };
  const j = JSON.stringify(Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.after])));
  const { plane, free, alias, none } = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.after]));
  const one = (r: typeof plane, i: number) => r!.made.every((m, k) => k === i ? m.length === 1 && m[0]! > 0 : k === 1
    || m.length === 0);
  expect(one(plane, 0) && plane!.fixes.join() === 'true,false,false' && plane!.boxes.join() === 'true,false,false',
    `healOn=pcurveMissingOnPlane: on the planes only, its checkbox ticked: ${j}`);
  expect(one(free, 2) && free!.fixes.join() === 'false,false,true' && free!.boxes.join() === 'false,false,true',
    `healOn=pcurveMissingOnFreeForm: on free-form surfaces only, its checkbox ticked: ${j}`);
  expect(alias!.made[2]!.join() === free!.made[2]!.join() && alias!.made[0]!.length === 0
    && alias!.fixes.join() === 'false,true,true' && alias!.boxes.join() === 'false,true,true',
    `healOn=pcurveMissing: the elementary and free-form ones: ${j}`);
  expect(none!.made.every((m) => m.length === 0) && none!.fixes.join() === 'false,false,false' && none!.fit === 0.01
    && none!.fitBox === 0.01, `heal=1 alone (healFit=0.01): none made, the fit in its field and meshedWith: ${j}`);
  process.stderr.write(` (pcurveMissingOnFreeForm ${free!.made[2]![0]} p-curves made, pcurveMissingOnPlane `
    + `${plane!.made[0]![0]})`);
  return undefined;
});
// Our own tessellator in the browser (tess-cadio's module in the pool's workers, as Vite bundles it): the assembly
// with backend=cadio and no fallback, its triangles those it gives here in Node, at the controls' default min angle and
// at 0 (fewer, the request's minAngle) after Mesh again, in meshedWith; the controls, closed; healing in the same
// workers before cadio meshes, on (heal.stp's fixes said) and off; keepFailing=1, a face that cadio fails by
// construction (conical-surface's #77 at a deflection of 1.2e-6 mm, past its point cap, set in the page: the address
// sets no deflection)
// meshed then (cadio given KEEP_FAILING), its pool's meshes not cached (no lookups, though the assembly's are cached
// from above), the backend saying so; minAngle= ignored with another backend, said.
await check('tess-cadio', async () => {
  const placedTriangles = async (minAngle?: number) => {
    const { scene: s } = await importStep(fs.readFileSync(step));
    const t = new CadioTessellator();
    await t.init();
    const { meshes } = await tessellateScene(s, new StepTessellator(t), minAngle === undefined ? {} : { minAngle });
    t.dispose();
    const at = [...partInstances(s)].filter((p) => p.visible);
    return [...meshes].reduce((n, [part, m]) => n + at.filter((p) => p.part === part).length * m.indices.length / 3,
      0);
  };
  const [plain, none] = [await placedTriangles(), await placedTriangles(0)];
  const again = `(async () => {
    const model = viewer.nextLoad();
    ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.nextLoad() === model || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cadViewer.idle();
  })`;
  const said = `(() => viewer.model.diagnostics.filter((d) => /^(strayPole|tolerances grown):/.test(d.message))
    .map((d) => d.message.split(':')[0]).sort())()`;
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&backend=cadio&fallback=none&check`,
    `(async () => {
    await cadViewer.idle();
    const folder = ui.gui.foldersRecursive().find((f) => f._title === 'tess-cadio');
    const debug = folder.foldersRecursive().find((f) => f._title === 'Debugging');
    const first = { triangles: viewer.stats().triangles, parts: viewer.model.parts, meshing: viewer.model.meshing,
      meshedWith: viewer.model.meshedWith, closed: folder._closed, debugClosed: debug._closed,
      controls: folder.controllersRecursive().map((c) => [c._name, c.getValue()]) };
    folder.controllersRecursive().find((c) => c._name === 'Min angle (degrees)').setValue(0);
    await ${again}();
    const zero = { triangles: viewer.stats().triangles, parts: viewer.model.parts,
      minAngle: viewer.model.meshedWith.minAngle };
    // The debugging switch ticked in the page: a pool of its own, its backend saying so.
    debug.controllers.find((c) => c._name === 'Keep faces that would fail').setValue(true);
    await ${again}();
    return { first, zero, kept: { backend: viewer.model.meshing.backend, keep: viewer.model.meshedWith.keepFailing } };
  })()`) as { after: { first: { triangles: number; parts: { done: number; failed: number };
    meshing: { backend: string }; meshedWith: { backend: string; fallback: string; minAngle: number;
      keepFailing: boolean }; closed: boolean; debugClosed: boolean; controls: [string, unknown][] };
    zero: { triangles: number; parts: { done: number; failed: number }; minAngle: number };
    kept: { backend: string; keep: boolean } } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.first.meshing.backend.startsWith('tess-cadio ') && !a.first.meshing.backend.includes('debugging'),
    `the backend: ${j}`);
  expect(a.first.parts.done === 5 && a.first.parts.failed === 0, `meshed: ${j}`);
  expect(a.first.triangles === plain, `${a.first.triangles} triangles, expected ${plain} (Node's): ${j}`);
  expect(a.first.meshedWith.backend === 'cadio' && a.first.meshedWith.fallback === 'none'
    && a.first.meshedWith.minAngle === 10 && !a.first.meshedWith.keepFailing, `meshedWith: ${j}`);
  expect(a.first.closed && a.first.debugClosed && JSON.stringify(a.first.controls)
    === '[["Min angle (degrees)",10],["Keep faces that would fail",false]]', `the controls: ${j}`);
  expect(none < plain && a.zero.triangles === none && a.zero.parts.failed === 0 && a.zero.minAngle === 0,
    `min angle 0: ${a.zero.triangles} triangles, expected ${none}: ${j}`);
  expect(a.kept.keep && a.kept.backend.endsWith('(debugging: tess-cadio keeps the faces it would fail)'),
    `Keep faces that would fail, ticked: ${j}`);
  // Healing in the same workers, before cadio meshes; and without it.
  for (const heal of ['1', '0']) {
    const h = await page(`?url=${encodeURIComponent('/content/heal.stp')}&backend=cadio&heal=${heal}&check`,
      `(async () => {
      await cadViewer.idle();
      return { said: ${said}, parts: viewer.model.parts, backend: viewer.model.meshing.backend,
        heal: viewer.model.meshedWith.heal, triangles: viewer.stats().triangles };
    })()`) as { after: { said: string[]; parts: { total: number; failed: number }; backend: string; heal: boolean;
      triangles: number } };
    const b = h.after, k = JSON.stringify(b);
    expect(b.backend.startsWith('tess-cadio+') && b.parts.total === 4 && b.triangles > 0, `heal=${heal}: ${k}`);
    expect(heal === '1' ? b.heal && b.said.join() === 'strayPole,tolerances grown' : !b.heal && !b.said.length,
      `heal=${heal}: ${k}`);
  }
  // Debugging: the faces that would fail kept (KEEP_FAILING), not cached; its backend saying so.
  const d = await page(`?url=${encodeURIComponent('/content/as1.stp')}&backend=cadio&keepFailing=1&check`,
    `(async () => {
    await cadViewer.idle();
    return { meshing: viewer.model.meshing, cache: viewer.settings.cache, keep: viewer.model.meshedWith.keepFailing,
      triangles: viewer.stats().triangles };
  })()`) as { after: { meshing: { backend: string; cache?: { misses: number; hits: number } }; cache: boolean;
    keep: boolean; triangles: number } };
  const e = d.after, l = JSON.stringify(e);
  expect(Object.keys(KEEP_FAILING).length === 3 && e.keep && e.cache && e.triangles > 0, `keepFailing=1: ${l}`);
  expect(e.meshing.backend.startsWith('tess-cadio+smlib ') && e.meshing.backend.endsWith(
    '(debugging: tess-cadio keeps the faces it would fail)'), `keepFailing=1, the backend: ${l}`);
  // (Its fallback, SMLib, cached; cadio's pool not: as1 meshed by cadio alone, so no lookups at all.)
  expect(!e.meshing.cache || (e.meshing.cache.misses === 0 && e.meshing.cache.hits === 0),
    `keepFailing=1, cadio cached: ${l}`);
  for (const keep of ['0', '1']) {
    const f = await page(`?backend=cadio&fallback=none&keepFailing=${keep}&check`, `(async () => {
      await cadViewer.ready;
      ui.setMeshing({ profile: 'custom', linearDeflection: 1.2e-6 });
      await ui.openUrl('/content/conical-surface.step');
      await cadViewer.idle();
      return { parts: viewer.model.parts, errors: viewer.model.diagnostics.filter((d) => d.severity === 'error')
        .map((d) => d.message), deflection: viewer.model.meshedWith.linearDeflection,
        kept: viewer.model.diagnostics.filter((d) => d.message.startsWith('faces kept with defects: '))
          .map((d) => d.message) };
    })()`) as { after: { parts: { total: number; done: number; failed: number }; errors: string[];
      deflection: number; kept: string[] } };
    const g = f.after, m = JSON.stringify(g);
    // (At its point cap: kept with its defect said by default, keepDefects; kept as it is, unjudged, keepFailing=1.)
    expect(g.deflection === 1.2e-6 && !g.errors.some((x) => /failed to mesh/.test(x)) && (keep === '1'
      || (g.kept.length === 1 && g.kept[0]!.includes('#77'))), `conical-surface at 1.2e-6, keepFailing=${keep}: ${m}`);
  }
  const o = await page(`?url=${encodeURIComponent('/content/as1.stp')}&minAngle=5&check`, `(async () => {
    await cadViewer.idle();
    // (The address's problems are said once its model has loaded.)
    const text = () => document.getElementById('status').textContent;
    for (let t = 0; t < 100 && !text().includes('the address'); t++) await new Promise((r) => setTimeout(r, 100));
    return { status: text(), minAngle: viewer.settings.minAngle };
  })()`) as { after: { status: string; minAngle: number } };
  expect(o.after.minAngle === 10 && o.after.status.includes('minAngle: only tess-cadio'),
    `minAngle= with OCCT: ${JSON.stringify(o.after)}`);
  return undefined;
});
// File's Link to this view... (link-dialog.ts): a modal with Include device defaults (off by default, remembered in
// this browser), the link in a one-line box that can be selected and scrolls sideways, and Copy (the clipboard
// stubbed), the dialog left open. Off, a link leaves out what is the device's default (a desktop's medium profile and
// fat edges; a phone's link says its thin edges, which aren't the desktop's, but not its coarse profile); on, profile=
// and edgeStyle= are always in it, a custom profile by its deflections; the box follows the option. Not in View any
// more. (Pages share the browser's storage: left off at the end, as the other checks expect.)
await check('link to this view', async () => {
  const look = `(async () => {
    await cadViewer.idle();
    let copied;
    navigator.clipboard.writeText = async (t) => { copied = t; };
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const control = (path) => ui.gui.controllersRecursive().find((c) => c.parent._title + '/' + c._name === path);
    const inView = ['Copy link to this view', 'Include device defaults'].filter((n) =>
      ui.gui.controllersRecursive().some((c) => c._name === n));
    // The dialog opened, its parts.
    const open = async () => {
      const b = control('File/Link to this view...');
      b.$button.click();
      await frame();
      const d = document.querySelector('dialog.cv-dialog');
      return { d, box: d.querySelector('input[type=checkbox]'), text: d.querySelector('textarea.link'),
        copy: [...d.querySelectorAll('button')].find((x) => x.textContent === 'Copy') };
    };
    const said = (href) => { const u = new URL(href); const h = new URLSearchParams(u.hash.slice(1));
      return { profile: u.searchParams.get('profile'), linear: u.searchParams.get('linearDeflection'),
        edgeStyle: h.get('edgeStyle') }; };
    let o = await open();
    const before = { checked: o.box.checked, link: said(o.text.value), same: o.text.value === ui.link(),
      title: o.d.querySelector('h2').textContent, readOnly: o.text.readOnly, wrap: o.text.wrap };
    o.box.click();
    await frame();
    const toggled = { stored: localStorage.getItem('cad-viewer.linkDeviceDefaults'), link: said(o.text.value),
      same: o.text.value === ui.link() };
    o.copy.click();
    for (let i = 0; i < 50 && (copied === undefined || o.copy.textContent === 'Copy'); i++) await frame();
    const copy = { copied: copied === o.text.value, label: o.copy.textContent, open: o.d.open };
    // A long link: one line, scrolling sideways, the line whole above the scroll bar; focused, all of it selected.
    o.text.value = o.text.value + '&' + 'x'.repeat(600);
    o.text.focus();
    const long = { scrolls: o.text.scrollWidth > o.text.clientWidth, line: o.text.scrollHeight <= o.text.clientHeight,
      selected: o.text.selectionStart === 0 && o.text.selectionEnd === o.text.value.length,
      inside: o.text.getBoundingClientRect().right <= o.d.getBoundingClientRect().right };
    o.d.querySelector('button[value=close]').click();
    await frame();
    ui.setMeshing({ profile: 'custom', linearDeflection: 0.05 });
    await (async () => { const b = control('B-Rep Meshing/Mesh again');
      await b.getValue().call(b.object); await cadViewer.idle(); })();
    o = await open();
    const custom = said(o.text.value);
    o.d.querySelector('button[value=close]').click();
    await frame();
    return { before, toggled, copy, long, custom, inView, closed: !document.querySelector('dialog.cv-dialog'),
      device: viewer.device };
  })()`;
  type Said = { profile: string | null; linear: string | null; edgeStyle: string | null };
  type Got = { before: { checked: boolean; link: Said; same: boolean; title: string; readOnly: boolean;
    wrap: string }; toggled: { stored: string | null; link: Said; same: boolean };
    copy: { copied: boolean; label: string; open: boolean };
    long: { scrolls: boolean; line: boolean; selected: boolean; inside: boolean }; custom: Said; inView: string[];
    closed: boolean; device: string };
  // (As it is: the check's pages otherwise ask for thin edges.)
  const url = `?url=${encodeURIComponent('/content/as1.stp')}&check`;
  // Off, then turned on.
  const a = (await page(url, look, { asIs: true }) as { after: Got }).after;
  // Remembered on in a new page, then turned off.
  const b = (await page(url, look, { asIs: true }) as { after: Got }).after;
  // A phone: on, then off.
  const pOn = (await page(url, `(async () => { localStorage.setItem('cad-viewer.linkDeviceDefaults', '1');
    return 0; })()`, { phone: true, asIs: true }), (await page(url, look, { phone: true, asIs: true }) as
    { after: Got }).after);
  const j = JSON.stringify({ a, b, pOn });
  expect(a.before.title === 'Link to this view' && a.before.readOnly && a.before.wrap === 'off' && a.before.same
    && a.inView.length === 0 && a.closed, `File's Link to this view...: the link, read only, one line: ${j}`);
  expect(!a.before.checked && a.before.link.profile === null && a.before.link.edgeStyle === null,
    `off by default: the desktop's defaults left out: ${j}`);
  expect(a.toggled.stored === '1' && a.toggled.link.profile === 'medium' && a.toggled.link.edgeStyle === 'fat'
    && a.toggled.same, `on: spelled out, remembered, the box following: ${j}`);
  expect(a.copy.copied && a.copy.label === 'Copied' && a.copy.open, `Copy: the link copied, the dialog open: ${j}`);
  expect([a, pOn].every((x) => x.long.scrolls && x.long.line && x.long.selected && x.long.inside),
    `a long link: scrolling sideways, the line whole, all selected on focus, inside the dialog: ${j}`);
  expect(a.custom.profile === null && a.custom.linear === '0.05', `on, custom: its deflections: ${j}`);
  expect(b.before.checked && b.before.link.profile === 'medium' && b.toggled.stored === '0'
    && b.toggled.link.profile === null && b.toggled.link.edgeStyle === null, `remembered on; off again: ${j}`);
  expect(pOn.device === 'phone' && pOn.before.checked && pOn.before.link.profile === 'coarse'
    && pOn.before.link.edgeStyle === 'thin' && pOn.toggled.link.profile === null && pOn.toggled.link.edgeStyle
    === 'thin', `a phone: coarse and thin on; off, its thin edges (not the desktop's) only: ${j}`);
  return undefined;
});
// Going to a face from the address, and why it failed: conical-surface with cadio alone at a deflection of 1.2e-6 mm
// from the address (linearDeflection=: custom, in meshedWith, in the page's link), face=77 (a face cadio fails by
// construction there, at its point cap): selected, the tree's detail on, revealed and zoomed to (the camera nearer than
// the whole model's), its Details saying it failed and why (tess-cadio's cause), the problems dialog (check=dialogs)
// with no error for it (kept with its defect, a warning); with keepFailing=1 and heal=1 the same link selects the
// face meshed (triangles, no cause); part=12 the part; an id matching nothing, one that isn't an id, and a profile=
// that names none, said in the address's problems.
await check('go to a face', async () => {
  const look = `(async () => {
    await cadViewer.idle();
    const text = () => document.getElementById('status').textContent;
    const d = document.querySelector('dialog.cv-dialog');
    const rows = d ? [...d.querySelectorAll('.table.errors tr')].map((r) => [...r.cells].map((c) => c.textContent))
      : [];
    d?.querySelector('button.primary')?.click();
    await cadViewer.idle();
    const nodes = viewer.nodes, sel = ui.selected();
    const out = { rows, selected: sel.map((id) => nodes.pathOf(id)), detail: nodes.hasDetail(),
      details: ui.details(), panel: document.getElementById('details').textContent,
      height: (viewer.camera.top - viewer.camera.bottom) / viewer.camera.zoom,
      meshedWith: viewer.model.meshedWith, link: ui.link?.(),
      kept: viewer.model.diagnostics.filter((x) => x.message.startsWith('faces kept with defects: '))
        .map((x) => x.severity + ': ' + x.message) };
    viewer.zoomAll();
    await cadViewer.idle();
    out.all = (viewer.camera.top - viewer.camera.bottom) / viewer.camera.zoom;
    for (let t = 0; t < 50 && !text().includes('the address'); t++) await new Promise((r) => setTimeout(r, 100));
    out.status = text();
    return out;
  })()`;
  type Got = { rows: string[][]; selected: string[]; detail: boolean; details: string[]; panel: string;
    height: number; all: number; status: string; link?: string; kept: string[];
    meshedWith: { backend: string; keepFailing: boolean; heal: boolean; profile: string; linearDeflection: number } };
  const url = `?url=${encodeURIComponent('/content/conical-surface.step')}&backend=cadio&fallback=none`
    + '&linearDeflection=1.2e-6';
  const f = (await page(`${url}&face=77&check=dialogs`, look) as { after: Got }).after, j = JSON.stringify(f);
  expect(f.meshedWith.profile === 'custom' && f.meshedWith.linearDeflection === 1.2e-6
    && new URL(f.link ?? 'x:').searchParams.get('linearDeflection') === '0.0000012', `the address's deflection, `
    + `meshed with and linked: ${j}`);
  expect(f.selected.length === 1 && f.selected[0]!.endsWith('/face#77') && f.detail, `face=77 selected: ${j}`);
  expect(f.height < f.all, `zoomed to it: ${j}`);
  // (At its point cap there, the face is kept with its mesh, tess-cadio's keepDefects: a warning, no error.)
  expect(f.details.some((x) => /^Triangles: [1-9]/.test(x)) && !f.details.some((x) => x.startsWith('Failed')),
    `its Details: ${j}`);
  expect(f.rows.length === 0 && f.kept.length === 1 && f.kept[0]!.startsWith('warning: faces kept with defects: 1 ')
    && f.kept[0]!.includes('#77') && /point cap/.test(f.kept[0]!), `kept with its defect said: ${j}`);
  expect(!f.status.includes('the address'), `nothing said: ${j}`);
  const k = (await page(`${url}&keepFailing=1&heal=1&face=77&check`, look) as { after: Got }).after;
  const l = JSON.stringify(k);
  expect(k.meshedWith.keepFailing && k.meshedWith.heal && k.selected.length === 1
    && k.selected[0]!.endsWith('/face#77'), `keepFailing=1, heal=1, face=77: ${l}`);
  expect(k.details.some((x) => /^Triangles: [1-9]/.test(x)) && !k.details.some((x) => x.startsWith('Cause:'))
    && !k.details.some((x) => x.startsWith('Failed')), `the face kept, meshed: ${l}`);
  const p = (await page(`${url}&part=12&face=999999,x1&profile=best&check`, look) as { after: Got }).after;
  const q = JSON.stringify(p);
  expect(p.selected.length === 1 && !p.selected[0]!.includes('face#'), `part=12: ${q}`);
  expect(p.status.includes('face=: nothing has #999999') && p.status.includes('face=: not STEP ids: x1'),
    `face= that names nothing: ${q}`);
  expect(p.status.includes('profile: not one of coarse, medium, fine, custom: best'), `profile= naming none: ${q}`);
  return undefined;
});
// Mesh again from the model worker's models, in place: no import (the same tree and scene graph, no "importing" in
// the status line, "meshing again" there), each part keeping its mesh until its new one comes (never fewer parts
// meshed while it goes), meshed anew (fine: more triangles); then with a millisecond's timeout (the cache off), the
// parts that fail shown as a load shows them: as1 has no tessellation of its own, so their faces' outlines from the
// models, counted failed.
await check('mesh again in place', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const c = (name) => ui.gui.controllersRecursive().find((x) => x._name === name);
    const statuses = [];
    const onStatus = viewer.onStatus;
    viewer.onStatus = (s) => { statuses.push(s); onStatus?.(s); };
    let least = Infinity;
    const onMeshes = viewer.onMeshes;
    viewer.onMeshes = () => { least = Math.min(least, viewer.graph.meshes.size); onMeshes?.(); };
    const again = async () => {
      statuses.length = 0;
      least = Infinity;
      const before = viewer.nextLoad();
      c('Mesh again').$button.click();
      for (let t = 0; t < 1200 && (viewer.nextLoad() === before || !viewer.model?.meshing); t++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await cadViewer.idle();
    };
    const nodes = viewer.nodes, graph = viewer.graph, meshed = graph.meshes.size, triangles = viewer.stats().triangles;
    ui.setMeshing({ profile: 'fine', cache: false });
    await again();
    const fine = { same: viewer.nodes === nodes && viewer.graph === graph, least, meshed: graph.meshes.size,
      triangles: viewer.stats().triangles, parts: viewer.model.parts,
      importing: statuses.some((s) => /importing/.test(s)), again: statuses.some((s) => /meshing again/.test(s)) };
    ui.setMeshing({ timeout: 0.001 });
    await again();
    const failed = { same: viewer.nodes === nodes, parts: viewer.model.parts, meshed: graph.meshes.size,
      outlined: [...graph.meshes.values()].filter((m) => !m.indices.length && m.faceOutlines?.length).length,
      triangles: viewer.stats().triangles };
    return { meshed, triangles, fine, failed };
  })()`) as { after: { meshed: number; triangles: number; fine: { same: boolean; least: number; meshed: number;
    triangles: number; parts: { total: number; failed: number }; importing: boolean; again: boolean };
  failed: { same: boolean; parts: { total: number; failed: number }; meshed: number; outlined: number;
    triangles: number } } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.meshed > 0 && a.fine.same && !a.fine.importing && a.fine.again, `in place, no import: ${j}`);
  expect(a.fine.least >= a.meshed && a.fine.meshed === a.meshed, `every part kept its mesh until its new one: ${j}`);
  expect(a.fine.triangles > a.triangles && a.fine.parts.failed === 0, `meshed anew, fine: ${j}`);
  expect(a.failed.same && a.failed.parts.failed > 0 && a.failed.outlined === a.failed.parts.failed &&
    a.failed.meshed === a.meshed && a.failed.triangles < a.fine.triangles,
    `the parts that failed outlined, as a load shows them: ${j}`);
  return undefined;
});
// Every slot of the appearance overrides drawn alike after Mesh again: an assembly hidden with a child shown, a part
// transparent with one face back to the file's and one hidden, a part's triangle edges on with one face off and one
// edge hidden, a face's on and its part's edges hidden; what's drawn, face by face in every placement (shown, opacity,
// triangle edges) and every line object, the same after meshing at another deflection, and the state's overrides too.
await check('overrides after mesh again', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    const button = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    ui.setTree({ open: true, detail: true });
    let m = viewer.nodes;
    const under = (id, a) => {
      for (let n = id; n >= 0; n = m.nodes[n].parent) if (n === a) return true;
      return false;
    };
    // (The smallest assembly of several, so parts enough are left outside it.)
    const size = (id) => m.nodes[id].kind === 'part' ? 1 : m.children(id).reduce((k, c) => k + size(c), 0);
    const asm = m.nodes.filter((n) => n.kind === 'assembly' && n.parent >= 0 && m.children(n.id).length > 1)
      .sort((x, y) => size(x.id) - size(y.id))[0].id;
    // (A part's faces, edges: its groups' nodes.)
    const inGroup = (id, kind) => m.children(id).filter((g) => m.nodes[g].kind === kind)
      .flatMap((g) => m.children(g));
    const faces = (id) => inGroup(id, 'faces');
    const parts = m.nodes.filter((n) => n.kind === 'part' && !under(n.id, asm) && faces(n.id).length >= 2)
      .map((n) => n.id);
    const [p, q, s] = parts;
    ui.setHidden([asm], true);
    ui.setHidden([m.children(asm)[0]], false);
    ui.setOverride(p, { transparent: true, alpha: 0.4 });
    ui.setOverride(faces(p)[0], { transparent: false });
    ui.setOverride(faces(p)[1], { hidden: true });
    ui.setOverride(q, { triangleEdges: true });
    ui.setOverride(faces(q)[0], { triangleEdges: false });
    ui.setOverride(inGroup(q, 'edges')[0], { hidden: true });
    ui.setOverride(faces(s)[0], { triangleEdges: true });
    const edges = m.children(s).find((c) => m.nodes[c].kind === 'edges');
    if (edges !== undefined) ui.setOverride(edges, { hidden: true });
    ui.select([]);
    await cadViewer.idle();
    // What's drawn: per placement, its group, its line objects, and per face its material (shown, opacity) and
    // whether its triangles have edges drawn (triangle-edges.ts's wireframes, whole or of some faces).
    const drawn = () => {
      const n = viewer.nodes, out = {};
      const pairs = viewer.triangleEdges.pairs;
      for (const node of n.nodes) {
        if (node.kind !== 'part') continue;
        // (Drawn: shown with every ancestor; a group hidden whole keeps its materials until shown, scene-graph.ts.)
        const g = node.object;
        let on = true;
        for (let o = g; o; o = o.parent) on &&= o.visible;
        const rec = { visible: on, lines: {}, faces: {} };
        for (const obj of g.children) {
          for (const c of obj.children) {
            // (Shown, and how many of its items: hidden one by one, items.ts. Lines: each item a run of chained
            // segments, however many the deflection gives it; dots one index each.)
            const items = (o) => {
              const x = o.geometry.index?.array ?? [];
              if (!o.isLineSegments) return x.length;
              let k = x.length ? 1 : 0;
              for (let i = 2; i < x.length; i += 2) if (x[i] !== x[i - 1]) k++;
              return k;
            };
            if (['edges', 'curves', 'points', 'vertices'].includes(c.name)) rec.lines[c.name] = on && c.visible &&
              items(c);
          }
          const pair = pairs.find((x) => x.source === obj);
          const index = obj.geometry.index?.array;
          for (const f of obj.userData.faceRanges ?? []) {
            if (f.source === null || !f.count) continue;
            const grp = obj.geometry.groups.find((x) => x.start <= f.start && f.start < x.start + x.count);
            const mat = [].concat(obj.material)[grp ? grp.materialIndex : 0];
            let tri = false;
            if (pair && pair.wire.visible) {
              if (!pair.own) tri = mat.visible;
              else {
                const a = pair.own.index.array;
                for (let i = 0; i < a.length && !tri; i += 3) tri = a[i] === index[f.start] &&
                  a[i + 1] === index[f.start + 1] && a[i + 2] === index[f.start + 2];
              }
            }
            const shown = on && mat.visible;
            rec.faces[f.source] = [shown, shown ? +mat.opacity.toFixed(3) : 0, shown && tri];
          }
        }
        out[n.pathOf(node.id)] = rec;
      }
      return out;
    };
    const slots = (st) => ({ hidden: st.hidden, shown: st.shown, opacity: st.opacity,
      triangleEdges: st.triangleEdges });
    const before = { drawn: drawn(), state: slots(cadViewer.state()), triangles: viewer.stats().triangles };
    const model = viewer.nextLoad();
    viewer.settings.cache = false;
    viewer.settings.profile = 'custom';
    viewer.settings.linearDeflection = 1;
    button('Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.nextLoad() === model || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cadViewer.idle();
    const after = { drawn: drawn(), state: slots(cadViewer.state()), triangles: viewer.stats().triangles };
    const at = (id) => ({ path: m.pathOf(id), faces: faces(id).map((f) => m.nodes[f].face.source) });
    return { before, after, set: { p: at(p), q: at(q), s: at(s) } };
  })()`) as { after: Record<string, { drawn: Record<string, { visible: boolean; lines: Record<string, boolean>;
    faces: Record<string, [boolean, number, boolean]> }>; state: Record<string, unknown[]>; triangles: number }> &
    { set: Record<'p' | 'q' | 's', { path: string; faces: number[] }> } };
  const { before, after, set } = r.after;
  // Each as set, before and after: p at 0.4 but its first face (the file's 1) and its second (hidden); q's triangle
  // edges but its first face's; s's first face's alone.
  for (const [when, d] of [['before', before!], ['after', after!]] as const) {
    type K = 'p' | 'q' | 's';
    const face = (k: K, i: number) => d.drawn[set[k].path]!.faces[set[k].faces[i]!]!;
    const rest = (k: K, from: number) => set[k].faces.slice(from).map((f) => d.drawn[set[k].path]!.faces[f]!);
    const e = `${when}: ${JSON.stringify([set, d.drawn[set.p.path], d.drawn[set.q.path], d.drawn[set.s.path]])}`;
    expect(JSON.stringify(face('p', 0)) === '[true,1,false]' && !face('p', 1)[0] &&
      rest('p', 2).every((f) => f[0] && f[1] === 0.4), `p's faces ${e}`);
    expect(!face('q', 0)[2] && rest('q', 1).every((f) => f[2]), `q's triangle edges ${e}`);
    expect(face('s', 0)[2] && rest('s', 1).every((f) => !f[2]) && d.drawn[set.s.path]!.lines.edges === false,
      `s's triangle edges and edges ${e}`);
  }
  const all = Object.values(before!.drawn).flatMap((p) => Object.values(p.faces));
  const j = JSON.stringify(before!.state);
  // (The overrides make a difference: what's compared is not all alike.)
  expect(all.some((f) => !f[0]) && all.some((f) => f[0] && f[1] === 0.4) && all.some((f) => f[0] && f[1] !== 0.4) &&
    all.some((f) => f[2]) && all.some((f) => f[0] && !f[2]) && Object.values(before!.drawn).some((p) => !p.visible) &&
    Object.values(before!.drawn).some((p) => p.visible && p.lines.edges === false), `the overrides drawn: ${j}`);
  expect(before!.triangles !== after!.triangles, `meshed anew: ${before!.triangles} then ${after!.triangles}`);
  expect(JSON.stringify(before!.state) === JSON.stringify(after!.state), `the overrides kept: ${j} then ${
    JSON.stringify(after!.state)}`);
  const diffs = Object.keys({ ...before!.drawn, ...after!.drawn }).filter((k) =>
    JSON.stringify(before!.drawn[k]) !== JSON.stringify(after!.drawn[k]));
  expect(!diffs.length, `drawn alike after: ${diffs.slice(0, 3).map((k) => `${k}: ${JSON.stringify(
    before!.drawn[k])} then ${JSON.stringify(after!.drawn[k])}`).join('; ')}`);
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
    // (In its faces group.)
    const face = m.children(part.id).flatMap((g) => m.children(g)).map((id) => m.nodes[id])
      .find((n) => n.kind === 'face');
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
// Triangle edges on a selected face, on screen: its highlight (an overlay over its triangles) doesn't hide them, with
// Triangle edges on Selected or All. The face's pixels: those its highlight changes; its edges: those of them that
// turning the edges on changes (as1's plate face: about 13% Selected and 18% All; hidden, under 1.2%).
await check('triangle edges on a selected face', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const m = viewer.nodes;
    const pixels = async () => {
      await cadViewer.idle();
      const img = new Image();
      img.src = cadViewer.screenshot();
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.width, img.height];
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, c.width, c.height).data;
    };
    const differ = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) >
      30;
    // (Faces have nodes only with the tree's detail.)
    ui.setTree({ detail: true });
    ui.setPickLevel('detail');
    let path;
    for (const [x, y] of [[0.5, 0.5], [0.4, 0.5], [0.6, 0.5], [0.5, 0.4], [0.5, 0.6]]) {
      path = cadViewer.pickAt(x, y)?.path;
      if (path) break;
    }
    const face = path === undefined ? undefined : m.find(path);
    if (face === undefined || m.nodes[face].kind !== 'face') return { face: path ?? null };
    cadViewer.apply({ render: { triangleEdges: 'off' } });
    ui.select([]);
    const plain = await pixels();
    ui.select([face]);
    const lit = await pixels();
    const mask = [];
    for (let i = 0; i < lit.length; i += 4) if (differ(plain, lit, i)) mask.push(i);
    const edges = async (mode) => {
      cadViewer.apply({ render: { triangleEdges: mode } });
      const p = await pixels();
      return mask.filter((i) => differ(lit, p, i)).length;
    };
    const selected = await edges('selected'), all = await edges('all');
    cadViewer.apply({ render: { triangleEdges: 'off' } });
    ui.select([]);
    return { face: path, mask: mask.length, selected, all };
  })()`) as { after: { face: string | null; mask?: number; selected?: number; all?: number } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.mask !== undefined && a.mask > 100, `a face picked and highlighted: ${j}`);
  expect(a.selected! > a.mask! * 0.05 && a.all! > a.mask! * 0.05, `its edges drawn over its highlight: ${j}`);
  return undefined;
});
// The keyboard shortcuts (shortcuts.ts), each pressing its control: f zooms to the selection, or all with none; 1 to 7
// look along the axes in Look Along an Axis's order; h and s hide and show the selection; t shows the tree or not; g
// cycles triangle edges (selected or all to off; off to selected with a selection, else all). None in a text field,
// with a modifier, or repeated; recorded as the controls they press. Each control shows its key, greyed, after its
// name, whole (the names themselves, which recordings use, unchanged).
// Multi-select (on by default, its control so named): in the tree a click adds a row and a click on a selected row
// takes it out, a shift-click adds the span from the row last clicked to what's selected and a shift-click on a
// selected row takes the span out; in the 3D view a click adds what's under it, a click on it again takes it out, a
// click on nothing leaves the selection; Escape (on the tree, on the view) selects nothing, recorded as Select none.
// With it off, a plain click selects the row alone and a shift-click the span alone.
await check('multi-select', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const p = ui.panel(), m = p.model;
    const control = ui.gui.controllersRecursive().find((c) => c.property === 'multi' && c.object === ui.selection);
    const named = control?._name, on = control?.getValue();
    const rows = () => [...document.querySelectorAll('.tree-row')].filter((r) => r.style.display !== 'none');
    p.expandAll();
    await frame();
    const click = (row, shiftKey = false) => row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
    const parts = m.nodes.filter((n) => n.kind === 'part').map((n) => n.id);
    const rowOf = async (id) => {
      p.scrollToRow(id, 0);
      await frame();
      return rows().find((r) => +r.dataset.id === id);
    };
    // The parts' rows in the tree's order, so a span between two is known.
    const order = rows().map((r) => +r.dataset.id);
    const between = (a, b) => order.slice(Math.min(order.indexOf(a), order.indexOf(b)),
      Math.max(order.indexOf(a), order.indexOf(b)) + 1);
    const sel = () => [...ui.selected()].sort((a, b) => a - b);
    const sorted = (x) => [...x].sort((a, b) => a - b);
    const out = { named, on };
    const [a, b, c, d] = parts;
    click(await rowOf(a));
    await frame();
    out.one = sel();
    click(await rowOf(b));
    await frame();
    out.two = sel();
    click(await rowOf(a));
    await frame();
    out.removed = sel();
    // (The row last clicked without shift: a.)
    click(await rowOf(d), true);
    await frame();
    out.span = sel();
    out.spanExpected = sorted(new Set([b, ...between(a, d)]));
    click(await rowOf(c), true);
    await frame();
    out.spanOut = sel();
    out.spanOutExpected = sorted(out.span.filter((x) => !between(a, c).includes(x)));
    // Escape on the tree's focused row.
    const key = (on) => on.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true,
      cancelable: true }));
    cadViewer.record(true);
    key(document.activeElement ?? document.body);
    const rec = cadViewer.record(false);
    out.escTree = sel();
    out.recorded = rec.events.filter((e) => e.type === 'control').map((e) => e.path);
    // The 3D view: two parts' centres, clicked.
    const canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    const spots = [];
    for (let y = 0.2; y < 0.85 && spots.length < 2; y += 0.05) for (let x = 0.2; x < 0.85 && spots.length < 2;
      x += 0.05) {
      const px = rect.left + x * rect.width, py = rect.top + y * rect.height;
      if (!viewer.pickAt(px, py)) continue;
      ui.select([]);
      ui.pickAt(px, py, false);
      const got = ui.selected()[0];
      if (got !== undefined && !spots.some((s) => s.id === got)) spots.push({ x: px, y: py, id: got });
    }
    ui.select([]);
    const pick = (s) => ui.pickAt(s.x, s.y, false);
    pick(spots[0]);
    pick(spots[1]);
    out.view2 = sel();
    pick(spots[0]);
    out.viewRemoved = sel();
    ui.pickAt(rect.left + 2, rect.top + 2, false);
    out.viewNothing = sel();
    pick(spots[0]);
    key(canvas);
    out.escView = sel();
    out.spots = sorted(spots.map((s) => s.id));
    // Off: the row alone, the span alone, the view's pick alone.
    control.setValue(false);
    click(await rowOf(a));
    click(await rowOf(b));
    await frame();
    out.offOne = sel();
    click(await rowOf(d), true);
    await frame();
    out.offSpan = sel();
    out.offSpanExpected = sorted(between(b, d));
    pick(spots[0]);
    pick(spots[1]);
    out.offView = sel();
    return out;
  })()`) as { after: Record<string, unknown> };
  const a = r.after as Record<string, number[]> & { named: string; on: boolean; recorded: string[] };
  const j = JSON.stringify(a);
  const same = (x: number[], y: number[]) => JSON.stringify(x) === JSON.stringify(y);
  expect(a.named === 'Multi-select' && a.on === true, `named Multi-select, on by default: ${j}`);
  expect(a.one!.length === 1 && a.two!.length === 2 && a.removed!.length === 1 && !a.removed!.includes(a.one![0]!),
    `tree: a click adds, a click on a selected row takes it out: ${j}`);
  expect(same(a.span!, a.spanExpected!) && a.span!.length >= 3, `tree: a shift-click adds the span: ${j}`);
  expect(same(a.spanOut!, a.spanOutExpected!) && a.spanOut!.length < a.span!.length,
    `tree: a shift-click on a selected row takes the span out: ${j}`);
  expect(a.escTree!.length === 0 && same(a.recorded as unknown as number[], ['Selection/Select none'] as unknown as
    number[]), `Escape in the tree: nothing selected, recorded as Select none: ${j}`);
  expect(a.spots!.length === 2 && same(a.view2!, a.spots!) && a.viewRemoved!.length === 1
    && same(a.viewNothing!, a.viewRemoved!) && a.escView!.length === 0,
    `the view: a click adds, again takes out, on nothing leaves it; Escape clears: ${j}`);
  expect(a.offOne!.length === 1 && same(a.offSpan!, a.offSpanExpected!) && a.offView!.length === 1,
    `off: the row, the span, the pick alone: ${j}`);
  return undefined;
});
// Mesh edge detection... (Rendering): a panel that doesn't block the page, starting from the defaults; Selection only
// with nothing selected said; with a part selected, only that part's placements get detected edges, beside their
// B-rep edges (kept), the tree's "detected mesh edges" right after the edges group; unchecked, every part; a smaller
// angle (5 degrees, remembered in the browser as it's changed) more segments (as1's cylinders' facets meet at under
// 10); a later GLB without edges detected with the remembered values (more segments than with the defaults);
// Defaults back to them; Escape closes it.
await check('mesh edge detection', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    localStorage.removeItem('cad-viewer.edgeDetection');
    await cadViewer.ready;
    await cadViewer.idle();
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const control = ui.gui.controllersRecursive().find((c) => c._name === 'Mesh edge detection...');
    const folder = control?.parent._title;
    control.$button.click();
    await frame();
    const d = document.querySelector('dialog.edge-detection');
    const input = (n) => d.querySelector('input[name=' + n + ']');
    const detect = [...d.querySelectorAll('button')].find((b) => b.textContent === 'Detect');
    const defaults = [...d.querySelectorAll('button')].find((b) => b.textContent === 'Defaults');
    const result = () => d.querySelector('p.result').textContent;
    const run = async () => {
      detect.click();
      for (let t = 0; t < 200 && (detect.disabled || result() === 'Detecting...'); t++) await frame();
      await frame();
      return result();
    };
    const detectedObjects = () => { let n = 0, segs = 0; viewer.display.traverse((o) => {
      if (o.name === 'detectedEdges') { n++; segs += o.geometry.index.count / 2; } }); return { n, segs }; };
    const brepEdges = () => { let n = 0; viewer.display.traverse((o) => { if (o.name === 'edges') n++; }); return n; };
    const out = { folder, open: d.open, modal: d.matches(':modal'), angle: input('angle').value,
      grid: input('grid').value, brep: brepEdges() };
    // (The tree's detail made before any run: a run makes it again.)
    ui.panel().model.setDetail(true);
    ui.panel().model.children(ui.panel().model.nodes.find((n) => n.kind === 'part').id);
    input('selection').checked = true;
    ui.select([]);
    out.none = await run();
    const m = ui.panel().model;
    const part = m.nodes.find((n) => n.kind === 'part' && n.object.userData.cad === 'part');
    const placements = m.nodes.filter((n) => n.kind === 'part' && n.object.userData.part === part.object.userData.part)
      .length;
    ui.select([part.id]);
    out.one = { text: await run(), objects: detectedObjects().n, placements, brep: brepEdges() };
    // The tree: right after the edges group.
    const kids = m.children(part.id).map((k) => m.nodes[k].name);
    out.kids = kids;
    // An assembly selected: every part below it.
    ui.select([m.roots[0]]);
    out.assembly = await run();
    input('selection').checked = false;
    // A run started while another goes: the first stopped.
    const first = viewer.detectEdges(undefined, { angle: 10, grid: 0.001 });
    const second = viewer.detectEdges([part.object.userData.part], { angle: 10, grid: 0.001 });
    out.superseded = [await first, await second];
    out.all = { text: await run(), ...detectedObjects(), brep: brepEdges() };
    input('angle').value = '5';
    input('angle').dispatchEvent(new Event('change'));
    out.stored = localStorage.getItem('cad-viewer.edgeDetection');
    out.wide = { text: await run(), ...detectedObjects() };
    // Not a number: said, not remembered.
    input('grid').value = '-1';
    input('grid').dispatchEvent(new Event('change'));
    out.bad = { said: result(), stored: localStorage.getItem('cad-viewer.edgeDetection') };
    input('grid').value = '0.001';
    input('grid').dispatchEvent(new Event('change'));
    return out;
  })()`, { asIs: true, then: async (sessionId) => {
    const evaluate = async (expression: string) => ((await send('Runtime.evaluate', { expression,
      returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
    // The GLB without edges in this page (the values remembered), then with the defaults.
    const glb = (reset: boolean) => evaluate(`(async () => {
      ${reset ? `document.querySelector('dialog.edge-detection button:not(.close):not(.primary)').click();` : ''}
      await ui.openUrl('/content/as1-noedges.glb');
      await cadViewer.idle();
      await new Promise((r) => setTimeout(r, 300));
      await cadViewer.idle();
      return { segments: viewer.stats().segments, stored: localStorage.getItem('cad-viewer.edgeDetection') };
    })()`);
    const remembered = await glb(false), reset = await glb(true);
    const closed = await evaluate(`(async () => {
      const d = document.querySelector('dialog.edge-detection');
      const v = [d.querySelector('input[name=angle]').value, d.querySelector('input[name=grid]').value];
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      localStorage.removeItem('cad-viewer.edgeDetection');
      return { values: v, gone: !document.querySelector('dialog.edge-detection') };
    })()`);
    return { remembered, reset, closed };
  } }) as { after: Record<string, unknown> & { one: { text: string; objects: number; placements: number;
    brep: number }; all: { text: string; n: number; segs: number; brep: number }; wide: { text: string; n: number;
    segs: number }; bad: { said: string; stored: string | null } }; then: { remembered: { segments: number;
    stored: string | null }; reset: { segments: number; stored: string | null }; closed: { values: string[];
    gone: boolean } } };
  const a = r.after, t = r.then, j = JSON.stringify({ a, t });
  expect(a.folder === 'Rendering' && a.open === true && a.modal === false && a.angle === '10' && a.grid === '0.001',
    `the panel, not modal, from the defaults: ${j}`);
  expect(a.none === 'Nothing selected.', `selection only, nothing selected: ${j}`);
  expect(/^Detected [\d,]+ edge segments on 1 part\.$/.test(a.one.text) && a.one.objects === a.one.placements
    && a.one.brep === a.brep, `selection only: that part's placements, B-rep edges kept: ${j}`);
  const kids = a.kids as string[];
  expect(kids.indexOf('detected mesh edges') === kids.indexOf('edges') + 1 && kids.indexOf('edges') >= 0,
    `the tree: after the edges group: ${j}`);
  expect(/on [2-9]\d* parts\.$/.test(a.all.text) && a.all.n > a.one.objects && a.all.brep === a.brep,
    `every part: ${j}`);
  const sup = a.superseded as { parts: number; stopped?: boolean }[];
  expect(sup[0]!.stopped === true && !sup[1]!.stopped && sup[1]!.parts === 1, `a run stopped by a later one: ${j}`);
  expect(String(a.assembly).endsWith(a.all.text.slice(a.all.text.indexOf(' on '))), `an assembly: its parts: ${j}`);
  expect(JSON.parse(String(a.stored)).angle === 5 && a.wide.segs > a.all.segs && a.wide.n === a.all.n,
    `a smaller angle remembered, more segments: ${j}`);
  expect(/^Not remembered: the weld tolerance/.test(a.bad.said) && JSON.parse(String(a.bad.stored)).grid === 0.001,
    `a bad value said, not remembered: ${j}`);
  expect(t.reset.segments > 0 && t.remembered.segments > t.reset.segments
    && JSON.parse(String(t.reset.stored)).angle === 10, `a later load detects with the remembered values: ${j}`);
  expect(t.closed.values.join() === '10,0.001' && t.closed.gone, `Defaults, then Escape: ${j}`);
  // A new page: the values read back from the browser at start, its load detecting with them.
  const segmentsWith = async (stored?: string) => ((await page(`?url=${encodeURIComponent('/content/as1-noedges.glb')}`
    + '&check', `cadViewer.idle().then(() => ({ s: viewer.stats().segments, d: viewer.edgeDetection }))`,
  { asIs: true, first: stored ? `localStorage.setItem('cad-viewer.edgeDetection', '${stored}');`
    : `localStorage.removeItem('cad-viewer.edgeDetection');` })) as { after: { s: number; d: unknown } }).after;
  const stored = await segmentsWith('{"angle":5,"grid":0.001}'), plain = await segmentsWith();
  expect(JSON.stringify(stored.d) === '{"angle":5,"grid":0.001}' && stored.s > plain.s && plain.s > 0,
    `a new page: the values remembered, used: ${JSON.stringify({ stored, plain })}`);
  await page('?check', `(localStorage.removeItem('cad-viewer.edgeDetection'), 0)`);
  return undefined;
});
// Mesh edge detection recorded and replayed: the values set (each change, Defaults) and each Detect (its values,
// Selection only, and what it said once done), the states' values; replayed in another page whose browser remembers
// other values: the first state's set before the load (a GLB without edges detected as recorded), each run made
// again with the same outcome, the panel showing them, the end's values the same; a run that said otherwise, and
// values at the end otherwise, reported.
await check('mesh edge detection recorded', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1-noedges.glb')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const detected = () => { let segs = 0; viewer.display.traverse((o) => {
      if (o.name === 'detectedEdges') segs += o.geometry.index.count / 2; }); return segs; };
    const out = { loaded: detected() };
    // The model as it loaded, alone.
    cadViewer.record(true);
    out.rec0 = cadViewer.record(false);
    cadViewer.record(true);
    ui.gui.controllersRecursive().find((c) => c._name === 'Mesh edge detection...').$button.click();
    await frame();
    const d = document.querySelector('dialog.edge-detection');
    const input = (n) => d.querySelector('input[name=' + n + ']');
    const button = (t) => [...d.querySelectorAll('button')].find((b) => b.textContent === t);
    const result = () => d.querySelector('p.result').textContent;
    const run = async () => {
      button('Detect').click();
      for (let t = 0; t < 200 && (button('Detect').disabled || result() === 'Detecting...'); t++) await frame();
      await frame();
      return result();
    };
    const set = (n, v) => {
      input(n).value = v;
      input(n).dispatchEvent(new Event('change'));
    };
    set('angle', '20');
    out.all = await run();
    cadViewer.select([cadViewer.nodes().find((n) => n.kind === 'part').path]);
    input('selection').checked = true;
    set('angle', '5');
    out.one = await run();
    out.segments = detected();
    button('Defaults').click();
    out.rec = cadViewer.record(false);
    localStorage.removeItem('cad-viewer.edgeDetection');
    return out;
  })()`, { asIs: true, first: `localStorage.setItem('cad-viewer.edgeDetection', '{"angle":5,"grid":0.001}');` }) as
    { after: { loaded: number; one: string; all: string; segments: number; rec0: { events: Record<string,
      unknown>[] }; rec: { events: Record<string, unknown>[] } } };
  const a = r.after;
  const ours = a.rec.events.filter((e) => e.type === 'detection' || e.type === 'detect')
    .map(({ t: _, ...e }) => e);
  const want = [{ type: 'detection', detection: { angle: 20, grid: 0.001 } },
    { type: 'detect', detection: { angle: 20, grid: 0.001 }, selectionOnly: false, result: a.all },
    { type: 'detection', detection: { angle: 5, grid: 0.001 } },
    { type: 'detect', detection: { angle: 5, grid: 0.001 }, selectionOnly: true, result: a.one },
    { type: 'detection', detection: { angle: 10, grid: 0.001 } }];
  const states = a.rec.events.filter((e) => e.type === 'state').map((e) => (e.state as { edgeDetection: unknown })
    .edgeDetection);
  expect(JSON.stringify(ours) === JSON.stringify(want) && /on 1 part\.$/.test(a.one) && /on [2-9]\d* parts\.$/
    .test(a.all) && JSON.stringify(states) === '[{"angle":5,"grid":0.001},{"angle":10,"grid":0.001}]',
  `recorded: ${JSON.stringify({ ours, want, states })}`);
  const tampered = structuredClone(a.rec);
  const last = tampered.events.findLast((e) => e.type === 'detect')!;
  last.result = 'Detected 1 edge segments on 1 part.';
  // The end's values otherwise: the last change left out.
  const ended = structuredClone(a.rec);
  ended.events.splice(ended.events.findLastIndex((e) => e.type === 'detection'), 1);
  const replayed = await page('?check', `(async () => {
    await cadViewer.ready;
    const detected = () => { let segs = 0; viewer.display.traverse((o) => {
      if (o.name === 'detectedEdges') segs += o.geometry.index.count / 2; }); return segs; };
    const first = await cadViewer.replay(${JSON.stringify(a.rec0)});
    const loaded = { divergences: first.divergences, segments: detected(), d: viewer.edgeDetection };
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    const d = document.querySelector('dialog.edge-detection');
    const out = { loaded, divergences: report.divergences, steps: report.steps, applied: report.applied,
      segments: detected(), stored: localStorage.getItem('cad-viewer.edgeDetection'),
      panel: d && { angle: d.querySelector('input[name=angle]').value, said: d.querySelector('p.result').textContent,
        only: d.querySelector('input[name=selection]').checked } };
    out.tampered = (await cadViewer.replay(${JSON.stringify(tampered)})).divergences;
    out.ended = (await cadViewer.replay(${JSON.stringify(ended)})).divergences;
    localStorage.removeItem('cad-viewer.edgeDetection');
    return out;
  })()`, { asIs: true, first: `localStorage.setItem('cad-viewer.edgeDetection', '{"angle":30,"grid":0.001}');` }) as
    { after: { loaded: { divergences: string[]; segments: number; d: unknown }; divergences: string[];
      steps: number; applied: number; segments: number; stored: string | null; panel: { angle: string; said: string;
      only: boolean } | null; tampered: string[]; ended: string[] } };
  const b = replayed.after, j = JSON.stringify({ b, a: { loaded: a.loaded, one: a.one, all: a.all,
    segments: a.segments } });
  expect(b.loaded.divergences.length === 0 && b.loaded.segments === a.loaded && a.loaded > 0
    && JSON.stringify(b.loaded.d) === '{"angle":5,"grid":0.001}', `the first state's values before the load: ${j}`);
  expect(b.divergences.length === 0 && b.applied === b.steps && b.segments === a.segments
    && b.stored === '{"angle":10,"grid":0.001}', `replayed as recorded, the values remembered: ${j}`);
  expect(b.panel?.angle === '10' && b.panel.said === a.one && b.panel.only === true, `the panel follows: ${j}`);
  expect(b.tampered.length === 1 && b.tampered[0]!.includes(`${a.one}, recorded Detected 1 edge segments`),
    `a run that said otherwise: ${j}`);
  expect(b.ended.length === 1 && b.ended[0]!.startsWith('the end: edgeDetection is {"angle":5'),
    `the end's values otherwise: ${j}`);
  return undefined;
});
// Look Along an Axis with Fit (first in its folder, on by default) and View's Look and fit (three steps by default):
// a view fits the selection, else the model, as it turns, ending where zoom selected (zoom all) from that direction
// would; in steps, frame by frame, a zoom out alone (the view's centre and direction kept, the height growing), an
// orbit alone (the height kept), a zoom in alone; all at once, frames turning and zooming together. Fit off: the turn
// alone; a shift-click the other way round from Fit. Iso X, Y and Z put that axis up; a Y-up file's Iso Y is the
// world's iso, its gnomon's origin asking for it. Recorded (Fit and Look and fit in the states, shift-clicks marked)
// and replayed with nothing diverging; an older recording's Iso (no Fit then) replayed as Iso Z, turning alone.
await check('look along an axis and fit', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&gnomon=1`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const ctl = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    const folder = ui.gui.foldersRecursive().find((f) => f._title === 'Look Along an Axis');
    const out = { order: folder.controllers.map((c) => c._name), fit: ctl('Fit').getValue(),
      motion: ctl('Look and fit').getValue(), motionIn: ctl('Look and fit').parent._title,
      options: [...ctl('Look and fit').$select.options].map((o) => o.textContent) };
    const press = (name, shiftKey = false) => ctl(name).$button.dispatchEvent(new MouseEvent('click',
      { bubbles: true, cancelable: true, shiftKey }));
    const cam = () => viewer.cameraState();
    const dirOf = (s) => { const d = s.position.map((x, i) => x - s.target[i]); const n = Math.hypot(...d);
      return d.map((x) => x / n); };
    const far = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
    // The view's up as drawn (perpendicular to its direction).
    const upOf = (s) => { const d = dirOf(s), k = s.up.reduce((t, x, i) => t + x * d[i], 0);
      const u = s.up.map((x, i) => x - k * d[i]), n = Math.hypot(...u); return u.map((x) => x / n); };
    // A flight's frames, each said as what changed from the last: z a zoom alone, o a turn or move alone, b both (a
    // frame across two steps' boundary also says b: left out between two others).
    const fly = async (go) => {
      viewer.flightMs = 1500;
      const frames = [cam()], layouts = [JSON.stringify(viewer.gnomon.layout)];
      go();
      for (let n = 0; viewer.flight && n < 500; n++) {
        await new Promise((r) => requestAnimationFrame(r));
        frames.push(cam());
        layouts.push(JSON.stringify(viewer.gnomon.layout));
      }
      viewer.flightMs = 0;
      await cadViewer.idle();
      frames.push(cam());
      const labels = [''];
      for (let k = 1; k < frames.length; k++) {
        const [a, b] = [frames[k - 1], frames[k]];
        const zoom = Math.abs(b.height / a.height - 1) > 1e-9;
        const turn = far(dirOf(a), dirOf(b)) > 1e-9 || far(upOf(a), upOf(b)) > 1e-9 || far(a.target, b.target) >
          1e-9 * a.height;
        labels.push(zoom && turn ? 'b' : zoom ? 'z' : turn ? 'o' : '');
      }
      let said = '';
      for (const c of labels) if (c && said[said.length - 1] !== c) said += c;
      said = said.replace(/(?<=[zo])b(?=[zo])/g, '').replace(/(.)\\1+/g, '$1');
      return { said, labels, end: cam(), first: frames[0], frames, layouts };
    };
    // The same direction's zoom selected (or zoom all), at once: where a fit should end.
    const zoomed = (selectedOnes) => { if (selectedOnes) ui.zoomSelected(); else viewer.zoomAll(); return cam(); };
    const same = (a, b) => far(a.target, b.target) < 1e-6 * b.height && Math.abs(a.height / b.height - 1) < 1e-9 &&
      far(dirOf(a), dirOf(b)) < 1e-9 && far(a.up, b.up) < 1e-9;
    const part = viewer.nodes.nodes.find((n) => n.kind === 'part');
    // Zoomed in close, off to the side, from iso: then Front with the part selected.
    viewer.setView('iso', { instant: true });
    viewer.zoomAll();
    viewer.setCamera({ ...cam(), height: cam().height / 20 });
    ui.select([part.id]);
    // (The gnomon's labels settled first: they glide after a turn.)
    await cadViewer.idle();
    await new Promise((r) => setTimeout(r, 500));
    await cadViewer.idle();
    let f = await fly(() => press('Front'));
    // (In the three steps: the zoom out's frames keep the centre and the direction, growing; the orbit's keep the
    // height; the zoom in's shrink to the end.)
    // (The zoom out's: the frames saying z before any says otherwise, frames drawn twice left out.)
    // (The gnomon's labels still meanwhile: they follow the turn, which hasn't begun.)
    const outFrames = [], outLayouts = new Set();
    for (let k = 1; k < f.frames.length && f.labels[k] !== 'b' && f.labels[k] !== 'o'; k++) {
      if (f.labels[k] === 'z') outFrames.push(f.frames[k]);
      outLayouts.add(f.layouts[k]);
    }
    out.steps = { said: f.said, dir: dirOf(f.end), up: f.end.up,
      outKept: outFrames.every((c, k) => far(c.target, f.first.target) < 1e-9 * c.height &&
        far(dirOf(c), dirOf(f.first)) < 1e-9 && (!k || c.height > outFrames[k - 1].height)),
      outFrames: outFrames.length, fitted: same(f.end, zoomed(true)), gnomonStill: outLayouts.size === 1 };
    // Nothing selected: the model.
    ui.select([]);
    viewer.setCamera({ ...cam(), height: cam().height / 3 });
    f = await fly(() => press('Top'));
    out.model = { said: f.said, dir: dirOf(f.end), fitted: same(f.end, zoomed(false)) };
    // Fit off: the turn alone; shifted, a fit.
    ctl('Fit').setValue(false);
    let before = cam();
    f = await fly(() => press('Left'));
    out.off = { said: f.said, kept: far(f.end.target, before.target) < 1e-9 * before.height &&
      f.end.height === before.height, dir: dirOf(f.end) };
    viewer.setCamera({ ...cam(), height: cam().height / 4 });
    f = await fly(() => press('Right', true));
    out.offShifted = { said: f.said, fitted: same(f.end, zoomed(false)), dir: dirOf(f.end) };
    ctl('Fit').setValue(true);
    before = cam();
    f = await fly(() => press('Back', true));
    out.onShifted = { said: f.said, kept: far(f.end.target, before.target) < 1e-9 * before.height &&
      f.end.height === before.height };
    // Simultaneous: turning and zooming together, to the same end.
    ctl('Look and fit').setValue('together');
    ui.select([part.id]);
    viewer.setCamera({ ...cam(), height: cam().height / 20 });
    f = await fly(() => press('Bottom'));
    out.together = { said: f.said, fitted: same(f.end, zoomed(true)), dir: dirOf(f.end) };
    ctl('Look and fit').setValue('steps');
    // The iso views: that axis up (as1's are the world's), at once.
    out.isos = ['Iso X', 'Iso Y', 'Iso Z'].map((v) => { press(v); return { up: upOf(cam()), dir: dirOf(cam()) }; });
    // Recorded: a fit, a shifted press, Look and fit changed, another fit; then an older kind's Iso (Fit off).
    viewer.setView('iso', { instant: true });
    viewer.setCamera({ ...cam(), height: cam().height / 5 });
    cadViewer.record(true);
    press('Front');
    await cadViewer.idle();
    // (As the user changes it: setValue isn't a finished change, which recordings keep.)
    const select = ctl('Look and fit').$select;
    select.selectedIndex = [...select.options].findIndex((o) => o.textContent === 'Simultaneous');
    select.dispatchEvent(new Event('change'));
    press('Top');
    await cadViewer.idle();
    // (Last, so the end's camera says whether it was replayed shifted, from a camera a fit would change: a call,
    // which recordings keep.)
    cadViewer.apply({ camera: { ...cam(), height: cam().height * 3 } });
    press('Iso Y', true);
    await cadViewer.idle();
    out.rec = cadViewer.record(false);
    ctl('Look and fit').setValue('steps');
    ctl('Fit').setValue(false);
    viewer.setView('front', { instant: true });
    cadViewer.record(true);
    press('Iso Z');
    await cadViewer.idle();
    out.old = cadViewer.record(false);
    ctl('Fit').setValue(true);
    return out;
  })()`) as { after: Record<string, unknown> & { rec: { events: Record<string, unknown>[] };
    old: { events: Record<string, unknown>[] } } };
  const a = r.after as Record<string, any>, j = JSON.stringify({ ...a, rec: undefined, old: undefined });
  const near = (x: number[], y: number[]) => x.every((v, i) => Math.abs(v - y[i]!) < 1e-9);
  const s3 = 1 / Math.sqrt(3);
  expect(a.order.join() === 'Fit,Front,Back,Left,Right,Top,Bottom,Iso X,Iso Y,Iso Z' && a.fit === true &&
    a.motion === 'steps' && a.motionIn === 'View' && a.options.join() === 'Sequential,Simultaneous',
  `the controls: ${j}`);
  expect(a.steps.said === 'zoz' && a.steps.outKept && a.steps.outFrames > 1 && a.steps.fitted && a.steps.gnomonStill &&
    near(a.steps.dir, [0, -1, 0]), `three steps: out, orbit, in, ending as zoom selected: ${j}`);
  expect(a.model.fitted && near(a.model.dir, [0, 0, 1]) && /o/.test(a.model.said), `nothing selected: the model: ${j}`);
  expect(a.off.said === 'o' && a.off.kept && near(a.off.dir, [-1, 0, 0]), `Fit off: the turn alone: ${j}`);
  expect(a.offShifted.fitted && near(a.offShifted.dir, [1, 0, 0]), `Fit off, shifted: fitted: ${j}`);
  expect(a.onShifted.said === 'o' && a.onShifted.kept, `Fit on, shifted: the turn alone: ${j}`);
  expect(a.together.said.includes('b') && a.together.fitted && near(a.together.dir, [0, 0, -1]),
    `all at once: turning and zooming together, the same end: ${j}`);
  // (Up as drawn: the axis less its part along the view, (2, -1, -1) / sqrt 6 for X seen from (1, 1, 1).)
  const s6 = 1 / Math.sqrt(6);
  expect(near(a.isos[0].up, [2 * s6, -s6, -s6]) && near(a.isos[1].up, [-s6, 2 * s6, -s6]) &&
    near(a.isos[2].up, [-s6, s6, 2 * s6]) && near(a.isos[0].dir, [s3, s3, s3]) && near(a.isos[1].dir, [s3, s3, s3]) &&
    near(a.isos[2].dir, [s3, -s3, s3]), `Iso X, Y, Z: that axis up: ${j}`);
  const controls = a.rec.events.filter((e: Record<string, unknown>) => e.type === 'control').map((e:
    Record<string, unknown>) => `${e.path}${e.value === undefined ? '' : '=' + e.value}${e.shift ? ' shift' : ''}`);
  const states = a.rec.events.filter((e: Record<string, unknown>) => e.type === 'state').map((e:
    Record<string, any>) => e.state.views);
  expect(controls.join('|') === 'View/Look Along an Axis/Front|View/Look and fit=together|' +
    'View/Look Along an Axis/Top|View/Look Along an Axis/Iso Y shift' && JSON.stringify(states) ===
    '[{"fit":true,"motion":"steps"},{"fit":true,"motion":"together"}]',
  `recorded: ${JSON.stringify({ controls, states })}`);
  // An older recording: its Iso, no Fit or Look and fit in its states.
  const old = structuredClone(a.old);
  for (const e of old.events) {
    if (e.type === 'control') e.path = 'View/Look Along an Axis/Iso';
    if (e.type === 'state') delete (e.state as Record<string, unknown>).views;
  }
  const replayed = await page('?check', `(async () => {
    await cadViewer.ready;
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    const views = ui.views();
    const legacy = await cadViewer.replay(${JSON.stringify(old)});
    const legacyViews = ui.views();
    // The end's Fit otherwise: said.
    const ended = ${JSON.stringify(a.rec)};
    ended.events.findLast((e) => e.type === 'state').state.views.fit = false;
    const tampered = (await cadViewer.replay(ended)).divergences;
    return { report, views, legacy, legacyViews, tampered };
  })()`) as { after: Record<string, any> };
  const b = replayed.after, k = JSON.stringify(b);
  expect(b.report.divergences.length === 0 && b.report.applied === b.report.steps && b.views.motion === 'together',
    `replayed: ${k}`);
  expect(b.legacy.divergences.length === 0 && b.legacyViews.fit === false, `an older recording's Iso: ${k}`);
  expect(b.tampered.length === 1 && b.tampered[0].startsWith('the end: views is {"fit":true'),
    `the end's Fit otherwise: ${k}`);
  // A Y-up file: Iso Y the world's iso, which the gnomon's origin asks for.
  const glb = await page(`?url=${encodeURIComponent('/content/as1.glb')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    viewer.setView('front', { instant: true });
    const asked = viewer.gnomonView('iso');
    ui.gui.controllersRecursive().find((c) => c._name === 'Fit').setValue(false);
    ui.gui.controllersRecursive().find((c) => c._name === 'Iso Y').$button.click();
    const s = viewer.cameraState();
    const d = s.position.map((x, i) => x - s.target[i]), n = Math.hypot(...d);
    return { asked, dir: d.map((x) => x / n), up: s.up };
  })()`) as { after: { asked: string; dir: number[]; up: number[] } };
  // (Fit off: the view's up as given, not made perpendicular.)
  expect(glb.after.asked === 'isoY' && near(glb.after.dir, [s3, -s3, s3]) && near(glb.after.up, [0, 0, 1]),
    `a Y-up file: Iso Y is the world's iso: ${JSON.stringify(glb.after)}`);
  return undefined;
});
await check('keyboard shortcuts', async () => {
  // (Other checks' keys forgotten first, before the page's scripts: they're in the same browser, and the hints must
  // show here for the mouse alone.)
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const calls = [];
    const zoomAll = viewer.zoomAll, zoomSelected = ui.zoomSelected, setView = viewer.setView;
    viewer.zoomAll = function (...a) { calls.push('all'); return zoomAll.apply(this, a); };
    ui.zoomSelected = function (...a) { calls.push('selected'); return zoomSelected.apply(this, a); };
    viewer.setView = function (v, ...a) { calls.push(v); return setView.call(this, v, ...a); };
    const lookAlong = viewer.lookAlong;
    viewer.lookAlong = function (v, ...a) { calls.push('fit ' + v); return lookAlong.call(this, v, ...a); };
    // A key pressed on what has the focus (else the page): whether its default was prevented.
    const key = (k, o = {}, on = document.activeElement ?? document.body) => !on.dispatchEvent(new KeyboardEvent(
      'keydown', { key: k, bubbles: true, cancelable: true, ...o }));
    const take = () => calls.splice(0);
    const out = {};
    const part = viewer.nodes.nodes.find((n) => n.kind === 'part');
    const path = viewer.nodes.pathOf(part.id);
    const hidden = () => cadViewer.state().hidden.includes(path);
    const control = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    // (Their folders open, to be measured.)
    for (const f of ui.gui.foldersRecursive()) {
      if (['View', 'Look Along an Axis', 'Rendering', 'Tree', 'Selection'].includes(f._title)) f.open();
    }
    out.hints = ui.gui.controllersRecursive().flatMap((c) => {
      const k = c.$name.querySelector('.cv-key');
      // (A mouse here: shown, whatever keyboard was seen.)
      return k ? [[c._name, k.textContent, +getComputedStyle(k).opacity < 1 && getComputedStyle(k).display !== 'none'
        && matchMedia('(any-pointer: fine)').matches && !document.documentElement.classList.contains('cv-keyboard'),
        c.$name.textContent === c._name + k.textContent,
        c.$name.clientWidth > 0 && c.$name.scrollWidth <= c.$name.clientWidth]] : [];
    });
    ui.select([]);
    out.f = [key('f'), take()];
    ui.select([part.id]);
    out.fSelected = [key('f'), take()];
    out.views = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((k) => key(k));
    out.viewCalls = take();
    // Shift with a digit: Fit the other way (its key's code; the character is shifted); Fit off, the other way again.
    out.shifted = [key('!', { code: 'Digit1', shiftKey: true }), key('(', { code: 'Digit9', shiftKey: true }),
      key(')', { code: 'Digit0', shiftKey: true })];
    control('Fit').setValue(false);
    out.shifted.push(key('@', { code: 'Digit2', shiftKey: true }), key('3'));
    control('Fit').setValue(true);
    out.shiftedCalls = take();
    out.h = [key('h'), hidden()];
    out.s = [key('s'), hidden()];
    out.escape = [key('Escape'), ui.selected().length];
    ui.select([part.id]);
    const tree0 = control('Show the tree').getValue();
    key('t');
    const tree1 = control('Show the tree').getValue();
    key('t');
    out.tree = [tree0, tree1, control('Show the tree').getValue()];
    const edges = () => viewer.render.triangleEdges;
    out.g = [edges()];
    for (let i = 0; i < 2; i++) { key('g'); out.g.push(edges()); }
    ui.select([]);
    for (let i = 0; i < 2; i++) { key('g'); out.g.push(edges()); }
    out.control = control('Triangle edges').getValue();
    // e: picking faces, edges, curves and vertices, the tree's detail and Vertices on; again, parts, both off; from
    // the assembly level, the detail level again.
    const detail = () => [ui.selection.level, control('Faces, edges, curves, vertices').getValue(),
      viewer.render.vertices, ui.tree().detail].join(' ');
    out.e = [detail()];
    for (let i = 0; i < 2; i++) { key('e'); out.e.push(detail()); }
    ui.setPickLevel('assembly');
    key('e');
    out.e.push(detail());
    key('e');
    // Left alone: a text field's, modified, shifted, repeated.
    const input = document.createElement('input');
    document.body.append(input);
    out.ignored = [key('f', {}, input), key('f', { ctrlKey: true }), key('f', { metaKey: true }),
      key('f', { altKey: true }), key('F', { shiftKey: true }), key('f', { repeat: true }), key('x')];
    input.remove();
    out.ignoredCalls = take();
    // Recorded as the controls they press.
    cadViewer.record(true);
    key('1');
    key('!', { code: 'Digit1', shiftKey: true });
    key('t');
    key('t');
    key('g');
    key('g');
    key('e');
    key('e');
    const rec = cadViewer.record(false);
    out.recorded = rec.events.filter((e) => e.type === 'control').map((e) => e.path + (e.value === undefined ? ''
      : '=' + e.value) + (e.shift ? ' shift' : ''));
    take();
    viewer.zoomAll = zoomAll;
    ui.zoomSelected = zoomSelected;
    viewer.setView = setView;
    viewer.lookAlong = lookAlong;
    // (The keyboard these keys said there is forgotten: later pages start without it.)
    localStorage.removeItem('cad-viewer.keyboard');
    return out;
  })()`, { first: `localStorage.removeItem('cad-viewer.keyboard');` }) as { after: { f: [boolean, string[]];
    fSelected: [boolean, string[]]; views: boolean[]; viewCalls: string[]; shifted: boolean[];
    shiftedCalls: string[]; e: string[];
    h: [boolean, boolean]; s: [boolean, boolean]; escape: [boolean, number]; tree: boolean[]; g: string[];
    control: string; ignored: boolean[];
    ignoredCalls: string[]; recorded: string[]; hints: [string, string, boolean, boolean, boolean][] } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.f[0] && a.f[1].join() === 'all' && a.fSelected[0] && a.fSelected[1].join() === 'selected',
    `f: zoom all with nothing selected, zoom selected with something: ${j}`);
  expect(a.views.join() === 'true,true,true,true,true,true,true,true,true,false' && a.viewCalls.join() ===
    'fit front,fit back,fit left,fit right,fit top,fit bottom,fit isoX,fit isoY,fit isoZ',
  `1 to 9: the views, in order, fitting: ${j}`);
  expect(a.shifted.join() === 'true,true,false,true,true' && a.shiftedCalls.join() ===
    'front,isoZ,fit back,left', `shift: Fit the other way: ${j}`);
  expect(a.h.join() === 'true,true' && a.s.join() === 'true,false', `h hides the selection, s shows it: ${j}`);
  expect(a.escape.join() === 'true,0', `Escape: nothing selected: ${j}`);
  expect(a.tree[0] !== a.tree[1] && a.tree[0] === a.tree[2], `t: the tree shown or not: ${j}`);
  expect(a.g.join() === 'off,selected,off,all,off' && a.control === 'off',
    `g: off to selected with a selection, to all without; back to off: ${j}`);
  expect(a.e.join() === 'part false false false,detail true true true,part false false false,detail true true true',
    `e: the detail level, the tree's detail and Vertices, or back to parts: ${j}`);
  expect(a.ignored.every((x) => !x) && a.ignoredCalls.length === 0,
    `none in a text field, with a modifier, repeated, or unbound: ${j}`);
  expect(a.hints.map((h) => h.slice(0, 2).join(' ')).join() === 'Zoom all f,Zoom selected f,Front 1,Back 2,Left 3,'
    + 'Right 4,Top 5,Bottom 6,Iso X 7,Iso Y 8,Iso Z 9,Show the tree t,Faces, edges, curves, vertices e,Pick e,'
    + 'Select none Esc,Hide selected h,Show selected s,Vertices e,Triangle edges g'
    && a.hints.every((h) => h[2] && h[3] && h[4]), `each control's key shown, greyed, after its name (whole): ${j}`);
  expect(a.recorded.join('|') === 'View/Look Along an Axis/Front|View/Look Along an Axis/Front shift|'
    + 'Tree/Show the tree=false|Tree/Show the tree=true|'
    + 'Rendering/Triangle edges=all|Rendering/Triangle edges=off|Selection/Pick=detail|'
    + 'Tree/Faces, edges, curves, vertices=true|Rendering/Vertices=true|Selection/Pick=part|'
    + 'Tree/Faces, edges, curves, vertices=false|Rendering/Vertices=false', `recorded as their controls: ${j}`);
  return undefined;
});
// The keys' hints on a touch screen with no mouse or trackpad (an emulated phone): hidden, until a key is pressed
// outside a text field (a physical keyboard: an on-screen one shows only for a text field), then shown, and still in
// the next page (remembered in the browser); a key typed in a text field doesn't count. (Other checks' keys forgotten
// first: they're in the same browser.)
await check('key hints on touch screens', async () => {
  const shown = `(() => getComputedStyle(ui.gui.controllersRecursive().find((c) => c._name === 'Zoom all')
    .$name.querySelector('.cv-key')).display !== 'none')()`;
  const key = (on: string) => `${on}.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))`;
  const first = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    const out = { fine: matchMedia('(any-pointer: fine)').matches, before: ${shown} };
    const input = document.createElement('input');
    document.body.append(input);
    ${key('input')};
    out.typed = ${shown};
    input.remove();
    ${key('document.body')};
    out.after = ${shown};
    out.remembered = localStorage.getItem('cad-viewer.keyboard');
    return out;
  })()`, { phone: true, first: `localStorage.removeItem('cad-viewer.keyboard');` }) as { after: { fine: boolean; before: boolean; typed: boolean; after: boolean;
    remembered: string | null } };
  const next = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    const out = { shown: ${shown} };
    localStorage.removeItem('cad-viewer.keyboard');
    return out;
  })()`, { phone: true }) as { after: { shown: boolean } };
  const a = first.after, j = JSON.stringify({ ...a, next: next.after });
  expect(!a.fine && !a.before && !a.typed, `no mouse: hidden, a key in a text field too: ${j}`);
  expect(a.after && a.remembered === '1' && next.after.shown, `a key elsewhere: shown, and remembered: ${j}`);
  return undefined;
});
// The controls' folders: File has Link to this view..., one fullscreen button and Theme before About...; View its
// zooms, Axes and the views alone; Selection, after picking and selecting, Details, hiding and showing, transparency;
// Rendering ends with Custom background and its picker. The fullscreen button says which way it goes: pressed (as a
// user's gesture), the page full screen and the button Exit fullscreen; pressed again, back, Enter fullscreen.
await check('control folders', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true, userGesture: true }, sessionId)) as { result: { value: unknown } })
    .result.value;
  const press = `(async () => {
    const before = !!document.fullscreenElement;
    ui.gui.controllersRecursive().find((c) => c.parent._title === 'File' && /fullscreen$/.test(c._name)).$button
      .click();
    for (let i = 0; i < 100 && !!document.fullscreenElement === before; i++) await new Promise((r) => setTimeout(r, 20));
    // (Its label changes on fullscreenchange, which comes at the next frame: later under load.)
    const label = () => ui.gui.controllersRecursive().find((c) => c.parent._title === 'File' &&
      /fullscreen$/.test(c._name))._name;
    const want = document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen';
    for (let i = 0; i < 100 && label() !== want; i++) await new Promise((r) => setTimeout(r, 20));
    const b = ui.gui.controllersRecursive().find((c) => c.parent._title === 'File' && /fullscreen$/.test(c._name));
    return { full: !!document.fullscreenElement, label: b._name, shown: b.$name.textContent };
  })()`;
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const folder = (t) => ui.gui.foldersRecursive().find((f) => f._title === t).controllers.map((c) => c._name);
    const b = ui.gui.controllersRecursive().find((c) => c._name === 'Enter fullscreen');
    return { file: folder('File'), view: folder('View'), selection: folder('Selection'),
      rendering: folder('Rendering').slice(-2), enabled: !!b && !b._disabled && document.fullscreenEnabled };
  })()`, { then: async (sessionId) => {
    const on = await evaluate(sessionId, press);
    const off = await evaluate(sessionId, press);
    return { on, off };
  } }) as { after: { file: string[]; view: string[]; selection: string[]; rendering: string[]; enabled: boolean };
    then: { on: { full: boolean; label: string; shown: string }; off: { full: boolean; label: string;
      shown: string } } };
  const a = r.after, t = r.then, j = JSON.stringify({ a, t });
  expect(a.file.join() === 'Open file...,Load URL...,Save original...,Export...,Screenshot...,Link to this view...,'
    + 'Enter fullscreen,About...,Theme', `File: ${j}`);
  expect(a.view.join() === 'Zoom all,Zoom selected,Axes,Cube,Look and fit',
    `View: its zooms, Axes, Cube and Look and fit (and the views' folder): ${j}`);
  expect(a.selection.slice(-9).join() === 'Details,Hide selected,Show selected,Hide others,Show others,Show all,'
    + 'Opacity,Make transparent,Restore opacity' && a.selection[0] === 'Pick', `Selection: ${j}`);
  expect(a.rendering.join() === 'Custom background,Background', `Rendering ends with the background: ${j}`);
  expect(a.enabled && t.on.full && t.on.label === 'Exit fullscreen' && t.on.shown === 'Exit fullscreen'
    && !t.off.full && t.off.label === 'Enter fullscreen' && t.off.shown === 'Enter fullscreen',
    `one fullscreen button, saying which way it goes: ${j}`);
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
// widest drawn so far (scrolling down to a wider row widens the range, and back doesn't narrow it); with room enough,
// no horizontal scroll bar, and rows as wide as the panel. The widest row, the nut's long name, is one the tree
// doesn't draw until scrolled to, whatever the font.
await check('tree scrolls sideways', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1-long-name.stp')}&check`, `(async () => {
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
        fill: rows.every((r) => r.offsetWidth >= scroller.clientWidth),
        long: rows.some((r) => r.querySelector('.tree-name').textContent.includes(${JSON.stringify(longName)})) };
    };
    ui.setTree({ open: true, detail: true });
    ui.panel().expandAll();
    document.documentElement.style.setProperty('--side', '140px');
    await frames();
    const narrow = look();
    scroller.scrollLeft = scroller.scrollWidth;
    await frames();
    const scrolled = scroller.scrollLeft > 0;
    // Down the tree (to the long name's row: every edge and vertex a row, the tree is long) and back: the widest so
    // far kept.
    const ranges = [narrow.range], longs = [narrow.long];
    const long = viewer.nodes.nodes.find((n) => n.name.includes(${JSON.stringify(longName)})).id;
    for (const to of ['long', scroller.scrollHeight, 0]) {
      if (to === 'long') ui.panel().scrollToRow(long, 0);
      else scroller.scrollTop = to;
      await frames();
      const l = look();
      ranges.push(l.range);
      longs.push(l.long);
    }
    document.documentElement.style.setProperty('--side', '900px');
    await frames();
    return { narrow, scrolled, ranges, longs, wide: look() };
  })()`) as { after: { narrow: { overflow: boolean; widths: number; clipped: number; rows: number };
    scrolled: boolean; ranges: number[]; longs: boolean[];
    wide: { overflow: boolean; widths: number; clipped: number; fill: boolean } } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.narrow.rows > 10 && a.narrow.overflow && a.scrolled && a.narrow.clipped === 0 && a.narrow.widths === 1,
    `narrow: ${j}`);
  // (The fixture: the long name not drawn at first, drawn once scrolled to.)
  expect(!a.longs[0] && a.longs.some((x) => x), `the long name drawn only when scrolled to: ${j}`);
  const rs = a.ranges;
  expect(rs.at(-1)! > rs[0]! && rs.every((x, i) => i === 0 || x >= rs[i - 1]!) && rs.at(-1) === Math.max(...rs),
    `the range widened by the long name and kept while scrolling down and back: ${j}`);
  expect(!a.wide.overflow && a.wide.clipped === 0 && a.wide.widths === 1 && a.wide.fill, `wide: ${j}`);
  return undefined;
});
// The status line stays while a load is under way, however long it says nothing new (a file held back here; a slow
// part's meshing alike), a spinner before its text, and fades 5 s after the load ends, the spinner gone.
await check('status kept while loading', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const status = document.getElementById('status');
    const faded = () => status.classList.contains('faded');
    const fetch0 = window.fetch;
    window.fetch = async (...a) => (await wait(6500), fetch0(...a));
    const t = performance.now();
    const loaded = cadViewer.load('/content/as1.stp');
    await wait(6000);
    const spinner = () => getComputedStyle(status, '::before').animationName;
    const out = { during: faded(), text: status.textContent, busy: status.classList.contains('busy'),
      spinning: spinner() };
    await loaded;
    window.fetch = fetch0;
    out.ended = faded();
    out.busyAfter = status.classList.contains('busy');
    out.spinningAfter = spinner();
    out.seconds = (performance.now() - t) / 1000;
    await wait(5600);
    out.after = faded();
    return out;
  })()`);
  const j = JSON.stringify(r.after);
  const o = r.after as { during: boolean; text: string; busy: boolean; spinning: string; ended: boolean;
    busyAfter: boolean; spinningAfter: string; after: boolean };
  expect(!o.during && /loading/.test(o.text), `shown while the file is held back: ${j}`);
  expect(!o.ended && o.after, `faded 5 s after the load: ${j}`);
  expect(o.busy && o.spinning === 'status-spin' && !o.busyAfter && o.spinningAfter === 'none',
    `a spinner while loading, none after: ${j}`);
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
    // On by default.
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
      // (Each one's part: a face's above its faces group.)
      detailParents: [...new Set(detail.map((id) => {
        let p = n.nodes[id].parent;
        while (n.nodes[p].kind !== 'part') p = n.nodes[p].parent;
        return n.pathOf(p);
      }))].sort(),
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
  // (What a click selects at the detail level: a face, or the group of the lines or dots clicked.)
  expect(a.tree.detail && a.detailCount > a.shown.length && a.kinds.join() === 'edges,face,vertices' &&
    a.detailHidden === 0 &&
    JSON.stringify(a.detailParents) === JSON.stringify(a.shownPaths), `detail: ${j}`);
  return undefined;
});
// About... (File): the authors, Marsette Vona first; the license; the repository's link; in a build, licenses.md's
// and the README's and STEP tutorial's PDFs, which are there; no model open, or the model's file, objects and
// triangles.
await check('about', async () => {
  const about = (query: string) => page(query, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
    const d = await new Promise((res) => { const f = () => { const e = document.querySelector('dialog.cv-dialog[open]');
      if (e) res(e); else setTimeout(f, 50); }; f(); });
    // (Links that act in the page, as Client details, apart.)
    const links = [...d.querySelectorAll('a')].filter((a) => a.getAttribute('href') !== '#').map((a) => ({
      href: a.href, target: a.target, rel: a.rel }));
    const licenses = links.find((l) => /licenses\.md$/.test(l.href));
    const status = licenses ? (await fetch(licenses.href)).status : undefined;
    const pdfs = links.filter((l) => /\.pdf$/.test(l.href));
    const pdf = pdfs.length ? await Promise.all(pdfs.map((l) => fetch(l.href).then(async (r) => ({
      name: l.href.split('/').pop(), status: r.status,
      magic: new TextDecoder().decode((await r.arrayBuffer()).slice(0, 5)) })))) : undefined;
    const pdfLine = [...d.querySelectorAll('p')].find((p) => p.querySelector('a[href$=".pdf"]'))?.textContent;
    // (The line saying the server has another version hidden, as it hasn't: the update badge check.)
    const text = [...d.querySelectorAll(':is(h2, p, table, .buttons):not([hidden])')].map((e) => e.textContent)
      .join('');
    const rows = [...d.querySelectorAll('tr')].map((r) => [...r.cells].map((c) => c.textContent));
    d.querySelector('.buttons button').click();
    await new Promise((res) => setTimeout(res, 100));
    return { title: d.querySelector('h2').textContent, text, links, status, pdf, pdfLine, closed: !d.isConnected, rows,
      triangles: viewer.stats()?.triangles, folders: ui.gui.foldersRecursive().map((f) => f._title) };
  })()`) as Promise<{ after: { title: string; text: string; links: { href: string; target: string; rel: string }[];
    status?: number; pdf?: { name: string; status: number; magic: string }[]; pdfLine?: string; closed: boolean;
    rows: string[][]; triangles?: number; folders: string[] } }>;
  const a = (await about('?check')).after;
  const m = (await about(`?url=${encodeURIComponent('/content/as1.stp')}&check`)).after;
  const j = JSON.stringify({ a, m });
  expect(/No model open\./.test(a.text) && !a.rows.length && !a.folders.includes('Model'), `no model: ${j}`);
  expect(m.rows[0]?.join() === 'File,as1.stp' && m.rows[1]?.[0] === 'Objects' &&
    m.rows[2]?.join() === `Triangles,${m.triangles!.toLocaleString()}` && m.triangles! > 0, `as1 open: ${j}`);
  expect(a.title === 'cad-io-js CAD viewer' && /By Marsette Vona and Claude \(Anthropic\)\./.test(a.text) &&
    /AGPL-3\.0-only/.test(a.text) && /LGPL-2\.1/.test(a.text) && /CC BY-SA 4\.0/.test(a.text), `the text: ${j}`);
  expect(a.links.some((l) => l.href === 'https://github.com/martyvona/cad-io-js') &&
    a.links.every((l) => l.target === '_blank' && l.rel === 'noopener'), `the links: ${j}`);
  expect(base === '/' ? a.status === undefined : a.status === 200, `licenses.md (a build's only): ${j}`);
  expect(base === '/' ? a.pdf === undefined : a.pdfLine === 'PDF documentation and STEP tutorial.' &&
    JSON.stringify(a.pdf?.map((p) => p.name)) === '["README.pdf","step_tutorial.pdf"]' &&
    a.pdf!.every((p) => p.status === 200 && p.magic === '%PDF-'), `the PDFs (a build's only): ${j}`);
  expect(a.closed, `closed: ${j}`);
  return undefined;
});
// Client details (About's link, client-info.ts): this browser, device and GPU as text to copy, what a recording carries
// too (its `client`): the device class, the browser read from the user agent, the screen and window, input, WebGL's
// version, GPU and limits, features; nothing identifying (no language, time zone or address); Copy copies it (the
// clipboard stubbed).
await check('client details', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    cadViewer.record(true);
    const rec = cadViewer.record(false);
    const frame = () => new Promise((res) => setTimeout(res, 50));
    const open = async () => { for (let t = 0; t < 100; t++) { const all = document.querySelectorAll(
      'dialog.cv-dialog[open]'); if (all.length) return all[all.length - 1]; await frame(); } };
    ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
    const about = await open();
    [...about.querySelectorAll('a')].find((a) => a.textContent === 'Client details').click();
    await frame();
    const d = await open();
    const area = d.querySelector('textarea.client-info');
    const copy = [...d.querySelectorAll('button')].find((b) => b.textContent === 'Copy');
    // (The clipboard stubbed: a headless page has no gesture to grant it.)
    let copied;
    navigator.clipboard.writeText = async (t) => { copied = t; };
    copy.click();
    for (let t = 0; t < 40 && copy.textContent !== 'Copied'; t++) await frame();
    const out = { title: d.querySelector('h2 span')?.textContent, text: area?.value, readOnly: area?.readOnly,
      copied: copy.textContent, copiedText: copied, client: rec.client, language: navigator.language,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone, ua: navigator.userAgent, dpr: devicePixelRatio,
      threads: navigator.hardwareConcurrency, device: viewer.detectedDevice,
      gl2: viewer.renderer.getContext() instanceof WebGL2RenderingContext, page: location.href };
    d.querySelector('button.close').click();
    await frame();
    about.querySelector('.buttons button').click();
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify({ ...a, text: undefined });
  const lines = new Map((a.text as string).split('\n').filter((l) => !l.startsWith('  ')).map((l) => {
    const k = l.indexOf(': ');
    return [l.slice(0, k), l.slice(k + 2)] as const;
  }));
  const want: Record<string, string> = { 'device.detected': a.device, 'device.inUse': a.device,
    'browser.name': 'Chrome', 'browser.engine': 'Blink', 'browser.userAgent': a.ua, 'screen.pixelRatio': String(a.dpr),
    'hardware.threads': String(a.threads), 'webgl.version': a.gl2 ? 'WebGL 2.0' : 'WebGL 1.0',
    'features.webAssembly': 'true' };
  const wrong = Object.entries(want).filter(([k, v]) => !(lines.get(k) ?? '').startsWith(v));
  expect(a.title === 'Client details' && a.readOnly && wrong.length === 0 && /^webgl\.limits\.maxTextureSize: \d+$/m
    .test(a.text) && /^webgl\.extensions: \(\d+\)$/m.test(a.text) && /^webgl\.renderer: \S/m.test(a.text) &&
    /^webgl\.gpu: \S/m.test(a.text) &&
    /^screen\.width: \d+$/m.test(a.text) && /^input\.pointer: /m.test(a.text), `the dialog: ${JSON.stringify(wrong)} ${
    a.text}`);
  expect(a.copied === 'Copied' && a.copiedText === a.text, `copied: ${j}`);
  // The recording's: the same fields.
  const c = a.client;
  expect(!!c && c.device?.detected === a.device && c.browser?.name === 'Chrome' && c.webgl?.version ===
    lines.get('webgl.version') && c.webgl?.renderer === lines.get('webgl.renderer') && c.hardware?.threads ===
    a.threads && Array.isArray(c.webgl?.extensions) && c.webgl.extensions.length > 0, `the recording's: ${j}`);
  // Nothing identifying: no language, time zone or address, in either.
  const json = JSON.stringify(c);
  const keyed = /"(languages?|timeZone|timezone|locale)"/i.test(json) || /(^|\.)(languages?|timeZone|locale): /im
    .test(a.text);
  expect(!keyed && !json.includes(a.zone) && !a.text.includes(a.zone) && !json.includes(a.page) && !/[?&]/.test(json),
    `nothing identifying: ${j}`);
  return undefined;
});
// Model Details (About's details link): the author after the file's name (a placeholder not), the file's metadata
// over About as rows, read-only (no fields, nothing editable, no button but its x), its text selected by dragging the
// mouse (the dialog not moved); closed by its x or Escape, About still open; nothing but the format said so.
await check('model details', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
  // About opened, and where its details link is (clicked with the mouse: a dialog opened without a user's gesture is
  // grouped with the one before by Chrome's close watchers, and Escape closes both).
  const open = `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    window.wait = async (f) => { for (let t = 0; t < 400; t++) { const v = f(); if (v) return v;
      await new Promise((res) => setTimeout(res, 25)); } };
    ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
    const about = await wait(() => document.querySelector('dialog.cv-dialog[open]'));
    const file = [...about.querySelectorAll('tr')].find((r) => r.cells[0].textContent === 'File')?.cells[1]
      .textContent;
    const lead = [...about.querySelectorAll('p')].find((p) => p.querySelector('a[href="#"]'));
    const l = lead.querySelector('a').getBoundingClientRect();
    window.details = { about, href: location.href };
    return { file, lead: lead.textContent, link: { x: (l.left + l.right) / 2, y: (l.top + l.bottom) / 2 } };
  })()`;
  const shown = `(async () => {
    const about = details.about;
    const d = await wait(() => [...document.querySelectorAll('dialog.cv-dialog[open]')].find((e) => e !== about));
    const td = [...d.querySelectorAll('tr')].find((r) => r.cells[0].textContent === 'Time stamp')?.cells[1];
    const r = td?.getBoundingClientRect();
    details.d = d;
    details.top = d.getBoundingClientRect().top;
    return { title: d.querySelector('h2 span').textContent,
      rows: [...d.querySelectorAll('tr')].map((row) => [...row.cells].map((c) => c.textContent)),
      texts: [...d.querySelectorAll('p')].map((p) => p.textContent),
      controls: d.querySelectorAll('input, select, textarea, [contenteditable]').length,
      buttons: [...d.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
      buttonRow: !!d.querySelector('.buttons'), address: location.href === details.href,
      cell: r ? { x0: r.left + 1, x1: r.right - 1, y: (r.top + r.bottom) / 2, text: td.textContent,
        onTop: document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)?.closest('dialog') === d }
        : null };
  })()`;
  type Opened = { file: string; lead: string; link: { x: number; y: number } };
  type Shown = { title: string; rows: string[][]; texts: string[]; controls: number; buttons: string[];
    buttonRow: boolean; address: boolean;
    cell: { x0: number; x1: number; y: number; text: string; onTop: boolean } | null };
  // Then: the link clicked, what it shows, a drag across a value and what it selected, and the dialog closed (its x,
  // or Escape).
  const then = (how: 'x' | 'escape') => async (sessionId: string, after: unknown) => {
    const mouse = (type: string, x: number, y: number, buttons: number) => send('Input.dispatchMouseEvent', { type,
      x, y, button: 'left', buttons, clickCount: 1 }, sessionId);
    const { link } = after as Opened;
    await mouse('mousePressed', link.x, link.y, 1);
    await mouse('mouseReleased', link.x, link.y, 0);
    const s = await evaluate(sessionId, shown) as Shown;
    const c = s.cell;
    let selected: string | undefined;
    if (c) {
      await mouse('mousePressed', c.x0, c.y, 1);
      for (let k = 1; k <= 8; k++) await mouse('mouseMoved', c.x0 + (c.x1 - c.x0) * k / 8, c.y, 1);
      await mouse('mouseReleased', c.x1, c.y, 0);
      selected = await evaluate(sessionId, 'getSelection().toString()') as string;
    }
    const moved = await evaluate(sessionId, 'details.d.getBoundingClientRect().top !== details.top');
    if (how === 'x') await evaluate(sessionId, `details.d.querySelector('button.close').click()`);
    else {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape',
        code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    }
    const closed = await evaluate(sessionId, `(async () => { await new Promise((res) => setTimeout(res, 200));
      return { details: !details.d.isConnected, about: details.about.isConnected && details.about.open }; })()`);
    return { ...s, selected, moved, closed };
  };
  type Then = Shown & { selected?: string; moved: boolean; closed: { details: boolean; about: boolean } };
  const run = async (file: string, how: 'x' | 'escape') => {
    const r = await page(`?url=${encodeURIComponent(`/content/${file}`)}&check`, open, { then: then(how) }) as
      { after: Opened; then: Then };
    return { ...r.after, ...r.then };
  };
  const a = await run('as1-authored.stp', 'x');
  const p = await run('as1.stp', 'escape');
  const b = await run('bare.json', 'escape');
  const j = JSON.stringify({ a, p, b });
  const row = (r: Shown, l: string) => r.rows.find(([k]) => k === l)?.[1];
  expect(a.file === 'as1-authored.stp (Ann B)' && p.file === 'as1.stp' && b.file === 'bare.json',
    `the author after the name: ${j}`);
  expect(a.lead === 'Current model (details, errors/warnings):' && a.title === 'Model Details',
    `the link and title: ${j}`);
  expect(row(a, 'Format') === 'step' && row(a, 'Name') === 'Open CASCADE Shape Model' &&
    row(a, 'Time stamp') === '2017-03-30T11:06:14' && row(a, 'Author') === 'Ann B' &&
    row(a, 'Authors') === 'Ann B\nnone' && row(a, 'Organizations') === 'Open CASCADE' &&
    row(a, 'Originating system') === 'Open CASCADE 7.1' && row(a, 'Authorization') === 'Unknown' &&
    !a.texts.length, `the metadata: ${j}`);
  expect(row(p, 'Author') === undefined && row(p, 'Authors') === 'Author', `a placeholder author: ${j}`);
  expect(a.controls === 0 && JSON.stringify(a.buttons) === '["Close"]' && !a.buttonRow, `read-only: ${j}`);
  // (The link's href, #, not followed: the address holds the view.)
  expect(a.address && b.address, `the address kept: ${j}`);
  expect(!!a.cell?.onTop && a.selected === a.cell.text && !a.moved, `its text selected by a drag: ${j}`);
  expect(a.closed.details && a.closed.about && p.closed.details && p.closed.about, `closed, About still open: ${j}`);
  expect(JSON.stringify(b.rows) === '[["Format","threejs"]]' &&
    JSON.stringify(b.texts) === '["No additional details available."]', `nothing but the format: ${j}`);
  return undefined;
});
// Mirrored and sheared placements (as1-transforms.json), read rigid, their stretches baked into copies of the parts:
// a mirrored part picked on its near side where it's drawn, as an unmirrored one is, its placement a rotation (this
// file's parts are drawn both sides: the copy's winding is cad-scene's rigid.test.ts's); its Details and Model Details
// saying what's stretched; the export dialog warning of nothing.
await check('transforms', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1-transforms.json')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const wait = async (f) => { for (let t = 0; t < 400; t++) { const v = f(); if (v) return v;
      await new Promise((res) => setTimeout(res, 25)); } };
    const m = ui.panel().model;
    const near = async (name) => {
      const n = m.nodes.find((k) => k.kind === 'part' && k.name === name);
      ui.select([n.id]);
      ui.hideOthers();
      // (Edges off: the circle at the far end of a nut's hole, seen through it, is picked within a few pixels.)
      ui.setRender({ edges: false });
      await cadViewer.idle();
      // (A placed part's object holds its mesh.)
      const o = n.object.children.find((c) => c.isMesh);
      o.geometry.computeBoundingSphere();
      const c = o.geometry.boundingSphere.center.clone().applyMatrix4(o.matrixWorld);
      const at = c.clone().project(viewer.camera);
      // The pixel nearest the centre on the part's front, nearer than its centre (the centre is in its hole, which can
      // be clear through, and next to the hole its far wall shows): none if its faces were drawn inside out.
      let hit, depth;
      const R = viewer.renderer.domElement.getBoundingClientRect();
      for (let r = 0; r < 40 && !hit; r++) for (let k = 0; k < 8 && !hit; k++) {
        const h = cadViewer.pickAt((at.x + 1) / 2 + r * Math.cos(k * Math.PI / 4) / R.width, (1 - at.y) / 2 + r *
          Math.sin(k * Math.PI / 4) / R.height);
        const d = h && c.clone().set(...h.point).project(viewer.camera).z;
        if (h?.path?.endsWith(name) && d < at.z) [hit, depth] = [h, d];
      }
      ui.selection.details = true;
      const stretched = ui.details().find((l) => l.startsWith('Stretched: ')) ?? null;
      ui.showAll();
      ui.select([]);
      ui.setRender({ edges: true });
      await cadViewer.idle();
      return { det: Math.sign(o.matrixWorld.determinant()), path: hit?.path, near: hit ? depth < at.z : null,
        stretched };
    };
    const mirrored = await near('nut_1'), plain = await near('nut_2');
    // Model Details.
    ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
    const about = await wait(() => document.querySelector('dialog.cv-dialog[open]'));
    [...about.querySelectorAll('a')].find((a) => a.textContent === 'details').click();
    const d = await wait(() => [...document.querySelectorAll('dialog.cv-dialog[open]')].find((e) => e !== about));
    const rows = [...d.querySelectorAll('tr')].map((row) => [...row.cells].map((c) => c.textContent))
      .filter(([k]) => k === 'Stretched parts' || k === 'Transforms');
    d.close();
    about.close();
    await new Promise((res) => setTimeout(res, 50));
    // The export dialog, for each format.
    ui.gui.controllersRecursive().find((c) => c._name === 'Export...').$button.click();
    const e = await wait(() => document.querySelector('dialog.cv-dialog[open]'));
    const format = e.querySelector('select[data-key=format]');
    const warned = {};
    for (const f of ['glb', 'gltf', 'threejs', '3mf']) {
      format.value = f;
      format.dispatchEvent(new Event('change'));
      warned[f] = [...e.querySelectorAll('p.warning')].filter((p) => !p.hidden).map((p) => p.textContent).join(' ')
        || null;
    }
    [...e.querySelectorAll('.buttons button')].find((b) => b.textContent === 'Cancel').click();
    return { mirrored, plain, rows, warned };
  })()`) as { after: { mirrored: { det: number; path?: string; near: boolean | null; stretched: string | null };
    plain: { det: number; path?: string; near: boolean | null; stretched: string | null }; rows: string[][];
    warned: Record<string, string | null> } };
  const a = r.after;
  const j = JSON.stringify(a);
  expect(a.mirrored.det > 0 && !!a.mirrored.path?.endsWith('nut_1') && a.mirrored.near === true &&
    a.plain.det > 0 && !!a.plain.path?.endsWith('nut_2') && a.plain.near === true, `picked where drawn: ${j}`);
  expect(/^Stretched: a mirrored copy of \S/.test(a.mirrored.stretched ?? '') && a.plain.stretched === null,
    `Details: ${j}`);
  expect(JSON.stringify(a.rows) === '[["Stretched parts","1 mirrored, 1 sheared"]]', `Model Details: ${j}`);
  expect(Object.values(a.warned).every((w) => w === null), `the export dialog: ${j}`);
  return undefined;
});
// Load demo model... (About): About closed, the catalog fetched (each time, past the cache), a model a row with its
// size; Load loads the chosen one by its content path, which is chosen again next time; Cancel loads nothing; a
// catalog that can't be fetched or read is said, Load disabled.
await check('demo models', async () => {
  // A demo directory of the check's own, its catalog written by the script deploy-viewer.sh and deploy-demo.sh run.
  const demo = path.join(content, 'demo');
  fs.mkdirSync(path.join(demo, 'sub'), { recursive: true });
  fs.copyFileSync(path.join(content, 'as1.glb'), path.join(demo, 'as1.glb'));
  fs.copyFileSync(step, path.join(demo, 'sub', 'as1 copy.stp'));
  fs.writeFileSync(path.join(demo, 'notes.txt'), 'not a model');
  writeCatalog(demo);
  const catalog = JSON.parse(fs.readFileSync(path.join(demo, 'catalog.json'), 'utf8')) as
    { models: { path: string; size: number }[] };
  // (Written independently of formatSize: both are between 1 kB and 1 MB.)
  const rows = catalog.models.map((m) => {
    if (m.size < 1e3 || m.size >= 999_950) throw new Error(`a demo model this check can't size: ${m.path}`);
    return `${m.path} (${(Math.round(m.size / 100) / 10).toFixed(1)}k)`;
  });
  expect(JSON.stringify(catalog.models.map((m) => m.path)) === '["as1.glb","sub/as1 copy.stp"]',
    `the catalog: ${JSON.stringify(catalog)}`);
  const r = await page('?check', `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const wait = async (f, ms = 60000) => { for (let t = 0; t < ms / 50; t++) { const v = f(); if (v) return v;
      await new Promise((res) => setTimeout(res, 50)); } return undefined; };
    const fetched = [];
    const realFetch = window.fetch.bind(window);
    let broken;
    window.fetch = (u, o) => { fetched.push({ url: String(u), cache: o?.cache });
      return broken ? broken() : realFetch(u, o); };
    const picker = async () => {
      ui.gui.controllersRecursive().find((c) => c._name === 'About...').$button.click();
      const about = await wait(() => document.querySelector('dialog.cv-dialog[open]'));
      const button = [...about.querySelectorAll('.buttons button')].find((b) => b.textContent === 'Load demo model...');
      button.click();
      await wait(() => !about.isConnected);
      const d = await wait(() => document.querySelector('dialog.cv-dialog[open]'));
      const select = d.querySelector('select');
      const load = d.querySelector('.buttons button.primary');
      const said = () => d.querySelector('p').textContent;
      const early = { load: load.disabled, select: select.disabled, said: said() };
      await wait(() => !said().startsWith('Fetching'), 10000);
      return { aboutClosed: !about.isConnected, title: d.querySelector('h2').textContent, early, d, select, load, said,
        options: [...select.options].map((o) => o.textContent), value: select.value };
    };
    const first = await picker();
    const chosen = first.select.options[first.select.options.length - 1].value;
    first.select.value = chosen;
    first.load.click();
    const loaded = await wait(() => viewer.model?.name === chosen.split('/').pop() && !viewer.loading);
    await cadViewer.idle();
    const again = await picker();
    const kept = again.value;
    again.d.querySelector('.buttons button:not(.primary)').click();
    await wait(() => !again.d.isConnected);
    // (A load would fetch the model again.)
    await new Promise((res) => setTimeout(res, 1000));
    const modelFetches = fetched.filter((f) => f.url.includes('/content/demo/sub/')).length;
    broken = () => Promise.resolve(new Response('nope', { status: 404 }));
    const missing = await picker();
    const missingSaid = { said: missing.said(), load: missing.load.disabled, failed: missing.d.querySelector('p')
      .classList.contains('failed') };
    missing.d.querySelector('.buttons button:not(.primary)').click();
    // (Slow, so the dialog is seen while it waits.)
    broken = () => new Promise((res) => setTimeout(() => res(new Response('{"no": 1}', { status: 200 })), 500));
    const garbled = await picker();
    const garbledSaid = { said: garbled.said(), load: garbled.load.disabled, early: garbled.early };
    garbled.d.querySelector('.buttons button:not(.primary)').click();
    window.fetch = realFetch;
    const catalogs = fetched.filter((f) => f.url.endsWith('/content/demo/catalog.json'));
    return { first: { aboutClosed: first.aboutClosed, title: first.title, early: first.early, said: first.said(),
      options: first.options }, chosen, loaded: !!loaded, url: cadViewer.state().model?.url, kept, modelFetches, missingSaid,
      garbledSaid, catalogs: catalogs.length, noStore: catalogs.every((f) => f.cache === 'no-store') };
  })()`) as { after: { first: { aboutClosed: boolean; title: string; early: object;
    said: string; options: string[] }; chosen: string; loaded: boolean; url?: string; kept: string;
    modelFetches: number;
    missingSaid: { said: string; load: boolean; failed: boolean }; garbledSaid: { said: string; load: boolean;
    early: { load: boolean; select: boolean; said: string } };
    catalogs: number; noStore: boolean } };
  const a = r.after;
  const j = JSON.stringify({ a, rows });
  expect(a.first.aboutClosed && a.first.title === 'Load Demo Model', `the dialog: ${j}`);
  expect(rows.length > 0 && JSON.stringify(a.first.options) === JSON.stringify(rows) &&
    a.first.said === `${rows.length} demo models:`, `the list: ${j}`);
  expect(a.loaded && a.chosen === catalog.models[catalog.models.length - 1]!.path &&
    String(a.url).endsWith('/content/demo/sub/as1%20copy.stp'), `loaded: ${j}`);
  expect(a.kept === a.chosen, `chosen again: ${j}`);
  expect(a.modelFetches === 1, `loaded once, Cancel loading nothing: ${j}`);
  expect(/^Could not fetch the list of demo models: there is no catalog \(404\)\.$/.test(a.missingSaid.said) &&
    a.missingSaid.load && a.missingSaid.failed, `no catalog: ${j}`);
  expect(/not a catalog/.test(a.garbledSaid.said) && a.garbledSaid.load, `not a catalog: ${j}`);
  expect(a.garbledSaid.early.load && a.garbledSaid.early.select && /^Fetching/.test(a.garbledSaid.early.said),
    `while fetching: ${j}`);
  expect(a.catalogs === 4 && a.noStore, `fetched each time, past the cache: ${j}`);
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
// Rendering's Custom background: off, the theme's; on, the picker's colour (drawn, and the page's --view-bg behind the
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
// Hovering in the tree: the row under the mouse in the highlight's colour (text dark on yellow, light on blue), its
// node highlighted in the 3D view as hovering there would (a part outlined, a face outlined by its ranges, an edge
// marked, an edges group marked whole); rows scrolled under a still mouse; none once the mouse leaves.
await check('tree hover', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 20)));
    const p = ui.panel(), m = p.model, scroller = document.querySelector('#tree .tree-scroller');
    p.setDetail(true);
    p.expandAll();
    await frame();
    const rowOf = async (id) => {
      p.scrollToRow(id, 0);
      await frame();
      return [...document.querySelectorAll('#tree .tree-row')].find((x) => +x.dataset.id === id);
    };
    const move = (x, y, pointerType = 'mouse') => scroller.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, clientX: x, clientY: y, pointerType }));
    const over = async (id) => {
      const b = (await rowOf(id)).getBoundingClientRect();
      move(b.left + 10, b.top + b.height / 2);
      await frame();
    };
    const state = () => {
      const rows = [...document.querySelectorAll('#tree .tree-row.hovered')].filter((x) => x.style.display !== 'none');
      const h = viewer.highlights.highlight;
      const part = (o) => { let n = m.nodeOf(o); while (n !== undefined && m.nodes[n].kind !== 'part')
        n = m.nodes[n].parent; return n; };
      return { rows: rows.map((x) => +x.dataset.id), bg: rows[0] && getComputedStyle(rows[0]).backgroundColor,
        fg: rows[0] && getComputedStyle(rows[0]).color,
        outline: h.outline.map((x) => ({ part: part(x.object), ranges: x.ranges?.length ?? 0 })),
        marks: h.marks.map((x) => ({ part: part(x.object), ranges: x.ranges?.length ?? 0 })) };
    };
    const kind = (k) => m.nodes.find((n) => n.kind === k).id;
    const partId = kind('part'), face = kind('face'), edge = kind('edge'), edges = kind('edges');
    const out = { partId, face, edge, edges, faceOf: m.partOf(face), edgeOf: m.partOf(edge), edgesOf: m.partOf(edges) };
    await over(partId);
    out.part = state();
    await over(face);
    out.faceRow = state();
    await over(edge);
    out.edgeRow = state();
    await over(edges);
    out.edgesRow = state();
    // Scrolled a row under the still mouse: the next row hovered.
    scroller.scrollTop += 18;
    await frame();
    await frame();
    out.scrolled = state();
    ui.setRender({ highlightColor: '#1f3fff' });
    await frame();
    out.blue = state();
    ui.setRender({ highlightColor: '#ffe100' });
    scroller.dispatchEvent(new PointerEvent('pointerleave', { clientX: 0, clientY: 0, pointerType: 'mouse' }));
    await frame();
    out.left = state();
    // A touch moving over the tree: no hover.
    const b = (await rowOf(partId)).getBoundingClientRect();
    move(b.left + 10, b.top + b.height / 2, 'touch');
    await frame();
    out.touch = state();
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after;
  const j = (o: unknown) => JSON.stringify(o);
  const one = (s: { rows: number[] }, id: number) => s.rows.length === 1 && s.rows[0] === id;
  expect(one(a.part, a.partId) && a.part.bg === 'rgb(255, 225, 0)' && a.part.fg === 'rgb(17, 17, 17)' &&
    a.part.outline.length > 0 && a.part.outline.every((x: { part: number; ranges: number }) => x.part === a.partId &&
    x.ranges === 0) && a.part.marks.length === 0, `a part's row: ${j(a.part)}`);
  expect(one(a.faceRow, a.face) && a.faceRow.outline.length === 1 && a.faceRow.outline[0].part === a.faceOf &&
    a.faceRow.outline[0].ranges > 0 && a.faceRow.marks.length === 0, `a face's row: ${j(a.faceRow)}`);
  expect(one(a.edgeRow, a.edge) && a.edgeRow.outline.length === 0 && a.edgeRow.marks.length === 1 &&
    a.edgeRow.marks[0].part === a.edgeOf && a.edgeRow.marks[0].ranges === 1, `an edge's row: ${j(a.edgeRow)}`);
  expect(one(a.edgesRow, a.edges) && a.edgesRow.outline.length === 0 && a.edgesRow.marks.length > 0 &&
    a.edgesRow.marks.every((x: { part: number; ranges: number }) => x.part === a.edgesOf && x.ranges === 0),
    `the edges group's row: ${j(a.edgesRow)}`);
  expect(a.scrolled.rows.length === 1 && a.scrolled.rows[0] !== a.edges && a.scrolled.marks.length +
    a.scrolled.outline.length > 0 && j(a.scrolled.marks) !== j(a.edgesRow.marks), `scrolled: ${j(a.scrolled)}`);
  expect(a.blue.bg === 'rgb(31, 63, 255)' && a.blue.fg === 'rgb(255, 255, 255)', `blue: ${j(a.blue)}`);
  expect(a.left.rows.length === 0 && a.left.outline.length === 0 && a.left.marks.length === 0,
    `the mouse gone: ${j(a.left)}`);
  expect(a.touch.rows.length === 0 && a.touch.outline.length === 0, `touch: ${j(a.touch)}`);
  return undefined;
});
// Hover highlights (outline.ts): the mouse over a part outlines it in the highlight's colour, outside the part (nothing
// strong over its own pixels), dim where another part is in front (an x-ray: the bracket's outline behind the rod); at
// the detail level a face outlined, an edge marked (thin and fat edges), a vertex marked (Vertices on); a drag, or the
// mouse gone, nothing.
await check('hover highlights', async () => {
  const frames = '(async () => { for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); ' +
    'await settled(); })()';
  // The canvas drawn now against `base`: changed pixels by how far each moved toward the highlight's colour (1: all
  // the way), strong (over 0.7) or dim (0.15 to 0.5) with no strong pixel beside it (not a line in sight's
  // antialiased edge: an x-ray), and the strong ones over the hovered placement's own ids.
  const SCAN = `globalThis.scan = (own) => {
    const c = viewer.renderer.domElement; viewer.snapshot();
    const g = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height }).getContext('2d');
    g.drawImage(c, 0, 0); const px = g.getImageData(0, 0, c.width, c.height).data;
    if (!globalThis.base) return (globalThis.base = px, {});
    const t = viewer.idPass.target, ids = new Uint8Array(4 * t.width * t.height);
    viewer.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, ids);
    const h = parseInt(viewer.render.highlightColor.slice(1), 16), was = globalThis.base;
    const tone = [h >> 16, (h >> 8) & 255, h & 255];
    let changed = 0, strong = 0, dim = 0, inside = 0;
    const strength = new Float32Array(c.width * c.height);
    for (let i = 0; i < px.length; i += 4) {
      const d = Math.abs(px[i] - was[i]) + Math.abs(px[i + 1] - was[i + 1]) + Math.abs(px[i + 2] - was[i + 2]);
      const all = Math.abs(tone[0] - was[i]) + Math.abs(tone[1] - was[i + 1]) + Math.abs(tone[2] - was[i + 2]);
      strength[i / 4] = d < 12 ? 0 : d / Math.max(1, all);
    }
    const besideStrong = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (strength[(y + dy) * c.width + x + dx] > 0.7) return true; } return false; };
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = 4 * (y * c.width + x);
      const d = Math.abs(px[i] - was[i]) + Math.abs(px[i + 1] - was[i + 1]) + Math.abs(px[i + 2] - was[i + 2]);
      if (d < 12) continue;
      changed++;
      const all = Math.abs(tone[0] - was[i]) + Math.abs(tone[1] - was[i + 1]) + Math.abs(tone[2] - was[i + 2]);
      const s = d / Math.max(1, all);
      if (s > 0.7) strong++;
      else if (s > 0.15 && s < 0.5 && !besideStrong(x, y)) dim++;
      const k = 4 * ((c.height - 1 - y) * t.width + x);
      const id = (ids[k] | ids[k + 1] << 8 | ids[k + 2] << 16 | ids[k + 3] << 24) >>> 0;
      const at = id && viewer.idPass.ids.resolve(id);
      if (own && s > 0.7 && at && at.placement === own) inside++;
    }
    // The marked pieces' lines' length on the canvas (device pixels).
    let length = 0;
    const p = new viewer.camera.position.constructor(), q = p.clone();
    for (const { object, ranges } of viewer.highlights.highlight.marks) {
      const pos = object.geometry.attributes.position, index = object.geometry.index;
      const xy = (v, i) => v.fromBufferAttribute(pos, index.getX(i)).applyMatrix4(object.matrixWorld)
        .project(viewer.camera).multiply({ x: c.width / 2, y: c.height / 2, z: 1 });
      for (const r of ranges ?? []) for (let i = r.start; i + 1 < r.start + r.count; i += 2) {
        length += xy(p, i).distanceTo(xy(q, i + 1));
      }
    }
    return { changed, strong, dim, inside, length, outline: viewer.highlights.outlinePieces.length,
      marks: viewer.highlights.group.children.length };
  }`;
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    ${SCAN};
    const m = ui.panel().model, rect = viewer.renderer.domElement.getBoundingClientRect();
    const at = (x, y) => [rect.left + x * rect.width, rect.top + y * rect.height];
    // A spot on the left bracket (behind the rod), and one on an edge, by picks over the view; a vertex's spot once
    // they're shown.
    let spot, edge;
    for (let y = 0.2; y < 0.8 && !spot; y += 0.02) for (let x = 0.2; x < 0.8 && !spot; x += 0.02) {
      const hit = viewer.pickAt(...at(x, y));
      if (hit?.object.isMesh && hit.faceIndex !== undefined && /bracket/.test(hit.object.name)) spot = at(x, y);
    }
    for (let y = 0.2; y < 0.8 && !edge; y += 0.01) for (let x = 0.2; x < 0.8 && !edge; x += 0.01) {
      const hit = viewer.pickAt(...at(x, y));
      if (hit?.item !== undefined && hit.object.name === 'edges') edge = at(x, y);
    }
    scan();
    globalThis.first = globalThis.base;
    return { spot, edge };
  })()`, { then: async (sessionId, after) => {
    const a = after as { spot?: [number, number]; edge?: [number, number] };
    const ev = async (expression: string) => ((await send('Runtime.evaluate', { expression, returnByValue: true,
      awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
    const mouse = (type: string, [x, y]: [number, number], buttons = 0) => send('Input.dispatchMouseEvent',
      { type, x, y, buttons, ...(type !== 'mouseMoved' || buttons ? { button: 'left', clickCount: 1 } : {}) },
      sessionId);
    // Moved there, and what it's over found (frames, in software rendering).
    // (Not settled while a button's down: the view isn't idle while it's dragged.)
    const over = async (p: [number, number], buttons = 0) => {
      await mouse('mouseMoved', p, buttons);
      await ev(`(async () => { for (let i = 0; i < 100 && viewer.hoverQueued; i++) await new Promise((r) =>
        requestAnimationFrame(r)); ${buttons ? 'for (let i = 0; i < 5; i++) await new Promise((r) => ' +
        'requestAnimationFrame(r));' : `await ${frames};`} })()`);
    };
    const shot = async (name: string) => {
      if (!process.env.SHOTS) return;
      // (The canvas, not the tab: with tab captures between them, later moves weren't found as hover.)
      const data = (await ev('viewer.snapshot()') as string).split(',')[1]!;
      fs.mkdirSync(process.env.SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.SHOTS, `hover-${name}.png`), Buffer.from(data, 'base64'));
    };
    const out: Record<string, unknown> = {};
    if (!a.spot || !a.edge) return out;
    // Off the canvas: over the controls.
    const gui = await ev(`(() => { const b = ui.gui.domElement.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + 10]; })()`) as [number, number];
    // (In blue, which no part here is near: strength is measured toward the highlight's colour. 1.5 CSS pixels wide,
    // so the line in sight doesn't cover the x-ray behind the rod.)
    await ev(`(globalThis.width0 = viewer.render.highlightWidth, ui.setRender({ highlightColor: '#1f6fff',
      highlightWidth: 1.5 }))`);
    await over(a.spot);
    await shot('part');
    out.part = await ev(`scan(viewer.pickAt(${a.spot}).object)`);
    // The width and the colour as set: more strong pixels wider; as many in magenta.
    const strong = (r: string) => ev(`(async () => { ui.setRender(${r}); await ${frames}; return scan().strong; })()`);
    out.widths = [await strong('{ highlightWidth: 1.5 }'), await strong('{ highlightWidth: 6 }')];
    out.magenta = await strong(`{ highlightWidth: 1.5, highlightColor: '#ff00ff' }`);
    await strong(`{ highlightWidth: width0, highlightColor: '#1f6fff' }`);
    await ev(`ui.setPickLevel('detail')`);
    await ev(frames);
    await shot('face');
    out.face = await ev('scan()');
    await over(a.edge);
    await shot('edge');
    out.edge = await ev('scan()');
    await ev(`(ui.setRender({ edgeStyle: 'fat' }), ${frames})`);
    await over([a.edge[0] + 1, a.edge[1]]);
    out.fat = await ev(`viewer.highlights.group.children.map((c) => c.type)`);
    await ev(`(ui.setRender({ edgeStyle: 'thin' }), ${frames})`);
    // Vertices shown: one picked over the view (at its point) marked.
    const vertex = await ev(`(async () => {
      ui.setRender({ vertices: true });
      await ${frames};
      const rect = viewer.renderer.domElement.getBoundingClientRect();
      let found;
      viewer.display.traverse((o) => {
        if (found || o.name !== 'vertices' || !o.visible) return;
        const p = new viewer.camera.position.constructor();
        for (let i = 0; i < o.geometry.attributes.position.count && !found; i++) {
          p.fromBufferAttribute(o.geometry.attributes.position, i).applyMatrix4(o.matrixWorld).project(viewer.camera);
          const xy = [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height];
          if (viewer.pickAt(...xy)?.object.name === 'vertices') found = xy;
        }
      });
      return found;
    })()`) as [number, number] | undefined;
    if (vertex) {
      await over(vertex);
      await shot('vertex');
      out.vertex = await ev(`viewer.highlights.group.children.map((c) => c.type)`);
      // Against the frame with Vertices on and the mouse away: the dot larger (its disc 3 CSS pixels across, the
      // mark's 7).
      await over(gui);
      await ev('(base = undefined, scan())');
      await over(vertex);
      out.dot = await ev('scan()');
    }
    // Gone: off the canvas (over the controls), the frame as it was before any.
    await ev(`(ui.setRender({ vertices: false }), ui.setPickLevel('part'), base = first, ${frames})`);
    await over(a.spot);
    await over(gui);
    out.gone = await ev(`(() => { const s = scan(); return { changed: s.changed, outline: s.outline,
      marks: s.marks }; })()`);
    // Hidden edges aren't drawn into the lines' ids (on the faces' depth): at the pixels of the plate's segments'
    // middles more than 2 mm behind the face drawn there (picked with edges off), the lines' ids are the plate's
    // edges' only where a visible one crosses (a few). (A pick there can still give an edge in sight within reach,
    // its point nearest the ray perhaps in its hidden part.)
    out.hidden = await ev(`(async () => {
      ui.setPickLevel('detail');
      const m = ui.panel().model, rect = viewer.renderer.domElement.getBoundingClientRect();
      const plate = m.nodes.find((n) => n.kind === 'part' && /plate/.test(n.name)).object;
      const edges = plate.getObjectByName('edges'), pos = edges.geometry.attributes.position;
      const index = edges.geometry.index, V = viewer.camera.position.constructor;
      const look = viewer.camera.getWorldDirection(new V());
      const middles = [];
      for (let i = 0; i + 1 < index.count; i += 2) {
        const a = new V().fromBufferAttribute(pos, index.getX(i)), b = new V().fromBufferAttribute(pos,
          index.getX(i + 1));
        middles.push(a.add(b).multiplyScalar(0.5).applyMatrix4(edges.matrixWorld));
      }
      const xy = (p) => { const q = p.clone().project(viewer.camera);
        return [rect.left + (q.x + 1) / 2 * rect.width, rect.top + (1 - q.y) / 2 * rect.height]; };
      ui.setRender({ edges: false });
      await ${frames};
      const behind = middles.filter((p) => {
        const f = viewer.pickAt(...xy(p));
        return f?.object.isMesh && p.dot(look) - f.point.dot(look) > 2;
      });
      ui.setRender({ edges: true });
      await ${frames};
      viewer.pickAt(...xy(behind[0] ?? middles[0]));
      const k = viewer.idPass.target.width / rect.width;
      const drawn = behind.filter((p) => {
        const [x, y] = xy(p), w = viewer.idPass.readWindow(viewer.renderer, viewer.idPass.lines,
          Math.floor((x - rect.left) * k), Math.floor((rect.bottom - y) * k), 1, 1);
        return viewer.idPass.ids.resolve(w.ids[0] ?? 0)?.object === edges;
      });
      return { middles: middles.length, behind: behind.length, drawn: drawn.length };
    })()`);
    // A part cut, alone: its silhouette in sight along its cap too (the id drawn there its own), not dim.
    out.cut = await ev(`(async () => {
      ui.setPickLevel('part');
      const m = ui.panel().model;
      const plate = m.nodes.find((n) => n.kind === 'part' && /plate/.test(n.name));
      ui.setHidden(m.nodes.filter((n) => n.kind === 'part' && n !== plate).map((n) => n.id), true);
      const mesh = plate.object.children[0], V = viewer.camera.position.constructor;
      mesh.geometry.computeBoundingBox();
      const centre = mesh.geometry.boundingBox.getCenter(new V()).applyMatrix4(mesh.matrixWorld);
      viewer.setSections({ ...viewer.sections.get(), x: { on: true, at: centre.x, flip: false }, caps: true });
      await ${frames};
      const rect = viewer.renderer.domElement.getBoundingClientRect();
      const q = centre.clone().add(new V(-5, 0, 0)).project(viewer.camera);
      return [rect.left + (q.x + 1) / 2 * rect.width, rect.top + (1 - q.y) / 2 * rect.height];
    })()`);
    if (Array.isArray(out.cut)) {
      const at = out.cut as [number, number];
      await over(gui);
      await ev('(base = undefined, scan())');
      await over(at);
      await shot('cut');
      out.cut = await ev(`(async () => { const s = scan(); ui.showAll();
        viewer.setSections({ ...viewer.sections.get(), x: { on: false, at: 0, flip: false } });
        await ${frames}; return s; })()`);
    }
    await over(gui);
    // A part hidden whole behind another (a bracket under the plate, seen from below), outlined: all of it an
    // x-ray, dim, none strong.
    out.behind = await ev(`(async () => {
      const camera = viewer.cameraState();
      viewer.setView('bottom', { instant: true });
      await ${frames};
      base = undefined;
      scan();
      const m = ui.panel().model;
      const part = m.nodes.find((n) => n.kind === 'part' && /bracket/.test(n.name)).object.children[0];
      viewer.setHighlight({ outline: [{ object: part }], marks: [] });
      await ${frames};
      const s = scan();
      globalThis.behindShot = viewer.snapshot();
      viewer.setHighlight(undefined);
      viewer.setCamera(camera);
      base = first;
      await ${frames};
      return s;
    })()`);
    if (process.env.SHOTS) fs.writeFileSync(path.join(process.env.SHOTS, 'hover-behind.png'), Buffer.from(
      (await ev('behindShot') as string).split(',')[1]!, 'base64'));
    // Hidden and picked at once (no frame between): not picked (the ids drawn again).
    out.stale = await ev(`(() => {
      const m = ui.panel().model, hit = viewer.pickAt(...${JSON.stringify(a.spot)});
      const part = m.nodeOf(hit.object), before = m.nodes[part].object;
      ui.setHidden([part], true);
      const again = viewer.pickAt(...${JSON.stringify(a.spot)});
      ui.setHidden([part], false);
      let o = again?.object;
      while (o && o !== before) o = o.parent;
      return { before: !!hit, again: !!o };
    })()`);
    // A drag (last: it turns the view): nothing while the button's down.
    await over(a.spot);
    await mouse('mousePressed', a.spot);
    await over([a.spot[0] + 30, a.spot[1] + 20], 1);
    out.drag = await ev(`({ outline: viewer.highlights.outlinePieces.length,
      marks: viewer.highlights.group.children.length })`);
    await mouse('mouseReleased', [a.spot[0] + 30, a.spot[1] + 20]);
    return out;
  } }) as { after?: unknown; then?: Record<string, { changed: number; strong: number; dim: number; inside: number;
    length: number; outline: number; marks: number }> & { fat?: string[]; vertex?: string[]; drag?: { outline: number;
    marks: number } } };
  const t = r.then ?? {};
  const j = JSON.stringify({ after: r.after, then: t });
  expect(!!t.part && t.part.outline > 0 && t.part.strong > 50 && t.part.dim > 20 && t.part.inside === 0,
    `a part outlined, dim behind the rod, nothing strong over itself: ${j}`);
  const widths = t.widths as unknown as number[] | undefined;
  expect(!!widths && widths[1]! > 2.5 * widths[0]!, `wider as set: ${j}`);
  const magenta = t.magenta as unknown as number | undefined;
  expect(magenta !== undefined && Math.abs(magenta - t.part!.strong) < 0.2 * t.part!.strong, `in the colour set: ${j}`);
  expect(!!t.face && t.face.outline === 1 && t.face.strong > 10, `a face outlined: ${j}`);
  expect(!!t.edge && t.edge.marks === 1 && t.edge.strong > 5 && t.edge.outline === 0, `an edge marked: ${j}`);
  expect(t.fat?.join() === 'Wireframe', `a fat edge marked: ${j}`);
  expect(t.vertex?.join() === 'Points', `a vertex marked: ${j}`);
  // (A disc 3 CSS pixels across and its rim, about 20 pixels; the mark's 7 across, about 60.)
  expect(!!t.dot && t.dot.changed >= 40, `a vertex's mark larger than its dot: ${j}`);
  // (A thin edge one pixel wide; its mark 3 CSS pixels. Strong pixels: ambient occlusion changes others around it.)
  expect(t.edge!.strong >= 2 * t.edge!.length && t.edge!.length > 3, `an edge's mark wider than the edge: ${j}`);
  // (A few specks of it in sight, through the gaps around the bolts, outlined in full.)
  expect(!!t.behind && t.behind.dim > 20 && t.behind.strong < 0.1 * t.behind.dim,
    `a part hidden whole, outlined dim: ${j}`);
  const stale = t.stale as unknown as { before: boolean; again: boolean } | undefined;
  expect(stale?.before === true && stale.again === false, `a part hidden, picked at once: ${j}`);
  expect(t.drag?.outline === 0 && t.drag.marks === 0, `nothing while dragging: ${j}`);
  const hidden = t.hidden as unknown as { behind: number; drawn: number } | undefined;
  expect(!!hidden && hidden.behind > 20 && hidden.drawn <= hidden.behind / 20, `hidden edges not drawn as ids: ${j}`);
  expect(!!t.cut && t.cut.outline > 0 && t.cut.strong > 50 && t.cut.dim < t.cut.strong / 10,
    `a cut part's silhouette in sight along its cap: ${j}`);
  expect(!!t.gone && t.gone.changed === 0 && t.gone.outline === 0 && t.gone.marks === 0, `gone with the mouse: ${j}`);
  console.log(`hover highlights: ${j}`);
  return undefined;
});

// Vertices (Rendering's Vertices, vertex-points.ts): off by default; on, a disc at each B-rep vertex of each placement
// (its model's vertex table, placed by the placement's group, projected here), round and as wide as asked: thin edges'
// 1 device pixel plus 2 CSS pixels, fat ones' width 1.5 times but at least 3 CSS pixels more (measured across a disc
// with edges off, by how much it darkens each pixel), each whole where it's seen (the faces at a corner not cutting
// into it); in the edges' colour, a selection's tint too; gone with a hidden part and where a section plane cuts.
await check('vertices', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&ao=0&smaa=0&edgeStyle=fat`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const control = ui.gui.controllersRecursive().find((c) => c._name === 'Vertices');
    const out = { byDefault: viewer.render.vertices, control: control?.parent._title, checked: control?.getValue() };
    viewer.setBackground(0xffffff);
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const ratio = viewer.renderer.getPixelRatio();
    const set = (r) => ui.setRender({ ...viewer.render, ...r });
    // Each vertex of each placement in the window's device pixels (from the canvas's bottom left), with its part.
    const V3 = viewer.camera.position.constructor;
    const vertices = [];
    for (const [part, placements] of viewer.graph.placements) {
      const m = viewer.graph.modelOf(part);
      if (!m) continue;
      for (const { group } of placements) {
        for (let i = 0; i < m.vertex.point.length; i += 3) {
          const p = m.vertex.point;
          const w = new V3(p[i], p[i + 1], p[i + 2]).applyMatrix4(group.matrixWorld);
          const q = w.clone().project(viewer.camera);
          vertices.push({ part, group, world: w, x: Math.round((q.x + 1) / 2 * canvas.width - 0.5),
            y: Math.round((q.y + 1) / 2 * canvas.height - 0.5) });
        }
      }
    }
    const inView = vertices.filter((v) => v.x >= 20 && v.y >= 20 && v.x < canvas.width - 20 &&
      v.y < canvas.height - 20);
    const frame = () => {
      viewer.draw();
      const px = new Uint8Array(4 * canvas.width * canvas.height);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return (x, y) => [...px.slice(4 * (y * canvas.width + x), 4 * (y * canvas.width + x) + 3)];
    };
    const isDark = (c) => c.every((v) => v < 60);
    set({ edges: false });
    const off = frame();
    out.drawnOff = viewer.camera.layers.isEnabled(2);
    // How many vertices' own pixel is dark: on, and not before.
    const darkened = (on) => inView.filter((v) => isDark(on(v.x, v.y)) && !isDark(off(v.x, v.y)));
    set({ vertices: true });
    out.checkedOn = control.getValue();
    let on = frame();
    out.count = 0;
    viewer.display.traverse((o) => { if (o.name === 'vertices' && o.isPoints) out.count += o.geometry.index.count; });
    out.vertices = vertices.length;
    const lit = darkened(on);
    out.lit = lit.length;
    out.inView = inView.length;
    // With no faces drawn (their materials hidden), every one (wide, so a disc's centre is dark wherever it falls).
    const faces = [];
    viewer.display.traverse((o) => { if (o.isMesh) for (const m of [o.material].flat()) faces.push([m, m.visible]); });
    for (const [m] of faces) m.visible = false;
    set({ vertices: false });
    const bare = frame();
    set({ vertices: true, edgeWidth: 6 });
    const all = frame();
    set({ edgeWidth: 1.5 });
    out.unhidden = inView.filter((v) => isDark(all(v.x, v.y)) && !isDark(bare(v.x, v.y))).length;
    for (const [m, was] of faces) m.visible = was;
    // Across a disc, along a row and a column through its centre: how much of each pixel it covers (its darkening of
    // the pixel drawn without it), summed, so its rim counts in part (device pixels); the median over discs alone (no
    // other vertex within 12 pixels).
    const width = (at) => {
      const alone = lit.filter((v) => !inView.some((u) => u !== v && Math.abs(u.x - v.x) < 12 &&
        Math.abs(u.y - v.y) < 12));
      // (In linear light, where the rim is blended.)
      const linear = (c) => Math.max(...c.map((v) => ((v / 255 + 0.055) / 1.055) ** 2.4));
      const cover = (x, y) => {
        const was = linear(off(x, y)), now = linear(at(x, y));
        return was < 0.05 ? 0 : Math.min(1, Math.max(0, 1 - now / was));
      };
      const runs = alone.map((v) => {
        let a = 0, b = 0;
        for (let k = -11; k <= 11; k++) { a += cover(v.x + k, v.y); b += cover(v.x, v.y + k); }
        return [a, b];
      });
      const med = (xs) => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)];
      return { least: Math.min(...runs.flat()), alone: alone.length, across: med(runs.map((r) => r[0])),
        down: med(runs.map((r) => r[1])) };
    };
    out.thick = { edgeStyle: viewer.render.edgeStyle, edgeWidth: viewer.render.edgeWidth, ...width(on) };
    // Wide at a depth offset of 8 pixels: whole; at none, the faces cut into some.
    set({ edgeWidth: 6, depthOffset: 8 });
    out.wide = { edgeWidth: 6, ...width(frame()) };
    set({ depthOffset: 0 });
    out.flat = width(frame());
    set({ edgeStyle: 'thin' });
    out.thin = width(frame());
    out.ratio = ratio;
    set({ edgeStyle: 'fat', edgeWidth: 6 });
    // A part selected: its discs in its edges' tint (not black).
    const part = viewer.nodes.nodes.find((n) => n.kind === 'part' && lit.some((v) => v.group === n.object ||
      v.group === n.object.parent || n.object.children?.includes(v.group)));
    ui.select([part.id]);
    set({ edges: true });
    viewer.draw();
    let edges; part.object.traverse((o) => { if (!edges && o.name === 'edges') edges = o; });
    on = frame();
    const mine = lit.filter((v) => { let p = v.group; while (p && p !== part.object) p = p.parent; return !!p; });
    const tint = edges.material.color.getHex();
    out.tint = { hex: tint, mine: mine.length, coloured: mine.filter((v) => !isDark(on(v.x, v.y))).length };
    // The selection's colour as set, while selected.
    const was = viewer.render.selectionColor;
    set({ selectionColor: '#00c000' });
    out.tint.recoloured = edges.material.color.getHexString();
    set({ selectionColor: was });
    ui.select([]);
    set({ edges: false });
    // Hidden: none of its discs.
    ui.setHidden([part.id], true);
    on = frame();
    out.hidden = { mine: mine.length, dark: mine.filter((v) => isDark(on(v.x, v.y))).length };
    ui.setHidden([part.id], false);
    // Cut along X at the middle: the discs on the side cut away gone, the others still there.
    const xs = vertices.map((v) => v.world.x), mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const none = { on: false, at: 0, flip: false };
    viewer.setSections({ x: { on: true, at: mid, flip: false }, y: none, z: none, caps: false });
    on = frame();
    const plane = viewer.renderer.clippingPlanes[0];
    const away = lit.filter((v) => plane.distanceToPoint(v.world) < -0.5);
    const kept = lit.filter((v) => plane.distanceToPoint(v.world) > 0.5);
    out.cut = { planes: viewer.renderer.clippingPlanes.length, away: away.length,
      awayDark: away.filter((v) => isDark(on(v.x, v.y))).length, kept: kept.length,
      keptDark: kept.filter((v) => isDark(on(v.x, v.y))).length };
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify(a);
  expect(a.byDefault === false && a.control === 'Rendering' && a.checked === false && a.drawnOff === false,
    `off by default, its control in Rendering: ${j}`);
  expect(a.checkedOn === true && a.count === a.vertices && a.vertices > 50, `a disc for each vertex placed: ${j}`);
  expect(a.unhidden === a.inView && a.inView > 50 && a.lit > 20, `drawn at the vertices: ${j}`);
  // (Within half a pixel of what's asked.)
  const within = (w: { alone: number; across: number; down: number }, css: number) => w.alone >= 5 &&
    Math.abs(w.across - css * a.ratio) <= 0.5 && Math.abs(w.down - css * a.ratio) <= 0.5;
  expect(within(a.thick, a.thick.edgeWidth + 3) && within(a.wide, 9) && within(a.thin, 1 / a.ratio + 2),
    `as wide as asked: ${j}`);
  // (Each whole, not cut into by the faces it lies on: at a concave corner, a face rises toward the camera.)
  expect(a.wide.least >= 9 * a.ratio - 0.5, `the faces don't cut into them at 8 pixels' offset: ${j}`);
  expect(a.flat.least < a.wide.least - 1, `at none, they do: ${j}`);
  expect(a.tint.hex !== 0 && a.tint.mine > 0 && a.tint.coloured === a.tint.mine, `a selection's tint: ${j}`);
  expect(a.tint.recoloured === '00c000', `the selection's colour as set: ${j}`);
  expect(a.hidden.mine > 0 && a.hidden.dark === 0, `none for a hidden part: ${j}`);
  expect(a.cut.planes === 1 && a.cut.away > 0 && a.cut.awayDark === 0 && a.cut.kept > 0 &&
    a.cut.keptDark > a.cut.kept / 2, `cut by a section plane: ${j}`);
  return undefined;
});
// The tree's detail (Faces, edges, curves, vertices): below a part, its faces, edges and vertices groups, in that
// order, each with a node per face, edge and vertex. One edge selected: the frame changes only along that edge (its
// polyline as its part's mesh gives it, projected here), in the selection's tint, thin and fat (fat wider); one hidden:
// only along it, the rest of its part's edges drawn. One vertex selected with Vertices off: a tinted dot at its point
// (its part's B-rep model's vertex table), nothing else changed. Select by ID with an edge's id, the tree's detail off:
// that edge (the detail turned on).
await check('edges and vertices in the tree', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&ao=0&smaa=0`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const byId = (() => {
      const [part, mesh] = [...viewer.graph.meshes].find(([, x]) => x.edges?.some((e) => e.source !== null));
      const source = mesh.edges.find((e) => e.source !== null && e.kind !== 'seam').source;
      const before = viewer.nodes.hasDetail();
      ui.selectByIds(String(source));
      const sel = ui.selected().map((id) => viewer.nodes.nodes[id]);
      return { before, after: viewer.nodes.hasDetail(), n: sel.length, kinds: [...new Set(sel.map((n) => n.kind))],
        sources: [...new Set(sel.map((n) => n.item?.source))].join() === String(source),
        parts: sel.every((n) => viewer.graph.placements.get(part).some((p) => {
          let q = n.parent;
          while (viewer.nodes.nodes[q].kind !== 'part') q = viewer.nodes.nodes[q].parent;
          return viewer.nodes.nodes[q].object === p.group;
        })) };
    })();
    ui.select([]);
    const control = ui.gui.controllersRecursive().find((c) => c._name === 'Faces, edges, curves, vertices');
    control.setValue(true);
    control._callOnFinishChange();
    viewer.setBackground(0xffffff);
    const m = viewer.nodes, graph = viewer.graph;
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const V3 = viewer.camera.position.constructor;
    // (A part in view with edges and vertices: the plate, the largest.)
    const part = m.nodes.find((n) => n.kind === 'part' && n.name.startsWith('plate'));
    const groups = m.children(part.id).map((g) => m.nodes[g].kind);
    const inGroup = (kind) => m.children(m.children(part.id).find((g) => m.nodes[g].kind === kind));
    const counts = { faces: inGroup('faces').length, edges: inGroup('edges').length,
      vertices: inGroup('vertices').length };
    const index = part.object.userData.part, mesh = graph.meshes.get(index), model = graph.modelOf(index);
    const group = part.object;
    // A point of the part's mesh (its coordinates minus its origin) or model (its own) in canvas pixels.
    const toPx = (x, y, z, origin = [0, 0, 0]) => {
      const q = new V3(x + origin[0], y + origin[1], z + origin[2]).applyMatrix4(group.matrixWorld)
        .project(viewer.camera);
      return [(q.x + 1) / 2 * canvas.width, (q.y + 1) / 2 * canvas.height];
    };
    // An edge's polyline in canvas pixels, by its source id.
    const polyline = (source) => {
      const e = mesh.edges.find((x) => x.source === source), p = mesh.edgePositions;
      return Array.from({ length: e.count }, (_, i) => toPx(p[3 * (e.start + i)], p[3 * (e.start + i) + 1],
        p[3 * (e.start + i) + 2], mesh.origin));
    };
    const distTo = (pts, x, y) => {
      let d = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
      }
      return d;
    };
    const frame = () => {
      viewer.draw();
      const px = new Uint8Array(4 * canvas.width * canvas.height);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    // The pixels that differ between two frames (by more than 40 in a channel): where, and whether orange (the tint).
    const changed = (a, b) => {
      const out = [];
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (d <= 40) continue;
        const k = i / 4;
        out.push({ x: k % canvas.width + 0.5, y: Math.floor(k / canvas.width) + 0.5,
          orange: b[i] > 180 && b[i + 1] > 80 && b[i + 1] < 200 && b[i + 2] < 120 });
      }
      return out;
    };
    const set = (r) => ui.setRender({ ...viewer.render, ...r });
    // The edge: the one whose polyline is longest on screen.
    const len = (pts) => pts.reduce((t, p, i) => i ? t + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : t, 0);
    const edge = inGroup('edges').map((id) => m.nodes[id]).filter((n) => n.item.source !== null)
      .sort((a, b) => len(polyline(b.item.source)) - len(polyline(a.item.source)))[0];
    const line = polyline(edge.item.source);
    const along = (cs, within) => ({ n: cs.length, near: cs.filter((c) => distTo(line, c.x, c.y) <= within).length,
      orange: cs.filter((c) => c.orange).length });
    const out = { byId, groups, counts, path: m.pathOf(edge.id), length: len(line) };
    for (const style of ['thin', 'fat']) {
      set({ edgeStyle: style });
      ui.select([]);
      const before = frame();
      ui.select([edge.id]);
      out[style] = along(changed(before, frame()), 4 * viewer.renderer.getPixelRatio() + 3);
    }
    // Hidden: only along it (the rest of the part's edges still drawn), thin and fat (fat edges following the lines'
    // geometry without it).
    ui.select([]);
    set({ edgeStyle: 'fat' });
    const fatShown = frame();
    ui.setHidden([edge.id], true);
    out.hiddenFat = along(changed(fatShown, frame()), 4 * viewer.renderer.getPixelRatio() + 3);
    ui.setHidden([edge.id], false);
    set({ edgeStyle: 'thin' });
    const shown = frame();
    ui.setHidden([edge.id], true);
    out.hidden = along(changed(shown, frame()), 4);
    let lines; group.traverse((o) => { if (!lines && o.name === 'edges') lines = o; });
    out.edgesDrawn = lines.visible && lines.geometry.index.count > 0;
    ui.setHidden([edge.id], false);
    // A vertex, Vertices off: a dot in the tint at its point, nothing else changed.
    const vertex = inGroup('vertices').map((id) => m.nodes[id]).find((n) => n.item.source !== null);
    const row = Array.from(model.vertex.id).indexOf(vertex.item.source);
    const at = toPx(model.vertex.point[3 * row], model.vertex.point[3 * row + 1], model.vertex.point[3 * row + 2]);
    ui.select([]);
    const plain = frame();
    ui.select([vertex.id]);
    const dot = changed(plain, frame());
    out.vertex = { on: viewer.render.vertices, n: dot.length, near: dot.filter((c) => Math.hypot(c.x - at[0],
      c.y - at[1]) <= 6 * viewer.renderer.getPixelRatio()).length, orange: dot.filter((c) => c.orange).length };
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify(a);
  expect(!a.byId.before && a.byId.after && a.byId.n > 0 && a.byId.kinds.join() === 'edge' && a.byId.sources &&
    a.byId.parts, `Select by ID, an edge's: ${j}`);
  expect(a.groups.join() === 'faces,edges,vertices' && a.counts.faces > 3 && a.counts.edges > 3 &&
    a.counts.vertices > 3, `the part's groups: ${j}`);
  expect(/\/edges\/edge#\d+$/.test(a.path), `an edge's path: ${j}`);
  for (const s of ['thin', 'fat']) {
    expect(a[s].n > a.length / 2 && a[s].near === a[s].n && a[s].orange > a[s].n / 2, `${s}: only along the edge, ` +
      `in the tint: ${j}`);
  }
  expect(a.fat.n > a.thin.n * 1.3, `fat wider: ${j}`);
  expect(a.hidden.n > a.length / 3 && a.hidden.near === a.hidden.n && a.edgesDrawn, `one edge hidden: ${j}`);
  expect(a.hiddenFat.n > a.length / 3 && a.hiddenFat.near === a.hiddenFat.n, `one edge hidden, fat: ${j}`);
  expect(a.vertex.on === false && a.vertex.n > 4 && a.vertex.near === a.vertex.n && a.vertex.orange > 0,
    `a vertex selected with Vertices off: ${j}`);
  return undefined;
});
// The B-rep's geometry in the tree and Details (geometry-info.ts), against the model's own columns read here by the
// layout's numbers (cad-brep's layout.ts: SURFACE_KIND and CURVE_KIND; a placement 9 reals, then a cylinder's or a
// circle's radius): each face's and edge's icon kind its surface's or curve's (wrappers aside), shown in its row's
// icon (named in its tooltip) and in the view's context menu's header for a face picked there; Details giving a
// cylinder's and a circle's radius, a vertex's point; faces' areas the sum of each one's; a part's volume on the exact
// geometry (healed: the analysis's) near its mesh's; an assembly's the sum of its placements'.
await check('geometry in the tree and details', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/arm-ap242.step')}&check&heal=1`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    ui.setTree({ open: true, detail: true });
    const m = viewer.nodes, graph = viewer.graph;
    const SURFACES = [, 'plane', 'cylinder', 'cone', 'sphere', 'torus', 'bspline', 'extrusion', 'revolution'];
    const CURVES = [, 'line', 'circle', 'ellipse', 'hyperbola', 'parabola', 'bspline', 'polyline'];
    const parts = m.nodes.filter((n) => n.kind === 'part');
    const all = parts.flatMap((p) => m.children(p.id).flatMap((g) => m.children(g)));
    const indexOf = (id) => { let p = id; while (m.nodes[p].kind !== 'part') p = m.nodes[p].parent;
      return m.nodes[p].object.userData.part; };
    // What the model says, read here: a face's surface row and kind, an edge's curve row and kind.
    const row = (d, table, id) => Array.from(d[table].id).indexOf(id);
    const truth = (id) => {
      const n = m.nodes[id], d = graph.modelOf(indexOf(id));
      if (n.kind === 'face') { const f = row(d, 'face', n.face.source), s = d.face.surface[f];
        return { kind: SURFACES[d.surface.kind[s]], s, d }; }
      if (n.kind === 'edge') { const e = row(d, 'edge', n.item.source), c = d.edge.curve[e];
        return c < 0 ? undefined : { kind: 'curve:' + CURVES[d.curve.kind[c]], c, d }; }
    };
    let compared = 0, wrong = [];
    const kinds = new Set();
    for (const id of all) {
      const t = truth(id);
      if (!t?.kind || t.kind === 'curve:undefined') continue;
      compared++;
      kinds.add(t.kind);
      if (m.geometryKind(id) !== t.kind) wrong.push([m.pathOf(id), m.geometryKind(id), t.kind]);
    }
    const pick = (kind) => all.find((id) => truth(id)?.kind === kind);
    // Its row: the icon named by the kind.
    const rowTitle = async (id) => {
      ui.panel().select([id]);
      for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
      return document.querySelector('#tree .tree-row[data-id="' + id + '"] .tree-icon')?.title;
    };
    const cyl = pick('cylinder'), circle = pick('curve:circle');
    const out = { compared, wrong: wrong.slice(0, 5), kinds: [...kinds],
      rows: [await rowTitle(cyl), await rowTitle(circle)] };
    const d = (ids) => { ui.select(ids); return ui.details(); };
    // A cylinder's and a circle's radius: after their placements' 9 reals.
    const tc = truth(cyl), tl = truth(circle);
    out.cylRadius = tc.d.pool.surfaceReal[tc.d.surface.real[tc.s] + 9];
    out.cylLine = d([cyl]).find((l) => l.startsWith('Surface:'));
    out.circleRadius = tl.d.pool.curveReal[tl.d.curve.real[tl.c] + 9];
    out.circleLine = d([circle]).find((l) => l.startsWith('Curve:'));
    const vertex = all.find((id) => m.nodes[id].kind === 'vertex');
    const vd = graph.modelOf(indexOf(vertex)), vr = row(vd, 'vertex', m.nodes[vertex].item.source);
    out.vertexPoint = Array.from(vd.vertex.point.slice(3 * vr, 3 * vr + 3));
    out.vertexLine = d([vertex]).find((l) => l.startsWith('Point:'));
    // Areas: three faces' the sum of each one's.
    const area = (lines) => +(lines.find((l) => l.startsWith('Area on the exact geometry'))
      ?.match(/: ([0-9,.]+) mm/)?.[1].replace(/,/g, '') ?? NaN);
    const three = all.filter((id) => m.nodes[id].kind === 'face').slice(0, 3);
    out.areas = { three: area(d(three)), each: three.map((id) => area(d([id]))) };
    // Volumes: each placed part's, on the exact geometry and of the mesh; the root assembly's.
    const volume = (lines, what) => +(lines.find((l) => l.startsWith(what))?.match(/: ([0-9,.]+) mm/)?.[1]
      .replace(/,/g, '') ?? NaN);
    out.parts = parts.map((p) => { const l = d([p.id]); return [volume(l, 'Volume on the exact geometry'),
      volume(l, 'Volume of the mesh'), area(l), +(l.find((x) => x.startsWith('Triangles'))
        ?.match(/area ([0-9,.]+) mm/)?.[1].replace(/,/g, '') ?? NaN)]; });
    out.root = volume(d([m.roots[0]]), 'Volume on the exact geometry');
    // The view's context menu for a face picked there, at the detail level: its header's icon named as the face's kind.
    ui.select([]);
    cadViewer.apply({ pick: 'detail' });
    await cadViewer.idle();
    const canvas = viewer.renderer.domElement, rect = canvas.getBoundingClientRect();
    let spot;
    for (let i = 3; i < 8 && !spot; i++) for (let j = 3; j < 8 && !spot; j++) {
      const p = cadViewer.pickAt(i / 10, j / 10)?.path, id = p && m.find(p);
      if (id !== undefined && m.nodes[id].kind === 'face' && truth(id)?.kind) {
        spot = { x: rect.left + i / 10 * rect.width, y: rect.top + j / 10 * rect.height, id };
      }
    }
    const send = (type, x, y, o) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1,
      isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, ...o }));
    send('pointerdown', spot.x, spot.y, { button: 2, buttons: 2 });
    send('pointerup', spot.x, spot.y, { button: 2, buttons: 0 });
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    out.menu = { header: document.querySelector('.cv-menu .tree-icon')?.title, kind: truth(spot.id).kind };
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify(a);
  expect(a.compared > 50 && a.wrong.length === 0 && ['plane', 'cylinder', 'curve:line', 'curve:circle'].every((k) =>
    a.kinds.includes(k)), `each face's and edge's kind: ${j}`);
  expect(a.rows[0] === 'cylinder' && a.rows[1] === 'circle', `the rows' icons: ${j}`);
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-4 * Math.max(1, Math.abs(y));
  const said = (line: string | undefined, re: RegExp) => Number(line?.match(re)?.[1]?.replace(/,/g, ''));
  expect(near(said(a.cylLine, /radius ([\d,.]+) mm/), a.cylRadius) && /^Surface: cylinder, /.test(a.cylLine),
    `a cylinder's radius: ${j}`);
  expect(near(said(a.circleLine, /radius ([\d,.]+) mm/), a.circleRadius) && /^Curve: circle, /.test(a.circleLine),
    `a circle's radius: ${j}`);
  const pt = (a.vertexLine as string | undefined)?.match(/\(([^)]*)\)/)?.[1]?.split(', ').map(Number) ?? [];
  expect(pt.length === 3 && pt.every((x, i) => near(x, a.vertexPoint[i])), `a vertex's point: ${j}`);
  const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
  expect(Math.abs(a.areas.three - sum(a.areas.each)) <= 0.2 && a.areas.three > 0, `faces' area: ${j}`);
  // (Parts whose shells the oracle couldn't all measure say so: their mesh's alone. The root sums those it has.)
  const parts = a.parts as (number | null)[][], measured = parts.filter(([o]) => o !== null);
  expect(measured.length >= parts.length / 2 && parts.every(([, me]) => me != null && me > 0) &&
    measured.every(([o, me]) => Math.abs(o! - me!) <= 0.03 * o!), `each part's volume, near its mesh's: ${j}`);
  expect(Math.abs(a.root - sum(measured.map((p) => p[0]!))) <= 0.1 * parts.length, `the assembly's volume: ${j}`);
  expect(parts.every((p) => p[2]! > 0 && Math.abs(p[2]! - p[3]!) <= 0.02 * p[2]!), `each part's area, near its ` +
    `mesh's: ${j}`);
  expect(a.menu.header === a.menu.kind.replace('curve:', ''), `the view's menu's header: ${j}`);
  return undefined;
});
// The axes gnomon (gnomon.ts): drawn in its box (#gnomon) over the view, X red, Y green, Z blue; each axis's
// direction on the screen the world's axis as the main camera shows it (from the camera itself, not the gnomon's), in
// the iso view and after turning to the front; drawn whatever the section planes cut; gone when View's Axes is off;
// never in pictures of the model alone; a GLB's own axes (Y up).
await check('axes gnomon', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&gnomon=1`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const dpr = canvas.width / canvas.clientWidth;
    const frames = async () => { for (let f = 0; f < 3; f++) await new Promise((res) => requestAnimationFrame(res)); };
    const kind = (r, g, b) => r > 180 && g < 120 && b < 120 ? 0 : g > 140 && r < 110 && b < 110 ? 1
      : b > 200 && r < 140 && g < 180 ? 2 : -1;
    // The axes' colours in the whole canvas, as device pixels from its bottom left: each colour's count and centroid in
    // the box, and how many outside it less as many as the same frame has without the gnomon (the model's own).
    const axes = () => {
      const on = drawn(), was = viewer.showGnomon;
      viewer.showGnomon = false;
      const off = drawn();
      viewer.showGnomon = was;
      // (The box's corners lie outside the gnomon's sphere: as they'd be without it, nothing cleared there.)
      const kept = on.corners.every((c, i) => c === off.corners[i]);
      return { axes: on.axes, box: on.box, outside: on.outside - off.outside, kept };
    };
    const drawn = () => {
      viewer.draw();
      const w = canvas.width, h = canvas.height, px = new Uint8Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // The box from #gnomon itself, in device pixels from the canvas's bottom left.
      const g = document.getElementById('gnomon').getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      const box = { x0: (g.left - cr.left) * dpr, y0: (cr.bottom - g.bottom) * dpr, x1: (g.right - cr.left) * dpr,
        y1: (cr.bottom - g.top) * dpr };
      const out = [0, 1, 2].map(() => ({ n: 0, x: 0, y: 0 }));
      let outside = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = 4 * (y * w + x), k = kind(px[i], px[i + 1], px[i + 2]);
        if (k < 0) continue;
        if (x < box.x0 || x >= box.x1 || y < box.y0 || y >= box.y1) { outside++; continue; }
        out[k].n++; out[k].x += x; out[k].y += y;
      }
      for (const o of out) if (o.n) { o.x /= o.n; o.y /= o.n; }
      const corners = [[box.x0 + 2, box.y0 + 2], [box.x1 - 3, box.y0 + 2], [box.x0 + 2, box.y1 - 3],
        [box.x1 - 3, box.y1 - 3]].map(([x, y]) => { const i = 4 * (Math.round(y) * w + Math.round(x));
        return px.slice(i, i + 3).join(); });
      return { axes: out, outside, box, corners };
    };
    // The world's axes on the screen as the main camera shows them (right, up).
    const screen = () => {
      const e = viewer.camera.matrixWorld.elements;
      return [0, 1, 2].map((a) => [e[a], e[4 + a]]);
    };
    // The model's file read again as GLB: its own axes (glTF's Y up), X the world's X, Y its Z, Z its -Y.
    const glbView = async () => {
      const bytes = await (await fetch('/content/as1.glb')).arrayBuffer();
      await viewer.load({ name: 'as1.glb', bytes });
      viewer.setView('iso', { instant: true });
      await frames();
      const [x, y, z] = screen();
      return { ...axes(), screen: [x, z, [-y[0], -y[1]]] };
    };
    const out = {};
    await frames();
    out.iso = { ...axes(), screen: screen() };
    // The labels in the iso view (none nudged there): predicted from the main camera alone, the sphere's centre 50
    // pixels in from #gnomon's left and 44 up from its bottom, an axis 34 pixels, a label 0.3 of one beyond its tip,
    // its box 14 pixels; each letter's colour inside its box.
    {
      const e = viewer.camera.matrixWorld.elements, g = document.getElementById('gnomon').getBoundingClientRect();
      const proj = (v) => [v[0] * e[0] + v[1] * e[1] + v[2] * e[2], v[0] * e[4] + v[1] * e[5] + v[2] * e[6]];
      const c = proj([1 / 3, 1 / 3, 1 / 3]);
      const at = (v, k) => { const p = proj(v); return [50 + (k * p[0] - c[0]) * 34, 44 + (k * p[1] - c[1]) * 34]; };
      const want = [...[[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => at(v, 1.3)), at([0, 0, 0], 1)];
      const got = viewer.gnomon.layout;
      out.labelsPlaced = want.every((w, i) => Math.abs(w[0] - got[i].x) < 0.5 && Math.abs(w[1] - got[i].y) < 0.5);
      viewer.draw();
      const w = canvas.width, h = canvas.height, px = new Uint8Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const cb = canvas.getBoundingClientRect();
      // Each letter's ink: its axis's colour within 14 pixels of its box's centre beyond the tip (the line left out),
      // its count and its centroid less the box's centre (CSS pixels, y up).
      out.letters = [0, 1, 2].map((k) => {
        const cxp = g.left - cb.left + want[k][0], cyp = cb.bottom - g.bottom + want[k][1];
        const tip = at([[1, 0, 0], [0, 1, 0], [0, 0, 1]][k], 1);
        let n = 0, sx = 0, sy = 0;
        for (let y = Math.ceil((cyp - 14) * dpr); y < (cyp + 14) * dpr; y++) {
          for (let x = Math.ceil((cxp - 14) * dpr); x < (cxp + 14) * dpr; x++) {
            const i = 4 * (y * w + x), X = x / dpr - (g.left - cb.left), Y = y / dpr - (cb.bottom - g.bottom);
            // (Nearer the tip than the label's centre is: the line's.)
            if (Math.hypot(X - tip[0], Y - tip[1]) < Math.hypot(X - want[k][0], Y - want[k][1])) continue;
            if (kind(px[i], px[i + 1], px[i + 2]) === k) { n++; sx += x / dpr; sy += y / dpr; }
          }
        }
        return { n, dx: n ? sx / n - cxp : 99, dy: n ? sy / n - cyp : 99 };
      });
      out.labelsJson = JSON.stringify({ want, got });
      // The x label's backing (over the view's background here): inside its box at mid-height, a shade off the
      // background (lighter on a dark one, darker on a light one); its very corner rounded off, nearer the background
      // than its edge at mid-height is (the radius is under a pixel's worth of the corner).
      const bg = viewer.scene.background.clone().convertLinearToSRGB().toArray().map((v) => Math.round(v * 255));
      const pixel = (X, Y) => { const i = 4 * (Math.round(Y * dpr) * w + Math.round(X * dpr));
        return [px[i], px[i + 1], px[i + 2]]; };
      const bx = g.left - cb.left + want[0][0] - 7, by = cb.bottom - g.bottom + want[0][1] - 7;
      out.backing = { bg, side: pixel(bx + 1.5, by + 7), edge: pixel(bx + 0.3, by + 7), corner: pixel(bx + 0.3,
        by + 0.3) };
    }
    viewer.setView('front', { instant: true });
    // (Its labels glide to their places first: idle waits for them.)
    await cadViewer.idle();
    await frames();
    out.front = { ...axes(), screen: screen() };
    // The y label (along the line of sight, on the origin's box) all the way clear of it.
    { const l = viewer.gnomon.layout; out.clear = Math.abs(l[1].x - l[3].x); }
    // Everything cut away: the gnomon stays.
    viewer.setSections({ ...viewer.sections.get(), x: { on: true, at: -1e6, flip: false } });
    await frames();
    out.cut = axes();
    viewer.setSections({ ...viewer.sections.get(), x: { on: false, at: 0, flip: false } });
    // A picture of the model alone where the gnomon is: none of it.
    const g = document.getElementById('gnomon').getBoundingClientRect();
    const crop = { left: g.left, top: g.top, width: g.width, height: g.height };
    out.picture = 0;
    for (const transparent of [false, true]) {
      const pic = viewer.viewImage(crop, g.width, { transparent });
      const d = pic.getContext('2d').getImageData(0, 0, pic.width, pic.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && kind(d[i], d[i + 1], d[i + 2]) >= 0) out.picture++;
    }
    // View's Axes off.
    ui.gui.controllersRecursive().find((c) => c._name === 'Axes').setValue(false);
    await frames();
    out.off = drawn();
    ui.gui.controllersRecursive().find((c) => c._name === 'Axes').setValue(true);
    out.glb = await glbView();
    return out;
  })()`) as { after: Record<string, { axes: { n: number; x: number; y: number }[]; outside: number;
    screen: number[][] }> };
  const a = r.after, j = JSON.stringify(a);
  const counts = (v: { axes: { n: number }[] }) => v.axes.map((x) => x.n);
  // The direction from one axis's centroid to another's is half the difference of their tips (each line's pixels
  // centred on its middle), which the main camera's axes give independently.
  const turned = (v: { axes: { n: number; x: number; y: number }[]; screen: number[][] }, p: number, q: number) => {
    const got = Math.atan2(v.axes[p]!.y - v.axes[q]!.y, v.axes[p]!.x - v.axes[q]!.x);
    const want = Math.atan2(v.screen[p]![1]! - v.screen[q]![1]!, v.screen[p]![0]! - v.screen[q]![0]!);
    const d = Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
    return d < 6 * Math.PI / 180;
  };
  const box = (a.iso as unknown as { box: { x0: number; y0: number; x1: number } }).box;
  expect(box.x0 < 20 && box.y0 >= 24 && box.y0 < 60 && box.x1 - box.x0 >= 60, `the box in the lower left, above a ` +
    `line of status: ${j}`);
  expect(counts(a.iso!).every((n) => n > 20) && a.iso!.outside === 0 && (a.iso as unknown as { kept: boolean }).kept,
    `iso: every axis drawn, in its box, the view kept around it: ${j}`);
  expect(turned(a.iso!, 0, 1) && turned(a.iso!, 1, 2) && turned(a.iso!, 2, 0), `iso: the axes as the camera turns: ${
    j}`);
  expect((a as unknown as { labelsPlaced: boolean }).labelsPlaced, `iso: the labels where the camera puts them: ${
    (a as unknown as { labelsJson: string }).labelsJson}`);
  const backing = (a as unknown as { backing: Record<'bg' | 'side' | 'edge' | 'corner', number[]> }).backing;
  const off = (p: number[]) => (backing.bg[0]! < 128 ? 1 : -1) * (p[0]! - backing.bg[0]!);
  expect(off(backing.side) > 8 && off(backing.corner) < off(backing.edge) - 2 && off(backing.corner) >= 0,
    `iso: the labels' backing, a shade off the background, rounded: ${JSON.stringify(backing)}`);
  const letters = (a as unknown as { letters: { n: number; dx: number; dy: number }[] }).letters;
  expect(letters.every((l) => l.n >= 8 && Math.abs(l.dx) < 1.5 && Math.abs(l.dy) < 3), `iso: each letter drawn ` +
    `centred in its box: ${JSON.stringify(letters)}`);
  // Front: Y along the line of sight; X and Z.
  expect(counts(a.front!)[0]! > 20 && counts(a.front!)[2]! > 20 && turned(a.front!, 0, 2),
    `front: X right, Z up: ${j}`);
  expect(counts(a.cut!).every((n, i) => n === counts(a.front!)[i]), `the section planes don't cut it: ${j}`);
  expect((a as unknown as { clear: number }).clear >= 14 - 1e-6, `front: the y label glided clear: ${j}`);
  expect((a.picture as unknown as number) === 0, `not in a picture of the model alone: ${j}`);
  expect(counts(a.off!).every((n) => n === 0), `View's Axes off: none: ${j}`);
  expect(counts(a.glb!).every((n) => n > 20) && turned(a.glb!, 0, 1) && turned(a.glb!, 1, 2) && turned(a.glb!, 2, 0),
    `GLB: the file's axes, Y up: ${j}`);
  return undefined;
});
// Clicks on the gnomon, by real mouse input: a label looks along its axis, that axis pointing at the viewer, or away
// when it already does; the origin's box looks iso (in a view along an axis too) and does nothing in the iso view;
// each a press of the View menu's button (recorded as that control), never a pick; the pointer a hand over a label;
// a finger's tap reaches further than a click. A GLB's labels are its own axes (its y the world's Z). Expectations
// are the world's directions, the view's back read from the camera.
await check('axes gnomon clicks', async () => {
  const evaluate = async (sessionId: string, expression: string) => ((await send('Runtime.evaluate', { expression,
    returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value: unknown } }).result.value;
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&gnomon=1`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    viewer.setView('front', { instant: true });
    await cadViewer.idle();
    cadViewer.record(true);
    return true;
  })()`, { scale: 1, then: async (sid) => {
    // A target's centre in client pixels, from #gnomon's box and the layout drawn.
    const at = async (t: string) => await evaluate(sid, `(() => {
      const g = document.getElementById('gnomon').getBoundingClientRect();
      const l = viewer.gnomon.layout['xyzo'.indexOf('${t}')];
      return [g.left + l.x, g.bottom - l.y]; })()`) as number[];
    const back = async () => await evaluate(sid, `viewer.camera.getWorldDirection(viewer.camera.position.clone())
      .negate().toArray().map((v) => Math.round(v * 1000) / 1000)`) as number[];
    const click = async (t: string) => {
      const [x, y] = await at(t);
      const m = (type: string, extra: object = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left',
        ...extra }, sid);
      await m('mouseMoved', { button: 'none' });
      await m('mousePressed', { buttons: 1, clickCount: 1 });
      await m('mouseReleased', { clickCount: 1 });
      await evaluate(sid, 'cadViewer.idle()');
      return back();
    };
    const out: Record<string, unknown> = { front: await back() };
    for (const [k, t] of ['z', 'z', 'x', 'y', 'y'].entries()) out[`${k} ${t}`] = await click(t);
    // The origin's box in a view along an axis (front): iso too.
    out.alongOrigin = await click('o');
    // A finger's tap 12 pixels above the z label (past its drawn box): top; a click there: nothing (a pick).
    await evaluate(sid, `(async () => { viewer.setView('front', { instant: true }); await cadViewer.idle(); })()`);
    const above = async () => { const [x, y] = await at('z') as [number, number]; return [x, y - 12]; };
    {
      const [x, y] = await above();
      const m = (type: string) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0 }, sid);
      await m('mousePressed');
      await m('mouseReleased');
      await evaluate(sid, 'cadViewer.idle()');
      out.clickNear = await back();
    }
    {
      const [x, y] = await above();
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, sid);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
      await send('Emulation.setTouchEmulationEnabled', { enabled: false }, sid);
      await evaluate(sid, 'cadViewer.idle()');
      out.tapNear = await back();
      await evaluate(sid, `(async () => { viewer.setView('front', { instant: true }); await cadViewer.idle(); })()`);
    }
    // A turn off every axis, then the origin: iso; again: nothing.
    await evaluate(sid, `(() => { const c = viewer.camera, t = viewer.controls.target;
      const off = c.position.clone().sub(t).applyAxisAngle(c.up.clone().set(0.3, 0.2, 1).normalize(), 0.5);
      c.position.copy(t).add(off);
      c.lookAt(t); viewer.redraw(); return cadViewer.idle(); })()`);
    out.oblique = await back();
    out.iso = await click('o');
    const controls = 'cadViewer.recording().events.filter((e) => e.type === "control").length';
    out.controlsBefore = await evaluate(sid, controls);
    out.isoAgain = await click('o');
    out.controlsAfter = await evaluate(sid, controls);
    // A hand over a label, none away from the gnomon.
    const [x, y] = await at('x') as [number, number];
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sid);
    out.hand = await evaluate(sid, 'viewer.renderer.domElement.style.cursor');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 300, y: y - 300, button: 'none' }, sid);
    out.away = await evaluate(sid, 'viewer.renderer.domElement.style.cursor');
    out.recorded = await evaluate(sid, `cadViewer.recording().events.filter((e) => e.type === 'control')
      .map((e) => e.path)`);
    out.picks = await evaluate(sid, 'cadViewer.recording().events.filter((e) => e.type === "pick").length');
    // Shift-clicked (Fit on): the view turned alone, as if Fit were off, recorded so.
    await evaluate(sid, `(async () => { viewer.setView('front', { instant: true }); await cadViewer.idle(); })()`);
    const height = async () => await evaluate(sid, 'viewer.cameraState().height') as number;
    const before = await height();
    {
      const [x, y] = await at('z');
      const m = (type: string, extra: object = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left',
        modifiers: 8, ...extra }, sid);
      await m('mouseMoved', { button: 'none' });
      await m('mousePressed', { buttons: 1, clickCount: 1 });
      await m('mouseReleased', { clickCount: 1 });
      await evaluate(sid, 'cadViewer.idle()');
    }
    out.shifted = { back: await back(), kept: await height() === before, fit: await evaluate(sid,
      'ui.views().fit'), last: await evaluate(sid, `(() => { const e = cadViewer.recording().events
      .filter((e) => e.type === 'control').pop(); return e.path + (e.shift ? ' shift' : ''); })()`) };
    // A GLB: its y the world's Z.
    await evaluate(sid, `(async () => { await cadViewer.load('/content/as1.glb'); await cadViewer.idle();
      viewer.setView('front', { instant: true }); await cadViewer.idle(); })()`);
    out.glbY = await click('y');
    return out;
  } }) as { then: Record<string, unknown> };
  const a = r.then, j = JSON.stringify(a);
  const is = (v: unknown, w: number[]) => (v as number[]).every((x, i) => Math.abs(x - w[i]!) < 1e-3);
  const s3 = 1 / Math.sqrt(3);
  expect(is(a.front, [0, -1, 0]), `front to start: ${j}`);
  expect(is(a['0 z'], [0, 0, 1]) && is(a['1 z'], [0, 0, -1]), `z: top, then bottom: ${j}`);
  expect(is(a['2 x'], [1, 0, 0]), `x: right: ${j}`);
  expect(is(a['3 y'], [0, 1, 0]) && is(a['4 y'], [0, -1, 0]), `y: back, then front: ${j}`);
  expect(is(a.alongOrigin, [s3, -s3, s3]), `the origin's box in a view along an axis: iso: ${j}`);
  expect(is(a.clickNear, [0, -1, 0]) && is(a.tapNear, [0, 0, 1]), `a tap reaches further than a click: ${j}`);
  expect(!is(a.oblique, [s3, -s3, s3]) && is(a.iso, [s3, -s3, s3]), `the origin's box: iso: ${j}`);
  expect(is(a.isoAgain, [s3, -s3, s3]) && a.controlsAfter === a.controlsBefore, `iso again: nothing: ${j}`);
  expect(a.hand === 'pointer' && a.away === '', `the pointer: ${j}`);
  const views = ['Top', 'Bottom', 'Right', 'Back', 'Front', 'Iso Z', 'Top', 'Iso Z'].map((v) =>
    `View/Look Along an Axis/${v}`);
  expect(JSON.stringify(a.recorded) === JSON.stringify(views) && a.picks === 1,
    `recorded as the views' buttons, one pick (the click near z): ${j}`);
  expect(is(a.glbY, [0, 0, 1]), `a GLB's y: the world's Z, top: ${j}`);
  const sh = a.shifted as { back: number[]; kept: boolean; fit: boolean; last: string };
  expect(is(sh.back, [0, 0, 1]) && sh.kept && sh.fit && sh.last === 'View/Look Along an Axis/Top shift',
    `shift-clicked: Fit the other way, recorded so: ${j}`);
  return undefined;
});
// The gnomon's labels in a flight (iso to front, a second, eased): every frame, each label moves a little (no jump);
// the y label's nudge (its place less its placement point, predicted from the main camera) blends from none to its
// final one as the flight goes (about half at half way); at the end they're where they belong, nothing left moving.
await check('axes gnomon in flight', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&gnomon=1`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    viewer.setView('iso', { instant: true });
    await cadViewer.idle();
    viewer.flightMs = 1000;
    const placement = (k) => {
      const e = viewer.camera.matrixWorld.elements;
      const proj = (v) => [v[0] * e[0] + v[1] * e[1] + v[2] * e[2], v[0] * e[4] + v[1] * e[5] + v[2] * e[6]];
      const c = proj([1 / 3, 1 / 3, 1 / 3]), p = proj([0, 1, 2].map((i) => i === k ? 1.3 : 0));
      return [50 + (p[0] - c[0]) * 34, 44 + (p[1] - c[1]) * 34];
    };
    const frames = [];
    viewer.setView('front');
    while (frames.length < 200) {
      await new Promise((res) => requestAnimationFrame(res));
      const f = viewer.flight;
      const p = placement(1), l = viewer.gnomon.layout;
      frames.push({ s: f ? (performance.now() - f.start) / viewer.flightMs : 1, layout: l,
        nudge: [l[1].x - p[0], l[1].y - p[1]], turn: viewer.camera.quaternion.toArray() });
      if (!f && !viewer.gnomon.moving) break;
    }
    await new Promise((res) => setTimeout(res, 400));
    viewer.draw();
    const settledAt = { after: viewer.gnomon.layout, moving: viewer.gnomon.moving };
    // At once to iso and back to the front, then left alone (no draws of ours): the viewer keeps drawing while the y
    // label glides, until it's clear of the origin's box (frames in headless Chrome come slowly, so a time won't do).
    viewer.flightMs = 0;
    viewer.setView('iso');
    await new Promise((res) => setTimeout(res, 300));
    viewer.setView('front');
    // (Idle once the viewer schedules no more frames of its own.)
    await cadViewer.idle();
    const l = viewer.gnomon.layout;
    return { frames, ...settledAt, glided: Math.abs(l[1].x - l[3].x) };
  })()`) as { after: { frames: { s: number; layout: { x: number; y: number }[]; nudge: number[];
    turn: number[] }[]; after: { x: number; y: number }[]; moving: boolean; glided: number } };
  const { frames, after, moving, glided } = r.after;
  const far = (a: { x: number; y: number }[], b: { x: number; y: number }[]) =>
    Math.max(...a.slice(0, 3).map((p, k) => Math.hypot(p.x - b[k]!.x, p.y - b[k]!.y)));
  let most = 0;
  for (let k = 1; k < frames.length; k++) most = Math.max(most, far(frames[k]!.layout, frames[k - 1]!.layout));
  const last = frames[frames.length - 1]!;
  const final = Math.hypot(...last.nudge);
  // The nudge as a fraction of its final one against the camera's own progress (the angle turned so far over the whole
  // turn), through the flight: the same easing.
  const angle = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((t, v, i) => t + v *
    b[i]!, 0))));
  const whole = angle(frames[0]!.turn, last.turn);
  const lag = frames.filter((f) => f.s > 0.05 && f.s < 0.95).map((f) => Math.hypot(...f.nudge) / final -
    angle(frames[0]!.turn, f.turn) / whole);
  const mids = lag.map((x) => Math.round(x * 1000) / 1000);
  const j = JSON.stringify({ n: frames.length, most, final, mids, moving });
  expect(frames.length >= 10 && most < 8, `a jump between frames: ${j}`);
  expect(final > 10 && mids.length >= 10 && mids.every((m) => Math.abs(m) < 0.06), `the y label's nudge blended ` +
    `as the camera turns: ${j}`);
  expect(far(after, last.layout) < 0.01 && !moving, `settled at the flight's end: ${j}`);
  expect(glided >= 14 - 1e-6, `left alone, the y label glided clear: ${glided}`);
  return undefined;
});
// The symbol of an axis along the line of sight, in the origin's box: front (y away), a ringed cross: green on its
// ring and on the cross's arms past the dot's reach; back (y at the viewer), a ringed dot: green on the ring and at the
// centre, nothing where the cross's arm would be; inside the ring, the background (the other axes' lines hidden);
// iso, none. Green measured as its excess over red and blue.
// The gnomon antialiased as the view is (Rendering's SMAA), on a screen of one device pixel per CSS pixel: with SMAA on,
// its edges smoothed (pixels at them differ from SMAA off), its colours where it's one colour all round the same as
// without (the raw sRGB numbers drawn into the texture; SMAA changes only edges, a letter's too), and nothing of the view more than a pixel from what it touches changed (what's
// under it not smoothed twice). With SMAA off, as before.
await check('axes gnomon antialiased', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&gnomon=1&deterministic`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    viewer.setView('iso', { instant: true });
    await cadViewer.idle();
    const fitted = viewer.cameraState();
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const g = document.getElementById('gnomon').getBoundingClientRect(), cb = canvas.getBoundingClientRect();
    const dpr = canvas.width / canvas.clientWidth;
    const box = { x: Math.round((g.left - cb.left) * dpr), y: Math.round((cb.bottom - g.bottom) * dpr),
      w: Math.round(g.width * dpr), h: Math.round(g.height * dpr) };
    const grab = (smaa, shown) => {
      ui.setRender({ smaa });
      viewer.showGnomon = shown;
      viewer.draw();
      const px = new Uint8Array(4 * box.w * box.h);
      gl.readPixels(box.x, box.y, box.w, box.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const n = box.w * box.h;
    const diff = (p, q, i) => Math.max(...[0, 1, 2].map((c) => Math.abs(p[4 * i + c] - q[4 * i + c])));
    // The model's edges under the box too, so smoothing them again would show: panned until SMAA changes enough of
    // what's there without the gnomon.
    let under = 0;
    for (const [k, pan] of [[0, 0], [150, 100], [250, 150], [100, 200], [300, 250], [200, 300]].entries()) {
      const mm = fitted.height / canvas.clientHeight;
      viewer.setCamera({ ...fitted, height: fitted.height / (k ? 2 : 1), pan: [-pan[0] * mm, -pan[1] * mm] });
      await cadViewer.idle();
      const a0 = grab(false, false), a = grab(true, false);
      under = 0;
      for (let i = 0; i < n; i++) if (diff(a, a0, i) > 8) under++;
      if (under > 50) break;
    }
    const A0 = grab(false, false), B0 = grab(false, true), A = grab(true, false), B = grab(true, true);
    // The same drawn after another view (its edges elsewhere): SMAA's own targets start empty each time.
    const camera = viewer.cameraState();
    viewer.setView('top', { instant: true });
    grab(true, true);
    viewer.setCamera(camera);
    const again = grab(true, true);
    let stale = 0;
    for (let i = 0; i < box.w * box.h; i++) if (diff(again, B, i) > 0) stale++;
    ui.setRender({ smaa: true });
    const touched = new Uint8Array(n);
    for (let i = 0; i < n; i++) touched[i] = diff(A0, B0, i) > 0 ? 1 : 0;
    // Whether every pixel within k of i is touched (all), or any is (some).
    const near = (i, k, all) => {
      const x = i % box.w, y = Math.floor(i / box.w);
      for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
        const X = x + dx, Y = y + dy;
        const t = X >= 0 && Y >= 0 && X < box.w && Y < box.h && touched[Y * box.w + X] === 1;
        if (all && !t) return false;
        if (!all && t) return true;
      }
      return all;
    };
    // Whether the gnomon is one colour next to i (without SMAA): no edge at i's sides, so SMAA leaves it (it blends a
    // pixel only across an edge at one of its sides; a letter's are smoothed).
    const flat = (i) => {
      const x = i % box.w, y = Math.floor(i / box.w);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, k = 4 * (Y * box.w + X);
        if (X < 0 || Y < 0 || X >= box.w || Y >= box.h) return false;
        if ([0, 1, 2].some((c) => B0[k + c] !== B0[4 * i + c])) return false;
      }
      return true;
    };
    let leaked = 0, inside = 0, insideOff = 0, smoothed = 0, worst = 0;
    for (let i = 0; i < n; i++) {
      if (diff(A, B, i) > 2 && !near(i, 1, false)) leaked++;
      if (touched[i] && near(i, 1, true) && flat(i)) {
        inside++;
        const d = diff(B, B0, i);
        worst = Math.max(worst, d);
        if (d > 3) insideOff++;
      }
      if (touched[i] && !near(i, 1, true) && diff(B, B0, i) > 8) smoothed++;
    }
    return { box, touched: touched.reduce((a, b) => a + b, 0), leaked, inside, insideOff, worst, smoothed, under,
      stale };
  })()`) as { after: { touched: number; leaked: number; inside: number; insideOff: number; worst: number;
    smoothed: number; under: number; stale: number } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.touched > 200 && a.smoothed > 20 && a.under > 50, `SMAA on: the gnomon's edges smoothed: ${j}`);
  expect(a.inside > 10 && a.insideOff === 0, `its colours inside as without SMAA: ${j}`);
  expect(a.leaked === 0, `nothing more than a pixel from it changed: ${j}`);
  expect(a.stale === 0, `the same after another view: ${j}`);
  return undefined;
});
await check('axes gnomon symbols', async () => {
  for (const scheme of ['dark', 'light'] as const) {
    const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&gnomon=1`, `(async () => {
      await cadViewer.ready; await cadViewer.idle();
      // (The shapes as drawn, without SMAA, whose blending reaches into the gaps: axes gnomon antialiased checks it.)
      ui.setRender({ smaa: false });
      const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
      const dpr = canvas.width / canvas.clientWidth;
      const sample = async (view, tilt = 0) => {
        viewer.setView(view, { instant: true });
        await cadViewer.idle();
        if (tilt) {
          // Turned about the view's up through the orbit centre, tilt degrees.
          const c = viewer.camera, t = viewer.controls.target;
          const up = c.up.clone().normalize();
          const off = c.position.clone().sub(t).applyAxisAngle(up, tilt * Math.PI / 180);
          c.position.copy(t).add(off);
          c.lookAt(t);
          viewer.redraw();
          await cadViewer.idle();
        }
        viewer.draw();
        const w = canvas.width, h = canvas.height, px = new Uint8Array(4 * w * h);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const g = document.getElementById('gnomon').getBoundingClientRect(), cb = canvas.getBoundingClientRect();
        const o = viewer.gnomon.layout[3];
        // Greenness at an offset (CSS pixels, y up) from the origin's box's centre: the most over the pixels there.
        const green = (dx, dy) => {
          const X = (g.left - cb.left + o.x + dx) * dpr, Y = (cb.bottom - g.bottom + o.y + dy) * dpr;
          let best = -255;
          for (let y = Math.floor(Y - dpr / 2); y <= Math.ceil(Y + dpr / 2) - 1; y++) {
            for (let x = Math.floor(X - dpr / 2); x <= Math.ceil(X + dpr / 2) - 1; x++) {
              const i = 4 * (y * w + x);
              best = Math.max(best, px[i + 1] - (px[i] + px[i + 2]) / 2);
            }
          }
          return Math.round(best);
        };
        // The colour at an offset, against the background's (its largest difference over the three channels).
        const bg = viewer.scene.background.clone().convertLinearToSRGB().toArray().map((v) => v * 255);
        const off = (dx, dy) => {
          const X = Math.round((g.left - cb.left + o.x + dx) * dpr), Y = Math.round((cb.bottom - g.bottom + o.y + dy) *
            dpr), i = 4 * (Y * w + X);
          return Math.round(Math.max(...[0, 1, 2].map((c) => Math.abs(px[i + c] - bg[c]))));
        };
        return { symbol: viewer.gnomon.symbol ?? null, drawn: viewer.gnomon.symbolMesh.visible,
          inside: Math.max(off(3.7, 0), off(-3.7, 0), off(0, 3.7), off(0, -3.7)),
          ring: Math.min(green(6, 0), green(-6, 0), green(0, 6),
          green(0, -6)), arm: Math.min(green(2.5, 2.5), green(-2.5, -2.5), green(2.5, -2.5),
          green(-2.5, 2.5)), centre: green(0, 0),
          gap: Math.max(green(3.7, 0), green(0, 3.7)) };
      };
      return { front: await sample('front'), back: await sample('back'), iso: await sample('iso'),
        tilted: await sample('front', 6.5) };
    })()`, { [scheme]: true }) as { after: Record<string, { symbol: { axis: number; head: boolean;
      opacity: number } | null; drawn: boolean; inside: number; ring: number; arm: number; centre: number;
      gap: number }> };
    const a = r.after, j = `${scheme}: ${JSON.stringify(a)}`;
    const [f, b, i] = [a.front!, a.back!, a.iso!];
    expect(f.symbol?.axis === 1 && !f.symbol.head && f.ring > 40 && f.arm > 40, `front: a ringed cross: ${j}`);
    expect(b.symbol?.axis === 1 && b.symbol.head && b.ring > 40 && b.centre > 40 && b.arm < 20, `back: a ringed dot: ${
      j}`);
    // (Thresholds above the symbol's own antialiasing, which on a white background reads greener.)
    expect(f.gap < 40 && b.gap < 40, `front and back: nothing between the ring and the middle: ${j}`);
    // Inside the ring, where the other axes' lines run: the background, opaque (a line there differs by 100 or more).
    expect(f.inside < 60 && b.inside < 60, `front and back: the ring filled with the background: ${j}`);
    expect(i.symbol === null && !i.drawn && i.ring < 20, `iso: none: ${j}`);
    // 6.5 degrees off the front: half faded in, its ring fainter than straight on.
    const t = a.tilted!;
    expect(t.symbol !== null && t.symbol.opacity > 0.2 && t.symbol.opacity < 0.8 && t.ring > 10 &&
      t.ring < 0.8 * f.ring, `tilted: faded: ${j}`);
    // Its disc faded too: the other axes' lines show through it.
    expect(t.inside > 40, `tilted: the disc faded with the symbol: ${j}`);
  }
  return undefined;
});
// On a phone the tree panel lies over the view: the gnomon's box moves beside it while it's open, following its width,
// and back to the corner when it closes.
await check('axes gnomon beside the phone tree', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&gnomon=1`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const at = () => {
      const g = document.getElementById('gnomon').getBoundingClientRect();
      const s = document.getElementById('side').getBoundingClientRect();
      const h = document.getElementById('side-handle').getBoundingClientRect();
      return { left: g.left, side: s.right, handle: h.right, open: !document.body.classList.contains('tree-closed') };
    };
    const set = (open) => ui.gui.controllersRecursive().find((c) => c._name === 'Show the tree').setValue(open);
    const out = {};
    set(false); out.closed = at();
    set(true); out.open = at();
    document.documentElement.style.setProperty('--side', '200px'); out.wider = at();
    document.documentElement.style.removeProperty('--side');
    return out;
  })()`, { phone: true }) as { after: Record<string, { left: number; side: number; handle: number; open: boolean }> };
  const a = r.after, j = JSON.stringify(a);
  expect(!a.closed!.open && a.closed!.left < 10, `closed: in the corner: ${j}`);
  expect(a.open!.open && a.open!.left >= a.open!.handle, `open: beside the panel and its handle: ${j}`);
  expect(a.wider!.left - a.open!.left === a.wider!.side - a.open!.side && a.wider!.side > a.open!.side,
    `following the panel's width: ${j}`);
  return undefined;
});
// The view cube (View's Cube, after Axes, on by default and only while the axes show; off on check pages unless
// ?cube=1, remembered as its own): drawn in the gnomon, its fill the labels' backing's colour, the labels clear of it
// (in views where they'd fall on it without it); each face lettered for the face view facing it, upright and not
// mirrored as that view shows it, a Y-up file's too (the cube made again for its axes); a face's
// tooltip its view's name and key (the key as the controls show theirs), none over an edge or corner; a click on a face
// presses that view's button (the same camera; recorded as the control), on a corner or an edge looks along it from
// the cube's centre, the file's up axis up (a corner's camera Iso Z's where they agree; an edge's two faces symmetric),
// fitting as the buttons do (shift the other way), the corner by the origin's box the cube's; recorded and replayed;
// with Cube off, not drawn or clicked.
await check('view cube', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check&gnomon=1&cube=1`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const g = viewer.gnomon, canvas = viewer.renderer.domElement;
    const control = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    // A view from a direction (the world's, the file's here), Z up as seen.
    const cubeLookOf = (d) => {
      const n = Math.hypot(...d), dir = d.map((x) => x / n), up = [0, 0, 1].map((x, i) => x - dir[2] * dir[i]);
      const m = Math.hypot(...up);
      return { dir, up: up.map((x) => x / m) };
    };
    const out = { cubeOn: control('Cube').getValue() };
    control('Axes').setValue(false);
    out.disabledWithoutAxes = control('Cube')._disabled;
    control('Axes').setValue(true);
    out.enabledWithAxes = !control('Cube')._disabled;
    // A point of the cube (its own coordinates, [0, 1] each) on the page, as last drawn.
    const at = (q) => {
      const cube = g.cube, n = cube.children[0].geometry.parameters.width;
      const p = cube.localToWorld(new viewer.camera.position.constructor(q[0] * n, q[1] * n, q[2] * n))
        .project(g.camera);
      const box = viewer.gnomonDrawn, c = canvas.getBoundingClientRect();
      return { x: c.left + box.x + (p.x + 1) / 2 * box.width, y: c.bottom - box.y - (p.y + 1) / 2 * box.height };
    };
    const send = (type, p, o = {}) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1,
      isPrimary: true, pointerType: 'mouse', clientX: p.x, clientY: p.y, ...o }));
    const click = async (q, o = {}) => {
      await frame();
      const p = at(q);
      send('pointerdown', p, { button: 0, buttons: 1, ...o });
      send('pointerup', p, { button: 0, buttons: 0, ...o });
      await cadViewer.idle();
      await frame();
    };
    const tip = async (q) => {
      await frame();
      send('pointermove', at(q), { button: -1, buttons: 0 });
      const t = document.querySelector('.cv-tip');
      return t && !t.hidden ? { text: t.firstChild.textContent, key: t.querySelector('.cv-key')?.textContent,
        keyOpacity: getComputedStyle(t.querySelector('.cv-key')).opacity } : null;
    };
    const cam = () => viewer.cameraState();
    const back = () => viewer.camera.getWorldDirection(new viewer.camera.position.constructor()).negate().toArray();
    // The face facing the viewer: its letter, and its letter's up on the screen.
    const facing = () => {
      viewer.draw();
      const b = viewer.camera.getWorldDirection(new viewer.camera.position.constructor()).negate();
      const kids = g.cube.children;
      for (let i = 0; i < kids.length; i++) {
        const f = kids[i];
        if (!f.userData.fill) continue;
        const n = new viewer.camera.position.constructor(0, 0, 1).transformDirection(f.matrixWorld);
        if (n.dot(b) < 0.99) continue;
        const letter = kids[i + 1];
        const V = viewer.camera.position.constructor, q = viewer.camera.quaternion;
        const up = new V(0, 1, 0).transformDirection(letter.matrixWorld);
        const right = new V(1, 0, 0).transformDirection(letter.matrixWorld);
        // (Upright, and not mirrored: its right the screen's.)
        return { letter: letter.material.userData.letter, upright: Math.min(up.dot(new V(0, 1, 0).applyQuaternion(q)),
          right.dot(new V(1, 0, 0).applyQuaternion(q))) };
      }
      return null;
    };
    out.letters = {};
    for (const v of ['front', 'back', 'left', 'right', 'top', 'bottom']) {
      viewer.setView(v, { instant: true });
      await cadViewer.idle();
      out.letters[v] = facing();
    }
    // The labels clear the cube's outline (sampled across each box), in views where they'd fall on it without it.
    const labelsOnCube = () => {
      viewer.draw();
      const box = viewer.gnomonDrawn, n = g.cube.children[0].geometry.parameters.width;
      const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => {
        const p = g.cube.localToWorld(new viewer.camera.position.constructor((c & 1) * n, (c >> 1 & 1) * n,
          (c >> 2 & 1) * n)).project(g.camera);
        return { x: (p.x + 1) / 2 * box.width, y: (p.y + 1) / 2 * box.height };
      });
      // (Inside the hull: on the inner side of every edge between hull points, found by brute force.)
      const inside = (q) => {
        for (const a of pts) for (const b of pts) {
          if (a === b) continue;
          const side = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
          if (pts.every((p) => side(p) >= -1e-6) && side(q) < -1e-6) return false;
        }
        return true;
      };
      let on = 0;
      for (const l of g.layout.slice(0, 3)) {
        for (let i = 1; i < 7; i++) for (let k = 1; k < 7; k++) {
          if (inside({ x: l.x - 7 + i * 2, y: l.y - 7 + k * 2 })) on++;
        }
      }
      return on;
    };
    const views = ['front', 'back', 'left', 'right', 'top', 'bottom', 'isoX', 'isoY', 'isoZ'];
    const looks = [[1, 1, 1], [-1, -1, -1], [1, -1, -1], [-1, 1, 0], [0, 1, -1]];
    out.onCube = { on: 0, off: 0 };
    for (const cubeOn of [true, false]) {
      g.showCube = cubeOn;
      for (const v of [...views, ...looks]) {
        viewer.setView(typeof v === 'string' ? v : cubeLookOf(v), { instant: true });
        await cadViewer.idle();
        // (The labels glide to their places: settled.)
        for (let t = 0; t < 60 && g.moving; t++) await frame();
        out.onCube[cubeOn ? 'on' : 'off'] += labelsOnCube();
      }
    }
    g.showCube = true;
    // Iso Z: F, R and T in sight.
    // (Through the interface, which a replay makes again.)
    const start = () => { cadViewer.view('isoZ'); return cadViewer.idle(); };
    await start();
    out.tips = { front: await tip([0.5, 0, 0.5]), right: await tip([1, 0.5, 0.5]), top: await tip([0.5, 0.5, 1]),
      corner: await tip([0.95, 0, 0.95]), edge: await tip([0.5, 0, 0.95]) };
    send('pointerleave', at([0.5, 0, 0.5]));
    out.tipGone = document.querySelector('.cv-tip')?.hidden ?? true;
    // A face's click: Front's button's camera.
    cadViewer.record(true);
    await click([0.5, 0, 0.5]);
    out.faceClick = cam();
    await start();
    control('Front').$button.click();
    await cadViewer.idle();
    out.frontButton = cam();
    // A corner: Iso Z's.
    await start();
    cadViewer.view('front');
    await cadViewer.idle();
    await click([0.95, 0, 0.95]);
    out.corner = { cam: cam(), back: back() };
    cadViewer.view('front');
    await cadViewer.idle();
    control('Iso Z').$button.click();
    await cadViewer.idle();
    out.isoButton = cam();
    // Edges: the vertical front-right one, the front-top one.
    await start();
    await click([0.95, 0, 0.5]);
    out.vertical = { cam: cam(), back: back() };
    await start();
    await click([0.5, 0, 0.95]);
    out.horizontal = { cam: cam(), back: back() };
    // The cube's corner by the origin's box: the cube's (the corner away from every axis's tip), not Iso Z.
    await start();
    await click([0.03, 0, 0.03]);
    out.originCorner = back();
    // Shift: not fitted (Fit on), the zoom kept.
    await start();
    cadViewer.apply({ camera: { ...cam(), height: cam().height * 3 } });
    await cadViewer.idle();
    out.before = cam();
    await click([0.95, 0, 0.95], { shiftKey: true });
    out.shifted = cam();
    out.final = cam();
    out.rec = cadViewer.record(false);
    // Cube off: no click on it.
    await start();
    const pixels = () => {
      viewer.draw();
      const gl = viewer.renderer.getContext(), box = viewer.gnomonDrawn, k = canvas.width / canvas.clientWidth;
      const w = Math.round(box.width * k), h = Math.round(box.height * k), px = new Uint8Array(4 * w * h);
      gl.readPixels(Math.round(box.x * k), Math.round(box.y * k), w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const withCube = pixels();
    const centre = at([0.5, 0, 0.5]);
    // A face's fill, away from its letter: the labels' backing's colour (a shade off the background).
    {
      const box = viewer.gnomonDrawn, k = canvas.width / canvas.clientWidth, c = canvas.getBoundingClientRect();
      const p = at([0.12, 0, 0.5]), w = Math.round(box.width * k);
      const x = Math.round((p.x - c.left - box.x) * k), y = Math.round((c.bottom - p.y - box.y) * k);
      const bg = viewer.scene.background.clone(), dark = bg.getHSL({}, 'srgb').l < 0.5;
      const want = bg.lerp(new bg.constructor(dark ? 0xffffff : 0x000000), 0.15).getHexString();
      out.fill = { got: [0, 1, 2].map((i) => withCube[4 * (y * w + x) + i]), want: [0, 2, 4].map((i) =>
        parseInt(want.slice(i, i + 2), 16)) };
    }
    const stored = () => ({ cube: localStorage.getItem('cad-viewer.cube'),
      axes: localStorage.getItem('cad-viewer.gnomon') });
    const storedBefore = stored();
    control('Cube').setValue(false);
    out.stored = { before: storedBefore, after: stored() };
    const without = pixels();
    let differ = 0;
    for (let i = 0; i < withCube.length; i += 4) if (Math.abs(withCube[i] - without[i]) > 16) differ++;
    out.drawnPixels = differ;
    const was = cam();
    send('pointerdown', centre, { button: 0, buttons: 1 });
    send('pointerup', centre, { button: 0, buttons: 0 });
    await cadViewer.idle();
    out.offClick = JSON.stringify(cam()) === JSON.stringify(was);
    control('Cube').setValue(true);
    // Another model, a Y-up file: the cube made again for its axes, F still facing the front view.
    await cadViewer.load('/content/as1.glb');
    await cadViewer.idle();
    viewer.setView('front', { instant: true });
    await cadViewer.idle();
    out.glbFront = facing();
    return out;
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify({ ...a, rec: undefined, shots: undefined });
  expect(a.cubeOn && a.disabledWithoutAxes && a.enabledWithAxes, `the control: ${j}`);
  expect(a.glbFront?.letter === 'F' && a.glbFront.upright > 0.99, `a Y-up file's front: ${j}`);
  expect(a.onCube.on === 0 && a.onCube.off > 0, `the labels off the cube: ${j}`);
  const letters = { front: 'F', back: 'K', left: 'L', right: 'R', top: 'T', bottom: 'M' } as Record<string, string>;
  expect(Object.entries(letters).every(([v, l]) => a.letters[v]?.letter === l && a.letters[v].upright > 0.99),
    `the letters, upright: ${j}`);
  const t = a.tips;
  expect(t.front?.text === 'Front' && t.front.key === '1' && t.right?.text === 'Right' && t.right.key === '4' &&
    t.top?.text === 'Top' && t.top.key === '5' && t.front.keyOpacity === '0.45' && t.corner === null &&
    t.edge === null && a.tipGone, `the tooltips: ${j}`);
  const near = (p: number[], q: number[], e = 1e-6) => p.every((x, i) => Math.abs(x - q[i]!) < e);
  const same = (p: any, q: any) => near(p.position, q.position, 1e-6 * Math.max(1, ...p.position.map(Math.abs)))
    && near(p.target, q.target, 1e-3) && near(p.up, q.up) && Math.abs(p.height - q.height) < 1e-6 * p.height;
  expect(same(a.faceClick, a.frontButton), `a face: its button: ${j}`);
  const s3 = 1 / Math.sqrt(3), s2 = Math.SQRT1_2;
  expect(near(a.corner.back, [s3, -s3, s3]) && same(a.corner.cam, a.isoButton), `a corner: ${j}`);
  expect(near(a.originCorner, [-s3, -s3, -s3]), `the corner by the origin: ${j}`);
  expect(near(a.vertical.back, [s2, -s2, 0]) && near(a.vertical.cam.up, [0, 0, 1]), `a vertical edge: ${j}`);
  expect(near(a.horizontal.back, [0, -s2, s2]) && near(a.horizontal.cam.up, [0, s2, s2]),
    `an edge across: its faces above and below: ${j}`);
  expect(Math.abs(a.shifted.height - a.before.height) < 1e-6 * a.before.height &&
    near(a.shifted.target, a.before.target, 1e-3), `shifted: not fitted: ${j}`);
  expect(a.drawnPixels > 100 && a.offClick, `Cube off: not drawn, not clicked: ${j}`);
  expect(a.fill.got.every((v: number, i: number) => Math.abs(v - a.fill.want[i]) <= 3), `a face's fill: ${j}`);
  expect(a.stored.after.cube === '0' && a.stored.after.axes === a.stored.before.axes, `Cube remembered: ${j}`);
  const events = (a.rec.events as { type: string; path?: string; shift?: boolean }[]);
  expect(events.some((e) => e.type === 'control' && e.path === 'View/Look Along an Axis/Front') &&
    events.filter((e) => e.type === 'look').length === 5 && events.filter((e) => e.type === 'look' && e.shift)
    .length === 1, `recorded: ${JSON.stringify(events.filter((e) => e.type === 'look' || e.type === 'control'))}`);
  const replayed = await page('?check', `(async () => {
    await cadViewer.ready;
    // (The looks counted: the camera events after them set the same camera.)
    let looks = 0;
    const look = ui.lookToward;
    ui.lookToward = (...x) => { looks++; return look(...x); };
    const report = await cadViewer.replay(${JSON.stringify(a.rec)});
    return { divergences: report.divergences, camera: viewer.cameraState(), steps: report.steps,
      applied: report.applied, looks };
  })()`) as { after: { divergences: string[]; camera: any; steps: number; applied: number; looks: number } };
  const b = replayed.after;
  expect(b.divergences.length === 0 && b.steps === b.applied && b.looks === 5 && same(b.camera, a.final),
    `replayed: ${JSON.stringify(b)} ${JSON.stringify(a.final)}`);
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
    // The headlight's direction (towards the light) in the camera's frame, as three.js lights with it: from its
    // target's world position to its own. Over the shoulder, (1, 1, 2), whatever the view and wherever the camera.
    const shoulder = () => {
      viewer.draw();
      const l = viewer.headlight, c = viewer.camera;
      const d = l.getWorldPosition(c.position.clone()).sub(l.target.getWorldPosition(c.position.clone()));
      return d.transformDirection(c.matrixWorld.clone().invert()).toArray();
    };
    const light = {};
    for (const v of ['front', 'top', 'iso']) { viewer.setView(v, { instant: true }); light[v] = shoulder(); }
    // The view moved far from the world's origin (the orbit centre with it).
    viewer.camera.position.x += 1e5; viewer.controls.target.x += 1e5; viewer.camera.updateMatrixWorld();
    light.far = shoulder();
    viewer.zoomAll();
    const before = look();
    ui.setRender({ ...viewer.render, specular: 0.8, ambient: 0.7, light: 3 });
    const after = look();
    await cadViewer.load('/content/as1.glb');
    await cadViewer.idle();
    const loaded = look();
    // Reset lighting to defaults: those four back, nothing else (the edges' width, set too, kept); the sliders show it.
    ui.setRender({ ...viewer.render, shininess: 80, edgeWidth: 3 });
    const control = (name) => ui.gui.controllersRecursive().find((c) => c._name === name);
    control('Reset lighting to defaults').$button.click();
    const reset = { ...look(), shininess: viewer.render.shininess, edgeWidth: viewer.render.edgeWidth,
      shown: ['Shininess', 'Specular', 'Ambient light', 'Headlight'].map((n) => parseFloat(control(n).$input.value)) };
    return { before, after, loaded, light, reset };
  })()`, { asIs: true }) as { after: Record<string, { lights: [string, number][]; speculars: number[] }> };
  const a = r.after;
  const j = JSON.stringify(a);
  const light = a.light as unknown as Record<string, number[]>;
  expect(Object.values(light).length === 4 && Object.values(light).every((d) => [1, 1, 2].every((w, i) =>
    Math.abs(d[i]! - w / Math.sqrt(6)) < 1e-6)), `the headlight over the shoulder: ${JSON.stringify(light)}`);
  const grey = (x: number) => Math.round(x * 255) * 0x010101;
  expect(JSON.stringify(a.before!.lights) === JSON.stringify([['AmbientLight', 1], ['DirectionalLight', 2.5]]) &&
    JSON.stringify(a.before!.speculars) === JSON.stringify([grey(0.2)]), `the defaults: ${j}`);
  expect(JSON.stringify(a.after!.lights) === JSON.stringify([['AmbientLight', 0.7], ['DirectionalLight', 3]]) &&
    JSON.stringify(a.after!.speculars) === JSON.stringify([grey(0.8)]), `changed: ${j}`);
  expect(JSON.stringify(a.loaded!.speculars) === JSON.stringify([grey(0.8)]), `a model loaded after: ${j}`);
  const reset = a.reset as unknown as { lights: [string, number][]; speculars: number[]; shininess: number;
    edgeWidth: number; shown: number[] };
  expect(JSON.stringify(reset.lights) === JSON.stringify(a.before!.lights) &&
    JSON.stringify(reset.speculars) === JSON.stringify(a.before!.speculars) && reset.shininess === 30 &&
    reset.edgeWidth === 3 && JSON.stringify(reset.shown) === JSON.stringify([30, 0.2, 1, 2.5]),
    `Reset lighting to defaults: ${JSON.stringify(reset)}`);
  return undefined;
});
// Cap hatching, at a pixel ratio of 2: the lines fixed on the model (twice as far apart on the screen zoomed in
// twice as far) and their width on the screen (the same zoomed in, cadrender's by default, wider as set).
type Look = { lines: number; width: number; gap: number };
await check('cap hatching', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready; await cadViewer.idle();
    const gl = viewer.renderer.getContext(), canvas = viewer.renderer.domElement;
    const plate = ui.panel().model.nodes.find((n) => n.kind === 'part' && partOf(n) === 'plate').object.children[0];
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
    const before = viewer.nextLoad();
    ui.gui.controllersRecursive().find((c) => c._name === 'Mesh again').$button.click();
    for (let t = 0; t < 1200 && (viewer.nextLoad() === before || !viewer.model?.meshing); t++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await cadViewer.idle();
    const m = viewer.nodes;
    const nuts = m.nodes.filter((n) => n.kind === 'part' && partOf(n) === 'nut');
    const source = nuts[0].object.children[0].userData.faces[0];
    // (One face in every placement: faces are hidden per placement.)
    const want = nuts.map((n) => m.pathOf(n.id) + '/faces/face#' + source);
    cadViewer.hide(want);
    ui.setTree({ detail: false });
    const hidden = cadViewer.state().hidden;
    ui.setMeshing({ profile: 'custom', linearDeflection: 0.5 });
    const st = cadViewer.state();
    cadViewer.record(true);
    cadViewer.view('top');
    await cadViewer.idle();
    const rec = cadViewer.record(false);
    // A face hidden by a state with no node made for it (the tree without detail), by an older link's path (the face
    // straight below its part), given back as it's named now; then a state hiding nothing.
    const bolt = m.nodes.find((n) => n.kind === 'part' && partOf(n) === 'bolt');
    cadViewer.apply({ hidden: [m.pathOf(bolt.id) + '/face#' + bolt.object.children[0].userData.faces[0]] });
    const unmade = cadViewer.state().hidden.filter((p) => p.startsWith(m.pathOf(bolt.id) + '/faces/face#')).length;
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
// 3MF's tree: with our extras the STEP file's (its shown nodes: the export leaves hidden ones out), names and kinds;
// without, anyone's, the placed parts flat at the top of the tree (the build's items root parts; no node for the file).
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
  expect(flat.length === parts && flat.every((n) => n.split('/').length === 1) && plain.filter((n) =>
    n.startsWith('assembly ')).length === 0, `without extras: ${JSON.stringify(plain.slice(0, 4))}`);
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
    const face = parts[2] + '/faces/face#' + viewer.nodes.nodes[viewer.nodes.find(parts[2])].object.children[0]
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
  expect(a.version === 5 && a.count === a.unique && a.parts.length >= 4, `nodes: ${j}`);
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
// The address follows the model opened (automation.ts): at start the address's own model, its view and options left as
// they are; a local file opened (as1.glb's bytes as local.glb): no model=, the view gone, the page's options kept,
// and after About's Reload (ui.reload) no model, the status saying to open local.glb again, the name not kept for
// another reload; a URL's model opened: model= its path in the content root; after Reload that model, with the view
// it had (a part hidden, the camera); a URL's model after a local file: the local file's name dropped.
await check('address follows the model', async () => {
  type Seen = { search: string; hash: string; model?: string; status: string; kept: string | null;
    hidden?: string[]; camera?: number[] };
  const seen = `({ search: location.search, hash: location.hash, model: viewer.model?.name,
    status: document.getElementById('status').textContent, kept: sessionStorage.getItem('cad-viewer.localFile'),
    hidden: cadViewer.state().hidden, camera: cadViewer.state().camera.position })`;
  const r = await page('?model=as1.stp&check#ao=0', `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const start = ${seen};
    const bytes = await (await fetch('/content/as1.glb')).arrayBuffer();
    await ui.openFiles([new File([bytes], 'local.glb')]);
    await cadViewer.idle();
    const local = ${seen};
    setTimeout(() => ui.reload(), 0);
    return { start, local };
  })()`, { asIs: true, then: async (sessionId) => {
    const evaluate = async (expression: string) => {
      const e = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId) as
        { result: { value: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string } };
      if (e.exceptionDetails) throw new Error(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text);
      return e.result.value;
    };
    // (The page reloading: its new document's cadViewer awaited.)
    const reloaded = async () => {
      await new Promise((res) => setTimeout(res, 1500));
      for (let t = 0; t < 100 && !await evaluate('!!globalThis.cadViewer && !!document.body.dataset.report'); t++) {
        await new Promise((res) => setTimeout(res, 100));
      }
      return evaluate(`cadViewer.ready.then(() => cadViewer.idle()).then(() => ${seen})`) as Promise<Seen>;
    };
    const afterLocal = await reloaded();
    const url = await evaluate(`(async () => {
      viewer.flightMs = 0;
      sessionStorage.setItem('cad-viewer.localFile', 'local.glb');
      await ui.openUrl('/content/as1.stp');
      await cadViewer.idle();
      const parts = cadViewer.nodes().filter((n) => n.kind === 'part').map((n) => n.path);
      cadViewer.hide([parts[1]]);
      cadViewer.view('top');
      const s = ${seen};
      setTimeout(() => ui.reload(), 0);
      return s;
    })()`) as Seen;
    return { afterLocal, url, afterUrl: await reloaded() };
  } }) as { after: { start: Seen; local: Seen }; then: { afterLocal: Seen; url: Seen; afterUrl: Seen } };
  const { start, local } = r.after, { afterLocal, url, afterUrl } = r.then;
  const j = JSON.stringify({ ...r.after, ...r.then });
  expect(start.search === '?model=as1.stp&check' && start.hash === '#ao=0' && start.model === 'as1.stp',
    `at start, the address as it was: ${j}`);
  expect(local.search === '?check' && local.hash === '' && local.model === 'local.glb' && local.kept === 'local.glb',
    `a local file: no model=, the view gone, its name kept: ${j}`);
  expect(afterLocal.search === '?check' && afterLocal.model === undefined && afterLocal.kept === null
    && afterLocal.status.includes('local.glb was open from this computer'), `reloaded: no model, said: ${j}`);
  // (Named by its path in the content root, content/ beside the page: in a build, served at /viewer/, /content/ isn't
  // in it, so its path on the server.)
  const named = `?model=${process.env.BUILD ? encodeURIComponent('/content/as1.stp') : 'as1.stp'}&check`;
  expect(url.search === named && url.hash === '' && url.kept === null && url.model === 'as1.stp',
    `a URL's model: model=, the local file's name dropped: ${j}`);
  expect(afterUrl.model === 'as1.stp' && afterUrl.search === named
    && JSON.stringify(afterUrl.hidden) === JSON.stringify(url.hidden) && url.hidden!.length === 1
    && Math.abs(url.camera![2]! - start.camera![2]!) > 1
    && afterUrl.camera!.every((v, k) => Math.abs(v - url.camera![k]!) < 1e-4), `reloaded: the model, its view: ${j}`);
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
      // (By its name's own text: a control's key, after it, isn't part of its name.)
      const control = (name) => [...document.querySelectorAll('.lil-gui .controller')]
        .find((c) => c.querySelector('.name')?.firstChild?.textContent.trim() === name);
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
// Replay recording... in the page: only the recording is picked (the picker stubbed here); its model is taken as it is
// if the one open has its hash, else a dialog asks for it (Open file..., Open URL..., the recorded URL filled in); a
// file with another hash isn't loaded, an error dialog says both hashes, and the replay stops. And the File folder's
// Load URL... asks in a dialog (no URL field among the controls).
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
      .find((c) => c.querySelector('.name')?.firstChild?.textContent.trim() === name);
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
    const load = viewer.nextLoad();
    let meshed;
    const watch = () => {
      if (!watching) return;
      const c = viewer.cameraState();
      log.push([performance.now(), 'camera', c.position, document.querySelector('.replay-pointer')?.hidden === false]);
      if (meshed === undefined && viewer.nextLoad() !== load && viewer.model?.meshing) meshed = performance.now();
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
  // The drag from 1600 to 2400 ms, the pause after it cut from 5.6 s to 1 s: 1 s from the frame the drag ended in (the
  // camera where it ended), not 5.6 s. (From there: the replay doesn't catch up, so the drag's own events, each waiting
  // for the viewer, may end it later than recorded, by more on a slower host.)
  const dist = (p: number[], q: number[]) => Math.hypot(...p.map((v, i) => v - q[i]!));
  const ended = rel(a.log.find((l) => l[1] === 'camera' && l[0] - a.t0 > times.edgesOn &&
    dist(l[2] as number[], a.to) < 1e-6)?.[0]);
  expect(ended - times.edgesOn >= 1800 - 150 && close(times.ao - ended, 1000), `the pause cut: ${JSON.stringify(
    { ended })} ${j}`);
  // The drag, 1000 to 1800 ms after the second change.
  const drag = a.log.filter((l) => l[1] === 'camera' && l[0] - a.t0 > times.edgesOn + 1100 &&
    l[0] - a.t0 < times.edgesOn + 1700);
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
// Opening that fails: an error modal saying why, besides the status line: a file not found (404), one that isn't a
// model, a server that can't be reached, a typed address that's neither a URL nor a content path (Load URL...); none in
// the plain ?check pages.
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
// Screenshot..., between Export... and Link to this view...: disabled with no model; the model alone at its default width, the
// square of its sphere's circle within the view between the tree and the controls (worked out here from the camera),
// and at twice that, the height in proportion, its pixels the view's there; with a transparent background (over the
// view's, the opaque image again); JPEG (no transparency offered); the whole window redrawn, as wide as
// the window, the controls' pixels in it and the view's; the browser's tab capture where headless Chrome gives one; the
// choices remembered; Cancel saving nothing; the model out of view: only the window offered.
await check('screenshot', async () => {
  const r = await page(`?check`, `(async () => {
    await cadViewer.ready;
    const all = ui.gui.controllersRecursive();
    const shot = all.find((c) => c._name === 'Screenshot...');
    const names = all.map((c) => c._name);
    const order = [names.indexOf('Export...'), names.indexOf('Screenshot...'), names.indexOf('Link to this view...')];
    const before = shot._disabled;
    await ui.openUrl('/content/as1.stp');
    await cadViewer.idle();
    viewer.flightMs = 0;
    viewer.zoomAll();
    await cadViewer.idle();
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const waitFor = async (f) => { for (let i = 0; i < 600; i++) { const x = f(); if (x) return x; await frame(); } };
    const files = [];
    window.showSaveFilePicker = async (o) => {
      const f = { name: o.suggestedName, accept: Object.values(o.types?.[0]?.accept ?? {}).flat() };
      files.push(f);
      return { createWritable: async () => ({ write: async (d) => { f.bytes = new Uint8Array(await d.arrayBuffer()); },
        close: async () => {} }) };
    };
    // The image's size, its first bytes, and its pixel at a point (fractions of its width and height).
    const read = async (bytes, at = []) => {
      const bm = await createImageBitmap(new Blob([bytes]));
      const c = Object.assign(document.createElement('canvas'), { width: bm.width, height: bm.height });
      const g = c.getContext('2d');
      g.drawImage(bm, 0, 0);
      return { width: bm.width, height: bm.height, magic: [...bytes.slice(0, 2)],
        px: at.map(([x, y]) => [...g.getImageData(Math.floor(x * (bm.width - 1)), Math.floor(y * (bm.height - 1)), 1,
          1).data]) };
    };
    // The view drawn now, and its pixel at a point of the window (CSS pixels).
    const viewPx = async (pts) => {
      const img = new Image();
      img.src = viewer.snapshot();
      await img.decode();
      const cv = viewer.renderer.domElement, rc = cv.getBoundingClientRect(), k = cv.width / rc.width;
      const c = Object.assign(document.createElement('canvas'), { width: cv.width, height: cv.height });
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return pts.map(([x, y]) => [...g.getImageData(Math.floor((x - rc.left) * k), Math.floor((y - rc.top) * k), 1,
        1).data]);
    };
    // Screenshot... with these choices; what the dialog showed, and the file. One that fails throws its message (the
    // dialog saying so closed, so the next run finds its own).
    const run = async (o = {}) => {
      files.length = 0;
      const done = shot.getValue().call(shot.object);
      const d = await waitFor(() => document.querySelector('dialog.cv-dialog select')?.closest('dialog'));
      if (!d) throw new Error('no Screenshot dialog: ' + document.querySelector('dialog.cv-dialog')?.textContent);
      const [format, what, how] = d.querySelectorAll('select');
      const width = d.querySelector('input[type=number]');
      const shown = { format: format.value, what: what.value, how: how.value, modelOffered: !what.options[0].disabled,
        howShown: !how.closest('label').hidden };
      if (o.what) { what.value = o.what; what.dispatchEvent(new Event('change')); }
      if (o.how) { how.value = o.how; how.dispatchEvent(new Event('change')); }
      if (o.format) { format.value = o.format; format.dispatchEvent(new Event('change')); }
      const clear = d.querySelector('input[type=checkbox]');
      shown.clearAtOpen = clear.checked;
      if (o.transparent !== undefined) clear.checked = o.transparent;
      shown.transparentShown = !clear.closest('label').hidden;
      shown.width = +width.value;
      if (o.width) {
        width.value = String(o.width);
        width.dispatchEvent(new Event('input'));
        width.dispatchEvent(new Event('change'));
      }
      shown.height = d.querySelector('p.note').textContent;
      d.querySelector(o.cancel ? 'button[value=cancel]' : 'button.primary').click();
      await done;
      const failed = document.querySelector('dialog.cv-dialog');
      if (failed) {
        const text = [...failed.querySelectorAll('h2, p')].map((e) => e.textContent).join(': ');
        failed.querySelector('button.primary').click();
        await waitFor(() => !failed.isConnected);
        throw new Error('Screenshot failed: ' + text);
      }
      return { shown, file: files[0] };
    };
    // The model's box, worked out here: its sphere through the camera, within the tree's right and the controls' left.
    const s = viewer.modelSphere(), cv = viewer.renderer.domElement.getBoundingClientRect();
    const toPx = (p) => { const q = p.clone().project(viewer.camera); return [cv.left + (q.x + 1) / 2 * cv.width,
      cv.top + (1 - q.y) / 2 * cv.height]; };
    const [cx, cy] = toPx(s.center);
    const up = s.center.clone().add(viewer.camera.up.clone().normalize().multiplyScalar(s.radius)), [, uy] = toPx(up);
    const rad = Math.abs(uy - cy);
    const left = Math.max(cv.left, document.getElementById('side').getBoundingClientRect().right, cx - rad);
    const right = Math.min(cv.right, ui.gui.domElement.getBoundingClientRect().left, cx + rad);
    const top = Math.max(cv.top, cy - rad), bottom = Math.min(cv.bottom, cy + rad);
    const expected = { width: Math.round(right) - Math.round(left), height: Math.round(bottom) - Math.round(top) };
    const centre = [(left + right) / 2, (top + bottom) / 2];
    const m1 = await run({ what: 'model', format: 'png' });
    const model = { ...m1, image: await read(m1.file.bytes, [[0.5, 0.5]]), view: await viewPx([centre]) };
    // Transparent: over the view's background, the opaque one again, but for a few pixels of the outline, where SMAA's
    // edge detection depends on the background (at most 0.2 %); the background as it was, after.
    // (On a background of the view's own, neither black nor white, so putting it back shows.)
    viewer.setBackground(0x336699);
    await cadViewer.idle();
    const o1 = await run({ what: 'model', format: 'png', transparent: false });
    const bgBefore = viewer.scene.background.getHex();
    const c1 = await run({ what: 'model', format: 'png', transparent: true });
    const clear = await (async () => {
      const [o, t] = await Promise.all([o1.file.bytes, c1.file.bytes].map((b) => createImageBitmap(new Blob([b]))));
      const fill = (bm, bg) => {
        const c = Object.assign(document.createElement('canvas'), { width: bm.width, height: bm.height });
        const g = c.getContext('2d');
        if (bg) { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
        g.drawImage(bm, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const opaque = fill(o), raw = fill(t), over = fill(t, '#' + bgBefore.toString(16).padStart(6, '0'));
      let off = 0, none = 0, full = 0;
      for (let i = 0; i < opaque.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(opaque[i + k] - over[i + k]));
        if (d > 6) off++;
        if (raw[i + 3] === 0) none++;
        if (raw[i + 3] === 255) full++;
      }
      return { size: [t.width, t.height, o.width, o.height], off, none, full, pixels: opaque.length / 4 };
    })();
    const bgAfter = viewer.scene.background.getHex();
    viewer.setBackground(undefined);
    await cadViewer.idle();
    const m2 = await run({ what: 'model', width: 2 * model.shown.width, transparent: false });
    const twice = { ...m2, image: await read(m2.file.bytes) };
    const j1 = await run({ what: 'model', format: 'jpeg' });
    const jpeg = { name: j1.file.name, accept: j1.file.accept, image: await read(j1.file.bytes),
      transparentShown: j1.shown.transparentShown };
    // The whole window: a point in the controls' title bar, and one in the view (left of the controls).
    const gt = ui.gui.domElement.querySelector('.title').getBoundingClientRect();
    // (Near its right end, clear of the title's text.)
    const inGui = [(gt.right - 6) / innerWidth, (gt.top + gt.bottom) / 2 / innerHeight];
    const guiColour = getComputedStyle(ui.gui.domElement.querySelector('.title')).backgroundColor;
    // The details box over the view (a part selected, so it stays): points across it, every other pixel, compared
    // with the window redrawn again with the box hidden (its background is white over white in the light theme, but
    // its text shows).
    cadViewer.select([cadViewer.nodes().find((n) => n.kind === 'part').path]);
    await cadViewer.idle();
    const box = document.getElementById('details');
    const db = box.getBoundingClientRect();
    const inDetails = [];
    for (let y = db.top + 1; y < db.bottom - 1; y += 2) for (let x = db.left + 1; x < db.right - 1; x += 2) {
      inDetails.push([x, y]);
    }
    const detailsShown = !box.hidden && !box.classList.contains('faded') && db.width > 0;
    const w1 = await run({ what: 'window', how: 'redraw', format: 'png' });
    // (A point of the view clear of the details box, which can reach down over the view's centre: below it then.)
    const inBox = centre[0] >= db.left && centre[0] <= db.right && centre[1] >= db.top && centre[1] <= db.bottom;
    const inView = inBox ? [centre[0], db.bottom + 8] : centre;
    const win = { ...w1, image: await read(w1.file.bytes, [inGui, [inView[0] / innerWidth, inView[1] / innerHeight]]),
      view: await viewPx([inView]), guiColour, inner: [innerWidth, innerHeight], detailsShown };
    const at = inDetails.map(([x, y]) => [x / (innerWidth - 1), y / (innerHeight - 1)]);
    const drawn = (await read(w1.file.bytes, at)).px;
    box.hidden = true;
    const w2 = await run({ what: 'window', how: 'redraw', format: 'png' });
    box.hidden = false;
    const without = (await read(w2.file.bytes, at)).px;
    win.details = { points: inDetails.length, differing: drawn.filter((p, i) => p.some((v, k) =>
      Math.abs(v - without[i][k]) > 64)).length };
    cadViewer.select([]);
    let tab;
    try {
      const t1 = await run({ what: 'window', how: 'tab' });
      tab = t1.file ? { ...t1, image: await read(t1.file.bytes) } : { error: 'no file' };
    } catch (e) { tab = { error: String(e) }; }
    const remembered = (await run({ cancel: true })).shown;
    const cancelled = files.length;
    // Out of view: only the window.
    viewer.panBy(5000, 0);
    await cadViewer.idle();
    const away = (await run({ cancel: true })).shown;
    return { order, before, after: shot._disabled, expected, model, clear, bg: [bgBefore, bgAfter],
      clearShown: c1.shown.transparentShown, twice, jpeg, win, tab, remembered, cancelled,
      away, status: document.getElementById('status').textContent };
  })()`) as { after: Record<string, any> };
  const a = r.after;
  const j = JSON.stringify({ ...a, model: { ...a.model, file: undefined }, twice: undefined, win: { ...a.win,
    file: undefined }, tab: { ...a.tab, file: undefined } });
  const near = (p: number[], q: number[], d: number) => p.slice(0, 3).every((v, k) => Math.abs(v - q[k]!) <= d);
  expect(a.order[0] >= 0 && a.order[1] === a.order[0] + 1 && a.order[2] === a.order[1] + 1 && a.before === true &&
    a.after === false, `between Export... and Link to this view..., enabled with a model: ${j}`);
  const m = a.model;
  expect(m.shown.what === 'model' && Math.abs(m.shown.width - a.expected.width) <= 1 && m.file.name === 'as1.png' &&
    m.image.width === m.shown.width && Math.abs(m.image.height - a.expected.height) <= 1 &&
    JSON.stringify(m.image.magic) === '[137,80]', `the model alone, at its box's width: ${j}`);
  expect(near(m.image.px[0], m.view[0], 24), `the model's pixels the view's: ${j}`);
  const c = a.clear;
  expect(a.clearShown && c.size[0] === c.size[2] && c.size[1] === c.size[3] && c.none > c.pixels / 20 &&
    c.full > c.pixels / 20 && c.off <= c.pixels / 500 && a.bg[0] === a.bg[1] && a.twice.shown.clearAtOpen === true, `a transparent background (over the view's, the `
    + `opaque image again): ${JSON.stringify(c)} ${JSON.stringify(a.bg)}`);
  const t = a.twice;
  expect(t.image.width === 2 * m.image.width && Math.abs(t.image.height - 2 * m.image.height) <= 1,
    `twice as wide, in proportion: ${t.image.width} x ${t.image.height}`);
  expect(a.jpeg.name === 'as1.jpg' && a.jpeg.accept.includes('.jpg') && JSON.stringify(a.jpeg.image.magic) ===
    '[255,216]' && a.jpeg.image.width === m.image.width && !a.jpeg.transparentShown, `JPEG: ${j}`);
  const w = a.win;
  const gui = (w.guiColour.match(/\d+/g) ?? []).map(Number);
  expect(w.shown.width === w.inner[0] && w.image.width === w.inner[0] && w.image.height === w.inner[1],
    `the whole window, as wide: ${j}`);
  expect(near(w.image.px[0], gui, 12) && near(w.image.px[1], w.view[0], 24), `the window's controls and view: ${j}`);
  // (Its text, over the view: nothing where it's missing.)
  expect(w.detailsShown && w.details.differing > w.details.points / 50, `the details box in the window: ${j}`);
  // (Headless Chrome's tab capture, accepted by its flag, where it gives one.)
  if (a.tab.error) console.log(`  (tab capture not checked: ${a.tab.error})`);
  else expect(a.tab.image.width === a.tab.shown.width && a.tab.shown.howShown, `the tab captured: ${j}`);
  expect(a.remembered.format === 'png' && a.remembered.what === 'window' && (!!a.tab.error || a.remembered.how ===
    'tab'), `remembered (the last saved: the tab capture's choices): ${j}`);
  expect(a.cancelled === 0, `cancelled, nothing saved: ${j}`);
  expect(a.away.what === 'window' && !a.away.modelOffered, `out of view, only the window: ${j}`);
  return undefined;
});
// File's Save...: disabled with no model; the save dialog (File System Access, stubbed) suggested the file's name (a
// URL's last segment) and given exactly its bytes; cancelled, nothing said; without the API, a download by that name
// (the link's click stubbed) with the same bytes; a load that fails before showing its model leaves the last one's file
// to save; the next model shown, its file.
// Export...: the dialog, each format with its options, the save dialog asked with the name and type, the file made in
// the model worker and written: GLB with Draco and with meshopt (their encoders in the browser), .gltf embedded and
// with its .bin saved after (a second dialog), three.js JSON with edges, 3MF; the viewer's hiding applied when asked;
// the choices remembered; Cancel saving nothing; disabled with no model.
// Another version on the server (update-check.ts), never polled: nothing fetched at load; version.json fetched as it
// is (the server's, the same as the page's). Then answered by the page's fetch, wrapped to count, with another: the
// tab sent behind another and brought back checks once, and the badge in the title says which; a click on it opens
// About (the controls not folded) with the same line and Reload, fetching nothing more. Check for updates there: the
// server unreachable (said, the version kept), back to the same (both go), unreachable or not answering in time
// (said), another whose download fails (said, dropped), then another again (the badge back).
await check('update badge', async () => {
  const first = `globalThis.versionFetches = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input?.url ?? input), location.href);
      if (!url.pathname.endsWith('/version.json')) return real(input, init);
      versionFetches++;
      if (globalThis.serverVersion === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError'))));
      return globalThis.serverVersion === 'down' ? Promise.reject(new TypeError('Failed to fetch'))
        : globalThis.serverVersion ? Promise.resolve(new Response(JSON.stringify({ version: serverVersion })))
        : real(input, init);
    };`;
  const r = await page('?check', `(async () => {
    await new Promise((r) => setTimeout(r, 1000));
    const title = document.querySelector('.lil-gui .title');
    const atLoad = versionFetches;
    const served = (await (await fetch(new URL('version.json', document.baseURI))).json()).version;
    return { version: title.textContent.replace('cad-io-js ', ''), atLoad, served };
  })()`, { first, then: async (sessionId) => {
    const evaluate = async (expression: string) => {
      const e = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId) as
        { result: { value: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string } };
      if (e.exceptionDetails) throw new Error(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text);
      return e.result.value;
    };
    await evaluate(`globalThis.serverVersion = '9.9.9-new', versionFetches = 0`);
    const away = await evaluate(`new Promise((r) => setTimeout(() => r(versionFetches), 300))`);
    // Another tab in front, then this one again.
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
    const other = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    await send('Page.bringToFront', {}, other.sessionId);
    // (Hidden once the browser gets to it, later under load; then a while behind.)
    for (let t = 0; t < 50 && await evaluate('document.visibilityState') !== 'hidden'; t++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const behind = await evaluate('[document.visibilityState, versionFetches]');
    await send('Page.bringToFront', {}, sessionId);
    await send('Target.closeTarget', { targetId });
    return evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const badge = document.querySelector('.lil-gui .title .update-badge');
      const title = document.querySelector('.lil-gui .title');
      for (let t = 0; t < 50 && !ui.updates.state.ready; t++) await wait(100);
      const b = badge.getBoundingClientRect(), tr = title.getBoundingClientRect();
      const shown = { fetches: versionFetches, hidden: badge.hidden, title: badge.title, ready: ui.updates.state.ready,
        inside: b.width > 0 && b.left >= tr.left && b.right <= tr.right && b.top >= tr.top && b.bottom <= tr.bottom };
      // (Past the gap within which a check is skipped, so one made by opening About would show.)
      await wait(2100);
      badge.click();
      await wait(300);
      const d = document.querySelector('dialog.cv-dialog');
      const p = d?.querySelector('p.update');
      const [check, reload] = p ? [...p.querySelectorAll('button')] : [];
      // Where the button is each time the line is read: it mustn't move as the line changes (the line after it).
      const at = new Set();
      const line = () => {
        const b = check.getBoundingClientRect(), s = p.querySelector('span').getBoundingClientRect();
        at.add(s.width > 0 && s.left < b.right ? 'before' : b.left + ',' + b.top);
        return p.querySelector('span').textContent;
      };
      const about = { open: !!d, fetched: versionFetches - shown.fetches, text: p ? line() : null, hidden: p?.hidden,
        reload: reload && !reload.hidden && !reload.disabled, check: check?.textContent,
        folded: title.parentElement.classList.contains('closed') };
      // The server down with a version seen: said, the version kept (Reload still there).
      globalThis.serverVersion = 'down';
      check.click();
      for (let t = 0; t < 50 && check.disabled; t++) await wait(100);
      const downSeen = { text: line(), reload: !reload.hidden && !reload.disabled, badge: !badge.hidden };
      globalThis.serverVersion = undefined;
      check.click();
      const checking = line();
      for (let t = 0; t < 50 && check.disabled; t++) await wait(100);
      const same = { checking, text: line(), reload: !reload.hidden, badge: !badge.hidden,
        fetched: versionFetches - shown.fetches };
      globalThis.serverVersion = 'down';
      check.click();
      for (let t = 0; t < 50 && check.disabled; t++) await wait(100);
      const down = { text: line(), badge: !badge.hidden };
      globalThis.serverVersion = 'hang';
      ui.updates.timeout = 500;
      check.click();
      for (let t = 0; t < 50 && check.disabled; t++) await wait(100);
      const hang = { text: line(), failed: p.querySelector('span').classList.contains('failed') };
      // A download that fails: said, and the version dropped (the badge goes).
      ui.updates.updateWorker = () => wait(300).then(() => { throw new Error('offline'); });
      globalThis.serverVersion = '9.9.9-c';
      check.click();
      for (let t = 0; t < 50 && check.disabled; t++) await wait(100);
      const lost = { text: line(), badge: !badge.hidden, reload: !reload.hidden, state: ui.updates.state };
      // (The service worker's download made slow: what it says meanwhile.)
      ui.updates.updateWorker = () => wait(1000);
      globalThis.serverVersion = '9.9.9-b';
      check.click();
      await wait(300);
      const downloading = { text: line(), reload: !reload.hidden && !reload.disabled };
      for (let t = 0; t < 50 && check.disabled; t++) await wait(100);
      const found = { downloading, text: line(), badge: badge.title,
        reload: !reload.hidden && !reload.disabled };
      // Reload is the automation layer's (the address following the model: 'address follows the model').
      let reloads = 0;
      const own = ui.reload;
      ui.reload = () => { reloads++; };
      reload.click();
      ui.reload = own;
      found.reloads = reloads;
      d.querySelector('.buttons button').click();
      return { away: ${JSON.stringify(away)}, behind: ${JSON.stringify(behind)}, shown, about, downSeen, same, down,
        hang, lost, found, at: [...at] };
    })()`);
  } }) as { after?: { version: string; atLoad: number; served: string }; then?: { away: number;
    behind: [string, number]; shown: { fetches: number; hidden: boolean; title: string; ready: boolean;
    inside: boolean }; about: { open: boolean; fetched: number; text: string | null; hidden: boolean;
    reload: boolean; check: string; folded: boolean }; downSeen: { text: string; reload: boolean; badge: boolean };
    same: { checking: string; text: string; reload: boolean;
    badge: boolean; fetched: number }; down: { text: string; badge: boolean };
    hang: { text: string; failed: boolean }; lost: { text: string; badge: boolean; reload: boolean;
    state: { latest?: string; ready: boolean } }; found: { downloading: { text: string; reload: boolean };
    text: string; badge: string; reload: boolean; reloads: number }; at: string[] }; missing?: string };
  const a = r.after, t = r.then;
  const j = JSON.stringify({ after: a, then: t, missing: r.missing });
  expect(!!a && !!t, `no result: ${j}`);
  expect(a!.atLoad === 0, `fetched at load: ${j}`);
  expect(a!.served === a!.version, `the server's own: ${j}`);
  // (Headless Chrome can keep the page visible behind another tab, as after a tab capture that failed to start:
  // Screenshot...'s check. Then it's not checked behind, only that nothing was fetched.)
  if (t!.behind[0] !== 'hidden') console.log(`  (behind another tab not checked: the page stayed ${t!.behind[0]})`);
  expect(t!.away === 0 && t!.behind[1] === 0, `fetched while staying or behind: ${j}`);
  expect(t!.shown.fetches === 1 && !t!.shown.hidden && t!.shown.inside && t!.shown.ready &&
    t!.shown.title.includes('9.9.9-new') && /reload/.test(t!.shown.title), `the badge on coming back: ${j}`);
  expect(t!.about.open && !t!.about.folded && t!.about.fetched === 0 && !t!.about.hidden &&
    !!t!.about.text?.includes('9.9.9-new') && t!.about.reload && t!.about.check === 'Check for updates',
    `About: ${j}`);
  expect(t!.at.length === 1 && t!.at[0] !== 'before', `Check for updates moved: ${j}`);
  expect(t!.downSeen.text === 'The server could not be reached: no connection.' && t!.downSeen.reload &&
    t!.downSeen.badge, `checked, unreachable with a version seen: ${j}`);
  expect(t!.same.checking === 'Checking...' && t!.same.text === 'This is the latest version.' && !t!.same.reload &&
    !t!.same.badge && t!.same.fetched === 2, `checked, the same: ${j}`);
  expect(t!.down.text === 'The server could not be reached: no connection.' && !t!.down.badge,
    `checked, unreachable: ${j}`);
  expect(t!.hang.text === 'The server could not be reached: no answer within 0.5 s.' && t!.hang.failed,
    `checked, no answer: ${j}`);
  expect(t!.lost.text === 'Version 9.9.9-c could not be downloaded: offline.' && !t!.lost.badge && !t!.lost.reload &&
    t!.lost.state.latest === undefined, `checked, the download failed: ${j}`);
  expect(/9\.9\.9-b .*downloading/.test(t!.found.downloading.text) && !t!.found.downloading.reload,
    `checking, another downloading: ${j}`);
  expect(t!.found.text.includes('9.9.9-b') && t!.found.badge.includes('9.9.9-b') && t!.found.reload
    && t!.found.reloads === 1, `checked, another (Reload the automation layer's): ${j}`);
  return undefined;
});

await check('export', async () => {
  const r = await page(`?check`, `(async () => {
    await cadViewer.ready;
    const exp = ui.gui.controllersRecursive().find((c) => c._name === 'Export...');
    const before = exp._disabled;
    await ui.openUrl('/content/as1.stp');
    await cadViewer.idle();
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    const files = [];
    window.showSaveFilePicker = async (o) => {
      const f = { name: o.suggestedName, accept: Object.values(o.types?.[0]?.accept ?? {}).flat() };
      files.push(f);
      return { createWritable: async () => ({ write: async (d) => { f.bytes = new Uint8Array(await d.arrayBuffer()); },
        close: async () => {} }) };
    };
    const waitFor = async (f) => { for (let i = 0; i < 600; i++) { const x = f(); if (x) return x; await frame(); } };
    // Export... with these choices (the format, checkboxes by their key, compression, the unit), then the .bin's
    // dialog; the dialog's warnings shown as it was left.
    const run = async (format, checks = {}, compression, cancel, unit) => {
      files.length = 0;
      const done = exp.getValue().call(exp.object);
      const d = await waitFor(() => document.querySelector('dialog.cv-dialog'));
      // (By key: an option not in a select leaves it with no value, which this throws on.)
      const choose = (key, value) => {
        const s = d.querySelector('select[data-key=' + key + ']');
        s.value = value;
        if (s.value !== value) throw new Error(key + ' has no ' + value);
        s.dispatchEvent(new Event('change'));
      };
      choose('format', format);
      if (compression) choose('compression', compression);
      if (unit) choose('unit', unit);
      for (const [k, v] of Object.entries(checks)) {
        const box = d.querySelector('input[data-key=' + k + ']');
        box.checked = v;
        box.dispatchEvent(new Event('change'));
      }
      const shownBoxes = [...d.querySelectorAll('label.check')].filter((l) => !l.hidden)
        .map((l) => l.querySelector('input').dataset.key);
      const warning = [...d.querySelectorAll('p.warning')].filter((p) => !p.hidden).map((p) => p.textContent)
        .join(' ');
      d.querySelector(cancel ? 'button[value=cancel]' : 'button.primary').click();
      if (format === 'gltf' && checks.embed === false) {
        const b = await waitFor(() => [...document.querySelectorAll('dialog.cv-dialog')].find((x) =>
          x.querySelector('h2').textContent === 'Save as1.bin'));
        b.querySelector('button.primary').click();
      }
      await done;
      return { files: files.map((f) => ({ name: f.name, accept: f.accept, size: f.bytes?.length ?? 0 })),
        bytes: files.map((f) => f.bytes), shownBoxes, warning, status: document.getElementById('status').textContent };
    };
    const text = (b) => new TextDecoder().decode(b);
    // GLB's JSON chunk.
    const glbJson = (b) => text(b.subarray(20, 20 + new DataView(b.buffer, b.byteOffset).getUint32(12, true)));
    const out = {};
    const pickBefore = cadViewer.pickAt(0.5, 0.5)?.path;
    let x = await run('glb');
    // The page's meshes back from the worker (lent for the export): picks, the triangles.
    let detached = 0, attributes = 0;
    viewer.scene.traverse((o) => { const g = o.geometry; if (!g?.attributes) return;
      for (const at of [...Object.values(g.attributes), ...(g.index ? [g.index] : [])]) {
        attributes++;
        if (at.array?.buffer && at.array.buffer.byteLength === 0) detached++;
      } });
    out.back = { pick: cadViewer.pickAt(0.5, 0.5)?.path === pickBefore && pickBefore !== undefined,
      positions: viewer.graph.meshes.values().next().value.positions.length > 0, detached, attributes };
    out.draco = { files: x.files, magic: text(x.bytes[0].subarray(0, 4)), ext: glbJson(x.bytes[0])
      .includes('KHR_draco_mesh_compression'), boxes: x.shownBoxes, status: x.status };
    // Uncompressed, for reading back here: the model's own triangles in it.
    x = await run('glb', { edges: false, curves: false }, 'none');
    out.none = /KHR_draco_mesh_compression|EXT_meshopt_compression/.test(glbJson(x.bytes[0]));
    let bin = '';
    for (let i = 0; i < x.bytes[0].length; i += 8192) bin += String.fromCharCode(...x.bytes[0].subarray(i, i + 8192));
    out.plain = btoa(bin);
    out.drawn = viewer.stats().triangles;
    x = await run('glb', {}, 'meshopt');
    out.meshopt = [glbJson(x.bytes[0]).includes('EXT_meshopt_compression'),
      glbJson(x.bytes[0]).includes('KHR_draco_mesh_compression')];
    x = await run('gltf', { embed: true }, 'none');
    out.embedded = { files: x.files, uri: JSON.parse(text(x.bytes[0])).buffers[0].uri.slice(0, 37) };
    x = await run('gltf', { embed: false }, 'none');
    const gj = JSON.parse(text(x.bytes[0]));
    out.beside = { files: x.files, uri: gj.buffers[0].uri, length: gj.buffers[0].byteLength, bin: x.bytes[1]?.length,
      status: x.status };
    x = await run('threejs', { edges: true });
    const tj = text(x.bytes[0]);
    out.threejs = { files: x.files, type: JSON.parse(tj).metadata.type, lines: tj.includes('"LineSegments"'),
      boxes: x.shownBoxes };
    x = await run('3mf', { edges: false });
    out.threemf = { files: x.files, magic: text(x.bytes[0].subarray(0, 2)), boxes: x.shownBoxes };
    // The viewer's hiding: a part hidden, three.js JSON with and without it applied.
    const m = ui.panel().model;
    const hiddenCount = (b) => (text(b).match(/"visible":false/g) ?? []).length;
    ui.setHidden([m.nodes.find((n) => n.kind === 'part').id], true);
    x = await run('threejs', { shown: false });
    const without = hiddenCount(x.bytes[0]);
    x = await run('threejs', { shown: true });
    out.shown = [without, hiddenCount(x.bytes[0])];
    ui.showAll();
    // Remembered: the next dialog starts with the last choice (three.js, applied).
    exp.getValue().call(exp.object);
    const d = await waitFor(() => document.querySelector('dialog.cv-dialog'));
    out.remembered = [d.querySelector('select[data-key=format]').value, d.querySelector('input[data-key=shown]').checked];
    d.querySelector('button[value=cancel]').click();
    await frame();
    // Cancelled: nothing asked or saved.
    x = await run('glb', {}, undefined, true);
    out.cancelled = x.files.length;
    // The unit: glTF in centimetres (said: its readers take metres), its top node turned by 1 / 10; STEP in inches
    // (nothing said); back to each format's own.
    x = await run('glb', {}, 'none', false, 'cm');
    const g = JSON.parse(glbJson(x.bytes[0])), top = g.nodes[g.scenes[0].nodes[0]];
    out.glbCm = { warning: x.warning, scale: top.matrix ? Math.hypot(...top.matrix.slice(0, 3)) : top.scale?.[0] ?? 1 };
    x = await run('step', {}, undefined, false, 'in');
    out.stepIn = { inch: text(x.bytes[0]).includes("CONVERSION_BASED_UNIT('INCH'"), warning: x.warning };
    x = await run('step', {}, undefined, false, 'default');
    // (An inch is defined by millimetres, so millimetres alone mean no inch written.)
    out.stepDefault = text(x.bytes[0]).includes('SI_UNIT(.MILLI.,.METRE.)')
      && !text(x.bytes[0]).includes('CONVERSION_BASED_UNIT');
    return { before, ...out };
  })()`) as { after: Record<string, any> };
  const a = r.after, j = JSON.stringify({ ...a, plain: undefined });
  expect(a.before === true, `disabled with no model: ${j}`);
  expect(a.draco.files.length === 1 && a.draco.files[0].name === 'as1.glb' && a.draco.files[0].accept.join() ===
    '.glb' && a.draco.magic === 'glTF' && a.draco.ext && /^exported as1\.glb, /.test(a.draco.status),
  `GLB with Draco: ${j}`);
  // (Not empty: the model's meshes in them, 8,048 triangles; the worker had handed its own to the page.)
  expect([a.draco, a.embedded, a.threejs, a.threemf].every((x) => x.files[0].size > 10_000), `sizes: ${j}`);
  expect(a.meshopt[0] === true && a.meshopt[1] === false, `GLB with meshopt: ${j}`);
  expect(a.none === false, `GLB uncompressed: ${j}`);
  // Read back with our importer: as many placed triangles as the viewer draws.
  const back = (await importGltf(Buffer.from(a.plain, 'base64'))).scene;
  let placed = 0;
  for (const pi of partInstances(back)) placed += (back.parts[pi.part]!.lods[0]?.mesh.indices.length ?? 0) / 3;
  expect(placed === a.drawn && placed > 0, `read back: ${placed} triangles placed, ${a.drawn} drawn`);
  expect(a.back.pick && a.back.positions && a.back.detached === 0 && a.back.attributes > 50, `the meshes back: ${j}`);
  expect(a.embedded.files.length === 1 && a.embedded.files[0].name === 'as1.gltf' &&
    a.embedded.uri === 'data:application/octet-stream;base64,', `.gltf embedded: ${j}`);
  expect(a.beside.files.map((f: { name: string }) => f.name).join() === 'as1.gltf,as1.bin' &&
    a.beside.uri === 'as1.bin' && a.beside.bin === a.beside.length && /and as1\.bin/.test(a.beside.status),
  `.gltf and its .bin: ${j}`);
  expect(a.threejs.files[0].name === 'as1.json' && a.threejs.type === 'Object' && a.threejs.lines &&
    !a.threejs.boxes.includes('instancing'), `three.js JSON: ${j}`);
  expect(a.threemf.files[0].name === 'as1.3mf' && a.threemf.magic === 'PK' && a.threemf.boxes.includes('assembly') &&
    !a.threemf.boxes.includes('edges'), `3MF: ${j}`);
  expect(a.shown[1] === a.shown[0] + 1, `the viewer's hiding: ${j}`);
  expect(a.remembered.join() === 'threejs,true' && a.cancelled === 0, `remembered, cancelled: ${j}`);
  expect(/glTF readers take lengths for metres/.test(a.glbCm.warning) && Math.abs(a.glbCm.scale - 0.1) < 1e-6,
    `glTF in centimetres: ${j}`);
  expect(a.stepIn.inch && a.stepIn.warning === '' && a.stepDefault, `STEP in inches, then its default: ${j}`);
  return undefined;
});
// The model worker lost during an export (detected by its heartbeat, the model made again): the export's message
// swallowed, its meshes handed away all the same (as a dead worker keeps them), the silence allowed 1.5 s: the watchdog
// says so, an error dialog, the worker stopped, and the model loaded and meshed again as it was, its view and overrides
// kept, its meshes back (no detached attributes), the controls' meshing as they were.
await check('export: the worker lost', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/as1.stp')}&check`, `(async () => {
    await cadViewer.ready;
    await cadViewer.idle();
    const m0 = ui.panel().model;
    const hidden = m0.nodes.find((n) => n.kind === 'part').id;
    ui.setHidden([hidden], true);
    const overrides = JSON.stringify(cadViewer.state().hidden);
    const triangles = viewer.stats().triangles;
    // The controls changed without meshing again: the model's own settings used for the rebuild, these back after.
    ui.setMeshing({ profile: 'custom', linearDeflection: 0.7 });
    const worker = viewer.modelWorker();
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (msg, transfer) => msg.type === 'export' ? new MessageChannel().port1.postMessage(msg, transfer)
      : post(msg, transfer);
    viewer.exportSilenceMs = 1500;
    const statuses = [];
    const st = document.getElementById('status');
    new MutationObserver(() => statuses.push(st.textContent)).observe(st, { childList: true, characterData: true,
      subtree: true });
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => {},
      close: async () => {} }) });
    const exp = ui.gui.controllersRecursive().find((c) => c._name === 'Export...');
    const done = exp.getValue().call(exp.object);
    const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    let d;
    for (let i = 0; i < 300 && !(d = document.querySelector('dialog.cv-dialog')); i++) await frame();
    d.querySelector('button.primary').click();
    await done;
    const errorDialog = [...document.querySelectorAll('dialog.cv-dialog.error')].map((x) => x.textContent);
    const status = statuses.join(' | ');
    const stopped = viewer.worker === undefined;
    await cadViewer.idle();
    let detached = 0;
    viewer.scene.traverse((o) => { const g = o.geometry; if (!g?.attributes) return;
      for (const at of [...Object.values(g.attributes), ...(g.index ? [g.index] : [])]) {
        if (at.array?.buffer && at.array.buffer.byteLength === 0) detached++;
      } });
    // (Every placed B-rep part's model with the page again, from the new load.)
    const breps = [...viewer.graph.placements.keys()].filter((i) => viewer.graph.scene.parts[i].brep);
    const held = breps.length > 0 && breps.every((i) => viewer.graph.modelOf(i)?.face.id.length > 0);
    return { errorDialog, status, stopped, again: viewer.stats().triangles === triangles, newModel: ui.panel().model !== m0,
      overrides: JSON.stringify(cadViewer.state().hidden) === overrides, detached, held,
      controls: viewer.settings.linearDeflection, meshedWith: viewer.model.meshedWith.linearDeflection,
      pick: !!cadViewer.pickAt(0.5, 0.5) };
  })()`) as { after: { errorDialog: string[]; status: string; stopped: boolean; again: boolean; newModel: boolean;
    overrides: boolean; detached: number; controls: number; meshedWith: number; pick: boolean; held: boolean } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.errorDialog.length === 1 && /the model worker stopped \(nothing from it for \d s\)/.test(
    a.errorDialog[0]!) && /loaded and meshed again/.test(a.errorDialog[0]!), `the error said: ${j}`);
  // (Whatever format was remembered from the checks before.)
  expect(/exporting as1\.\w+\.\.\. \| loading as1\.stp\.\.\./.test(a.status) && a.stopped,
    `the worker stopped, loading again: ${j}`);
  expect(a.newModel && a.again && a.overrides && a.detached === 0 && a.pick && a.held, `made again: ${j}`);
  expect(a.controls === 0.7 && a.meshedWith !== 0.7, `meshed as it was, the controls back: ${j}`);
  return undefined;
});
await check('save', async () => {
  const r = await page(`?check`, `(async () => {
    await cadViewer.ready;
    const save = ui.gui.controllersRecursive().find((c) => c._name === 'Save original...');
    const before = save._disabled;
    await ui.openUrl('/content/as1.stp');
    await cadViewer.idle();
    const want = new Uint8Array(await (await fetch('/content/as1.stp')).arrayBuffer());
    const same = (b) => b.length === want.length && b.every((x, i) => x === want[i]);
    let suggested, written;
    window.showSaveFilePicker = async (o) => { suggested = o.suggestedName; return { createWritable: async () => ({
      write: async (d) => { written = new Uint8Array(await d.arrayBuffer()); }, close: async () => {} }) }; };
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

// Save original... reads the file again (the page keeps no copy) and checks it against the SHA-256 it had when it
// loaded: by URL, a server now giving other bytes is said and asked (Cancel: not saved; Save anyway: the new bytes
// written), one that can't be fetched is said, nothing written; a local file (its File, read from disk again) the
// same: as it was, saved; changed, asked; unreadable (moved, deleted), said.
await check('save a file changed or gone', async () => {
  const r = await page(`?check`, `(async () => {
    await cadViewer.ready;
    const save = ui.gui.controllersRecursive().find((c) => c._name === 'Save original...');
    const open = () => document.querySelector('dialog.cv-dialog[open]');
    let written;
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async (d) => { written = new Uint8Array(await d.arrayBuffer()); }, close: async () => {} }) });
    // Saved, a dialog's title and the answer given (if it asks), the status line after.
    const saveAs = async (answer) => {
      written = undefined;
      const done = save.getValue().call(save.object);
      let title;
      for (let t = 0; t < 20 && !open(); t++) await new Promise((res) => setTimeout(res, 50));
      if (open()) {
        title = open().querySelector('h2').textContent;
        (open().querySelector('button[value=' + answer + ']') ?? open().querySelector('button')).click();
      }
      await done;
      return { title, written: written?.length, status: document.getElementById('status').textContent };
    };
    await ui.openUrl('/content/heal.stp');
    await cadViewer.idle();
    const size = ui.source().size;
    const fetchWas = window.fetch;
    const url = new URL('/content/heal.stp', location.href).href;
    window.fetch = async (u, o) => (new URL(String(u), location.href).href === url ? new Response(new Uint8Array(
      [1, 2, 3])) : fetchWas(u, o));
    const changedCancel = await saveAs('cancel'), changedSave = await saveAs('save');
    window.fetch = async (u, o) => (new URL(String(u), location.href).href === url
      ? Promise.reject(new TypeError('Failed to fetch')) : fetchWas(u, o));
    const gone = await saveAs('ok');
    window.fetch = fetchWas;
    const same = await saveAs('ok');
    // A local file: its File kept, read again.
    const bytes = new Uint8Array(await (await fetch('/content/heal.stp')).arrayBuffer());
    await ui.openFiles([new File([bytes], 'heal.stp')]);
    await cadViewer.idle();
    const local = { file: ui.source().file instanceof File, bytes: ui.source().bytes === undefined };
    const localSame = await saveAs('ok');
    // (The same size, one byte different: the hash tells.)
    const flipped = bytes.slice();
    flipped[flipped.length - 1] ^= 1;
    ui.source().file = new File([flipped], 'heal.stp');
    const localChanged = await saveAs('cancel');
    ui.source().file = { name: 'heal.stp', arrayBuffer: () => Promise.reject(new DOMException('gone',
      'NotReadableError')) };
    const localGone = await saveAs('ok');
    return { size, changedCancel, changedSave, gone, same, local, localSame, localChanged, localGone };
  })()`) as { after: { [k in 'changedCancel' | 'changedSave' | 'gone' | 'same' | 'localSame' | 'localChanged'
    | 'localGone']: { title?: string; written?: number; status: string } } & { size: number;
    local: { file: boolean; bytes: boolean } } };
  const a = r.after, j = JSON.stringify(a);
  expect(a.changedCancel.title === 'heal.stp has changed' && a.changedCancel.written === undefined
    && /not saved/.test(a.changedCancel.status), `changed on the server, cancelled: ${j}`);
  expect(a.changedSave.title === 'heal.stp has changed' && a.changedSave.written === 3, `saved anyway: ${j}`);
  expect(a.gone.title === 'Could not read heal.stp' && a.gone.written === undefined, `can't be fetched: ${j}`);
  expect(a.same.title === undefined && a.same.written === a.size, `unchanged: saved: ${j}`);
  expect(a.local.file && a.local.bytes && a.localSame.title === undefined && a.localSame.written === a.size,
    `a local file: its File kept, saved: ${j}`);
  expect(a.localChanged.title === 'heal.stp has changed' && a.localChanged.written === undefined,
    `a local file changed: asked: ${j}`);
  expect(a.localGone.title === 'Could not read heal.stp' && a.localGone.written === undefined
    && /moved, deleted or changed/.test(a.localGone.status), `a local file gone: said: ${j}`);
  return undefined;
});
await check('missing file', async () => {
  const r = await page(`?url=${encodeURIComponent('/content/nothing.glb')}&check`);
  expect(typeof r.error === 'string' && /not found \(404/.test(r.error), `report ${JSON.stringify(r)}`);
  return undefined;
});

// What a build holds (printing nothing as it's made): one Draco decoder (draco3dgltf's, for gltf-import in the import
// worker: the GLBs above loaded through it) and its encoder (for Export..., export-gltf there); licenses.md with the
// npm packages' licenses, OCCT's and SMLib's, not precached by its service worker (which precaches the backends'
// modules), nor are version.json (update-check.ts) and the documents' PDFs.
if (staticServer) {
  await check('build', async () => {
    expect(buildOutput.trim() === '', `the build printed: ${buildOutput.slice(0, 1000)}`);
    const assets = fs.readdirSync(path.join(dist, 'assets'));
    const draco = assets.filter((f) => f.startsWith('draco_'));
    expect(draco.length === 2 && draco.some((f) => /^draco_decoder_gltf-.*\.wasm$/.test(f)) &&
      draco.some((f) => /^draco_encoder-.*\.wasm$/.test(f)), `Draco's files: ${draco}`);
    const licenses = fs.readFileSync(path.join(dist, 'licenses.md'), 'utf8');
    expect(['### three - 0.186.1 (MIT)', '### @headless-tree/core', '`@gltf-transform/core`', 'draco3dgltf',
      'meshoptimizer', 'Open CASCADE exception (version 1.0)', 'NVIDIA CORPORATION', 'Apache License',
      'GNU LESSER GENERAL PUBLIC LICENSE', 'GNU AFFERO GENERAL PUBLIC LICENSE', '`assets/tess_cadio-*.wasm`']
      .every((t) => licenses.includes(t)),
      'licenses.md');
    expect(!fs.existsSync(path.join(dist, '.vite')), 'Vite\'s own licenses file left');
    const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
    // (The PDFs are named in the navigation fallback's denylist, not in the precache list's entries.)
    expect(sw.includes('occt_tess-') && sw.includes('smlib_tess-') && sw.includes('tess_cadio-') &&
      !sw.includes('licenses.md') &&
      !sw.includes('version.json') &&
      !/url:"[^"]*\.pdf"/.test(sw), 'the precache list');
    for (const pdf of ['README.pdf', 'step_tutorial.pdf']) {
      expect(fs.readFileSync(path.join(dist, pdf)).subarray(0, 5).toString() === '%PDF-', `no ${pdf}`);
    }
    expect(fs.existsSync(path.join(dist, 'version.json')), 'no version.json');
    return undefined;
  });
}

// The documents' PDFs (a build only), as About's links open them: navigated to in a tab the service worker controls,
// the server's PDF, not the app shell (the worker answers navigations it doesn't know with index.html).
if (staticServer) {
  await check('document PDFs', async () => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const evaluate = async (expression: string) => {
      const e = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId) as
        { result: { value: unknown }; exceptionDetails?: { text: string } };
      if (e.exceptionDetails) throw new Error(e.exceptionDetails.text);
      return e.result.value;
    };
    const settled = async (want: (v: unknown) => boolean, expression: string) => {
      let v: unknown;
      for (let t = 0; t < 300; t++) {
        v = await evaluate(expression).catch(() => undefined);
        if (want(v)) return v;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return v;
    };
    try {
      await send('Page.enable', {}, sessionId);
      await send('Page.navigate', { url: `http://localhost:${port}${base}?check` }, sessionId);
      await settled((v) => !!v, 'document.body?.dataset.report ?? null');
      let controlled = await settled((v) => v === true, '!!navigator.serviceWorker.controller');
      if (!controlled) {
        await send('Page.reload', {}, sessionId);
        controlled = await settled((v) => v === true, '!!navigator.serviceWorker.controller');
      }
      expect(controlled === true, 'no service worker controls the page');
      // Each navigation's response as the tab got it (headless Chrome downloads a PDF rather than showing it, so the
      // document can't be asked): its type, and whether the service worker answered.
      const got: Record<string, { mimeType: string; fromServiceWorker: boolean }> = {};
      const listener = (e: { method: string; params: Record<string, unknown>; sessionId?: string }) => {
        if (e.sessionId !== sessionId || e.method !== 'Network.responseReceived' || e.params.type !== 'Document') return;
        const r = e.params.response as { url: string; mimeType: string; fromServiceWorker?: boolean };
        const name = new URL(r.url).pathname.split('/').pop()!;
        got[name] = { mimeType: r.mimeType, fromServiceWorker: r.fromServiceWorker === true };
      };
      headless.events.add(listener);
      await send('Network.enable', {}, sessionId);
      const pdfs = ['README.pdf', 'step_tutorial.pdf'];
      for (const pdf of pdfs) {
        await send('Page.navigate', { url: `http://localhost:${port}${base}${pdf}` }, sessionId);
        for (let t = 0; t < 100 && !got[pdf]; t++) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      headless.events.delete(listener);
      expect(pdfs.every((p) => got[p]?.mimeType === 'application/pdf' && !got[p].fromServiceWorker),
        `the PDFs as opened: ${JSON.stringify(got)}`);
    } finally {
      await send('Target.closeTarget', { targetId });
    }
    return undefined;
  });
}

// A new deployment (a build only): with the page controlled by its service worker, the build on the server becomes
// another, as a deployment would make it: its main bundle with another version under another name, index.html and
// the worker's precache list naming it, version.json saying so. The page's check sees it, and is ready once the new
// worker has taken over; one reload then shows the new version, which the check then finds the same. Before it, a
// deployment whose worker can't install (a file missing): the download fails, said, and nothing changes.
if (staticServer) {
  await check('new deployment', async () => {
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
    const title = "document.querySelector('.lil-gui .title').textContent";
    try {
      await send('Page.enable', {}, sessionId);
      await send('Page.navigate', { url: `http://localhost:${port}${base}?check` }, sessionId);
      expect(await ready(), 'the page never reported');
      let controlled = await evaluate(`Promise.race([navigator.serviceWorker.ready.then(() => new Promise((r) =>
        setTimeout(() => r(!!navigator.serviceWorker.controller), 500))), new Promise((r) => setTimeout(() => r(false),
        20000))])`);
      if (!controlled) {
        await send('Page.reload', {}, sessionId);
        await ready();
        controlled = await evaluate('!!navigator.serviceWorker.controller');
      }
      expect(controlled === true, 'no service worker controls the page');
      const old = (JSON.parse(fs.readFileSync(path.join(dist, 'version.json'), 'utf8')) as { version: string }).version;
      expect(await evaluate(title) === `cad-io-js ${old}`, `the title before: ${await evaluate(title)}`);
      await evaluate('ui.updates.check(true)');
      expect(await evaluate('ui.updates.state.latest ?? null') === null, 'an update before the deployment');
      const html = path.join(dist, 'index.html'), sw = path.join(dist, 'sw.js');
      // A deployment whose download fails: its worker's precache names a file the server doesn't have, so the new
      // worker's install fails (it's discarded): the check says so, the version is dropped, the page as it was.
      const swGood = fs.readFileSync(sw, 'utf8');
      const swBroken = swGood.replace('precacheAndRoute([',
        'precacheAndRoute([{url:"assets/missing.js",revision:null},');
      expect(swBroken !== swGood, 'the broken precache list');
      fs.writeFileSync(sw, swBroken);
      fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version: `${old}-broken` }));
      const broken = await evaluate(`Promise.race([ui.updates.check(true).then((r) => ({ r, state: ui.updates.state,
        badge: !document.querySelector('.lil-gui .title .update-badge').hidden })),
        new Promise((r) => setTimeout(() => r('timed out'), 60000))])`) as { r: { error?: string };
        state: { latest?: string }; badge: boolean };
      expect(broken.r.error === `Version ${old}-broken could not be downloaded: its files could not all be fetched.`
        && broken.state.latest === undefined && !broken.badge, `the broken deployment: ${JSON.stringify(broken)}`);
      // And one whose worker's script can't be fetched (gone): the same.
      fs.rmSync(sw);
      fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version: `${old}-gone` }));
      const gone = await evaluate(`ui.updates.check(true).then((r) => ({ r, state: ui.updates.state }))`) as
        { r: { error?: string }; state: { latest?: string } };
      expect(gone.r.error === `Version ${old}-gone could not be downloaded: its service worker could not be fetched.`
        && gone.state.latest === undefined, `the deployment without its worker: ${JSON.stringify(gone)}`);
      fs.writeFileSync(sw, swGood);
      // The deployment.
      const next = `${old}-next`;
      const main = /assets\/index-[\w-]+\.js/.exec(fs.readFileSync(html, 'utf8'))![0];
      const renamed = main.replace(/\.js$/, 'n.js');
      const code = fs.readFileSync(path.join(dist, main), 'utf8');
      expect(code.includes(old), 'the version in the main bundle');
      fs.writeFileSync(path.join(dist, renamed), code.split(old).join(next));
      fs.rmSync(path.join(dist, main));
      fs.writeFileSync(html, fs.readFileSync(html, 'utf8').split(main).join(renamed));
      const swText = fs.readFileSync(sw, 'utf8');
      const swNext = swText.split(main).join(renamed).replace(/(url:"index\.html",revision:")[^"]+/, '$1next');
      expect(swNext !== swText && swNext.includes('revision:"next"'), 'the precache list rewritten');
      fs.writeFileSync(sw, swNext);
      fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version: next }));
      const seen = await evaluate(`Promise.race([ui.updates.check(true).then(() => ui.updates.state),
        new Promise((r) => setTimeout(() => r('timed out'), 60000))])`) as { latest?: string; ready: boolean };
      expect(seen.latest === next && seen.ready, `seen: ${JSON.stringify(seen)}`);
      const badge = await evaluate("document.querySelector('.lil-gui .title .update-badge').title") as string;
      expect(badge.includes(next), `the badge: ${badge}`);
      await send('Page.reload', {}, sessionId);
      expect(await ready(), 'the page did not come back');
      expect(await evaluate(title) === `cad-io-js ${next}`, `after one reload: ${await evaluate(title)}`);
      await evaluate('ui.updates.check(true)');
      expect(await evaluate('ui.updates.state.latest ?? null') === null, 'still an update after the reload');
      return undefined;
    } finally {
      await send('Target.closeTarget', { targetId });
    }
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
      expect(r.triangles === triangles && r.parts.failed === 0 && /^occt\+smlib /.test(r.backend),
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
