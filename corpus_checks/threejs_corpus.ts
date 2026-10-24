// Phase 4 step 2: three.js JSON for every corpus file, loaded back with THREE.ObjectLoader and compared with the
// export view it was written from. Each file is imported, tessellated with our OCCT backend (a tess-workers pool,
// 0.1 mm, edges), and exported with edges, curves and extras (userData); then, in the loaded scene:
//   - one Mesh per placed part with triangles, and one Group per part without, in tree order;
//   - each Mesh's world matrix equals the view's (the root's, mm Z-up to m Y-up, then node transforms down the tree,
//     times the part's);
//   - its triangles (index count) and, per triangle, its material's colour and opacity equal the look's groups';
//   - one geometry per mesh unless instances group faces differently; edges, curves and points segment counts.
// Prints the JSON size and export time per format phase. Files whose JSON would exceed V8's string limit are
// exported (chunks counted) but not loaded.
// Usage: node corpus_checks/threejs_corpus.ts [file-list.txt] [max MB, default 2]  (progress on standard error)
import fs from 'node:fs';
import os from 'node:os';
import * as THREE from 'three';
import { exportView, multiply, tessellateScene, type ExportNode,
  type Mat4 } from '../packages/cad-scene/src/index.ts';
import { threejsChunks } from '../packages/export-threejs/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';

const workers = Math.max(1, os.availableParallelism() - 1);
const tess = new WorkerTessellator(
  { backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'),
  export: 'OcctTessellator' }, workers });
await tess.init();
const maxBytes = Number(process.argv[3] ?? 2) * 1e6;
const STRING_LIMIT = 2 ** 29 - 24; // V8's maximum string length (characters)

// Written out here rather than taken from the exporter: millimetres to metres and Z up to Y up ((x, y, z) ->
// (x, z, -y)).
const ROOT: Mat4 = Float64Array.of(0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1);
const hex = (c: readonly number[]) => c.reduce((h, v) => h * 256 + Math.round(Math.min(1, Math.max(0, v)) * 255), 0);
const totals = { files: 0, skipped: 0, notLoaded: 0, meshes: 0, groups: 0, triangles: 0, geometries: 0, segments: 0,
  points: 0, bytes: 0, exportMs: 0, loadMs: 0, problems: 0 };
const problems: string[] = [];
const biggest: [number, string, number][] = [];
const t0 = Date.now();
for (const f of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(f);
  if (bytes.length > maxBytes) { totals.skipped++; continue; }
  const name = shortName(f);
  process.stderr.write(`${name}\n`);
  totals.files++;
  const problem = (msg: string) => { totals.problems++; if (problems.length < 200) problems.push(`${name}: ${msg}`); };
  const { scene } = await importStep(bytes);
  const { meshes } = await tessellateScene(scene, tess,
    { linearDeflection: 0.1, angularDeflection: 0.5, edges: true, concurrency: workers });
  const view = exportView(scene, meshes, { edges: true, curves: true });

  const te = performance.now();
  const chunks: string[] = [];
  let length = 0;
  for (const c of threejsChunks(scene, view, { extras: true })) { chunks.push(c); length += c.length; }
  totals.exportMs += performance.now() - te;
  totals.bytes += length;
  biggest.push([length, name, performance.now() - te]);
  if (length > STRING_LIMIT) { totals.notLoaded++; continue; }

  const tl = performance.now();
  const root = new THREE.ObjectLoader().parse(JSON.parse(chunks.join('')));
  root.updateMatrixWorld(true);
  totals.loadMs += performance.now() - tl;

  // Expected, in tree order: each placed part's world matrix and look.
  const expected: { world: Mat4; look: number }[] = [];
  const walk = (n: ExportNode, parent: Mat4) => {
    const t = multiply(parent, n.transform);
    for (const p of n.parts) expected.push({ world: multiply(t, p.transform), look: p.look });
    for (const c of n.children) walk(c, t);
  };
  for (const r of view.roots) walk(r, ROOT);
  // The loaded part objects in the same order: objects with userData.part, depth first as written (parts before
  // children).
  const found: THREE.Object3D[] = [];
  const visit = (o: THREE.Object3D) => { if (o.userData.part !== undefined) found.push(o);
    for (const c of o.children) visit(c); };
  visit(root);
  if (found.length !== expected.length) {
    problem(`${found.length} part objects, expected ${expected.length}`); continue; }
  const geometries = new Set<THREE.BufferGeometry>();
  found.forEach((o, k) => {
    const e = expected[k]!;
    const look = view.looks[e.look]!;
    if (o.userData.part !== look.part) problem(`object ${k}: part ${o.userData.part}, expected ${look.part}`);
    const scale = Math.max(1, ...Array.from(e.world, Math.abs));
    if (!o.matrixWorld.elements.every((x, i) => Math.abs(x - e.world[i]!) <= 1e-6 * scale)) problem(
      `object ${k} (part ${look.part}): world matrix differs`);
    if (look.groups.length) {
      if (!(o instanceof THREE.Mesh)) { problem(`object ${k}: not a Mesh`); return; }
      totals.meshes++;
      geometries.add(o.geometry);
      const index = o.geometry.index!.array;
      if (index.length !== look.indices.length) problem(
        `object ${k}: ${index.length} indices, expected ${look.indices.length}`);
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const groups = o.geometry.groups.length ? o.geometry.groups : [
        { start: 0, count: index.length, materialIndex: 0 }];
      // Per triangle: the loaded material's colour and opacity against the look's group for the same triangle.
      const lookMat = new Array<string>(look.indices.length / 3);
      for (const g of look.groups) {
        const m = g.material === undefined ? undefined : scene.materials[g.material];
        const key = m ? `${hex(m.color)}/${m.opacity}` : 'default';
        for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) lookMat[t] = key;
        totals.groups++;
      }
      const loadedMat = new Array<string>(index.length / 3);
      for (const g of groups) {
        const m = mats[g.materialIndex ?? 0] as THREE.MeshStandardMaterial;
        const key = m.userData.material === undefined ? 'default' : `${m.color.getHex()}/${m.opacity}`;
        for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) loadedMat[t] = key;
      }
      // Triangles may come from another look's geometry (a one-material look reuses one), so compare as multisets.
      const tris = (ix: ArrayLike<number>, mats: string[]) => mats.map(
        (m, t) => `${ix[3 * t]},${ix[3 * t + 1]},${ix[3 * t + 2]}:${m}`).sort().join('|');
      if (tris(index, loadedMat) !== tris(look.indices, lookMat)) problem(
        `object ${k} (part ${look.part}): triangles or materials differ`);
      totals.triangles += index.length / 3;
    } else if (o.type !== 'Group') problem(`object ${k}: ${o.type}, expected a Group`);
    for (const c of o.children) {
      if (c instanceof THREE.LineSegments) totals.segments += c.geometry.index!.count / 2;
      if (c instanceof THREE.Points) totals.points += c.geometry.getAttribute('position').count;
    }
  });
  totals.geometries += geometries.size;
}
tess.dispose();

const mb = (n: number) => (n / 1e6).toFixed(1);
console.log(`files ${totals.files} (${totals.skipped} over ${maxBytes / 1e6} MB skipped; ${totals.notLoaded} too large `
  + `to load), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`meshes ${totals.meshes} (geometries ${totals.geometries}), groups ${totals.groups}, triangles `
  + `${totals.triangles}, segments ${totals.segments}, points ${totals.points}`);
console.log(`JSON ${mb(totals.bytes)} M characters; export ${(totals.exportMs / 1000).toFixed(2)} s; JSON.parse + `
  + `ObjectLoader ${(totals.loadMs / 1000).toFixed(2)} s`);
console.log('largest:');
for (const [n, f, ms] of biggest.sort((a, b) => b[0] - a[0]).slice(0, 5)) console.log(
  `  ${mb(n)} M characters, ${(ms / 1000).toFixed(1)} s  ${f}`);
console.log(`problems ${totals.problems}`);
for (const p of problems) console.log(`  ${p}`);
