// Phase 4 step 5: 3MF for every corpus file, read back with lib3mf (the 3MF Consortium's reader, strict mode) and
// compared with the export view it was written from. Each file is imported, tessellated with our OCCT backend (a
// tess-workers pool, 0.1 mm), and exported with open meshes as surface objects and hidden instances kept, so every
// placed part with triangles is written; then:
//   - lib3mf's errors and warnings are problems;
//   - parts build: one item per placed part with triangles, in tree order, at the view's world transform (to
//     float32, as lib3mf reads transforms);
//   - each mesh object: 'model' exactly when lib3mf's check finds it manifold and oriented and it has positive volume
//     (which lib3mf doesn't check), else 'surface';
//     its triangles, in order, those of the look that aren't degenerate after welding, every corner at the mesh's
//     exact position, every triangle in its group's colour (the material's sRGB and opacity, else the default);
//     and none of the look's triangles degenerate (tessellateScene dropped those);
//   - assembly build: one item; composing its components gives the same objects at the same world transforms, in the
//     same order, as the parts build's items.
// Prints the 3MF sizes and the export and read times. Usage:
//   node corpus_checks/threemf_corpus.ts [file-list.txt] [max MB, default 2]  (progress on standard error)
import fs from 'node:fs';
import os from 'node:os';
import { exportView, identity, multiply, tessellateScene, type ExportNode, type Mat4 } from '../packages/cad-scene/src/index.ts';
import { threemf } from '../packages/export-3mf/src/index.ts';
import { OBJECT_TYPE, read3mf, type Read3mf } from '../packages/export-3mf/test/read3mf.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { WorkerTessellator } from '../packages/tess-workers/src/node.ts';
import { corpusFiles, shortName } from './corpus.ts';

const workers = Math.max(1, os.availableParallelism() - 1);
const tess = new WorkerTessellator({ backend: { module: import.meta.resolve('../packages/tess-occt/src/index.ts'), export: 'OcctTessellator' }, workers });
await tess.init();
const maxBytes = Number(process.argv[3] ?? 2) * 1e6;

// The expectations, written out here rather than taken from the exporter: 3MF's transform order (the rows of the
// row-vector matrix, so our column-major columns), and colours as 8-bit sRGB with alpha.
const rows = (m: Mat4) => [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!, m[12]!, m[13]!, m[14]!];
const byte = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255);
/** 3MF's 12 numbers back to a column-major matrix. */
const matrix = (t: number[] | undefined): Mat4 => (t ? Float64Array.of(t[0]!, t[1]!, t[2]!, 0, t[3]!, t[4]!, t[5]!, 0, t[6]!, t[7]!, t[8]!, 0, t[9]!, t[10]!, t[11]!, 1) : identity());

const totals = { files: 0, skipped: 0, items: 0, models: 0, surfaces: 0, lib3mfOpen: 0, insideOut: 0, triangles: 0, degenerate: 0, bytes: 0, assemblyBytes: 0, exportMs: 0, readMs: 0, problems: 0 };
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
  const { meshes } = await tessellateScene(scene, tess, { linearDeflection: 0.1, angularDeflection: 0.5, concurrency: workers });
  const view = exportView(scene, meshes);

  const te = performance.now();
  const out = threemf(scene, view, { nonManifold: 'surface', hidden: 'keep' });
  const ms = performance.now() - te;
  const data = Uint8Array.from(Buffer.concat(out.chunks));
  totals.exportMs += ms;
  totals.bytes += data.length;
  biggest.push([data.length, name, ms]);
  const assembly = Uint8Array.from(Buffer.concat(threemf(scene, view, { nonManifold: 'surface', hidden: 'keep', build: 'assembly' }).chunks));
  totals.assemblyBytes += assembly.length;

  const tr = performance.now();
  let read: Read3mf, assembled: Read3mf;
  try {
    read = await read3mf(data);
    assembled = await read3mf(assembly, { full: false });
  } catch (e) {
    problem(`lib3mf: ${(e as Error).message ?? e}`);
    continue;
  }
  totals.readMs += performance.now() - tr;
  for (const w of [...read.warnings, ...assembled.warnings]) problem(`lib3mf warning: ${w}`);
  if (read.unit !== 1) problem(`unit ${read.unit}`);

  // Expected, in tree order: each placed part with triangles, its world transform and look.
  const expected: { world: Mat4; look: number }[] = [];
  const walk = (n: ExportNode, parent: Mat4) => {
    const t = multiply(parent, n.transform);
    for (const p of n.parts) if (view.looks[p.look]!.groups.length) expected.push({ world: multiply(t, p.transform), look: p.look });
    for (const c of n.children) walk(c, t);
  };
  for (const r of view.roots) walk(r, identity());
  // Looks whose meshes weld to no triangle at all (every one degenerate) have no object.
  const objectOf = new Map<number, number>();
  const items = read.items;
  let k = 0;
  for (const e of expected) {
    const look = view.looks[e.look]!;
    if (!nonDegenerate(look.mesh.positions, look.indices).length) continue;
    const item = items[k++];
    if (!item) { problem(`${items.length} items, expected more`); break; }
    totals.items++;
    const want = rows(e.world).map(Math.fround);
    const got = item.transform ?? rows(identity());
    const scale = Math.max(1, ...want.map(Math.abs));
    if (!got.every((x, i) => Math.abs(x - want[i]!) <= 1e-6 * scale)) problem(`item ${k - 1} (part ${look.part}): transform ${got} expected ${want}`);
    const seen = objectOf.get(e.look);
    if (seen === undefined) objectOf.set(e.look, item.object);
    else if (seen !== item.object) problem(`look ${e.look} in objects ${seen} and ${item.object}`);
  }
  if (k !== items.length) problem(`${items.length} items, expected ${k}`);

  // Each look's object, triangle by triangle.
  for (const [lookIndex, id] of objectOf) {
    const look = view.looks[lookIndex]!;
    const m = read.meshes.get(id);
    if (!m) { problem(`no mesh object ${id}`); continue; }
    if (m.type === OBJECT_TYPE.model) totals.models++;
    else if (m.type === OBJECT_TYPE.surface) totals.surfaces++;
    else problem(`object ${id}: type ${m.type}`);
    // A model: manifold and oriented by lib3mf's check, and of positive volume (lib3mf doesn't check the sign); a
    // surface fails one of them.
    const solid = m.manifold && volume(m.positions, m.triangles) > 0;
    if (!m.manifold && m.type === OBJECT_TYPE.surface) totals.lib3mfOpen++;
    if (m.manifold && m.type === OBJECT_TYPE.surface) totals.insideOut++;
    if ((m.type === OBJECT_TYPE.model) !== solid) problem(`object ${id} (part ${look.part}): type ${m.type}, lib3mf's manifold check ${m.manifold}, volume ${volume(m.positions, m.triangles)}`);
    const p = look.mesh.positions;
    let t = 0;
    for (const g of look.groups) {
      const material = g.material === undefined ? undefined : scene.materials[g.material];
      const c = material?.color ?? [0.8, 0.8, 0.8];
      const want = [byte(c[0]), byte(c[1]), byte(c[2]), byte(material?.opacity ?? 1)];
      for (const tri of nonDegenerate(p, look.indices.subarray(g.start, g.start + g.count))) {
        if (3 * t >= m.triangles.length) { t++; continue; }
        for (let corner = 0; corner < 3; corner++) {
          const v = m.triangles[3 * t + corner]!;
          for (let axis = 0; axis < 3; axis++) {
            if (m.positions[3 * v + axis] !== p[3 * tri[corner]! + axis]! + 0) { problem(`object ${id} (part ${look.part}) triangle ${t}: corner ${corner} moved`); corner = 3; break; }
          }
        }
        const [group, property] = m.properties[t]!;
        const got = read.colors.get(group)?.get(property)?.color;
        if (!got || !got.every((x, i) => x === want[i])) problem(`object ${id} (part ${look.part}) triangle ${t}: colour ${got}, expected ${want}`);
        t++;
      }
    }
    if (t !== m.triangles.length / 3) problem(`object ${id} (part ${look.part}): ${m.triangles.length / 3} triangles, expected ${t}`);
    totals.triangles += t;
    totals.degenerate += look.indices.length / 3 - t;
    // tessellateScene drops triangles with two corners at one position, so the exporter should find none.
    if (look.indices.length / 3 !== t) problem(`object ${id} (part ${look.part}): ${look.indices.length / 3 - t} degenerate triangles left in the mesh`);
  }

  // The assembly build: the same objects at the same places, composing the components.
  const placed: { object: number; world: Mat4 }[] = [];
  const compose = (object: number, world: Mat4) => {
    const c = assembled.components.get(object);
    if (!c) { placed.push({ object, world }); return; }
    for (const x of c.components) compose(x.object, multiply(world, matrix(x.transform)));
  };
  if (assembled.items.length > 1) problem(`assembly build: ${assembled.items.length} items`);
  for (const it of assembled.items) compose(it.object, matrix(it.transform));
  if (placed.length !== items.length) problem(`assembly build: ${placed.length} placed objects, ${items.length} items in the parts build`);
  placed.forEach((pl, i) => {
    const it = items[i];
    if (!it) return;
    if (pl.object !== it.object) problem(`assembly build: placed object ${i} is ${pl.object}, item ${it.object}`);
    const want = it.transform ?? rows(identity());
    const got = rows(pl.world);
    const scale = Math.max(1, ...want.map(Math.abs));
    // Each float32 transform on the way rounds: a looser tolerance than the items'.
    if (!got.every((x, j) => Math.abs(x - want[j]!) <= 1e-5 * scale)) problem(`assembly build: object ${i} at ${got}, the item at ${want}`);
  });
}
tess.dispose();

/** Six times a closed mesh's signed volume. */
function volume(p: number[], t: number[]): number {
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i]!, b = 3 * t[i + 1]!, c = 3 * t[i + 2]!;
    v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return v;
}

/** A mesh's triangles (as vertex triples) that welding by exact position leaves non-degenerate. */
function nonDegenerate(p: Float32Array, indices: Uint32Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  const same = (a: number, b: number) => p[3 * a]! === p[3 * b]! && p[3 * a + 1]! === p[3 * b + 1]! && p[3 * a + 2]! === p[3 * b + 2]!;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
    if (!same(a, b) && !same(b, c) && !same(c, a)) out.push([a, b, c]);
  }
  return out;
}

const mb = (n: number) => (n / 1e6).toFixed(1);
console.log(`files ${totals.files} (${totals.skipped} over ${maxBytes / 1e6} MB skipped), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`items ${totals.items}, objects: model ${totals.models}, surface ${totals.surfaces} (${totals.lib3mfOpen} not manifold by lib3mf, ${totals.insideOut} inside out); triangles ${totals.triangles} (${totals.degenerate} degenerate dropped)`);
console.log(`3MF ${mb(totals.bytes)} MB (assembly build ${mb(totals.assemblyBytes)} MB); export ${(totals.exportMs / 1000).toFixed(2)} s; lib3mf read ${(totals.readMs / 1000).toFixed(2)} s`);
console.log('largest:');
for (const [n, f, ms] of biggest.sort((a, b) => b[0] - a[0]).slice(0, 5)) console.log(`  ${mb(n)} MB, ${(ms / 1000).toFixed(1)} s  ${f}`);
console.log(`problems ${totals.problems}`);
for (const p of problems) console.log(`  ${p}`);
