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
import { strFromU8, unzipSync } from 'fflate';
import * as THREE from 'three';
import { exportView, tessellateScene } from 'cad-scene';
import { threemf } from 'export-3mf';
import { glb, gltfJson } from 'export-gltf';
import { threejsJson } from 'export-threejs';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { stepconv } from '../src/index.ts';
import { OBJECT_TYPE, read3mf } from '../../export-3mf/test/read3mf.ts';

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
  // stepconv's default meshing is the library's (medium).
  const { meshes } = await tessellateScene(scene, tess, { edges: true });
  tess.dispose();
  const expected = threejsJson(scene, exportView(scene, meshes, { edges: true, curves: true }),
    { name: 'as1-oc-214-mat' });
  for (const workers of ['2', '0']) {
    const r = await run([assembly, '-o', out, '--with-edges', '--with-curves', '-j', workers]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), expected, `workers ${workers}`);
    assert.match(r.stderr, new RegExp(String.raw`^5 parts \(5 of 5 brep parts tessellated\), 18 placed; `
      + String.raw`8048 triangles; 0\.2 MB written\nimport [\d.]+ s, tessellation [\d.]+ s \(medium: 0\.1 mm, `
      + String.raw`15 deg\), export [\d.]+ s\n`
      + String.raw`0 errors, 0 warnings, 0 notes\n$`));
  }
  const loaded = load(expected);
  assert.equal(loaded.name, 'as1-oc-214-mat');
  assert.equal(triangles(loaded), 8048);
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
  load(fs.readFileSync(out, 'utf8')).traverse(
    (x) => { if (x instanceof THREE.Mesh) for (const m of [x.material].flat()) sides.add(
    (m as THREE.Material).side); });
  assert.deepEqual([...sides], [THREE.DoubleSide]);
});

test('stepconv: GLB and .gltf with its .bin, the same as the library; hidden instances; standard output', { skip },
  async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  const { meshes } = await tessellateScene(scene, tess, { edges: true });
  tess.dispose();
  const view = exportView(scene, meshes, { edges: true });
  const out = path.join(tmp, 'as1.glb');
  const r = await run([assembly, '-o', out, '--with-edges', '-j', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(new Uint8Array(fs.readFileSync(out)), (await glb(scene, view, { name: 'as1-oc-214-mat' })).bytes);
  // .gltf: the JSON names a .bin beside it, named after the output.
  const json = path.join(tmp, 'model.gltf');
  assert.equal((await run([assembly, '-o', json, '--with-edges', '-j', '2'])).code, 0);
  const expected = await gltfJson(scene, view, 'model.bin', { name: 'as1-oc-214-mat' });
  assert.equal(fs.readFileSync(json, 'utf8'), expected.json);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(tmp, 'model.bin'))), expected.bin);
  assert.match(expected.json, /"uri":"model.bin"/);
  // GLB to standard output; .gltf can't go there.
  const stdout = spawnSync(process.execPath,
    [path.join(import.meta.dirname, '../bin/stepconv.ts'), cube, '-o', '-', '-f', 'glb', '-j', '0', '-q']);
  assert.equal(stdout.status, 0);
  assert.equal(stdout.stdout.subarray(0, 4).toString('latin1'), 'glTF');
  // (In the temporary directory, so that a broken check writes its '-.bin' there.)
  const usage = spawnSync(process.execPath,
    [path.join(import.meta.dirname, '../bin/stepconv.ts'), cube, '-o', '-', '-f', 'gltf'],
    { cwd: tmp, encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /gltf writes a \.bin file beside the output, so not to standard output/);
  // If the .bin can't be written, neither file is left.
  const blocked = path.join(tmp, 'blocked.gltf');
  fs.mkdirSync(path.join(tmp, 'blocked.bin'));
  const failed = await run([cube, '-o', blocked, '-j', '0']);
  assert.equal(failed.code, 2);
  assert.match(failed.stderr, /can't write .*blocked\.gltf: EISDIR/);
  assert.ok(!fs.existsSync(blocked) && fs.statSync(path.join(tmp, 'blocked.bin')).isDirectory());
});

// A solid with a curve set and points beside it: edges, curves and points.
const mixed = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/trj6_as1-td-214.stp');

test('stepconv: glTF with --with-edges, --with-curves, --unlit-lines, --gltf-embed',
  { skip: skip || (!fs.existsSync(mixed) && 'corpus not fetched') }, async () => {
  const out = path.join(tmp, 'flags.gltf');
  // Each run embedded, so the .gltf alone has everything.
  const kinds = async (file: string, args: string[]) => {
    const r = await run([file, '-o', out, '--gltf-embed', '-j', '2', ...args]);
    assert.equal(r.code, 0, r.stderr);
    const json = JSON.parse(fs.readFileSync(out, 'utf8'));
    return { names: [...new Set<string>(
      json.nodes.map((n: { name?: string }) => n.name).filter(
      (n: string) => ['edges', 'curves', 'points'].includes(n)))].sort(), json };
  };
  const all = ['--with-edges', '--with-curves'];
  assert.deepEqual((await kinds(mixed, all)).names, ['curves', 'edges', 'points']);
  assert.deepEqual((await kinds(mixed, ['--with-edges'])).names, ['edges']);
  assert.deepEqual((await kinds(mixed, ['--with-curves'])).names, ['curves', 'points']);
  assert.deepEqual((await kinds(mixed, [])).names, []);
  // Embedded: no .bin beside it, the buffer a data URI.
  const { json } = await kinds(assembly, all);
  assert.ok(!fs.existsSync(path.join(tmp, 'flags.bin')));
  assert.match(json.buffers[0].uri, /^data:application\/octet-stream;base64,/);
  assert.deepEqual(json.extensionsUsed, ['KHR_draco_mesh_compression']);
  // Unlit lines: the extension on the edges' material only.
  const unlit = (await kinds(assembly, [...all, '--unlit-lines'])).json;
  assert.deepEqual(unlit.extensionsUsed, ['KHR_draco_mesh_compression', 'KHR_materials_unlit']);
  const edgeMesh = unlit.nodes.find((n: { name?: string }) => n.name === 'edges').mesh;
  const unlitMaterials = unlit.materials.map((m: { extensions?: object }, i: number) => (m.extensions ? i : -1)).filter(
    (i: number) => i >= 0);
  assert.deepEqual(unlitMaterials, [unlit.meshes[edgeMesh].primitives[0].material]);
  // Embedded .gltf to standard output.
  const stdout = spawnSync(process.execPath,
    [path.join(import.meta.dirname, '../bin/stepconv.ts'), cube, '-o', '-', '-f', 'gltf', '--gltf-embed', '-j', '0',
    '-q'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(stdout.status, 0);
  assert.equal(JSON.parse(stdout.stdout).asset.version, '2.0');
  // --gltf-embed with other formats; --unlit-lines is accepted for three.js, whose lines are always unlit.
  const scratch = path.join(tmp, 'usage.json');
  const r = await run([cube, '-o', scratch, '--gltf-embed']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--gltf-embed applies to glb and gltf output/);
  assert.equal((await run([cube, '-o', scratch, '--with-edges', '--unlit-lines', '-j', '0'])).code, 0);
  const g = await run([cube, '-o', path.join(tmp, 'usage.glb'), '--gltf-embed']);
  assert.equal(g.code, 1);
  assert.match(g.stderr, /--gltf-embed applies to gltf output \(GLB holds its buffer\)/);
});

const hidden = path.join(root,
  'test_corpus/third_party/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files/nist_ctc_02_asme1_ap242-e2.stp');

test('stepconv: glTF leaves hidden instances out, with a warning, unless --keep-hidden',
  { skip: skip || (!fs.existsSync(hidden) && 'corpus not fetched') }, async () => {
  const out = path.join(tmp, 'hidden.gltf');
  const used = () => JSON.parse(fs.readFileSync(out, 'utf8')).extensionsUsed.filter(
    (e: string) => e !== 'KHR_draco_mesh_compression');
  const lax = await run([hidden, '-o', out, '-j', '2']);
  assert.equal(lax.code, 0);
  assert.match(lax.stderr,
    /\n  warning: 1 hidden part instance left out \(glTF has no visibility without KHR_node_visibility\)\n/);
  assert.deepEqual(used(), []);
  const kept = await run([hidden, '-o', out, '-j', '2', '--keep-hidden']);
  assert.doesNotMatch(kept.stderr, /hidden/);
  assert.deepEqual(used(), ['KHR_node_visibility']);
});

test('stepconv: --extras in every format; --gltf-compression, --gltf-draco-bits', { skip }, async () => {
  const out = (ext: string) => path.join(tmp, `extras${ext}`);
  const ok = async (args: string[]) => { const r = await run([assembly, '-j', '2', '-q', ...args]);
    assert.equal(r.code, 0, r.stderr); };
  // three.js: userData only with --extras.
  await ok(['-o', out('.json')]);
  assert.doesNotMatch(fs.readFileSync(out('.json'), 'utf8'), /"userData"/);
  await ok(['-o', out('.json'), '--extras']);
  assert.match(fs.readFileSync(out('.json'), 'utf8'), /"userData":\{"part":0/);
  // 3MF: our metadata only with --extras.
  const model = () => strFromU8(unzipSync(new Uint8Array(fs.readFileSync(out('.3mf'))))['3D/3dmodel.model']!);
  await ok(['-o', out('.3mf')]);
  assert.doesNotMatch(model(), /cadio/);
  await ok(['-o', out('.3mf'), '--extras']);
  assert.match(model(), /<metadata name="cadio:path">/);
  // glTF: Draco by default, no extras; with --extras, faces by _FACE.
  const gltf = async (args: string[]) => {
    await ok(['-o', out('.gltf'), '--gltf-embed', ...args]);
    return JSON.parse(fs.readFileSync(out('.gltf'), 'utf8'));
  };
  const d = await gltf([]);
  assert.deepEqual(d.extensionsRequired, ['KHR_draco_mesh_compression']);
  assert.doesNotMatch(JSON.stringify(d), /"extras"/);
  const de = await gltf(['--extras']);
  const prim = de.meshes[0].primitives[0];
  assert.ok('_FACE' in prim.extensions.KHR_draco_mesh_compression.attributes);
  assert.ok(prim.extras.faces.every((f: object) => Object.keys(f).join() === 'source'));
  // meshopt: face ranges; none: neither extension.
  const m = await gltf(['--gltf-compression', 'meshopt', '--extras']);
  assert.deepEqual(m.extensionsRequired.sort(), ['EXT_meshopt_compression', 'KHR_mesh_quantization']);
  assert.deepEqual(Object.keys(m.meshes[0].primitives[0].extras.faces[0]), ['source', 'start', 'count']);
  assert.equal((await gltf(['--gltf-compression', 'none'])).extensionsUsed, undefined);
  // Fewer Draco bits, a smaller file.
  const size = async (args: string[]) => {
    await ok(['-o', out('.glb'), ...args]);
    return fs.statSync(out('.glb')).size;
  };
  assert.ok(await size(['--gltf-draco-bits', '8']) < await size([]));
  // Usage errors.
  const bad = async (args: string[], message: RegExp) => {
    const r = await run([cube, '-j', '0', ...args]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, message);
  };
  await bad(['-o', out('.glb'), '--gltf-compression', 'zip'], /--gltf-compression must be draco, meshopt or none/);
  await bad(['-o', out('.json'), '--gltf-compression', 'none'], /--gltf-compression applies to glb and gltf output/);
  await bad(['-o', out('.3mf'), '--gltf-draco-bits', '12'], /--gltf-draco-bits applies to glb and gltf output/);
  await bad(['-o', out('.glb'), '--gltf-compression', 'meshopt', '--gltf-draco-bits', '12'],
    /--gltf-draco-bits applies to Draco compression/);
  for (const bits of ['0', '31', '1.5', 'x']) await bad(['-o', out('.glb'), '--gltf-draco-bits', bits],
    /--gltf-draco-bits must be a whole number from 1 to 30/);
});

test('stepconv: --gltf-instancing; --keep-empty', { skip }, async () => {
  const out = path.join(tmp, 'instancing.gltf');
  const gltf = async (args: string[]) => {
    const r = await run([assembly, '-o', out, '--gltf-embed', '-j', '2', '-q', ...args]);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  type N = { mesh?: number; children?: number[]; extensions?: { EXT_mesh_gpu_instancing?: { attributes:
    { TRANSLATION: number } } } };
  const plain = await gltf([]);
  const placed = plain.nodes.filter((n: N) => n.mesh !== undefined).length;
  const j = await gltf(['--gltf-instancing']);
  assert.deepEqual(j.extensionsRequired.sort(), ['EXT_mesh_gpu_instancing', 'KHR_draco_mesh_compression']);
  // 18 placed parts: three looks instanced (16 placements), two left as they were.
  const inst = j.nodes.filter((n: N) => n.extensions?.EXT_mesh_gpu_instancing);
  const count = inst.map((n: N) => j.accessors[n.extensions!.EXT_mesh_gpu_instancing!.attributes.TRANSLATION].count);
  assert.deepEqual([placed, inst.length, count.reduce((a: number, b: number) => a + b, 0)], [18, 3, 16]);
  assert.equal(j.nodes.filter((n: N) => n.mesh !== undefined && !n.extensions?.EXT_mesh_gpu_instancing).length, 2);
  // Every node but the root has something to draw beneath it, unless --keep-empty.
  const drawn = (doc: { nodes: N[] }, i: number): boolean => doc.nodes[i]!.mesh !== undefined
    || (doc.nodes[i]!.children ?? []).some((c) => drawn(doc, c));
  assert.ok(j.nodes.every((_: N, i: number) => i === j.scenes[0].nodes[0] || drawn(j, i)));
  const kept = await gltf(['--gltf-instancing', '--keep-empty']);
  assert.ok(kept.nodes.length > j.nodes.length);
  assert.ok(kept.nodes.some((_: N, i: number) => !drawn(kept, i)));
  // Usage errors: instancing is glTF's; 3MF never writes empty nodes.
  for (const [args, message] of [[['-o', path.join(tmp, 'i.json'), '--gltf-instancing'],
    /--gltf-instancing applies to glb and gltf output/], [['-o', path.join(tmp, 'i.3mf'), '--keep-empty'],
    /--keep-empty doesn't apply to 3mf output/]] as const) {
    const r = await run([cube, '-j', '0', ...args]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, message);
  }
  // three.js: empty nodes left out, or kept (dm1's tree has 3 nodes with nothing to draw beneath them).
  const dm1 = path.join(root, 'test_corpus/third_party/occt-import-js/test/testfiles/cax-if/dm1-pe-214.stp');
  const three = async (args: string[]) => {
    const r = await run([dm1, '-o', path.join(tmp, 'i.json'), '-j', '2', '-q', ...args]);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(tmp, 'i.json'), 'utf8'));
  };
  const objects = (o: { children?: object[] }): number => 1 + (o.children ?? []).reduce(
    (a: number, c) => a + objects(c), 0);
  assert.ok(objects((await three(['--keep-empty'])).object) > objects((await three([])).object));
});

// Open shells only.
const shells = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/trj7_k1-sd-214.stp');

test('stepconv: 3MF, the same as the library; --3mf-colorgroup, --3mf-assembly, --3mf-surfaces, --keep-hidden',
  { skip: skip || ((!fs.existsSync(hidden) || !fs.existsSync(shells)) && 'corpus not fetched') }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  const { meshes } = await tessellateScene(scene, tess);
  tess.dispose();
  const out = path.join(tmp, 'as1.3mf');
  const r = await run([assembly, '-o', out, '-j', '2']);
  assert.equal(r.code, 0, r.stderr);
  const bytes = new Uint8Array(fs.readFileSync(out));
  assert.deepEqual(bytes, Uint8Array.from(
    Buffer.concat(threemf(scene, exportView(scene, meshes), { name: 'as1-oc-214-mat' }).chunks)));
  const parts = await read3mf(bytes, { full: false });
  assert.deepEqual(parts.warnings, []);
  assert.ok(parts.items.length > 1 && parts.components.size === 0 && parts.colors.size === 1);
  const flags = async (file: string, args: string[]) => {
    const f = await run([file, '-o', out, '-j', '2', ...args]);
    assert.equal(f.code, 0, f.stderr);
    return { stderr: f.stderr, model: await read3mf(new Uint8Array(fs.readFileSync(out)), { full: false }) };
  };
  const assembled = (await flags(assembly, ['--3mf-assembly'])).model;
  assert.equal(assembled.items.length, 1);
  assert.ok(assembled.components.size > 1);
  const coloured = (await flags(assembly, ['--3mf-colorgroup'])).model;
  assert.deepEqual([...coloured.colors.keys()], [1]);
  assert.match(strFromU8(unzipSync(new Uint8Array(fs.readFileSync(out)))['3D/3dmodel.model']!),
    /<m:colorgroup id="1">/);
  // Open shells: left out with a warning each, or written as surfaces.
  const left = await flags(shells, []);
  // (Open shells in the file: said so too.)
  assert.match(left.stderr, new RegExp(/\n  warning: #\d+: part 'small_shell' is not a closed, oriented manifold /
    .source + /\(an open shell in the source, \d+ boundary edges\); left out\n/.source));
  assert.equal(left.model.items.length, 0);
  const surfaces = await flags(shells, ['--3mf-surfaces']);
  assert.match(surfaces.stderr, /written as a surface object/);
  assert.deepEqual([...surfaces.model.meshes.values()].map((m) => m.type), [OBJECT_TYPE.surface, OBJECT_TYPE.surface]);
  // Hidden instances (here an open shell, so written as surfaces to count).
  const lax = await flags(hidden, ['--3mf-surfaces']);
  assert.match(lax.stderr, /\n  warning: 1 hidden part instance left out \(3MF has no visibility\)\n/);
  const kept = await flags(hidden, ['--3mf-surfaces', '--keep-hidden']);
  assert.doesNotMatch(kept.stderr, /hidden/);
  assert.equal(kept.model.items.length, lax.model.items.length + 1);
  // To standard output.
  const stdout = spawnSync(process.execPath,
    [path.join(import.meta.dirname, '../bin/stepconv.ts'), cube, '-o', '-', '-f', '3mf', '-j', '0', '-q']);
  assert.equal(stdout.status, 0);
  assert.equal((await read3mf(new Uint8Array(stdout.stdout), { full: false })).items.length, 1);
  // 3MF flags with other formats; lines and double-sided faces with 3MF.
  for (const flag of ['--3mf-colorgroup', '--3mf-assembly', '--3mf-surfaces']) {
    const u = await run([cube, '-o', path.join(tmp, 'usage.glb'), flag]);
    assert.equal(u.code, 1, flag);
    assert.match(u.stderr, new RegExp(`${flag} applies to 3mf output`));
  }
  for (const flag of ['--with-edges', '--with-curves', '--unlit-lines', '--double-sided']) {
    const u = await run([cube, '-o', path.join(tmp, 'usage.3mf'), flag]);
    assert.equal(u.code, 1, flag);
    assert.match(u.stderr, new RegExp(`${flag} doesn't apply to 3mf output`));
  }
});

test('stepconv: --coarse, --medium, --fine, each value replaced by -d or --angular-deflection', { skip }, async () => {
  const out = path.join(tmp, 'profile.json');
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  const cases: [string[], Parameters<typeof tessellateScene>[2], string][] = [
    [['--coarse'], { profile: 'coarse' }, 'coarse: 0.2 mm, 30 deg'],
    [['--medium'], { profile: 'medium' }, 'medium: 0.1 mm, 15 deg'],
    [['--fine'], { profile: 'fine' }, 'fine: 0.05 mm, 7.5 deg'],
    [['--fine', '-d', '0.03'], { profile: 'fine', linearDeflection: 0.03 }, 'custom: 0.03 mm, 7.5 deg'],
    [['--coarse', '--angular-deflection', '15', '-d', '0.1'], { profile: 'medium' }, 'medium: 0.1 mm, 15 deg'],
  ];
  const counts: number[] = [];
  for (const [flags, opts, label] of cases) {
    const { meshes } = await tessellateScene(scene, tess, opts);
    const expected = threejsJson(scene, exportView(scene, meshes, {}), { name: 'as1-oc-214-mat' });
    const r = await run([assembly, '-o', out, ...flags, '-j', '2']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), expected, flags.join(' '));
    assert.ok(r.stderr.includes(`(${label})`), `${flags.join(' ')}: ${r.stderr}`);
    counts.push(triangles(load(expected)));
  }
  tess.dispose();
  assert.ok(counts[0]! < counts[1]! && counts[1]! < counts[2]!, `coarse < medium < fine: ${counts}`);
});

test('stepconv: --angular-deflection in degrees', { skip }, async () => {
  const out = path.join(tmp, 'angular.json');
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  const { meshes } = await tessellateScene(scene, tess,
    { linearDeflection: 0.1, angularDeflection: (10 * Math.PI) / 180 });
  tess.dispose();
  const expected = threejsJson(scene, exportView(scene, meshes, {}), { name: 'as1-oc-214-mat' });
  assert.equal((await run([assembly, '-o', out, '--angular-deflection', '10', '-j', '2'])).code, 0);
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
  // Nothing to draw: a .gltf without a buffer, so no .bin.
  assert.equal((await run([broken, '-o', path.join(tmp, 'empty.gltf'), '-j', '0'])).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'empty.gltf'), 'utf8')).buffers, undefined);
  assert.ok(!fs.existsSync(path.join(tmp, 'empty.bin')));
  assert.equal(load(fs.readFileSync(out, 'utf8')).type, 'Group');
  assert.equal((await run([cube, '-o', out, '-j', '0', '--strict'])).code, 0);
});

test('stepconv: wireframe curves on request; --workers 0 starts no worker',
  { skip: skip || (!fs.existsSync(wireframe) && 'corpus not fetched') }, async () => {
  const out = path.join(tmp, 'wire.json');
  const names = () => { const n: string[] = [];
    load(fs.readFileSync(out, 'utf8')).traverse((x) => { if (x instanceof THREE.LineSegments) n.push(x.name); });
    return n; };
  let started = 0;
  const count = () => started++;
  diagnostics_channel.subscribe('worker_threads', count);
  try {
    assert.equal((await run([wireframe, '-o', out, '-j', '0'])).code, 0);
    assert.deepEqual(names(), []);
    assert.equal(started, 0);
    assert.equal((await run([wireframe, '-o', out, '--with-curves', '-j', '1'])).code, 0);
    assert.ok(names().length > 0 && names().every((n) => n === 'curves'));
    assert.equal(started, 1);
  } finally {
    diagnostics_channel.unsubscribe('worker_threads', count);
  }
});

test('stepconv: --timeout reaches the pool: at 1 ms every part times out, and the run still writes its output',
  { skip }, async () => {
  const out = path.join(tmp, 'timeout.json');
  const r = await run([assembly, '-o', out, '--timeout', '0.001', '-j', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^5 parts \(0 of 5 brep parts tessellated\)/);
  assert.match(r.stderr, /timed out after 1 ms/);
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
  assert.match((await run([assembly, '-o', out, '--cache', cache, '-d', '0.05', '-j', '1'])).stderr,
    /\ncache: 0 hits \(0 failures\), 5 misses\n/);
  assert.match((await run([assembly, '-o', out, '--cache', cache, '--angular-deflection', '20', '-j', '1'])).stderr,
    /\ncache: 0 hits \(0 failures\), 5 misses\n/);
  // Size 0 disables the cache.
  assert.match((await run([assembly, '-o', out, '--cache', cache, '--cache-size', '0', '-j', '1'])).stderr,
    /\ncache: 0 hits \(0 failures\), 0 misses\n/);
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
  await usage([cube, '-o', scratch, '--angular-deflection', 'x'], /--angular-deflection must be a positive number/);
  await usage([cube, '-o', scratch, '--angular-deflection', '181'], /--angular-deflection must be at most 180 degrees/);
  await usage([cube, '-o', scratch, '--fine', '--coarse'], /--coarse, --fine: one meshing profile at most/);
  // Options renamed or removed since 0.1.0 are unknown.
  for (const old of ['--edges', '--curves', '--gltf-no-edges', '--gltf-faces-only', '--gltf-unlit-lines']) {
    await usage([cube, '-o', scratch, old], new RegExp(`Unknown option '${old}'`));
  }
  await usage([cube, '-o', scratch, '--angular', '10'], /Unknown option '--angular'/);
  await usage([cube, '-o', scratch, '--workers=-1'], /--workers must be a non-negative number/);
  await usage([cube, '-o', scratch, '-j', '1.5'], /--workers must be a whole number/);
  await usage([cube, '-o', scratch, '--timeout=-3'], /--timeout must be a non-negative number/);
  await usage([cube, '-o', scratch, '--cache-size', '5'], /--cache-size needs --cache/);
  await usage([cube, '-o', scratch, '--bogus'], /Unknown option '--bogus'/);
  const help = await run(['-h']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: stepconv/);
  assert.match(help.stdout, /--timeout <s> +per part, in a worker \(default 60\); 0: none/);
  assert.match(help.stdout, /threejs +\.json/);
  assert.match(help.stdout, /glb +\.glb/);
  assert.match(help.stdout, /gltf +\.gltf/);
  assert.match(help.stdout, /3mf +\.3mf/);
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
  const stderr = execFileSync(process.execPath,
    [path.join(import.meta.dirname, '../bin/stepconv.ts'), cube, '-o', out, '-j', '1'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(stderr, '');
  assert.equal(triangles(load(fs.readFileSync(out, 'utf8'))), 12);
});

// OCCT prints messages (`*** ERR ...`) for this file: warnings in the summary, never on standard output (which holds
// the JSON) or printed as they are.
const noisy = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/bug32314_corrupted.stp');

test("stepconv: the backend's messages are warnings, not printed",
  { skip: skip || (!fs.existsSync(noisy) && 'corpus not fetched') }, () => {
  for (const workers of ['0', '2']) {
    const r = spawnSync(process.execPath,
      [path.join(import.meta.dirname, '../bin/stepconv.ts'), noisy, '-o', '-', '-f', 'threejs', '-j', workers],
      { encoding: 'utf8', maxBuffer: 2 ** 28 });
    assert.equal(r.status, 0);
    assert.ok(JSON.parse(r.stdout).object, `workers ${workers}`);
    assert.doesNotMatch(r.stderr, /\*\*\*/);
    assert.match(r.stderr, /\n3 errors, 26 warnings, 0 notes\n/);
    assert.match(r.stderr,
      /\n  warning: #392938: 13 references to instances the file doesn't define: #11, #393036, .*, #393179, \.\.\.\n/);
    assert.match(r.stderr,
      /\n  warning: #392938: OCCT: ERR StepReaderData : Unresolved Reference : Fails Count : 13\n/);
  }
});
