// Phase 4 step 1: cad-scene's export view against the scene it is made from. Each corpus file is imported, its parts
// tessellated with our OCCT backend (in a tess-workers pool, at 0.1 mm), and its export view (with edges and curves)
// checked against partInstances:
//   - every placed part with something to draw appears once in the view's tree, at the same path;
//   - its world transform (the view's node transforms multiplied down the tree) is partInstances' transform times
//     the translation by the mesh's origin;
//   - each look's groups partition its indices, and its triangles, each with its group's material, are exactly the
//     mesh's triangles with the materials partInstances resolves for their faces (the face's own, else the instance's);
//   - instances with the same part and resolved materials share a look.
// Usage: node corpus_checks/export_view.ts [file-list.txt] [max MB, default 2]  (progress per file on standard error)
import fs from 'node:fs';
import os from 'node:os';
import { exportView, identity, multiply, partInstances, tessellateScene, type ExportNode, type Mat4 } from '../packages/cad-scene/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';

const workers = Math.max(1, os.availableParallelism() - 1);
const tess = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'), export: 'OcctTessellator' }, workers });
await tess.init();
const maxBytes = Number(process.argv[3] ?? 2) * 1e6;

const close = (a: Mat4, b: Mat4) => {
  const scale = Math.max(1, ...Array.from(b, Math.abs));
  return a.every((x, i) => Math.abs(x - b[i]!) <= 1e-9 * scale);
};
const translation = (v: readonly number[]): Mat4 => {
  const m = identity();
  m[12] = v[0]!; m[13] = v[1]!; m[14] = v[2]!;
  return m;
};

const totals = { files: 0, skipped: 0, partInstances: 0, drawn: 0, looks: 0, multiLook: 0, groups: 0, multiGroup: 0, triangles: 0, problems: 0 };
const problems: string[] = [];
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

  // The view's placed parts, with world transforms, by path and position among the component's drawn parts.
  const placed = new Map<string, { look: number; world: Mat4; visible: boolean }[]>();
  const walk = (n: ExportNode, parent: Mat4) => {
    const t = multiply(parent, n.transform);
    placed.set(n.path.join('/'), n.parts.map((p) => ({ look: p.look, world: multiply(t, p.transform), visible: p.visible })));
    for (const c of n.children) walk(c, t);
  };
  for (const r of view.roots) walk(r, identity());

  const lookOf = new Map<string, number>();
  const cursor = new Map<string, number>();
  for (const pi of partInstances(scene)) {
    totals.partInstances++;
    const mesh = meshes.get(pi.part) ?? (scene.parts[pi.part]!.kind === 'mesh' ? (scene.parts[pi.part] as { lods: never[] }).lods[0] : undefined);
    const drawable = mesh && (mesh.indices.length || mesh.edges?.length || mesh.curves?.length || mesh.pointSources?.length);
    if (!drawable) continue;
    totals.drawn++;
    const key = pi.path.join('/');
    const k = cursor.get(key) ?? 0;
    cursor.set(key, k + 1);
    const p = placed.get(key)?.[k];
    if (!p) { problem(`${key} part ${pi.part}: missing from the view`); continue; }
    const look = view.looks[p.look]!;
    if (look.part !== pi.part) { problem(`${key}: look ${p.look} is part ${look.part}, expected ${pi.part}`); continue; }
    if (!close(p.world, multiply(pi.transform, translation(mesh.origin)))) problem(`${key} part ${pi.part}: transform differs`);
    if (p.visible !== pi.visible) problem(`${key} part ${pi.part}: visibility differs`);
    if (look.material !== pi.material) problem(`${key} part ${pi.part}: default material ${look.material}, expected ${pi.material}`);
    // Equal parts and resolved materials share a look.
    const sig = `${pi.part}:${pi.material}:${[...pi.faceMaterials].filter(([face]) => mesh.faces.some((r) => r.source === face)).sort((a, b) => a[0] - b[0]).join(';')}`;
    const seen = lookOf.get(sig);
    if (seen === undefined) lookOf.set(sig, p.look);
    else if (seen !== p.look) problem(`${key} part ${pi.part}: look ${p.look}, but an equal instance has ${seen}`);
    // Triangles with materials: expected from the scene, actual from the look's groups.
    const tri = (ix: Uint32Array, i: number, m: number | undefined) => `${ix[i]},${ix[i + 1]},${ix[i + 2]}:${m}`;
    const expected: string[] = [];
    for (const r of mesh.faces) {
      const m = (r.source === null ? undefined : pi.faceMaterials.get(r.source)) ?? pi.material;
      for (let i = r.start; i < r.start + r.count; i += 3) expected.push(tri(mesh.indices, i, m));
    }
    if (!mesh.faces.length) for (let i = 0; i < mesh.indices.length; i += 3) expected.push(tri(mesh.indices, i, pi.material));
    const actual: string[] = [];
    let at = 0;
    for (const g of look.groups) {
      if (g.start !== at) problem(`${key} part ${pi.part}: groups don't partition the indices`);
      for (let i = g.start; i < g.start + g.count; i += 3) actual.push(tri(look.indices, i, g.material));
      at = g.start + g.count;
    }
    if (at !== look.indices.length || look.indices.length !== mesh.indices.length) problem(`${key} part ${pi.part}: ${at} of ${look.indices.length} indices grouped, mesh has ${mesh.indices.length}`);
    expected.sort(); actual.sort();
    if (expected.join('|') !== actual.join('|')) problem(`${key} part ${pi.part}: triangles or their materials differ`);
  }
  for (const [key, list] of placed) if ((cursor.get(key) ?? 0) !== list.length) problem(`${key}: ${list.length} parts in the view, ${cursor.get(key) ?? 0} expected`);

  totals.looks += view.looks.length;
  const perPart = new Map<number, number>();
  for (const l of view.looks) {
    perPart.set(l.part, (perPart.get(l.part) ?? 0) + 1);
    totals.groups += l.groups.length;
    if (l.groups.length > 1) totals.multiGroup++;
    totals.triangles += l.indices.length / 3;
  }
  totals.multiLook += [...perPart.values()].filter((n) => n > 1).length;
}
tess.dispose();

console.log(`files ${totals.files} (${totals.skipped} over ${maxBytes / 1e6} MB skipped), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`part instances ${totals.partInstances}, with something to draw ${totals.drawn}`);
console.log(`looks ${totals.looks}; parts with more than one look ${totals.multiLook}`);
console.log(`groups ${totals.groups}; looks with more than one group ${totals.multiGroup}; triangles in looks ${totals.triangles}`);
console.log(`problems ${totals.problems}`);
for (const p of problems) console.log(`  ${p}`);
