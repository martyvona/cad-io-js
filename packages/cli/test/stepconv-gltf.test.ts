// Needs the built backends (packages/tess-occt/build.sh, packages/tess-truck/build.sh) and the corpus
// (test_corpus/third_party/pull.sh); skipped without them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { exportView, meshDeflections, tessellateScene } from 'cad-scene';
import { glb, gltfJson } from 'export-gltf';
import { StepTessellator } from 'step-export';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { assembly, cube, hidden, root, run, skip, tmp } from './stepconv-helpers.ts';

test('stepconv: GLB and .gltf with its .bin, the same as the library; hidden instances; standard output', { skip },
  async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  await tessellateScene(scene, new StepTessellator(tess), { edges: true });
  tess.dispose();
  const view = exportView(scene, { ...meshDeflections({}), edges: true });
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
