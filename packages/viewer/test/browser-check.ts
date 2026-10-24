// The viewer in a real browser, which `npm test` can't reach: makes a model in each three.js-loadable format (GLB
// with Draco, glTF with meshopt and a .bin beside it, three.js JSON) from one STEP assembly, starts the dev server on
// them (cad-viewer start), opens each in headless Chrome (?url=...&check) and compares what the page reports with
// what the scene says, computed here independently of the viewer: the triangles, and the world box in millimetres
// with Z up (so each format's frame mapping is checked). Also: the page with no model, and an unknown file.
// Run by hand: node packages/viewer/test/browser-check.ts [path to Chrome]   (needs tess-occt built and the corpus;
// SHOTS=<dir> saves a screenshot of each page there; BUILD=1 checks a build, served by vite preview, instead of the
// dev server)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { exportView, partInstances, tessellateScene } from 'cad-scene';
import { glb, gltfJson } from 'export-gltf';
import { threejsJson } from 'export-threejs';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { main } from '../bin/viewer.ts';

const repo = path.resolve(import.meta.dirname, '../../..');
const chrome = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const step = path.join(repo, 'test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-viewer-check-'));
const content = path.join(tmp, 'content');
fs.mkdirSync(content);

// The models, and what the scene says they hold.
const { scene } = await importStep(fs.readFileSync(step));
const occt = new OcctTessellator();
await occt.init();
const { meshes } = await tessellateScene(scene, occt, { linearDeflection: 0.1, angularDeflection: 0.5, edges: true });
occt.dispose();
const view = exportView(scene, meshes, { edges: true });
fs.writeFileSync(path.join(content, 'as1.glb'), (await glb(scene, view)).bytes);
const meshopt = await gltfJson(scene, view, 'as1-meshopt.bin', { compression: 'meshopt' });
fs.writeFileSync(path.join(content, 'as1-meshopt.gltf'), meshopt.json);
fs.writeFileSync(path.join(content, 'as1-meshopt.bin'), meshopt.bin);
fs.writeFileSync(path.join(content, 'as1.json'), threejsJson(scene, view));
fs.writeFileSync(path.join(content, 'as1.json.extras.json'), threejsJson(scene, view, { extras: true }));
fs.writeFileSync(path.join(content, 'notes.txt'), 'not a model');

let triangles = 0;
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (const p of partInstances(scene)) {
  const m = meshes.get(p.part);
  if (!p.visible || !m) continue;
  triangles += m.indices.length / 3;
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
let preview: ReturnType<typeof spawn> | undefined;
if (process.env.BUILD) {
  // vite build into the temporary directory, then vite preview on it, with the same content root.
  const viewer = path.resolve(import.meta.dirname, '..');
  const vite = path.join(repo, 'node_modules/vite/bin/vite.js');
  const env = { ...process.env, VIEWER_CONTENT_ROOT: content, VIEWER_PORT: String(port) };
  const dist = path.join(tmp, 'dist');
  await new Promise<void>((resolve, reject) => spawn(process.execPath, [vite, 'build', '--outDir', dist, '--logLevel',
    'warn'], { cwd: viewer, env, stdio: 'inherit' }).on('exit', (c) => c === 0 ? resolve() : reject(new Error(
    'vite build failed'))));
  preview = spawn(process.execPath, [vite, 'preview', '--outDir', dist], { cwd: viewer, env, stdio: 'ignore' });
  for (let t = 0; t < 100; t++) {
    const up = await new Promise<boolean>((resolve) => net.connect(port, '127.0.0.1').once('connect',
      function (this: net.Socket) { this.destroy(); resolve(true); }).once('error', () => resolve(false)));
    if (up) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} else if (await main(['start', '--content-root', content, '--port', String(port)], io) !== 0) process.exit(1);

// Chrome over the DevTools protocol: a tab per page, polled until the page reports (real time: Draco decodes in a
// worker, which --virtual-time-budget doesn't wait for).
const profile = path.join(tmp, 'chrome');
const browser = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0',
  'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const endpoint = await new Promise<string>((resolve, reject) => {
  let s = '';
  browser.stderr.on('data', (c) => {
    s += c;
    const m = /DevTools listening on (ws:\S+)/.exec(s);
    if (m) resolve(m[1]!);
  });
  browser.on('error', reject).on('exit', () => reject(new Error(`Chrome exited: ${s}`)));
});
const ws = new WebSocket(endpoint);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map<number, (r: { result?: Record<string, unknown>; error?: unknown }) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
  if (m.id !== undefined) pending.get(m.id)?.(m);
};
const send = (method: string, params: object = {}, sessionId?: string) => new Promise<Record<string, unknown>>(
  (resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result ?? {}));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

/** Opens a page and waits for its report; `after`, an expression, is then evaluated there, its value the `after`. */
async function page(query: string, after?: string): Promise<Record<string, unknown>> {
  const { targetId } = await send('Target.createTarget', { url: `http://localhost:${port}/${query}` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  try {
    for (let t = 0; t < 600; t++) {
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
        if (after) report.after = ((await send('Runtime.evaluate', { expression: after, returnByValue: true },
          sessionId)) as { result: { value: unknown } }).result.value;
        return report;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const status = await send('Runtime.evaluate', { expression: "document.getElementById('status')?.textContent",
      returnByValue: true }, sessionId) as { result: { value: string } };
    return { missing: `no report within 60 s; status: ${status.result.value}` };
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}

const results: [string, string][] = [];
const check = async (name: string, f: () => Promise<string | undefined>) => {
  try { results.push([name, (await f()) ?? 'ok']); } catch (e) { results.push([name, `FAIL ${(e as Error).message}`]); }
};
const expect = (c: boolean, m: string) => { if (!c) throw new Error(m); };

// A first load, whose report isn't used: Vite optimizes the dependencies it finds on first use, and reloads the
// page when it does.
await page('?check');

// Centring and back, through the page's `viewer`: [display position, target before, target after] each way.
const CENTER = `(() => { const v = globalThis.viewer; const t0 = v.controls.target.toArray(); v.setCentered(true);
  const on = [v.display.position.toArray(), t0, v.controls.target.toArray()]; v.setCentered(true); v.setCentered(false);
  return { on, off: [v.display.position.toArray(), v.controls.target.toArray()] }; })()`;

// Draco quantizes positions to 14 bits over each part mesh's extent, meshopt to 16: well under 0.05 mm here.
const TOL = 0.05;
for (const file of ['as1.glb', 'as1-meshopt.gltf', 'as1.json', 'as1.json.extras.json']) {
  await check(file, async () => {
    const r = await page(`?url=${encodeURIComponent(`/content/${file}`)}&check`, CENTER) as {
      stats?: { triangles: number }; box?: number[][]; centroid?: number[]; error?: string; missing?: string;
      after?: { on: number[][]; off: number[][] } };
    expect(!r.error && !r.missing, `no model: ${r.error ?? r.missing}`);
    expect(r.stats!.triangles === triangles, `${r.stats!.triangles} triangles, expected ${triangles}`);
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
await check('no model', async () => {
  const r = await page('?check');
  expect(r.empty === true, `report ${JSON.stringify(r)}`);
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

ws.close();
browser.kill();
if (preview) preview.kill();
else await main(['stop'], io);
fs.rmSync(tmp, { recursive: true, force: true });
const rounded = [lo, hi].map((v) => v.map((x) => +x.toFixed(3)));
console.log(`expected: ${triangles} triangles, box ${JSON.stringify(rounded)}`);
for (const [name, r] of results) console.log(`${r === 'ok' ? 'ok  ' : 'FAIL'} ${name}${r === 'ok' ? '' : `: ${r}`}`);
process.exit(results.every(([, r]) => r === 'ok') ? 0 : 1);
