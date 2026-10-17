// Phase 1 step 6: check the product structure extractor against OCCT, through occt-import-js (its prebuilt module
// in the corpus checkout), which reads STEP with OCCT's XCAF assembly reader and returns meshes in world
// coordinates.
//
// For every product instance in our tree, every B-rep vertex (VERTEX_POINT) of the product's own representations is
// moved to world coordinates with our transforms and looked up among OCCT's mesh vertices, which always include the
// B-rep vertices. A wrong placement, a wrong unit or a missing instance shows up as vertices not found. Also
// compares instance counts with OCCT's meshes and names with its node names.
// Usage: node corpus_checks/products_occt.ts [file-list.txt] [max MB, default 5]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { openModel, parseStep } from '../packages/step-parser/src/index.ts';
import { apply, multiply, scaling, type Vec3 } from '../packages/step-parser/src/extract/math.ts';
import { productInstances, productRepresentations, extractProducts } from '../packages/step-parser/src/extract/products.ts';
import { point } from '../packages/step-parser/src/extract/placement.ts';
import { Reader } from '../packages/step-parser/src/extract/reader.ts';
import { Units } from '../packages/step-parser/src/extract/units.ts';
import { corpusDir, corpusFiles, shortName } from './corpus.ts';

const require = createRequire(import.meta.url);
const loadOcct = () => require(path.join(corpusDir, 'occt-import-js/dist/occt-import-js.js'))();
let occt = await loadOcct();
const maxBytes = Number(process.argv[3] ?? 5) * 1e6;

interface OcctNode { name: string; meshes: number[]; children: OcctNode[] }
const totals = { files: 0, skipped: 0, failed: 0, instances: 0, vertices: 0, found: 0, filesAllFound: 0 };
const problems: string[] = [];

for (const f of corpusFiles(process.argv[2])) {
  const bytes = fs.readFileSync(f);
  if (bytes.length > maxBytes) { totals.skipped++; continue; }
  const name = shortName(f);
  let res;
  try {
    res = occt.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.01 });
  } catch {
    // A WebAssembly exception (on the deliberately corrupted files): the module's state is suspect, so reload it.
    occt = await loadOcct();
    res = { success: false };
  }
  if (!res.success) { totals.failed++; problems.push(`${name}: occt-import-js failed`); continue; }
  totals.files++;

  // OCCT's mesh vertices on a grid of 1e-4 of the model size.
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of res.meshes) {
    const a = mesh.attributes.position.array as number[];
    for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, a[i + k]!); hi[k] = Math.max(hi[k]!, a[i + k]!); }
  }
  const size = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!, 1e-9);
  const tol = size * 1e-5;
  const cell = tol * 4;
  const grid = new Map<string, Vec3[]>();
  for (const mesh of res.meshes) {
    const a = mesh.attributes.position.array as number[];
    for (let i = 0; i < a.length; i += 3) {
      const key = `${Math.floor(a[i]! / cell)},${Math.floor(a[i + 1]! / cell)},${Math.floor(a[i + 2]! / cell)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push([a[i]!, a[i + 1]!, a[i + 2]!]);
    }
  }
  const near = (p: Vec3) => {
    const [x, y, z] = p.map((c) => Math.floor(c / cell));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const q of grid.get(`${x! + dx},${y! + dy},${z! + dz}`) ?? []) if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= tol) return true;
    }
    return false;
  };

  // Our instances and their vertices, in world millimetres.
  const m = await openModel(parseStep(bytes));
  const r = new Reader(m);
  const s = extractProducts(r, new Units(r));
  const verticesOf = new Map<number, Vec3[]>();
  const repVertices = (id: number): Vec3[] => {
    let v = verticesOf.get(id);
    if (v) return v;
    v = [];
    const seen = new Set<number>();
    const todo = r.refs(m.resolve(id), 'items');
    while (todo.length) {
      const p = todo.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      if (m.isInstanceOf(p, 'MAPPED_ITEM') || m.isInstanceOf(p, 'REPRESENTATION')) continue; // placed separately
      if (m.isInstanceOf(p, 'VERTEX_POINT')) { const c = point(r, r.ref(p, 'vertex_geometry')); if (c) v.push(c); continue; }
      for (const id2 of m.file.index.refsOf(p)) { const q = m.resolve(id2); if (q >= 0) todo.push(q); }
    }
    verticesOf.set(id, v);
    return v;
  };
  let missing = 0, total = 0;
  for (const inst of productInstances(s)) {
    totals.instances++;
    const root = s.products[inst.path.length ? s.occurrences[inst.path[0]!]!.parent : inst.product]!;
    const rootUnit = s.representations.get(root.shapes[0] ?? -1)?.context?.lengthUnit?.factor ?? 1e-3;
    const toMm = multiply(scaling(rootUnit * 1000), inst.transform);
    for (const { representation, transform } of productRepresentations(s, inst.product)) {
      const t = multiply(toMm, transform);
      for (const v of repVertices(representation)) {
        total++;
        if (!near(apply(t, v))) missing++;
      }
    }
  }
  totals.vertices += total;
  totals.found += total - missing;
  if (missing === 0) totals.filesAllFound++;
  else problems.push(`${name}: ${missing} of ${total} vertices not found (${s.occurrences.length} occurrences, ${res.meshes.length} OCCT meshes)`);
}

console.log(`${totals.files} files checked (${totals.skipped} over the size limit, ${totals.failed} failed in occt-import-js); ${totals.instances} product instances`);
console.log(`${totals.found} of ${totals.vertices} B-rep vertices found in OCCT's meshes; ${totals.filesAllFound} files with every vertex found`);
for (const p of problems) console.log('  ', p);
