// Phase 4 step 4: GLB for every corpus file, checked with the Khronos glTF-Validator, read back with glTF-Transform
// and compared with the export view it was written from. Each file is imported, tessellated with our OCCT backend
// (a tess-workers pool, 0.1 mm, edges), and exported with edges, curves and hidden instances (KHR_node_visibility);
// then:
//   - the validator's errors are problems; its warnings, infos and hints are tallied by code;
//   - one node per placed part (extras.part), in tree order, hidden ones with KHR_node_visibility;
//   - each one's world matrix (composed from the nodes' local matrices) equals the root transform times the view's
//     (glTF-Transform keeps TRS, so this checks the decomposition too);
//   - its triangles and, per triangle, its material's base colour (linear) and alpha equal the look's groups';
//   - one faces' mesh per look; edges, curves and points in child nodes (identity transforms) with meshes of their
//     own, segment and point counts.
// Prints the GLB size and export and validation times. Usage:
//   node corpus_checks/gltf_corpus.ts [file-list.txt] [max MB, default 2]  (progress on standard error)
import fs from 'node:fs';
import os from 'node:os';
import { WebIO, type Node } from '@gltf-transform/core';
import { KHRMaterialsUnlit, KHRNodeVisibility } from '@gltf-transform/extensions';
import validator from 'gltf-validator';
import { exportView, identity, multiply, tessellateScene, type ExportNode, type Mat4 } from '../packages/cad-scene/src/index.ts';
import { glb } from '../packages/export-gltf/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';

const workers = Math.max(1, os.availableParallelism() - 1);
const tess = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'), export: 'OcctTessellator' }, workers });
await tess.init();
const maxBytes = Number(process.argv[3] ?? 2) * 1e6;
const io = new WebIO().registerExtensions([KHRMaterialsUnlit, KHRNodeVisibility]);

// The expectations, written out here rather than taken from the exporter: millimetres to metres and Z up to Y up
// ((x, y, z) → (x, z, −y)), and the sRGB transfer function.
const ROOT: Mat4 = Float64Array.of(0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1);
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const totals = { files: 0, skipped: 0, nodes: 0, hidden: 0, meshes: 0, primitives: 0, triangles: 0, segments: 0, points: 0, bytes: 0, exportMs: 0, validateMs: 0, problems: 0 };
const issues = new Map<string, { n: number; files: Set<string>; example: string }>();
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
  const { meshes } = await tessellateScene(scene, tess, { linearDeflection: 0.1, angularDeflection: 0.5, edges: true, concurrency: workers });
  const view = exportView(scene, meshes, { edges: true, curves: true });

  const te = performance.now();
  const out = await glb(scene, view, { hidden: 'extension' });
  const ms = performance.now() - te;
  totals.exportMs += ms;
  totals.bytes += out.bytes.length;
  biggest.push([out.bytes.length, name, ms]);
  if (out.diagnostics.length) problem(`diagnostics: ${out.diagnostics.map((d) => d.message).join('; ')}`);

  const tv = performance.now();
  const report = await validator.validateBytes(out.bytes, { maxIssues: 0, ignoredIssues: [] });
  totals.validateMs += performance.now() - tv;
  for (const m of report.issues.messages) {
    const sev = ['error', 'warning', 'info', 'hint'][m.severity]!;
    if (m.severity === 0) problem(`validator: ${m.code} ${m.message} at ${m.pointer}`);
    const key = `${sev} ${m.code}`;
    const e = issues.get(key) ?? { n: 0, files: new Set(), example: `${name} ${m.pointer ?? ''}: ${m.message}` };
    e.n++;
    e.files.add(name);
    issues.set(key, e);
  }

  const doc = await io.readBinary(out.bytes);
  // Expected, in tree order: each placed part's world matrix and look.
  const expected: { world: Mat4; look: number; visible: boolean }[] = [];
  const walk = (n: ExportNode, parent: Mat4) => {
    const t = multiply(parent, n.transform);
    for (const p of n.parts) expected.push({ world: multiply(t, p.transform), look: p.look, visible: p.visible });
    for (const c of n.children) walk(c, t);
  };
  for (const r of view.roots) walk(r, ROOT);
  // World matrices: each node's local matrix (from the TRS written) down the tree.
  const found: { node: Node; world: Mat4 }[] = [];
  const visit = (n: Node, parent: Mat4) => {
    const world = multiply(parent, Float64Array.from(n.getMatrix()));
    if ((n.getExtras() as { part?: number }).part !== undefined) found.push({ node: n, world });
    for (const c of n.listChildren()) visit(c, world);
  };
  for (const s of doc.getRoot().listScenes()) for (const n of s.listChildren()) visit(n, identity());
  if (found.length !== expected.length) { problem(`${found.length} part nodes, expected ${expected.length}`); continue; }
  const meshesSeen = new Set<unknown>();
  found.forEach(({ node, world }, k) => {
    const e = expected[k]!;
    const look = view.looks[e.look]!;
    totals.nodes++;
    const part = (node.getExtras() as { part: number }).part;
    if (part !== look.part) problem(`node ${k}: part ${part}, expected ${look.part}`);
    const hidden = node.getExtension<{ getVisible(): boolean }>('KHR_node_visibility')?.getVisible() === false;
    if (hidden) totals.hidden++;
    if (hidden === e.visible) problem(`node ${k} (part ${look.part}): visibility differs`);
    const scale = Math.max(1, ...Array.from(e.world, Math.abs));
    const err = Math.max(...Array.from(world, (x, i) => Math.abs(x - e.world[i]!)));
    if (err > 1e-9 * scale) problem(`node ${k} (part ${look.part}): world matrix differs by ${err.toPrecision(3)} (largest entry ${scale.toPrecision(3)})`);
    const mesh = node.getMesh();
    const prims = mesh?.listPrimitives() ?? [];
    if (mesh) meshesSeen.add(mesh);
    const tris = prims.filter((p) => p.getMode() === 4);
    if (tris.length !== look.groups.length) { problem(`node ${k} (part ${look.part}): ${tris.length} triangle primitives, expected ${look.groups.length}`); return; }
    tris.forEach((p, g) => {
      const group = look.groups[g]!;
      const ix = p.getIndices()!.getArray()!;
      if (ix.length !== group.count || !ix.every((v, i) => v === look.indices[group.start + i])) problem(`node ${k} (part ${look.part}) group ${g}: indices differ`);
      if (p.getAttribute('POSITION')!.getArray() !== null && p.getAttribute('POSITION')!.getCount() !== look.mesh.positions.length / 3) problem(`node ${k} group ${g}: vertex count differs`);
      const m = group.material === undefined ? undefined : scene.materials[group.material];
      const want = m ? [...m.color.map(linear), m.opacity] : [linear(0.8), linear(0.8), linear(0.8), 1];
      const got = p.getMaterial()!.getBaseColorFactor();
      if (!got.every((x, i) => Math.abs(x - want[i]!) < 1e-6)) problem(`node ${k} (part ${look.part}) group ${g}: colour ${got}, expected ${want}`);
      if ((m !== undefined && m.opacity < 1) !== (p.getMaterial()!.getAlphaMode() === 'BLEND')) problem(`node ${k} group ${g}: alpha mode`);
      totals.triangles += ix.length / 3;
      totals.primitives++;
    });
    if (prims.some((p) => p.getMode() !== 4)) problem(`node ${k} (part ${look.part}): lines or points in the faces' mesh`);
    for (const c of node.listChildren()) {
      const what = c.getName();
      if (!['edges', 'curves', 'points'].includes(what)) problem(`node ${k} (part ${look.part}): child ${what}`);
      if (!c.getMatrix().every((x, i) => x === (i % 5 === 0 ? 1 : 0))) problem(`node ${k} (part ${look.part}): ${what} not at the part's place`);
      for (const p of c.getMesh()?.listPrimitives() ?? []) {
        if (p.getMode() !== (what === 'points' ? 0 : 1)) problem(`node ${k} (part ${look.part}): ${what} in mode ${p.getMode()}`);
        if (p.getMode() === 1) totals.segments += p.getIndices()!.getCount() / 2;
        if (p.getMode() === 0) totals.points += p.getIndices()!.getCount();
      }
    }
  });
  totals.meshes += meshesSeen.size;
  const looksUsed = new Set(expected.filter((e) => view.looks[e.look]!.groups.length).map((e) => e.look));
  if (meshesSeen.size > looksUsed.size) problem(`${meshesSeen.size} meshes for ${looksUsed.size} looks`);
}
tess.dispose();

const mb = (n: number) => (n / 1e6).toFixed(1);
console.log(`files ${totals.files} (${totals.skipped} over ${maxBytes / 1e6} MB skipped), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`part nodes ${totals.nodes} (${totals.hidden} hidden), meshes ${totals.meshes}, triangle primitives ${totals.primitives}, triangles ${totals.triangles}, segments ${totals.segments}, points ${totals.points}`);
console.log(`GLB ${mb(totals.bytes)} MB; export ${(totals.exportMs / 1000).toFixed(2)} s; validation ${(totals.validateMs / 1000).toFixed(2)} s`);
console.log('largest:');
for (const [n, f, ms] of biggest.sort((a, b) => b[0] - a[0]).slice(0, 5)) console.log(`  ${mb(n)} MB, ${(ms / 1000).toFixed(1)} s  ${f}`);
console.log('validator issues (count, files, code, an example):');
for (const [k, e] of [...issues].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(e.n).padStart(8)} ${String(e.files.size).padStart(4)} ${k}  e.g. ${e.example}`);
console.log(`problems ${totals.problems}`);
for (const p of problems) console.log(`  ${p}`);
