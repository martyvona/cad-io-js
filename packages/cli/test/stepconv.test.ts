// Needs the built backends (packages/tess-occt/build.sh, packages/tess-truck/build.sh) and the corpus
// (test_corpus/third_party/pull.sh); skipped without them.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import diagnostics_channel from 'node:diagnostics_channel';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { exportView, tessellateScene } from 'cad-scene';
import { threejsJson } from 'export-threejs';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { stepconv } from '../src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const cube = path.join(root, 'test_corpus/third_party/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp');
const assembly = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
const wireframe = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/trj4_k1_geo-pe-203.stp');
const occtBuilt = fs.existsSync(path.join(root, 'packages/tess-occt/dist/occt_tess.wasm'));
const truckBuilt = fs.existsSync(path.join(root, 'packages/tess-truck/dist/tess_truck.wasm'));
const skip = !occtBuilt ? 'tess-occt not built' : !fs.existsSync(assembly) ? 'corpus not fetched' : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stepconv-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function sink() {
  const chunks: Buffer[] = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}
async function run(args: string[], stdin: Readable = Readable.from([])) {
  const out = sink(), err = sink();
  const code = await stepconv(args, { stdout: out.stream, stderr: err.stream, stdin });
  return { code, stdout: out.text(), stderr: err.text() };
}
const load = (json: string) => new THREE.ObjectLoader().parse(JSON.parse(json));
const triangles = (o: THREE.Object3D) => {
  let n = 0;
  o.traverse((x) => { if (x instanceof THREE.Mesh) n += x.geometry.index!.count / 3; });
  return n;
};

test('stepconv: the same file as the library pipeline, in a worker pool and on the main thread', { skip }, async () => {
  const out = path.join(tmp, 'as1.json');
  // The library's own pipeline, for comparison.
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  const { meshes } = await tessellateScene(scene, tess, { linearDeflection: 0.1, angularDeflection: 0.5, edges: true });
  tess.dispose();
  const expected = threejsJson(scene, exportView(scene, meshes, { edges: true, curves: true }), { name: 'as1-oc-214-mat' });
  for (const workers of ['2', '0']) {
    const r = await run([assembly, '-o', out, '--edges', '--curves', '-j', workers]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), expected, `workers ${workers}`);
    assert.match(r.stderr, /^5 parts \(5 of 5 brep parts tessellated\), 18 placed; 5180 triangles; 0\.2 MB written\nimport [\d.]+ s, tessellation [\d.]+ s, export [\d.]+ s\n0 errors, 0 warnings, 0 notes\n$/);
  }
  const loaded = load(expected);
  assert.equal(loaded.name, 'as1-oc-214-mat');
  assert.equal(triangles(loaded), 5180);
  let lines = 0;
  loaded.traverse((x) => { if (x instanceof THREE.LineSegments) lines++; });
  assert.ok(lines > 0);
  // The defaults: no edges, single-sided; --double-sided.
  const plain = await run([assembly, '-o', out]);
  assert.equal(plain.code, 0);
  const p = load(fs.readFileSync(out, 'utf8'));
  let sides = new Set<number>(), noLines = true;
  p.traverse((x) => {
    if (x instanceof THREE.LineSegments) noLines = false;
    if (x instanceof THREE.Mesh) for (const m of [x.material].flat()) sides.add((m as THREE.Material).side);
  });
  assert.ok(noLines);
  assert.deepEqual([...sides], [THREE.FrontSide]);
  assert.equal((await run([assembly, '-o', out, '--double-sided', '-q'])).stderr, '');
  sides = new Set();
  load(fs.readFileSync(out, 'utf8')).traverse((x) => { if (x instanceof THREE.Mesh) for (const m of [x.material].flat()) sides.add((m as THREE.Material).side); });
  assert.deepEqual([...sides], [THREE.DoubleSide]);
});

test('stepconv: --angular in degrees', { skip }, async () => {
  const out = path.join(tmp, 'angular.json');
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  const { meshes } = await tessellateScene(scene, tess, { linearDeflection: 0.1, angularDeflection: (10 * Math.PI) / 180 });
  tess.dispose();
  const expected = threejsJson(scene, exportView(scene, meshes, {}), { name: 'as1-oc-214-mat' });
  assert.equal((await run([assembly, '-o', out, '--angular', '10', '-j', '2'])).code, 0);
  const fine = fs.readFileSync(out, 'utf8');
  assert.equal(fine, expected);
  assert.equal((await run([assembly, '-o', out, '-j', '2'])).code, 0);
  assert.ok(triangles(load(fine)) > triangles(load(fs.readFileSync(out, 'utf8'))));
});

test('stepconv: --strict exits 3 when a part fails, with the output written', { skip }, async () => {
  // The cube with its shell's faces replaced by a reference to nothing: OCCT makes no shape.
  const broken = path.join(tmp, 'broken.stp');
  const text = fs.readFileSync(cube, 'latin1');
  fs.writeFileSync(broken, text.replace(/CLOSED_SHELL\('',\([^)]*\)\)/, "CLOSED_SHELL('',(#999999))"), 'latin1');
  const out = path.join(tmp, 'broken.json');
  const lax = await run([broken, '-o', out, '-j', '0']);
  assert.equal(lax.code, 0);
  assert.match(lax.stderr, /^1 parts \(0 of 1 brep parts tessellated\)/);
  fs.rmSync(out);
  assert.equal((await run([broken, '-o', out, '-j', '0', '--strict'])).code, 3);
  assert.equal(load(fs.readFileSync(out, 'utf8')).type, 'Group');
  assert.equal((await run([cube, '-o', out, '-j', '0', '--strict'])).code, 0);
});

test('stepconv: wireframe curves on request; --workers 0 starts no worker', { skip: skip || (!fs.existsSync(wireframe) && 'corpus not fetched') }, async () => {
  const out = path.join(tmp, 'wire.json');
  const names = () => { const n: string[] = []; load(fs.readFileSync(out, 'utf8')).traverse((x) => { if (x instanceof THREE.LineSegments) n.push(x.name); }); return n; };
  let started = 0;
  const count = () => started++;
  diagnostics_channel.subscribe('worker_threads', count);
  try {
    assert.equal((await run([wireframe, '-o', out, '-j', '0'])).code, 0);
    assert.deepEqual(names(), []);
    assert.equal(started, 0);
    assert.equal((await run([wireframe, '-o', out, '--curves', '-j', '1'])).code, 0);
    assert.ok(names().length > 0 && names().every((n) => n === 'curves'));
    assert.equal(started, 1);
  } finally {
    diagnostics_channel.unsubscribe('worker_threads', count);
  }
});

test('stepconv: the cache answers a second run', { skip }, async () => {
  const cache = path.join(tmp, 'cache');
  const out = path.join(tmp, 'cached.json');
  const first = await run([assembly, '-o', out, '--cache', cache, '-j', '1']);
  assert.match(first.stderr, /\ncache: 0 hits \(0 failures\), 5 misses\n/);
  const bytes = fs.readFileSync(out);
  const second = await run([assembly, '-o', out, '--cache', cache, '--cache-size', '64', '-j', '1']);
  assert.match(second.stderr, /\ncache: 5 hits \(0 failures\), 0 misses\n/);
  assert.deepEqual(fs.readFileSync(out), bytes);
  // A different deflection, linear or angular, is a different request.
  assert.match((await run([assembly, '-o', out, '--cache', cache, '-d', '0.05', '-j', '1'])).stderr, /\ncache: 0 hits \(0 failures\), 5 misses\n/);
  assert.match((await run([assembly, '-o', out, '--cache', cache, '--angular', '20', '-j', '1'])).stderr, /\ncache: 0 hits \(0 failures\), 5 misses\n/);
  // Size 0 disables the cache.
  assert.match((await run([assembly, '-o', out, '--cache', cache, '--cache-size', '0', '-j', '1'])).stderr, /\ncache: 0 hits \(0 failures\), 0 misses\n/);
});

test('stepconv: truck', { skip: skip || (!truckBuilt && 'tess-truck not built') }, async () => {
  const out = path.join(tmp, 'cube.json');
  const r = await run([cube, '-o', out, '-b', 'truck', '-j', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(triangles(load(fs.readFileSync(out, 'utf8'))), 12);
});

test('stepconv: standard input and output, gzipped input', { skip }, async () => {
  const stdin = new PassThrough();
  stdin.end(gzipSync(fs.readFileSync(cube)));
  const r = await run(['-', '-o', '-', '-f', 'threejs', '-j', '0'], stdin);
  assert.equal(r.code, 0, r.stderr);
  const o = load(r.stdout);
  assert.equal(o.name, 'stdin');
  assert.equal(triangles(o), 12);
});

test('stepconv: usage errors and failures', async () => {
  // Outputs in the temporary directory, so a broken check that goes on to convert writes nothing elsewhere.
  const scratch = path.join(tmp, 'usage.json');
  const usage = async (args: string[], message: RegExp) => {
    const r = await run(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, message);
    assert.match(r.stderr, /Usage: stepconv/);
  };
  await usage([], /expected one input file/);
  await usage([cube], /expected an output file/);
  await usage([cube, '-o', '-'], /standard output needs --format/);
  await usage([cube, '-o', path.join(tmp, 'x.obj')], /can't tell the format from '\.obj'/);
  await usage([cube, '-o', scratch, '-f', 'stl'], /unknown format 'stl'/);
  await usage([cube, '-o', scratch, '-b', 'nope'], /unknown backend 'nope'/);
  await usage([cube, '-o', scratch, '-d', '0'], /--deflection must be a positive number/);
  await usage([cube, '-o', scratch, '--angular', 'x'], /--angular must be a positive number/);
  await usage([cube, '-o', scratch, '--angular', '181'], /--angular must be at most 180 degrees/);
  await usage([cube, '-o', scratch, '--workers=-1'], /--workers must be a non-negative number/);
  await usage([cube, '-o', scratch, '-j', '1.5'], /--workers must be a whole number/);
  await usage([cube, '-o', scratch, '--timeout=-3'], /--timeout must be a non-negative number/);
  await usage([cube, '-o', scratch, '--cache-size', '5'], /--cache-size needs --cache/);
  await usage([cube, '-o', scratch, '--bogus'], /Unknown option '--bogus'/);
  const help = await run(['-h']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: stepconv/);
  assert.match(help.stdout, /threejs +\.json/);
  // Failures: an unreadable input; an output that can't be opened (nothing written).
  const missing = await run([path.join(tmp, 'missing.stp'), '-o', path.join(tmp, 'x.json')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /^stepconv: can't read .*missing\.stp/);
  if (fs.existsSync(cube)) {
    const bad = await run([cube, '-o', path.join(tmp, 'no/such/dir/x.json'), '-j', '0']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /^stepconv: can't write .*x\.json: ENOENT/);
  }
});

test('stepconv: the bin script', { skip }, () => {
  const out = path.join(tmp, 'bin.json');
  const stderr = execFileSync(process.execPath, [path.join(import.meta.dirname, '../bin/stepconv.ts'), cube, '-o', out, '-j', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(stderr, '');
  assert.equal(triangles(load(fs.readFileSync(out, 'utf8'))), 12);
});

// OCCT prints messages (`*** ERR ...`) for this file: warnings in the summary, never on standard output (which holds
// the JSON) or printed as they are.
const noisy = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/bug32314_corrupted.stp');

test("stepconv: the backend's messages are warnings, not printed", { skip: skip || (!fs.existsSync(noisy) && 'corpus not fetched') }, () => {
  for (const workers of ['0', '2']) {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '../bin/stepconv.ts'), noisy, '-o', '-', '-f', 'threejs', '-j', workers], { encoding: 'utf8', maxBuffer: 2 ** 28 });
    assert.equal(r.status, 0);
    assert.ok(JSON.parse(r.stdout).object, `workers ${workers}`);
    assert.doesNotMatch(r.stderr, /\*\*\*/);
    assert.match(r.stderr, /\n3 errors, 26 warnings, 0 notes\n/);
    assert.match(r.stderr, /\n  warning: #392938: 13 references to instances the file doesn't define: #11, #393036, .*, #393179, \.\.\.\n/);
    assert.match(r.stderr, /\n  warning: #392938: OCCT: ERR StepReaderData : Unresolved Reference : Fails Count : 13\n/);
  }
});
