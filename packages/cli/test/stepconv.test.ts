// Needs the built backends (packages/tess-occt/build.sh, packages/tess-truck/build.sh) and the corpus
// (test_corpus/third_party/pull.sh); skipped without them.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import diagnostics_channel from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { exportView, meshDeflections, tessellateScene } from 'cad-scene';
import { threejsJson } from 'export-threejs';
import { exportStep, StepTessellator } from 'step-export';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { assembly, cube, load, root, run, skip, tmp, triangles, truckBuilt, wireframe } from './stepconv-helpers.ts';

test('stepconv: the same file as the library pipeline, in a worker pool and on the main thread', { skip }, async () => {
  const out = path.join(tmp, 'as1.json');
  // The library's own pipeline, for comparison.
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(assembly));
  // stepconv's default meshing is the library's (medium).
  await tessellateScene(scene, new StepTessellator(tess), { edges: true });
  tess.dispose();
  const expected = threejsJson(scene, exportView(scene, { ...meshDeflections({}), edges: true, curves: true }),
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
    await tessellateScene(scene, new StepTessellator(tess), opts);
    // (The scene keeps every level made: the one at these settings.)
    const expected = threejsJson(scene, exportView(scene, meshDeflections(opts)), { name: 'as1-oc-214-mat' });
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
  const ten = { linearDeflection: 0.1, angularDeflection: (10 * Math.PI) / 180 };
  await tessellateScene(scene, new StepTessellator(tess), ten);
  tess.dispose();
  const expected = threejsJson(scene, exportView(scene, ten), { name: 'as1-oc-214-mat' });
  assert.equal((await run([assembly, '-o', out, '--angular-deflection', '10', '-j', '2'])).code, 0);
  const fine = fs.readFileSync(out, 'utf8');
  assert.equal(fine, expected);
  assert.equal((await run([assembly, '-o', out, '-j', '2'])).code, 0);
  assert.ok(triangles(load(fine)) > triangles(load(fs.readFileSync(out, 'utf8'))));
});

test('stepconv: AP242 tessellated geometry read as it is', { skip }, async () => {
    // A cube of complex triangulated faces (strips): read, nothing meshed.
    const cubeTess = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/bug33638.stp');
    const out = path.join(tmp, 'tess.json');
    const read = await run([cubeTess, '-o', out, '-j', '0']);
    assert.equal(read.code, 0);
    assert.match(read.stderr, /^1 parts \(0 of 0 brep parts tessellated\), 1 placed; 12 triangles/);
    assert.match(read.stderr, /0 errors, 0 warnings/);
    assert.equal(triangles(load(fs.readFileSync(out, 'utf8'))), 12);
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
  // (Without extras, a Scene of the tops.)
  assert.equal(load(fs.readFileSync(out, 'utf8')).type, 'Scene');
  const whole = await run([cube, '-o', out, '-j', '0', '--strict']);
  assert.equal(whole.code, 0);
  // (A file of one part: a root part, counted placed.)
  assert.match(whole.stderr, /^1 parts \(1 of 1 brep parts tessellated\), 1 placed; 12 triangles/);
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
  await usage([cube, '-o', scratch, '--unit', 'furlong'], /--unit must be one of mm, cm, m, in, ft, not 'furlong'/);
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
  const stp = path.join(tmp, 'usage.stp');
  await usage([cube, '-o', scratch, '--step-meshes'], /--step-meshes applies to step output/);
  await usage([cube, '-o', scratch, '--step-schema', 'ap214'], /--step-schema applies to step output/);
  await usage([cube, '-o', stp, '--step-schema', 'ap203'], /--step-schema must be ap242 or ap214, not 'ap203'/);
  await usage([cube, '-o', stp, '--step-schema', 'ap214', '--step-meshes'], /--step-meshes needs ap242/);
  for (const o of ['--with-edges', '--with-curves', '--unlit-lines', '--double-sided', '--keep-hidden',
    '--keep-empty', '--extras']) await usage([cube, '-o', stp, o], new RegExp(`${o} doesn't apply to step output`));
  const help = await run(['-h']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: stepconv/);
  assert.match(help.stdout, /--timeout <s> +per part, in a worker \(default 120\); 0: none/);
  assert.match(help.stdout, /threejs +\.json/);
  assert.match(help.stdout, /glb +\.glb/);
  assert.match(help.stdout, /gltf +\.gltf/);
  assert.match(help.stdout, /3mf +\.3mf/);
  assert.match(help.stdout, /step +\.stp, \.step/);
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

test('stepconv: STEP, the same as the library, nothing meshed; --step-meshes meshes; --step-schema ap214', { skip },
  async () => {
    const concat = (cs: Iterable<Uint8Array>) => Buffer.concat([...cs]);
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(assembly)));
    for (const [ext, schema] of [['.stp', 'ap242'], ['.step', 'ap214']] as const) {
      const out = path.join(tmp, `as1${ext}`);
      const r = await run([assembly, '-o', out, ...(schema === 'ap214' ? ['--step-schema', 'ap214'] : []), '-j', '0']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.match(r.stderr,
        /^5 parts \(5 brep parts, not tessellated\), 18 placed; [\d.]+ MB written\nimport [\d.]+ s, export /);
      assert.deepEqual(fs.readFileSync(out), concat(exportStep(scene, { name: 'as1-oc-214-mat', schema }).chunks));
    }
    // With meshes: tessellated (a worker pool), each B-rep part's mesh beside it, read back as a source level.
    const out = path.join(tmp, 'as1-meshes.stp');
    const r = await run([assembly, '-o', out, '--step-meshes', '--coarse']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^5 parts \(5 of 5 brep parts tessellated\), 18 placed;/);
    const back = (await importStep(new Uint8Array(fs.readFileSync(out)))).scene;
    assert.ok(back.parts.every((p) => p.brep && p.lods.length === 1 && p.lods[0]!.from === 'source'));
    assert.equal(back.parts[0]!.lods[0]!.linearDeflection, 0.2);
  });

test('stepconv: --unit, as the library writes it; the format\'s default without it', { skip }, async () => {
  const concat = (cs: Iterable<Uint8Array>) => Buffer.concat([...cs]);
  const { scene } = await importStep(new Uint8Array(fs.readFileSync(assembly)));
  const out = path.join(tmp, 'as1-in.stp');
  const r = await run([assembly, '-o', out, '--unit', 'in', '-j', '0']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(out), concat(exportStep(scene, { name: 'as1-oc-214-mat', unit: 25.4 }).chunks));
  assert.match(fs.readFileSync(out, 'latin1'), /CONVERSION_BASED_UNIT\('INCH'/);
  // glTF in millimetres: its top nodes scale by 1 / 1 instead of 1 / 1000.
  const glbOut = path.join(tmp, 'cube-mm.glb');
  assert.equal((await run([cube, '-o', glbOut, '--unit', 'mm', '-j', '0', '--gltf-compression', 'none'])).code, 0);
  const bytes = fs.readFileSync(glbOut);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as
    { nodes: { matrix?: number[]; scale?: number[] }[]; scenes: { nodes: number[] }[] };
  const top = json.nodes[json.scenes[0]!.nodes[0]!]!;
  const scale = top.matrix ? Math.hypot(top.matrix[0]!, top.matrix[1]!, top.matrix[2]!) : top.scale?.[0] ?? 1;
  assert.ok(Math.abs(scale - 1) < 1e-9, JSON.stringify(top));
});

test('stepconv: the bin script', { skip }, () => {
  const out = path.join(tmp, 'bin.json');
  const stderr = execFileSync(process.execPath,
    [path.join(import.meta.dirname, '../bin/stepconv.ts'), cube, '-o', out, '-j', '1'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(stderr, '');
  assert.equal(triangles(load(fs.readFileSync(out, 'utf8'))), 12);
});

// A broken file (references to instances it doesn't define): its problems warnings in the summary, never on standard
// output (which holds the JSON) or printed as OCCT prints them (`*** ERR ...`). (OCCT reads each part's model as
// written STEP, which has no dangling references, so it prints nothing for this file; tess-occt's tests check that
// what it prints comes back as warnings.)
const noisy = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/bug32314_corrupted.stp');

test("stepconv: a broken file's problems are warnings, nothing printed but the output",
  { skip: skip || (!fs.existsSync(noisy) && 'corpus not fetched') }, () => {
  for (const workers of ['0', '2']) {
    const r = spawnSync(process.execPath,
      [path.join(import.meta.dirname, '../bin/stepconv.ts'), noisy, '-o', '-', '-f', 'threejs', '-j', workers],
      { encoding: 'utf8', maxBuffer: 2 ** 28 });
    assert.equal(r.status, 0);
    assert.ok(JSON.parse(r.stdout).object, `workers ${workers}`);
    assert.doesNotMatch(r.stderr, /\*\*\*/);
    assert.match(r.stderr, /\n3 errors, 16 warnings, 0 notes\n/);
    assert.match(r.stderr,
      /\n  warning: #392938: 13 references to instances the file doesn't define: #11, #393036, .*, #393179, \.\.\.\n/);
  }
});
