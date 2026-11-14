// Needs the built backends (packages/tess-occt/build.sh, packages/tess-truck/build.sh) and the corpus
// (test_corpus/third_party/pull.sh); skipped without them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { exportView, meshDeflections, tessellateScene } from 'cad-scene';
import { threemf } from 'export-3mf';
import { StepTessellator } from 'step-export';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { OBJECT_TYPE, read3mf } from '../../export-3mf/test/read3mf.ts';
import { assembly, cube, hidden, root, run, skip, tmp } from './stepconv-helpers.ts';

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

// Open shells only.
const shells = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/trj7_k1-sd-214.stp');

test('stepconv: 3MF, the same as the library; --3mf-colorgroup, --3mf-assembly, --3mf-surfaces, --keep-hidden',
  { skip: skip || ((!fs.existsSync(hidden) || !fs.existsSync(shells)) && 'corpus not fetched') }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  await tessellateScene(scene, new StepTessellator(tess));
  tess.dispose();
  const out = path.join(tmp, 'as1.3mf');
  const r = await run([assembly, '-o', out, '-j', '2']);
  assert.equal(r.code, 0, r.stderr);
  const bytes = new Uint8Array(fs.readFileSync(out));
  assert.deepEqual(bytes, Uint8Array.from(
    Buffer.concat(threemf(scene, exportView(scene, meshDeflections({})), { name: 'as1-oc-214-mat' }).chunks)));
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
